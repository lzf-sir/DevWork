/**
 * Agent 循环 —— 把「研判 → 派单 → 执行 → 回收」串成一条持续运转的链。
 *
 * 为什么单独一个循环，而不是塞进 shadow-scheduler 的 tick：
 *   · 研判是 800ms 级的高频轻活，派工是秒级的重活（起异步执行）
 *   · 两者的失败要互相隔离：派工抛异常不该让研判停摆
 *   · 循环只做「推进状态」，状态本身全在表里 —— 重启即恢复
 */
import { dispatchQueued, reapExpiredAssignments, routeAcceptedDecisions } from './tickets';
import { launchPendingAssignments } from './worker-runtime';
import { superagentEnabled } from './shadow-scheduler';
import { runCollectors } from './shadow-collectors';
import { fanoutPendingTriggers } from './subscription';

const LOOP_MS = 1000;
/** 采集器会碰磁盘 / 起 git 进程，没必要每秒一次：5 秒一次足够，也够省。 */
const COLLECT_EVERY = 5;

let timer: NodeJS.Timeout | null = null;
let busy = false;
let steps = 0;
let lastStepAt = '';
let lastSummary = { created: 0, attached: 0, fanned: 0, dispatched: 0, launched: 0, reaped: 0 };
let lastCollect = { logs: 0, git: 0, terminal: 0, sql: 0 };

async function step(): Promise<void> {
  if (!superagentEnabled()) return;
  if (busy) return;
  busy = true;
  try {
    if (steps % COLLECT_EVERY === 0) {
      const collected = runCollectors();
      if (collected.logs + collected.git + collected.terminal + collected.sql > 0) {
        lastCollect = collected;
      }
    }
    const routed = routeAcceptedDecisions();
    /* 先建单再分流：新事件先有机会建出自己的工单，
     * 剩下没建单的才作为「同线程后续」投给已有工单。 */
    const fanned = await fanoutPendingTriggers();
    const dispatched = dispatchQueued();
    const launched = launchPendingAssignments();
    const reaped = reapExpiredAssignments();
    steps += 1;
    lastStepAt = new Date().toISOString();
    lastSummary = { ...routed, fanned: fanned.delivered, dispatched, launched, reaped };
  } catch (error) {
    /* 单轮失败不影响下一轮：所有推进都是幂等的（状态在表里）。 */
    // eslint-disable-next-line no-console
    console.error('[AgentLoop] 步进失败:', error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
  }
}

export function startAgentLoop(): { started: boolean; reason: string } {
  if (!superagentEnabled()) return { started: false, reason: '影子链路关闭，Agent 循环不启动' };
  if (timer) return { started: true, reason: '已在运行' };
  timer = setInterval(() => { void step(); }, LOOP_MS);
  timer.unref();
  void step();
  return { started: true, reason: `已启动（${LOOP_MS}ms）` };
}

export function stopAgentLoop(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function agentLoopStatus(): Record<string, unknown> {
  return { running: timer !== null, intervalMs: LOOP_MS, steps, lastStepAt, last: lastSummary, collect: lastCollect };
}

/** 测试 / 面板用：手动推一轮。 */
export async function agentLoopStep(): Promise<Record<string, unknown>> {
  await step();
  return agentLoopStatus();
}
