/**
 * ContextBudget —— 上下文预算管理器（设计 §3.3 的可执行版）。
 *
 * 三个必须先想清楚的判断：
 *
 * 1. **压缩不是删消息。** 时间线是用户的账本，删了就没法回看「它当时为什么这么答」。
 *    所以压缩只做一件事：把早前那段折叠成一张摘要卡，之后发给模型的上下文从
 *    摘要开始算；原始消息一条不动，只是在时间线上标了「已折叠」。
 *
 * 2. **预算按模型算，不按常量算。** 204800 是原型里写死的数字，套在 32k 的模型上
 *    会让"还有 90% 余量"这种谎话一直显示着。窗口取自模型名，设置页可覆盖。
 *
 * 3. **估算就是估算。** 本文件所有 token 数都是「字符数 / 1.5」，用于展示与阈值判断，
 *    不用于计费对账；真实用量以供应商回传的 usage 为准（conversation.ts 里那条链）。
 */
import { all, get, newId, nowIso, run } from '../db/database';
import { settingRaw } from '../db/repositories';

/** 中英混排的经验值：1 token ≈ 1.5 字符。全项目只有这一处定义口径。 */
const CHARS_PER_TOKEN = 1.5;

export function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

export function tokensOfText(text: string): number {
  return text ? estimateTokens(text.length) : 0;
}

/* ───────────────────────── 窗口与阈值 ───────────────────────── */

export const DEFAULT_CONTEXT_WINDOW = 128000;
/** 历史占窗口的比例上限：剩下的留给系统提示、工具 schema、任务清单与输出。 */
const HISTORY_SHARE = 0.55;
/** 自动压缩的默认水位：到 80% 就动手，别等真撞上限被供应商截断。 */
const DEFAULT_AUTO_COMPACT_AT = 0.8;
/** 压缩时保留的最近内容占窗口比例（折叠剩下的那部分必须够模型接着干）。 */
const DEFAULT_KEEP_SHARE = 0.3;

const MODEL_WINDOWS: [RegExp, number][] = [
  [/claude/i, 200000],
  [/gpt-4\.1|gpt-4o|gpt-4-turbo|o1|o3/i, 128000],
  [/deepseek/i, 128000],
  [/qwen|glm-4|moonshot|kimi|doubao|seed/i, 128000],
  [/gpt-3\.5|gpt-4(?!o|-turbo|-1)/i, 16384],
  [/llama|qwen2\.5|deepseek-r1|mistral/i, 32768],
];

export interface WindowInfo {
  window: number;
  source: 'setting' | 'model' | 'default';
}

/** 生效的上下文窗口：设置页显式覆盖 > 模型名推断 > 默认值。 */
export function resolveContextWindow(model: string | undefined): WindowInfo {
  let configured = 0;
  try {
    configured = Number(settingRaw('model').contextWindow ?? 0);
  } catch {
    configured = 0;
  }
  if (Number.isFinite(configured) && configured >= 4000) {
    return { window: Math.floor(configured), source: 'setting' };
  }
  const name = String(model ?? '');
  for (const [pattern, window] of MODEL_WINDOWS) {
    if (pattern.test(name)) return { window, source: 'model' };
  }
  if (name && name !== '未接入模型') return { window: DEFAULT_CONTEXT_WINDOW, source: 'default' };
  return { window: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

/** 自动压缩水位（0.3~0.95），设置页可调。 */
export function autoCompactAt(): number {
  let raw = 0;
  try {
    raw = Number(settingRaw('model').autoCompactAt ?? 0);
  } catch {
    raw = 0;
  }
  if (Number.isFinite(raw) && raw >= 0.3 && raw <= 0.95) return raw;
  return DEFAULT_AUTO_COMPACT_AT;
}

/* ───────────────────────── 度量 ───────────────────────── */

interface MessageRow {
  rowid: number;
  id: string;
  kind: string;
  payload: string;
  created_at: string;
}

/** 参与上下文的消息种类：只有用户话说与助手文本。工具行/审批卡不进提示。 */
const CONTEXT_KINDS = "('bubble','user','text','conclusion')";

export interface SummaryInfo {
  cardId: string;
  rowid: number;
  content: string;
  coversUpTo: number;
  messages: number;
  tokens: number;
  freedTokens: number;
  source: 'model' | 'rule';
  mode: 'auto' | 'manual';
  at: string;
  model: string;
}

/** 最近一次压缩的摘要（没有就是 null）。 */
export function latestSummary(conversationId: string): SummaryInfo | null {
  const row = get<{ rowid: number; id: string; payload: string }>(
    `SELECT rowid, id, payload FROM message WHERE conversation_id = ? AND kind = 'summary'
     ORDER BY rowid DESC LIMIT 1`,
    conversationId,
  );
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return {
      cardId: row.id,
      rowid: Number(row.rowid),
      content: String(payload.content ?? ''),
      coversUpTo: Number(payload.coversUpTo ?? 0),
      messages: Number(payload.messages ?? 0),
      tokens: tokensOfText(String(payload.content ?? '')),
      freedTokens: Number(payload.freedTokens ?? 0),
      source: payload.source === 'model' ? 'model' : 'rule',
      mode: payload.mode === 'manual' ? 'manual' : 'auto',
      at: String(payload.at ?? ''),
      model: String(payload.model ?? ''),
    };
  } catch {
    return null;
  }
}

function contextRows(conversationId: string, afterRowid = 0): MessageRow[] {
  return all<MessageRow>(
    `SELECT rowid, id, kind, payload, created_at FROM message
     WHERE conversation_id = ? AND kind IN ${CONTEXT_KINDS} AND rowid > ? ORDER BY rowid`,
    conversationId, afterRowid,
  );
}

function textOf(row: MessageRow): string {
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return String(payload.content ?? payload.text ?? '');
  } catch {
    return '';
  }
}

export interface ContextBreakdown {
  name: string;
  tokens: number;
}

export interface ContextUsage {
  /** 本轮真实会发给模型的 token 估算（系统 + 清单 + 摘要 + 历史 + 本轮输入）。 */
  used: number;
  budget: number;
  ratio: number;
  autoCompactAt: number;
  state: 'ok' | 'near' | 'over';
  windowSource: WindowInfo['source'];
  model: string;
  breakdown: ContextBreakdown[];
  messages: { total: number; inWindow: number; folded: number };
  summary: { messages: number; tokens: number; source: string; mode: string; at: string; model: string } | null;
  /** 是否已经到了自动压缩的水位（前端把按钮标黄）。 */
  shouldCompact: boolean;
}

/** 系统提示 + 工具 schema 的固定开销：工具面越大越贵，这里按条数估。 */
function fixedOverhead(toolCount: number): number {
  return 620 + Math.max(0, toolCount) * 90;
}

export interface MeasureOptions {
  model?: string;
  toolCount?: number;
  /** 本轮输入（还没落库的用户消息），用于"发出去之前"就能看到会不会超。 */
  pendingContent?: string;
}

/** 上下文占用与构成（纯读，无副作用）。 */
export function measureContext(conversationId: string, options: MeasureOptions = {}): ContextUsage {
  const windowInfo = resolveContextWindow(options.model);
  const summary = latestSummary(conversationId);
  const rows = contextRows(conversationId, summary?.coversUpTo ?? 0);
  const historyBudget = Math.floor(windowInfo.window * HISTORY_SHARE);

  /* 从最新往回累加，直到预算用完 —— 与 buildHistory 的口径必须完全一致，
   * 否则"显示 60%"和"实际塞了 95%"会同时成立。 */
  let accumulated = 0;
  let inWindow = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const tokens = tokensOfText(textOf(rows[index]));
    if (inWindow > 0 && accumulated + tokens > historyBudget) break;
    accumulated += tokens;
    inWindow += 1;
  }
  const folded = Math.max(0, rows.length - inWindow);
  const summaryTokens = summary ? summary.tokens : 0;
  const pending = options.pendingContent ? tokensOfText(options.pendingContent) : 0;
  const breakdown: ContextBreakdown[] = [
    { name: '系统与工具', tokens: fixedOverhead(options.toolCount ?? 0) },
    ...(summaryTokens > 0 ? [{ name: '压缩摘要', tokens: summaryTokens }] : []),
    { name: '历史对话', tokens: accumulated },
    ...(pending > 0 ? [{ name: '本轮输入', tokens: pending }] : []),
  ];
  const used = breakdown.reduce((sum, item) => sum + item.tokens, 0);
  const ratio = windowInfo.window > 0 ? used / windowInfo.window : 0;
  const trigger = autoCompactAt();
  return {
    used,
    budget: windowInfo.window,
    ratio,
    autoCompactAt: trigger,
    state: ratio >= trigger ? 'over' : ratio >= trigger * 0.75 ? 'near' : 'ok',
    windowSource: windowInfo.source,
    model: String(options.model ?? ''),
    breakdown,
    messages: { total: rows.length, inWindow, folded },
    summary: summary
      ? {
          messages: summary.messages,
          tokens: summary.tokens,
          source: summary.source,
          mode: summary.mode,
          at: summary.at,
          model: summary.model,
        }
      : null,
    shouldCompact: ratio >= trigger,
  };
}

/* ───────────────────────── 历史构建 ───────────────────────── */

export interface BudgetedHistory {
  history: { role: 'user' | 'assistant'; content: string }[];
  used: number;
  /** 预算外被丢掉的消息条数（>0 说明该压缩了）。 */
  dropped: number;
  summary: SummaryInfo | null;
}

/**
 * 按预算还原多轮上下文。
 *
 * 与上一版的差别只有一点，但很关键：**被截掉的旧消息现在有去处**——
 * 先放摘要（如果有），再放预算内的近期消息。上一版直接 slice(-12)，
 * 12 条之前的上下文静默消失，模型不知道自己漏了什么，用户也不知道。
 */
export function buildBudgetedHistory(
  conversationId: string,
  excludeContent: string,
  options: { model?: string } = {},
): BudgetedHistory {
  const windowInfo = resolveContextWindow(options.model);
  const summary = latestSummary(conversationId);
  const rows = contextRows(conversationId, summary?.coversUpTo ?? 0);
  const historyBudget = Math.floor(windowInfo.window * HISTORY_SHARE);

  const picked: { role: 'user' | 'assistant'; content: string }[] = [];
  let accumulated = 0;
  let dropped = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const content = textOf(row);
    if (!content) continue;
    const isUser = row.kind === 'bubble' || row.kind === 'user';
    /* 本轮的用户话已经单独作为 user 消息发出去，不能再算进历史。 */
    if (isUser && content === excludeContent) continue;
    /* 助手文本单条封顶 1200 字：一条超长结论就能吃掉整个窗口。 */
    const normalized = isUser ? content : content.slice(0, 1200);
    const tokens = tokensOfText(normalized);
    if (picked.length > 0 && accumulated + tokens > historyBudget) {
      dropped = index + 1;
      break;
    }
    accumulated += tokens;
    picked.push({ role: isUser ? 'user' : 'assistant', content: normalized });
  }
  picked.reverse();

  if (summary && summary.content) {
    picked.unshift({
      role: 'assistant',
      content: `【早前 ${summary.messages} 条对话的压缩摘要 · ${summary.source === 'model' ? '模型提炼' : '规则提炼'}】\n${summary.content}`,
    });
  }
  return { history: picked, used: accumulated, dropped, summary };
}

/* ───────────────────────── 压缩 ───────────────────────── */

export interface CompactionInput {
  conversationId: string;
  mode: 'auto' | 'manual';
  model?: string;
  /** 有真模型时优先让模型提炼；没有则规则提炼（并如实标注）。 */
  gateway?: { summarize?: (transcript: string, maxChars: number) => Promise<{ text: string; source: 'model'; model: string }> };
  /** 折叠后保留的最近内容占窗口比例，默认 30%。 */
  keepShare?: number;
}

export interface CompactionResult {
  skipped: boolean;
  reason?: string;
  before: number;
  after: number;
  freed: number;
  /** 被折叠的消息条数（原始消息仍在时间线里）。 */
  covered: number;
  cardId?: string;
  summary?: { content: string; source: 'model' | 'rule'; model: string; messages: number; tokens: number };
  /** 卡片的 API 形状，前端插进时间线用。 */
  card?: {
    id: string;
    conversationId: string;
    kind: string;
    role: string;
    payload: Record<string, unknown>;
    createdAt: string;
    actor: string;
    content?: string;
  };
}

/** 规则提炼：没有模型时的兜底。抽用户诉求 + 已有结论，过程只留计数。 */
function ruleSummary(rows: MessageRow[], maxChars: number): string {
  const asks: string[] = [];
  const findings: string[] = [];
  for (const row of rows) {
    const content = textOf(row).replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const isUser = row.kind === 'bubble' || row.kind === 'user';
    if (isUser) {
      if (asks.length < 10) asks.push(`- ${content.slice(0, 160)}`);
    } else if (findings.length < 10) {
      findings.push(`- ${content.slice(0, 200)}`);
    }
  }
  const lines = [
    asks.length > 0 ? `用户诉求（按时间）：\n${asks.join('\n')}` : '',
    findings.length > 0 ? `已给出的答复要点：\n${findings.join('\n')}` : '',
    `过程：共折叠 ${rows.length} 条对话（工具调用细节不入摘要，需要时可回看原始消息）。`,
  ].filter(Boolean);
  const text = lines.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function transcriptOf(rows: MessageRow[], maxChars: number): string {
  const parts: string[] = [];
  let used = 0;
  for (const row of rows) {
    const content = textOf(row).replace(/\s+/g, ' ').trim();
    if (!content) continue;
    const isUser = row.kind === 'bubble' || row.kind === 'user';
    const line = `${isUser ? '用户' : '助手'}：${content.slice(0, 600)}`;
    if (used + line.length > maxChars) break;
    used += line.length;
    parts.push(line);
  }
  return parts.join('\n');
}

/**
 * 压缩一次上下文。返回的 before/after 是**压缩前后估算的上下文占用**，
 * 不是"省了多少钱"——省下的钱没法在没接模型时算出来。
 */
export async function compactConversation(input: CompactionInput): Promise<CompactionResult> {
  const { conversationId } = input;
  const windowInfo = resolveContextWindow(input.model);
  const before = measureContext(conversationId, { model: input.model }).used;
  const summary = latestSummary(conversationId);
  const rows = contextRows(conversationId, summary?.coversUpTo ?? 0);

  /* 保留最近一段不折叠：压缩完还要接着干，把最近几轮也压掉等于让模型失忆。
   *
   * 两条上限同时生效（谁先到算谁）：
   *  - 条数：手动压缩保留最近 6 条 —— 否则短会话（总量远小于窗口 30%）永远
   *    折叠不出东西，用户点了「压缩上下文」却什么也没发生；
   *  - tokens：不超过窗口的 keepShare（默认 30%）。
   */
  const keepShare = input.keepShare && input.keepShare > 0
    ? Math.min(0.5, Math.max(0.1, input.keepShare))
    : DEFAULT_KEEP_SHARE;
  const keepByTokens = Math.floor(windowInfo.window * keepShare);
  const keepByCount = input.mode === 'manual' ? 6 : Math.max(6, Math.round(rows.length * 0.3));
  let keepTokens = 0;
  let keepCount = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (keepCount >= keepByCount) break;
    const tokens = tokensOfText(textOf(rows[index]));
    if (keepCount > 0 && keepTokens + tokens > keepByTokens) break;
    keepTokens += tokens;
    keepCount += 1;
  }
  const foldRows = rows.slice(0, Math.max(0, rows.length - keepCount));

  if (foldRows.length < 2) {
    return {
      skipped: true,
      reason: '可折叠的内容不足 2 条：上下文本来就短，压缩只会损失信息',
      before, after: before, freed: 0, covered: 0,
    };
  }
  const foldTokens = foldRows.reduce((sum, row) => sum + tokensOfText(textOf(row)), 0);
  const maxChars = Math.max(400, Math.min(1600, Math.round(foldTokens / 2)));
  let content = '';
  let source: 'model' | 'rule' = 'rule';
  let model = String(input.model ?? '');
  if (input.gateway?.summarize) {
    try {
      const result = await input.gateway.summarize(transcriptOf(foldRows, maxChars * 6), maxChars);
      content = result.text;
      source = 'model';
      model = result.model || model;
    } catch {
      /* 模型摘要失败 → 规则提炼兜底，并在卡上标清楚是谁提炼的。 */
      content = '';
    }
  }
  if (!content.trim()) {
    content = ruleSummary(foldRows, maxChars);
    source = 'rule';
  }

  const lastFolded = foldRows[foldRows.length - 1];
  const summaryTokens = tokensOfText(content);
  /* 提炼后没变小就别插卡：一张比原文还长的"压缩摘要"是负收益，
   * 更糟的是它会让后续轮次误以为上下文已经被优化过。 */
  if (summaryTokens >= foldTokens) {
    return {
      skipped: true,
      reason: `提炼后没有变小（折叠 ${foldTokens} tokens → 摘要 ${summaryTokens} tokens），这次压缩不值得做`,
      before, after: before, freed: 0, covered: 0,
    };
  }
  const freedTokens = Math.max(0, foldTokens - summaryTokens);
  const payload: Record<string, unknown> = {
    content,
    source,
    model,
    mode: input.mode,
    coversUpTo: lastFolded.rowid,
    messages: foldRows.length,
    tokensBefore: foldTokens,
    tokensAfter: summaryTokens,
    freedTokens,
    at: nowIso(),
  };
  const id = newId('m');
  const createdAt = nowIso();
  run(
    'INSERT INTO message (id,conversation_id,kind,payload,actor,created_at) VALUES (?,?,?,?,?,?)',
    id, conversationId, 'summary', JSON.stringify(payload), 'system', createdAt,
  );

  const after = measureContext(conversationId, { model: input.model }).used;
  /* 用量表跟着回退：不重算的话状态栏会一直停在压缩前的数字。 */
  const usageRow = get<{ id: string }>('SELECT id FROM usage_stat WHERE conversation_id = ?', conversationId);
  if (usageRow) {
    run(
      'UPDATE usage_stat SET context_used = ?, context_budget = ? WHERE conversation_id = ?',
      after, windowInfo.window, conversationId,
    );
  } else {
    run(
      `INSERT INTO usage_stat (id,conversation_id,context_used,context_budget,cost_cny,model)
       VALUES (?,?,?,?,?,?)`,
      newId('usage'), conversationId, after, windowInfo.window, 0, model || '未接入模型',
    );
  }

  return {
    skipped: false,
    before,
    after,
    freed: Math.max(0, before - after),
    covered: foldRows.length,
    cardId: id,
    summary: { content, source, model, messages: foldRows.length, tokens: summaryTokens },
    card: {
      id,
      conversationId,
      kind: 'summary',
      role: 'assistant',
      payload,
      createdAt,
      actor: 'system',
      content,
    },
  };
}
