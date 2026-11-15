/**
 * CodeLex —— 词法感知的代码扫描（不是语法解析，但比正则匹配强一个量级）。
 *
 * 为什么需要这一层：
 *   上一版 `code_find(mode=refs)` 是「整行正则找 `\bname\b`」，于是
 *   `// 这里也要调 setConnectTimeout` 会被算成一处引用，`"setConnectTimeout"` 字符串同理。
 *   对一个要被信任的 Agent 来说，这类误报比漏报更糟：它会把"注释里提了一句"
 *   当成"代码里有调用"，然后基于错误计数下结论。
 *
 * 本模块只做三件事，且全部是**纯函数**（不碰 fs，便于单测）：
 *   ① maskNonCode —— 把注释与字符串"抹成空格"，保留行列位置与换行；
 *   ② extractSymbols —— 从抹过的文本里提取符号（名字/种类/起止行/所属容器）；
 *   ③ findOccurrences —— 在抹过的文本里找标识符，区分"定义"与"引用"，
 *      并单独统计**被排除的注释/字符串命中数**（这个数字本身就是有用信息）。
 *
 * 明确的边界（写进工具输出，不许隐藏）：
 *   · 这是**词法**级，不是类型系统：同名不同符号（两个类各有 `save()`）仍会合并计数；
 *   · 不做正则字面量识别（`/a/g` 里出现的标识符会被当成引用）——代价可接受，
 *     因为反过来（把除法当正则起始）会破坏后续所有解析；
 *   · 字符串插值 `${...}` 内部按代码处理（否则模板字符串里的调用会全部丢失）。
 */

export type LexLang = 'ts' | 'java' | 'python' | 'go' | 'rust' | 'clike';

/** 按扩展名判定词法方言。判不出的走 clike（`//` `/* *\/` 那一套最常见）。 */
export function lexLangOf(filePath: string): LexLang {
  const lower = String(filePath ?? '').toLowerCase();
  if (/\.(ts|tsx|mts|cts)$/.test(lower)) return 'ts';
  if (/\.(js|jsx|mjs|cjs|vue|svelte)$/.test(lower)) return 'ts';
  if (/\.java$/.test(lower)) return 'java';
  if (/\.(kt|kts|scala|groovy)$/.test(lower)) return 'java';
  if (/\.py$/.test(lower)) return 'python';
  if (/\.go$/.test(lower)) return 'go';
  if (/\.rs$/.test(lower)) return 'rust';
  return 'clike';
}

export interface MaskResult {
  /** 与原文**等长**：注释与字符串内容替换为空格，换行原样保留。 */
  masked: string;
  /** 逐字符标记：1 = 代码，0 = 注释/字符串。用于判断某个命中在不在代码里。 */
  codeFlags: Uint8Array;
  /** 被抹掉的字符数（粗略规模指标）。 */
  maskedChars: number;
}

type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'triple-s' | 'triple-d';

/**
 * 抹掉注释与字符串。
 *
 * 状态机而不是逐行正则：块注释、模板字符串、Java 文本块都是**跨行**的，
 * 逐行处理必然把"字符串里的第 2 行"当成代码——那正是误报的主要来源。
 */
export function maskNonCode(content: string, lang: LexLang): MaskResult {
  const src = String(content ?? '');
  const out: string[] = new Array(src.length);
  const flags = new Uint8Array(src.length);
  /* 栈式状态：模板字符串里的 ${...} 需要回到代码态，并且要数清嵌套的 { }。 */
  const stack: Array<{ mode: Mode; braces: number }> = [{ mode: 'code', braces: 0 }];
  const top = (): { mode: Mode; braces: number } => stack[stack.length - 1];
  let maskedChars = 0;

  const emit = (index: number, keep: boolean): void => {
    const ch = src[index];
    if (keep) {
      out[index] = ch;
      flags[index] = 1;
      return;
    }
    /* 换行必须保留：它决定了行号，抹掉等于把后面所有行号算错。 */
    out[index] = ch === '\n' || ch === '\r' ? ch : ' ';
    flags[index] = 0;
    if (ch !== '\n' && ch !== '\r') maskedChars += 1;
  };

  for (let index = 0; index < src.length; index += 1) {
    const ch = src[index];
    const next = src[index + 1];
    const current = top();

    if (current.mode === 'line') {
      if (ch === '\n') { emit(index, true); stack.pop(); continue; }
      emit(index, false);
      continue;
    }
    if (current.mode === 'block') {
      if (ch === '*' && next === '/') {
        emit(index, false);
        emit(index + 1, false);
        index += 1;
        stack.pop();
        continue;
      }
      emit(index, false);
      continue;
    }
    if (current.mode === 'triple-s' || current.mode === 'triple-d') {
      const quote = current.mode === 'triple-s' ? "'" : '"';
      if (ch === quote && src[index + 1] === quote && src[index + 2] === quote) {
        emit(index, false); emit(index + 1, false); emit(index + 2, false);
        index += 2;
        stack.pop();
        continue;
      }
      emit(index, false);
      continue;
    }
    if (current.mode === 'single' || current.mode === 'double') {
      if (ch === '\\') {
        emit(index, false);
        if (index + 1 < src.length) { emit(index + 1, false); index += 1; }
        continue;
      }
      if ((current.mode === 'single' && ch === "'") || (current.mode === 'double' && ch === '"')) {
        emit(index, false);
        stack.pop();
        continue;
      }
      /* JS/Java 的普通字符串不跨行：遇到换行视为未闭合，回到代码态。
       * 不这么处理的话，一行写错引号就会把后面整个文件都吞掉。 */
      if (ch === '\n') { emit(index, true); stack.pop(); continue; }
      emit(index, false);
      continue;
    }
    if (current.mode === 'template') {
      if (ch === '\\') {
        emit(index, false);
        if (index + 1 < src.length) { emit(index + 1, false); index += 1; }
        continue;
      }
      if (ch === '`') { emit(index, false); stack.pop(); continue; }
      if (ch === '$' && next === '{') {
        emit(index, false); emit(index + 1, false);
        index += 1;
        stack.push({ mode: 'code', braces: 0 });
        continue;
      }
      emit(index, false);
      continue;
    }

    /* ---- 代码态 ---- */
    if (ch === '/' && next === '/') { emit(index, false); emit(index + 1, false); index += 1; stack.push({ mode: 'line', braces: 0 }); continue; }
    if (ch === '/' && next === '*') { emit(index, false); emit(index + 1, false); index += 1; stack.push({ mode: 'block', braces: 0 }); continue; }
    /* `#` 只在 python / shell 类方言里是注释；C 系的 `#include` / `#{` 是正常语法。 */
    if (ch === '#' && lang === 'python') { emit(index, false); stack.push({ mode: 'line', braces: 0 }); continue; }
    if ((ch === "'" || ch === '"') && lang === 'python') {
      const triple = src[index + 1] === ch && src[index + 2] === ch;
      if (triple) {
        emit(index, false); emit(index + 1, false); emit(index + 2, false);
        index += 2;
        stack.push({ mode: ch === "'" ? 'triple-s' : 'triple-d', braces: 0 });
        continue;
      }
      emit(index, false);
      stack.push({ mode: ch === "'" ? 'single' : 'double', braces: 0 });
      continue;
    }
    if (ch === '"' && next === '"' && src[index + 2] === '"' && lang === 'java') {
      /* Java 15 文本块：跨行，必须按 triple 处理，否则块内每行都会被当代码。 */
      emit(index, false); emit(index + 1, false); emit(index + 2, false);
      index += 2;
      stack.push({ mode: 'triple-d', braces: 0 });
      continue;
    }
    if (ch === "'" || ch === '"') { emit(index, false); stack.push({ mode: ch === "'" ? 'single' : 'double', braces: 0 }); continue; }
    if (ch === '`' && (lang === 'ts' || lang === 'clike' || lang === 'rust')) { emit(index, false); stack.push({ mode: 'template', braces: 0 }); continue; }

    if (ch === '{') current.braces += 1;
    else if (ch === '}') {
      if (current.braces === 0 && stack.length > 1) {
        /* 模板插值结束：`${...}` 的最外层右括号，回到模板串。 */
        emit(index, false);
        stack.pop();
        continue;
      }
      if (current.braces > 0) current.braces -= 1;
    }
    emit(index, true);
  }

  return { masked: out.join(''), codeFlags: flags, maskedChars };
}

/* ================= import 语句（供 refs 跨文件收敛） ================= */

export interface ImportSpec {
  /** 模块说明符原文：`./user/User`、`a.b.C`、`github.com/x/y`。 */
  specifier: string;
  /** 从该模块导入的名字。`import { save }` → `['save']`；Java 类导入 → 类名；`import *` / 侧效导入 → 空。 */
  names: string[];
  /** 是否相对路径（`.` / `..` 开头）。相对路径能精确解析，其余只能按尾部匹配。 */
  relative: boolean;
  line: number;
}

/** 行数上限：一个文件里几千条 import 时，收敛表本身就没法读了。 */
const MAX_IMPORTS = 400;

/**
 * 抽 import 语句。
 *
 * 关键点：**结构在抹过的文本上匹配，说明符从原文的同一位置取**。
 * 抹过的文本里说明符是一串空格（它本来就是字符串），位置却与原文一一对应；
 * 反过来在原文上直接正则，注释里那句 `// import x from './y'` 会被当成真的导入——
 * 那正是 refs 上一版踩过的坑，不能在新功能上再犯一遍。
 *
 * 只覆盖四种方言（ts/java/python/go 与 rust 的 `use`），其余返回空数组：
 * 判不出就是判不出，宁可让收敛表写「无导入证据」，也不要按 C 语法猜。
 */
export function extractImports(masked: string, original: string, lang: LexLang): ImportSpec[] {
  const out: ImportSpec[] = [];
  if (!masked || !original) return out;
  const codeLines = masked.split(/\r?\n/);
  const rawLines = original.split(/\r?\n/);

  const push = (spec: string, names: string[], line: number): void => {
    const clean = String(spec ?? '').trim();
    if (!clean || clean.length > 200 || out.length >= MAX_IMPORTS) return;
    out.push({
      specifier: clean,
      names: names.filter((item) => /^[A-Za-z_$][\w$]*$/.test(item)),
      relative: clean === '.' || clean === '..' || /^\.\.?\//.test(clean),
      line,
    });
  };

  /** 从抹过文本里的偏移取原文的字符串字面量；位置对不上就放弃（不猜）。 */
  const literalAt = (raw: string, offset: number): string | null => {
    let index = offset;
    while (index < raw.length && (raw[index] === ' ' || raw[index] === '\t')) index += 1;
    const quote = raw[index];
    if (quote !== '"' && quote !== "'" && quote !== '`') return null;
    const end = raw.indexOf(quote, index + 1);
    if (end < 0) return null;
    return raw.slice(index + 1, end);
  };

  for (let row = 0; row < codeLines.length; row += 1) {
    const code = codeLines[row];
    const raw = rawLines[row] ?? '';
    if (!code.trim()) continue;
    const line = row + 1;

    if (lang === 'java') {
      /* `import a.b.C;` / `import static a.b.C.save;` —— 全是代码，无需从原文取。 */
      const match = /^\s*import\s+(?:static\s+)?([\w.$*]+)\s*;/.exec(code);
      if (match) {
        const segments = match[1].split('.');
        /* static 导入的可能是成员（`a.b.C.save`），名字取最后一段；普通导入取类名。 */
        push(match[1], [segments[segments.length - 1]], line);
      }
      continue;
    }

    if (lang === 'python') {
      const from = /^\s*from\s+([\w.]+)\s+import\s+(.+?)(?:\s*#.*)?$/.exec(code);
      if (from) {
        const names = from[2].replace(/[()]/g, '').split(',').map((item) => item.trim().split(/\s+as\s+/)[0]);
        push(from[1], names, line);
        continue;
      }
      const plain = /^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)$/.exec(code);
      if (plain) {
        for (const module of plain[1].split(',')) push(module.trim().split(/\s+as\s+/)[0], [], line);
      }
      continue;
    }

    if (lang === 'rust') {
      const use = /^\s*use\s+([\w:]+)/.exec(code);
      if (use) push(use[1].replace(/::$/, ''), [use[1].split('::').pop() ?? ''], line);
      continue;
    }

    if (lang === 'go') {
      /* `import "x"` / `import alias "x"` / import 块里的一行 `alias "x"`。
       * 偏移只给到关键字之后：说明符在抹过的文本里是空格，任何 `\s*` 都会把它吃掉。 */
      const keyword = /^\s*import\b/.exec(code);
      const direct = keyword ? literalAt(raw, keyword.index + keyword[0].length) : null;
      if (direct !== null) {
        if (!/[^\w./\-]/.test(direct)) push(direct, [], line);
        continue;
      }
      /* import 块内的行：原文里第一个引号前只允许出现别名。 */
      const quoteAt = raw.indexOf('"');
      if (quoteAt > 0 && /^[._\w]*\s*$/.test(raw.slice(0, quoteAt)) && /^[\s._\w]*$/.test(code.slice(0, quoteAt))) {
        const spec = literalAt(raw, 0);
        if (spec && !/[^\w./\-]/.test(spec)) push(spec, [], line);
      }
      continue;
    }

    /* ts / clike：import ... from 'x'、import 'x'、require('x')、import('x')。 */
    let handled = false;
    /* `from` 逐个试：只有"关键字边界 + 原文该处确实是引号"才认。 */
    for (let at = code.indexOf('from'); at >= 0 && !handled; at = code.indexOf('from', at + 4)) {
      const before = at === 0 ? ' ' : code[at - 1];
      const after = code[at + 4] ?? ' ';
      if (/[\w$]/.test(before) || /[\w$]/.test(after)) continue;
      const spec = literalAt(raw, at + 4);
      if (spec === null) continue;
      let names: string[] = [];
      const brace = /\{([^}]*)\}/.exec(code.slice(0, at));
      if (brace) {
        names = brace[1].split(',').map((item) => item.trim().split(/\s+as\s+/)[0]);
      } else {
        /* 默认导入 `import Foo from`：取 import 之后第一个标识符（跳过 type）。 */
        const def = /^\s*(?:import|export)\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(code.slice(0, at));
        if (def && def[1] !== 'type') names = [def[1]];
      }
      push(spec, names, line);
      handled = true;
    }
    if (handled) continue;

    /* 调用形态：`require('./x')` / 动态 `import('./x')`。 */
    const call = /\b(?:require|import)\s*\(/.exec(code);
    if (call) {
      const spec = literalAt(raw, call.index + call[0].length);
      if (spec !== null) { push(spec, [], line); continue; }
    }

    /* 侧效导入：`import './x'`。 */
    const side = /^\s*import\b/.exec(code);
    if (side) {
      const spec = literalAt(raw, side.index + side[0].length);
      if (spec !== null) push(spec, [], line);
    }
  }

  return out;
}

export type SymbolKind = 'class' | 'interface' | 'enum' | 'function' | 'method' | 'field' | 'const' | 'type' | 'struct';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 声明行（1 起）。 */
  line: number;
  /** 结束行（1 起）。无法确定时等于 line —— 不要编一个区间。 */
  endLine: number;
  /** 所属容器（类名/结构体名）；顶层符号没有。 */
  container?: string;
  /** 单行签名（原文，截断到 200）。 */
  signature: string;
}

/** 不是符号名的关键字：少了这张表，`if (x) {` 会被当成 method。 */
const NOT_A_NAME = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'delete', 'throw', 'try', 'else',
  'do', 'case', 'super', 'this', 'typeof', 'instanceof', 'in', 'of', 'await', 'yield',
  'synchronized', 'assert', 'print', 'lambda', 'with', 'match', 'using', 'sizeof',
  /* 匿名函数表达式 `function() {` 会在"无返回类型"那条分支里被当成名字叫 function 的方法。 */
  'function', 'func', 'fn', 'def', 'fun',
]);

const CLASS_LIKE = /^(?:(?:export|default|declare|abstract|public|private|protected|internal|static|final|sealed|open|partial|data|annotation|pub)\s+)*(class|interface|enum|record|struct|trait|object)\s+([A-Za-z_$][\w$]*)/;
const FUNC_KEYWORD = /^(?:(?:export|default|public|private|protected|static|final|abstract|internal|open|override|suspend|async|pub)\s+)*(?:fun|function|def|func|fn)\s*\*?\s*(?:<[^>]+>\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const GO_METHOD = /^func\s+\(\s*[^)]*?([A-Za-z_]\w*)\s*\)\s*([A-Za-z_]\w*)\s*\(/;
const ASSIGNED_FN = /^(?:(?:export|default|public|private|protected|static|final|readonly|const|let|var)\s+)*(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|<[^>]+>\s*\()/;
const ASSIGNED_VALUE = /^(?:(?:export|public|private|protected|static|final|readonly)\s+)*(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=/;
const TYPE_ALIAS = /^(?:(?:export|declare)\s+)*(?:type)\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/;
const MEMBER = /^(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|override|async|open|suspend|virtual|readonly|internal|pub|export|declare)\s+)*([A-Za-z_$][\w$<>\[\],.?|&\s]*?)\s+([A-Za-z_$][\w$]*)\s*\((.*)$/;
/** 无返回类型的声明形态：`save(` / `constructor(` / `User(`。只是形状，是否算声明由括号配平判断。 */
const BARE_METHOD = /^([A-Za-z_$][\w$]*)\s*\(/;
const PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/;
const PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;

/** 数一行里的花括号净增量（只用于容器深度，不做语法校验）。 */
function countBraces(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{') delta += 1;
    else if (ch === '}') delta -= 1;
  }
  return delta;
}

/** 从声明行往后数大括号，找到配对的结束行；找不到就返回声明行（不编造区间）。 */
function braceEnd(maskedLines: string[], fromLine: number): number {
  let depth = 0;
  let started = false;
  for (let index = fromLine - 1; index < maskedLines.length; index += 1) {
    const line = maskedLines[index];
    for (const ch of line) {
      if (ch === '{') { depth += 1; started = true; }
      else if (ch === '}') {
        depth -= 1;
        if (started && depth === 0) return index + 1;
      }
    }
    /* 声明行里没有 { 且以 ; 结尾：这是接口/抽象方法，区间就是这一行。 */
    if (!started && index === fromLine - 1 && line.trim().endsWith(';')) return fromLine;
  }
  return fromLine;
}

/** python 用缩进判定区间：下一个缩进 <= 自身且非空的行就是边界。 */
function indentEnd(lines: string[], fromLine: number, indent: number): number {
  let end = fromLine;
  for (let index = fromLine; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw.trim() === '') continue;
    const current = raw.length - raw.trimStart().length;
    if (current <= indent) break;
    end = index + 1;
  }
  return end;
}

/**
 * 提取符号。输入必须是 **masked 文本**（调用方负责），
 * 否则 `// class Fake` 会变成一个类——这正是上一版的问题。
 *
 * 上限 400 个：一个文件里 400 个以上的符号，大纲已经失去导航价值，
 * 此时如实截断比继续堆更有用。
 */
export function extractSymbols(masked: string, original: string, lang: LexLang): CodeSymbol[] {
  const maskedLines = masked.split(/\r?\n/);
  const originalLines = original.split(/\r?\n/);
  const symbols: CodeSymbol[] = [];
  const MAX = 400;

  /* python 走缩进 + 容器栈，其余走大括号深度。 */
  const indentStack: Array<{ name: string; indent: number; kind: SymbolKind }> = [];
  /* 大括号方言的容器栈：记 (容器名, 声明时的深度, 结束行)。方法要能说出"我属于哪个类"，
   * 否则大纲只是一串同名方法——Java 里 save() 在三个类里各有一份。 */
  const blockStack: Array<{ name: string; depth: number; endLine: number }> = [];
  let depth = 0;

  for (let index = 0; index < maskedLines.length && symbols.length < MAX; index += 1) {
    const maskedLine = maskedLines[index];
    const trimmed = maskedLine.trim();
    const line = index + 1;
    /* 声明行的"起笔深度"：先取当前深度，再根据本行花括号更新，供下一个符号使用。 */
    const declDepth = depth;

    if (trimmed !== '') {
      const signature = (originalLines[index] ?? '').trim().slice(0, 200);
      while (blockStack.length > 0 && blockStack[blockStack.length - 1].endLine < line) blockStack.pop();
      const containerOf = (): string | undefined => {
        for (let i = blockStack.length - 1; i >= 0; i -= 1) {
          if (blockStack[i].depth < declDepth) return blockStack[i].name;
        }
        return undefined;
      };

      if (lang === 'python') {
        /* 缩进栈：容器由缩进决定，区间由"下一行缩进 <= 自身"决定。 */
        const pyCls = PY_CLASS.exec(maskedLine);
        if (pyCls) {
          const indent = pyCls[1].length;
          while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent >= indent) indentStack.pop();
          const container = indentStack.length > 0 ? indentStack[indentStack.length - 1].name : undefined;
          indentStack.push({ name: pyCls[2], indent, kind: 'class' });
          symbols.push({ name: pyCls[2], kind: 'class', line, endLine: indentEnd(originalLines, line, indent), container, signature });
        } else {
          const pyDef = PY_DEF.exec(maskedLine);
          if (pyDef) {
            const indent = pyDef[1].length;
            while (indentStack.length > 0 && indentStack[indentStack.length - 1].indent >= indent) indentStack.pop();
            const owner = indentStack.length > 0 ? indentStack[indentStack.length - 1] : undefined;
            const kind: SymbolKind = owner?.kind === 'class' ? 'method' : 'function';
            symbols.push({
              name: pyDef[2], kind, line,
              endLine: indentEnd(originalLines, line, indent),
              container: owner?.name,
              signature,
            });
            indentStack.push({ name: pyDef[2], indent, kind });
          } else {
            /* 赋值只在"模块级"或"类体第一层"才算符号：函数内的局部赋值是噪音，
             * 大纲里列一堆 temp / result 只会让人不再看大纲。 */
            const pyAssign = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*\S/.exec(trimmed);
            const indent = maskedLine.length - maskedLine.trimStart().length;
            const owner = indentStack.length > 0 ? indentStack[indentStack.length - 1] : undefined;
            /* 只有「类体第一层」才算字段：方法体内的赋值（owner 是 method）即使缩进
             * 刚好等于 owner.indent + 4 也是局部变量。 */
            const navigable = indent === 0 || (owner?.kind === 'class' && indent === owner.indent + 4);
            if (pyAssign && navigable && !NOT_A_NAME.has(pyAssign[1])) {
              symbols.push({ name: pyAssign[1], kind: 'const', line, endLine: line, signature });
            }
          }
        }
      } else {
        const cls = CLASS_LIKE.exec(trimmed);
        if (cls) {
          const kindWord = cls[1];
          const kind: SymbolKind = kindWord === 'interface' ? 'interface'
            : kindWord === 'enum' ? 'enum'
              : kindWord === 'struct' ? 'struct'
                : kindWord === 'trait' ? 'interface'
                  : 'class';
          const endLine = braceEnd(maskedLines, line);
          symbols.push({ name: cls[2], kind, line, endLine, container: containerOf(), signature });
          while (blockStack.length > 0 && blockStack[blockStack.length - 1].depth >= declDepth) blockStack.pop();
          blockStack.push({ name: cls[2], depth: declDepth, endLine });
          depth += countBraces(maskedLine);
          continue;
        }

        const goMethod = lang === 'go' ? GO_METHOD.exec(trimmed) : null;
        if (goMethod) {
          symbols.push({
            name: goMethod[2], kind: 'method', line, endLine: braceEnd(maskedLines, line),
            container: goMethod[1], signature,
          });
          depth += countBraces(maskedLine);
          continue;
        }

        const fn = FUNC_KEYWORD.exec(trimmed);
        if (fn && !NOT_A_NAME.has(fn[1])) {
          symbols.push({ name: fn[1], kind: 'function', line, endLine: braceEnd(maskedLines, line), container: containerOf(), signature });
          depth += countBraces(maskedLine);
          continue;
        }

        const assignedFn = declDepth === 0 ? ASSIGNED_FN.exec(trimmed) : null;
        if (assignedFn && !NOT_A_NAME.has(assignedFn[1])) {
          symbols.push({ name: assignedFn[1], kind: 'function', line, endLine: braceEnd(maskedLines, line), container: containerOf(), signature });
          depth += countBraces(maskedLine);
          continue;
        }

        const alias = TYPE_ALIAS.exec(trimmed);
        if (alias && !NOT_A_NAME.has(alias[1])) {
          symbols.push({ name: alias[1], kind: 'type', line, endLine: braceEnd(maskedLines, line), container: containerOf(), signature });
          depth += countBraces(maskedLine);
          continue;
        }

        /* 内联注解：`@Override public void save() {`。注解只是修饰，剥掉再判声明形态，
         * 否则带注解的方法会整类从大纲里消失（refs 于是说"定义 0 处"）。 */
        const decl = trimmed.replace(/^(?:@[A-Za-z_$][\w$.]*(?:\([^)]*\))?\s*)+/, '');
        const member = MEMBER.exec(decl);
        if (member && !NOT_A_NAME.has(member[2])) {
          /* 三种声明形态都要认，否则大纲会漏掉一整类方法：
           *   ① 块体 `public void save(...) {`；
           *   ② 单行体 `void save() { }`（Java getter / 空实现的常见写法）；
           *   ③ 抽象/接口声明 `List<Order> findByStatus(String s);`。
           * 但 MEMBER 的形状也会命中表达式语句，所以 ③ 还要加两道排除：
           * `return new Foo(x);`（前缀是 return）与 `y = foo(x);`（前缀含赋值）。 */
          const head = decl.slice(0, decl.indexOf('('));
          const declarative = /[{(]\s*$/.test(member[3])
            || /(?:=>)\s*$/.test(member[3])
            || /\{[\s\S]*\}\s*$/.test(member[3])
            || (/;\s*$/.test(member[3])
              && !/^(return|throw|yield|new|await)\b/.test(trimmed)
              && !/[^=!<>]=[^=]/.test(head));
          if (declarative) {
            symbols.push({ name: member[2], kind: 'method', line, endLine: braceEnd(maskedLines, line), container: containerOf(), signature });
            depth += countBraces(maskedLine);
            continue;
          }
        }

        /* ④ 没有返回类型的声明：`save() {`（TS 类方法）、`constructor() {`、
         * `public User() {`（Java 构造器）。MEMBER 要求"类型 + 名 + ("，
         * 这一整类原本会被漏掉——大纲上少一个方法，refs 就会说"定义 0 处"。
         * 判据比 MEMBER 更严：参数括号必须在这行里配平并多出右括号，
         * 且行内要有块体。`doSomething(x);` 没有 `{`，
         * `run((x) => {` 的括号是配平的（不是声明），两条都不会被误收。 */
        const bare = BARE_METHOD.exec(decl);
        if (bare && !NOT_A_NAME.has(bare[1])) {
          const open = decl.indexOf('{');
          if (open > 0) {
            const params = decl.slice(decl.indexOf('('), open);
            const closes = (params.match(/\)/g) ?? []).length;
            const opens = (params.match(/\(/g) ?? []).length;
            const rest = decl.slice(open);
            /* params 从 `(` 起算：正常声明在这里是配平的（`save()` → 1 开 1 闭）。
             * `run((x) => {` 是 2 开 1 闭，`foo(a, (b) => {` 同理——都靠这条排除。
             * 块体（行尾只有一个 `{`）与单行体（行尾收在 `}`）都要认。 */
            if (closes === opens && !/=>/.test(params) && /\{\s*$|\}\s*$/.test(rest)) {
              symbols.push({ name: bare[1], kind: 'method', line, endLine: braceEnd(maskedLines, line), container: containerOf(), signature });
              depth += countBraces(maskedLine);
              continue;
            }
          }
        }

        /* declDepth === 0 才收：函数体内的 `const tmp = ...` 是局部变量，
         * 它不是"可以跳过去看的地方"。少列 20 个局部变量，大纲才有人用。 */
        const assigned = declDepth === 0 ? ASSIGNED_VALUE.exec(trimmed) : null;
        if (assigned && !NOT_A_NAME.has(assigned[1])) {
          symbols.push({ name: assigned[1], kind: 'const', line, endLine: line, container: containerOf(), signature });
        }
      }
    }

    depth += countBraces(maskedLine);
  }

  return symbols;
}

export interface Occurrence {
  line: number;
  /** 列号（1 起）。 */
  column: number;
  kind: 'definition' | 'reference';
  /** 该行原文（截断）。 */
  snippet: string;
  /**
   * 引用处紧邻的前缀接收者，按**书写形式**取：`user.save` → `user`，
   * `this.repo.save` → `this.repo`。裸名出现（`save(...)`）没有这个字段。
   * 注意：它是变量名，不是类型名——`user` 与 `order` 也可能是同一个类。
   */
  receiver?: string;
  /** 该处所在的符号（`UserService.checkout`）；顶层位置没有。 */
  scope?: string;
}

/** 接收者链：`a`、`a.b`、`this.repo`。不匹配 `new X().` 与 `arr[0].`（认不出就不编）。 */
const RECEIVER_CHAIN = /([A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*)\s*\??\.\s*$/;

function receiverOf(codeLine: string, column: number): string | undefined {
  const prefix = codeLine.slice(0, Math.max(0, column - 1));
  if (!prefix) return undefined;
  const match = RECEIVER_CHAIN.exec(prefix);
  if (!match) return undefined;
  const chain = match[1].replace(/\s*\??\.\s*/g, '.');
  if (!chain) return undefined;
  return chain.length > 40 ? chain.slice(0, 40) : chain;
}

/**
 * 取包含该行的最内层符号；同长度区间取后出现的（内层声明总在后面）。
 *
 * 导出给 `scanTodos` 用：一个 TODO 到底写在哪个方法里，决定了改它的人要不要先读
 * 两百行上下文。这里只回答"包含这一行的最内层符号是谁"，**不做"注释紧挨着谁就属于谁"
 * 那种推断**——那是猜测，不是证据。
 */
export function scopeOf(symbols: CodeSymbol[], line: number): string | undefined {
  let best: CodeSymbol | undefined;
  for (const symbol of symbols) {
    if (line < symbol.line || line > symbol.endLine) continue;
    if (!best || symbol.endLine - symbol.line <= best.endLine - best.line) best = symbol;
  }
  if (!best) return undefined;
  return best.container ? `${best.container}.${best.name}` : best.name;
}

/** 分组统计：只给计数与标签，不给"结论"。 */
export interface GroupStat {
  label: string;
  count: number;
}

export interface RefsSummary {
  /** 引用按接收者书写形式分组（裸名归入 `(裸名)`）。 */
  byReceiver: GroupStat[];
  /** 引用按所在符号分组（顶层归入 `(顶层)`）。 */
  byScope: GroupStat[];
  /** 定义按所在容器分组。 */
  definitionScopes: GroupStat[];
  /** 超出 cap 未列出的分组数。 */
  hiddenGroups: number;
  /** 上面三张表覆盖的命中数（= 传入条数）。 */
  covered: number;
}

/**
 * 把 refs 命中压成三张分组表：定义落在哪些容器、引用分布在哪些类、
 * 引用按什么接收者写出来的。
 *
 * 目的只有一个：`User.save` 与 `Order.save` 被合并计数时，让调用方**看得见**
 * 歧义在哪，而不是靠一句"同名会合并"提醒。分组本身是词法的，
 * 所以标签只承诺"这里写的是 user"，不承诺"这里调的是 User 类"。
 */
export function summarizeRefs(
  items: Array<{ line: number; kind: 'definition' | 'reference'; receiver?: string; scope?: string }>,
  cap = 6,
): RefsSummary {
  const tally = (pick: (item: (typeof items)[number]) => string | undefined, kind?: 'definition' | 'reference'): GroupStat[] => {
    const map = new Map<string, number>();
    for (const item of items) {
      if (kind && item.kind !== kind) continue;
      const label = pick(item) ?? (kind === 'reference' ? '(裸名)' : '(顶层)');
      map.set(label, (map.get(label) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([label, count]) => ({ label, count }))
      /* 计数降序；同数按标签字典序，保证同一份输入每次输出一致。 */
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };

  const cut = (rows: GroupStat[]): GroupStat[] => rows.slice(0, Math.max(1, cap));
  const byReceiverAll = tally((item) => item.receiver, 'reference');
  const byScopeAll = tally((item) => item.scope, 'reference');
  const defsAll = tally((item) => item.scope, 'definition');
  const hidden = (rows: GroupStat[], keep: GroupStat[]): number => rows.length - keep.length;
  const hiddenGroups = hidden(byReceiverAll, cut(byReceiverAll))
    + hidden(byScopeAll, cut(byScopeAll))
    + hidden(defsAll, cut(defsAll));

  return {
    byReceiver: cut(byReceiverAll),
    byScope: cut(byScopeAll),
    definitionScopes: cut(defsAll),
    hiddenGroups,
    covered: items.length,
  };
}

export interface OccurrenceScan {
  occurrences: Occurrence[];
  /** 被排除的命中数：出现在注释/字符串里的同名文本（上一版会把它们算成引用）。 */
  excludedInNonCode: number;
  /** 扫描是否因上限截断。 */
  truncated: boolean;
}

/**
 * 找标识符在**代码**里的出现位置，并区分定义 / 引用。
 *
 * 判定口径（写清楚才不会让调用方误以为是类型系统）：
 *   · 定义 = 出现在 extractSymbols 给出的"名字 + 行"上；
 *   · 引用 = 其余出现在代码里的匹配（含 import、调用、类型位置）；
 *   · 注释与字符串里的匹配**不计入**，只报数量。
 *
 * 每条命中还带 `receiver` / `scope`：它们不改变计数，只让调用方看得见
 * "这 N 处里有多少是 `user.save`、多少是 `order.save`"。
 */
export function findOccurrences(
  masked: string,
  original: string,
  name: string,
  options: { max?: number; lang?: LexLang; symbols?: CodeSymbol[] } = {},
): OccurrenceScan {
  const symbol = String(name ?? '');
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    return { occurrences: [], excludedInNonCode: 0, truncated: false };
  }
  const max = Math.max(1, Math.min(Number(options.max) || 200, 500));
  const maskedLines = masked.split(/\r?\n/);
  const originalLines = original.split(/\r?\n/);
  const defs = new Set((options.symbols ?? []).filter((item) => item.name === symbol).map((item) => item.line));
  const symbols = options.symbols ?? [];
  const word = new RegExp(`(?<![\\w$])${escapeRe(symbol)}(?![\\w$])`, 'g');
  const occurrences: Occurrence[] = [];
  let excluded = 0;
  let truncated = false;

  for (let index = 0; index < maskedLines.length; index += 1) {
    const codeLine = maskedLines[index];
    const rawLine = originalLines[index] ?? '';
    /* 注释/字符串里的命中数：用原文匹配数 - 代码匹配数。
     * 差值为负说明抹过的文本里反而多了（不可能），保险起见取 max(0)。 */
    const rawCount = (rawLine.match(word) ?? []).length;
    if (rawCount === 0) continue;
    word.lastIndex = 0;
    const codeCount = (codeLine.match(word) ?? []).length;
    if (rawCount > codeCount) excluded += rawCount - codeCount;
    if (codeCount === 0) continue;

    let match: RegExpExecArray | null;
    word.lastIndex = 0;
    while ((match = word.exec(codeLine)) !== null) {
      if (occurrences.length >= max) { truncated = true; break; }
      const isDefinition = defs.has(index + 1);
      occurrences.push({
        line: index + 1,
        column: match.index + 1,
        kind: isDefinition ? 'definition' : 'reference',
        snippet: rawLine.trim().slice(0, 200),
        /* 定义行不取接收者：`public void save() {` 的前缀是修饰符，不是接收者。 */
        receiver: isDefinition ? undefined : receiverOf(codeLine, match.index + 1),
        scope: scopeOf(symbols, index + 1),
      });
    }
    if (truncated) break;
  }

  return { occurrences, excludedInNonCode: excluded, truncated };
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
