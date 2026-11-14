/**
 * conversations 路由：会话 / 消息 / 流式 / 审批 / 引用。
 * 从原单体 routes/index.ts 切分而来，路由体未改写。
 */
/**
 * REST 路由 G0–G11。路径严格按架构契约；同时注册 client.ts 使用的等价别名。
 * 终端拦截属正常业务结果 → HTTP 200 + ok:true；SQL Guard 拒绝 → 422 + E_SQL_REJECTED。
 */
import type { Express, Request, Response } from 'express';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ApiFailure, fail, identity, ok, queryString, wrap } from '../http/core';
import { all, get, run, writeAudit, newId, nowIso } from '../db/database';
import { demoDb } from '../db/database';
import {
  allPanels,
  allSettings,
  assetDetailShape,
  auditCategoryCondition,
  auditShape,
  credentialShape,
  effectivePolicy,
  fileTree,
  gitSummary,
  listArtifacts,
  listCitations,
  listMessageCards,
  listWorkspaces,
  panelShape,
  readOnlyMode,
  settingRaw,
  sidebarShape,
  statusBarShape,
  workspaceById,
  workspaceShape,
} from '../db/repositories';
import { SENSITIVE_RULES } from '../config/rules';
import { sanitizeAssetConfig } from '../config/asset-forms';
import { detectDriver, hasWal } from '../db/adapter';
import { probe, kernelIdentity } from '../kernel/permission';
import { executeCommand, listHistory, listSessions, ensureSession } from '../services/command-executor';
import { runSqlQuery, toCsv } from '../services/sql-query';
import {
  browseRows,
  listObjects,
  safeTableName,
  tableDdl,
  tableFields,
  toInsertScript,
  toJson,
  toMarkdown,
  type BrowseFilter,
} from '../services/sql-browse';
import { runDocIndex, runIndex, searchAsset as searchIndex } from '../services/indexer';
import { agentWrite, fileDiff, fileOutline, generatePatch, readContent, save } from '../services/file-service';
import {
  cloneRepository,
  ensureWorkspaceDir,
  repoStatus,
} from '../services/workspace-repos';
import {
  llmKeyStatus, setLlmKey, llmRuntimeConfig, resolveLlmApiKey, testLlmConnection, fetchLlmModels, LLM_PRESETS,
  llmProfileList, llmActiveProfileId, llmProfileKeyRef, llmProfileKeyStatus, saveLlmProfiles, createGateway,
  type LlmProfile,
} from '../services/llm-gateway';
import { compactConversation, measureContext } from '../services/context-budget';
import { SKILL_REGISTRY, skillShape, validateSkillRegistry } from '../config/skills';
import { deleteSecret } from '../services/secret-store';
import { deriveToolFace, gatewayToolFace } from '../config/tool-catalog';
import { CMD_TEMPLATES } from '../config/cmd-templates';
import { bind, credentialSecret, renew, revoke } from '../services/credential';
import {
  citationDetail,
  createCommandSuggestion,
  exportConversation,
  respondApproval,
  rollbackApproval,
  sendMessage,
  truncateMessages,
} from '../services/conversation';
import { bootstrapArtifacts, artifactPath, artifactSize } from '../sandbox/bootstrap';
import { normalizeBrowserUrl, readBrowserPage, readBrowserState, writeBrowserPage, writeBrowserState } from '../services/browser';
import { PORT } from '../config';

type Row = Record<string, unknown>;
import { body, optionalId, requireRow } from './helpers';
import { parseBody } from '../http/validate';
import { approvalDecisionSchema, approvalRollbackSchema, attachmentUploadSchema, commandSuggestionSchema, compactContextSchema, conversationCreateSchema, conversationPatchSchema, sendMessageSchema, truncateMessagesSchema } from '../../../shared/contracts';

export function registerConversationRoutes(app: Express): void {
  /* ---------------- G4 会话 / 消息 / 引用 ---------------- */
  /* 会话行 → API 形状。archivedAt 非空 = 已归档（侧栏隐藏，归档管理页可见）。 */
  const conversationShape = (c: Row): Row => ({
    id: c.id,
    workspaceId: c.workspace_id,
    title: c.title,
    folderId: c.folder_id,
    /* 资产绑定：前端据此知道这条会话是从哪个资产的页面唤起的。 */
    assetId: c.asset_id ?? null,
    assetType: c.asset_type ?? null,
    createdAt: c.created_at,
    archivedAt: c.archived_at ?? null,
  });
  app.get('/api/conversations', wrap(async (req: Request, res: Response) => {
    /* archived=1：归档管理页专用 —— 只返回已归档会话，且 workspaceId 可选
     * （设置页是全局入口，跨工作区一屏管理）。 */
    if (queryString(req, 'archived') === '1') {
      const workspaceId = queryString(req, 'workspaceId');
      const rows = workspaceId
        ? all<Row>('SELECT * FROM conversation WHERE archived_at IS NOT NULL AND workspace_id = ? ORDER BY archived_at DESC', workspaceId)
        : all<Row>('SELECT * FROM conversation WHERE archived_at IS NOT NULL ORDER BY archived_at DESC');
      ok(res, rows.map(conversationShape));
      return;
    }
    const workspaceId = queryString(req, 'workspaceId', 'w-ops');
    requireRow(await workspaceById(workspaceId), '工作区');
    ok(res, (all<Row>(
      'SELECT * FROM conversation WHERE workspace_id = ? AND archived_at IS NULL ORDER BY sort_order',
      workspaceId,
    )).map(conversationShape));
  }));
  app.post('/api/conversations', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(conversationCreateSchema, req);
    const id = newId('c');
    /* assetId 可选：普通会话不带绑定，从资产页唤起的会话带上。 */
    const assetId = optionalId(payload.assetId);
    const assetType = assetId ? String(payload.assetType ?? '') : null;
    run(
      'INSERT INTO conversation (id,workspace_id,folder_id,title,sort_order,asset_id,asset_type,created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, String(payload.workspaceId ?? 'w-ops'), optionalId(payload.folderId),
      String(payload.title ?? '新建会话'), 99, assetId, assetType, nowIso(),
    );
    ok(res, {
      id,
      workspaceId: payload.workspaceId ?? 'w-ops',
      title: payload.title,
      assetId,
      assetType,
      createdAt: nowIso(),
    });
  }));
  app.get('/api/conversations/:id/messages', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    requireRow(get<{ id: string }>('SELECT id FROM conversation WHERE id = ?', id), '会话');
    ok(res, await listMessageCards(id));
  }));
  app.post('/api/conversations/:id/messages', wrap(async (req: Request, res: Response) => {
    /* 契约校验：content / assetIds / attachments / model / regenerate 由 shared 定义。
     * content 允许为空 ——「重试」复用同一端点且沿用已有用户气泡（regenerate=true）。 */
    const payload = parseBody(sendMessageSchema, req);
    const result = await sendMessage(String(req.params.id), {
      content: String(payload.content ?? ''),
      assetIds: Array.isArray(payload.assetIds) ? (payload.assetIds as string[]) : [],
      attachments: Array.isArray(payload.attachments) ? (payload.attachments as string[]).map(String) : [],
      /* 会话级模型覆盖：只影响本次调用，不改全局配置。 */
      model: typeof payload.model === 'string' ? payload.model : undefined,
      /* 重试：沿用已有用户气泡，不重复插入。 */
      regenerate: payload.regenerate === true,
    }, await identity(req));
    ok(res, result);
  }));
  /* 消息时间线截断（撤回 / 编辑重发 / 重试的共同原语）：
   * inclusive 连目标一起删；after 保留目标（用户气泡）删其后全部内容。 */
  app.post('/api/conversations/:id/messages/truncate', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(truncateMessagesSchema, req);
    const mode = String(payload.mode ?? 'inclusive') === 'after' ? 'after' : 'inclusive';
    ok(res, await truncateMessages(String(req.params.id), String(payload.messageId ?? ''), mode));
  }));
  /* B16：SSE 流式端点 —— 逐事件推送（text_delta 增量 / tool_call / citation / conclusion），
   * 结束时推送 { type:'result', result: TurnResult }，与一次性端点同一持久化语义。 */
  app.post('/api/conversations/:id/stream', async (req: Request, res: Response) => {
    const payload = parseBody(sendMessageSchema, req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    await sendMessage(String(req.params.id), {
      content: String(payload.content ?? ''),
      assetIds: Array.isArray(payload.assetIds) ? (payload.assetIds as string[]) : [],
      attachments: Array.isArray(payload.attachments) ? (payload.attachments as string[]).map(String) : [],
      /* 会话级模型覆盖：只影响本次调用，不改全局配置。 */
      model: typeof payload.model === 'string' ? payload.model : undefined,
      /* 重试：沿用已有用户气泡，不重复插入。 */
      regenerate: payload.regenerate === true,
    }, await identity(req), (event) => {
      /* 客户端手动中断（stopGeneration）：连接关闭后不再向已断开的流写事件。
       * 本轮服务端工作照常持久化（真实成本不伪造），只是不再推送。 */
      if (!res.writableEnded) send({ ok: true, data: event });
    })
      .then((result) => {
        send({ ok: true, data: { type: 'result', result } });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof ApiFailure ? error.code : 'E_INTERNAL';
        send({ ok: false, error: { code, message } });
      })
      .finally(() => {
        res.end();
      });
  });
  app.get('/api/conversations/:id/export', wrap(async (req: Request, res: Response) => {
    const format = queryString(req, 'format', 'json') === 'md' ? 'md' : 'json';
    ok(res, await exportConversation(String(req.params.id), format));
  }));
  app.get('/api/conversations/:id/citations', wrap(async (req: Request, res: Response) => {
    ok(res, await listCitations(String(req.params.id)));
  }));
  app.get('/api/citations/:id', wrap(async (req: Request, res: Response) => {
    ok(res, await citationDetail(String(req.params.id)));
  }));
  /* 附件上传：前端把文件读成 base64 随 JSON 上传（无需 multipart 依赖）。
   * 文件真实落盘到产物目录，并登记 artifact 行——右栏「产物」与下载链路直接复用。 */
  const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
  app.post('/api/conversations/:id/attachments', wrap(async (req: Request, res: Response) => {
    requireRow(get<Row>('SELECT id FROM conversation WHERE id = ?', String(req.params.id)), '会话');
    const payload = parseBody(attachmentUploadSchema, req);
    const name = String(payload.name ?? '').trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!name) throw new ApiFailure('E_VALIDATION', '附件文件名不能为空');
    const buf = Buffer.from(String(payload.contentBase64 ?? ''), 'base64');
    if (buf.length === 0) throw new ApiFailure('E_VALIDATION', '附件内容为空');
    if (buf.length > MAX_ATTACHMENT_BYTES) throw new ApiFailure('E_VALIDATION', '附件超过 10MB 上限');
    bootstrapArtifacts();
    fs.writeFileSync(artifactPath(name), buf);
    const id = newId('art');
    run(
      'INSERT INTO artifact (id,conversation_id,name,file_name,size_bytes,meta,created_at) VALUES (?,?,?,?,?,?,?)',
      id, String(req.params.id), name, name, buf.length,
      `FILE · ${Math.max(1, Math.round(buf.length / 1024))}KB`, nowIso(),
    );
    writeAudit({
      workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: 'attachment.upload', target: name, result: '成功', severity: 'info',
      detail: `会话 ${req.params.id} 上传附件 ${buf.length} 字节，已登记为产物`,
    });
    ok(res, { id, name, fileName: name, sizeBytes: buf.length });
  }));
  app.post('/api/conversations/:id/approvals/:messageId', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(approvalDecisionSchema, req);
    const scope = String(payload.scope ?? 'once') === 'session' ? 'session' : 'once';
    ok(res, await respondApproval(String(req.params.id), String(req.params.messageId),
      String(payload.decision ?? 'deny') === 'approve' ? 'approve' : 'deny', (await identity(req)).name, scope));
  }));
  app.post('/api/approvals/:messageId', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(approvalDecisionSchema, req);
    const scope = String(payload.scope ?? 'once') === 'session' ? 'session' : 'once';
    ok(res, await respondApproval(String(payload.conversationId ?? 'c-gmv'), String(req.params.messageId),
      String(payload.decision ?? 'deny') === 'approve' ? 'approve' : 'deny', (await identity(req)).name, scope));
  }));
  /* 回滚端点（V2 写能力层的 rollback 闸门）：按审批卡 payload.rollbackRef 分派。 */
  app.post('/api/conversations/:id/approvals/:messageId/rollback', wrap(async (req: Request, res: Response) => {
    ok(res, await rollbackApproval(String(req.params.id), String(req.params.messageId), (await identity(req)).name));
  }));
  app.post('/api/approvals/:messageId/rollback', wrap(async (req: Request, res: Response) => {
    ok(res, await rollbackApproval(String(parseBody(approvalRollbackSchema, req).conversationId ?? 'c-gmv'), String(req.params.messageId), (await identity(req)).name));
  }));
  app.post('/api/conversations/:id/command-suggestions', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(commandSuggestionSchema, req);
    ok(res, await createCommandSuggestion(String(req.params.id), {
      command: String(payload.command ?? ''), reason: String(payload.reason ?? ''),
    }));
  }));
  app.post('/api/command-suggestions', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(commandSuggestionSchema, req);
    ok(res, await createCommandSuggestion(String(payload.conversationId ?? 'c-gmv'), {
      command: String(payload.command ?? ''), reason: String(payload.reason ?? ''),
    }));
  }));
  app.patch('/api/conversations/:id', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const payload = parseBody(conversationPatchSchema, req);
    if (typeof payload.title === 'string') run('UPDATE conversation SET title = ? WHERE id = ?', payload.title, id);
    /* 归档 / 恢复：archived=true 记下归档时间并从侧栏隐藏；false 清空时间回到原文件夹。 */
    if (typeof payload.archived === 'boolean') {
      run('UPDATE conversation SET archived_at = ? WHERE id = ?', payload.archived ? nowIso() : null, id);
      writeAudit({
        workspaceId: 'w-ops', conversationId: id, actor: (await identity(req)).name, source: 'user',
        action: payload.archived ? 'conversation.archive' : 'conversation.unarchive',
        target: id, result: '成功', severity: 'info',
        detail: payload.archived ? `会话 ${id} 已归档` : `会话 ${id} 已从归档恢复`,
      });
    }
    const row = requireRow(get<Row>('SELECT * FROM conversation WHERE id = ?', id), '会话');
    ok(res, conversationShape(row));
  }));
  app.delete('/api/conversations/:id', wrap(async (req: Request, res: Response) => {
    run('DELETE FROM message WHERE conversation_id = ?', req.params.id);
    run('DELETE FROM conversation WHERE id = ?', req.params.id);
    writeAudit({
      workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: 'conversation.delete', target: String(req.params.id), result: '成功', severity: 'warn',
      detail: `会话 ${req.params.id} 已彻底删除（含消息）`,
    });
    ok(res, { deleted: true });
  }));

  /* ---------------- G5 右栏 3 Tab / 用量 / 产物 ---------------- */
  app.get('/api/conversations/:id/context', wrap(async (req: Request, res: Response) => {
    ok(res, await panelShape(String(req.params.id), 'context'));
  }));
  app.get('/api/conversations/:id/execution', wrap(async (req: Request, res: Response) => {
    ok(res, await panelShape(String(req.params.id), 'execution'));
  }));
  app.get('/api/conversations/:id/artifacts', wrap(async (req: Request, res: Response) => {
    const panel = await panelShape(String(req.params.id), 'artifacts');
    const items = Array.isArray(panel.items) ? panel.items : [];
    if (items.length > 0) {
      ok(res, panel);
      return;
    }
    /* 快照缺位（老库升级 / 会话还没跑过 Agent）时从 artifact 表兜底：
     * 文件 Tab 的清单必须指向真实产物 —— 面板空时前端只能拿演示占位 id，
     * 那种 id 服务端对不上号，预览/下载只会 404。 */
    const files = await listArtifacts(String(req.params.id));
    if (files.length === 0) {
      ok(res, panel);
      return;
    }
    ok(res, {
      ...panel,
      items: files.map((f) => ({
        id: f.id,
        tag: f.fileType || 'DOC',
        /* 与快照条目一致用文件名展示：预览/下载都按它定位。 */
        name: f.fileName || f.name,
        size: f.sizeLabel || `${Math.max(1, Math.round(Number(f.sizeBytes ?? 0) / 1024))}KB`,
        sizeBytes: Number(f.sizeBytes ?? 0),
        bg: '#EAF1FE',
        fg: '#2F6FEB',
      })),
      note: panel.note || '产物会随会话保存，也可发布到资料库或直接下载。',
    });
  }));
  app.get('/api/conversations/:id/usage', wrap(async (req: Request, res: Response) => {
    const row = get<Row>('SELECT * FROM usage_stat WHERE conversation_id = ?', req.params.id);
    if (row) {
      ok(res, {
        contextUsed: Number(row.context_used),
        contextBudget: Number(row.context_budget),
        costCny: Number(row.cost_cny),
        model: String(row.model ?? 'Claude-Sonnet'),
      });
      return;
    }
    /* B13：无 usage_stat 行时按上下文预算口径实算（不再写死假值）。 */
    const conversation = get<Row>('SELECT workspace_id FROM conversation WHERE id = ?', String(req.params.id));
    const face = conversation ? deriveToolFace(String(conversation.workspace_id)) : undefined;
    const usage = measureContext(String(req.params.id), { toolCount: face ? gatewayToolFace(face).length : 0 });
    ok(res, {
      contextUsed: usage.used,
      contextBudget: usage.budget,
      costCny: 0,
      model: usage.model || '未接入模型',
    });
  }));

  /* 上下文用量明细：输入框那个小按钮读它（占用 / 预算 / 构成 / 上次压缩）。
   * 与 /usage 分开是因为两者读者不同：/usage 给状态栏看总量，这里给"要不要压缩"看结构。 */
  app.get('/api/conversations/:id/context-usage', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const conversation = requireRow(get<Row>('SELECT workspace_id FROM conversation WHERE id = ?', id), '会话');
    const model = queryString(req, 'model') || undefined;
    const face = deriveToolFace(String(conversation.workspace_id));
    ok(res, measureContext(id, { model, toolCount: gatewayToolFace(face).length }));
  }));

  /* 手动压缩：把早前对话折叠成一张摘要卡（原始消息不动，只是不再整段进提示）。 */
  app.post('/api/conversations/:id/compact', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const conversation = requireRow(get<Row>('SELECT workspace_id FROM conversation WHERE id = ?', id), '会话');
    const payload = parseBody(compactContextSchema, req);
    const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined;
    const gateway = await createGateway(model);
    const result = await compactConversation({
      conversationId: id,
      mode: 'manual',
      model: model ?? gateway.modelName,
      keepShare: typeof payload.keepShare === 'number' ? payload.keepShare : undefined,
      gateway,
    });
    if (!result.skipped) {
      writeAudit({
        workspaceId: String(conversation.workspace_id), conversationId: id,
        actor: (await identity(req)).name, source: 'user',
        action: 'context.compact', target: id, result: '成功', severity: 'info',
        detail: `手动压缩：折叠 ${result.covered} 条对话，上下文 ${result.before} → ${result.after} tokens，`
          + `摘要来源 ${result.summary?.source === 'model' ? `模型 ${result.summary.model}` : '规则提炼'}`,
      });
    }
    ok(res, result);
  }));
}
