/**
 * terminal 路由：终端会话 / 历史 / 命令白黑名单。
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
  llmProfileList, llmActiveProfileId, llmProfileKeyRef, llmProfileKeyStatus, saveLlmProfiles,
  type LlmProfile,
} from '../services/llm-gateway';
import { SKILL_REGISTRY, skillShape, validateSkillRegistry } from '../config/skills';
import { deleteSecret } from '../services/secret-store';
import { deriveToolFace } from '../config/tool-catalog';
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
import { body, requireAssetId } from './helpers';
import { parseBody } from '../http/validate';
import { terminalExecuteSchema, terminalSessionPatchSchema } from '../../../shared/contracts';

export function registerTerminalRoutes(app: Express): void {
  app.get('/api/assets/:id/terminal/sessions', wrap(async (req: Request, res: Response) => {
    /* B7：与其余 12 个资产子端点一致，先校验资产存在性与工作区归属；
     * 校验通过后如实返回会话列表（可能为空数组），不再造硬编码 fallback 会话。 */
    const assetId = await requireAssetId(req);
    ok(res, await listSessions(assetId));
  }));
  app.post('/api/assets/:id/terminal/sessions', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const sid = newId('sess');
    const cwd = await ensureSession(assetId, sid);
    ok(res, { id: sid, assetId, cwd, createdAt: nowIso() });
  }));
  app.patch('/api/assets/:id/terminal/sessions/:sid', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const cwd = await ensureSession(assetId, String(req.params.sid));
    ok(res, { id: req.params.sid, assetId, cwd: String(parseBody(terminalSessionPatchSchema, req).cwd ?? cwd), createdAt: nowIso() });
  }));
  app.delete('/api/assets/:id/terminal/sessions/:sid', wrap(async (req: Request, res: Response) => {
    await requireAssetId(req);
    run('DELETE FROM terminal_session WHERE id = ?', req.params.sid);
    ok(res, { closed: true });
  }));
  app.post('/api/assets/:id/terminal/execute', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(terminalExecuteSchema, req);
    const assetId = await requireAssetId(req);
    const result = await executeCommand(assetId, {
      sessionId: String(payload.sessionId ?? 'sess-1'),
      command: String(payload.command ?? ''),
    }, await identity(req));
    ok(res, result);
  }));
  app.get('/api/assets/:id/terminal/history', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const sid = queryString(req, 'sid') || queryString(req, 'sessionId', 'sess-1');
    ok(res, await listHistory(assetId, sid));
  }));
  app.get('/api/commands/whitelist', async (_req, res) => ok(res, all<Row>('SELECT * FROM command_whitelist ORDER BY id')));
  app.get('/api/commands/blacklist', async (_req, res) => ok(res, all<Row>('SELECT * FROM command_blacklist_rule ORDER BY id')));
  /* 技能登记表：输入框「/ 技能」菜单的数据源。
   * 登记表自检不通过就直接 500 —— 菜单里摆着点了会报「未知工具」的技能，
   * 比不提供技能更糟，宁可让服务端起不来也不要发假能力给前端。 */
}
