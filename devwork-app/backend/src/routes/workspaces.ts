/**
 * workspaces 路由：工作区增删改查与切换。
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
import { body, requireRow } from './helpers';
import { parseBody } from '../http/validate';
import { workspaceCreateSchema, workspacePatchSchema } from '../../../shared/contracts';

export function registerWorkspaceRoutes(app: Express): void {
  app.get('/api/workspaces', async (_req, res) => ok(res, await listWorkspaces()));
  app.post('/api/workspaces', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(workspaceCreateSchema, req);
    const name = String(payload.name ?? '').trim();
    if (!name) throw new ApiFailure('E_VALIDATION', 'name 必须是非空字符串');
    const id = newId('w');
    run(
      `INSERT INTO workspace (id,name,description,index_progress,assets_count,conversations_count,owner_label,recent_label,trust_level,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, name, String(payload.description ?? ''), 0, 0, 0, '仅我', '刚刚', 'normal', nowIso(),
    );
    ok(res, await workspaceShape(requireRow(get<Row>('SELECT * FROM workspace WHERE id = ?', id), '工作区')));
  }));
  app.post('/api/workspaces/:id/switch', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const ws = requireRow(await workspaceById(id), '工作区');
    const sidebar = await sidebarShape(id);
    const convId = String(sidebar.currentConversationId ?? '');
    writeAudit({
      workspaceId: id, actor: (await identity(req)).name, source: 'user',
      action: 'workspace.switch', target: ws.name, result: '放行', severity: 'info',
      detail: `切换到 ${ws.name} · 三组数据集随工作区隔离`,
    });
    ok(res, {
      workspaceId: id,
      workspaceName: ws.name,
      sidebar,
      context: await panelShape(convId, 'context'),
      execution: await panelShape(convId, 'execution'),
      artifacts: await panelShape(convId, 'artifacts'),
      statusBar: await statusBarShape(convId),
    });
  }));
  app.get('/api/workspaces/:id', wrap(async (req: Request, res: Response) => {
    ok(res, requireRow(await workspaceById(String(req.params.id)), '工作区'));
  }));
  app.patch('/api/workspaces/:id', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    requireRow(await workspaceById(id), '工作区');
    const patch = parseBody(workspacePatchSchema, req);
    if (typeof patch.name === 'string') run('UPDATE workspace SET name = ? WHERE id = ?', patch.name, id);
    if (typeof patch.description === 'string') run('UPDATE workspace SET description = ? WHERE id = ?', patch.description, id);
    ok(res, requireRow(await workspaceById(id), '工作区'));
  }));
  app.delete('/api/workspaces/:id', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (id === 'w-ops') throw new ApiFailure('E_VALIDATION', '默认工作区不可删除');
    run('DELETE FROM workspace WHERE id = ?', id);
    ok(res, { deleted: true });
  }));
  app.post('/api/workspaces/:id/local-dir', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = get<{ id: string }>('SELECT id FROM workspace WHERE id = ?', id);
    requireRow(row, '工作区');
    const who = await identity(req);
    const result = await ensureWorkspaceDir(id);
    writeAudit({
      workspaceId: id, actor: who.name, source: 'user',
      action: 'workspace.local-dir', target: id, result: '成功', severity: 'info',
      detail: `本地工作区目录就绪：${result.localRoot}`,
    });
    ok(res, result);
  }));
}
