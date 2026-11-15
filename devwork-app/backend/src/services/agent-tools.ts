/**
 * AgentTools —— 派生工具面的真实执行器。
 *
 * 每个实现都必须「真」：要么真实读盘/真实查询/真实 HTTP/真实 git，要么如实报降级，
 * 绝不编造输出（这是本仓库从 V8 起的铁律）。
 * 写工具（v2）在这里只表达意图不执行——执行走 write-executor 的三层防线，
 * 且只有「会话级审批」命中时才会真正落盘。
 *
 * ============ 两条结构性约定（V10） ============
 *
 * ① **入口归一别名**：V10 把 9 个"同对象多动词"的工具合并成 6 个带 mode 的工具，
 *    旧名（code_read / db_schema / skill_load …）不再进模型工具面，但历史轨迹与
 *    旧技能模板还在用它们。所以本函数第一件事是 normalizeToolCall()，之后 switch
 *    只认正式名——**同一个动作只有一份实现**，不会出现"旧名有 bug 新名修好了"。
 *
 * ② **mode 必须显式**：多 mode 工具靠 args.mode 分派，缺失时直接报错并列出可选值，
 *    不猜默认值。猜错的代价是"看起来成功、其实查错了东西"，比报错更贵。
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readContent, fileOutline, fileDiff, repoStatus, resolve as resolveFilePath } from './file-service';
import { resolveRepoRoot } from './workspace-repos';
import { runSqlQuery } from './sql-query';
import { listObjects, tableFields } from './sql-browse';
import { searchAsset as searchIndex, chunkById } from './indexer';
import { all, get, run } from '../db/database';
import { readLogLines, filterByWindow } from './log-sink';
import { normalizeBrowserUrl, readBrowserPage, writeBrowserState } from './browser';
import { PORT, browserAllowPrivate } from '../config';
import type { Identity } from '../http/core';
import type { CitationSeed, ToolExecutionResult } from './llm-gateway';
import { normalizeToolCall, type DerivedTool } from '../config/tool-catalog';
import { writeTodoPlan } from './todo';
import { globFiles, grepFiles, findSymbolOccurrences, sliceLines, scanTodos } from './code-nav';
import { splitDiffByFile, assembleDiff } from './git-diff';
import { webFetch } from './web-fetch';
import { searchWeb } from './web-search';
import { SKILL_REGISTRY, validateSkillRegistry } from '../config/skills';
import type { SubagentOutcome } from './subagent';

export interface ToolContext {
  assetId: string;
  workspaceId: string;
  conversationId: string;
  identity: Identity;
  /**
   * 子代理执行器：由会话编排注入（只有它同时拿到网关与只读子面）。
   * 没注入就是"本进程没有子代理能力"，工具要如实说不可用，不能假装跑过了。
   */
  subagent?: (input: { goal: string; maxToolCalls: number }) => Promise<SubagentOutcome>;
}

function snippetOf(content: string): string {
  return content.split('\n').slice(0, 5).join('\n');
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 索引检索（kb_search / code_find(mode=index) 共用实现）。 */
async function searchTool(assetId: string, query: string, sourceLabel: string): Promise<ToolExecutionResult> {
  const hits = await searchIndex(assetId, query);
  if (hits.length === 0) {
    return {
      ok: true,
      result: `未命中任何片段（资产=${assetId} · query=${query}）。没有证据就不该有结论。`,
      citations: [],
    };
  }
  const citations: CitationSeed[] = [];
  for (const hit of hits.slice(0, 4)) {
    const chunk = await chunkById(hit.id);
    if (!chunk) continue;
    citations.push({
      title: hit.title,
      source: `${sourceLabel} · ${hit.path}`,
      locator: hit.locator,
      snippet: snippetOf(chunk.content),
      confidence: Number(hit.score) || 0.8,
      version: hit.kind === 'doc' ? 'doc' : 'code',
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      kind: hit.kind,
    });
  }
  const summary = hits.map((hit) => `- ${hit.title} · ${hit.locator} · 相关度 ${hit.score}`).join('\n');
  return { ok: true, result: `命中 ${hits.length} 个片段（资产=${assetId}）\n${summary}`, citations };
}

/** API 资产的真实端点清单（本服务自身的只读 REST 面）。 */
export const API_ENDPOINTS: { method: string; path: string; desc: string; readOnly: boolean }[] = [
  { method: 'GET', path: '/api/health', desc: '健康检查（git/docker 探测）', readOnly: true },
  { method: 'GET', path: '/api/workspaces', desc: '工作区列表', readOnly: true },
  { method: 'GET', path: '/api/assets', desc: '资产列表', readOnly: true },
  { method: 'GET', path: '/api/skills', desc: '技能清单（含派生可用性）', readOnly: true },
  { method: 'GET', path: '/api/settings', desc: '设置快照', readOnly: true },
  { method: 'GET', path: '/api/cmd-templates', desc: '命令模板库（意图导向）', readOnly: true },
  { method: 'GET', path: '/api/tools', desc: '派生工具面（诊断）', readOnly: true },
];

/** api_call_read 的路径白名单 = 规范清单里的只读端点。 */
function isAllowedApiPath(pathname: string): boolean {
  return API_ENDPOINTS.some((endpoint) => endpoint.readOnly && endpoint.path === pathname);
}

/* ================= code_find / code_view 的共用实现 ================= */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 符号定位（code_find mode=refs）。
 *
 * 词法级，不是类型级。四轮演进的口径差别值得记住：
 *   v1 整行正则 `\bname\b` → 注释、字符串里的同名文本全算引用；
 *   v2 加"定义形态"判断 → 定义/引用能分了，但注释里的 `function foo` 仍算定义；
 *   v3 先抹掉注释与字符串再匹配，并把**被排除的数量**如实报出来；
 *   v4（当前）再给三张分组表：定义落在哪些容器、引用分布在哪些类、按什么接收者写出。
 *
 * v4 解决的是 v3 留下的那句话——"`Order.save()` 与 `User.save()` 会被合并计数"。
 * 不写局部符号表解析器，而是把**歧义摆出来**让调用方自己判断：同名命中里
 * 如果定义散在 3 个类、引用写成 2 种接收者，那"9 处引用"本来就没有单一含义。
 * 度量上仍是词法的，所以输出里绝不给"引用共 N 处"这种结论式措辞。
 */
async function findSymbolRefs(
  assetId: string,
  symbol: string,
  options: { glob?: string; subPath?: string; max?: number },
): Promise<ToolExecutionResult> {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
    return {
      ok: false,
      result: `mode=refs 的 pattern 必须是单个标识符（字母/数字/下划线/$，且不以数字开头）：${symbol || '（空）'}。`
        + '要找一串文本请改用 mode=regex。',
    };
  }
  const max = options.max ?? 40;
  const scan = await findSymbolOccurrences(assetId, symbol, {
    glob: options.glob,
    subPath: options.subPath,
    max,
  });

  if (scan.hits.length === 0 && scan.excludedInNonCode === 0) {
    return {
      ok: true,
      result: `符号 ${symbol} 在仓库代码里没有任何出现（扫描 ${scan.filesScanned} 个文件${scan.skippedLarge > 0 ? `，${scan.skippedLarge} 个超大文件跳过` : ''}）。`
        + '真没有就是真没有——不要因为"应该有"就改用猜测的位置。',
    };
  }

  const defs = scan.hits.filter((hit) => hit.kind === 'definition');
  const refs = scan.hits.filter((hit) => hit.kind === 'reference');
  const line = (hit: { path: string; line: number; column: number; snippet: string }): string =>
    `- ${hit.path}:L${hit.line}:C${hit.column} · ${hit.snippet}`;

  const { summary, convergence } = scan;
  const fmt = (rows: Array<{ label: string; count: number }>): string =>
    rows.map((row) => `${row.label} ${row.count}`).join('、');
  /* 全是裸名（类型名、import 之类）时，接收者表什么都说明不了——整行不印。 */
  const receiverRows = summary.byReceiver.length === 1 && summary.byReceiver[0].label === '(裸名)'
    ? []
    : summary.byReceiver;
  /* 定义散在多个文件时才做跨文件收敛：单文件里两个类的同名方法，import 帮不上忙。 */
  const converged = convergence.definitionFiles.length >= 2;

  const convRows: string[] = [];
  if (converged) {
    convRows.push(`同名候选的跨文件收敛（按 import 关系，不做类型推断）——定义散在 ${convergence.definitionFiles.length} 个文件：`);
    for (const file of convergence.definitionFiles.slice(0, 8)) {
      convRows.push(`  · 定义 ${file.defs} 处：${file.path}:L${file.line}${file.scope ? `（${file.scope}）` : ''}`);
    }
    for (const group of convergence.files) {
      const head = `  · ${group.path}（引用 ${group.refs}`;
      if (group.kind === 'local') {
        convRows.push(`${head} / 定义 ${group.defs}）：引用与定义同文件`);
        continue;
      }
      if (group.kind === 'unknown') {
        /* 「同目录」不是归属：Java 同包不需要 import，这条只说明下一个该看哪儿。 */
        convRows.push(`${head}）：没有 import 证据，无法归属`
          + (group.sameDir ? `（同目录有定义的 ${group.sameDir}：Java 同包无需 import，从 import 判不出来）` : ''));
        continue;
      }
      if (group.kind === 'split') {
        const targets = group.links.map((link) => `${link.target}（${link.specifier}）`).join('、');
        convRows.push(`${head}）：导入了 ${group.links.length} 个定义文件，无法拆分 → ${targets}`);
        continue;
      }
      const link = group.links[0];
      convRows.push(`${head}）：导入 ${link.specifier} → ${link.target}`
        + (link.via === 'name' ? '（import 名单里就有这个符号）' : '（只导入了模块，名单里没有这个符号）'));
    }
    if (convergence.hiddenFiles > 0) {
      convRows.push(`  · 另有 ${convergence.hiddenFiles} 个引用文件未列出（缩小 glob / path 再看）`);
    }
    /* 汇总只给四类计数，不给结论。四类加起来正好是"能归属 / 分不开 / 判不了 / 本来就在一起"。 */
    convRows.push(`  · 汇总：引用 ${convergence.linkedRefs + convergence.unknownRefs + convergence.splitRefs + convergence.localRefs} 处——`
      + `按 import 归入唯一定义 ${convergence.linkedRefs}、导入多个定义分不开 ${convergence.splitRefs}、`
      + `无法归属 ${convergence.unknownRefs}、与定义同文件 ${convergence.localRefs}`);
    if (convergence.importsParsed === 0) {
      convRows.push('  · 这些文件里一条 import 都没解析出来：可能是方言不支持（只认 ts/java/python/go/rust），'
        + '也可能依赖是全局注入的');
    }
    convRows.push('  · 「归入」只表示该文件导入了那个定义所在模块，不表示每一处调用都解析到它（变量实际类型仍需人工确认）');
  }

  /* 分组只在真有歧义时才出现：单定义 + 单接收者的符号，多印三行只是噪音。 */
  const ambiguous = converged || summary.definitionScopes.length > 1
    || receiverRows.length > 1
    || summary.byScope.length > 1;
  const digest = ambiguous ? [
    /* 跨文件收敛有自己的抬头（含"不做类型推断"）；没有收敛表时补上原抬头。 */
    converged ? '' : '同名候选分组（按书写形式分，不做类型推断）：',
    ...convRows,
    /* 收敛表已经逐个列了定义文件与所属符号，这里不再重复一张容器表。 */
    converged ? '' : summary.definitionScopes.length > 1
      ? `  · 定义落在 ${summary.definitionScopes.length} 个容器：${fmt(summary.definitionScopes)}`
      : summary.definitionScopes.length === 1
        ? `  · 定义 ${summary.definitionScopes[0].count} 处（${summary.definitionScopes[0].label}）：没有同名第二定义，`
          + '引用大概率同源（依赖里的同名方法不在扫描范围）'
        /* 定义 0 处时正文已经说了"可能来自依赖"，这里不再重复一遍。 */
        : '',
    receiverRows.length > 0 ? `  · 引用按接收者：${fmt(receiverRows)}` : '',
    summary.byScope.length > 0 ? `  · 引用按所在符号：${fmt(summary.byScope)}` : '',
    summary.hiddenGroups > 0 ? `  · 另有 ${summary.hiddenGroups} 个分组未列出（缩小 glob 再看）` : '',
    scan.truncated ? `  · 分组基于已列出的 ${summary.covered} 处，命中已被上限 ${max} 截断` : '',
  ].filter(Boolean) : [];

  return {
    ok: true,
    result: [
      `符号 ${symbol}：代码里出现 ${scan.hits.length} 处（定义 ${defs.length} / 引用 ${refs.length}），涉及 ${scan.filesMatched} 个文件`,
      /* 「被排除的注释/字符串命中」是本模式最有价值的一条：它解释了为什么
       * 你 grep 到的数量和这里不一样，避免模型以为工具漏了。 */
      scan.excludedInNonCode > 0
        ? `另有 ${scan.excludedInNonCode} 处出现在注释或字符串里，已排除（不是代码引用）`
        : '注释与字符串里没有同名文本（本次排除 0 处）',
      ambiguous
        ? '（词法级判定，非类型系统：同名不同符号在总数里合并、在下面的分组里分开；不做正则字面量识别）'
        : '（词法级判定，非类型系统：同名不同符号会合并；不做正则字面量识别）',
      ...digest,
      defs.length > 0 ? '定义：\n' + defs.map(line).join('\n') : '定义：0 处（这个符号可能来自依赖、拼错了，或定义在未扫描的超大文件里）',
      refs.length > 0 ? '引用：\n' + refs.map(line).join('\n') : '',
      scan.truncated ? `（命中数被上限 ${max} 截断：加 glob / path 缩小范围，或提高 max）` : '',
      scan.skippedLarge > 0 ? `（${scan.skippedLarge} 个超过 512KB 的文件被跳过，结果不含它们）` : '',
    ].filter(Boolean).join('\n'),
  };
}

/** code_find 的四条判据。 */
async function codeFind(assetId: string, mode: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const pattern = String(args.pattern ?? '');
  if (!pattern.trim()) return { ok: false, result: 'pattern 参数为空（各 mode 都需要一个"找什么"）' };

  if (mode === 'index') return searchTool(assetId, pattern.trim(), '代码库');

  if (mode === 'refs') {
    try {
      return await findSymbolRefs(assetId, pattern.trim(), {
        glob: typeof args.glob === 'string' ? args.glob : undefined,
        subPath: typeof args.path === 'string' ? args.path : undefined,
        max: clampInt(args.max, 40, 1, 200),
      });
    } catch (error) {
      return { ok: false, result: `符号定位失败：${errorText(error)}` };
    }
  }

  if (mode === 'glob') {
    try {
      const result = await globFiles(assetId, pattern, {
        subPath: typeof args.path === 'string' ? args.path : undefined,
        max: Number(args.max ?? 100),
      });
      if (result.files.length === 0) {
        return {
          ok: true,
          result: `没有文件匹配 ${pattern}（已扫描 ${result.scanned} 个文件${result.truncated ? '，扫描被上限截断' : ''}）。`
            + '没有就是没有，不要换一个猜的路径当结论。',
        };
      }
      const lines = result.files.map((file) => {
        const when = new Date(file.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
        return `- ${file.path} · ${file.size}B · ${when}`;
      });
      return {
        ok: true,
        result: [
          `匹配 ${pattern}：${result.files.length} 个（扫描 ${result.scanned} 个文件，按修改时间从新到旧）`,
          ...lines,
          result.truncated ? '（结果被上限截断：缩小 pattern 或加 path 再找一次）' : '',
        ].filter(Boolean).join('\n'),
      };
    } catch (error) {
      return { ok: false, result: `查找失败：${errorText(error)}` };
    }
  }

  /* 剩下的只有 regex —— 显式判一下，别让未知 mode 静默走 regex。 */
  if (mode !== 'regex') {
    return { ok: false, result: `未知 mode：${mode}。可选：regex / glob / index / refs。` };
  }
  try {
    const result = await grepFiles(assetId, pattern, {
      glob: typeof args.glob === 'string' ? args.glob : undefined,
      subPath: typeof args.path === 'string' ? args.path : undefined,
      contextLines: Number(args.contextLines ?? 0),
      max: Number(args.max ?? 40),
      ignoreCase: args.ignoreCase !== false,
    });
    if (result.hits.length === 0) {
      return {
        ok: true,
        result: `未命中：/${pattern}/（扫描 ${result.filesScanned} 个文件`
          + `${result.skippedLarge > 0 ? `，跳过 ${result.skippedLarge} 个超 512KB 的大文件` : ''}）。`
          + '真实扫描结果为空，不要据此编造文件内容。',
      };
    }
    const blocks = result.hits.map((hit) => [
      ...hit.before.map((line, index) => `${hit.path}-${hit.line - hit.before.length + index}- ${line}`),
      `${hit.path}:${hit.line}: ${hit.text}`,
      ...hit.after.map((line, index) => `${hit.path}-${hit.line + index + 1}- ${line}`),
    ].join('\n'));
    return {
      ok: true,
      result: [
        `/${pattern}/ 命中 ${result.hits.length} 处（${result.filesMatched} 个文件，扫描 ${result.filesScanned} 个）`,
        result.truncated ? '（命中数被上限截断：加 glob / path 缩小范围，或提高 max）' : '',
        ...blocks,
      ].filter(Boolean).join('\n'),
    };
  } catch (error) {
    return { ok: false, result: `搜索失败：${errorText(error)}` };
  }
}

/**
 * `mode=diff` 的正文预算。
 *
 * 比 `git show` 的 5000 小：单文件视图通常紧接在 `mode=status` 之后，用来确认
 * 某个具体文件"到底改了什么"，不需要把整次提交的体量都塞进来。
 */
const DIFF_VIEW_BUDGET = 3000;

/** code_view 的四个视角：读正文 / 符号大纲 / 单文件变更 / 整仓工作区状态。 */
async function codeView(assetId: string, mode: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const rel = String(args.path ?? '').trim();

  /* status 是唯一允许不带 path 的 mode：它问的是"这批活改到了哪些文件"，
   * 而模型现在只能自己猜文件名逐个 diff——猜文件名就是幻觉的入口。 */
  if (mode === 'status') {
    try {
      const status = await repoStatus(assetId, rel || undefined);
      if (status.entries.length === 0) {
        return {
          ok: true,
          result: `${rel ? `${rel} ` : ''}工作区干净：没有未提交变更，也没有未追踪文件`
            + '（这是 git 的当前事实，不是"看起来没有改动"）',
        };
      }
      const tally = new Map<string, number>();
      for (const entry of status.entries) {
        const label = entry.code === '??' ? '未追踪'
          : entry.code.includes('R') ? '重命名'
            : entry.code.includes('D') ? '删除'
              : entry.code.includes('A') ? '新增'
                : '修改';
        tally.set(label, (tally.get(label) ?? 0) + 1);
      }
      const counts = [...tally.entries()].map(([label, n]) => `${label} ${n}`).join(' · ');
      return {
        ok: true,
        result: [
          `${rel ? `${rel} 范围内` : '工作区'}共 ${status.entries.length} 项变更（${counts}）：`,
          ...status.entries.map((entry) => `${entry.code} ${entry.path}`),
          status.truncated ? `（超过 40 项，只列出前 40 项：加 path 缩小范围）` : '',
          status.hiddenSensitive > 0 ? `（另有 ${status.hiddenSensitive} 项命中敏感规则，路径已隐藏）` : '',
          '（状态码：`M `=已暂存修改 / ` M`=工作区修改 / `??`=未追踪 / `D `=已暂存删除）',
        ].filter(Boolean).join('\n'),
      };
    } catch (error) {
      return { ok: false, result: `读取工作区状态失败：${errorText(error)}` };
    }
  }

  if (!rel) {
    return { ok: false, result: `mode=${mode} 需要 path（要看哪个文件）。只想看"改到了哪些文件"请用 mode=status。` };
  }

  if (mode === 'outline') {
    try {
      const outline = await fileOutline(assetId, rel);
      /* 带行区间与所属容器：模型据此可以直接 code_view(mode=content, offset/limit)
       * 读方法体，不必"从第 1 行读到 400 行"再自己找。endLine 缺省时说明没解析出闭合大括号，
       * 这里不得编一个区间——只写起始行，让模型自己接着读。 */
      const symbols = outline.symbols.map((s) => {
        const span = typeof s.endLine === 'number' && s.endLine > s.line ? ` L${s.line}-${s.endLine}` : ` L${s.line}`;
        const owner = s.container ? `${s.container}.` : '';
        return `- [${s.sg}] ${owner}${s.label}${span}`;
      }).join('\n');
      return {
        ok: true,
        result: `${rel} 符号大纲（${outline.symbols.length} 项，L=行号区间）：\n${symbols}\n${outline.references.join('；')}\n${outline.git.join(' · ')}`,
      };
    } catch (error) {
      return { ok: false, result: `大纲失败：${errorText(error)}` };
    }
  }

  if (mode === 'diff') {
    try {
      const diff = await fileDiff(assetId, rel);
      if (diff.untracked) {
        return {
          ok: true,
          result: `${rel} 是未追踪文件（git 新增，还没 add）：diff 里看不到它的内容。`
            + '这不等于"没有改动"——要看内容请用 mode=content，要知道还有哪些文件动过用 mode=status。',
        };
      }
      if (diff.clean) return { ok: true, result: `${rel} 相对 HEAD 无变更（clean）` };

      /* 单文件 diff 以前是 `diff.slice(0, 3000)`——和 git show 同一个毛病：
       * 在一段 hunk 的**中间**裁一刀，`-old()` 与 `+new()` 被切开，
       * 读出来的结论就是"删了一个方法"。现在走同一套边界装配。 */
      const chunks = splitDiffByFile(diff.diff);
      if (chunks.length === 0) {
        /* 有 diff 却切不出文件块：二进制改动或纯模式变更。原样给抬头，不猜内容。 */
        return {
          ok: true,
          result: `${rel} 有未提交变更，但没有可展开的文本 hunk（二进制 / 仅模式变更）：\n`
            + diff.diff.slice(0, 600),
        };
      }
      const assembled = assembleDiff(chunks, DIFF_VIEW_BUDGET, { header: chunks.length > 1 });
      const totalHunks = chunks.reduce((sum, chunk) => sum + chunk.hunks, 0);
      const notes: string[] = [];
      const reduced = assembled.partial.length > 0 || assembled.clipped.length > 0 || assembled.skipped.length > 0;
      if (reduced) {
        notes.push(`（本次展示 ${assembled.used}/${DIFF_VIEW_BUDGET} 字符；`
          + '没展示的部分就是没展示，别把"没看到"当成"没改"）');
      }
      if (assembled.partial.length > 0) {
        notes.push('只展开了一部分 hunk：'
          + assembled.partial.map((item) => `${item.shown}/${item.total} 个`).join('、')
          + '——剩下的 hunk 要自己读，行号见 `@@` 抬头');
      }
      if (assembled.clipped.length > 0) {
        /* 单文件时窗口块自己已经写了「共 N 行 / 只给前 K 行」，这里不再复述数字，
         * 只说下一步怎么办——重复的数字白烧 token，缺的下一步才是模型需要的。 */
        const rows = assembled.clipped;
        notes.push(rows.length === 1 && chunks.length === 1
          ? '这个 hunk 太长，只给了行窗口——末尾写着还剩多少行，缺的部分用 mode=content 按行号补读'
          : 'hunk 过长，只给了行窗口：'
            + rows.map((item) => `${item.path}（${item.shownLines}/${item.totalLines} 行）`).join('、')
            + '——窗口末尾写着还剩多少行，缺的部分要自己读原文件补');
      }
      return {
        ok: true,
        result: [
          `${rel} 的未提交变更（共 ${totalHunks} 个 hunk${reduced ? '' : '，已全部展开'}）：`,
          ...notes,
          assembled.blocks.join('\n\n'),
        ].join('\n'),
      };
    } catch (error) {
      return { ok: false, result: `diff 失败：${errorText(error)}` };
    }
  }

  if (mode !== 'content') {
    return { ok: false, result: `未知 mode：${mode}。可选：content / outline / diff / status。` };
  }
  try {
    /* 先 stat 再读：超大文件一次性读进来会把整个后端进程拖住，
     * 而"这文件 8MB"本身就是有用的信息——直接告诉模型改用 grep 定位。 */
    const absolute = await resolveFilePath(assetId, rel);
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      return { ok: false, result: `${rel} 是目录，不是文件。列目录请用 code_find（mode: "glob", pattern: "${rel}/**/*"）` };
    }
    const MAX_READ_BYTES = 2 * 1024 * 1024;
    if (stat.size > MAX_READ_BYTES) {
      return {
        ok: false,
        result: `${rel} 体积 ${(stat.size / 1024 / 1024).toFixed(1)}MB，超过单次读取上限 2MB。`
          + '先用 code_find（mode: "regex"）定位到具体行号，再用 offset/limit 精读那一段。',
      };
    }
    const content = await readContent(assetId, rel);
    if (!content.plain) {
      return { ok: true, result: `文件存在但内容为空，或该资产没有本地克隆：${rel}` };
    }
    const view = sliceLines(content.plain, args.offset, args.limit);
    const body = view.lines
      .map((line, index) => `${String(view.start + index).padStart(5, ' ')} | ${line}`)
      .join('\n');
    /* 把「读到哪了」写成明确事实，而不是让模型自己数行：
     * 只读了一部分却当成全文，是这套工具最容易产生幻觉的地方。 */
    const rest = view.total - view.end;
    const head = `${rel}（${content.language}）· 共 ${view.total} 行 · 本次 L${view.start}-L${view.end}`;
    const tail = rest > 0
      ? `\n\n[还有 ${rest} 行未读：用 offset=${view.end + 1} 继续读，不要在没读完时下结论]`
      : '\n\n[已读到文件末尾]';
    return { ok: true, result: `${head}\n${body}${tail}` };
  } catch (error) {
    return { ok: false, result: `读取被拦截：${errorText(error)}` };
  }
}

/* ================= git_history ================= */

/** `mode=show` 的正文预算。够看一次正常提交，又不至于把上下文顶爆。 */
const SHOW_DIFF_BUDGET = 5000;

/** 在仓库根跑一条 git 命令（只读；8 秒超时，2MB 输出上限，不走 shell）。 */
function execGit(cwd: string, argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile('git', argv, { cwd, timeout: 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      const err = String(stderr ?? '').trim() || (error ? error.message : '');
      resolvePromise({ ok: !error, stdout: String(stdout ?? ''), stderr: err });
    });
  });
}

/**
 * git 路径参数的安全收口。
 *
 * 两条必须做的检查（不是为了防 shell —— 这里根本不过 shell）：
 *   · 绝对路径与外跳（..）：git 会把它们当 pathspec 解析到仓库外，结果与用户理解不符；
 *   · rev 只允许"引用字符集"：`-` 开头的串会被 git 当选项（`--output=` 就能写文件），
 *     这是唯一一条能把只读工具变成写工具的缝。
 */
function normalizeGitPath(raw: unknown): { rel?: string; error?: string } {
  const rel = String(raw ?? '').trim().replace(/\\/g, '/');
  if (!rel) return {};
  if (rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)) return { error: `path 必须是仓库内相对路径：${rel}` };
  if (rel.split('/').includes('..')) return { error: `path 不能跳出仓库（含 ..）：${rel}` };
  return { rel };
}

function normalizeGitRev(raw: unknown): { rev: string; error?: string } {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { rev: 'HEAD' };
  const rev = String(raw).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._~^/-]{0,79}$/.test(rev)) {
    return { rev: '', error: `rev 只接受提交/分支/标签名（字母数字开头，可含 . _ ~ ^ / -）：${rev}` };
  }
  return { rev };
}

async function gitHistory(assetId: string, mode: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  let root: string;
  try {
    root = path.resolve(await resolveRepoRoot(assetId));
  } catch (error) {
    return { ok: false, result: `拿不到该资产的仓库根：${errorText(error)}` };
  }
  const probe = await execGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (!probe.ok || !probe.stdout.includes('true')) {
    return {
      ok: false,
      result: `${root} 不是 git 仓库（git rev-parse 失败：${probe.stderr.slice(0, 160) || '无输出'}）。`
        + '没有 git 就没有历史可查——不要用记忆里的提交补。',
    };
  }

  const pathArg = normalizeGitPath(args.path);
  if (pathArg.error) return { ok: false, result: pathArg.error };
  const rel = pathArg.rel;

  if (mode === 'log') {
    const limit = clampInt(args.limit, 20, 1, 200);
    const argv = ['log', '--no-color', '--date=short', '--pretty=format:%h|%ad|%an|%s', `--max-count=${limit}`];
    if (rel) argv.push('--', rel);
    const result = await execGit(root, argv);
    if (!result.ok) return { ok: false, result: `git log 失败：${result.stderr.slice(0, 300)}` };
    if (!result.stdout.trim()) {
      return {
        ok: true,
        result: rel
          ? `${rel} 没有任何提交记录（该文件可能是新增且未提交）。`
          : '仓库还没有任何提交（空仓库）。',
      };
    }
    const lines = result.stdout.split('\n').slice(0, limit);
    return {
      ok: true,
      result: `git log${rel ? ` · ${rel}` : ''}（最多 ${limit} 条，格式 hash|日期|作者|标题）：\n${lines.join('\n')}`,
    };
  }

  if (mode === 'blame') {
    if (!rel) return { ok: false, result: 'mode=blame 需要 path（逐行溯源必须指定文件）' };
    const offset = clampInt(args.offset, 1, 1, 200000);
    const limit = clampInt(args.limit, 60, 1, 200);
    /* 刻意不加 `--no-color`：git blame 的 color 选项在部分版本里是
     * `--color-lines` / `--color-by-age`，`--no-color` 会被判为歧义而直接失败
     * （实测 git 2.4x 报 "ambiguous option"）。execFile 没有 tty，本来也不会着色。 */
    const result = await execGit(root, ['blame', '-L', `${offset},${offset + limit - 1}`, '--', rel]);
    if (!result.ok) return { ok: false, result: `git blame 失败：${result.stderr.slice(0, 300)}` };
    const lines = result.stdout.split('\n').slice(0, limit);
    return {
      ok: true,
      result: `git blame · ${rel} · L${offset}-L${offset + limit - 1}（每行：commit (作者 日期 行号) 内容）：\n${lines.join('\n')}`
        + (args.limit === undefined ? '\n（默认只给 60 行：要看别处请传 offset/limit）' : ''),
    };
  }

  if (mode === 'show') {
    const rev = normalizeGitRev(args.rev);
    if (rev.error) return { ok: false, result: rev.error };
    const scope = rel ? ['--', rel] : [];
    /* 两次调用，各拿一样东西：
     *   --stat  → "改了几个文件、增删多少行"（短，永远完整）；
     *   纯 diff → 正文（长，要按边界装配）。
     * 分开调是因为"这次改动大不大"应该先由 stat 回答，而不是由第一个文件猜。 */
    const stat = await execGit(root, [
      'show', '--no-color', '--stat', '--date=short', '--pretty=format:%h|%ad|%an|%s', rev.rev, ...scope,
    ]);
    if (!stat.ok) return { ok: false, result: `git show ${rev.rev} 失败：${stat.stderr.slice(0, 300)}` };
    const body = await execGit(root, ['show', '--no-color', '--pretty=format:', rev.rev, ...scope]);
    if (!body.ok) return { ok: false, result: `git show ${rev.rev} 失败：${body.stderr.slice(0, 300)}` };

    const chunks = splitDiffByFile(body.stdout);
    if (chunks.length === 0) {
      return {
        ok: true,
        result: `${stat.stdout.trim()}\n\n`
          + `（git show ${rev.rev} 没有可展开的文本 diff：常见于空提交、合并提交（默认只打印抬头）、`
          + '或这次只改了二进制/文件权限。不要去推测"它改了什么"——没有 diff 就是没有证据。）',
      };
    }

    const assembled = assembleDiff(chunks, SHOW_DIFF_BUDGET);
    const notes: string[] = [];
    if (assembled.blocks.length > 0) {
      const extra = [
        assembled.partial.length > 0 ? `部分 hunk ${assembled.partial.length} 个` : '',
        assembled.clipped.length > 0 ? `行窗口 ${assembled.clipped.length} 个` : '',
      ].filter(Boolean).join(' · ');
      notes.push(`（diff 按文件整段展开：完整 ${assembled.included} 个${extra ? ` · ${extra}` : ''}，`
        + `共用 ${assembled.used}/${SHOW_DIFF_BUDGET} 字符）`);
    }
    if (assembled.partial.length > 0) {
      notes.push('只展开了一部分 hunk 的文件：'
        + assembled.partial.map((item) => `${item.path}（${item.shown}/${item.total} 个 hunk）`).join('、')
        + '——剩下的 hunk 没有被裁剪展示，就是没展示，别把"没看到"当成"没改"');
    }
    if (assembled.clipped.length > 0) {
      notes.push('hunk 过长、只给了行窗口的文件：'
        + assembled.clipped.map((item) => `${item.path}（${item.shownLines}/${item.totalLines} 行）`).join('、')
        + '——窗口末尾写着还剩多少行，缺的部分要自己读原文件补');
    }
    if (assembled.skipped.length > 0) {
      const shown = assembled.skipped.slice(0, 8).join('、');
      notes.push(`未展开 ${assembled.skipped.length} 个文件：${shown}${assembled.skipped.length > 8 ? ' …' : ''}`);
      notes.push(`单独看其中某个：git_history(mode=show, rev=${rev.rev}, path=<上面的路径>)`);
    }

    return {
      ok: true,
      result: [
        `git show ${rev.rev}${rel ? ` · ${rel}` : ''} · 共 ${chunks.length} 个文件`,
        stat.stdout.trim(),
        ...notes,
        assembled.blocks.join('\n\n'),
      ].filter(Boolean).join('\n'),
    };
  }

  return { ok: false, result: `未知 mode：${mode}。可选：log / blame / show。` };
}

/* ================= memo ================= */

/** 会话笔记的字数上限：超过就从**最旧**的一端裁，并如实说明裁掉了。 */
const MEMO_MAX_CHARS = 12000;

async function memo(conversationId: string, mode: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  const row = get<{ content: string; revision: number; updated_at: string }>(
    'SELECT content, revision, updated_at FROM conversation_memo WHERE conversation_id = ?', conversationId,
  );
  const current = String(row?.content ?? '');
  const revision = Number(row?.revision ?? 0);

  if (mode === 'read') {
    if (!current.trim()) {
      return {
        ok: true,
        result: '笔记还是空的（这是真实状态，不是读取失败）。长任务里先把"已确认的事实"写进来，'
          + '上下文被压缩之后它就是唯一还在的东西。',
      };
    }
    return {
      ok: true,
      result: `会话笔记（第 ${revision} 版 · ${current.length} 字符 · 更新于 ${String(row?.updated_at ?? '未知')}）：\n${current}`,
    };
  }

  if (mode !== 'write') return { ok: false, result: `未知 mode：${mode}。可选：write / read。` };

  const content = String(args.content ?? '').trim();
  if (!content) return { ok: false, result: 'mode=write 需要 content（一条结论或一个事实，别传空串）' };
  if (content.length > 2000) {
    return { ok: false, result: `单条笔记 ${content.length} 字符，超过 2000 上限：请拆成几条，或只留下结论。` };
  }

  const stamp = new Date().toISOString().slice(11, 19);
  const replace = args.replace === true;
  const merged = replace ? content : [current, `- [${stamp}] ${content}`].filter(Boolean).join('\n');
  const trimmed = merged.length > MEMO_MAX_CHARS ? merged.slice(merged.length - MEMO_MAX_CHARS) : merged;
  const dropped = merged.length - trimmed.length;

  run(
    `INSERT INTO conversation_memo (conversation_id, content, revision, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET content = excluded.content,
       revision = conversation_memo.revision + 1, updated_at = excluded.updated_at`,
    conversationId, trimmed, new Date().toISOString(),
  );

  return {
    ok: true,
    result: [
      `笔记已${replace ? '覆盖' : '追加'}（第 ${revision + 1} 版 · ${trimmed.length} 字符）`,
      dropped > 0 ? `注意：超过 ${MEMO_MAX_CHARS} 字符上限，最旧的 ${dropped} 字符已被裁掉（要留就写短点）。` : '',
      replace ? '' : `当前条目数：${trimmed.split('\n').filter((line) => line.startsWith('- [')).length}`,
    ].filter(Boolean).join('\n'),
  };
}

/* ================= 技能 ================= */

/** 当前工作区已有的资产类型（技能可用性判据）。 */
function presentAssetTypes(workspaceId: string): string[] {
  return all<{ type: string }>('SELECT DISTINCT type FROM asset WHERE workspace_id = ?', workspaceId)
    .map((row) => String(row.type));
}

function skillList(workspaceId: string, category: string): ToolExecutionResult {
  const present = presentAssetTypes(workspaceId);
  const problems = validateSkillRegistry();
  const skills = SKILL_REGISTRY.filter((skill) => !category || skill.category === category);
  if (skills.length === 0) {
    return {
      ok: true,
      result: category
        ? `没有「${category}」类技能（真实清单，共 ${SKILL_REGISTRY.length} 个技能）`
        : '当前没有任何技能',
    };
  }
  const lines = skills.map((skill) => {
    const missing = skill.requiresAssets.filter((type) => !present.includes(type));
    const state = missing.length > 0 ? `不可用（缺少 ${missing.join('/')} 资产）` : '可用';
    const when = skill.whenToUse ? ` · 适用：${skill.whenToUse}` : '';
    return `- ${skill.id} · ${skill.label} · ${skill.category} · ${state} · 预算 ${skill.budget.maxToolCalls} 次工具调用${when}`;
  });
  return {
    ok: true,
    result: [
      `共 ${skills.length} 个技能${category ? `（分类：${category}）` : ''}：`,
      ...lines,
      problems.length > 0 ? `\n技能登记自检发现问题（如实上报）：${problems.join('；')}` : '',
      '\n用 skill（mode: "load", id: "..."）取某个技能的完整方法论，加载后按它的步骤执行。',
    ].filter(Boolean).join('\n'),
  };
}

function skillLoad(workspaceId: string, id: string): ToolExecutionResult {
  if (!id) return { ok: false, result: 'id 参数为空（先用 mode=list 看有哪些技能）' };
  const skill = SKILL_REGISTRY.find((item) => item.id === id);
  if (!skill) {
    return { ok: false, result: `未知技能：${id}。可用：${SKILL_REGISTRY.map((item) => item.id).join(', ')}` };
  }
  const present = presentAssetTypes(workspaceId);
  const missing = skill.requiresAssets.filter((type) => !present.includes(type));
  if (missing.length > 0) {
    return {
      ok: false,
      result: `技能 ${id} 在当前工作区不可用：缺少 ${missing.join('/')} 类型资产。`
        + '不要强行按它执行——先告诉用户缺什么。',
    };
  }
  /* 内置技能的正文就是它的模板（历史上模板即方法论）；文件技能有独立正文。
   * 两者都必须给全，否则"加载了技能"就只是加载了一句口号。 */
  const body = (skill.methodology ?? skill.template).trim();
  return {
    ok: true,
    result: [
      `# 技能：${skill.label}（${skill.id} · ${skill.category}）`,
      skill.desc,
      `推荐工具：${skill.tools.join(' / ')}${skill.writeTools?.length ? ` ｜ 写工具（需审批）：${skill.writeTools.join(' / ')}` : ''}`,
      `工具调用预算：${skill.budget.maxToolCalls} 次`,
      '',
      body.slice(0, 6000),
      body.length > 6000 ? '\n（正文过长已截断：按上面已给出的步骤执行）' : '',
    ].filter(Boolean).join('\n'),
  };
}

/* ================= db_inspect ================= */

async function dbInspect(assetId: string, mode: string, args: Record<string, unknown>, identity: Identity): Promise<ToolExecutionResult> {
  const objects = listObjects();

  if (mode === 'tables') {
    const nodes = objects.nodes.slice(0, 60).map((node) => `- ${node.name}（${node.kind}）`).join('\n');
    return { ok: true, result: `数据库对象清单（${objects.nodes.length} 个）：\n${nodes}` };
  }

  if (mode === 'schema') {
    const table = String(args.table ?? '').trim();
    if (!table) {
      const names = objects.nodes.slice(0, 40).map((node) => node.name).join(', ');
      return {
        ok: true,
        result: `mode=schema 需要 table（这次没给，故只列出有哪些表）：\n${names}\n`
          + '拿不准表名时先用 mode=tables 看清单。',
      };
    }
    const fields = tableFields(table);
    const columns = fields.columns.map((c) => `- ${c.name} · ${c.type}${c.nullable ? ' · NULL' : ''}`).join('\n');
    return {
      ok: true,
      result: `表 ${table}：\n${columns}\n索引：${fields.indexes.map((idx) => idx.join(',')).join('；') || '无'}\n`
        + `外键：${fields.foreignKeys.map((fk) => fk.join(',')).join('；') || '无'}`,
    };
  }

  if (mode === 'counts') {
    /* 行数画像：逐表真实 COUNT（上限 20 表）。scale 判断与数据倾斜排查的第一步。 */
    const tables = objects.nodes.filter((node) => node.kind === 'table').map((node) => node.name);
    const requested = String(args.tables ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const targets = (requested.length > 0 ? requested : tables).slice(0, 20);
    if (targets.length === 0) return { ok: false, result: '数据库中未发现表（真实查询，未编造）' };
    const results: string[] = [];
    for (const table of targets) {
      try {
        const result = await runSqlQuery(`SELECT COUNT(*) AS n FROM "${table}"`, { maxRows: 1, timeoutMs: 5000 }, identity, assetId);
        const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
        const count = Number(row?.n ?? row?.N ?? 0);
        results.push(`- ${table}：${count} 行`);
      } catch (error) {
        results.push(`- ${table}：计数失败（${errorText(error).slice(0, 60)}）`);
      }
    }
    return { ok: true, result: `行数画像（${results.length}/${tables.length} 表，上限 20）：\n${results.join('\n')}` };
  }

  if (mode === 'explain') {
    /* 看执行计划 ≠ 看耗时。这条分支只回答"数据库打算怎么取数"，
     * 不回答"这条查询慢不慢"——后者要靠 db_query 的真实 durationMs，
     * 把计划当耗时说出去就是编造。 */
    const sql = String(args.sql ?? '').trim().replace(/;+\s*$/, '');
    if (!sql) return { ok: false, result: 'mode=explain 需要 sql（给一条 SELECT / WITH 查询）' };
    if (!/^(select|with)\b/i.test(sql)) {
      return { ok: false, result: 'mode=explain 只接受 SELECT / WITH 查询（写语句不属于"看计划"的范畴）' };
    }
    if (sql.includes(';')) return { ok: false, result: 'mode=explain 一次只能看一条语句（检测到分号）' };
    try {
      const plan = await runSqlQuery(`EXPLAIN QUERY PLAN ${sql}`, { maxRows: 60, timeoutMs: 5000 }, identity, assetId);
      /* rows 是二维数组（不是对象数组）：detail 列要按列名定位。
       * 换一个 SQLite 版本列名可能变，找不到就退化成整行拼接——不丢信息，也不假装没有。 */
      const detailIndex = plan.columnNames.findIndex((name) => name.toLowerCase() === 'detail');
      const details = plan.rows
        .map((row) => (detailIndex >= 0 ? String(row[detailIndex] ?? '') : row.map((cell) => String(cell ?? '')).join(' | ')))
        .filter((line) => line.trim() !== '');
      if (details.length === 0) {
        return { ok: true, result: `EXPLAIN QUERY PLAN 未返回计划行（${plan.durationMs}ms）。这不等于"计划良好"，只说明该语句没有可展示的步骤。` };
      }
      const annotated = details.map((detail) => `- ${detail}${explainHint(detail)}`);
      const scans = details.filter((d) => /^SCAN /i.test(d)).length;
      return {
        ok: true,
        result: [
          `执行计划（SQLite EXPLAIN QUERY PLAN，${plan.durationMs}ms 生成）：`,
          annotated.join('\n'),
          '',
          scans > 0
            ? `注意：有 ${scans} 处 SCAN（全表/全索引扫描）。是否"慢"取决于表规模——先 db_inspect(mode=counts) 看行数，再用 db_query 实测耗时。`
            : '本计划未出现 SCAN 步骤。',
          '这是**计划**不是耗时：真实耗时请用 db_query 执行同一语句，看返回的 durationMs。',
        ].join('\n'),
      };
    } catch (error) {
      return { ok: false, result: `执行计划生成失败（真实错误）：${errorText(error).slice(0, 200)}` };
    }
  }

  return { ok: false, result: `未知 mode：${mode}。可选：tables / schema / counts / explain。` };
}

/** 给 SQLite 的计划行补一句人话注解：模型和用户都不该靠背关键词理解它。 */
function explainHint(detail: string): string {
  if (/^SCAN /i.test(detail)) return '  ← 全表扫描（没用上索引）';
  if (/USING (COVERING )?INDEX/i.test(detail)) return '  ← 走索引';
  if (/USE TEMP B-TREE/i.test(detail)) return '  ← 需要临时 B 树（排序/分组不进索引顺序）';
  if (/SUBQUERY/i.test(detail)) return '  ← 子查询，注意是否被执行了多次';
  return '';
}

/**
 * 派生工具执行入口。
 * 只读工具在这里真实执行；写工具只表达意图（真实执行在 write-executor，
 * 由审批批准触发）。
 */
export async function executeAgentTool(
  rawName: string,
  rawArgs: Record<string, unknown> | undefined,
  tool: DerivedTool | undefined,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  /* ① 入口归一：旧名 → 正式名 + 固定 mode（见 tool-catalog.ts 的 LEGACY_TOOL_ALIASES）。
   * 归一放在执行器入口而不是每个调用点，是为了让"旧名"没有第二套实现。 */
  const call = normalizeToolCall(rawName, rawArgs);
  const toolName = call.name;
  const args = call.args;
  const assetId = tool?.assetId ?? ctx.assetId;

  /* ② mode 是合并工具的必填项：缺了就说清可选值，绝不猜。 */
  const entry = tool?.entry;
  const modeParam = entry?.params.mode;
  const mode = String(args.mode ?? '').trim();
  if (modeParam && !mode) {
    return {
      ok: false,
      result: `缺少 mode 参数。${toolName} 支持：${(modeParam.enum ?? []).join(' / ')}。`
        + '（合并后的工具靠 mode 区分动作，不提供默认值——猜错会得到"看起来成功但查错了"的结果）',
    };
  }
  if (modeParam && modeParam.enum && !modeParam.enum.includes(mode)) {
    return { ok: false, result: `未知 mode：${mode}。${toolName} 支持：${modeParam.enum.join(' / ')}。` };
  }

  switch (toolName) {
    /* ---- 任务清单（Agent 自身状态，任何工作区都可用）---- */
    case 'todo_write': {
      /* 只写「计划状态」，不碰磁盘。这里不做任何"假装推进"：模型传什么就记什么，
       * 进度由 todo.ts 从 status 数出来，不接受模型自报的完成数。 */
      try {
        const { plan, created } = writeTodoPlan(ctx.conversationId, args.items);
        const blocked = plan.items.filter((item) => item.status === 'blocked').map((item) => item.title);
        return {
          ok: true,
          result: [
            `任务清单已${created ? '建立' : '更新'}（第 ${plan.revision} 版）：${plan.progress.done}/${plan.progress.total} 完成`,
            plan.items.map((item, index) => `${index + 1}. [${item.status}] ${item.title}`).join('\n'),
            blocked.length > 0 ? `受阻项：${blocked.join(' / ')}（先解决或如实报告，不要跳过）` : '',
          ].filter(Boolean).join('\n'),
        };
      } catch (error) {
        return { ok: false, result: `清单未更新：${errorText(error)}` };
      }
    }

    /* ---- 通用 ---- */
    case 'ws_list_assets': {
      const rows = all<Record<string, unknown>>(
        'SELECT id, type, name, env, status, credential_bound FROM asset WHERE workspace_id = ? ORDER BY created_at, id',
        ctx.workspaceId,
      );
      const lines = rows.map((row) => `- ${row.id} · ${row.type} · ${row.name}${row.env ? ` · ${row.env}` : ''} · ${row.status}`);
      return { ok: true, result: `工作区 ${ctx.workspaceId} 共 ${rows.length} 个资产：\n${lines.join('\n')}` };
    }

    case 'memo': {
      try {
        return await memo(ctx.conversationId, mode, args);
      } catch (error) {
        return { ok: false, result: `笔记读写失败：${errorText(error)}` };
      }
    }

    /* ---- 内置浏览器：Agent 真的能"开网页"，而不只是文案 ---- */
    case 'browser': {
      if (mode === 'navigate') {
        /* Agent 侧默认禁私有网段：借浏览器探本机/内网是 SSRF 的经典入口。
         * 自托管部署可显式放开（DEVWORK_BROWSER_ALLOW_PRIVATE=1）。
         * 用户手动导航不受此限（用户自己想去哪是他的自由度）。 */
        const normalized = normalizeBrowserUrl(args.url, { allowPrivate: browserAllowPrivate() });
        if (!normalized.ok) return { ok: false, result: `导航被拒：${normalized.reason}` };
        const state = await writeBrowserState(ctx.conversationId, normalized.url ?? '', 'agent');
        return {
          ok: true,
          result: [
            `内置浏览器已导航到 ${normalized.url}`,
            '右栏「浏览器」Tab 已同步该地址（用户可见）。',
            '要读这页内容，请再调 browser（mode: "read"）：页面快照由前端回传。',
            `state: by=${state.by} · ${state.updatedAt}`,
          ].join('\n'),
        };
      }
      if (mode !== 'read') return { ok: false, result: `未知 mode：${mode}。可选：navigate / read。` };
      const page = await readBrowserPage(ctx.conversationId);
      if (!page.text.trim()) {
        return {
          ok: false,
          result: page.url
            ? `当前页 ${page.url} 还没有页面快照（前端未回传正文，或页面是纯图片/空白）。`
            : '内置浏览器还没有导航过任何页面，也没有页面快照。',
        };
      }
      return {
        ok: true,
        result: [
          `标题：${page.title || '（无标题）'}`,
          `地址：${page.url || '（未知）'}`,
          `抓取时间：${page.capturedAt}`,
          '正文：',
          page.text,
        ].join('\n'),
      };
    }

    case 'web_fetch': {
      const url = String(args.url ?? '').trim();
      if (!url) return { ok: false, result: 'url 参数为空' };
      try {
        const page = await webFetch(url, { maxChars: Number(args.maxChars ?? 20000) });
        if (!page.text.trim()) {
          return {
            ok: false,
            result: `抓到 ${page.url}（${page.contentType} · ${page.bytes}B）但没有可读正文：`
              + '页面可能是纯图片、需要登录，或正文由前端脚本渲染。这里如实报告抓不到，'
              + '不要用记忆里的内容补上这一页。',
          };
        }
        return {
          ok: true,
          result: [
            `来源：${page.url}`,
            page.title ? `标题：${page.title}` : '',
            `类型：${page.contentType} · ${page.bytes}B · ${page.truncated ? '内容已截断（提高 maxChars 可多取）' : '内容完整'}`,
            page.redirects.length > 1 ? `重定向链：${page.redirects.join(' → ')}` : '',
            '正文：',
            page.text,
          ].filter(Boolean).join('\n'),
        };
      } catch (error) {
        return { ok: false, result: `抓取失败（真实结果，未使用任何缓存或记忆）：${errorText(error)}` };
      }
    }

    /* ---- 外部检索：只走真的搜索后端，没接就明确拒绝 ---- */
    case 'web_search': {
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, result: 'query 参数为空' };
      if (query.length > 200) return { ok: false, result: 'query 过长（>200 字符）：搜索词应该收敛，不是把整段需求丢进去' };
      const outcome = await searchWeb(query, clampInt(args.limit, 5, 1, 10));
      if (!outcome.ok) return { ok: false, result: outcome.note };
      if (outcome.hits.length === 0) return { ok: true, result: outcome.note };
      const lines = outcome.hits.map((hit, index) => [
        `${index + 1}. ${hit.title}`,
        `   ${hit.url}`,
        hit.snippet ? `   ${hit.snippet.slice(0, 200)}` : '   （该条无摘要）',
      ].join('\n'));
      return {
        ok: true,
        result: [
          outcome.note,
          lines.join('\n'),
          '',
          '引用纪律：以上是**搜索摘要**不是原文。要引用具体内容必须用 web_fetch 打开对应 URL；',
          '打不开就写"未取到原文"，不要拿摘要当原文引用。',
        ].join('\n'),
      };
    }

    /* ---- 子代理：把大范围搜证关进独立上下文 ---- */
    case 'subtask': {
      const goal = String(args.goal ?? '').trim();
      if (!goal) {
        return {
          ok: false,
          result: 'goal 为空：子代理看不到主对话历史，任务描述必须自包含（要查什么、在哪查、查完要回答什么）。',
        };
      }
      if (goal.length > 2000) return { ok: false, result: 'goal 过长（>2000 字符）：把任务收敛成一句可执行的调研目标。' };
      const runner = ctx.subagent;
      if (!runner) {
        return {
          ok: false,
          result: '子代理不可用：本会话没有注入子代理执行器。请改用 code_find / code_view / db_query 自己分步查证。',
        };
      }
      const outcome = await runner({ goal, maxToolCalls: clampInt(args.maxToolCalls, 12, 1, 25) });
      if (!outcome.ok) {
        return {
          ok: false,
          result: `${outcome.note || '子代理未产出结论'}`
            + (outcome.toolCalls > 0 ? `（已执行 ${outcome.toolCalls} 次工具调用：${outcome.toolsUsed.join(' / ')}）` : ''),
        };
      }
      return {
        ok: true,
        result: [
          `子代理结论（独立上下文 · ${outcome.toolCalls} 次工具调用：${outcome.toolsUsed.join(' / ') || '无'}）：`,
          outcome.summary,
          outcome.note ? `\n${outcome.note}` : '',
          '',
          '这些结论来自子代理的查证，不是你亲自读到的。引用时说明「子代理查证」，'
            + '关键结论若要用在最终回答里，建议用 code_view 复核一次原文。',
        ].filter(Boolean).join('\n'),
      };
    }

    /* ---- 技能：先看清单，再按需加载正文 ---- */
    case 'skill': {
      if (mode === 'list') return skillList(ctx.workspaceId, String(args.category ?? '').trim());
      if (mode !== 'load') return { ok: false, result: `未知 mode：${mode}。可选：list / load。` };
      return skillLoad(ctx.workspaceId, String(args.id ?? '').trim());
    }

    /* ---- codebase ---- */
    case 'code_find': {
      /* 索引检索需要凭据/资产索引已建；其余走磁盘。索引未建时如实报"未命中"会误导，
       * 所以这里是唯一需要额外口径的地方——但判定权在 indexer，不在这里编。 */
      return codeFind(assetId, mode, args);
    }
    case 'code_view':
      return codeView(assetId, mode, args);

    case 'code_todos': {
      /* 真实遍历仓库源码，扫 TODO/FIXME/HACK 标记。跳过规则、敏感文件、体积上限、
       * 文件数闸门都在 scanTodos（复用 walkFiles），这里只负责措辞。 */
      const max = clampInt(args.max, 30, 1, 100);
      const subPath = String(args.path ?? '').trim();
      let scan: Awaited<ReturnType<typeof scanTodos>>;
      try {
        scan = await scanTodos(assetId, { max, subPath: subPath || undefined });
      } catch (error) {
        /* path 指向文件时 resolveScanRoot 会抛「不是目录」。直接抛出去模型只会看到一句
         * 栈信息，所以在这里补上"目录 vs 文件"的区分和下一步怎么做。 */
        return {
          ok: false,
          result: `扫描失败：${errorText(error)}。path 必须是仓库内的**目录**；`
            + '不确定目录名就先 code_find(mode=glob, pattern="**/*.java") 看一眼，或不传 path 扫全仓。',
        };
      }
      if (scan.hits.length === 0) {
        const caveats = [
          scan.skippedLarge > 0 ? `${scan.skippedLarge} 个超过 200KB 的文件没读` : '',
          scan.walkTruncated ? '文件数达到遍历上限，没走完整个仓库' : '',
        ].filter(Boolean).join('；');
        return {
          ok: true,
          result: `仓库内未扫到 TODO/FIXME/HACK 标记（读过 ${scan.filesRead} 个文本文件）`
            + (caveats
              ? `。但注意：${caveats}——这不是"整个仓库都干净"的证据`
              /* 不写"这是全量结果"：依赖目录、构建产物、敏感文件都按规则跳过了，
               * "全量"是个绝对说法，而这里只是"规则范围内没有跳过"。 */
              : '，范围内该读的都读了（依赖目录/构建产物按规则跳过，敏感文件不读）'),
        };
      }
      const rows = scan.hits.map((hit) => {
        /* 归属用 `@ Owner.method`；代码文件里查不到归属要说"模块级"，
         * 非代码文件就什么都不说——`README.md` 里没有"方法"这种东西。 */
        const where = hit.owner
          ? ` @ ${hit.owner}`
          : hit.codeFile ? ' @ (模块级，不在任何方法/类内)' : '';
        return `- ${hit.path}:L${hit.line} · ${hit.marker} · ${hit.text || '（无说明）'}${where}`;
      });
      const notes: string[] = [];
      /* 措辞纪律：到上限只能说"结果不保证完整"，不能说"后面还有"——
       * 第 100 条恰好是仓库最后一个标记时，后者就是假话。
       * 同样地，"没扫到"也要分清是"扫完了没有"还是"根本没走完"。 */
      if (scan.stoppedAtCap) {
        notes.push(`已达上限 ${max}（按路径顺序截断，结果不保证完整）：要全看完请提高 max 或缩小 path`);
      }
      if (scan.skippedLarge > 0) notes.push(`${scan.skippedLarge} 个超过 200KB 的文件没读`);
      if (scan.walkTruncated) notes.push('文件数达到遍历上限，没走完整个仓库');
      const hasOwner = scan.hits.some((hit) => hit.owner || hit.codeFile);
      return {
        ok: true,
        result: [
          `扫到 ${scan.hits.length} 个标记（读过 ${scan.filesRead} 个文本文件）${notes.length > 0 ? '；' : ''}${notes.join('；')}`,
          /* 归属只是"这个标记写在哪个符号里"，不是"该谁来修"。措辞上不越界。 */
          hasOwner ? '（@ 后是包含该行的最内层符号；改之前先看这一段）' : '',
          rows.join('\n'),
        ].filter(Boolean).join('\n'),
      };
    }

    case 'git_history':
      return gitHistory(assetId, mode, args);

    /* ---- database ---- */
    case 'db_query': {
      const sql = String(args.sql ?? '').trim();
      if (!sql) return { ok: false, result: 'sql 参数为空' };
      const result = await runSqlQuery(sql, { maxRows: 200, timeoutMs: 8000 }, ctx.identity, assetId);
      const sample = result.rows.slice(0, 8).map((row) => JSON.stringify(row)).join('\n');
      return {
        ok: true,
        result: `查询成功 · ${result.rowCount} 行 · ${result.durationMs}ms · checksum ${result.dbChecksumBefore === result.dbChecksumAfter ? '未变化' : '变化'}\n采样：\n${sample}`,
      };
    }
    case 'db_inspect':
      return dbInspect(assetId, mode, args, ctx.identity);

    /* ---- knowledge ---- */
    case 'kb_search': {
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, result: 'query 参数为空' };
      return searchTool(assetId, query, '运营知识库');
    }

    /* ---- server ---- */
    case 'srv_status': {
      const procCount = await new Promise<number>((resolvePromise) => {
        const cmd = process.platform === 'win32' ? 'tasklist' : 'ps';
        const argv = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['aux'];
        execFile(cmd, argv, { timeout: 4000, windowsHide: true }, (error, stdout) => {
          if (error) { resolvePromise(-1); return; }
          resolvePromise(stdout.split('\n').filter((line) => line.trim() !== '').length);
        });
      });
      const sessionRows = all<{ n: number }>('SELECT COUNT(*) AS n FROM terminal_session');
      const sessions = Number(sessionRows[0]?.n ?? 0);
      return {
        ok: true,
        result: [
          `主机：${os.platform()} ${os.arch()} · CPU ${os.cpus().length} 核 · 内存 ${Math.round(os.totalmem() / 1024 ** 3)}G（空闲 ${Math.round(os.freemem() / 1024 ** 3)}G）`,
          `uptime ${Math.floor(os.uptime() / 3600)}h · 进程数 ${procCount >= 0 ? procCount : '采集失败（真实探测，未编造）'}`,
          `资产绑定终端会话：${sessions} 个`,
        ].join('\n'),
      };
    }
    case 'srv_log_tail': {
      const lines = clampInt(args.lines, 20, 1, 100);
      const all0 = readLogLines();
      const tail = all0.slice(-lines);
      return {
        ok: true,
        result: tail.length === 0
          ? '日志文件为空（真实读取，未编造）'
          : `日志尾部 ${tail.length}/${all0.length} 行：\n${tail.map((line) => line.raw).join('\n')}`,
      };
    }

    /* ---- log 资产 ---- */
    case 'log_query': {
      const query = String(args.query ?? '').trim().toLowerCase();
      const limit = clampInt(args.limit, 30, 1, 100);
      let lines = readLogLines();
      const total = lines.length;
      lines = filterByWindow(lines, args.from ? String(args.from) : undefined, args.to ? String(args.to) : undefined);
      if (query) lines = lines.filter((line) => line.raw.toLowerCase().includes(query));
      const sample = lines.slice(-limit);
      return {
        ok: true,
        result: `日志检索：总 ${total} 行 → 命中 ${lines.length} 行（显示末尾 ${sample.length} 行）\n${sample.map((line) => line.raw).join('\n') || '（无命中）'}`,
      };
    }

    /* ---- api 资产 ---- */
    case 'api_spec_read': {
      const list = API_ENDPOINTS.map((endpoint) => `- ${endpoint.method} ${endpoint.path} · ${endpoint.desc}${endpoint.readOnly ? ' · 只读' : ' · 副作用（不派生）'}`).join('\n');
      return { ok: true, result: `API 资产端点规范（${API_ENDPOINTS.length} 个，全部只读）：\n${list}` };
    }
    case 'api_call_read': {
      const pathname = String(args.path ?? '').trim();
      if (!pathname.startsWith('/api/')) return { ok: false, result: '路径必须以 /api/ 开头' };
      if (!isAllowedApiPath(pathname)) {
        return { ok: false, result: `路径不在只读规范清单内（防副作用调用）：${pathname}。可用：${API_ENDPOINTS.filter((e) => e.readOnly).map((e) => e.path).join(', ')}` };
      }
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: AbortSignal.timeout(6000) });
        const body = await response.text();
        return { ok: true, result: `GET ${pathname} → HTTP ${response.status}\n${body.slice(0, 1500)}` };
      } catch (error) {
        return { ok: false, result: `API 调用失败（真实结果）：${errorText(error)}` };
      }
    }

    /* ---- 写工具（v2）：执行器只表达意图，真实执行在 write-executor ---- */
    case 'code_edit':
    case 'db_query_write':
    case 'srv_exec':
    case 'fs_write_file':
    case 'fs_manage':
      return {
        ok: false,
        result: `写操作未执行：${toolName}${mode ? `（mode=${mode}）` : ''} 需要人工审批。`
          + '批准后由三层防线管线（precheck → 快照 → 落盘 → 校验）真实执行，你不要假装已生效。',
      };

    default:
      return { ok: false, result: `未知只读工具：${toolName}${call.aliasedFrom ? `（旧名 ${call.aliasedFrom}）` : ''}` };
  }
}
