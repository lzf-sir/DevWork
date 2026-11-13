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
import { deriveToolFace, gatewayToolFace, derivedTool, type ToolFace } from '../config/tool-catalog';
import { executeAgentTool } from './agent-tools';
import { executeFileWrite, executeDbWrite, executeSrvTemplate, rollbackWritePlan } from './write-executor';
import {
  approvalKeyOf, grantSessionApproval, hasSessionApproval,
  breakerTripped, breakerStatus, recordWriteDeny, recordWriteSuccess,
} from './session-approvals';
import { requireCredential } from './credential';
import { createGateway, detectIntent, type AgentEvent, type GatewayContext } from './llm-gateway';

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

async function insertCard(
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
 * 写计划的统一执行入口（三层防线）。只对 V2 可执行工具真执行；
 * 演示轨迹遗留名（fs_truncate_log 等）没有可执行内容，如实返回不假装。 */
async function executeWritePlan(
  toolName: string,
  args: Record<string, unknown>,
  face: ToolFace,
  identity: Identity,
  workspaceId: string,
): Promise<{ ok: boolean; message: string; rollbackRef?: string; diskChanged: boolean }> {
  const tool = derivedTool(face, toolName);
  const assetId = tool?.assetId ?? toolSpec(toolName).assetId;
  switch (toolName) {
    case 'code_edit':
    case 'fs_write_file':
      return executeFileWrite(assetId, String(args.path ?? ''), String(args.content ?? ''), identity, workspaceId);
    case 'db_query_write':
      return executeDbWrite(String(args.sql ?? ''), identity, workspaceId);
    case 'srv_exec': {
      let params: Record<string, unknown> = {};
      if (typeof args.params === 'string') {
        try { params = JSON.parse(args.params) as Record<string, unknown>; } catch { params = {}; }
      } else if (args.params && typeof args.params === 'object') {
        params = args.params as Record<string, unknown>;
      }
      return executeSrvTemplate(assetId, String(args.action ?? ''), params, identity, workspaceId);
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

/** 从库里还原多轮上下文（最近 12 条 user/assistant 文本，时间正序）。 */
async function buildHistory(conversationId: string, excludeContent: string): Promise<GatewayContext['history']> {
  const rows = all<{ kind: string; payload: string; actor: string }>(
    'SELECT kind, payload, actor FROM message WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 24',
    conversationId,
  );
  const history: { role: 'user' | 'assistant'; content: string }[] = [];
  rows.reverse().forEach((row) => {
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { return; }
    if (row.kind === 'bubble') {
      const content = String(payload.content ?? '');
      if (content && content !== excludeContent) history.push({ role: 'user', content });
    } else if (row.kind === 'text' || row.kind === 'conclusion') {
      const content = String(payload.content ?? '');
      if (content) history.push({ role: 'assistant', content: content.slice(0, 1200) });
    }
  });
  return history;
}

/** 引用片段摘要：前 5 行足够浮层展示，且原文可点开核对。 */
function snippetOf(content: string): string {
  return content.split('\n').slice(0, 5).join('\n');
}

/** 派生工具面 + 权限内核 + 会话审批记忆的真实执行器。
 *  返回结构里的 ok 是"执行是否成功"的唯一事实来源，工具卡状态由它推导。 */
function makeToolExecutor(
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
      const key = approvalKeyOf(toolAction(toolName), targetTypeOf(toolName, args), toolRisk(toolName));
      if (hasSessionApproval(conversationId, key)) {
        const outcome = await executeWritePlan(toolName, args, face, identity, workspaceId);
        if (outcome.ok) recordWriteSuccess(conversationId);
        return {
          ok: outcome.ok,
          result: `${outcome.message}\n（命中会话级审批记忆：${key}）${outcome.rollbackRef ? `\n回滚引用已就绪：${outcome.rollbackRef.slice(0, 200)}` : ''}`,
        };
      }
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

/** token 估算：中英混排按 1 token ≈ 1.5 字符，仅用于展示与预算告警，不用于计费对账。 */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 1.5));
}

/** 上下文实际占用：按本会话全部消息卡体的字符数估算。 */
function contextCharsOf(conversationId: string): number {
  const row = get<{ n: number }>(
    'SELECT COALESCE(SUM(LENGTH(payload)), 0) AS n FROM message WHERE conversation_id = ?',
    conversationId,
  );
  return Number(row?.n ?? 0);
}

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
  }

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
    toolFace: gatewayToolFace(face),
    executeTool: makeToolExecutor(ctx, conversationId, identity, conversation.workspace_id, face),
  })) {
    events.push(event);
    onEvent?.(event);
  }

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

        /* 会话级审批记忆（设计 §6.4）：记忆键 = intent+targetType+risk，不含具体参数。
         * 命中时 ask → allow（审计里保留原裁决链）。 */
        const memoryKey = approvalKeyOf(action, targetTypeOf(event.toolName, parsedArgs), risk);
        const sessionApproved = isWrite && hasSessionApproval(conversationId, memoryKey);

        const kernelVerdict = await check({
          actor: 'agent', action, risk,
          workspaceId: conversation.workspace_id,
          assetId,
          path: targetPath,
          payload: { toolName: event.toolName },
        }, ctx);
        const verdict = sessionApproved && kernelVerdict.effect === 'ask'
          ? { ...kernelVerdict, effect: 'allow' as const, reason: `会话级审批记忆命中（${memoryKey}），本类操作本会话内免审` }
          : kernelVerdict;
        auditIds.push(verdict.auditId);

        /* 连拒熔断（设计 §5.4）：写操作被拒/转建议计数，≥3 熔断本轮。 */
        if (isWrite && (verdict.effect === 'deny' || verdict.effect === 'suggest')) recordWriteDeny(conversationId);

        /* 会话记忆命中且网关未真执行（Mock 写步骤不走执行器）→ 分支级补执行。
         * 标记字符串与执行器返回文案一致，避免 OpenAI 路径双重执行。 */
        let effective = event;
        if (sessionApproved && isWrite && verdict.effect === 'allow'
          && !String(event.result ?? '').includes('命中会话级审批记忆')) {
          const outcome = await executeWritePlan(event.toolName, parsedArgs, face, identity, conversation.workspace_id);
          if (outcome.ok) recordWriteSuccess(conversationId);
          effective = {
            ...event,
            result: `${outcome.message}\n（命中会话级审批记忆：${memoryKey}）`,
            ok: outcome.ok,
          };
        }

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
          /* V2 写执行计划：批准后由 write-executor 按三层防线真执行（会话记忆键随卡登记）。 */
          cardPayload.plan = {
            toolName: effective.toolName,
            args: parsedArgs,
            targetType: targetTypeOf(effective.toolName, parsedArgs),
            memoryKey,
            derivedAssetId: derivedTool(face, effective.toolName)?.assetId ?? assetId,
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
    const contextUsed = estimateTokens(contextCharsOf(conversationId));
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
    const modelName = providerUsage?.model ?? gateway.modelName;

    const existing = get<{ id: string }>('SELECT id FROM usage_stat WHERE conversation_id = ?', conversationId);
    if (existing) {
      run(
        'UPDATE usage_stat SET context_used = ?, cost_cny = ROUND(cost_cny + ?, 4), model = ? WHERE conversation_id = ?',
        contextUsed, costDelta, modelName, conversationId,
      );
    } else {
      run(
        `INSERT INTO usage_stat (id,conversation_id,context_used,context_budget,cost_cny,model)
         VALUES (?,?,?,?,?,?)`,
        newId('usage'), conversationId, contextUsed, 204800, costDelta, modelName,
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
    const lastCard = cards[cards.length - 1];
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
  const budget = 204800;
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

  /* 上下文占用按剩余消息重算（与 sendMessage 的估算口径一致）。 */
  const contextUsed = estimateTokens(await contextCharsOf(conversationId));
  const usageRow = get<{ id: string }>('SELECT id FROM usage_stat WHERE conversation_id = ?', conversationId);
  if (usageRow) {
    run('UPDATE usage_stat SET context_used = ? WHERE conversation_id = ?', contextUsed, conversationId);
  }
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(row.payload) as Record<string, unknown>; } catch { /* payload 损坏不影响截断 */ }
  writeAudit({
    workspaceId: 'w-ops', conversationId, actor: 'user', source: 'user',
    action: mode === 'after' ? 'message.retry_reset' : 'message.truncate',
    target: messageId, result: '成功', severity: 'warn',
    detail: `会话 ${conversationId} 从消息 ${messageId}（${mode}）截断 ${doomed.length} 条，`
      + `同步清理产物 ${artifacts} 个 / 文件 ${files} 个 / 引用 ${citations} 条 / 工具调用 ${toolCalls} 条，上下文已回退`,
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
  const workspaceId = conversation?.workspace_id ?? 'w-ops';
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
 * scope='session' 时登记会话级审批记忆（记忆键 = intent+targetType+risk，不含参数）。
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
  /* 裁决是真事件，必须落进审计表；只返回一个自己编的 auditId 等于假装记了审计。 */
  const auditId = writeAudit({
    workspaceId: 'w-ops', conversationId, actor: who, source: 'user',
    action: 'approval.decide', target: command.slice(0, 120),
    result: decision === 'approve' ? '批准' : '拒绝',
    severity: decision === 'approve' ? 'warn' : 'info',
    detail: `审批裁决：${decision} · scope=${scope} · 工具=${String(payload.toolName ?? '')} · 原因=${String(payload.reason ?? '')}`,
  });

  /* 会话级审批记忆：只对批准方向登记；记忆键来自卡片 plan（intent+targetType+risk）。 */
  const plan = (payload.plan ?? null) as Record<string, unknown> | null;
  if (decision === 'approve' && scope === 'session' && plan) {
    grantSessionApproval(conversationId, String(plan.memoryKey ?? ''));
  }

  /* V2 写执行：批准 + 有可执行 plan → 三层防线真执行。 */
  let executed: { ok: boolean; message: string; rollbackRef?: string; diskChanged: boolean } | null = null;
  if (decision === 'approve' && plan && typeof plan.toolName === 'string') {
    const conversation = get<{ workspace_id: string }>('SELECT workspace_id FROM conversation WHERE id = ?', conversationId);
    const identity: Identity = { name: who, org: 'DevWork', actor: 'user', source: 'user' };
    executed = await executeWritePlan(
      String(plan.toolName),
      (plan.args ?? {}) as Record<string, unknown>,
      await deriveToolFace(conversation?.workspace_id ?? 'w-ops'),
      identity,
      conversation?.workspace_id ?? 'w-ops',
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
      scope,
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

  const text = decision === 'approve'
    ? (executed
      ? `审批已通过并记入审计（${auditId}）：${command}\n执行结果：${executed.message}`
      : `审批已通过并记入审计（${auditId}）：${command}。该工具没有可执行内容（演示轨迹遗留名），如需落地请按建议手动执行。`)
    : `审批已拒绝并记入审计（${auditId}）：${command}。无副作用，磁盘零变更。${scope === 'session' ? '' : ''}`;

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
    scope,
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

