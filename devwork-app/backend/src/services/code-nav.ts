/**
 * CodeNav —— code_find 的两个原子能力：按模式找文件（glob）、按内容找行（grep）。
 *
 * 为什么单独成模块而不是塞进 agent-tools.ts：
 *   ① 这两件事都要**遍历磁盘**，安全边界（路径越界 / 敏感文件 / 二进制 / 体积）必须
 *      只能有一份实现。散在工具分支里，下一个加工具的人一定会漏掉其中一条。
 *   ② agent-tools.ts 是分发层，只该做参数归一化与结果措辞，不该有 fs.walk。
 *
 * 与索引检索（code_find mode=index）的分工——三者都叫"搜代码"，但证据强度不同：
 *   · mode=index → FTS5 索引检索，适合"不知道在哪、先摸个大概"，但索引可能过期；
 *   · mode=regex → 磁盘逐行真实匹配（本模块 grepFiles），证据是**此刻的现实**；
 *   · mode=glob  → 只按路径/名称找（本模块 globFiles），不读内容，最省 IO。
 * 结论里引用行号时应该用 grep/read 的结果，不要拿索引行号当事实（索引可能落后于工作区）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveRepoRoot } from './workspace-repos';
import { resolve } from './file-service';
import { isSensitive } from '../db/repositories';
import { extractImports, extractSymbols, findOccurrences, lexLangOf, maskNonCode, scopeOf, summarizeRefs } from './code-lex';
import type { CodeSymbol, ImportSpec, RefsSummary } from './code-lex';

/** 遍历时整棵跳过的目录：依赖、版本库、构建产物、运行时数据。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nuxt', '.venv', '__pycache__',
  'target', 'out', '.runtime', '.devwork-snapshots', '.idea', '.gradle', 'vendor',
]);

/** 只在显式支持的扩展名上做内容匹配：避免把二进制/压缩产物当文本读。 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php',
  '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.swift', '.scala', '.sql', '.sh', '.ps1',
  '.css', '.scss', '.less', '.html', '.htm', '.vue', '.svelte',
  '.md', '.mdx', '.txt', '.json', '.json5', '.yaml', '.yml', '.toml', '.ini', '.conf', '.xml', '.properties',
]);

const MAX_DEPTH = 12;
/** 扫描文件数上限：万级仓库上不设闸门 = 一次工具调用卡死整个后端进程。 */
const MAX_SCAN_FILES = 4000;

export interface FileEntry {
  /** 仓库内相对路径（统一 / 分隔）。 */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface NavOptions {
  /** 子目录（仓库内相对路径，缺省 = 仓库根）。 */
  subPath?: string;
  /** 最多返回多少条。 */
  max?: number;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * 把 glob 转正则。支持 ** / * / ? / {a,b}。
 *
 * 刻意不做的事：不支持 [] 字符类、不支持嵌套大括号内的通配、不支持 ! 取反。
 * 模型几乎不会用到这些，而每多支持一种语法就多一类可以写出灾难性回溯的表达式。
 */
export function globToRegExp(glob: string): RegExp {
  const source = String(glob ?? '').trim().replace(/\\/g, '/');
  if (!source) throw new Error('glob 模式为空');
  if (source.length > 400) throw new Error('glob 模式过长（上限 400 字符）');
  const escape = (value: string): string => value.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  let out = '';
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '*') {
      if (source[index + 1] === '*') {
        index += 1;
        if (source[index + 1] === '/') {
          /* 双星号+斜杠要能匹配零层：这样的模式必须命中根目录下的 a.ts。 */
          index += 1;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const end = source.indexOf('}', index);
      if (end === -1) {
        out += '\\{';
      } else {
        const parts = source.slice(index + 1, end).split(',');
        out += `(?:${parts.map((part) => escape(part)).join('|')})`;
        index = end;
      }
    } else {
      out += escape(ch);
    }
  }
  /* 大小写不敏感：Windows/macOS 文件系统本就不敏感，Linux 上宁可多给几条也不要
   * 让模型因为一个大小写差异得出"这个文件不存在"的错误结论。 */
  return new RegExp(`^${out}$`, 'i');
}

/** 解析遍历根：先过 file-service.resolve（含越界/敏感校验），空子路径走仓库根。 */
async function resolveScanRoot(assetId: string, subPath?: string): Promise<{ root: string; displayPrefix: string }> {
  const want = String(subPath ?? '').trim().replace(/\\/g, '/');
  if (want === '' || want === '.' || want === './') {
    return { root: path.resolve(resolveRepoRoot(assetId)), displayPrefix: '' };
  }
  const absolute = await resolve(assetId, want);
  const stat = fs.statSync(absolute);
  if (!stat.isDirectory()) throw new Error(`不是目录：${want}`);
  return { root: absolute, displayPrefix: want.replace(/\/+$/, '') };
}

/** 递归枚举文件（跳过 SKIP_DIRS 与敏感文件），返回仓库内相对路径。 */
function walkFiles(root: string, opts: { followTextOnly: boolean }): { files: FileEntry[]; scanned: number; truncated: boolean } {
  const files: FileEntry[] = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dir: string, depth: number): void => {
    if (truncated) return;
    if (depth > MAX_DEPTH) { truncated = true; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (opts.followTextOnly && !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      scanned += 1;
      if (scanned > MAX_SCAN_FILES) { truncated = true; return; }
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      const rel = path.relative(root, full).replace(/\\/g, '/');
      /* 敏感文件连路径都不该出现：列出一个 .env 的位置，等于给了一个明确的下载入口。 */
      if (isSensitive(rel) || isSensitive(entry.name)) continue;
      files.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };

  walk(root, 0);
  return { files, scanned, truncated };
}

export interface GlobResult {
  files: FileEntry[];
  scanned: number;
  truncated: boolean;
}

/** 按 glob 模式列文件，按修改时间降序（最近改过的最可能是当前任务相关的）。 */
export async function globFiles(assetId: string, pattern: string, options: NavOptions = {}): Promise<GlobResult> {
  const matcher = globToRegExp(pattern);
  const max = clamp(options.max, 100, 1, 300);
  const { root, displayPrefix } = await resolveScanRoot(assetId, options.subPath);
  const walked = walkFiles(root, { followTextOnly: false });

  /* 无 `**` 的模式只匹配当前层：`*.ts` 不该把三层目录下的 a.ts 也带出来。
   * 这是 glob 的通行语义，模型对此有稳定预期。 */
  const anchored = /(^|\/)\*\*/.test(String(pattern ?? ''));
  const matched = walked.files
    .filter((file) => (anchored ? matcher.test(file.path) : (matcher.test(file.path) || !file.path.includes('/'))))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return {
    files: matched.slice(0, max).map((file) => ({
      ...file,
      path: displayPrefix ? `${displayPrefix}/${file.path}` : file.path,
    })),
    scanned: walked.scanned,
    truncated: walked.truncated || matched.length > max,
  };
}

export interface GrepHit {
  path: string;
  /** 命中行号（1 起）。 */
  line: number;
  text: string;
  before: string[];
  after: string[];
}

export interface GrepResult {
  hits: GrepHit[];
  filesScanned: number;
  filesMatched: number;
  truncated: boolean;
  skippedLarge: number;
}

/**
 * 按正则逐行匹配文件内容，可带上下文行。
 *
 * 安全与稳定性：
 *   · 正则是模型给的，长度封顶 200 并用 try/catch 兜住编译失败（不兜就会 500）；
 *   · 单文件 512KB 封顶，超限计入 skippedLarge **并如实上报**——静默跳过等于
 *     让模型以为"全仓都没有"；
 *   · 二进制判定看前 8KB 是否含 NUL，比按扩展名猜准。
 */
export async function grepFiles(
  assetId: string,
  pattern: string,
  options: NavOptions & { glob?: string; contextLines?: number; ignoreCase?: boolean } = {},
): Promise<GrepResult> {
  const raw = String(pattern ?? '');
  if (raw.trim() === '') throw new Error('pattern 为空');
  if (raw.length > 200) throw new Error('pattern 过长（上限 200 字符，请改用更具体的片段）');

  const ignoreCase = options.ignoreCase !== false;
  let regex: RegExp;
  try {
    regex = new RegExp(raw, ignoreCase ? 'i' : '');
  } catch (error) {
    throw new Error(`正则无法编译：${error instanceof Error ? error.message : String(error)}`);
  }

  const contextLines = clamp(options.contextLines, 0, 0, 5);
  const max = clamp(options.max, 40, 1, 200);
  const fileFilter = options.glob ? globToRegExp(String(options.glob)) : null;
  const filterAnchored = options.glob ? /(^|\/)\*\*/.test(String(options.glob)) : false;

  const MAX_BYTES = 512 * 1024;
  const { root, displayPrefix } = await resolveScanRoot(assetId, options.subPath);
  const walked = walkFiles(root, { followTextOnly: true });

  const hits: GrepHit[] = [];
  let filesMatched = 0;
  let skippedLarge = 0;
  let hitCapReached = false;

  for (const file of walked.files) {
    if (hits.length >= max) { hitCapReached = true; break; }
    if (fileFilter && !(filterAnchored ? fileFilter.test(file.path) : (fileFilter.test(file.path) || !file.path.includes('/')))) continue;
    if (file.size > MAX_BYTES) { skippedLarge += 1; continue; }

    let content: string;
    try {
      const buffer = fs.readFileSync(path.join(root, file.path));
      /* NUL 出现在前 8KB 就判定为二进制，交给 skippedLarge 之外的静默跳过即可——
       * 二进制不是"跳过的大文件"，不该混进同一个计数。 */
      if (buffer.subarray(0, 8192).includes(0)) continue;
      content = buffer.toString('utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    let fileHit = false;
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue;
      if (hits.length >= max) { hitCapReached = true; break; }
      fileHit = true;
      const from = Math.max(0, index - contextLines);
      const to = Math.min(lines.length - 1, index + contextLines);
      hits.push({
        path: displayPrefix ? `${displayPrefix}/${file.path}` : file.path,
        line: index + 1,
        text: lines[index].slice(0, 400),
        before: lines.slice(from, index).map((line) => line.slice(0, 400)),
        after: lines.slice(index + 1, to + 1).map((line) => line.slice(0, 400)),
      });
    }
    if (fileHit) filesMatched += 1;
  }

  return {
    hits,
    filesScanned: walked.scanned,
    filesMatched,
    truncated: walked.truncated || hitCapReached,
    skippedLarge,
  };
}

/**
 * 找符号出现位置（供 code_find mode=refs）。
 *
 * 与 grepFiles 的差别不是"更快"，而是**证据更硬**：先过 code-lex 抹掉注释与字符串，
 * 再在剩下的代码里匹配。上一版直接 grep `\bname\b`，于是
 * `// 这里也要调 setConnectTimeout` 和 `"setConnectTimeout"` 都被算成引用，
 * 模型据此说出"有 7 处调用"——而真实调用可能只有 3 处。
 *
 * 仍然如实保留两条局限（工具输出里要写）：不做类型解析（同名不同符号会合并）、
 * 不做正则字面量识别。
 */
export interface SymbolRefHit {
  path: string;
  line: number;
  column: number;
  kind: 'definition' | 'reference';
  snippet: string;
  /** 引用处的前缀接收者（书写形式，非类型）。 */
  receiver?: string;
  /** 该处所在的符号。 */
  scope?: string;
}

export interface SymbolRefResult {
  hits: SymbolRefHit[];
  filesScanned: number;
  filesMatched: number;
  /** 出现在注释/字符串里的命中数（上一版会把这些算成引用）。 */
  excludedInNonCode: number;
  truncated: boolean;
  skippedLarge: number;
  /** 同名候选的分组视图：定义落在哪些容器、引用分布在哪些类、按什么接收者写出。 */
  summary: RefsSummary;
  /** 同名候选的跨文件收敛：哪个文件导入了哪个定义（定义散在多个文件时才有意义）。 */
  convergence: RefConvergence;
}

/* ================= 跨文件收敛（按 import 关系） ================= */

/** 解析 import 说明符时尝试补全的扩展名。顺序影响不大（要求唯一匹配），但要覆盖常见的。 */
const RESOLVE_EXTS = [
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.java', '.kt', '.py', '.go', '.rs', '.scala',
];

/** TS 的 ESM 写法：`./x.js` 实际指向 `x.ts`。 */
const ESM_EXT_MAP: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

export interface ImportLink {
  /** 命中的定义文件（仓库内相对路径）。 */
  target: string;
  /** 说明符原文。 */
  specifier: string;
  /**
   * 证据强度：
   *   `name`   = import 名单里就有这个符号（`import { save }`）；
   *   `module` = 只是导入了定义所在的模块（`import { User }` 后调 `user.save()`）。
   */
  via: 'name' | 'module';
}

export type RefFileKind = 'local' | 'linked' | 'split' | 'unknown';

export interface RefFileGroup {
  path: string;
  /** 该文件里的引用数。 */
  refs: number;
  /** 该文件里的定义数（>0 即 local）。 */
  defs: number;
  kind: RefFileKind;
  links: ImportLink[];
  /**
   * 只在 `unknown` 时有值：同目录下恰好有一个定义文件时填它。
   * Java 同包无需 import，这条不是归属，只是"下一个该看哪儿"。
   */
  sameDir?: string;
}

export interface RefConvergence {
  /** 含定义的文件（按路径排序）。 */
  definitionFiles: Array<{ path: string; defs: number; line: number; scope?: string }>;
  /** 含引用的文件（按引用数降序、同数按路径）。 */
  files: RefFileGroup[];
  /** 能被 import 收敛到唯一定义的引用数。 */
  linkedRefs: number;
  /** 无法归属的引用数。 */
  unknownRefs: number;
  /** 文件同时导入多个定义、无法拆分的引用数。 */
  splitRefs: number;
  /** 与定义同文件的引用数。 */
  localRefs: number;
  /** 超出展示上限未列出的文件数。 */
  hiddenFiles: number;
  /** 解析时读过的 import 条数（用于判断"没有证据"是不是因为没解析出来）。 */
  importsParsed: number;
}

/**
 * 把 import 说明符解析成仓库内的文件路径，只在与 `defFiles` 命中时返回。
 *
 * 两条路径：相对说明符按目录拼接（可精确解析），其余按**路径尾部**匹配
 * （`a.b.C` → `a/b/C`，`github.com/x/y` → `x/y`），并且要求**唯一命中**——
 * 一条说明符能匹配到两个定义文件时，说明它本身就是歧义的，此时返回 null
 * 让调用方写"无法归属"，比挑一个更像答案的强。
 */
function resolveImportTarget(importer: string, spec: ImportSpec, defFiles: string[]): string | null {
  if (defFiles.length === 0) return null;
  const norm = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '');
  const candidates = new Set<string>();

  if (spec.relative) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(norm(importer)), spec.specifier));
    candidates.add(base);
    for (const ext of RESOLVE_EXTS) {
      candidates.add(`${base}${ext}`);
      candidates.add(`${base}/index${ext}`);
    }
    /* `./x.js` → `x.ts`：先剥扩展再补 TS 扩展名。 */
    const dot = base.lastIndexOf('.');
    if (dot > base.lastIndexOf('/')) {
      const stem = base.slice(0, dot);
      const ext = base.slice(dot);
      for (const swap of [...(ESM_EXT_MAP[ext] ?? []), ext]) candidates.add(`${stem}${swap}`);
      for (const extra of RESOLVE_EXTS) candidates.add(`${stem}${extra}`);
    }
  } else {
    const segments = spec.specifier.replace(/^@[\w-]+\//, '').replace(/[.:]/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
    /* 从最长尾部往下试，**第一个有命中的层就定结果**。
     * 不能把所有层级的命中并起来：`a.Repo` 在长尾部命中 a/Repo，短尾部 `Repo.java`
     * 又会把 b/Repo 也拉进来，于是"其实很确定"的一条 import 变成"无法归属"。 */
    for (let take = segments.length; take >= 1; take -= 1) {
      const tail = segments.slice(-take).join('/');
      const hits = new Set<string>();
      for (const file of defFiles) {
        const target = norm(file);
        if (target === tail) { hits.add(file); continue; }
        for (const ext of RESOLVE_EXTS) {
          if (target === `${tail}${ext}` || target.endsWith(`/${tail}${ext}`)) { hits.add(file); break; }
        }
      }
      if (hits.size === 0) continue;
      return hits.size === 1 ? [...hits][0] : null;
    }
    return null;
  }

  const matched = new Set<string>();
  for (const candidate of candidates) {
    for (const file of defFiles) {
      if (norm(file) === candidate) matched.add(file);
    }
  }
  return matched.size === 1 ? [...matched][0] : null;
}

/**
 * 按 import 关系把引用收敛到定义文件。
 *
 * 这一步回答的是"这几个文件里的 `save` 是同一个 `save` 吗"——很可能是
 * 既有 §15 的接收者分组（`user.save` / `order.save`）**看不出来**的那种歧义，
 * 因为跨文件的同名符号往往写成一样的接收者名。import 是原文里实打实写着的，
 * 所以它能当证据；但它证明的是"文件导入了那个模块"，不是"这一行调用解析到它"。
 * 输出措辞必须守住这条线。
 */
function buildConvergence(
  symbol: string,
  hits: SymbolRefHit[],
  importsByFile: Map<string, ImportSpec[]>,
  importsParsed: number,
  cap = 8,
): RefConvergence {
  const defsByFile = new Map<string, { count: number; line: number; scope?: string }>();
  const refsByFile = new Map<string, number>();
  for (const hit of hits) {
    if (hit.kind === 'definition') {
      const entry = defsByFile.get(hit.path) ?? { count: 0, line: hit.line };
      entry.count += 1;
      entry.line = Math.min(entry.line, hit.line);
      entry.scope = entry.scope ?? hit.scope;
      defsByFile.set(hit.path, entry);
    } else {
      refsByFile.set(hit.path, (refsByFile.get(hit.path) ?? 0) + 1);
    }
  }

  const defFiles = [...defsByFile.keys()].sort();
  const groups: RefFileGroup[] = [];
  let linkedRefs = 0;
  let unknownRefs = 0;
  let splitRefs = 0;
  let localRefs = 0;

  for (const [file, refs] of refsByFile) {
    const localDefs = defsByFile.get(file)?.count ?? 0;
    if (localDefs > 0) {
      groups.push({ path: file, refs, defs: localDefs, kind: 'local', links: [] });
      localRefs += refs;
      continue;
    }

    const links: ImportLink[] = [];
    for (const spec of importsByFile.get(file) ?? []) {
      const target = resolveImportTarget(file, spec, defFiles);
      if (!target) continue;
      /* 证据强度只看一件事：import 名单里有没有**这个符号**。
       * `import { User }` 后调 `user.save()` 只证明导入了模块，不证明调的是那个 save。 */
      const via: ImportLink['via'] = spec.names.includes(symbol) ? 'name' : 'module';
      const existing = links.find((item) => item.target === target);
      if (existing) {
        if (via === 'name') existing.via = 'name';
        continue;
      }
      links.push({ target, specifier: spec.specifier, via });
    }

    if (links.length === 0) {
      const dir = path.posix.dirname(file);
      const sameDir = defFiles.find((item) => path.posix.dirname(item) === dir && /\.java$/i.test(file));
      groups.push({ path: file, refs, defs: 0, kind: 'unknown', links, sameDir });
      unknownRefs += refs;
      continue;
    }
    if (links.length === 1) {
      groups.push({ path: file, refs, defs: 0, kind: 'linked', links });
      linkedRefs += refs;
      continue;
    }
    groups.push({ path: file, refs, defs: 0, kind: 'split', links });
    splitRefs += refs;
  }

  groups.sort((a, b) => b.refs - a.refs || a.path.localeCompare(b.path));
  const kept = groups.slice(0, Math.max(1, cap));

  return {
    definitionFiles: defFiles.map((file) => ({
      path: file,
      defs: defsByFile.get(file)?.count ?? 0,
      line: defsByFile.get(file)?.line ?? 1,
      scope: defsByFile.get(file)?.scope,
    })),
    files: kept,
    linkedRefs,
    unknownRefs,
    splitRefs,
    localRefs,
    hiddenFiles: groups.length - kept.length,
    importsParsed,
  };
}

export async function findSymbolOccurrences(
  assetId: string,
  symbol: string,
  options: NavOptions & { glob?: string } = {},
): Promise<SymbolRefResult> {
  const max = clamp(options.max, 40, 1, 200);
  const fileFilter = options.glob ? globToRegExp(String(options.glob)) : null;
  const filterAnchored = options.glob ? /(^|\/)\*\*/.test(String(options.glob)) : false;
  const MAX_BYTES = 512 * 1024;

  const { root, displayPrefix } = await resolveScanRoot(assetId, options.subPath);
  const walked = walkFiles(root, { followTextOnly: true });

  const hits: SymbolRefHit[] = [];
  const importsByFile = new Map<string, ImportSpec[]>();
  let importsParsed = 0;
  let filesMatched = 0;
  let skippedLarge = 0;
  let excluded = 0;
  let truncated = walked.truncated;

  for (const file of walked.files) {
    if (hits.length >= max) { truncated = true; break; }
    if (fileFilter && !(filterAnchored ? fileFilter.test(file.path) : (fileFilter.test(file.path) || !file.path.includes('/')))) continue;
    if (file.size > MAX_BYTES) { skippedLarge += 1; continue; }

    let content: string;
    try {
      const buffer = fs.readFileSync(path.join(root, file.path));
      if (buffer.subarray(0, 8192).includes(0)) continue;
      content = buffer.toString('utf8');
    } catch {
      continue;
    }

    const lang = lexLangOf(file.path);
    const mask = maskNonCode(content, lang);
    const symbols = extractSymbols(mask.masked, content, lang);
    const scan = findOccurrences(mask.masked, content, symbol, { max: max - hits.length, symbols });
    excluded += scan.excludedInNonCode;
    if (scan.truncated) truncated = true;
    if (scan.occurrences.length === 0) continue;

    const displayPath = displayPrefix ? `${displayPrefix}/${file.path}` : file.path;
    /* import 只在**真有引用**的文件上解析：没有引用的文件对收敛表没有贡献，
     * 整仓 refs 时给每个文件都跑一遍正则纯属浪费。 */
    const imports = extractImports(mask.masked, content, lang);
    importsByFile.set(displayPath, imports);
    importsParsed += imports.length;

    filesMatched += 1;
    for (const item of scan.occurrences) {
      hits.push({
        path: displayPath,
        line: item.line,
        column: item.column,
        kind: item.kind,
        snippet: item.snippet,
        receiver: item.receiver,
        scope: item.scope,
      });
    }
  }

  return {
    hits,
    filesScanned: walked.scanned,
    filesMatched,
    excludedInNonCode: excluded,
    truncated: truncated || hits.length >= max,
    skippedLarge,
    summary: summarizeRefs(hits),
    convergence: buildConvergence(symbol, hits, importsByFile, importsParsed),
  };
}

/** 读文件的行区间（供 code_view mode=content 分页）。入参来自模型，故按 unknown 收口后自行 clamp。 */
export function sliceLines(content: string, offset: unknown, limit: unknown): { lines: string[]; total: number; start: number; end: number } {
  const all = content.split(/\r?\n/);
  /* 末尾换行会 split 出一个空串，但那不是第 N+1 行——扣掉，否则总行数永远多 1。 */
  const total = all.length > 0 && all[all.length - 1] === '' ? all.length - 1 : all.length;
  const start = clamp(offset, 1, 1, Math.max(total, 1));
  const end = Math.min(total, start + clamp(limit, 120, 1, 400) - 1);
  return { lines: all.slice(start - 1, end), total, start, end };
}

/* ================= 遗留标记（code_todos） ================= */

/** 匹配 `TODO: xxx` / `FIXME xxx` / `HACK`。`\b` 让 `TODO_LIST` 这种标识符不算标记。 */
const TODO_PATTERN = /\b(TODO|FIXME|HACK)\b[:\s]?([^\n]{0,120})/;

/**
 * 只有这些扩展名才做"所属符号"推断。
 *
 * `.md` / `.json` / `.sql` 里没有"方法"这种东西，给它们标"模块级"是在编造结构。
 * 注意不能用 `lexLangOf` 判断——它对未知扩展名返回 `'clike'` 兜底，那是"按 C 语法试试"，
 * 不是"这是代码文件"。
 */
const SYMBOL_EXTS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|java|kt|kts|scala|groovy|py|go|rs)$/i;

/** 单文件读取上限：超过就跳过并计数。扫描二进制/压缩产物不该拖住整个后端。 */
const MAX_TODO_FILE_BYTES = 200 * 1024;

export interface TodoHit {
  path: string;
  line: number;
  marker: string;
  /** 标记后的说明（截断 120）。没有说明时为空串——由调用方决定怎么措辞。 */
  text: string;
  /**
   * 包含该行的最内层符号（`Class.method` / `fn`）。
   *
   * `undefined` 有两种含义，用 `codeFile` 区分：代码文件里"确实不在任何符号内"（模块级），
   * 或非代码文件"没有符号这个概念"。把这两种都说成"模块级"是撒谎。
   */
  owner?: string;
  /** 该扩展名是否支持符号推断。 */
  codeFile: boolean;
}

export interface TodoScanResult {
  hits: TodoHit[];
  /** 真正读过内容的文件数。 */
  filesRead: number;
  /** 超过单文件上限被跳过的个数（结果是"没扫到"的一部分原因，必须报出来）。 */
  skippedLarge: number;
  /**
   * 到上限就停了：**后面的文件没看**。
   *
   * 这里刻意不叫 `truncated`：它描述的既不是"还有更多"也不是"精度损失"，
   * 而是"这次扫描提前结束"。调用方只能由此说"结果不保证完整"，
   * 不能说"后面还有"——第 100 条恰好是仓库最后一个标记时，后者就是假的。
   */
  stoppedAtCap: boolean;
  /** 遍历时因为文件数上限被截断（连"看完了"都不敢说）。 */
  walkTruncated: boolean;
}

/**
 * 扫仓库里的 TODO / FIXME / HACK。
 *
 * 与旧实现（散在 agent-tools 的分支里）的三个差别：
 *   ① 复用 `walkFiles`：跳过规则、敏感文件、文件数上限只有一份实现；
 *   ② 给每条命中补**所属符号**——"L42 有个 TODO"和"OrderService.createOrder 里有个 TODO"
 *      对下一步动作的暗示完全不同：后者能直接定位要读哪一段；
 *   ③ 把"为什么可能没扫全"（大文件跳过 / 遍历截断 / 命中触顶）分成三个独立事实。
 */
export async function scanTodos(assetId: string, options: NavOptions = {}): Promise<TodoScanResult> {
  const max = clamp(options.max, 30, 1, 100);
  const { root, displayPrefix } = await resolveScanRoot(assetId, options.subPath);
  const walked = walkFiles(root, { followTextOnly: true });

  const hits: TodoHit[] = [];
  let filesRead = 0;
  let skippedLarge = 0;
  let stoppedAtCap = false;

  for (const file of walked.files) {
    if (hits.length >= max) { stoppedAtCap = true; break; }
    if (file.size > MAX_TODO_FILE_BYTES) { skippedLarge += 1; continue; }
    let content: string;
    try { content = fs.readFileSync(path.join(root, file.path), 'utf8'); } catch { continue; }
    /* NUL 出现在前 8KB 判定为二进制：不是"跳过的大文件"，不该混进同一个计数，静默跳过。 */
    if (content.slice(0, 8192).includes('\u0000')) continue;
    filesRead += 1;

    const lines = content.split(/\r?\n/);
    let fileSymbols: CodeSymbol[] | null = null;
    const codeFile = SYMBOL_EXTS.test(file.path);
    const ownerAt = (line: number): string | undefined => {
      if (!codeFile) return undefined;
      if (fileSymbols === null) {
        /* 懒解析：只对**真有标记**的文件付词法成本。整仓扫 TODO 时解析几千个文件是浪费。 */
        const lang = lexLangOf(file.path);
        fileSymbols = extractSymbols(maskNonCode(content, lang).masked, content, lang);
      }
      return scopeOf(fileSymbols, line);
    };

    for (let index = 0; index < lines.length; index += 1) {
      const match = TODO_PATTERN.exec(lines[index]);
      if (!match) continue;
      /* 没有说明也要给一条——"这里有个 TODO 但没写内容"本身就是结论。 */
      const owner = ownerAt(index + 1);
      hits.push({
        path: displayPrefix ? `${displayPrefix}/${file.path}` : file.path,
        line: index + 1,
        marker: match[1],
        text: (match[2] ?? '').trim(),
        owner,
        codeFile,
      });
      if (hits.length >= max) { stoppedAtCap = true; break; }
    }
  }

  /* 目录顺序不可靠：按路径 + 行号排一下，同样的仓库两次扫描给出同样的列表。 */
  hits.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));

  return { hits, filesRead, skippedLarge, stoppedAtCap, walkTruncated: walked.truncated };
}
