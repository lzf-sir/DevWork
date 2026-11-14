/**
 * sidebar 路由：侧栏 / 状态栏 / 分组 / 条目移动。
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
import { AUDIT_GLOBAL_SCOPE, all, get, run, writeAudit, newId, nowIso } from '../db/database';
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
import { DEFAULT_WORKSPACE_ID, PORT } from '../config';

type Row = Record<string, unknown>;
import { body, optionalId, requireRow, workspaceGuard } from './helpers';
import { parseBody } from '../http/validate';
import { folderCreateSchema, folderPatchSchema, folderReorderSchema, itemsMoveSchema } from '../../../shared/contracts';

export function registerSidebarRoutes(app: Express): void {
  app.get('/api/sidebar', wrap(async (req: Request, res: Response) => {
    const workspaceId = queryString(req, 'workspaceId', DEFAULT_WORKSPACE_ID);
    requireRow(await workspaceById(workspaceId), '工作区');
    ok(res, await sidebarShape(workspaceId));
  }));
  app.get('/api/status-bar', wrap(async (req: Request, res: Response) => {
    ok(res, await statusBarShape(queryString(req, 'conversationId', '') || undefined));
  }));

  /* ---------------- G2 文件夹 ---------------- */
  app.get('/api/folders', wrap(async (req: Request, res: Response) => {
    const workspaceId = queryString(req, 'workspaceId', DEFAULT_WORKSPACE_ID);
    const kind = queryString(req, 'kind', 'asset');
    ok(res, (all<Row>(
      'SELECT * FROM folder WHERE workspace_id = ? AND kind = ? ORDER BY sort_order',
      workspaceId, kind,
    )).map((f) => ({
      id: f.id, workspaceId: f.workspace_id, kind: f.kind, name: f.name,
      parentId: f.parent_id ?? null,
      depth: f.parent_id ? 2 : 1,
      collapsed: Number(f.collapsed) === 1, sortOrder: Number(f.sort_order), count: Number(f.count ?? 0),
    })));
  }));
  app.post('/api/folders', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(folderCreateSchema, req);
    const workspaceId = String(payload.workspaceId ?? DEFAULT_WORKSPACE_ID);
    const kind = String(payload.kind ?? 'asset');
    const name = String(payload.name ?? '').trim() || '新建文件夹';
    const parentId = optionalId(payload.parentId);

    /* 目录树只允许两层（设计 §侧栏：分区 → 文件夹 → 子文件夹 → 条目）。
     * 不限制的话前端一旦递归渲染子级就会无限套娃，这里在写入侧兜住。 */
    if (parentId) {
      const parent = get<Row>('SELECT * FROM folder WHERE id = ?', parentId);
      if (!parent) throw new ApiFailure('E_NOT_FOUND', '父文件夹不存在');
      if (parent.workspace_id !== workspaceId) throw new ApiFailure('E_VALIDATION', '父文件夹不在同一工作区');
      if (parent.parent_id) throw new ApiFailure('E_VALIDATION', '目录层级最多两层，不能再建子文件夹');
    }
    if (!get<Row>('SELECT id FROM workspace WHERE id = ?', workspaceId)) {
      throw new ApiFailure('E_NOT_FOUND', '工作区不存在');
    }

    const id = newId('f');
    const maxOrder = Number((get<Row>(
      'SELECT COALESCE(MAX(sort_order), 0) AS m FROM folder WHERE workspace_id = ? AND kind = ?',
      workspaceId, kind,
    ))?.m ?? 0);
    run(
      `INSERT INTO folder (id,workspace_id,kind,parent_id,name,collapsed,sort_order,created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      id, workspaceId, kind, parentId, name, 0, maxOrder + 1, nowIso(),
    );
    writeAudit({
      workspaceId, actor: (await identity(req)).name, source: 'user',
      action: 'folder.create', target: name, result: '成功', severity: 'info',
      detail: `新建${kind === 'asset' ? '资产' : '会话'}文件夹「${name}」${parentId ? ` 于 ${parentId} 下` : ''}`,
    });
    const row = requireRow(get<Row>('SELECT * FROM folder WHERE id = ?', id), '文件夹');
    ok(res, {
      id: row.id, workspaceId: row.workspace_id, kind: row.kind, name: row.name,
      parentId: row.parent_id ?? null, depth: row.parent_id ? 2 : 1,
      collapsed: false, sortOrder: Number(row.sort_order), count: 0,
    });
  }));
  app.post('/api/folders/reorder', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(folderReorderSchema, req);
    const ids = Array.isArray(payload.ids) ? (payload.ids as unknown[]) : [];
    /* forEach + await 是发射后不管，顺序也不保证；排序是写操作，逐个 await 才是对的。 */
    for (const [index, value] of ids.entries()) {
      if (typeof value === 'string') run('UPDATE folder SET sort_order = ? WHERE id = ?', index, value);
    }
    ok(res, { ok: true });
  }));
  app.patch('/api/folders/:id', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const existing = requireRow(get<Row>('SELECT * FROM folder WHERE id = ?', id), '文件夹');
    const patch = parseBody(folderPatchSchema, req);
    if (typeof patch.name === 'string') {
      const name = patch.name.trim();
      if (!name) throw new ApiFailure('E_VALIDATION', '文件夹名称不能为空');
      run('UPDATE folder SET name = ? WHERE id = ?', name, id);
    }
    /* 折叠状态必须落库：否则切项目 / 重进应用抽屉全弹开，用户整理好的结构白做。 */
    if (typeof patch.collapsed === 'boolean') {
      run('UPDATE folder SET collapsed = ? WHERE id = ?', patch.collapsed ? 1 : 0, id);
    }
    if ('parentId' in patch) {
      const parentId = optionalId(patch.parentId);
      if (parentId === id) throw new ApiFailure('E_VALIDATION', '不能把自己设为父文件夹');
      if (parentId) {
        const parent = get<Row>('SELECT * FROM folder WHERE id = ?', parentId);
        if (!parent) throw new ApiFailure('E_NOT_FOUND', '父文件夹不存在');
        if (parent.parent_id) throw new ApiFailure('E_VALIDATION', '目录层级最多两层');
        /* 自己有子文件夹时不能再被挂到别人下面，否则会形成三层。 */
        if ((all<Row>('SELECT id FROM folder WHERE parent_id = ?', id)).length > 0) {
          throw new ApiFailure('E_VALIDATION', '该文件夹下还有子文件夹，不能再移动');
        }
      }
      run('UPDATE folder SET parent_id = ? WHERE id = ?', parentId, id);
    }
    const row = requireRow(get<Row>('SELECT * FROM folder WHERE id = ?', id), '文件夹');
    const renamed = typeof patch.name === 'string' && patch.name.trim() !== String(existing.name);
    if (renamed || typeof patch.collapsed === 'boolean') {
      writeAudit({
        workspaceId: String(row.workspace_id), actor: (await identity(req)).name, source: 'user',
        action: 'folder.update', target: String(row.name), result: '成功', severity: 'info',
        detail: renamed ? `文件夹重命名：${String(existing.name)} → ${String(row.name)}` : `文件夹折叠状态改为 ${Number(row.collapsed) === 1 ? '收起' : '展开'}`,
      });
    }
    ok(res, {
      id: row.id, workspaceId: row.workspace_id, kind: row.kind, name: row.name,
      parentId: row.parent_id ?? null, depth: row.parent_id ? 2 : 1,
      collapsed: Number(row.collapsed) === 1, sortOrder: Number(row.sort_order), count: 0,
    });
  }));
  app.delete('/api/folders/:id', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const folder = requireRow(get<Row>('SELECT * FROM folder WHERE id = ?', id), '文件夹');
    const affectedAssets = (all<Row>('SELECT id FROM asset WHERE folder_id = ?', id)).length;
    const affectedConvs = (all<Row>('SELECT id FROM conversation WHERE folder_id = ?', id)).length;
    /* 子文件夹不跟着删（用户没说要删内容），上提到被删文件夹的父级，避免变成孤儿。 */
    const movedToParentId = optionalId(folder.parent_id);
    run('UPDATE folder SET parent_id = ? WHERE parent_id = ?', movedToParentId, id);
    run('UPDATE asset SET folder_id = ? WHERE folder_id = ?', movedToParentId, id);
    run('UPDATE conversation SET folder_id = ? WHERE folder_id = ?', movedToParentId, id);
    run('DELETE FROM folder WHERE id = ?', id);
    writeAudit({
      workspaceId: String(folder.workspace_id), actor: (await identity(req)).name, source: 'user',
      action: 'folder.delete', target: String(folder.name), result: '成功', severity: 'warn',
      detail: `删除文件夹「${String(folder.name)}」· ${affectedAssets} 个资产 / ${affectedConvs} 个会话上提到${movedToParentId ? '父级' : '根'}`,
    });
    ok(res, { movedToParentId, affected: affectedAssets + affectedConvs });
  }));
  app.post('/api/items/move', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(itemsMoveSchema, req);
    const table = payload.kind === 'conversation' ? 'conversation' : 'asset';
    const targetFolderId = optionalId(payload.targetFolderId);
    const itemId = String(payload.itemId ?? '');
    if (targetFolderId) {
      const folder = get<Row>('SELECT * FROM folder WHERE id = ?', targetFolderId);
      if (!folder) throw new ApiFailure('E_NOT_FOUND', '目标文件夹不存在');
      if (String(folder.kind) !== String(payload.kind ?? 'conversation')) {
        throw new ApiFailure('E_VALIDATION', '目标文件夹类型不匹配');
      }
    }
    run(`UPDATE ${table} SET folder_id = ? WHERE id = ?`, targetFolderId, itemId);
    writeAudit({
      /* 移动条目属于「当前工作区」的动作：请求没声明就记全局，不伪装成 w-ops。 */
      workspaceId: workspaceGuard(req) || AUDIT_GLOBAL_SCOPE, actor: (await identity(req)).name, source: 'user',
      action: 'item.move', target: itemId, result: '成功', severity: 'info',
      detail: targetFolderId ? `移动到文件夹 ${targetFolderId}` : '移出文件夹',
    });
    ok(res, { ok: true });
  }));

  /* ---------------- G3 资产 / 能力 / 凭据 ---------------- */
}
