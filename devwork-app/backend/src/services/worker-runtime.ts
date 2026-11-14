/**
 * Worker 运行时 —— 一张工单的一次执行。
 *
 * 三个刻意的边界：
 *   1. **没有 accepted 的 Mandate 不开跑**。授权是执行的前提，不是执行的备注。
 *   2. **工具面按 Mandate 裁剪**。模型看不到范围外的工具，就没法「顺手」用一下；
 *      即使它从历史里猜出工具名，执行器还会再拦一次（两道闸）。
 *   3. **写操作仍然走既有内核**。`makeToolExecutor` 里那套「高风险 → 审批卡、
 *      绝不自动执行」一行没改 —— Mandate 是上限，不是免审批通行证。
 *
 * 单轮执行，不做 while 循环：跑完一轮就出报告，下一轮由新事件触发。
 * 这样「工单停在哪」永远是表里的事实，不是某个 Promise 的状态。
 */
import { all, get, run } from '../db/database';
import { deriveToolFace, type ToolFace } from '../config/tool-catalog';
import { toolAction, toolIsWrite, toolRisk, type ToolRisk } from '../config/tools';
import { LOCAL_IDENTITY_NAME, type Identity } from '../http/core';
import { createGateway, type AgentEvent, type GatewayContext, type ToolExecutionResult } from './llm-gateway';
import { buildHistory, insertCard, makeToolExecutor } from './conversation';
import { runInExecContext } from './exec-context';
import { hasUnreadSince, inboxDigest } from './subscription';
import { prepareWorkdir, isolationTargetsOf } from './workdir';
import {
  askAttention,
  ensureTicketChannel,
  finishAssignment,
  heartbeat,
  recomputeStage,
  ticketTriggerBody,
} from './tickets';

type Row = Record<string, unknown>;

const RISK_RANK: Record<ToolRisk, number> = { low: 0, medium: 1, high: 2 };

interface MandateView {
  status: string;
  scope: {
    level: string;
    assets: string[];
    assetTypes: string[];
    actions: string[];
    riskCeiling: ToolRisk;
    maxWrites: number;
  };
}

function mandateOf(ticket: Row): MandateView | null {
  if (!ticket.mandate_id) return null;
  const row = get<Row>('SELECT * FROM mandate WHERE id = ?', String(ticket.mandate_id));
  if (!row) return null;
  let scope: MandateView['scope'] = {
    level: 'workspace', assets: [], assetTypes: [], actions: [], riskCeiling: 'low', maxWrites: 0,
  };
  try {
    const parsed = JSON.parse(String(row.scope ?? '{}')) as Partial<MandateView['scope']>;
    scope = {
      level: String(parsed.level ?? 'workspace'),
      assets: Array.isArray(parsed.assets) ? parsed.assets.map(String) : [],
      assetTypes: Array.isArray(parsed.assetTypes) ? parsed.assetTypes.map(String) : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions.map(String) : [],
      riskCeiling: parsed.riskCeiling === 'medium' || parsed.riskCeiling === 'high' ? parsed.riskCeiling : 'low',
      maxWrites: Math.max(0, Math.floor(Number(parsed.maxWrites ?? 0) || 0)),
    };
  } catch {
    /* 坏数据按最严处理：没有动作 = 什么都不许。 */
  }
  return { status: String(row.status ?? 'draft'), scope };
}

/** 只保留授权范围内的工具。模型看不到范围外的选项，就不会去想它。 */
function filterFace(face: ToolFace, actions: string[]): ToolFace {
  const allowed = new Set(actions);
  return { ...face, active: face.active.filter((tool) => allowed.has(toolAction(tool.name))) };
}

/**
 * 跑一次派工。调用方 fire-and-forget（不 await），
 * 所以这里必须自己兜住所有异常：失败要落成报告，不能只留一个 rejected promise。
 */
export async function runAssignment(assignmentId: string): Promise<void> {
  const assignment = get<Row>('SELECT * FROM assignment WHERE id = ?', assignmentId);
  if (!assignment || String(assignment.state) !== 'pending') return;

  heartbeat(assignmentId);
  const ticket = get<Row>('SELECT * FROM ticket WHERE id = ?', String(assignment.ticket_id));
  if (!ticket || String(ticket.state) === 'ended') {
    finishAssignment(assignmentId, 'dropped', '工单已结束，本轮不执行');
    return;
  }

  const mandate = mandateOf(ticket);
  if (!mandate) {
    finishAssignment(assignmentId, 'failed', '工单缺少授权（Mandate），拒绝执行');
    return;
  }
  if (mandate.status !== 'accepted') {
    /* 草案态不执行。这是 P2 的安全底线：没人认可的活，机器不动手。 */
    finishAssignment(assignmentId, 'blocked', `授权仍为 ${mandate.status}，需人工认可后才执行`);
    return;
  }

  const workspaceId = String(ticket.workspace_id);
  const conversationId = ensureTicketChannel(String(ticket.id));
  /* 起始任务 + 收件箱：同一线程在开单之后补的话，必须和初始任务一起交给模型。
   * 只给初始任务，模型会不知道「顺便再看下 9 点那个尖峰」这件事存在。 */
  const base = ticketTriggerBody(String(ticket.id));
  const digest = inboxDigest(String(ticket.id));
  const content = digest ? `${base}\n${digest}` : base;
  const assetIds = mandate.scope.assets;

  const fullFace = await deriveToolFace(workspaceId);
  const face = filterFace(fullFace, mandate.scope.actions);
  if (face.active.length === 0) {
    finishAssignment(
      assignmentId, 'failed',
      `授权范围内没有可用工具（actions=${mandate.scope.actions.join(',') || '空'}）。请检查规则的 actions 是否与工具登记表对齐。`,
    );
    return;
  }

  /* 本轮开始的水位：结束时用它判断「跑这一轮期间有没有插进来新消息」。 */
  const roundStart = String(
    get<Row>('SELECT started_at FROM assignment WHERE id = ?', assignmentId)?.started_at ?? new Date().toISOString(),
  );

  const gateway = await createGateway();
  if (gateway.kind === 'mock') {
    /* 没有模型就不假装干活。这条比「跑一遍产出模板文本」诚实得多。 */
    finishAssignment(assignmentId, 'failed', '未接入模型：工单不执行。请在设置里配置模型后重试');
    return;
  }

  /* 允许写的工单必须有自己的工作区。建不出来就停下来 —— 不许降级成共享目录：
   * 两个人抢同一个工作区的后果是静默覆盖，比停下来严重得多。
   *
   * 隔离目标不能只看授权里的 assets：写工具落到哪个资产由派生管线决定
   * （tool-catalog R4），授权没点名不代表写操作不碰它。 */
  const targets = isolationTargetsOf({
    face,
    scopeAssets: assetIds,
    maxWrites: mandate.scope.maxWrites,
  });
  const plan = prepareWorkdir(String(ticket.id), String(ticket.short_name ?? ''), targets);
  if (plan.error) {
    finishAssignment(assignmentId, 'blocked', plan.error);
    return;
  }
  run('UPDATE assignment SET workdir = ? WHERE id = ?', plan.root, assignmentId);

  const identity: Identity = { name: LOCAL_IDENTITY_NAME, org: '', actor: 'user', source: 'user' };
  const baseExecutor = makeToolExecutor({ identityName: identity.name, source: 'agent' }, conversationId, identity, workspaceId, fullFace);

  let writes = 0;
  let blockedByMandate = '';
  const executeTool = async (toolName: string, argsJson: string): Promise<ToolExecutionResult> => {
    const action = toolAction(toolName);
    if (!mandate.scope.actions.includes(action)) {
      blockedByMandate = `模型尝试调用 ${action}，不在本工单授权范围内`;
      return {
        ok: false,
        result: `【超出授权】${action} 不在本工单的 Mandate 内（可用：${mandate.scope.actions.join('、')}）。`
          + '需要更大范围，请把这件事交回 Router 重新开一张工单，不要在本单内扩权。',
      };
    }
    const risk = toolRisk(toolName);
    if (RISK_RANK[risk] > RISK_RANK[mandate.scope.riskCeiling]) {
      blockedByMandate = `模型尝试 ${risk} 风险动作，高于授权上限 ${mandate.scope.riskCeiling}`;
      return { ok: false, result: `【超出授权】风险 ${risk} 高于本工单上限 ${mandate.scope.riskCeiling}。` };
    }
    if (toolIsWrite(toolName) && writes >= mandate.scope.maxWrites) {
      blockedByMandate = `写操作已达授权上限 ${mandate.scope.maxWrites} 次`;
      return { ok: false, result: `【超出授权】本工单写操作上限 ${mandate.scope.maxWrites} 次，已达上限。` };
    }
    const outcome = await baseExecutor(toolName, argsJson);
    if (toolIsWrite(toolName) && outcome.ok) writes += 1;
    return outcome;
  };

  /* 在会话里留一条「凭哪份授权在干」的气泡：事后追责全靠它。 */
  await insertCard(conversationId, 'notice', {
    level: 'info',
    title: '工单执行 · 授权范围',
    content: `level=${mandate.scope.level} · 动作 ${mandate.scope.actions.join('、') || '无'}`
      + ` · 风险≤${mandate.scope.riskCeiling} · 写 ${mandate.scope.maxWrites} 次`,
  }, 'agent');

  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let events = 0;
  let failed = '';

  try {
    const context: GatewayContext = {
      conversationId,
      workspaceId,
      content,
      assetIds,
      readOnlyMode: mandate.scope.maxWrites === 0,
      history: await buildHistory(conversationId, content),
      toolFace: face.active.map((tool) => tool.schema),
      executeTool,
    };
    /* 整个推理循环都跑在这张工单的工作区里：文件工具按 assetId 解析路径时，
     * 会被 exec context 改写到这里，工具本身不需要知道工单存在。 */
    await runInExecContext(
      {
        ticketId: String(ticket.id),
        workdir: plan.root,
        assetRoots: plan.assetRoots,
        /* 本单要求隔离的写目标：解析层据此拒绝回落共享仓库。 */
        isolatedAssets: targets.codeAssets,
        aliasTarget: targets.aliasTarget || undefined,
        workspaceId,
      },
      async () => {
        for await (const event of gateway.generate(context)) {
          events += 1;
          if (events % 8 === 0) heartbeat(assignmentId);
          if (event.type === 'text' || event.type === 'text_delta') text += event.content;
          if (event.type === 'usage') {
            tokensIn += event.promptTokens;
            tokensOut += event.completionTokens;
          }
        }
      },
    );
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
  }

  if (text.trim()) {
    await insertCard(conversationId, 'bubble', { content: text.slice(0, 8000), chips: [], assetIds, attachments: [] }, 'agent');
  }

  if (failed) {
    finishAssignment(assignmentId, 'failed', `执行异常：${failed}`, { tokensIn, tokensOut });
    return;
  }

  if (blockedByMandate) {
    /* 越界不是「问一句要不要放宽」，而是把这件事交回去。
     * 就地扩权会让一张工单慢慢长大，最后没人知道它到底被授权了什么。 */
    const asked = askAttention(String(ticket.id), {
      question: blockedByMandate,
      options: ['把这件事交回 Router 重新授权', '结束本单'],
      impact: '本单不会自行扩大范围；当前已产出内容仍然保留',
    });
    finishAssignment(
      assignmentId, 'blocked',
      asked.budgetExhausted
        ? `${blockedByMandate}（提问预算已用尽，本轮不打扰你）`
        : blockedByMandate,
      { tokensIn, tokensOut },
    );
    return;
  }

  /* 收工前再查一次收件箱：本轮跑的时候线程里可能又插进了新消息。
   * 这时报 waiting 而不是 ready —— 报 ready 就会把工单推到「等人验收」，
   * 而新消息没人读，表现为「我说了它没做」，且不会报任何错。 */
  const late = hasUnreadSince(String(ticket.id), roundStart);
  if (late > 0) {
    finishAssignment(
      assignmentId, 'waiting',
      `${text.slice(0, 340)}（本轮期间又收到 ${late} 条新消息，继续处理）`,
      { tokensIn, tokensOut },
    );
    recomputeStage(String(ticket.id));
    return;
  }

  finishAssignment(
    assignmentId,
    text.trim() ? 'ready' : 'waiting',
    text.trim() ? text.slice(0, 500) : `本轮无输出（${events} 个事件）`,
    { tokensIn, tokensOut },
  );
  recomputeStage(String(ticket.id));
}

/**
 * 派工的启动入口：异步起跑，失败兜底成 failed 报告。
 * 单独抽出来是为了让 tickets.ts 不必 import 运行时（避免循环依赖）。
 */
export function launchAssignment(assignmentId: string): void {
  void runAssignment(assignmentId).catch((error: unknown) => {
    finishAssignment(assignmentId, 'failed', `启动失败：${error instanceof Error ? error.message : String(error)}`);
  });
}

/** 把排队中的派工拉起来。由 tick 每轮调用一次。 */
export function launchPendingAssignments(limit = 2): number {
  const rows = all<Record<string, unknown>>(
    "SELECT id FROM assignment WHERE state = 'pending' ORDER BY started_at ASC LIMIT ?",
    limit,
  );
  rows.forEach((row) => launchAssignment(String(row.id)));
  return rows.length;
}
