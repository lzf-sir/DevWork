/**
 * 工单（Ticket）—— P2 的执行单元。
 *
 * 为什么执行单元不是会话：会话是「人跟 Agent 说话的地方」，一个人可以同时说三件事，
 * 三件事的进度不该挤在一条时间线上。工单是「一件被授权的活」，它可以换执行器、
 * 可以等人、可以重派，而会话不能。
 *
 * 三条硬规则（每条都在防一个具体的失控方式）：
 *   1. **只有 accepted 的 Mandate 才能派工**。草案态一律停在 grant 阶段——
 *      默认不执行，这是整套 P2 的安全底线。
 *   2. **stage 由事实推导，不手工赋值**。报告、注意力、派工、授权状态都是事实，
 *      状态是它们的函数。手工改 stage 一定会跟事实脱节。
 *   3. **一个线程同时只有一张开放工单**。第二条消息 attach 到已有工单，
 *      不新开——否则同一件事会分裂成两张互相不知道对方存在的工单。
 */
import { all, get, newId, nowIso, run, writeAudit } from '../db/database';
import { settingRaw } from '../db/repositories';

type Row = Record<string, unknown>;

export type TicketStage =
  | 'grant'          // 待授权（Mandate 还是草案）
  | 'queued'         // 排到队了，等执行器
  | 'working'        // 执行器在跑
  | 'idle'           // 本轮干完，等新事件
  | 'person/answer'  // 有未回答的提问
  | 'person/review'  // 交付物待验收
  | 'person/blocked' // 受阻
  | 'person/failed'; // 失败

export type AssignmentReport = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';

const LEASE_MS = 90_000;

/* ───────────────────────────── 事实查询 ───────────────────────────── */

function latestAssignment(ticketId: string): Row | undefined {
  return get<Row>(
    'SELECT * FROM assignment WHERE ticket_id = ? ORDER BY started_at DESC, id DESC LIMIT 1',
    ticketId,
  );
}

function openAttention(ticketId: string): Row | undefined {
  return get<Row>('SELECT * FROM attention WHERE ticket_id = ? AND answered_at IS NULL ORDER BY asked_at DESC LIMIT 1', ticketId);
}

/**
 * stage 的唯一来源：从事实推导，不手工写。
 *
 * 顺序即优先级：人必须先被照顾到（待人），然后才是机器状态。
 * 反过来会出现「执行器在跑、但人还在等一个回答」的假象。
 */
/**
 * 上一轮结束之后，本单收到的新事件数。
 *
 * 直接查 trigger 而不走 subscription.ts 的封装，是为了避免
 * tickets ↔ subscription 之间的模块循环（那边要用 recomputeStage）。
 */
function unreadInbox(ticketId: string): number {
  const last = get<Row>(
    "SELECT ended_at FROM assignment WHERE ticket_id = ? AND state = 'ended' ORDER BY started_at DESC LIMIT 1",
    ticketId,
  );
  const since = String(last?.ended_at ?? '');
  return Number(
    get<Row>(
      'SELECT COUNT(*) AS n FROM trigger WHERE delivered_ticket_id = ? AND received_at > ?',
      ticketId, since,
    )?.n ?? 0,
  );
}

export function recomputeStage(ticketId: string): TicketStage {
  const ticket = get<Row>('SELECT * FROM ticket WHERE id = ?', ticketId);
  if (!ticket) return 'queued';
  if (String(ticket.state) === 'ended') return 'idle';

  const attention = openAttention(ticketId);
  const assignment = latestAssignment(ticketId);
  const mandate = ticket.mandate_id ? get<Row>('SELECT * FROM mandate WHERE id = ?', String(ticket.mandate_id)) : undefined;
  const report = String(assignment?.report ?? '');
  const assignmentState = String(assignment?.state ?? '');

  let stage: TicketStage;
  /* 「有新消息」优先于「等人验收」：工单跑完了，但线程里又来了后续，
   * 这时应该接着干，而不是把人叫来看一份已经过时的产出。
   * 不覆盖 person/blocked 和 person/failed —— 那两个是人必须介入的状态，
   * 新消息不该让它们自己溜过去。 */
  const unread = (report === 'ready' || !report) ? unreadInbox(ticketId) : 0;

  if (attention) stage = 'person/answer';
  else if (mandate && String(mandate.status) !== 'accepted') stage = 'grant';
  else if (report === 'ready' && unread > 0) stage = 'queued';
  else if (report === 'ready') stage = 'person/review';
  else if (report === 'blocked') stage = 'person/blocked';
  else if (report === 'failed') stage = 'person/failed';
  else if (assignmentState === 'running') stage = 'working';
  else if (assignmentState === 'pending') stage = 'queued';
  /* 还没有任何派工记录的「已授权」工单是排队，不是 idle。
   * 漏了这一档，新工单会被推导成 idle，而派工只认 queued ——
   * 结果是「授权了但永远不跑」，而且表里看起来一切正常。 */
  else if (!assignment && mandate && String(mandate.status) === 'accepted') stage = 'queued';
  /* idle 的工单被新消息唤醒：这是订阅的意义所在。 */
  else if (unread > 0) stage = 'queued';
  else stage = 'idle';

  run('UPDATE ticket SET stage = ? WHERE id = ?', stage, ticketId);
  return stage;
}

export function ticketShape(row: Row): Row {
  const latest = latestAssignment(String(row.id));
  const attention = openAttention(String(row.id));
  const mandate = row.mandate_id ? get<Row>('SELECT * FROM mandate WHERE id = ?', String(row.mandate_id)) : undefined;
  let matched: string[] = [];
  try {
    const parsed = JSON.parse(String(mandate?.matched_rules ?? '[]')) as unknown;
    if (Array.isArray(parsed)) matched = parsed.map((item) => String(item));
  } catch {
    matched = [];
  }
  let question: Row | null = null;
  if (attention) {
    let options: unknown[] = [];
    try {
      const parsed = JSON.parse(String(attention.options ?? '[]')) as unknown;
      if (Array.isArray(parsed)) options = parsed;
    } catch {
      options = [];
    }
    question = {
      id: String(attention.id),
      question: String(attention.question),
      options,
      impact: String(attention.impact ?? ''),
      askedAt: String(attention.asked_at ?? ''),
    };
  }
  return {
    id: String(row.id ?? ''),
    shortName: String(row.short_name ?? ''),
    workspaceId: String(row.workspace_id ?? ''),
    threadId: String(row.thread_id ?? ''),
    title: String(row.title ?? ''),
    state: String(row.state ?? 'open'),
    stage: String(row.stage ?? 'queued'),
    endedReason: String(row.ended_reason ?? ''),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    mandateId: row.mandate_id ? String(row.mandate_id) : null,
    mandateStatus: mandate ? String(mandate.status) : '',
    matchedRules: matched,
    report: String(latest?.report ?? ''),
    reportNote: String(latest?.report_note ?? ''),
    tokensIn: Number(latest?.tokens_in ?? 0),
    tokensOut: Number(latest?.tokens_out ?? 0),
    createdAt: String(row.created_at ?? ''),
    endedAt: row.ended_at ? String(row.ended_at) : null,
    /** 待人：有的话面板直接给输入框，不再让人翻执行日志。 */
    question,
  };
}

export function listTickets(options: { limit?: number; stage?: string; state?: string } = {}): { items: Row[]; total: number } {
  const limit = Math.min(100, Math.max(1, options.limit ?? 30));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (options.stage) {
    where.push('stage = ?');
    params.push(options.stage);
  }
  if (options.state) {
    where.push('state = ?');
    params.push(options.state);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(get<Row>(`SELECT COUNT(*) AS n FROM ticket ${clause}`, ...params)?.n ?? 0);
  const items = all<Row>(
    `SELECT * FROM ticket ${clause} ORDER BY created_at DESC LIMIT ?`,
    ...params, limit,
  ).map(ticketShape);
  return { items, total };
}

export function ticketStageCounts(): Record<string, number> {
  const rows = all<Row>('SELECT stage, COUNT(*) AS n FROM ticket WHERE state = ? GROUP BY stage', 'open');
  const out: Record<string, number> = {};
  rows.forEach((row) => { out[String(row.stage)] = Number(row.n ?? 0); });
  return out;
}

/* ───────────────────────────── Channel ───────────────────────────── */

function ensureTicketConversation(ticket: Row): string {
  const existing = String(ticket.conversation_id ?? '');
  if (existing) return existing;
  const convId = newId('c');
  const title = `工单 · ${String(ticket.title ?? '').slice(0, 20)}`;
  run(
    'INSERT INTO conversation (id,workspace_id,folder_id,title,sort_order,asset_id,asset_type,archived_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    convId, String(ticket.workspace_id), null, title, 0, null, null, null, nowIso(),
  );
  run('UPDATE ticket SET conversation_id = ? WHERE id = ?', convId, String(ticket.id));
  return convId;
}

/** 工单的 Channel（会话）。Worker 的执行轨迹全部落在这个会话里。 */
export function ensureTicketChannel(ticketId: string): string {
  const ticket = get<Row>('SELECT * FROM ticket WHERE id = ?', ticketId) as Row;
  return ensureTicketConversation(ticket);
}

/** 起始事件正文：Worker 的「这一单要干什么」来自它，不是来自标题。 */
export function ticketTriggerBody(ticketId: string): string {
  const ticket = get<Row>('SELECT * FROM ticket WHERE id = ?', ticketId);
  if (!ticket) return '';
  const body = ticket.trigger_id
    ? String(get<Row>('SELECT body FROM trigger WHERE id = ?', String(ticket.trigger_id))?.body ?? '')
    : '';
  return body.trim() || String(ticket.title ?? '');
}

/* ───────────────────────────── Router ───────────────────────────── */

function shortNameOf(id: string): string {
  return `t-${id.slice(-6)}`;
}

function titleOf(body: string, threadKey: string): string {
  const first = body.replace(/\s+/g, ' ').trim();
  if (first) return first.length > 36 ? `${first.slice(0, 36)}…` : first;
  return threadKey || '未命名工单';
}

/**
 * 把「影子接单」变成真工单。
 *
 * 只在 mandate 已存在（即 would_accept=1 且范围算得出来）时才建——
 * 范围算不出来的事件不会走到这里，这是上游已经守住的边界。
 */
export function routeAcceptedDecisions(limit = 20): { created: number; attached: number } {
  const rows = all<Row>(
    `SELECT d.id AS decision_id, d.thread_id, d.strength, m.id AS mandate_id,
            t.id AS trigger_id, t.body, t.actor,
            th.workspace_id, th.asset_id, th.thread_key
     FROM decision d
     JOIN mandate m ON m.decision_id = d.id
     JOIN trigger t ON t.id = d.trigger_id
     JOIN thread th ON th.id = d.thread_id
     WHERE d.would_accept = 1 AND d.kind = 'ignore'
       AND m.ticket_id IS NULL
       /* 只接受「已认可」的授权才建工单：草案不是授权，不该长出工单。
        * 这一条同时挡住了「每条影子接单都建一张工单」的刷屏。 */
       AND m.status = 'accepted'
     ORDER BY d.created_at ASC LIMIT ?`,
    limit,
  );

  let created = 0;
  let attached = 0;
  rows.forEach((row) => {
    const threadId = String(row.thread_id);
    const open = get<Row>(
      "SELECT * FROM ticket WHERE thread_id = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1",
      threadId,
    );

    if (open) {
      /* 同一线程的第二件事：attach 到已有工单，只加订阅，不新开。
       * 新开会让两张工单各自持有一半上下文，谁都不知道对方。 */
      run(
        'INSERT OR IGNORE INTO subscription (ticket_id,thread_id,kind,created_at) VALUES (?,?,?,?)',
        String(open.id), threadId, 'own', nowIso(),
      );
      run('UPDATE mandate SET ticket_id = ? WHERE id = ?', String(open.id), String(row.mandate_id));
      recomputeStage(String(open.id));
      attached += 1;
      return;
    }

    const id = newId('tkt');
    run(
      `INSERT INTO ticket
        (id,short_name,workspace_id,thread_id,title,state,stage,ended_reason,conversation_id,mandate_id,trigger_id,created_at,ended_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, shortNameOf(id), String(row.workspace_id), threadId,
      titleOf(String(row.body ?? ''), String(row.thread_key ?? '')),
      'open', 'grant', '', null, String(row.mandate_id), String(row.trigger_id), nowIso(), null,
    );
    run('UPDATE mandate SET ticket_id = ? WHERE id = ?', id, String(row.mandate_id));
    run(
      'INSERT OR IGNORE INTO subscription (ticket_id,thread_id,kind,created_at) VALUES (?,?,?,?)',
      id, threadId, 'own', nowIso(),
    );
    ensureTicketConversation(get<Row>('SELECT * FROM ticket WHERE id = ?', id) as Row);
    recomputeStage(id);
    writeAudit({
      /* 工单归属的工作区：审计要能按工作区筛到这条回收记录。 */
      workspaceId: String(row.workspace_id ?? ''),
      actor: '系统', source: 'system',
      action: 'ticket.create', target: `ticket:${id}`,
      result: '成功', severity: 'info',
      detail: `工单已建（stage=grant，等授权）· mandate=${String(row.mandate_id)} · thread=${threadId}`,
    });
    created += 1;
  });

  return { created, attached };
}

/* ───────────────────────────── 派工 ───────────────────────────── */

export function maxConcurrent(): number {
  const raw = Number(settingRaw('superagent').maxConcurrent ?? 1);
  return Number.isFinite(raw) ? Math.min(4, Math.max(1, Math.floor(raw))) : 1;
}

/** 可派工的工单：开放、排队中、授权已认可、且没有在途派工。 */
function readyTickets(limit: number): Row[] {
  return all<Row>(
    `SELECT t.* FROM ticket t
     JOIN mandate m ON m.id = t.mandate_id
     WHERE t.state = 'open' AND t.stage = 'queued' AND m.status = 'accepted'
       AND NOT EXISTS (
         SELECT 1 FROM assignment a
         WHERE a.ticket_id = t.id AND a.state IN ('pending','running')
       )
     ORDER BY t.created_at ASC LIMIT ?`,
    limit,
  );
}

/** 正在跑的派工里，有没有「允许写」的工单。 */
function writeTicketRunning(): boolean {
  const rows = all<Row>(
    `SELECT m.scope AS scope FROM assignment a
     JOIN ticket t ON t.id = a.ticket_id
     JOIN mandate m ON m.id = t.mandate_id
     WHERE a.state IN ('pending','running')`,
  );
  return rows.some((row) => {
    try {
      const parsed = JSON.parse(String(row.scope ?? '{}')) as { maxWrites?: number };
      return Number(parsed.maxWrites ?? 0) > 0;
    } catch {
      /* 读不出范围就当作「可写」——保守一侧才不会撞车。 */
      return true;
    }
  });
}

function isWriteTicket(ticket: Row): boolean {
  const mandate = ticket.mandate_id
    ? get<Row>('SELECT scope FROM mandate WHERE id = ?', String(ticket.mandate_id))
    : undefined;
  try {
    const parsed = JSON.parse(String(mandate?.scope ?? '{}')) as { maxWrites?: number };
    return Number(parsed.maxWrites ?? 0) > 0;
  } catch {
    return true;
  }
}

export function dispatchQueued(): number {
  const running = Number(get<Row>("SELECT COUNT(*) AS n FROM assignment WHERE state IN ('pending','running')")?.n ?? 0);
  const free = maxConcurrent() - running;
  if (free <= 0) return 0;

  /* 写权限工单互斥：同时只允许一张在跑。
   * 工作树已经隔离了代码，但「同时改两个仓库的同一个分支」仍然会打架，
   * 而且合并策略还没设计 —— 在没想清楚之前，串行是唯一诚实的做法。 */
  const writeBusy = writeTicketRunning();
  const tickets = readyTickets(free).filter((ticket) => !writeBusy || !isWriteTicket(ticket));
  tickets.forEach((ticket) => {
    const id = newId('asg');
    const attempts = Number(get<Row>('SELECT COUNT(*) AS n FROM assignment WHERE ticket_id = ?', String(ticket.id))?.n ?? 0) + 1;
    run(
      `INSERT INTO assignment
        (id,ticket_id,worker_session,workdir,state,lease_until,heartbeat_at,report,report_note,tokens_in,tokens_out,attempts,started_at,ended_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, String(ticket.id), `worker-${String(ticket.short_name)}`, '', 'pending', '', '',
      'progress', '', 0, 0, attempts, nowIso(), null,
    );
    recomputeStage(String(ticket.id));
  });
  return tickets.length;
}

export function heartbeat(assignmentId: string): void {
  run(
    'UPDATE assignment SET heartbeat_at = ?, lease_until = ?, state = ? WHERE id = ?',
    nowIso(), new Date(Date.now() + LEASE_MS).toISOString(), 'running', assignmentId,
  );
}

export function finishAssignment(
  assignmentId: string,
  report: AssignmentReport,
  note: string,
  usage: { tokensIn?: number; tokensOut?: number } = {},
): void {
  const assignment = get<Row>('SELECT * FROM assignment WHERE id = ?', assignmentId);
  if (!assignment) return;
  run(
    'UPDATE assignment SET state = ?, report = ?, report_note = ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, ended_at = ?, lease_until = ? WHERE id = ?',
    'ended', report, note.slice(0, 2000), usage.tokensIn ?? 0, usage.tokensOut ?? 0, nowIso(), '', assignmentId,
  );
  recomputeStage(String(assignment.ticket_id));
}

/**
 * 租约回收。
 *
 * 没有它，进程被杀之后工单会永远停在「执行中」，而唯一的补救手段是手工改库。
 * 回收后进 person/failed：让人看见「它断在这了」，而不是假装还在跑。
 */
export function reapExpiredAssignments(now = new Date()): number {
  const expired = all<Row>(
    "SELECT * FROM assignment WHERE state = 'running' AND lease_until <> '' AND lease_until < ?",
    now.toISOString(),
  );
  expired.forEach((row) => {
    finishAssignment(String(row.id), 'failed', '执行器租约过期：进程可能被中断，本轮已回收');
    const owner = get<Row>('SELECT workspace_id FROM ticket WHERE id = ?', String(row.ticket_id));
    writeAudit({
      workspaceId: String(owner?.workspace_id ?? ''),
      actor: '系统', source: 'system',
      action: 'assignment.reap', target: `ticket:${String(row.ticket_id)}`,
      result: '拦截', severity: 'warn',
      detail: `租约过期回收（lease_until=${String(row.lease_until)}）`,
    });
  });
  return expired.length;
}

/* ───────────────────────────── 注意力 ───────────────────────────── */

/**
 * 结构化提问。
 *
 * 预算是硬上限：超了不提问，落 checkpoint 让人下次进来自行决定。
 * 「问不出来就不问」比「问到人麻木」好，因为前者只损失一轮，后者损失信任。
 */
export function askAttention(
  ticketId: string,
  input: { question: string; options?: string[]; impact?: string },
): { id: string | null; budgetExhausted: boolean } {
  const ticket = get<Row>('SELECT * FROM ticket WHERE id = ?', ticketId);
  if (!ticket || String(ticket.state) === 'ended') return { id: null, budgetExhausted: false };
  const mandate = ticket.mandate_id
    ? get<Row>('SELECT * FROM mandate WHERE id = ?', String(ticket.mandate_id))
    : undefined;
  const budget = Math.max(1, Number(mandate?.attention_budget ?? 1));
  const cutoff = new Date(Date.now() - 3600_000).toISOString();
  const asked = Number(
    get<Row>('SELECT COUNT(*) AS n FROM attention WHERE ticket_id = ? AND asked_at >= ?', ticketId, cutoff)?.n ?? 0,
  );
  if (asked >= budget) return { id: null, budgetExhausted: true };

  const id = newId('att');
  run(
    'INSERT INTO attention (id,ticket_id,question,options,impact,blocking,asked_at,answered_at,answer) VALUES (?,?,?,?,?,?,?,?,?)',
    id, ticketId, input.question.slice(0, 500),
    JSON.stringify((input.options ?? []).slice(0, 4)),
    (input.impact ?? '').slice(0, 500), 1, nowIso(), null, null,
  );
  recomputeStage(ticketId);
  writeAudit({
    workspaceId: String(ticket.workspace_id ?? ''),
    actor: '系统', source: 'system',
    action: 'attention.ask', target: `ticket:${ticketId}`,
    result: '待审批', severity: 'info',
    detail: input.question.slice(0, 200),
  });
  return { id, budgetExhausted: false };
}

export function answerAttention(
  ticketId: string,
  attentionId: string,
  answer: string,
): { ok: boolean; message: string } {
  const row = get<Row>('SELECT * FROM attention WHERE id = ? AND ticket_id = ?', attentionId, ticketId);
  if (!row) return { ok: false, message: '提问不存在' };
  if (row.answered_at) return { ok: false, message: '已经回答过了' };
  run('UPDATE attention SET answer = ?, answered_at = ? WHERE id = ?', answer.slice(0, 2000), nowIso(), attentionId);
  run("UPDATE ticket SET stage = 'queued' WHERE id = ? AND state = 'open'", ticketId);
  recomputeStage(ticketId);
  const stage = String(get<Row>('SELECT stage FROM ticket WHERE id = ?', ticketId)?.stage ?? '');
  /* 答完之后要能立刻接着干，而不是等人再点一次「继续」。 */
  if (stage === 'queued') dispatchQueued();
  return { ok: true, message: '已回答，工单已重新排队' };
}

export function stopTicket(ticketId: string, reason = 'stopped_by_person'): boolean {
  const ticket = get<Row>('SELECT * FROM ticket WHERE id = ?', ticketId);
  if (!ticket || String(ticket.state) === 'ended') return false;
  run("UPDATE ticket SET state = 'ended', ended_reason = ?, ended_at = ?, stage = 'idle' WHERE id = ?", reason, nowIso(), ticketId);
  run("UPDATE assignment SET state = 'ended', report = 'dropped', ended_at = ? WHERE ticket_id = ? AND state IN ('pending','running')", nowIso(), ticketId);
  writeAudit({
    workspaceId: String(ticket.workspace_id ?? ''),
    actor: '用户', source: 'user',
    action: 'ticket.stop', target: `ticket:${ticketId}`,
    result: '拦截', severity: 'info', detail: `工单停止：${reason}`,
  });
  return true;
}

/**
 * 重派。
 *
 * 只在「没有在途派工」时允许：否则一次点击会起两个执行器跑同一张工单，
 * 两边的工具调用会互相踩。这是最能体现「状态在表里」的一条约束。
 */
export function retryTicket(ticketId: string): { ok: boolean; message: string } {
  const ticket = get<Row>('SELECT * FROM ticket WHERE id = ?', ticketId);
  if (!ticket) return { ok: false, message: '工单不存在' };
  if (String(ticket.state) === 'ended') return { ok: false, message: '工单已结束，不能重派' };
  const mandate = ticket.mandate_id
    ? get<Row>('SELECT * FROM mandate WHERE id = ?', String(ticket.mandate_id))
    : undefined;
  if (!mandate || String(mandate.status) !== 'accepted') {
    return { ok: false, message: '授权未认可，不能重派' };
  }
  const inFlight = Number(
    get<Row>("SELECT COUNT(*) AS n FROM assignment WHERE ticket_id = ? AND state IN ('pending','running')", ticketId)?.n ?? 0,
  );
  if (inFlight > 0) return { ok: false, message: '已有在执行的一轮，等它结束再重派' };
  run("UPDATE ticket SET stage = 'queued' WHERE id = ?", ticketId);
  dispatchQueued();
  return { ok: true, message: '已重新排队' };
}

/**
 * 工单详情：一张单的全部事实。
 *
 * 为什么不让人去会话里翻工具调用：会话记录的是「模型说了什么、调了什么」，
 * 而人判断一张单「跑得对不对」需要的是另一组事实 —— 第几轮、每轮耗时、
 * 累计花了多少 token、哪次失败过、授权范围是什么、期间收到过什么。
 * 这些散在四张表里，必须在服务端合成一次，否则前端要串四个接口还对不齐时间线。
 *
 * 返回**扁平化**（ticket 的字段在顶层，附加字段在外层），
 * 这样 `GET /tickets/:id` 对旧调用方保持兼容。
 */
export function getTicketDetail(ticketId: string): Row | null {
  const row = get<Row>('SELECT * FROM ticket WHERE id = ?', ticketId);
  if (!row) return null;
  const shape = ticketShape(row);

  const mandateRow = row.mandate_id
    ? get<Row>('SELECT * FROM mandate WHERE id = ?', String(row.mandate_id))
    : undefined;

  let mandate: Row | null = null;
  if (mandateRow) {
    let scope: Row = {};
    let matchedRules: string[] = [];
    try { scope = JSON.parse(String(mandateRow.scope ?? '{}')) as Row; } catch { scope = {}; }
    try {
      const parsed = JSON.parse(String(mandateRow.matched_rules ?? '[]')) as unknown;
      if (Array.isArray(parsed)) matchedRules = parsed.map((item) => String(item));
    } catch { matchedRules = []; }
    mandate = {
      id: String(mandateRow.id ?? ''),
      status: String(mandateRow.status ?? ''),
      strength: String(mandateRow.strength ?? ''),
      policyVersion: String(mandateRow.policy_version ?? ''),
      requester: String(mandateRow.requester ?? ''),
      note: String(mandateRow.note ?? ''),
      reviewedAt: mandateRow.reviewed_at ? String(mandateRow.reviewed_at) : null,
      scope,
      matchedRules,
    };
  }

  const assignmentRows = all<Row>(
    'SELECT * FROM assignment WHERE ticket_id = ? ORDER BY started_at ASC',
    ticketId,
  );
  const assignments = assignmentRows.map((item) => ({
    id: String(item.id ?? ''),
    state: String(item.state ?? ''),
    report: String(item.report ?? ''),
    reportNote: String(item.report_note ?? ''),
    tokensIn: Number(item.tokens_in ?? 0),
    tokensOut: Number(item.tokens_out ?? 0),
    attempts: Number(item.attempts ?? 0),
    workdir: String(item.workdir ?? ''),
    workerSession: String(item.worker_session ?? ''),
    startedAt: String(item.started_at ?? ''),
    endedAt: item.ended_at ? String(item.ended_at) : null,
  }));

  const attentionRows = all<Row>(
    'SELECT * FROM attention WHERE ticket_id = ? ORDER BY asked_at DESC LIMIT 50',
    ticketId,
  );
  const attentions = attentionRows.map((item) => {
    let options: unknown[] = [];
    try {
      const parsed = JSON.parse(String(item.options ?? '[]')) as unknown;
      if (Array.isArray(parsed)) options = parsed;
    } catch { options = []; }
    return {
      id: String(item.id ?? ''),
      question: String(item.question ?? ''),
      options,
      impact: String(item.impact ?? ''),
      blocking: Number(item.blocking ?? 1) === 1,
      askedAt: String(item.asked_at ?? ''),
      answeredAt: item.answered_at ? String(item.answered_at) : null,
      answer: item.answer === null || item.answer === undefined ? null : String(item.answer),
    };
  });

  const own = String(row.trigger_id ?? '');
  const inbox = all<Row>(
    `SELECT id, actor, body, received_at FROM trigger
     WHERE delivered_ticket_id = ? AND id != ?
     ORDER BY received_at DESC LIMIT 20`,
    ticketId, own,
  ).map((item) => ({
    triggerId: String(item.id ?? ''),
    actor: String(item.actor ?? ''),
    body: String(item.body ?? ''),
    receivedAt: String(item.received_at ?? ''),
  }));

  const ended = assignmentRows.filter((item) => String(item.state) === 'ended');
  const firstStart = assignmentRows.length > 0 ? String(assignmentRows[0].started_at ?? '') : '';
  const lastEnd = ended.length > 0 ? String(ended[ended.length - 1].ended_at ?? '') : '';

  return {
    ...shape,
    mandate,
    assignments,
    attentions,
    inbox,
    totals: {
      rounds: assignmentRows.length,
      failedRounds: assignmentRows.filter((item) => String(item.report) === 'failed').length,
      tokensIn: assignmentRows.reduce((sum, item) => sum + Number(item.tokens_in ?? 0), 0),
      tokensOut: assignmentRows.reduce((sum, item) => sum + Number(item.tokens_out ?? 0), 0),
      /** 墙钟时长：从第一次派工到最近一次结束（排队等待也算，那是真实的等待）。 */
      wallMs: firstStart && lastEnd ? Math.max(0, Date.parse(lastEnd) - Date.parse(firstStart)) : 0,
      inboxCount: inbox.length,
    },
  };
}

export function getTicket(ticketId: string): Row | null {
  const row = get<Row>('SELECT * FROM ticket WHERE id = ?', ticketId);
  return row ? ticketShape(row) : null;
}

export function ticketStats(): Row {
  const total = Number(get<Row>('SELECT COUNT(*) AS n FROM ticket')?.n ?? 0);
  const open = Number(get<Row>("SELECT COUNT(*) AS n FROM ticket WHERE state = 'open'")?.n ?? 0);
  const waitingHuman = Number(
    get<Row>("SELECT COUNT(*) AS n FROM ticket WHERE state = 'open' AND stage LIKE 'person/%'")?.n ?? 0,
  );
  const endedByHuman = Number(
    get<Row>("SELECT COUNT(*) AS n FROM ticket WHERE ended_reason = 'stopped_by_person'")?.n ?? 0,
  );
  const assignments = Number(get<Row>('SELECT COUNT(*) AS n FROM assignment')?.n ?? 0);
  const reaped = Number(get<Row>("SELECT COUNT(*) AS n FROM assignment WHERE report = 'failed'")?.n ?? 0);
  const attentionAsked = Number(get<Row>('SELECT COUNT(*) AS n FROM attention')?.n ?? 0);
  const attentionAnswered = Number(get<Row>('SELECT COUNT(*) AS n FROM attention WHERE answered_at IS NOT NULL')?.n ?? 0);
  return {
    total,
    open,
    waitingHuman,
    endedByHuman,
    assignments,
    failedAssignments: reaped,
    attention: { asked: attentionAsked, answered: attentionAnswered },
    /** 打扰密度：每张已结束工单问了几次人。设计目标 ≤1.5。 */
    attentionPerTicket: total > 0 ? Number((attentionAsked / total).toFixed(2)) : 0,
    stages: ticketStageCounts(),
    maxConcurrent: maxConcurrent(),
  };
}

/**
 * 按会话反查工单（一次给齐详情）。
 *
 * 会话侧只记了「模型说了什么、调了什么」；「谁在执行、第几轮、卡在哪」在工单侧。
 * 协作流视图要的是后者，所以按 ticket.conversation_id 反查 ——
 * 不做成让前端串 N 个 GET /tickets/:id：串出来的时间线对不齐，
 * 人也看不出「第 3 轮开始变慢」这种只有并排才看得见的事实。
 */
export function listTicketsByConversation(conversationId: string, limit = 20): Row[] {
  if (!conversationId) return [];
  const capped = Math.min(50, Math.max(1, limit));
  const ids = all<Row>(
    'SELECT id FROM ticket WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?',
    conversationId, capped,
  );
  return ids
    .map((row) => getTicketDetail(String(row.id)))
    .filter((item): item is Row => item !== null);
}

/* 四个待人阶段的人话说法。写在这里而不是散到前端：
 * 「person/answer 是什么意思」只该有一个答案。 */

const WAITING_LABEL: Record<string, string> = {
  'person/answer': '等你回答',
  'person/review': '待你验收',
  'person/blocked': '受阻待决',
  'person/failed': '失败待处理',
};

/**
 * 「谁在等我、等我做什么」—— 待人清单。
 *
 * 口径与 ticketStats().waitingHuman 严格一致（open 且 stage LIKE 'person/%'）。
 * 不把 grant 并进来：待授权是「还没被放行的活」，它属于准入/账本区，
 * 不是「Agent 已经跑到一半停下来了」。两件事混成一个数字，
 * 侧栏就会和智能体面板对不上账，而人一旦发现数字对不上，就再也不信它。
 *
 * 排序即优先级：answer（阻塞，它张着嘴等一句话）→ blocked → failed → review。
 * 同类按创建时间正序：等得最久的排最前，避免「点开一看全在等，不知道先救谁」。
 */
export function waitingTickets(limit = 20): Row[] {
  const capped = Math.min(50, Math.max(1, limit));
  const rows = all<Row>(
    `SELECT t.id, t.short_name, t.title, t.stage, t.conversation_id, t.workspace_id, t.created_at,
            c.title AS conv_title
       FROM ticket t
       LEFT JOIN conversation c ON c.id = t.conversation_id
      WHERE t.state = 'open' AND t.stage LIKE 'person/%'
      ORDER BY CASE t.stage
                 WHEN 'person/answer'  THEN 0
                 WHEN 'person/blocked' THEN 1
                 WHEN 'person/failed'  THEN 2
                 ELSE 3
               END,
               t.created_at ASC
      LIMIT ?`,
    capped,
  );

  return rows.map((row) => {
    const stage = String(row.stage ?? '');
    const attention = openAttention(String(row.id));
    let options: unknown[] = [];
    try {
      const parsed = JSON.parse(String(attention?.options ?? '[]')) as unknown;
      if (Array.isArray(parsed)) options = parsed;
    } catch {
      options = [];
    }
    /* 等人从哪一刻开始算：有未答提问就是提问那一刻；否则退到工单创建。
     * 这两个都能解释成人话（「它 6 分钟前问的」/「这单挂了 2 小时」），
     * 而 stage 变更时间没落库，编不出来也不该编。 */
    const since = String(attention?.asked_at ?? row.created_at ?? '');
    return {
      id: String(row.id ?? ''),
      shortName: String(row.short_name ?? ''),
      title: String(row.title ?? ''),
      stage,
      waitingFor: WAITING_LABEL[stage] ?? '等你处理',
      conversationId: row.conversation_id ? String(row.conversation_id) : null,
      conversationTitle: row.conv_title ? String(row.conv_title) : '',
      workspaceId: String(row.workspace_id ?? ''),
      since,
      question: attention
        ? {
            id: String(attention.id),
            question: String(attention.question ?? ''),
            options,
            impact: String(attention.impact ?? ''),
          }
        : null,
    };
  });
}

