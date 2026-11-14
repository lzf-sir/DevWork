/**
 * ConversationService —— 会话编排（V8）。
 * 一次提问产出完整结构化轨迹并全部落库（消息 / 工具调用 / 引用 / 产物 / 面板 / 用量）。
 *
 * 本轮修订的三条硬规则：
 * 1. 工具卡的 status 必须由「权限裁决 + 真实执行结果」推导，不能写死「已自动放行」；
 * 2. 凭据校验必须落在工具真正访问的资产上（kb_search 不该被数据库凭据挡死）；
 * 3. 权限裁决必须带真实 identity 与真实资产，不能恒传 admin + 生产库。
 */
import fs from 'node:fs';
import { ApiFailure, type Identity } from '../http/core';
import { all, get, newId, nowIso, run, tx, writeAudit } from '../db/database';
import { resolveWorkspaceIdForAsset } from './workspace-repos';
import { artifactPath } from '../sandbox/bootstrap';
import {
  allPanels,
  citationShape,
  listArtifacts,
  listCitations,
  listMessageCards,
  readOnlyMode,
  statusBarShape,
} from '../db/repositories';
import { check, type PermissionContext } from '../kernel/permission';
import { TOOL_REGISTRY, toolAction, toolIsWrite, toolRisk, toolSpec } from '../config/tools';
import { deriveToolFace, gatewayToolFace, derivedTool, type DerivedTool, type ToolFace } from '../config/tool-catalog';
import { executeAgentTool } from './agent-tools';
import { executeFileWrite, executeDbWrite, executeSrvTemplate, rollbackWritePlan } from './write-executor';
import {
  breakerTripped, breakerStatus, recordWriteDeny, recordWriteSuccess,
} from './session-approvals';
import { requireCredential } from './credential';
import { createGateway, detectIntent, type AgentEvent, type GatewayContext } from './llm-gateway';
import { ingestUserTurn } from './shadow-scheduler';
import {
  buildBudgetedHistory, compactConversation, estimateTokens, measureContext, resolveContextWindow,
} from './context-budget';
import { readTodoCard, readTodoPlan, todoPromptOf, writeTodoPlan } from './todo';

type Row = Record<string, unknown>;

export interface TurnResult {
  conversationId: string;
  intent: string;
  gateway: 'mock' | 'openai-compatible';
  messages: Record<string, unknown>[];
  citations: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  panels: Record<string, unknown>;
  statusBar: Record<string, unknown>;
  auditIds: string[];
}

interface InsertedCard {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export async function insertCard(
  conversationId: string,
  kind: string,
  payload: Record<string, unknown>,
  actor = 'agent',
): Promise<InsertedCard> {
  const id = newId('m');
  run(
    'INSERT INTO message (id,conversation_id,kind,payload,actor,created_at) VALUES (?,?,?,?,?,?)',
    id, conversationId, kind, JSON.stringify(payload), actor, nowIso(),
  );
  return { id, kind, payload };
}

function cardShape(card: InsertedCard, conversationId: string): Record<string, unknown> {
  return {
    id: card.id,
    conversationId,
    kind: card.kind,
    role: card.kind === 'bubble' ? 'user' : 'assistant',
    content: typeof card.payload.content === 'string' ? card.payload.content : undefined,
    payload: card.payload,
    actor: card.kind === 'bubble' ? 'user' : 'agent',
    createdAt: nowIso(),
  };
}

/** 工具的资产归属 / 动作名 / 风险等级统一来自 config/tools.ts：
 *  两份表各写一遍就会漂移，而漂移的后果是模型挑一个写工具就能绕过审批。 */

/** 写意图的 targetType（会话级审批记忆键的一部分，不含具体参数——设计 §6.4）。 */
function targetTypeOf(toolName: string, args: Record<string, unknown>): string {
  if (/srv_exec/.test(toolName)) {
    const action = String(args.action ?? '');
    return action ? `intent:${action}` : 'intent:unknown';
  }
  if (/db|sql/i.test(toolName)) return 'db';
  if (/srv|service/i.test(toolName)) return 'service';
  return 'code-file';
}

/**
 * 写操作真正落到的资产。
 *
 * workspace 型写工具（fs_write_file）派生出来的资产是**工作区本身**，
 * 而工作区没有自己的仓库 —— 直接拿它去解析路径会一路回落到共享演示仓库，
 * 等于往公共目录里写代码。静态登记表里 fs_write_file 归属的本来就是代码资产，
 * 这里把派生面的 workspace 绑定归位到代码主实例：
 *  - 工单执行期内，解析层会把它改写成本单的工作树（exec-context 别名）；
 *  - 会话内直接审批时，它落到工作区自己克隆的仓库，而不是沙箱演示仓库。
 */
function writeTargetAssetId(toolName: string, tool: DerivedTool | undefined, face: ToolFace): string {
  if (tool && tool.entry.assetType !== 'workspace') return tool.assetId;
  const codeTool = face.all.find((item) => item.entry.assetType === 'code' && item.entry.writeAction);
  if (codeTool) return codeTool.assetId;
  return tool?.assetId ?? toolSpec(toolName).assetId;
}

/**
 * 写计划的统一执行入口（三层防线）。只对 V2 可执行工具真执行；
 * 演示轨迹遗留名（fs_truncate_log 等）没有可执行内容，如实返回不假装。 */
async function executeWritePlan(
  toolName: string,
  args: Record<string, unknown>,
  face: ToolFace,
  identity: Identity,
  workspaceId: string,
  conversationId = '',
): Promise<{ ok: boolean; message: string; rollbackRef?: string; diskChanged: boolean }> {
  const tool = derivedTool(face, toolName);
  const assetId = writeTargetAssetId(toolName, tool, face);
  /* 归属三级：① 资源实际归属 → ② 调用方给的会话归属 → ③ 空串。
   * 跨工作区会话（conversation.workspace_id ≠ asset.workspace_id）是 1.0 的合法状态，
   * 这类审计必须以**资源实际归属**为准，否则「这条写动的是哪个工作区的文件」说不清。
   * 任何情况都不回落默认工作区：不认识就记空串，detail 里标 workspace:unknown。 */
  const ownerWorkspaceId = resolveWorkspaceIdForAsset(assetId) ?? workspaceId;
  switch (toolName) {
    case 'code_edit':
    case 'fs_write_file':
      /* conversationId 决定快照落点（DATA_DIR/snapshots/<会话>/），不再写进用户仓库。 */
      return executeFileWrite(assetId, String(args.path ?? ''), String(args.content ?? ''), identity, ownerWorkspaceId, conversationId);
    case 'db_query_write':
      return executeDbWrite(String(args.sql ?? ''), identity, ownerWorkspaceId);
    case 'srv_exec': {
      let params: Record<string, unknown> = {};
      if (typeof args.params === 'string') {
        try { params = JSON.parse(args.params) as Record<string, unknown>; } catch { params = {}; }
      } else if (args.params && typeof args.params === 'object') {
        params = args.params as Record<string, unknown>;
      }
      return executeSrvTemplate(assetId, String(args.action ?? ''), params, identity, ownerWorkspaceId);
    }
    default:
      return { ok: false, message: `工具 ${toolName} 属于演示轨迹遗留名，无可执行内容（不假装执行）`, diskChanged: false };
  }
}

/** 工具调用的只读 Service 内部二次过核（双保险）。 */
async function serviceCheck(
  ctx: PermissionContext,
  req: { action: string; assetId: string; workspaceId: string; conversationId: string },
): Promise<string> {
  const verdict = await check({
    actor: 'agent', action: req.action, risk: 'low', workspaceId: req.workspaceId,
    assetId: req.assetId, payload: { conversationId: req.conversationId },
  }, ctx);
  if (verdict.effect !== 'allow') {
    throw new ApiFailure('E_PERMISSION_DENIED', `只读 Service 二次裁决拒绝：${verdict.reason}`);
  }
  return verdict.auditId;
}

/** 从库里还原多轮上下文（按上下文预算裁剪，压缩后从摘要卡之后算起）。
 *  与上一版的差别：被预算截掉的旧消息现在有去处 —— 摘要卡替它们进提示，
 *  而不是静默消失让模型以为自己什么都没看过。 */
export async function buildHistory(conversationId: string, excludeContent: string): Promise<GatewayContext['history']> {
  return buildBudgetedHistory(conversationId, excludeContent).history;
}

/** 引用片段摘要：前 5 行足够浮层展示，且原文可点开核对。 */
function snippetOf(content: string): string {
  return content.split('\n').slice(0, 5).join('\n');
}

/** 派生工具面 + 权限内核 + 会话审批记忆的真实执行器。
 *  返回结构里的 ok 是"执行是否成功"的唯一事实来源，工具卡状态由它推导。 */
export function makeToolExecutor(
  ctx: PermissionContext,
  conversationId: string,
  identity: Identity,
  workspaceId: string,
  face: ToolFace,
): NonNullable<GatewayContext['executeTool']> {
  return async (toolName: string, argsJson: string) => {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(argsJson) as Record<string, unknown>; } catch { /* 保持空对象 */ }

    const isWrite = toolIsWrite(toolName);

    /* ---- 写工具：表达意图，不在此执行（除非会话级审批记忆命中）---- */
    if (isWrite) {
      if (breakerTripped(conversationId)) {
        const status = breakerStatus(conversationId);
        return {
          ok: false,
          result: `本轮任务已熔断：连续 ${status.threshold} 次写操作被拒/转建议，停止重试（防变相越权）。`
            + '降级路径：产出建议卡说明意图与被拒原因，由用户手动执行。',
        };
      }
      /* 1.0 不做会话级免审：这里不再查询「本会话内允许」记忆，
       * 写意图一律走「生成审批卡 → 人逐次批准」这一条路
       * （记忆键不含参数，批准一次就等于免审写任意文件，口径无法自洽）。 */
      return {
        ok: false,
        result: '写操作未执行：待人工审批（审批卡已生成；批准后按 precheck → 执行 → 校验 → 回滚就绪 管线运行）',
      };
    }

    /* ---- 只读工具：静态表兜底 + 派生面绑定 ---- */
    const known = !!TOOL_REGISTRY[toolName] || !!derivedTool(face, toolName);
    if (!known) {
      return {
        ok: false,
        result: `未知工具：${toolName}（派生工具面：${face.active.map((t) => t.name).join(' / ') || '空'}）`,
      };
    }

    try {
      const derived = derivedTool(face, toolName);
      const staticSpec = toolSpec(toolName);
      const assetId = derived?.assetId ?? staticSpec.assetId;
      const auditId = await serviceCheck(ctx, {
        action: derived?.entry.action ?? staticSpec.action, assetId,
        workspaceId, conversationId,
      });
      /* 凭据检查：静态表与派生目录任一声明 needsCredential 都要过（能力与凭据不漂移）。 */
      const needsCredential = derived?.entry.needsCredential ?? staticSpec.needsCredential;
      if (needsCredential) await requireCredential(assetId, identity);

      /* 派生工具统一走 agent-tools；遗留名（pg_sql_query/kb_search/code_search）映射到同名实现。 */
      const outcome = await executeAgentTool(toolName, args, derived, {
        assetId, workspaceId, conversationId, identity,
      });
      if (outcome.ok) {
        return {
          ok: true,
          result: `${outcome.result} · auditId=${auditId}`,
          citations: outcome.citations,
        };
      }
      return outcome;
    } catch (error) {
      if (error instanceof ApiFailure) {
        if (error.code === 'E_CREDENTIAL_REQUIRED') return { ok: false, result: error.message };
        return { ok: false, result: `工具被拦截（${error.code}）：${error.message}` };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, result: `工具执行失败（未产生任何写操作）：${message}` };
    }
  };
}

/** 工具卡状态：裁决结果 + 执行结果共同决定，不允许再出现"失败了还写已放行"。 */
function toolStatusOf(effect: string, ok: boolean): { status: string; cls: 'ok' | 'warn' | 'deny' | 'suggest' } {
  if (effect === 'deny') return { status: '已拦截', cls: 'deny' };
  if (effect === 'suggest') return { status: '转建议', cls: 'suggest' };
  if (effect === 'ask') return { status: '待审批', cls: 'warn' };
  return ok ? { status: '已自动放行', cls: 'ok' } : { status: '失败', cls: 'warn' };
}

/** 上下文实际占用由 context-budget 统一口径计算（含摘要卡与预算裁剪），
 *  这里不再单独维护一份"全表字符数"的近似值 —— 两份口径必然漂移。 */

/** 一次提问 → 完整轨迹。onEvent 非空时逐事件回调（供 SSE 流式端点使用）。 */
export async function sendMessage(
  conversationId: string,
  input: { content: string; assetIds?: string[]; attachments?: string[]; model?: string; regenerate?: boolean },
  identity: Identity,
  onEvent?: (event: AgentEvent) => void,
): Promise<TurnResult> {
  const conversation = get<{ id: string; workspace_id: string; title: string; asset_id: string | null }>(
    'SELECT id, workspace_id, title, asset_id FROM conversation WHERE id = ?',
    conversationId,
  );
  if (!conversation) throw new ApiFailure('E_NOT_FOUND', `会话不存在：${conversationId}`);
  if (!input.content || input.content.trim() === '') {
    throw new ApiFailure('E_VALIDATION', 'content 必须是非空字符串');
  }

  /* 会话级模型覆盖：只影响本次调用。 */
  const gateway = await createGateway(input.model);
  const intent = detectIntent(input.content);
  const readOnly = await readOnlyMode();
  /* 派生管线（设计 §1/§3）：工具面从本工作区资产×能力×信任级别计算，不是写死清单。 */
  const face = await deriveToolFace(conversation.workspace_id);
  /* Agent 以"用户代理"身份行動：身份来自本地固定值，不存在角色差异。 */
  const ctx: PermissionContext = { identityName: identity.name, source: 'agent' };
  const cards: InsertedCard[] = [];
  const auditIds: string[] = [];
  /** 本次挂起待审批的写操作，最后的执行面板快照要用它标黄。 */
  const pendingApprovals: Record<string, unknown>[] = [];
  /** 模型返回的真实用量（provider）优先于本地估算（estimate）。 */
  let providerUsage: { promptTokens: number; completionTokens: number; model: string } | null = null;
  let conclusionIds: string[] = [];

  const attachments = Array.isArray(input.attachments) ? input.attachments.map(String).filter(Boolean) : [];
  /* 气泡上的 @ 引用 chip 必须来自用户真实挂载的资产：
   * 之前写死「生产库 / 运营知识库」，用户没挂也会显示——那是假的引用。
   * 资产绑定会话（从代码库 / 数据 / 终端页唤起）默认挂载绑定资产：
   * 绑定是服务端事实，不依赖前端每次都记得带上。 */
  const requestedAssetIds = Array.isArray(input.assetIds) ? input.assetIds.map(String).filter(Boolean) : [];
  const boundAssetId = conversation.asset_id ? String(conversation.asset_id) : '';
  const assetIds = [...new Set([...(boundAssetId ? [boundAssetId] : []), ...requestedAssetIds])];
  const chipNames: string[] = [];
  for (const assetId of assetIds) {
    const asset = get<Row>('SELECT name FROM asset WHERE id = ?', assetId);
    chipNames.push(asset ? String(asset.name) : assetId);
  }
  /* regenerate（重试）：沿用已有用户气泡，不再插一条同样的气泡；
   * 本函数其余链路（上下文 / 工具 / 裁决 / 落库）与普通发送完全一致。 */
  if (!input.regenerate) {
    const userCard = await insertCard(conversationId, 'bubble', {
      content: input.content,
      chips: [...chipNames, ...attachments.map((name) => `📎 ${name}`)],
      assetIds,
      attachments,
    }, 'user');
    cards.push(userCard);
    /* P1.5 影子链路取料：把这一轮的话记成一条 Trigger，供 Gate 研判。
     * 旁路观测 —— 不 await、内部吞异常，挂了也不影响本轮生成。
     * regenerate 不取料：重试沿用的是同一条用户消息，重复取料会污染分母。 */
    ingestUserTurn({
      workspaceId: conversation.workspace_id,
      conversationId,
      messageId: userCard.id,
      conversationTitle: conversation.title,
      actor: identity.name,
      content: input.content,
      assetId: conversation.asset_id,
    });
  }

  /* 工具面只算一次：网关拿它当 toolsSpec，预算拿它估固定开销，两处必须同一份。 */
  const toolFace = gatewayToolFace(face);

  /* ---- 自动压缩：上下文逼近上限时先提炼再继续 ----
   * 放在生成之前，而不是等供应商报超限：真撞上限时模型的失败信息通常只是
   * "context length exceeded"，用户看到的是一次莫名其妙的失败。 */
  const preEvents: AgentEvent[] = [];
  const windowInfo = resolveContextWindow(gateway.modelName);
  const usageBefore = measureContext(conversationId, { model: gateway.modelName, toolCount: toolFace.length });
  if (usageBefore.shouldCompact) {
    const compacted = await compactConversation({
      conversationId, mode: 'auto', model: gateway.modelName, gateway,
    });
    if (!compacted.skipped && compacted.card) {
      cards.push({ id: compacted.cardId ?? compacted.card.id, kind: 'summary', payload: compacted.card.payload });
      preEvents.push({
        type: 'notice',
        level: 'info',
        title: '已自动压缩上下文',
        content: [
          `上下文占用达到 ${Math.round((usageBefore.ratio * 100))}%（${Math.round(usageBefore.used / 1000)}k / ${Math.round(windowInfo.window / 1000)}k），`
            + `已将早前 ${compacted.covered} 条对话折叠为一段摘要，继续本轮任务。`,
          `摘要由${compacted.summary?.source === 'model' ? `模型（${compacted.summary.model}）提炼` : '规则提炼（未接入模型）'}，`
            + `约 ${compacted.before} → ${compacted.after} tokens。原始消息仍保留在时间线里，只是不再整段发给模型。`,
        ].join('\n'),
      });
    }
  }
  for (const event of preEvents) onEvent?.(event);

  const events: AgentEvent[] = [];
  /** 本轮真实产生的引用 id —— 右栏「上下文 · 命中」只列本轮证据，不再展示静态快照。 */
  const turnCitationIds: string[] = [];
  for await (const event of gateway.generate({
    conversationId,
    workspaceId: conversation.workspace_id,
    content: input.content,
    assetIds,
    readOnlyMode: readOnly,
    history: await buildHistory(conversationId, input.content),
    toolFace,
    /* 清单进系统提示：长任务里模型最容易丢的就是"我排到第几步了"。 */
    todoText: todoPromptOf(readTodoPlan(conversationId)),
    executeTool: makeToolExecutor(ctx, conversationId, identity, conversation.workspace_id, face),
  })) {
    events.push(event);
    onEvent?.(event);
  }
  /* 压缩说明要排在回复前面（它是"本轮开始前发生的事"），
   * 而不是流结束后补一条解释。 */
  events.unshift(...preEvents);

  /* B16：text_delta 缓冲 —— 流式增量聚合成一张 text 卡落库（可回放）。 */
  let textBuffer = '';
  const flushText = async (): Promise<void> => {
    if (!textBuffer.trim()) return;
    cards.push(await insertCard(conversationId, 'text', { content: textBuffer }));
    textBuffer = '';
  };

  for (const event of events) {
    if (event.type === 'text_delta') {
      textBuffer += event.content;
      continue;
    }
    await flushText();
    switch (event.type) {
      case 'routing': {
        auditIds.push(`route-${event.intent}`);
        break;
      }
      case 'plan': {
        cards.push(await insertCard(conversationId, 'plan', {
          intent: event.intent, steps: event.steps, degraded: event.degraded === true,
        }));
        break;
      }
      case 'todo': {
        /* 同一条会话只留一张清单卡（原位更新）—— 10 步任务不该产生 10 张卡。 */
        try {
          const { card } = writeTodoPlan(conversationId, event.items, { degraded: event.degraded === true });
          cards.push({ id: card.id, kind: card.kind, payload: card.payload });
        } catch (error) {
          cards.push(await insertCard(conversationId, 'notice', {
            level: 'warn',
            title: '任务清单未能建立',
            content: error instanceof Error ? error.message : String(error),
          }));
        }
        break;
      }
      case 'text': {
        cards.push(await insertCard(conversationId, 'text', { content: event.content }));
        break;
      }
      case 'notice': {
        cards.push(await insertCard(conversationId, 'notice', {
          level: event.level, title: event.title, content: event.content,
        }));
        break;
      }
      case 'usage': {
        /* 模型真实回传的 token 数：直接落变量，最后统一写 usage_stat。 */
        providerUsage = {
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
          model: event.model,
        };
        break;
      }
      case 'tool_call': {
        /* 写/只读与风险等级一律以登记表为准，不再相信事件里自报的 write 字段：
         * 网关的直连模型分支曾经把 risk 写死成 low，等于让模型自己给自己降级。 */
        const spec = toolSpec(event.toolName);
        const isWrite = toolIsWrite(event.toolName);
        const action = toolAction(event.toolName);
        const assetId = spec.assetId;
        const risk = spec.risk;

        let parsedArgs: Record<string, unknown> = {};
        try { parsedArgs = JSON.parse(event.args) as Record<string, unknown>; } catch { /* 非 JSON 参数不阻断裁决 */ }
        const targetPath = typeof parsedArgs.path === 'string' ? parsedArgs.path : undefined;

        /* 1.0 不做会话级审批记忆：写工具一律由内核按 ask 裁决，逐次生成审批卡。
         * 会话免审的记忆键不含参数（设计 §6.4），对「写任意文件」这类动作等于长期免审。 */
        const kernelVerdict = await check({
          actor: 'agent', action, risk,
          workspaceId: conversation.workspace_id,
          assetId,
          path: targetPath,
          payload: { toolName: event.toolName },
        }, ctx);
        const verdict = kernelVerdict;
        auditIds.push(verdict.auditId);

        /* 连拒熔断（设计 §5.4）：写操作被拒/转建议计数，≥3 熔断本轮。 */
        if (isWrite && (verdict.effect === 'deny' || verdict.effect === 'suggest')) recordWriteDeny(conversationId);

        const effective = event;

        const ok = effective.ok !== false;
        const cardPayload: Record<string, unknown> = {
          name: effective.label ?? effective.toolName,
          toolName: effective.toolName,
          assetId,
          action,
          decision: verdict.effect,
          durationMs: effective.durationMs,
          args: effective.args,
          result: effective.result,
          ok,
          auditId: verdict.auditId,
        };

        if (verdict.effect === 'deny' || verdict.effect === 'suggest') {
          cardPayload.status = toolStatusOf(verdict.effect, ok).status;
          cardPayload.statusCls = toolStatusOf(verdict.effect, ok).cls;
          cardPayload.reason = verdict.reason;
          cardPayload.suggestion = verdict.suggestion ?? '已生成建议，未执行任何写操作';
          cardPayload.executable = false;
          cardPayload.constraints = verdict.constraints ?? { diskChanged: false, bytesWritten: 0, executable: false };
          const card = await insertCard(conversationId, 'suggestion', cardPayload);
          cards.push(card);
        } else if (verdict.effect === 'ask') {
          cardPayload.status = '待审批';
          cardPayload.statusCls = 'warn';
          cardPayload.reason = verdict.reason;
          cardPayload.approvalCard = true;
          /* 审批卡必须自解释：用户要能一眼看出「Agent 想做什么」，而不是看到一行待审批。 */
          cardPayload.command = `${effective.toolName} ${effective.args}`;
          cardPayload.executable = false;
          cardPayload.resolved = false;
          /* V2 写执行计划：批准后由 write-executor 按三层防线真执行。
           * 1.0 不再登记会话级免审记忆（memoryKey 字段保留为空串以兼容旧卡结构）。 */
          cardPayload.plan = {
            toolName: effective.toolName,
            args: parsedArgs,
            targetType: targetTypeOf(effective.toolName, parsedArgs),
            memoryKey: '',
            derivedAssetId: writeTargetAssetId(effective.toolName, derivedTool(face, effective.toolName), face),
          };
          cardPayload.constraints = verdict.constraints ?? { approvalCard: true, executable: false, diskChanged: false };
          const card = await insertCard(conversationId, 'approval_card', cardPayload);
          cards.push(card);
          /* 待审批项要进右栏「执行」Tab：标黄 + 可点回会话，否则审批卡沉在历史里没人处理。 */
          pendingApprovals.push({
            messageId: card.id, toolName: effective.toolName, command: cardPayload.command,
            reason: verdict.reason, auditId: verdict.auditId, status: '待审批',
          });
        } else {
          const derived = toolStatusOf(verdict.effect, ok);
          cardPayload.status = derived.status;
          cardPayload.statusCls = derived.cls;
          const card = await insertCard(conversationId, 'tool_row', cardPayload);
          cards.push(card);
          /* 写工具在 allow 分支也必须落 tool_call 行，保证审计闭环。 */
          run(
            `INSERT INTO tool_call (id,message_id,conversation_id,tool_name,args,result,permission,duration_ms,audit_id,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            newId('tc'), card.id, conversationId, effective.toolName, effective.args,
            effective.result, verdict.effect, effective.durationMs, verdict.auditId, nowIso(),
          );
        }

        if (verdict.effect === 'deny' || verdict.effect === 'suggest' || verdict.effect === 'ask') {
          run(
            `INSERT INTO tool_call (id,message_id,conversation_id,tool_name,args,result,permission,duration_ms,audit_id,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            newId('tc'), cards[cards.length - 1].id, conversationId, effective.toolName, effective.args,
            `${effective.result} · ${verdict.reason}`, verdict.effect, effective.durationMs, verdict.auditId, nowIso(),
          );
        }

        /* 清单更新：执行器已经把最新状态写进那张卡，这里把最新 payload 一并回传，
         * 前端按 id 原位替换 —— 用户在长任务里看到的是同一张清单在推进。 */
        if (event.toolName === 'todo_write') {
          const todoCard = readTodoCard(conversationId);
          if (todoCard) cards.push({ id: todoCard.cardId, kind: 'todo', payload: todoCard.payload });
        }
        break;
      }
      case 'citation': {
        turnCitationIds.push(event.id);
        run(
          `INSERT OR REPLACE INTO citation (id,conversation_id,title,source,locator,snippet,confidence,version,path,start_line,end_line)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          event.id, conversationId, event.title, event.source, event.locator,
          event.snippet, event.confidence, event.version,
          event.path ?? null, event.startLine ?? null, event.endLine ?? null,
        );
        break;
      }
      case 'conclusion': {
        conclusionIds = event.citationIds;
        cards.push(await insertCard(conversationId, 'conclusion', {
          confidence: event.confidence,
          citationIds: event.citationIds,
          content: event.content,
          paras: event.paras,
        }));
        break;
      }
      case 'artifact': {
        run(
          `INSERT INTO artifact (id,conversation_id,name,file_name,size_bytes,meta,created_at)
           VALUES (?,?,?,?,?,?,?)`,
          newId('art'), conversationId, event.name, event.fileName, event.sizeBytes,
          `${event.fileType} · ${Math.round(event.sizeBytes / 1024)}KB`, nowIso(),
        );
        cards.push(await insertCard(conversationId, 'artifact', {
          name: event.name,
          meta: event.meta,
          desc: event.desc,
          fileName: event.fileName,
          fileType: event.fileType,
          sizeBytes: event.sizeBytes,
        }));
        break;
      }
      case 'done':
      default:
        break;
    }
  }
  await flushText();

  /* 右栏 3 Tab 快照 + 真实用量（先查后写，避免"UPDATE 命中 0 行再 INSERT 兜底"的顺序缺陷）。 */
  tx(() => {
    const panels = buildPanelPayloads(conversationId, { assetIds, intent, turnCitationIds, pendingApprovals });
    for (const kind of ['context', 'execution', 'artifacts'] as const) {
      run(
        `INSERT INTO context_snapshot (id,conversation_id,kind,payload,created_at) VALUES (?,?,?,?,?)`,
        newId('ctx'), conversationId, kind, JSON.stringify(panels[kind]), nowIso(),
      );
    }

    /* 用量：优先用模型返回的真实 usage；没有（未接入模型 / 供应商不返回）才估算。
     * cost 仅当配置了单价才累加，未配价目一律保持 0（不编造价格）。 */
    const modelName = providerUsage?.model ?? gateway.modelName;
    /* 上下文占用按 context-budget 的真实口径重算（含摘要卡、预算裁剪、本轮输入），
     * 不再用"全表 payload 字符数"——那个数在压缩之后只会一直虚高。 */
    const contextUsed = measureContext(conversationId, { model: modelName, toolCount: toolFace.length }).used;
    const completionChars = cards
      .filter((card) => card.kind === 'text' || card.kind === 'conclusion' || card.kind === 'notice')
      .reduce((sum, card) => sum + String(card.payload.content ?? '').length, 0);
    const completionTokens = providerUsage?.completionTokens ?? estimateTokens(completionChars);
    const promptTokens = providerUsage?.promptTokens ?? null;
    const billableTokens = promptTokens === null ? completionTokens : promptTokens + completionTokens;
    const pricePerK = Number(process.env.DEVWORK_PRICE_PER_1K_CNY ?? '0');
    const costDelta = Number.isFinite(pricePerK) && pricePerK > 0
      ? Number(((billableTokens / 1000) * pricePerK).toFixed(4))
      : 0;

    const existing = get<{ id: string }>('SELECT id FROM usage_stat WHERE conversation_id = ?', conversationId);
    if (existing) {
      run(
        'UPDATE usage_stat SET context_used = ?, context_budget = ?, cost_cny = ROUND(cost_cny + ?, 4), model = ? WHERE conversation_id = ?',
        contextUsed, windowInfo.window, costDelta, modelName, conversationId,
      );
    } else {
      run(
        `INSERT INTO usage_stat (id,conversation_id,context_used,context_budget,cost_cny,model)
         VALUES (?,?,?,?,?,?)`,
        newId('usage'), conversationId, contextUsed, windowInfo.window, costDelta, modelName,
      );
    }
    /* 单轮用量打点：写进本轮回填的最后一张卡的 payload（前端在回复下方展示）。
     * promptTokens 只有模型真回传才有；估算模式下如实留 null，不编造输入侧数字。 */
    const turnUsage = {
      promptTokens: providerUsage?.promptTokens ?? null,
      completionTokens,
      totalTokens: providerUsage
        ? providerUsage.promptTokens + providerUsage.completionTokens
        : completionTokens,
      costCny: costDelta,
      model: modelName,
    };
    /* 用量挂在「有正文的那张卡」上，而不是时间线最后一张：
     * 清单卡也会被追加进 cards，把 tokens 挂到清单上，前端就没地方显示了。 */
    const lastCard = [...cards].reverse()
      .find((card) => card.kind === 'text' || card.kind === 'conclusion' || card.kind === 'notice');
    if (lastCard) {
      lastCard.payload = { ...lastCard.payload, usage: turnUsage };
      run('UPDATE message SET payload = ? WHERE id = ?', JSON.stringify(lastCard.payload), lastCard.id);
    }
    void conclusionIds;
  });

  return {
    conversationId,
    intent,
    gateway: gateway.kind,
    messages: cards.map((card) => cardShape(card, conversationId)),
    citations: listCitations(conversationId),
    artifacts: listArtifacts(conversationId),
    panels: allPanels(conversationId),
    statusBar: statusBarShape(conversationId),
    auditIds,
  };
}

/**
 * 右栏 3 Tab 快照构建 —— sendMessage 与消息截断共用。
 * 全部从库真读（tool_call / message / citation / artifact），不写死：
 * 撤回后必须重算，否则产物 Tab 躺幽灵产物、执行 Tab 躺幽灵工具行。
 */
function buildPanelPayloads(
  conversationId: string,
  opts: {
    assetIds: string[];
    intent: string;
    turnCitationIds: string[];
    pendingApprovals: Record<string, unknown>[];
  },
): { context: Record<string, unknown>; execution: Record<string, unknown>; artifacts: Record<string, unknown> } {
  const { assetIds, intent, turnCitationIds, pendingApprovals } = opts;
  const asRow = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
  const prevPanels = allPanels(conversationId);
  const prevContext = asRow(prevPanels.context);

  /* ----「上下文」Tab 真实重算：不再沿用种子静态快照（否则发多少条消息 bars 永远不变）---- */
  const goByType: Record<string, string | null> = { db: 'db', code: 'code', server: 'server', kb: null };
  /* 用合并后的 assetIds（含会话绑定资产），否则绑定会话的右栏会显示「未挂载任何资产」。 */
  const ids = assetIds;
  let mounted: Record<string, unknown>[] = [];
  for (const assetId of ids) {
    const a = get<Row>('SELECT name, type, subtitle FROM asset WHERE id = ?', assetId);
    const name = a ? String(a.name) : assetId;
    const type = a ? String(a.type) : '';
    mounted.push({
      name: `@ ${name}`,
      meta: a ? (String(a.subtitle ?? '') || type) : '未找到该资产',
      go: goByType[type] ?? null,
    });
  }
  if (mounted.length === 0 && Array.isArray(prevContext.mounted)) {
    mounted = prevContext.mounted as Record<string, unknown>[];
  }

  /* 命中：只列本轮真实入库的 citation（最多 8 条）。 */
  const turnCitations = (listCitations(conversationId)).filter((c) => turnCitationIds.includes(String(c.id)));
  const hits = turnCitations.slice(0, 8).map((c) => ({
    name: String(c.title), locator: String(c.locator), score: Number(c.confidence),
    meta: [String(c.version ?? ''), `命中 ${Number(c.confidence).toFixed(2)}`],
  }));

  /* token 构成：按消息种类与工具结果真实估算（1 token ≈ 1.5 字符，仅展示口径）。 */
  const charsOf = (sql: string): number =>
    Number(get<Row>(sql, conversationId)?.n ?? 0);
  const historyChars = charsOf(
    `SELECT COALESCE(SUM(LENGTH(payload)),0) AS n FROM message
     WHERE conversation_id = ? AND kind IN ('bubble','text','conclusion')`,
  );
  const toolChars = charsOf('SELECT COALESCE(SUM(LENGTH(result)),0) AS n FROM tool_call WHERE conversation_id = ?');
  const citeChars = turnCitations.reduce((sum, c) => sum + String(c.snippet ?? '').length, 0);
  const systemChars = 620; /* 与 OpenAiCompatibleGateway.systemPrompt 量级一致 */
  const tokenOf = (chars: number): number => estimateTokens(chars);
  const breakdownDefs: [string, number][] = [
    ['系统提示', tokenOf(systemChars)],
    ['检索结果', tokenOf(citeChars)],
    ['工具结果', tokenOf(toolChars)],
    ['历史对话', tokenOf(historyChars)],
  ];
  const totalTokens = breakdownDefs.reduce((sum, [, tokens]) => sum + tokens, 0);
  /* 预算跟着模型走：写死 204800 会让 32k 的模型一直显示"还有九成余量"。 */
  const usageModel = String(get<Row>('SELECT model FROM usage_stat WHERE conversation_id = ?', conversationId)?.model ?? '');
  const budget = resolveContextWindow(usageModel).window;
  const bars = breakdownDefs.map(([name, tokens]) => ({
    name,
    width: Math.min(100, Math.max(2, Math.round((tokens / 1024 / 32) * 100))),
    value: tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens),
  }));
  const tokenBreakdown = breakdownDefs.map(([name, tokens]) => ({ name, tokens }));
  const context = { mounted, hits, bars, tokenBreakdown, totalTokens, budget, lastIntent: intent, lastQueryAt: nowIso() };

  /* ----「执行」Tab：真实 tool_call 聚合（近 20 条，含本轮）---- */
  const permLabel: Record<string, string> = {
    allow: '已自动放行', ask: '待审批 · 未执行', deny: '已拦截', suggest: '转建议',
  };
  const toolRows = (all<Row>(
    'SELECT tool_name, permission, duration_ms FROM tool_call WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 20',
    conversationId,
  )).reverse();
  const tools = toolRows.map((t) => ({
    name: String(t.tool_name),
    meta: [permLabel[String(t.permission)] ?? String(t.permission), `${Number(t.duration_ms)}ms`],
    pending: String(t.permission) === 'ask',
  }));
  /* 耗时条：按工具聚合平均耗时，宽度相对最大值。 */
  const byTool = new Map<string, { total: number; count: number }>();
  toolRows.forEach((t) => {
    const key = String(t.tool_name);
    const entry = byTool.get(key) ?? { total: 0, count: 0 };
    entry.total += Number(t.duration_ms) || 0;
    entry.count += 1;
    byTool.set(key, entry);
  });
  const avgRows = [...byTool.entries()]
    .map(([name, { total, count }]) => ({ name, avg: total / count }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);
  const maxAvg = avgRows[0]?.avg ?? 0;
  const timings = avgRows.map(({ name, avg }) => ({
    name,
    width: maxAvg > 0 ? Math.max(6, Math.round((avg / maxAvg) * 100)) : 6,
    value: avg >= 1000 ? `${(avg / 1000).toFixed(1)}s` : `${Math.round(avg)}ms`,
  }));
  const execution = {
    tools, timings, pendingApprovals, lastRunAt: nowIso(), lastIntent: intent,
  };
  const artifacts = { ...asRow(prevPanels.artifacts), items: listArtifacts(conversationId) };
  return { context, execution, artifacts };
}

/**
 * 消息时间线截断 —— 撤回 / 编辑重发 / 重试 三个动作的共同原语。
 *
 * 语义是「回到这条消息之前的状态」：后面的回复都以它为上下文生成，
 * 只删一条会留下"回答了没人问过的问题"的断层，所以从目标消息起整段截掉。
 *  - inclusive：连同目标消息一起删（撤回 / 编辑前清场）；
 *  - after：保留目标消息（用户气泡），只删它之后的全部内容（重试前清场）。
 * 被删消息生出的下游产物（artifact 行 + 磁盘文件 / citation / tool_call）同步清理，不留孤儿。
 *
 * 用量随之重算 context_used（上下文真实回退）；cost_cny 不回退 ——
 * 已消耗的 token 是真实成本，撤回不该把花掉的钱"撤"回来。
 */
export async function truncateMessages(
  conversationId: string,
  messageId: string,
  mode: 'inclusive' | 'after',
): Promise<{
  deleted: number;
  mode: string;
  bubble?: { content: string; assetIds: string[]; attachments: string[]; chips: string[] };
  /** 随消息一并清掉的下游产物：产物行 / 磁盘文件 / 引用行 / 工具调用行。 */
  artifacts: number;
  files: number;
  citations: number;
  toolCalls: number;
}> {
  /* 时间线顺序以 SQLite 隐式 rowid 为准（即插入顺序），边界就是目标消息自身的 rowid。 */
  const row = get<{ rowid: number; kind: string; payload: string }>(
    'SELECT rowid, kind, payload FROM message WHERE id = ? AND conversation_id = ?',
    messageId, conversationId,
  );
  if (!row) throw new ApiFailure('E_NOT_FOUND', `消息不存在：${messageId}`);
  /* 会话归属：审计要用真实工作区，不能取默认工作区顶替。 */
  const owner = get<{ workspace_id: string }>('SELECT workspace_id FROM conversation WHERE id = ?', conversationId);
  const boundaryOp = mode === 'after' ? '>' : '>=';
  const doomed = all<{ id: string; kind: string; payload: string }>(
    `SELECT id, kind, payload FROM message WHERE conversation_id = ? AND rowid ${boundaryOp} ? ORDER BY rowid`,
    conversationId, row.rowid,
  );

  /*
   * 撤回是「全量回滚」：消息删掉后，它生出来的产物 / 引用 / 工具调用不能留成孤儿。
   * 从被删卡片的 payload 反查下游引用（产物卡的 fileName、气泡的附件、结论的 citationIds），
   * tool_call 则与消息 id 直连。audit_event 是 append-only 黑匣子，故意不动。
   */
  const doomedIds = doomed.map((item) => item.id);
  const artifactNames = new Set<string>();
  const citationIds = new Set<string>();
  for (const item of doomed) {
    let card: Record<string, unknown> = {};
    try { card = JSON.parse(item.payload) as Record<string, unknown>; } catch { continue; }
    if (item.kind === 'artifact') {
      const fileName = String(card.fileName ?? card.name ?? '');
      if (fileName) artifactNames.add(fileName);
    } else if (item.kind === 'bubble' || item.kind === 'user') {
      /* 气泡被删时，它上传的附件（上传即登记为产物）也要跟着走。 */
      for (const name of Array.isArray(card.attachments) ? card.attachments : []) artifactNames.add(String(name));
    } else if (item.kind === 'conclusion') {
      for (const id of Array.isArray(card.citationIds) ? card.citationIds : []) citationIds.add(String(id));
    }
  }

  run(
    `DELETE FROM message WHERE conversation_id = ? AND rowid ${boundaryOp} ?`,
    conversationId, row.rowid,
  );

  /* IN 子句分块删除（规避参数个数上限），返回受影响行数。 */
  const deleteIn = async (table: string, column: string, ids: string[]): Promise<number> => {
    let affected = 0;
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      affected += run(
        `DELETE FROM ${table} WHERE conversation_id = ? AND ${column} IN (${chunk.map(() => '?').join(',')})`,
        conversationId, ...chunk,
      );
    }
    return affected;
  };

  const toolCalls = await deleteIn('tool_call', 'message_id', doomedIds);
  const citations = await deleteIn('citation', 'id', [...citationIds]);

  /*
   * 产物行按名称反查删除；磁盘文件仅在没有任何产物行还引用时才删 ——
   * 产物目录是扁平共享的（artifactPath 按 basename 落盘），同名文件可能被幸存消息占用。
   */
  let artifacts = 0;
  let files = 0;
  const names = [...artifactNames];
  const orphanFiles = new Set<string>();
  for (let i = 0; i < names.length; i += 400) {
    const chunk = names.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = all<{ id: string; file_name: string }>(
      `SELECT id, file_name FROM artifact WHERE conversation_id = ? AND (file_name IN (${placeholders}) OR name IN (${placeholders}))`,
      conversationId, ...chunk, ...chunk,
    );
    for (const artifactRow of rows) orphanFiles.add(artifactRow.file_name);
    artifacts += run(
      `DELETE FROM artifact WHERE conversation_id = ? AND (file_name IN (${placeholders}) OR name IN (${placeholders}))`,
      conversationId, ...chunk, ...chunk,
    );
  }
  for (const fileName of orphanFiles) {
    const remaining = get<{ n: number }>('SELECT COUNT(*) AS n FROM artifact WHERE file_name = ?', fileName);
    if (Number(remaining?.n ?? 0) === 0) {
      try {
        fs.unlinkSync(artifactPath(fileName));
        files += 1;
      } catch { /* 文件本就不存在（种子数据只登记不落盘）时如实跳过 */ }
    }
  }

  /*
   * 右栏 3 Tab 快照跟着回滚：不刷新的话产物 Tab 会留幽灵产物、执行 Tab 会留幽灵工具行。
   * 以截断后时间线的「最后一轮」为准重建（气泡 → intent/资产，结论 → 命中引用）。
   */
  const parsePayload = (raw: string | undefined): Record<string, unknown> => {
    try { return JSON.parse(raw ?? '{}') as Record<string, unknown>; } catch { return {}; }
  };
  const lastBubble = parsePayload((get<{ payload: string }>(
    `SELECT payload FROM message WHERE conversation_id = ? AND kind IN ('bubble','user') ORDER BY created_at DESC, id DESC LIMIT 1`,
    conversationId,
  ))?.payload);
  const lastConclusion = parsePayload((get<{ payload: string }>(
    `SELECT payload FROM message WHERE conversation_id = ? AND kind = 'conclusion' ORDER BY created_at DESC, id DESC LIMIT 1`,
    conversationId,
  ))?.payload);
  /* 挂起审批：只丢掉随截断被删掉的卡，之前遗留的待审批不能跟着消失。 */
  const prevExecution = ((allPanels(conversationId)).execution ?? {}) as Record<string, unknown>;
  const survivingApprovals = (Array.isArray(prevExecution.pendingApprovals) ? prevExecution.pendingApprovals as Record<string, unknown>[] : [])
    .filter((item) => !doomedIds.includes(String(item.messageId)));
  const panels = await buildPanelPayloads(conversationId, {
    assetIds: Array.isArray(lastBubble.assetIds) ? (lastBubble.assetIds as unknown[]).map(String) : [],
    intent: typeof lastBubble.content === 'string' && lastBubble.content ? detectIntent(lastBubble.content) : '',
    turnCitationIds: Array.isArray(lastConclusion.citationIds) ? (lastConclusion.citationIds as unknown[]).map(String) : [],
    pendingApprovals: survivingApprovals,
  });
  for (const kind of ['context', 'execution', 'artifacts'] as const) {
    run(
      `INSERT INTO context_snapshot (id,conversation_id,kind,payload,created_at) VALUES (?,?,?,?,?)`,
      newId('ctx'), conversationId, kind, JSON.stringify(panels[kind]), nowIso(),
    );
  }

  /* 上下文占用按剩余内容重算（与 sendMessage 同一口径：含摘要卡与预算裁剪）。 */
  const contextUsed = measureContext(conversationId).used;
  const usageRow = get<{ id: string }>('SELECT id FROM usage_stat WHERE conversation_id = ?', conversationId);
  if (usageRow) {
    run('UPDATE usage_stat SET context_used = ? WHERE conversation_id = ?', contextUsed, conversationId);
  }
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* payload 损坏不影响截断 */ }
  /* 归属三级：会话的 workspace_id 拿不到就记空串 + workspace:unknown（不回落默认工作区）。 */
  const truncateWorkspaceId = String(owner?.workspace_id ?? '');
  writeAudit({
    workspaceId: truncateWorkspaceId, conversationId, actor: 'user', source: 'user',
    action: mode === 'after' ? 'message.retry_reset' : 'message.truncate',
    target: messageId, result: '成功', severity: 'warn',
    detail: `会话 ${conversationId} 从消息 ${messageId}（${mode}）截断 ${doomed.length} 条，`
      + `同步清理产物 ${artifacts} 个 / 文件 ${files} 个 / 引用 ${citations} 条 / 工具调用 ${toolCalls} 条，上下文已回退`
      + (truncateWorkspaceId === '' ? ' · workspace:unknown' : ''),
  });
  return {
    deleted: doomed.length,
    mode,
    bubble: mode === 'after' && row.kind === 'bubble'
      ? {
          content: String(payload.content ?? ''),
          assetIds: Array.isArray(payload.assetIds) ? (payload.assetIds as string[]).map(String) : [],
          attachments: Array.isArray(payload.attachments) ? (payload.attachments as string[]).map(String) : [],
          chips: Array.isArray(payload.chips) ? (payload.chips as string[]).map(String) : [],
        }
      : undefined,
    artifacts,
    files,
    citations,
    toolCalls,
  };
}

/** 回滚闸门：按审批卡 payload.rollbackRef 执行恢复（V2 写能力层）。 */
export async function rollbackApproval(
  conversationId: string,
  messageId: string,
  identityName = 'Agent',
): Promise<Record<string, unknown>> {
  const row = get<{ id: string; payload: string; kind: string }>(
    'SELECT id, payload, kind FROM message WHERE id = ? AND conversation_id = ?',
    messageId, conversationId,
  );
  if (!row || row.kind !== 'approval_card') {
    throw new ApiFailure('E_NOT_FOUND', `审批卡不存在：${messageId}`);
  }
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  if (!payload.rollbackRef) {
    throw new ApiFailure('E_VALIDATION', '该审批卡没有回滚引用（未执行过写操作，或该操作不可回滚）');
  }
  const who = identityName || '本机用户';
  const conversation = get<{ workspace_id: string }>('SELECT workspace_id FROM conversation WHERE id = ?', conversationId);
  /* 上面的审批卡查询已经证明这个会话存在，所以这里没有回落默认工作区的必要：
   * 真查不到就显式报错 —— 拿默认工作区去解析回滚路径会把文件还原到别人的目录。 */
  const workspaceId = String(conversation?.workspace_id ?? '');
  if (workspaceId === '') throw new ApiFailure('E_NOT_FOUND', `会话不存在，无法定位回滚所属工作区：${conversationId}`);
  const result = await rollbackWritePlan(String(payload.rollbackRef), { name: who, org: 'DevWork', actor: 'user', source: 'user' }, workspaceId);
  const card = await insertCard(conversationId, 'text', {
    content: `回滚${result.ok ? '成功' : '失败'}：${result.message}`,
    rollback: result.ok, actorName: who,
  });
  return { ...cardShape(card, conversationId), ...result };
}

/** 会话导出：可回放的完整结构化轨迹。 */
export async function exportConversation(
  conversationId: string,
  format: 'md' | 'json' = 'json',
): Promise<{ content: string; fileName: string }> {
  const conversation = get<{ id: string; title: string }>('SELECT id, title FROM conversation WHERE id = ?', conversationId);
  if (!conversation) throw new ApiFailure('E_NOT_FOUND', `会话不存在：${conversationId}`);
  const payload = {
    conversationId,
    title: conversation.title,
    exportedAt: nowIso(),
    messages: await listMessageCards(conversationId),
    citations: listCitations(conversationId),
    artifacts: listArtifacts(conversationId),
    toolCalls: all<Record<string, unknown>>(
      'SELECT * FROM tool_call WHERE conversation_id = ? ORDER BY created_at', conversationId,
    ),
    panels: allPanels(conversationId),
  };
  if (format === 'md') {
    const lines = [
      `# ${conversation.title}`,
      '',
      ...payload.messages.map((card) => {
        const body = typeof card.content === 'string' ? card.content : JSON.stringify(card.payload);
        return `- **${String(card.kind)}** (${String(card.actor)}): ${body}`;
      }),
      '',
      '## 引用',
      ...payload.citations.map((cit: Record<string, unknown>) => `- ${String(cit.title)} · ${String(cit.locator)}`),
    ];
    return { content: lines.join('\n'), fileName: `${conversation.title}.md` };
  }
  return { content: JSON.stringify(payload, null, 2), fileName: `${conversation.title}.json` };
}

/** 引用详情：带上源文件路径与行号，前端「打开」可直达编辑器对应行。 */
export async function citationDetail(citationId: string): Promise<Record<string, unknown>> {
  const row = get<Record<string, unknown>>('SELECT * FROM citation WHERE id = ?', citationId);
  if (!row) throw new ApiFailure('E_NOT_FOUND', `引用不存在：${citationId}`);
  const assetId = row.asset_id ? String(row.asset_id) : 'a-kb';
  return {
    ...citationShape(row),
    assetId,
    assetName: row.source,
    code: row.snippet,
    score: String(row.confidence),
    path: row.path ?? null,
    startLine: row.start_line ?? null,
    endLine: row.end_line ?? null,
  };
}

/**
 * 审批裁决 + V2 写执行。
 * approve 且卡片带可执行 plan（code_edit / db_query_write / srv_exec / fs_write_file）时，
 * 走 write-executor 三层防线真执行；演示轨迹遗留名没有可执行内容，如实说明。
 *
 * `scope` 是**客户端请求的口径**（可能是 session），只用于审计里说明"请求的档位已被降级"。
 * 生效口径恒为 once：函数入口即规范化，卡片 payload / 审计 / 返回值都写 scopeApplied。
 */
export async function respondApproval(
  conversationId: string,
  messageId: string,
  decision: 'approve' | 'deny',
  identityName = 'Agent',
  scope: 'once' | 'session' = 'once',
): Promise<Record<string, unknown>> {
  const row = get<{ id: string; payload: string; kind: string }>(
    'SELECT id, payload, kind FROM message WHERE id = ? AND conversation_id = ?',
    messageId, conversationId,
  );
  if (!row) throw new ApiFailure('E_NOT_FOUND', `审批卡不存在或不属于该会话：${messageId}`);
  if (row.kind !== 'approval_card') {
    throw new ApiFailure('E_VALIDATION', '该消息不是审批卡，无法裁决');
  }
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  /* 重复裁决必须挡住：否则同一张卡能被点两次批准，审计里出现两条互相矛盾的记录。 */
  if (payload.resolved === true) {
    throw new ApiFailure('E_ALREADY_RESOLVED', `该审批已裁决（${String(payload.decision ?? '')}），不能重复处理`);
  }

  const command = String(payload.command ?? payload.toolName ?? messageId);
  const who = identityName || '本机用户';
  /* 1.0 不做会话免审：在服务层入口把入参**规范化**，之后一律只用 scopeApplied。
   * 为什么不只靠路由归一：审批有两个路由（/conversations/:id/approvals/:messageId 与
   * /approvals/:messageId），将来再加一条时若忘了归一，卡片与审计就会回显 session
   * 却只执行一次 ——「记录说按会话授权、实际只批一次」正是本轮在清的那类不实记录。 */
  const scopeApplied: 'once' = 'once';
  const owner = get<{ workspace_id: string }>('SELECT workspace_id FROM conversation WHERE id = ?', conversationId);
  /* 审计归属：会话存在就取它的 workspace_id；拿不到（老库 / 异常数据）记空串，
   * 并在 detail 里写明 workspace:unknown —— 绝不拿"看起来存在"的默认值伪装成
   * 某个工作区（那等于把硬编码搬个位置，按工作区筛审计照样查错）。 */
  const conversationWorkspaceId = String(owner?.workspace_id ?? '');
  const workspaceNote = conversationWorkspaceId === '' ? ' · workspace:unknown' : '';
  /* 裁决是真事件，必须落进审计表；只返回一个自己编的 auditId 等于假装记了审计。 */
  const auditId = writeAudit({
    workspaceId: conversationWorkspaceId, conversationId, actor: who, source: 'user',
    action: 'approval.decide', target: command.slice(0, 120),
    result: decision === 'approve' ? '批准' : '拒绝',
    severity: decision === 'approve' ? 'warn' : 'info',
    detail: `审批裁决：${decision} · scope=${scopeApplied}${scope === 'session' ? '（请求为 session，1.0 按 once 处理）' : ''}`
      + ` · 工具=${String(payload.toolName ?? '')} · 原因=${String(payload.reason ?? '')}${workspaceNote}`,
  });

  const plan = (payload.plan ?? null) as Record<string, unknown> | null;
  /* 会话级审批记忆已在 1.0 下线：不再 grantSessionApproval，写操作逐次批准。 */

  /* V2 写执行：批准 + 有可执行 plan → 三层防线真执行。 */
  let executed: { ok: boolean; message: string; rollbackRef?: string; diskChanged: boolean } | null = null;
  if (decision === 'approve' && plan && typeof plan.toolName === 'string') {
    const identity: Identity = { name: who, org: 'DevWork', actor: 'user', source: 'user' };
    executed = await executeWritePlan(
      String(plan.toolName),
      (plan.args ?? {}) as Record<string, unknown>,
      await deriveToolFace(conversationWorkspaceId),
      identity,
      conversationWorkspaceId,
      conversationId,
    );
    if (executed.ok) recordWriteSuccess(conversationId);
    else recordWriteDeny(conversationId);
  }

  /* 原卡打上已裁决标记（执行结果一并写入），UI 据此禁用按钮并展示执行结果。 */
  run(
    'UPDATE message SET payload = ? WHERE id = ?',
    JSON.stringify({
      ...payload,
      resolved: true,
      decision,
      decidedBy: who,
      decidedAt: nowIso(),
      auditId,
      scope: scopeApplied,
      ...(executed ? {
        executed: true,
        executionOk: executed.ok,
        executionMessage: executed.message,
        rollbackRef: executed.rollbackRef ?? null,
        diskChanged: executed.diskChanged,
        constraints: { ...(payload.constraints as Record<string, unknown> ?? {}), executable: true, diskChanged: executed.diskChanged },
      } : {}),
    }),
    messageId,
  );

  /* 这张 text 卡是**落库记录**，将来回看时要能看出「逐次批准」的口径：
   * 只写"已通过"会让人以为此后同类操作都放行了（1.0 实际逐次审批）。 */
  const perTimeNote = '下次同类操作仍需再次批准。';
  const text = decision === 'approve'
    ? (executed
      ? `审批已通过并记入审计（${auditId}）：${command}\n执行结果：${executed.message}${perTimeNote}`
      : `审批已通过并记入审计（${auditId}）：${command}。该工具没有可执行内容（演示轨迹遗留名），如需落地请按建议手动执行。${perTimeNote}`)
    /* 拒绝文案里说清「你请求的是会话级、1.0 只按单次处理」——这是说明降级，不是宣称已免审。 */
    : `审批已拒绝并记入审计（${auditId}）：${command}。无副作用，磁盘零变更。`
      + (scope === 'session' ? '（请求为会话级，1.0 按单次处理）' : '');

  const card = await insertCard(conversationId, 'text', {
    content: text,
    decision,
    auditId,
    actorName: who,
    ...(executed ? { executed: true, executionOk: executed.ok, rollbackRef: executed.rollbackRef ?? null } : {}),
  });
  /* 返回裁决后的原卡 + 说明卡：前端把原卡就地更新为"已裁决"，不必整页重刷。 */
  const updated = get<{ id: string; kind: string; payload: string }>(
    'SELECT id, kind, payload FROM message WHERE id = ?', messageId,
  );
  const resolvedCard = updated
    ? cardShape({
      id: updated.id,
      kind: updated.kind,
      payload: JSON.parse(updated.payload) as Record<string, unknown>,
    }, conversationId)
    : null;
  return {
    ...cardShape(card, conversationId),
    resolvedCard,
    decision,
    /* 回报实际生效的审批口径（恒为 once），前端据此不再显示「本会话内允许」。
     * scopeApplied 是显式字段：请求里的 session 只是被规范化，绝不能原样回显成"已按会话授权"。 */
    scope: scopeApplied,
    scopeApplied: scopeApplied,
    auditId,
    executed: executed ? executed.ok : false,
    diskChanged: executed ? executed.diskChanged : false,
  };
}

export async function createCommandSuggestion(
  conversationId: string,
  input: { command: string; reason: string },
): Promise<Record<string, unknown>> {
  const id = newId('sug');
  const auditId = `sug-${newId('aud')}`;
  run(
    `INSERT INTO command_suggestion (id,conversation_id,command,executable,audit_id,created_at)
     VALUES (?,?,?,?,?,?)`,
    id, conversationId, input.command, 0, auditId, nowIso(),
  );
  return { id, command: input.command, reason: input.reason, executable: false, auditId };
}

