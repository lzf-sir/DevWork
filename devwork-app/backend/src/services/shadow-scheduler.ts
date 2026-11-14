/**
 * ShadowScheduler —— P1 影子链路的执行外壳。
 *
 * 它只做三件事：收事件（ingest）、研判（gate + 规则）、记账（decision）。
 * **不建工单、不派工、不执行任何工具** —— 这是 P1 与 P2 的分界线，
 * 也是本文件敢以「一次 SELECT + 一次 INSERT」的成本常驻的原因。
 *
 * 为什么不用队列中间件：状态全在表里。
 *   trigger.disposition  = 游标
 *   thread.eval_running  = 线程锁
 *   decision             = 决策账本
 * 进程重启后 tick 从表里接着跑，没有任何「内存里的待办」会丢。
 * 这正是「评估无状态」在单机 SQLite 上的落地形态。
 *
 * 关停开关：DEVWORK_SUPERAGENT=off —— 一键回到旧链路，不删表、不改数据。
 */
import { AUDIT_GLOBAL_SCOPE, all, get, newId, nowIso, run, writeAudit } from '../db/database';
import { settingRaw } from '../db/repositories';
import { DEFAULT_WORKSPACE_ID } from '../config';
import {
  DEFAULT_POLICY,
  gate,
  matchRules,
  type AcceptMode,
  type RuleScope,
  type ShadowPolicy,
  type ShadowRule,
  type Strength,
} from './shadow-gate';

type Row = Record<string, unknown>;

export const SUPERAGENT_ENV = 'DEVWORK_SUPERAGENT';
const SETTING_SECTION = 'superagent';
const DEFAULT_TICK_MS = 800;
const DEFAULT_BATCH = 20;

export type SourceKind = 'user' | 'terminal' | 'git' | 'sql' | 'log' | 'schedule' | 'ci';

/** 七类源。主动源（log / schedule / ci / sql）默认关闭：按需打开是操作者的动作。
 *  enabled 用 0 | 1 而不是 boolean：这一列直接写进 SQLite，
 *  布尔在绑定参数时没有对应类型（SqlValue 只收 string / number / null）。 */
const SOURCE_CATALOG: { kind: SourceKind; enabled: 0 | 1; title: string; config: Row }[] = [
  { kind: 'user', enabled: 1, title: '人工请求', config: { intake: 'mention-or-direct' } },
  { kind: 'terminal', enabled: 0, title: '终端命令结束', config: { onExitCode: 'non-zero' } },
  { kind: 'git', enabled: 0, title: '仓库变更', config: { events: ['push', 'pull_request'] } },
  { kind: 'sql', enabled: 0, title: '慢查询阈值', config: { thresholdMs: 2000 } },
  { kind: 'log', enabled: 0, title: '日志异常', config: { pattern: 'ERROR|FATAL' } },
  { kind: 'schedule', enabled: 0, title: '定时巡检', config: { schedule: 'daily', at: '09:30', prompt: '' } },
  { kind: 'ci', enabled: 0, title: '流水线结果', config: { onFailure: true } },
];

/* ───────────────────────────── 定时源 ───────────────────────────── */

export interface ScheduleConfig {
  /** daily = 每天固定时刻；interval = 固定间隔。 */
  schedule?: 'daily' | 'interval';
  /** daily 用：HH:MM（本地时区）。 */
  at?: string;
  /** interval 用：间隔分钟数，最小 5。 */
  everyMinutes?: number;
  /** 触发时投递的正文（想让 Agent 巡检什么，就写在这里）。 */
  prompt?: string;
}

const DEFAULT_CHECK_PROMPT = '定时巡检：检查当前工作区的资产状态与最近的失败动作，有异常则给出结论，无异常一句话带过。';

export function rawConfigOf(source: Row): Row {
  try {
    const parsed = JSON.parse(String(source.config ?? '{}')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Row) : {};
  } catch {
    return {};
  }
}

export function scheduleConfigOf(source: Row): ScheduleConfig {
  const raw = rawConfigOf(source);
  return {
    schedule: raw.schedule === 'interval' ? 'interval' : 'daily',
    at: String(raw.at ?? '09:30'),
    everyMinutes: Number(raw.everyMinutes ?? 60),
    prompt: String(raw.prompt ?? ''),
  };
}

/**
 * 算下一次触发时刻。
 *
 * 刻意用**本地时区**：这是桌面软件，「每天 09:30」指的是用户表上的 09:30。
 * 换成 UTC 会让深圳的用户在 17:30 收到巡检。
 *
 * 补发策略：错过多次只补一次。关电脑三天后开机，不应该连着炸出三条巡检。
 */
export function computeNextFire(config: ScheduleConfig, from = new Date()): string {
  if (config.schedule === 'interval') {
    const minutes = Math.max(5, Math.floor(Number(config.everyMinutes ?? 60) || 60));
    return new Date(from.getTime() + minutes * 60_000).toISOString();
  }
  const raw = String(config.at ?? '09:30');
  const [hourText, minuteText] = raw.split(':');
  const hour = Number.parseInt(hourText ?? '', 10);
  const minute = Number.parseInt(minuteText ?? '', 10);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 9);
  next.setMinutes(Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 30);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** 该源的下一次到点时刻写回库（重启后仍算得回来）。 */
function advanceSchedule(source: Row, from = new Date()): string {
  const next = computeNextFire(scheduleConfigOf(source), from);
  run('UPDATE source SET next_fire_at = ? WHERE id = ?', next, String(source.id));
  return next;
}

/**
 * 把「该跑一次」翻译成一条 Trigger。
 *
 * 投递本身走普通的 ingest 路径 —— 定时源没有任何特权：它是 system 身份，
 * 只能产生 inferred 候选，一样要过 Gate、过频控、过规则匹配。
 * 这条边界很重要：定时器不该是绕过准入的后门。
 */
function emitScheduledTrigger(source: Row, dueAt: string): IngestResult {
  const config = scheduleConfigOf(source);
  const body = String(config.prompt ?? '').trim() || DEFAULT_CHECK_PROMPT;
  return ingestTrigger({
    workspaceId: String(source.workspace_id),
    sourceKind: 'schedule',
    threadKey: `schedule:${String(source.id)}`,
    threadTitle: '定时巡检',
    actor: 'scheduler',
    actorKind: 'system',
    body,
    payload: { schedule: config.schedule, at: config.at, dueAt },
    /* 幂等键带到期时刻：同一次到点即使重复进入（崩溃/重放）也只留一条。 */
    idemKey: `sched:${String(source.id)}:${dueAt}`,
  });
}

/** 每个 tick 检查一次到点的定时源。一条极轻的 SELECT，没有到点的行就是空转。 */
export function fireDueSchedules(now = new Date()): number {
  const rows = all<Row>("SELECT * FROM source WHERE kind = 'schedule' AND enabled = 1");
  let fired = 0;
  rows.forEach((source) => {
    const next = String(source.next_fire_at ?? '');
    if (!next) {
      /* 刚启用 / 老库刚补列：只排下一次，不补发。
       * 否则「启用」这个动作会立刻跑一次巡检，人会以为它自己决定要干活。 */
      advanceSchedule(source, now);
      return;
    }
    if (new Date(next).getTime() > now.getTime()) return;
    emitScheduledTrigger(source, next);
    advanceSchedule(source, now);
    fired += 1;
  });
  return fired;
}

/**
 * 立即触发一次（面板「立即巡检」/ 测试用）。
 *
 * 只投递，**不推进** next_fire_at：手动跑一次不该把明天的巡检挪走。
 */
export function fireSourceNow(kind: SourceKind): IngestResult | null {
  const row = get<Row>('SELECT * FROM source WHERE kind = ? ORDER BY created_at LIMIT 1', kind);
  if (!row) return null;
  return emitScheduledTrigger(row, new Date().toISOString());
}

/**
 * 取「这个工作区的这个源」那一行。
 *
 * 以前写的是 `UPDATE … WHERE kind = ?` 配 `SELECT … ORDER BY created_at LIMIT 1`：
 * 写操作改了**全部**工作区的同名源，读回来的却只有第一个 —— 两个工作区各有一份
 * schedule 源时，改 A 的巡检时间会把 B 的开关一起关掉（审计 A-P2-07）。
 * 未带 workspaceId 的旧调用退回「最早的那一行」且只改这一行，不再波及所有工作区。
 */
function sourceRowOf(kind: SourceKind, workspaceId?: string): Row | undefined {
  return workspaceId
    ? get<Row>('SELECT * FROM source WHERE kind = ? AND workspace_id = ? ORDER BY created_at LIMIT 1', kind, workspaceId)
    : get<Row>('SELECT * FROM source WHERE kind = ? ORDER BY created_at LIMIT 1', kind);
}

/** 改源配置（目前只服务 schedule）。改完立刻按新配置重排下次触发。 */
export function updateSourceConfig(kind: SourceKind, patch: ScheduleConfig, workspaceId = ''): Row | null {
  const row = sourceRowOf(kind, workspaceId || undefined);
  if (!row) return null;
  const merged = { ...rawConfigOf(row), ...patch };
  run('UPDATE source SET config = ? WHERE id = ?', JSON.stringify(merged), String(row.id));
  const updated = get<Row>('SELECT * FROM source WHERE id = ?', String(row.id));
  if (updated && kind === 'schedule' && Number(updated.enabled) === 1) advanceSchedule(updated, new Date());
  return get<Row>('SELECT * FROM source WHERE id = ?', String(row.id)) ?? null;
}

/** 缓存 2 秒：两个循环每秒都会问一次，而这是个纯配置项。 */
let enabledCache = { value: true, at: 0 };

/**
 * 总开关。env 优先级最高（运维要能一键止血），其次是设置页。
 *
 * 为什么不能只靠 env：打包成桌面软件后，用户没有 env 可设 ——
 * 一个「装完就关不掉」的常驻 Agent 是不可接受的。
 */
export function superagentEnabled(): boolean {
  const env = (process.env[SUPERAGENT_ENV] ?? '').toLowerCase();
  if (env === 'off') return false;
  if (env === 'on') return true;
  const now = Date.now();
  if (now - enabledCache.at < 2000) return enabledCache.value;
  let value = true;
  try {
    value = settingRaw(SETTING_SECTION).enabled !== false;
  } catch {
    value = true;
  }
  enabledCache = { value, at: now };
  return value;
}

export function setSuperagentEnabled(enabled: boolean): boolean {
  const raw: Row = { ...settingRaw(SETTING_SECTION), enabled };
  const exists = get<Row>('SELECT section FROM setting WHERE section = ?', SETTING_SECTION);
  if (exists) {
    run('UPDATE setting SET raw = ? WHERE section = ?', JSON.stringify(raw), SETTING_SECTION);
  } else {
    run('INSERT INTO setting (section, raw) VALUES (?,?)', SETTING_SECTION, JSON.stringify(raw));
  }
  enabledCache = { value: enabled, at: Date.now() };
  writeAudit({
    /* 总开关是全局配置，归属如实记为 global（不再伪装成 w-ops）。 */
    workspaceId: AUDIT_GLOBAL_SCOPE,
    actor: '用户', source: 'user',
    action: 'superagent.toggle', target: '影子链路',
    result: enabled ? '放行' : '拦截', severity: enabled ? 'info' : 'warn',
    detail: enabled ? '影子链路已启用' : '影子链路已关停（两个循环都会空转）',
  });
  return enabled;
}

/* ───────────────────────────── 策略 ───────────────────────────── */

function asArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

/** 规则里的授权范围。actions 为空视为「这条规则不表态」，返回 undefined。 */
function normalizeScope(value: unknown): RuleScope | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Row;
  const actions = asArray(raw.actions);
  if (actions.length === 0) return undefined;
  const ceiling = String(raw.riskCeiling ?? 'low');
  return {
    actions,
    riskCeiling: ceiling === 'medium' || ceiling === 'high' ? ceiling : 'low',
    maxWrites: Math.max(0, Math.floor(Number(raw.maxWrites ?? 0) || 0)),
  };
}

function normalizeRules(value: unknown): ShadowRule[] {
  if (!Array.isArray(value)) return DEFAULT_POLICY.rules;
  const rules: ShadowRule[] = [];
  value.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const row = item as Row;
    const id = String(row.id ?? '').trim();
    if (!id) return;
    rules.push({
      id,
      name: String(row.name ?? id).trim() || id,
      enabled: row.enabled !== false,
      keywords: asArray(row.keywords),
      assetTypes: asArray(row.assetTypes),
      scope: normalizeScope(row.scope),
    });
  });
  return rules;
}

/**
 * 生效策略。
 *
 * 缺省值刻意保守：acceptMode=observe（只看不做）、白名单只有「本机用户」。
 * 主动干活的能力不该靠默认值获得，必须靠操作者写进设置。
 */
export function shadowPolicy(): ShadowPolicy {
  let raw: Row = {};
  try {
    raw = settingRaw(SETTING_SECTION);
  } catch {
    return { ...DEFAULT_POLICY };
  }
  const mode = String(raw.acceptMode ?? '').trim();
  const acceptMode: AcceptMode = mode === 'off' || mode === 'auto' || mode === 'observe'
    ? (mode as AcceptMode)
    : DEFAULT_POLICY.acceptMode;
  const rate = Number(raw.threadRatePerHour ?? DEFAULT_POLICY.threadRatePerHour);
  const autoMax = Number(raw.autoMaxPerHour ?? DEFAULT_POLICY.autoMaxPerHour);
  /* 「没配过」用默认值，「配成空」就是空。
   * 早期写法是「数组为空就回落默认」，导致白名单永远删不干净——把最后一个人删了，
   * 刷新一下他又回来了。空名单是一个合法状态（谁都不接），不该被默认值顶掉。 */
  const allowedActors = Array.isArray(raw.allowedActors)
    ? asArray(raw.allowedActors)
    : DEFAULT_POLICY.allowedActors;
  return {
    acceptMode,
    allowedActors,
    allowedBots: asArray(raw.allowedBots),
    threadRatePerHour: Number.isFinite(rate) ? Math.min(24, Math.max(1, Math.floor(rate))) : DEFAULT_POLICY.threadRatePerHour,
    autoMaxPerHour: Number.isFinite(autoMax)
      ? Math.max(0, Math.min(20, Math.floor(autoMax)))
      : DEFAULT_POLICY.autoMaxPerHour,
    /* 只认严格的 true：字符串 "false" 也当 false，避免配置文件写错就开了写权限。 */
    autoAllowWrites: raw.autoAllowWrites === true,
    rules: normalizeRules(raw.rules),
    policyVersion: String(raw.policyVersion ?? DEFAULT_POLICY.policyVersion).trim() || DEFAULT_POLICY.policyVersion,
  };
}

/** 写策略。任何会影响判定的改动都升一次 policyVersion —— 决策要能回溯「凭哪版规则」。 */
export function saveShadowPolicy(patch: Partial<ShadowPolicy>): ShadowPolicy {
  const current = shadowPolicy();
  const raw: Row = { ...settingRaw(SETTING_SECTION) };
  const nextMode = patch.acceptMode ?? current.acceptMode;
  const nextRate = patch.threadRatePerHour ?? current.threadRatePerHour;
  const nextRules = patch.rules ?? current.rules;
  const seq = Number(raw.policySeq ?? 1) + 1;

  raw.acceptMode = nextMode;
  raw.allowedActors = patch.allowedActors ?? current.allowedActors;
  raw.allowedBots = patch.allowedBots ?? current.allowedBots;
  raw.threadRatePerHour = Math.min(24, Math.max(1, Math.floor(Number(nextRate) || 1)));
  /* 注意这里用 ?? 而不是 ||：autoMaxPerHour = 0 是一个有意义的配置
   * （等于关掉自动签发），用 || 会把它悄悄变成默认值 3。 */
  const nextAutoMax = patch.autoMaxPerHour ?? current.autoMaxPerHour;
  raw.autoMaxPerHour = Math.max(0, Math.min(20, Math.floor(Number(nextAutoMax))));
  raw.autoAllowWrites = patch.autoAllowWrites ?? current.autoAllowWrites;
  raw.rules = nextRules;
  raw.policySeq = seq;
  raw.policyVersion = `pol-${seq}`;

  const exists = get<Row>('SELECT section FROM setting WHERE section = ?', SETTING_SECTION);
  if (exists) {
    run('UPDATE setting SET raw = ? WHERE section = ?', JSON.stringify(raw), SETTING_SECTION);
  } else {
    run('INSERT INTO setting (section, raw) VALUES (?,?)', SETTING_SECTION, JSON.stringify(raw));
  }
  return shadowPolicy();
}

/* ───────────────────────────── 源与线程 ───────────────────────────── */

function defaultWorkspaceId(): string {
  const row = get<Row>('SELECT id FROM workspace ORDER BY created_at ASC LIMIT 1');
  return String(row?.id ?? DEFAULT_WORKSPACE_ID);
}

/** 幂等播种七类源（结构性配置，不是演示数据）。 */
export function ensureShadowSources(): number {
  const workspaceId = defaultWorkspaceId();
  let created = 0;
  SOURCE_CATALOG.forEach((item) => {
    const exists = get<Row>('SELECT id FROM source WHERE workspace_id = ? AND kind = ?', workspaceId, item.kind);
    if (exists) return;
    run(
      'INSERT INTO source (id,workspace_id,kind,config,enabled,read_position,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      newId(`src-${item.kind}`), workspaceId, item.kind, JSON.stringify({ ...item.config, title: item.title }), item.enabled, '', '', nowIso(),
    );
    created += 1;
  });
  return created;
}

/**
 * 启动清理：上一进程若死在 tick 中间，eval_running 会留在 1，
 * 那条线程从此再也不被研判 —— 这是「无状态」唯一的坑，必须显式抹平。
 */
export function recoverShadowState(): number {
  return run('UPDATE thread SET eval_running = 0 WHERE eval_running = 1');
}

function ensureSource(kind: SourceKind, workspaceId: string): Row {
  const found = get<Row>('SELECT * FROM source WHERE workspace_id = ? AND kind = ?', workspaceId, kind);
  if (found) return found;
  const catalog = SOURCE_CATALOG.find((item) => item.kind === kind);
  const id = newId(`src-${kind}`);
  run(
    'INSERT INTO source (id,workspace_id,kind,config,enabled,read_position,last_seen_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, workspaceId, kind, JSON.stringify(catalog?.config ?? {}), catalog?.enabled ?? 0, '', '', nowIso(),
  );
  return get<Row>('SELECT * FROM source WHERE id = ?', id) as Row;
}

function ensureThread(source: Row, workspaceId: string, threadKey: string, title: string, assetId?: string | null): Row {
  const sourceId = String(source.id);
  const found = get<Row>('SELECT * FROM thread WHERE source_id = ? AND thread_key = ?', sourceId, threadKey);
  if (found) {
    /* 会话可能在第一次发消息后才绑定资产（从代码库页发起）—— 补上即可，不重建线程。 */
    if (assetId && !found.asset_id) {
      run('UPDATE thread SET asset_id = ? WHERE id = ?', assetId, String(found.id));
      return { ...found, asset_id: assetId };
    }
    return found;
  }
  const id = newId('thr');
  run(
    'INSERT INTO thread (id,workspace_id,source_id,asset_id,thread_key,title,eval_running,created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, workspaceId, sourceId, assetId ?? null, threadKey, title, 0, nowIso(),
  );
  return get<Row>('SELECT * FROM thread WHERE id = ?', id) as Row;
}

/* ───────────────────────────── 收事件 ───────────────────────────── */

export interface IngestInput {
  workspaceId?: string;
  sourceKind: SourceKind;
  /** 源内稳定键：会话 id / 文件路径 / issue 号。缺省用 'inbox'。 */
  threadKey?: string;
  threadTitle?: string;
  /** 线程绑定的资产：决定规则里的 assetTypes 匹配。 */
  assetId?: string | null;
  actor: string;
  actorKind?: 'person' | 'bot' | 'system';
  addressed?: boolean;
  body?: string;
  payload?: Row;
  /** 幂等键。由源提供（外部事件 id）；缺省每条都是新事件。 */
  idemKey?: string;
  receivedAt?: string;
}

export interface IngestResult {
  triggerId: string;
  threadId: string;
  sourceId: string;
  /** false = 幂等命中，库里已有同一条事件。 */
  created: boolean;
}

export function ingestTrigger(input: IngestInput): IngestResult {
  const workspaceId = input.workspaceId ?? defaultWorkspaceId();
  const source = ensureSource(input.sourceKind, workspaceId);
  const sourceId = String(source.id);
  const threadKey = (input.threadKey ?? 'inbox').slice(0, 200);
  const thread = ensureThread(source, workspaceId, threadKey, input.threadTitle ?? threadKey, input.assetId);
  const threadId = String(thread.id);

  const body = (input.body ?? '').slice(0, 8000);
  const receivedAt = input.receivedAt ?? nowIso();
  const idemKey = (input.idemKey ?? newId('evt')).slice(0, 200);
  const payload = JSON.stringify(input.payload ?? {});
  const triggerId = newId('trg');

  const inserted = run(
    `INSERT OR IGNORE INTO trigger
      (id,thread_id,source_id,actor,actor_kind,addressed,body,payload,idem_key,disposition,decision_id,received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    triggerId, threadId, sourceId,
    input.actor.slice(0, 120),
    input.actorKind ?? 'person',
    input.addressed ? 1 : 0,
    body, payload, idemKey,
    'pending', '', receivedAt,
  );

  /* 只更新 last_seen_at —— **不碰 read_position**。
   * read_position 是采集器的位点（字节偏移 / git HEAD / 时间戳），
   * 由采集器自己推进；这里写幂等键会把刚推进的位点覆盖掉，
   * 于是下一轮采集器要么从头重扫（log），要么永远停在旧位点（terminal/sql）。 */
  run('UPDATE source SET last_seen_at = ? WHERE id = ?', receivedAt, sourceId);

  if (inserted === 0) {
    const existing = get<Row>('SELECT id FROM trigger WHERE source_id = ? AND idem_key = ?', sourceId, idemKey);
    return { triggerId: String(existing?.id ?? ''), threadId, sourceId, created: false };
  }
  return { triggerId, threadId, sourceId, created: true };
}

/* ───────────────────────────── 研判 ───────────────────────────── */

let ticking = false;
let tickCount = 0;
let lastTickAt = '';
let lastTickMs = 0;
let timer: NodeJS.Timeout | null = null;

function payloadKeysOf(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? Object.keys(parsed as Row) : [];
  } catch {
    return [];
  }
}

function assetTypeOf(thread: Row, cache: Map<string, string>): string {
  const assetId = String(thread.asset_id ?? '');
  if (!assetId) return '';
  const hit = cache.get(assetId);
  if (hit !== undefined) return hit;
  const row = get<Row>('SELECT type FROM asset WHERE id = ?', assetId);
  const type = String(row?.type ?? '');
  cache.set(assetId, type);
  return type;
}

/** 一小时内该线程的决策数（频控依据）。 */
function recentDecisions(threadId: string): number {
  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const row = get<Row>('SELECT COUNT(*) AS n FROM decision WHERE thread_id = ? AND created_at >= ?', threadId, cutoff);
  return Number(row?.n ?? 0);
}

export interface MandateScope {
  /**
   * 授权粒度。
   *   asset     —— 事件挂到了具体资产，范围收窄到那一个
   *   workspace —— 没挂资产，退到工作区级，但**必须**带 assetTypes 白名单
   * 为什么要有这一级：`conversation.asset_id` 默认是 NULL，人平时就是开个会话问一句。
   * 没有工作区级，绝大多数草案会卡在「范围未定」，Mandate 永远签不出来。
   */
  level: 'workspace' | 'asset';
  workspaceId: string;
  /** 允许动的资产（level=asset 时只有一个）。 */
  assets: string[];
  /** 允许的资产类型白名单：工作区级授权靠它划界。 */
  assetTypes: string[];
  actions: string[];
  riskCeiling: RuleScope['riskCeiling'];
  maxWrites: number;
}

const RISK_ORDER: Record<RuleScope['riskCeiling'], number> = { low: 0, medium: 1, high: 2 };

/**
 * 把命中的规则合成为一份范围。
 *
 * 三条合成规则，每条都取「最宽」或「最严」中的一种，必须固定下来：
 *   · actions 取并集 —— 两条规则各允许一些动作，合起来都允许
 *   · riskCeiling 取最高 —— 否则「只读规则 + 可写规则」同时命中会退化成只读，写不出去
 *   · maxWrites 取最大 —— 同风险
 * 反过来（取交集 / 取最低）会让多规则命中变成「谁都不敢动」，那是另一种失效。
 */
function buildMandateScope(rules: ShadowRule[], thread: Row): MandateScope {
  const actions = new Set<string>();
  const assetTypes = new Set<string>();
  let riskCeiling: RuleScope['riskCeiling'] = 'low';
  let maxWrites = 0;

  rules.forEach((rule) => {
    (rule.assetTypes ?? []).forEach((type) => assetTypes.add(type));
    if (!rule.scope) return;
    rule.scope.actions.forEach((action) => actions.add(action));
    if (RISK_ORDER[rule.scope.riskCeiling] > RISK_ORDER[riskCeiling]) riskCeiling = rule.scope.riskCeiling;
    maxWrites = Math.max(maxWrites, rule.scope.maxWrites);
  });

  const assetId = String(thread.asset_id ?? '');
  return {
    level: assetId ? 'asset' : 'workspace',
    workspaceId: String(thread.workspace_id ?? ''),
    assets: assetId ? [assetId] : [],
    assetTypes: [...assetTypes],
    actions: [...actions],
    riskCeiling,
    maxWrites,
  };
}

/**
 * 生成授权草案。
 *
 * 它**不授予任何权力**：没有工单、没有派工、没有执行器读它。
 * 存在的唯一理由是让人在授权真正发生之前，先看范围算得准不准——
 * 「规则只写了关键词，能不能推出一个说得清的范围」是 P2 第一个会踩的坑。
 */
function createDraftMandate(input: {
  decisionId: string;
  thread: Row;
  rules: ShadowRule[];
  policy: ShadowPolicy;
  strength: Strength;
  requester: string;
}): string | null {
  const scope = buildMandateScope(input.rules, input.thread);
  /* 一条动作都没推出来 = 规则没给范围。这种情况下不发草案：
   * 一份「什么都能做」的空范围比没有更危险，它会被误读成「已授权」。 */
  if (scope.actions.length === 0) return null;
  /* 工作区级授权必须带资产类型白名单。
   * 不带 = 整个工作区任意资产，那不是「范围较宽」，是「没有范围」，
   * 只是穿了一件好看的外衣。宁可不签，也不要签一份无界的。 */
  if (scope.level === 'workspace' && scope.assetTypes.length === 0) return null;
  const id = newId('mnd');
  run(
    `INSERT INTO mandate
      (id,decision_id,ticket_id,status,strength,policy_version,requester,scope,matched_rules,attention_budget,note,created_at,reviewed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.decisionId,
    null,
    'draft',
    input.strength,
    input.policy.policyVersion,
    input.requester,
    JSON.stringify(scope),
    JSON.stringify(input.rules.map((rule) => rule.id)),
    1,
    '',
    nowIso(),
    null,
  );
  return id;
}

/* auto 签发的标记前缀：统计「有多少授权是没人看过就签出去的」靠它。 */
const AUTO_NOTE_PREFIX = 'auto:';

function autoIssuedLastHour(): number {
  const since = new Date(Date.now() - 3600_000).toISOString();
  return Number(
    get<Row>(
      'SELECT COUNT(*) AS n FROM mandate WHERE status = ? AND created_at >= ? AND note LIKE ?',
      'accepted', since, `${AUTO_NOTE_PREFIX}%`,
    )?.n ?? 0,
  );
}

/**
 * auto 模式：把人审这一步省掉 —— 但不是无条件的。
 *
 * 四道闸，从宽到严：
 *   ① 只有 `acceptMode = auto` 才走这条路（observe 下永远是草案）
 *   ② 有写权限的范围默认仍要人点头（`autoAllowWrites` 才放行）
 *   ③ 每小时签发数受 `autoMaxPerHour` 约束（防刷屏）
 *   ④ 范围推不出来（scopeUndefined）的草案根本不签发
 *
 * 为什么②默认关：auto 的意义是「省掉重复确认」，不是「省掉责任」。
 * 只读任务签错了，代价是多查了几次库；写任务签错了，代价是代码被改。
 * 两者不该享受同一个默认值。
 *
 * 返回 reason 而不是布尔，是因为「为什么没自动签」本身要被观测到 ——
 * 面板上「auto 开着但一单没签」和「auto 开着但预算爆了」是完全不同的两件事。
 */
export function maybeAutoIssue(mandateId: string, policy: ShadowPolicy): { issued: boolean; reason: string } {
  if (policy.acceptMode !== 'auto') return { issued: false, reason: 'E_NOT_AUTO' };

  const row = get<Row>('SELECT * FROM mandate WHERE id = ?', mandateId);
  if (!row) return { issued: false, reason: 'E_NOT_FOUND' };
  if (String(row.status) !== 'draft') return { issued: false, reason: 'E_ALREADY_RESOLVED' };

  const shape = mandateShape(row);
  if (shape.scopeUndefined) return { issued: false, reason: 'E_AUTO_SCOPE_UNDEFINED' };

  const scope = shape.scope as MandateScope;
  if (scope.maxWrites > 0 && !policy.autoAllowWrites) {
    return { issued: false, reason: 'E_AUTO_WRITE_LOCKED' };
  }
  if (autoIssuedLastHour() >= policy.autoMaxPerHour) {
    return { issued: false, reason: 'E_AUTO_BUDGET' };
  }

  run(
    "UPDATE mandate SET status = ?, reviewed_at = ?, note = ? WHERE id = ?",
    'accepted',
    nowIso(),
    `${AUTO_NOTE_PREFIX}${policy.policyVersion} · 风险≤${scope.riskCeiling} · 写 ${scope.maxWrites} 次`,
    mandateId,
  );
  /* 审计归属沿 decision → trigger → thread 回溯到真实工作区
   * （mandate / trigger 表本身不带 workspace_id，thread 才是归属载体）。 */
  const owner = get<{ workspace_id: string }>(
    `SELECT th.workspace_id AS workspace_id FROM mandate m
       JOIN decision d ON d.id = m.decision_id
       JOIN trigger t ON t.id = d.trigger_id
       JOIN thread th ON th.id = t.thread_id
     WHERE m.id = ?`,
    mandateId,
  );
  writeAudit({
    workspaceId: String(owner?.workspace_id ?? AUDIT_GLOBAL_SCOPE),
    actor: '系统', source: 'system',
    action: 'superagent.mandate.auto', target: `mandate:${mandateId}`,
    result: '放行', severity: 'warn',
    detail: `auto 签发：${scope.level === 'asset' ? scope.assets.join(',') : `工作区级 ${scope.assetTypes.join('/')}`}`
      + ` · ${scope.actions.length} 个动作 · 写 ${scope.maxWrites} 次`,
  });
  return { issued: true, reason: 'auto' };
}

/**
 * 研判一条触发并落决策。
 *
 * P1 只产生两种 kind：
 *   ignore（would_accept=1）—— 「我本来会接这单」，影子期的核心产出
 *   ignore（would_accept=0）—— 「不该接」，附带 reason_code 说明被什么挡住
 * 没有 unavailable：P1 的研判不依赖模型，纯规则可判，不存在「没跑完」。
 */
function evaluate(trigger: Row, policy: ShadowPolicy, assetTypeCache: Map<string, string>): void {
  const startedAt = Date.now();
  const source = get<Row>('SELECT * FROM source WHERE id = ?', String(trigger.source_id));
  const thread = get<Row>('SELECT * FROM thread WHERE id = ?', String(trigger.thread_id));
  if (!source || !thread) return;

  const body = String(trigger.body ?? '');
  const verdict = gate({
    sourceEnabled: Number(source.enabled) === 1,
    sourceKind: String(source.kind ?? ''),
    actor: String(trigger.actor ?? ''),
    actorKind: (String(trigger.actor_kind ?? 'person') as 'person' | 'bot' | 'system'),
    addressed: Number(trigger.addressed) === 1,
    body,
    payloadKeys: payloadKeysOf(String(trigger.payload ?? '{}')),
    recentDecisions: recentDecisions(String(thread.id)),
  }, policy);

  const assetType = assetTypeOf(thread, assetTypeCache);
  /* 只有过了准入才谈「值不值得接」：被挡掉的事件不该命中原规则，
   * 否则统计里会出现「明明没准入却匹配了规则」的自相矛盾。 */
  const matched = verdict.admitted ? matchRules(policy.rules, body, assetType) : [];
  const wouldAccept = verdict.admitted && matched.length > 0;
  const strength: Strength = verdict.strength;

  const decisionId = newId('dec');
  run(
    `INSERT INTO decision
      (id,thread_id,trigger_id,kind,strength,would_accept,reason_code,reason,matched_rules,policy_version,ticket_id,eval_ms,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    decisionId,
    String(thread.id),
    String(trigger.id),
    'ignore',
    strength,
    wouldAccept ? 1 : 0,
    verdict.reasonCode,
    wouldAccept
      ? `${verdict.reason} · 命中规则 ${matched.join(',')}（影子期只记录，不接单）`
      : verdict.reason,
    JSON.stringify(matched),
    policy.policyVersion,
    null,
    Date.now() - startedAt,
    nowIso(),
  );
  run(
    'UPDATE trigger SET disposition = ?, decision_id = ? WHERE id = ?',
    verdict.admitted ? 'evaluated' : 'ignored',
    decisionId,
    String(trigger.id),
  );

  /* 影子接单 → 顺手产出一份授权草案，供人审阅。 */
  if (wouldAccept) {
    const mandateId = createDraftMandate({
      decisionId,
      thread,
      rules: policy.rules.filter((rule) => matched.includes(rule.id)),
      policy,
      strength,
      requester: String(trigger.actor ?? ''),
    });
    /* auto 模式下试着直接签发。失败不是错误 —— 它会退回草案等人批，
     * 而「为什么没签」由 maybeAutoIssue 的 reason 记录。 */
    if (mandateId) maybeAutoIssue(mandateId, policy);
  }
}

/**
 * 一次 tick：取一批 pending → 按线程分组 → 同线程串行 → 落决策。
 *
 * 线程锁（eval_running）只为「同线程串行」而存在：同一线程的两条消息
 * 如果并发研判，会各自看到「对方还没落决策」的快照，从而重复接单。
 */
export async function tickOnce(): Promise<{ picked: number; evaluated: number; skipped: number }> {
  /* 关停时连库都不碰：不需要停定时器，空转成本就是一次函数调用。 */
  if (!superagentEnabled()) return { picked: 0, evaluated: 0, skipped: 0 };
  if (ticking) return { picked: 0, evaluated: 0, skipped: 0 };
  ticking = true;
  const startedAt = Date.now();
  let picked = 0;
  let evaluated = 0;
  let skipped = 0;
  try {
    /* 先把到点的定时源补成 Trigger：同一 tick 内就会被研判，不用等下一轮。 */
    fireDueSchedules();
    const policy = shadowPolicy();
    const batch = all<Row>(
      `SELECT * FROM trigger WHERE disposition = 'pending'
       ORDER BY received_at ASC, id ASC LIMIT ?`,
      DEFAULT_BATCH,
    );
    picked = batch.length;

    const groups = new Map<string, Row[]>();
    batch.forEach((trigger) => {
      const key = String(trigger.thread_id);
      const list = groups.get(key) ?? [];
      list.push(trigger);
      groups.set(key, list);
    });

    const assetTypeCache = new Map<string, string>();
    for (const [threadId, list] of groups) {
      const thread = get<Row>('SELECT eval_running FROM thread WHERE id = ?', threadId);
      if (!thread || Number(thread.eval_running) === 1) {
        skipped += list.length;
        continue;
      }
      run('UPDATE thread SET eval_running = 1 WHERE id = ?', threadId);
      try {
        list.forEach((trigger) => {
          evaluate(trigger, policy, assetTypeCache);
          evaluated += 1;
        });
      } finally {
        run('UPDATE thread SET eval_running = 0 WHERE id = ?', threadId);
      }
    }

    tickCount += 1;
    lastTickAt = nowIso();
    lastTickMs = Date.now() - startedAt;
    return { picked, evaluated, skipped };
  } catch (error) {
    /* tick 失败不能拖垮服务：记日志、下一轮继续。状态都在表里，重试天然安全。 */
    // eslint-disable-next-line no-console
    console.error('[ShadowScheduler] tick 失败:', error instanceof Error ? error.message : String(error));
    return { picked, evaluated, skipped };
  } finally {
    ticking = false;
  }
}

export function startShadowScheduler(): { started: boolean; reason: string } {
  if (!superagentEnabled()) {
    return { started: false, reason: `${SUPERAGENT_ENV}=off，影子链路未启动` };
  }
  if (timer) return { started: true, reason: '已在运行' };
  ensureShadowSources();
  recoverShadowState();
  timer = setInterval(() => { void tickOnce(); }, DEFAULT_TICK_MS);
  /* unref：影子链路不该阻止进程退出（Electron 关窗时后端要能立刻走）。 */
  timer.unref();
  void tickOnce();
  writeAudit({
    /* 启动是进程级事件，不属于任何一个工作区。 */
    workspaceId: AUDIT_GLOBAL_SCOPE,
    actor: '系统', source: 'system',
    action: 'superagent.shadow.start', target: '影子链路',
    result: '成功', severity: 'info',
    detail: `P1 影子链路启动 · tick=${DEFAULT_TICK_MS}ms · 只记录不执行`,
  });
  return { started: true, reason: '已启动' };
}

export function stopShadowScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/* ───────────────────────────── 读取面 ───────────────────────────── */

export function decisionShape(row: Row): Row {
  let matched: string[] = [];
  try {
    const parsed = JSON.parse(String(row.matched_rules ?? '[]')) as unknown;
    if (Array.isArray(parsed)) matched = parsed.map((item) => String(item));
  } catch {
    matched = [];
  }
  return {
    id: String(row.id ?? ''),
    threadId: String(row.thread_id ?? ''),
    triggerId: String(row.trigger_id ?? ''),
    kind: String(row.kind ?? ''),
    strength: String(row.strength ?? ''),
    wouldAccept: Number(row.would_accept ?? 0) === 1,
    reasonCode: String(row.reason_code ?? ''),
    reason: String(row.reason ?? ''),
    matchedRules: matched,
    policyVersion: String(row.policy_version ?? ''),
    evalMs: Number(row.eval_ms ?? 0),
    createdAt: String(row.created_at ?? ''),
  };
}

export function listShadowDecisions(options: {
  limit?: number; wouldAcceptOnly?: boolean; reasonCode?: string;
} = {}): { items: Row[]; total: number } {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.wouldAcceptOnly) where.push('would_accept = 1');
  if (options.reasonCode) {
    where.push('reason_code = ?');
    params.push(options.reasonCode);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(get<Row>(`SELECT COUNT(*) AS n FROM decision ${clause}`, ...params)?.n ?? 0);
  const items = all<Row>(
    `SELECT * FROM decision ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params, limit,
  ).map(decisionShape);
  return { items, total };
}

export function mandateShape(row: Row): Row {
  let scope: MandateScope = {
    level: 'workspace', workspaceId: '', assets: [], assetTypes: [], actions: [], riskCeiling: 'low', maxWrites: 0,
  };
  try {
    const parsed = JSON.parse(String(row.scope ?? '{}')) as Partial<MandateScope>;
    const assets = Array.isArray(parsed.assets) ? parsed.assets.map(String) : [];
    scope = {
      level: parsed.level === 'asset' || assets.length > 0 ? 'asset' : 'workspace',
      workspaceId: String(parsed.workspaceId ?? ''),
      assets,
      assetTypes: Array.isArray(parsed.assetTypes) ? parsed.assetTypes.map(String) : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions.map(String) : [],
      riskCeiling: parsed.riskCeiling === 'medium' || parsed.riskCeiling === 'high' ? parsed.riskCeiling : 'low',
      maxWrites: Math.max(0, Math.floor(Number(parsed.maxWrites ?? 0) || 0)),
    };
  } catch {
    /* 坏数据不炸页面：保持空范围，面板上会显示「范围未定」。 */
  }
  let matched: string[] = [];
  try {
    const parsed = JSON.parse(String(row.matched_rules ?? '[]')) as unknown;
    if (Array.isArray(parsed)) matched = parsed.map((item) => String(item));
  } catch {
    matched = [];
  }
  return {
    id: String(row.id ?? ''),
    decisionId: String(row.decision_id ?? ''),
    ticketId: row.ticket_id ? String(row.ticket_id) : null,
    status: String(row.status ?? 'draft'),
    strength: String(row.strength ?? ''),
    policyVersion: String(row.policy_version ?? ''),
    requester: String(row.requester ?? ''),
    scope,
    matchedRules: matched,
    attentionBudget: Number(row.attention_budget ?? 1),
    note: String(row.note ?? ''),
    createdAt: String(row.created_at ?? ''),
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    /** 范围不足：既没挂资产，规则也没给资产类型 —— 这种草案不允许「认可」。 */
    scopeUndefined: scope.actions.length === 0
      || (scope.level === 'workspace' && scope.assetTypes.length === 0),
    readOnly: scope.maxWrites === 0,
  };
}

export function triggerShape(row: Row): Row {
  return {
    id: String(row.id ?? ''),
    threadId: String(row.thread_id ?? ''),
    threadKey: String(row.thread_key ?? ''),
    sourceKind: String(row.source_kind ?? ''),
    actor: String(row.actor ?? ''),
    actorKind: String(row.actor_kind ?? ''),
    addressed: Number(row.addressed ?? 0) === 1,
    body: String(row.body ?? ''),
    disposition: String(row.disposition ?? ''),
    decisionId: String(row.decision_id ?? ''),
    idemKey: String(row.idem_key ?? ''),
    receivedAt: String(row.received_at ?? ''),
  };
}

/**
 * 事件列表。
 *
 * 决策账本只回答「判了什么」，不回答「吃了什么」。影子面板要能对照
 * 「这条消息 → 这个判断」，否则没法人工抽查 Gate 是不是把话理解错了。
 */
export function listShadowTriggers(options: {
  limit?: number; disposition?: string; threadKey?: string;
} = {}): { items: Row[]; total: number } {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.disposition) {
    where.push('t.disposition = ?');
    params.push(options.disposition);
  }
  if (options.threadKey) {
    where.push('th.thread_key = ?');
    params.push(options.threadKey);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(get<Row>(
    `SELECT COUNT(*) AS n FROM trigger t JOIN thread th ON th.id = t.thread_id ${clause}`,
    ...params,
  )?.n ?? 0);
  const items = all<Row>(
    `SELECT t.*, th.thread_key, s.kind AS source_kind
     FROM trigger t
     JOIN thread th ON th.id = t.thread_id
     JOIN source s ON s.id = t.source_id
     ${clause}
     ORDER BY t.received_at DESC, t.id DESC LIMIT ?`,
    ...params, limit,
  ).map(triggerShape);
  return { items, total };
}

export function listShadowMandates(options: { limit?: number; status?: string } = {}): { items: Row[]; total: number } {
  const limit = Math.min(200, Math.max(1, options.limit ?? 50));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(get<Row>(`SELECT COUNT(*) AS n FROM mandate ${clause}`, ...params)?.n ?? 0);
  const items = all<Row>(
    `SELECT * FROM mandate ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params, limit,
  ).map(mandateShape);
  return { items, total };
}

export type MandateReview = 'accepted' | 'narrowed' | 'rejected';

/**
 * 人对草案表态。
 *
 * 三条硬规则：
 *   1. 只能改 draft → 别的状态一次定终身（与 Mandate 不可变一致）；
 *   2. 收窄只能**减少**权限：传入的 actions 必须与现有范围取交集，
 *      不然「收窄」就成了绕过授权的后门；
 *   3. 表态不产生任何执行动作 —— 影子期它只是记录「人怎么看这份范围」。
 */
export function reviewMandate(
  id: string,
  input: { status: MandateReview; note?: string; actions?: string[] },
): Row | null {
  const row = get<Row>('SELECT * FROM mandate WHERE id = ?', id);
  if (!row) return null;
  if (String(row.status) !== 'draft') {
    throw new Error(`授权草案已定稿（${String(row.status)}），不可再次表态`);
  }
  const current = mandateShape(row);
  let scope = current.scope as MandateScope;
  if (input.status === 'narrowed' && Array.isArray(input.actions)) {
    const allowed = new Set(scope.actions);
    const kept = [...new Set(input.actions.map(String))].filter((action) => allowed.has(action));
    /* 只收窄 actions；maxWrites 不动（收窄动作不等于放宽次数）。 */
    scope = { ...scope, actions: kept };
  }
  run(
    'UPDATE mandate SET status = ?, note = ?, scope = ?, reviewed_at = ? WHERE id = ?',
    input.status,
    (input.note ?? '').slice(0, 500),
    JSON.stringify(scope),
    nowIso(),
    id,
  );
  return mandateShape(get<Row>('SELECT * FROM mandate WHERE id = ?', id) as Row);
}

/**
 * 影子期真正要看的数字。
 *
 * wouldAcceptLast24h 直接回答「这套规则一天会主动接几单」——
 * 它就是决定 auto 模式能不能开的那个数。没有它，P1 等于白跑。
 */
export function shadowStats(): Row {
  const total = Number(get<Row>('SELECT COUNT(*) AS n FROM trigger')?.n ?? 0);
  const pending = Number(get<Row>("SELECT COUNT(*) AS n FROM trigger WHERE disposition = 'pending'")?.n ?? 0);
  const decided = Number(get<Row>('SELECT COUNT(*) AS n FROM decision')?.n ?? 0);
  const wouldAccept = Number(get<Row>('SELECT COUNT(*) AS n FROM decision WHERE would_accept = 1')?.n ?? 0);
  const cutoff = new Date(Date.now() - 86400_000).toISOString();
  const wouldAccept24h = Number(
    get<Row>('SELECT COUNT(*) AS n FROM decision WHERE would_accept = 1 AND created_at >= ?', cutoff)?.n ?? 0,
  );
  const decided24h = Number(
    get<Row>('SELECT COUNT(*) AS n FROM decision WHERE created_at >= ?', cutoff)?.n ?? 0,
  );
  const byReason = all<Row>(
    `SELECT reason_code, COUNT(*) AS n, SUM(would_accept) AS would
     FROM decision GROUP BY reason_code ORDER BY n DESC`,
  ).map((row) => ({
    reasonCode: String(row.reason_code ?? ''),
    count: Number(row.n ?? 0),
    wouldAccept: Number(row.would ?? 0),
  }));
  const bySource = all<Row>(
    `SELECT s.kind AS kind, COUNT(t.id) AS n
     FROM source s LEFT JOIN trigger t ON t.source_id = s.id
     GROUP BY s.id ORDER BY n DESC`,
  ).map((row) => ({ kind: String(row.kind ?? ''), triggers: Number(row.n ?? 0) }));

  const mandateRows = all<Row>('SELECT status, scope FROM mandate');
  const mandateBy = (status: string): number => mandateRows.filter((row) => String(row.status) === status).length;
  let scopeUndefined = 0;
  let levelAsset = 0;
  let levelWorkspace = 0;
  mandateRows.forEach((row) => {
    try {
      const parsed = JSON.parse(String(row.scope ?? '{}')) as { assets?: unknown; assetTypes?: unknown; actions?: unknown };
      const assets = Array.isArray(parsed.assets) ? parsed.assets.length : 0;
      const types = Array.isArray(parsed.assetTypes) ? parsed.assetTypes.length : 0;
      const actions = Array.isArray(parsed.actions) ? parsed.actions.length : 0;
      if (assets > 0) levelAsset += 1;
      else levelWorkspace += 1;
      if (actions === 0 || (assets === 0 && types === 0)) scopeUndefined += 1;
    } catch {
      scopeUndefined += 1;
    }
  });

  /* auto 的实时水位：开了 auto 之后人最先问的就是「它这一个小时自己签了几张」。
   * 只给总数不够 —— 预算是否用满，决定了「没接单」是因为不该接还是因为被刹车挡住。 */
  const policy = shadowPolicy();
  const autoLastHour = autoIssuedLastHour();

  return {
    triggers: { total, pending, decided },
    auto: {
      issuedLastHour: autoLastHour,
      maxPerHour: policy.autoMaxPerHour,
      budgetLeft: Math.max(0, policy.autoMaxPerHour - autoLastHour),
      allowWrites: policy.autoAllowWrites,
      mode: policy.acceptMode,
    },
    mandates: {
      total: mandateRows.length,
      draft: mandateBy('draft'),
      accepted: mandateBy('accepted'),
      narrowed: mandateBy('narrowed'),
      rejected: mandateBy('rejected'),
      /** 范围不足：既无资产、也无资产类型。这个数越大，说明规则写得越粗。 */
      scopeUndefined,
      /** 粒度分布：asset = 收窄到具体资产；workspace = 工作区级 + 类型白名单。 */
      levelAsset,
      levelWorkspace,
    },
    decisions: {
      total: decided,
      wouldAccept,
      wouldAcceptRate: decided > 0 ? Number((wouldAccept / decided).toFixed(4)) : 0,
    },
    last24h: {
      decided: decided24h,
      wouldAccept: wouldAccept24h,
      /* 一天会接几单 —— 这个数字决定 auto 能不能开。 */
      estimatedDailyAccept: wouldAccept24h,
    },
    byReason,
    bySource,
  };
}

export function shadowStatus(): Row {
  /* 源按「目录顺序」排，不按 SQL 的字母序：字母序会把 ci 排第一、把唯一的
   * 「人工请求」排到最后，而人最先要看的恰恰是它。 */
  const order = new Map(SOURCE_CATALOG.map((item, index) => [item.kind as string, index]));
  const sources = all<Row>(
    `SELECT s.kind, s.enabled, s.last_seen_at, s.next_fire_at, s.config, COUNT(t.id) AS triggers
     FROM source s LEFT JOIN trigger t ON t.source_id = s.id
     GROUP BY s.id`,
  ).map((row) => ({
    kind: String(row.kind ?? ''),
    enabled: Number(row.enabled ?? 0) === 1,
    triggers: Number(row.triggers ?? 0),
    lastSeenAt: String(row.last_seen_at ?? ''),
    nextFireAt: String(row.next_fire_at ?? ''),
    /* 只有定时源有这份配置；别的源返回 undefined，前端据此决定要不要渲染编辑行。 */
    schedule: String(row.kind) === 'schedule' ? scheduleConfigOf(row) : undefined,
  }));
  sources.sort((left, right) => (order.get(left.kind) ?? 99) - (order.get(right.kind) ?? 99));

  return {
    enabled: superagentEnabled(),
    running: timer !== null,
    phase: 'P1-shadow',
    tick: { count: tickCount, lastTickAt, lastTickMs, intervalMs: DEFAULT_TICK_MS, batch: DEFAULT_BATCH },
    retentionDays: SHADOW_RETENTION_DAYS,
    policy: shadowPolicy(),
    sources,
  };
}

/** 事件源开关（P1 只允许改 user / terminal 两类，主动源留给 P3 再开）。 */
export function setSourceEnabled(kind: SourceKind, enabled: boolean, workspaceId = ''): number {
  /* 只动「一个工作区的一行」：按 kind 批量 UPDATE 会跨工作区串开关。 */
  const row = sourceRowOf(kind, workspaceId || undefined);
  if (!row) return 0;
  const changed = run('UPDATE source SET enabled = ? WHERE id = ?', enabled ? 1 : 0, String(row.id));
  /* 定时源启用时重排下一次：停在「三天前该跑」的时刻会让它一打开就补发，
   * 而人的预期是「打开之后从下一次开始」。重启要补发，手动开关不补发。 */
  if (changed > 0 && enabled && kind === 'schedule') {
    advanceSchedule(row, new Date());
  }
  return changed;
}

/**
 * 账本导出（CSV）。
 *
 * 为什么要它：影子期的价值在「离线核对」——把决策拉到表格里，跟真实请求对一遍。
 * 只留在 SQLite 里，就等于要求人会用 SQL 才能审自己的 Agent。
 */
export function exportShadowCsv(limit = 1000): { content: string; fileName: string; rows: number } {
  const rows = all<Row>(
    `SELECT d.created_at, s.kind AS source_kind, th.thread_key, t.actor, t.addressed,
            d.strength, d.would_accept, d.reason_code, d.matched_rules, d.policy_version,
            t.body
     FROM decision d
     JOIN trigger t ON t.id = d.trigger_id
     JOIN thread th ON th.id = d.thread_id
     JOIN source s ON s.id = t.source_id
     ORDER BY d.created_at DESC LIMIT ?`,
    Math.min(5000, Math.max(1, limit)),
  );
  const escape = (value: unknown): string => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = ['时间', '来源', '线程', '发起人', '点名', '强度', '本来会接', '原因码', '命中规则', '策略版本', '输入'];
  const lines = [header.join(',')];
  rows.forEach((row) => {
    lines.push([
      escape(row.created_at), escape(row.source_kind), escape(row.thread_key),
      escape(row.actor), Number(row.addressed) === 1 ? '是' : '否',
      escape(row.strength), Number(row.would_accept) === 1 ? '是' : '否',
      escape(row.reason_code), escape(row.matched_rules), escape(row.policy_version),
      escape(row.body),
    ].join(','));
  });
  return {
    content: lines.join('\n'),
    fileName: `devwork-shadow-${new Date().toISOString().slice(0, 10)}.csv`,
    rows: rows.length,
  };
}

/* ───────────────────────────── 留存 ───────────────────────────── */

/** 账本留存天数。30 天足够回答「这套规则一天接几单」，再久只是磁盘负担。 */
export const SHADOW_RETENTION_DAYS = 30;

/**
 * 清理过期观测数据。
 *
 * 为什么必须有：P1.5 之后每一条用户消息都会落一条 trigger，桌面端跑一年就是几十万行。
 * 影子账本是**可重建的观测数据**，不是业务事实 —— 给它一个保留期比让它无限长更诚实。
 *
 * 只删三类：`decision`、已处置的 `trigger`、无触发的空 `thread`。
 * 待研判的 trigger（pending）不删，审计与工单（P2）一律不碰。
 */
export function pruneShadowLedger(days = SHADOW_RETENTION_DAYS): {
  decisions: number; triggers: number; threads: number; mandates: number; sqlTraces: number;
} {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  /* 只清「还没人表过态」的草案：一旦人认可 / 否决过，它就是决策依据，不属于可重建数据。 */
  const mandates = run("DELETE FROM mandate WHERE status = 'draft' AND created_at < ?", cutoff);
  const decisions = run('DELETE FROM decision WHERE created_at < ?', cutoff);
  /* 慢查询留痕与决策同寿命：它是采集器的原料，不是审计证据。 */
  const sqlTraces = run('DELETE FROM sql_trace WHERE created_at < ?', cutoff);
  const triggers = run("DELETE FROM trigger WHERE received_at < ? AND disposition <> 'pending'", cutoff);
  const threads = run(
    `DELETE FROM thread
     WHERE created_at < ?
       AND eval_running = 0
       AND id NOT IN (SELECT thread_id FROM trigger)`,
    cutoff,
  );
  return { decisions, triggers, threads, mandates, sqlTraces };
}

/* ───────────────────── P1.5：真人对话取料 ───────────────────── */
/**
 * 把一轮真人对话记进影子账本。
 *
 * 为什么在服务层做映射、而不是在路由里：会话是**通道**，工单是**执行单元**，
 * 两者的边界必须由服务层定义 —— 路由只该知道「有一条消息发出去了」，
 * 不该知道「它会被翻译成一条 Trigger」。
 *
 * 三个刻意的选择：
 *   addressed=true     在 Agent 会话里打字就是「直接找它」，等价于 mention。
 *                      若设成 false，真人请求会被当成 follow-up，永远进不了 explicit。
 *   threadKey=会话 id  一个会话就是一条线程；同线程的后续判断才有上下文。
 *   idemKey=消息 id    同一条消息重复进入（重试 / 重放 / 幂等重投）只研判一次。
 *
 * 为什么 fire-and-forget 且内部吞异常：影子链路是**旁路观测**。
 * 它挂了、慢了、表不存在了，都不允许影响用户这一轮对话 —— 观测本身不能成为故障源。
 */
export function ingestUserTurn(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  conversationTitle?: string;
  actor: string;
  content: string;
  assetId?: string | null;
}): void {
  try {
    if (!superagentEnabled()) return;
    if (!input.content || input.content.trim() === '') return;
    ingestTrigger({
      workspaceId: input.workspaceId,
      sourceKind: 'user',
      threadKey: input.conversationId,
      threadTitle: input.conversationTitle ?? '会话',
      assetId: input.assetId ?? null,
      actor: input.actor,
      actorKind: 'person',
      addressed: true,
      body: input.content,
      payload: { conversationId: input.conversationId, channel: 'chat' },
      idemKey: `msg:${input.messageId}`,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[ShadowScheduler] 会话取料失败（不影响对话）:', error instanceof Error ? error.message : String(error));
  }
}
