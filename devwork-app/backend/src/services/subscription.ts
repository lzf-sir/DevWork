/**
 * 订阅扇出 —— 让「一张工单」跟踪一个线程，而不只是干完一件就走。
 *
 * 为什么需要这一层：
 *   工单的起始任务是「线程里的第一件事」。但线程是活的：同一个会话里
 *   人还会继续补一句「顺便看下 9 点那个尖峰」。没有扇出，这句话只会
 *   在 Gate 里被单独研判、单独建一张工单，两张工单各自握着一半上下文，
 *   谁都不知道对方存在。
 *
 * 三条约束（都来自踩过的坑）：
 *   1. **送上下文，不送权限**。扇出只把事件投进工单的收件箱，
 *      能不能动手仍由那张工单的 Mandate 决定 —— 新消息不能给它扩权。
 *   2. **一条事件只投一次**。`fanout_at` 是处理位点；没有它，
 *      「没有工单可投」的事件会被每轮重新扫出来。
 *   3. **投递要能唤醒**。投完不改 stage，唤醒交给 `recomputeStage` 推导：
 *      正在跑的工单读完本轮会自己看到 inbox，结束前还有新消息就不收工。
 */
import { all, get, run } from '../db/database';
import { insertCard } from './conversation';

type Row = Record<string, unknown>;

export interface InboxEntry {
  triggerId: string;
  actor: string;
  body: string;
  receivedAt: string;
}

/**
 * 工单的收件箱：订阅线程里、投给这张工单、且不是它自己起始任务的那些事件。
 *
 * 排除起始 trigger 是必须的：起始任务已经作为 `content` 传给模型了，
 * 再进收件箱就会重复一遍，模型会以为人把同一句话说了两次。
 */
export function ticketInbox(ticketId: string, limit = 6): InboxEntry[] {
  const ticket = get<Row>('SELECT trigger_id FROM ticket WHERE id = ?', ticketId);
  const own = String(ticket?.trigger_id ?? '');
  const rows = all<Row>(
    `SELECT id, actor, body, received_at FROM trigger
     WHERE delivered_ticket_id = ? AND id != ?
     ORDER BY received_at DESC LIMIT ?`,
    ticketId, own, limit,
  );
  return rows.reverse().map((row) => ({
    triggerId: String(row.id ?? ''),
    actor: String(row.actor ?? ''),
    body: String(row.body ?? ''),
    receivedAt: String(row.received_at ?? ''),
  }));
}

/** 把收件箱拼成一段可读的上下文。空收件箱返回空串（不占 token）。 */
export function inboxDigest(ticketId: string): string {
  const items = ticketInbox(ticketId);
  if (items.length === 0) return '';
  const lines = items.map((item) => `- [${item.receivedAt.slice(11, 16)}] ${item.actor}：${item.body.slice(0, 400)}`);
  return [
    '',
    '以下是这件事开始之后，同一线程里新到的消息（按时间顺序）。',
    '它们属于同一件事的后续，请一并处理；如果其中某条超出了你被授权的范围，',
    '不要自行扩大范围，直接说明越界即可。',
    ...lines,
  ].join('\n');
}

/**
 * 结束前的收工检查：本轮开始之后还有没有新投递。
 *
 * 为什么必须在结束前查一次：Worker 读完上下文就不再读了。
 * 一轮跑完就收工，期间到的消息全漏 —— 而漏掉的消息不会报错，
 * 只会表现为「我明明跟它说了，它没做」。
 */
export function hasUnreadSince(ticketId: string, sinceIso: string): number {
  const row = get<Row>(
    `SELECT COUNT(*) AS n FROM trigger
     WHERE delivered_ticket_id = ? AND received_at > ?`,
    ticketId, sinceIso,
  );
  return Number(row?.n ?? 0);
}

/**
 * 分发所有「已研判但还没扇出」的事件。
 *
 * 一轮扫一批，处理完就打位点 —— 位点先于副作用写入是可以接受的，
 * 因为最坏结果只是「这条消息没被投给工单」，而不是「投了两次」。
 * 重复投递会让工单重复干活，比漏投更难查。
 */
export async function fanoutPendingTriggers(limit = 30): Promise<{
  delivered: number;
  skipped: number;
  woken: number;
}> {
  /* 只扇出「Gate 判了要接」的事件。
   * 这一条是安全底线：被 ignore 的事件（源未启用 / 机器人不在白名单 / 空事件）
   * 如果也投给已有工单，就等于给它们开了一条绕过准入的侧门 ——
   * 门在正面锁着，货从后面进去了。 */
  const rows = all<Row>(
    `SELECT t.id, t.thread_id, t.actor, t.body, t.received_at, d.would_accept
     FROM trigger t JOIN decision d ON d.id = t.decision_id
     WHERE t.fanout_at IS NULL AND t.decision_id IS NOT NULL
     ORDER BY t.received_at ASC LIMIT ?`,
    limit,
  );

  let delivered = 0;
  let skipped = 0;
  let woken = 0;

  for (const row of rows) {
    const triggerId = String(row.id);
    const threadId = String(row.thread_id);

    if (Number(row.would_accept ?? 0) !== 1) {
      /* 不该接的事件也要打位点，否则每轮都会被重新扫出来。 */
      run('UPDATE trigger SET fanout_at = ? WHERE id = ?', new Date().toISOString(), triggerId);
      skipped += 1;
      continue;
    }

    /* 自己建的那张工单：这条事件就是它的任务本身，不需要再投一次。 */
    const own = get<Row>('SELECT id FROM ticket WHERE trigger_id = ?', triggerId);
    if (own) {
      run('UPDATE trigger SET fanout_at = ?, delivered_ticket_id = ? WHERE id = ?',
        new Date().toISOString(), String(own.id), triggerId);
      skipped += 1;
      continue;
    }

    /* 订阅了这个线程、且还活着的工单。多张时投最新那张：
     * 同线程多张工单本身是 attach 应该避免的状态，取最新的至少语义确定。 */
    const subscribers = all<Row>(
      `SELECT k.id, k.stage, k.state FROM subscription s
       JOIN ticket k ON k.id = s.ticket_id
       WHERE s.thread_id = ? AND k.state = 'open'
       ORDER BY k.created_at DESC`,
      threadId,
    );

    if (subscribers.length === 0) {
      /* 没人订阅：可能是「这单没被接」，也可能是工单已结束。
       * 都要打位点，否则每轮都会重新扫到它。 */
      run('UPDATE trigger SET fanout_at = ? WHERE id = ?', new Date().toISOString(), triggerId);
      skipped += 1;
      continue;
    }

    const target = subscribers[0];
    const ticketId = String(target.id);

    run('UPDATE trigger SET fanout_at = ?, delivered_ticket_id = ? WHERE id = ?',
      new Date().toISOString(), ticketId, triggerId);

    /* 在执行轨迹里留一条可见记录：人打开工单会话，应该能看出
     * 「这条消息是在跑到一半时插进来的」，而不是只看到一堆工具调用。 */
    const conversation = get<Row>('SELECT conversation_id FROM ticket WHERE id = ?', ticketId);
    if (conversation?.conversation_id) {
      await insertCard(String(conversation.conversation_id), 'notice', {
        level: 'info',
        title: '收到同线程新消息',
        content: `${String(row.actor ?? '')}：${String(row.body ?? '').slice(0, 400)}`,
      }, 'system');
    }

    /* 等待中的工单被新消息唤醒。person/* 不唤醒 —— 那些状态在等人，
     * 人还没表态就自己接着干，等于绕过审批。 */
    if (String(target.stage) === 'idle') woken += 1;
    delivered += 1;
  }

  return { delivered, skipped, woken };
}

/** 测试用：清空位点，让同一批事件重新可扇出。 */
export function resetFanout(threadId?: string): number {
  return threadId
    ? run('UPDATE trigger SET fanout_at = NULL, delivered_ticket_id = NULL WHERE thread_id = ?', threadId)
    : run('UPDATE trigger SET fanout_at = NULL, delivered_ticket_id = NULL');
}

/** 收件箱统计：面板用（多少条事件被投进了工单）。 */
export function fanoutStats(): { delivered: number; pending: number } {
  return {
    delivered: Number(get<Row>('SELECT COUNT(*) AS n FROM trigger WHERE delivered_ticket_id IS NOT NULL')?.n ?? 0),
    pending: Number(get<Row>('SELECT COUNT(*) AS n FROM trigger WHERE fanout_at IS NULL AND decision_id IS NOT NULL')?.n ?? 0),
  };
}
