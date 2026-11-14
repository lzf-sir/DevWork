/**
 * TodoPlan —— 长任务的计划清单。
 *
 * 三个判断写在这里，代码只是结果：
 * 1. **一张卡、原位更新**：清单属于「当前任务的状态」，不是一条条历史消息。
 *    每次更新追加一张卡，10 步之后时间线就被 10 张清单淹了。所以按会话只留
 *    一张 kind='todo' 的卡，后续更新改它的 payload —— 用户在时间线上看到的是
 *    同一张卡在推进。
 * 2. **进度由状态推导**：done/total 从 items 数出来，不接受模型自报的数字。
 *    模型说"已完成 3/5"但 items 里只有一个 done，那是它错了，不是数据错了。
 * 3. **只认三种状态**：pending / doing / done / blocked。没有「进展顺利」这种
 *    无法判断真假的中间态，也没有 0~100 的百分比——长任务里百分比是编的。
 */
import { ApiFailure } from '../http/core';
import { get, newId, nowIso, run } from '../db/database';

export type TodoStatus = 'pending' | 'doing' | 'done' | 'blocked';

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  /** 一句话说明：为什么 blocked / 这一步产出了什么。 */
  note?: string;
}

export interface TodoProgress {
  done: number;
  total: number;
  doing: number;
  blocked: number;
  /** 0~100，仅由状态数推导，不用来画"进度条欺骗"。 */
  percent: number;
}

export interface TodoPlan {
  items: TodoItem[];
  progress: TodoProgress;
  revision: number;
  updatedAt: string;
  /** 演示轨迹（未接入模型）时标记为 true，UI 要能看出来。 */
  degraded: boolean;
}

/** 单条清单卡最多 30 项：超过这个数，人已经看不完，模型更跟踪不住。 */
const MAX_ITEMS = 30;
const MAX_TITLE = 160;
const MAX_NOTE = 200;
export const TODO_CARD_KIND = 'todo';

const STATUS_SET: TodoStatus[] = ['pending', 'doing', 'done', 'blocked'];

function normalizeStatus(raw: unknown, fallback: TodoStatus = 'pending'): TodoStatus {
  const value = String(raw ?? '').trim().toLowerCase();
  if (STATUS_SET.includes(value as TodoStatus)) return value as TodoStatus;
  /* 模型常用的近义词：in_progress / running → doing；completed / finished → done。 */
  if (/^(in[_-]?progress|running|active|做中|进行中)$/.test(value)) return 'doing';
  if (/^(completed?|finished|closed|完成|已完成)$/.test(value)) return 'done';
  if (/^(blocked|stuck|failed|受阻|失败|阻塞)$/.test(value)) return 'blocked';
  if (/^(todo|open|pending|待办|未开始)$/.test(value)) return 'pending';
  return fallback;
}

function normalizeTitle(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

export function progressOf(items: TodoItem[]): TodoProgress {
  const total = items.length;
  const done = items.filter((item) => item.status === 'done').length;
  const doing = items.filter((item) => item.status === 'doing').length;
  const blocked = items.filter((item) => item.status === 'blocked').length;
  return { done, total, doing, blocked, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

interface CardRow {
  id: string;
  payload: string;
}

function latestCard(conversationId: string): CardRow | undefined {
  return get<CardRow>(
    `SELECT id, payload FROM message WHERE conversation_id = ? AND kind = '${TODO_CARD_KIND}'
     ORDER BY rowid DESC LIMIT 1`,
    conversationId,
  );
}

function parsePlan(raw: string | undefined): TodoPlan | null {
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const items = Array.isArray(payload.items) ? (payload.items as Record<string, unknown>[]) : [];
    const normalized: TodoItem[] = items.map((item, index) => ({
      id: String(item.id ?? `t${index + 1}`),
      title: normalizeTitle(item.title),
      status: normalizeStatus(item.status),
      ...(item.note ? { note: String(item.note).slice(0, MAX_NOTE) } : {}),
    })).filter((item) => item.title !== '');
    return {
      items: normalized,
      progress: progressOf(normalized),
      revision: Number(payload.revision ?? 1),
      updatedAt: String(payload.updatedAt ?? ''),
      degraded: payload.degraded === true,
    };
  } catch {
    return null;
  }
}

/** 当前清单（没有就是 null）。右栏、系统提示、UI 都读这一份。 */
export function readTodoPlan(conversationId: string): TodoPlan | null {
  return parsePlan(latestCard(conversationId)?.payload);
}

/** 当前清单卡（id + plan），供 sendMessage 把最新状态回传给前端。 */
export function readTodoCard(conversationId: string): { cardId: string; payload: Record<string, unknown> } | null {
  const row = latestCard(conversationId);
  if (!row) return null;
  try {
    return { cardId: row.id, payload: JSON.parse(row.payload) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * 写入清单（同一张卡原位更新）。
 *
 * 合并规则：模型下次可能只回传「变了的那几项」，也可能回传全量。
 *  - 带 id 且能对上 → 沿用该 id，更新 title/status；
 *  - 不带 id → 按标题对已有项，命中则沿用 id 与其当前状态（除非显式给了 status）；
 *  - 都对不上 → 新增一项。
 * 这样"只改一项状态"和"整体重排"两种写法都能工作，不需要模型记住全部 id。
 */
export function writeTodoPlan(
  conversationId: string,
  rawItems: unknown,
  opts: { degraded?: boolean } = {},
): { cardId: string; plan: TodoPlan; created: boolean; card: { id: string; kind: string; payload: Record<string, unknown> } } {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new ApiFailure('E_VALIDATION', 'items 必须是非空数组：清单至少要有一步');
  }
  const previous = readTodoPlan(conversationId);
  const previousItems = previous?.items ?? [];
  const byId = new Map(previousItems.map((item) => [item.id, item]));
  const byTitle = new Map(previousItems.map((item) => [item.title.toLowerCase(), item]));
  const used = new Set<string>();
  const items: TodoItem[] = [];

  rawItems.slice(0, MAX_ITEMS).forEach((raw, index) => {
    const row = (raw && typeof raw === 'object' ? raw : { title: String(raw ?? '') }) as Record<string, unknown>;
    const title = normalizeTitle(row.title ?? row.text ?? row.goal);
    if (!title) return;
    const explicitId = String(row.id ?? '').trim();
    const matched = (explicitId ? byId.get(explicitId) : undefined)
      ?? byTitle.get(title.toLowerCase());
    const status = row.status === undefined || row.status === null
      ? (matched?.status ?? 'pending')
      : normalizeStatus(row.status, matched?.status ?? 'pending');
    /* id 冲突去重：两个新项同名时给后一个换新 id，避免 Map 覆盖。 */
    let id = matched?.id ?? `t${index + 1}`;
    if (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const note = row.note === undefined || row.note === null ? matched?.note : String(row.note).slice(0, MAX_NOTE);
    items.push({ id, title, status, ...(note ? { note } : {}) });
  });

  if (items.length === 0) {
    throw new ApiFailure('E_VALIDATION', 'items 里没有可用的 title：清单项必须带标题');
  }

  const plan: TodoPlan = {
    items,
    progress: progressOf(items),
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: nowIso(),
    degraded: opts.degraded === true || previous?.degraded === true,
  };
  const payload: Record<string, unknown> = {
    items: plan.items,
    progress: plan.progress,
    revision: plan.revision,
    updatedAt: plan.updatedAt,
    degraded: plan.degraded,
  };

  const existing = latestCard(conversationId);
  if (existing) {
    run('UPDATE message SET payload = ? WHERE id = ?', JSON.stringify(payload), existing.id);
    return { cardId: existing.id, plan, created: false, card: { id: existing.id, kind: TODO_CARD_KIND, payload } };
  }
  const id = newId('m');
  run(
    'INSERT INTO message (id,conversation_id,kind,payload,actor,created_at) VALUES (?,?,?,?,?,?)',
    id, conversationId, TODO_CARD_KIND, JSON.stringify(payload), 'agent', nowIso(),
  );
  return { cardId: id, plan, created: true, card: { id, kind: TODO_CARD_KIND, payload } };
}

/** 给模型看的一行式清单（进系统提示，成本极低但能防止它忘记第 3 步）。 */
export function todoPromptOf(plan: TodoPlan | null): string {
  if (!plan || plan.items.length === 0) return '';
  const mark: Record<TodoStatus, string> = { done: '[x]', doing: '[>]', blocked: '[!]', pending: '[ ]' };
  const lines = plan.items.map((item) => `${mark[item.status]} ${item.title}${item.note ? `（${item.note}）` : ''}`);
  return [
    `当前任务清单（${plan.progress.done}/${plan.progress.total} 完成，第 ${plan.revision} 版）：`,
    ...lines,
    '继续推进时优先处理 doing 项；某一步完成后必须调用 todo_write 更新它的 status。',
  ].join('\n');
}
