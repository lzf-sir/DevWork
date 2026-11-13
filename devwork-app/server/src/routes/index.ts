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

/** git / docker 可用性探测，结果缓存（进程生命周期内不变）。 */
let toolProbeCache: { git: boolean; docker: boolean } | null = null;
function probeTools(): { git: boolean; docker: boolean } {
  if (toolProbeCache) return toolProbeCache;
  const canRun = (bin: string, args: string[]): boolean => {
    try {
      execFileSync(bin, args, { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  };
  toolProbeCache = {
    git: canRun('git', ['--version']),
    docker: canRun('docker', ['--version']),
  };
  return toolProbeCache;
}

function body(req: Request): Row {
  return (req.body ?? {}) as Row;
}

/** 只把字符串当作可选 id，其余一律 null，避免把未知类型写进 SQLite。 */
function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function assertWorkspace(resourceWorkspaceId: string, requested: string): void {
  if (requested && requested !== resourceWorkspaceId) {
    throw new ApiFailure('E_WORKSPACE_MISMATCH', `资源不属于工作区 ${requested}（实际 ${resourceWorkspaceId}）`);
  }
}

function workspaceGuard(req: Request): string {
  return queryString(req, 'workspaceId');
}

function requireRow<T>(value: T | undefined | null, label: string): T {
  if (!value) throw new ApiFailure('E_NOT_FOUND', `${label}不存在`);
  return value;
}

/**
 * 合并 query + body 作为筛选参数，body 优先。
 * POST /api/audit/export 由 client.ts 用 body 传 AuditQuery，GET 系列用 query。
 */
function requestParams(req: Request): Row {
  const fromQuery = (req.query ?? {}) as Row;
  const payload = req.body;
  const fromBody: Row = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Row)
    : {};
  return { ...fromQuery, ...fromBody };
}

function paramString(params: Row, key: string): string {
  const value = params[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 校验 /api/assets/:id/* 的资产存在性 + 工作区归属，杜绝未知 id 伪造数据。 */
async function requireAssetId(req: Request): Promise<string> {
  const id = String(req.params.id);
  const row = get<{ workspace_id: string }>('SELECT workspace_id FROM asset WHERE id = ?', id);
  requireRow(row, '资产');
  assertWorkspace(String(row?.workspace_id ?? ''), workspaceGuard(req));
  return id;
}

const AUDIT_MAX_ROWS = 5000;

/**
 * 审计筛选条件的唯一构造处。
 *
 * 列表分页和 CSV 导出都走这里 —— 之前导出用的是另一套"全量"查询，
 * 用户筛了"策略变更"导出来却是全部，属于会让人做错决策的偏差。
 */
function auditFilter(req: Request): { where: string; params: string[] } {
  const params = requestParams(req);
  const conditions: string[] = [];
  const paramsOut: string[] = [];
  const actor = paramString(params, 'actor');
  const assetId = paramString(params, 'assetId');
  const action = paramString(params, 'action');
  const result = paramString(params, 'result');
  const from = paramString(params, 'from');
  const to = paramString(params, 'to');
  const category = paramString(params, 'category');
  /* 分类筛选在服务端做：前端只传 category，导出 CSV 也能复用同一口径。 */
  if (category) {
    const condition = auditCategoryCondition(category);
    conditions.push(condition.sql);
    paramsOut.push(...condition.params);
  }
  if (actor) { conditions.push('actor LIKE ?'); paramsOut.push(`%${actor}%`); }
  if (assetId) { conditions.push('target LIKE ?'); paramsOut.push(`%${assetId}%`); }
  if (action) { conditions.push('action LIKE ?'); paramsOut.push(`%${action}%`); }
  if (result) { conditions.push('result = ?'); paramsOut.push(result); }
  if (from) { conditions.push('created_at >= ?'); paramsOut.push(from); }
  if (to) { conditions.push('created_at <= ?'); paramsOut.push(to); }
  return { where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '', params: paramsOut };
}

async function auditRows(req: Request): Promise<Row[]> {
  const { where, params } = auditFilter(req);
  const rows = all<Row>(
    `SELECT * FROM audit_event ${where} ORDER BY created_at DESC, id DESC LIMIT ${AUDIT_MAX_ROWS}`,
    ...params,
  );
  return rows.map(auditShape);
}

/** 真实命中总数：不能拿"截断后的行数"冒充 total，那会让分页页码说谎。 */
async function auditTotal(req: Request): Promise<number> {
  const { where, params } = auditFilter(req);
  const row = get<Row>(`SELECT COUNT(*) AS n FROM audit_event ${where}`, ...params);
  return Number(row?.n ?? 0);
}

/** 导出达到上限时必须说清楚，不能让用户以为拿到了全量。 */
function exportDetail(exported: number, total: number): string {
  if (exported >= AUDIT_MAX_ROWS && total > exported) {
    return `导出 ${exported} 条审计记录（CSV，已达单次上限 ${AUDIT_MAX_ROWS}，服务端共命中 ${total} 条）`;
  }
  return `导出 ${exported} 条审计记录（CSV，服务端共命中 ${total} 条）`;
}

/** Excel on Windows 直接打开中文 CSV 需要 UTF-8 BOM + CRLF。 */
function csvFromAudit(rows: Row[]): string {
  const header = '时间,操作人,来源,动作,对象,结果,级别,详情';
  const lines = [
    header,
    ...rows.map((row) => [
      row.createdAtLabel, row.actor, row.source, row.action, row.target,
      row.result, row.severity, row.detail,
    ].map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')),
  ];
  return `\uFEFF${lines.join('\r\n')}`;
}

/** 注册全部 G0–G11 路由。 */
export function registerRoutes(app: Express): void {
  /* ---------------- G0 系统 / 引导 ---------------- */
  app.get('/api/health', (_req, res) => {
    const driver = detectDriver();
    const tools = probeTools();
    ok(res, {
      status: driver === 'none' ? 'degraded' : 'ok',
      node: process.version,
      driver,
      wal: hasWal(),
      version: '0.4.2',
      gitAvailable: tools.git,
      dockerAvailable: tools.docker,
      port: PORT,
      time: new Date().toISOString(),
    });
  });

  app.get('/api/bootstrap', wrap(async (req: Request, res: Response) => {
    /* C1：默认项目（gen.g1）真实生效 —— 前端不带 workspaceId 启动时，
     * 按设置页选的项目名解析初始工作区；找不到或未配置回落 w-ops。 */
    const gen = await settingRaw('gen');
    const defaultWs = await (async () => {
      const name = String(gen.g1 ?? '').trim();
      if (!name) return '';
      const row = get<Row>('SELECT id FROM workspace WHERE name = ?', name);
      return row ? String(row.id) : '';
    })();
    const workspaceId = queryString(req, 'workspaceId', '') || defaultWs || 'w-ops';
    const ws = requireRow(await workspaceById(workspaceId), '工作区');
    const who = await identity(req);
    const sidebar = await sidebarShape(workspaceId);
    /* 启动恢复（gen.g4）：开启时回到最近一次有消息的会话；关闭则回到默认第一个。 */
    const restoreLast = gen.g4 !== false;
    const lastActiveId = get<Row>(
      `SELECT conversation_id AS id FROM message
       WHERE conversation_id IN (SELECT id FROM conversation WHERE workspace_id = ?)
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      workspaceId,
    );
    const currentConversationId = restoreLast && lastActiveId?.id
      ? String(lastActiveId.id)
      : String(sidebar.currentConversationId ?? 'c-gmv');
    ok(res, {
      workspaceId,
      workspaceName: ws.name,
      apiMode: 'live',
      readOnlyMode: await readOnlyMode(),
      workspace: ws,
      sidebar,
      currentConversationId,
      messages: await listMessageCards(currentConversationId),
      panels: await allPanels(currentConversationId),
      context: await panelShape(currentConversationId, 'context'),
      execution: await panelShape(currentConversationId, 'execution'),
      artifacts: await panelShape(currentConversationId, 'artifacts'),
      statusBar: await statusBarShape(currentConversationId),
    });
  }));

  /* ---------------- G1 工作区 / 侧栏 / 状态栏 ---------------- */
  app.get('/api/workspaces', async (_req, res) => ok(res, await listWorkspaces()));
  app.post('/api/workspaces', wrap(async (req: Request, res: Response) => {
    const name = String(body(req).name ?? '').trim();
    if (!name) throw new ApiFailure('E_VALIDATION', 'name 必须是非空字符串');
    const id = newId('w');
    run(
      `INSERT INTO workspace (id,name,description,index_progress,assets_count,conversations_count,owner_label,recent_label,trust_level,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, name, String(body(req).description ?? ''), 0, 0, 0, '仅我', '刚刚', 'normal', nowIso(),
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
    const patch = body(req);
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
  app.get('/api/sidebar', wrap(async (req: Request, res: Response) => {
    const workspaceId = queryString(req, 'workspaceId', 'w-ops');
    requireRow(await workspaceById(workspaceId), '工作区');
    ok(res, await sidebarShape(workspaceId));
  }));
  app.get('/api/status-bar', wrap(async (req: Request, res: Response) => {
    ok(res, await statusBarShape(queryString(req, 'conversationId', '') || undefined));
  }));

  /* ---------------- G2 文件夹 ---------------- */
  app.get('/api/folders', wrap(async (req: Request, res: Response) => {
    const workspaceId = queryString(req, 'workspaceId', 'w-ops');
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
    const payload = body(req);
    const workspaceId = String(payload.workspaceId ?? 'w-ops');
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
    const ids = Array.isArray(body(req).ids) ? (body(req).ids as unknown[]) : [];
    /* forEach + await 是发射后不管，顺序也不保证；排序是写操作，逐个 await 才是对的。 */
    for (const [index, value] of ids.entries()) {
      if (typeof value === 'string') run('UPDATE folder SET sort_order = ? WHERE id = ?', index, value);
    }
    ok(res, { ok: true });
  }));
  app.patch('/api/folders/:id', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const existing = requireRow(get<Row>('SELECT * FROM folder WHERE id = ?', id), '文件夹');
    const patch = body(req);
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
    const payload = body(req);
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
      workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: 'item.move', target: itemId, result: '成功', severity: 'info',
      detail: targetFolderId ? `移动到文件夹 ${targetFolderId}` : '移出文件夹',
    });
    ok(res, { ok: true });
  }));

  /* ---------------- G3 资产 / 能力 / 凭据 ---------------- */
  app.get('/api/assets', wrap(async (req: Request, res: Response) => {
    const workspaceId = queryString(req, 'workspaceId', 'w-ops');
    const type = queryString(req, 'type');
    const rows = type
      ? all<Row>('SELECT * FROM asset WHERE workspace_id = ? AND type = ?', workspaceId, type)
      : all<Row>('SELECT * FROM asset WHERE workspace_id = ?', workspaceId);
    ok(res, rows.map((a) => ({
      id: a.id, workspaceId: a.workspace_id, type: a.type, name: a.name, env: a.env,
      status: a.status, indexProgress: Number(a.index_progress),
      credentialBound: Number(a.credential_bound) === 1,
    })));
  }));
  app.post('/api/assets', wrap(async (req: Request, res: Response) => {
    const payload = body(req);
    const id = newId('a');
    const workspaceId = String(payload.workspaceId ?? 'w-ops');
    const type = String(payload.type ?? 'code');
    const name = String(payload.name ?? '新资产').trim();
    if (!name) throw new ApiFailure('E_VALIDATION', '资产名称不能为空');
    /* 诚实状态：刚建的资产既没绑凭据也没建索引，写 online/100% 就是编造。
     * 置 idle + 0% + 未绑定，侧栏会自动显示「待验证」灰点，等用户真去绑定/索引。 */
    /* 代码库的「连接参数」语义是仓库地址 → 存成 cloneUrl，后续克隆流程直接复用。 */
    const endpoint = String(payload.endpoint ?? '').trim();
    /* 客户端提交的 config 必须过服务端白名单：按键白名单 + 敏感键拒绝 + 值形状与长度有界。
     * 前端那层是体验，这层是安全 —— 前端可能被绕过（改包、直接调 API），这层必须独立挡得住。 */
    const submitted = sanitizeAssetConfig(type, payload.config);
    const assetConfig: Record<string, unknown> = { ...submitted };
    /* endpoint 保留：侧栏副标题与历史数据按这个键读，新表单改结构化存储后不能把老路径断了。 */
    if (endpoint) assetConfig.endpoint = endpoint;
    if (type === 'code' && endpoint) assetConfig.cloneUrl = endpoint;
    run(
      `INSERT INTO asset (id,workspace_id,folder_id,type,name,env,status,index_progress,credential_bound,subtitle,config,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, workspaceId, optionalId(payload.folderId), type, name, String(payload.env ?? ''),
      'idle', 0, 0, String(payload.subtitle ?? ''), JSON.stringify(assetConfig), nowIso(),
    );
    const who = await identity(req);
    /* 凭据：接入时一并录入 —— 用户不必创建完再去「能力授权」页补一次。
     * 秘密经 safeStorage 加密存本机，库里只留 secret_ref；鉴权方式与账号名存普通列。 */
    const rawCredential = payload.credential;
    const credential = rawCredential && typeof rawCredential === 'object' && !Array.isArray(rawCredential)
      ? rawCredential as Record<string, unknown>
      : null;
    let credentialBound = false;
    let credentialError = '';
    if (credential) {
      const label = String(credential.label ?? '').trim();
      if (!label) {
        credentialError = '凭据标签为空，未绑定';
      } else {
        try {
          await bind(id, {
            label,
            secret: String(credential.secret ?? ''),
            username: String(credential.username ?? ''),
            authMethod: String(credential.method ?? ''),
          }, who);
          credentialBound = true;
        } catch (error) {
          /* 绑定失败不能吞掉：资产已建好，但要说清凭据没绑上、为什么。 */
          credentialError = error instanceof ApiFailure ? error.message : '凭据绑定失败';
          writeAudit({
            workspaceId, actor: who.name, source: 'user',
            action: 'credential.bind', target: name, result: '失败', severity: 'warn',
            detail: `接入时绑定凭据失败：${credentialError}`,
          });
        }
      }
    }
    writeAudit({
      workspaceId, actor: who.name, source: 'user',
      action: 'asset.create', target: name, result: '成功', severity: 'info',
      /* 审计只记配置项的**键名**，不记值 —— 值里可能有主机名、库名这类不该进审计的细节。
       * 凭据同理：只记「绑没绑上」，绝不记账号口令。 */
      detail: `接入 ${type} 资产 ${name} · `
        + (credentialBound ? '凭据已绑定' : '凭据未绑定')
        + ' / 索引未建立（本地沙箱不探测远端连通性）'
        + (Object.keys(assetConfig).length > 0
          ? ` · 配置项：${Object.keys(assetConfig).join('、')}`
          : ''),
    });
    ok(res, {
      id, workspaceId, type, name, status: 'idle',
      credentialBound,
      credentialError: credentialError || undefined,
    });
  }));
  app.post('/api/assets/:id/index/progress', wrap(async (req: Request, res: Response) => {
    const id = await requireAssetId(req);
    /* B15：代码资产触发真实索引管线（扫仓库 → 分块 → FTS5），不再模拟进度。 */
    const type = String((get<{ type: string }>('SELECT type FROM asset WHERE id = ?', id))?.type ?? '');
    if (type === 'code') {
      const result = await runIndex(id);
      run('UPDATE asset SET index_progress = ?, status = ? WHERE id = ?', 100, 'online', id);
      const who = await identity(req);
      writeAudit({
        workspaceId: 'w-ops', actor: who.name, source: 'user',
        action: 'index.run', target: id, result: '成功', severity: 'info',
        detail: `扫描 ${result.files} 个文件 · 生成 ${result.chunks} 个索引块（FTS5）`,
      });
      ok(res, { indexProgress: 100, status: 'online', chunks: result.chunks, files: result.files });
      return;
    }
    /* 知识库同理：真扫 docs/ 重建 doc 块，而不是把进度条推到 100% 假装索引好了。 */
    if (type === 'kb') {
      const result = await runDocIndex(id);
      run('UPDATE asset SET index_progress = ?, status = ? WHERE id = ?', 100, 'online', id);
      writeAudit({
        workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
        action: 'index.run', target: id, result: '成功', severity: 'info',
        detail: `重建知识库索引：${result.files} 个文档 / ${result.chunks} 个片段`,
      });
      ok(res, { indexProgress: 100, status: 'online', chunks: result.chunks, files: result.files });
      return;
    }
    const current = Number((get<{ index_progress: number }>('SELECT index_progress FROM asset WHERE id = ?', id))?.index_progress ?? 0);
    const to = typeof body(req).to === 'number' ? Number(body(req).to) : Math.min(100, current + Number(body(req).delta ?? 10));
    run('UPDATE asset SET index_progress = ?, status = ? WHERE id = ?', to, to >= 100 ? 'online' : 'indexing', id);
    ok(res, { indexProgress: to, status: to >= 100 ? 'online' : 'indexing' });
  }));
  /* 知识库文档清单：只统计 kind='doc' 的索引块，行数从磁盘真实文件数出来。 */
  app.get('/api/assets/:id/documents', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const rows = all<Row>(
      `SELECT path, COUNT(*) AS chunks, MIN(start_line) AS first_line, MAX(end_line) AS last_line
       FROM index_chunk WHERE asset_id = ? AND kind = 'doc'
       GROUP BY path ORDER BY path`,
      assetId,
    );
    /* readContent 要读磁盘，必须逐个 await：map 里写 await 会并发读文件且顺序不可控。 */
    const files: Array<{ path: string; name: string; chunks: number; lines: number; firstLine: number; lastLine: number }> = [];
    for (const row of rows) {
      const filePath = String(row.path);
      /* 文档行数取自磁盘真实文件；资产仓库根缺失时不编造行数。 */
      let lineCount = 0;
      try {
        const content = await readContent(assetId, filePath);
        lineCount = content.plain ? content.plain.split(/\r?\n/).length : 0;
      } catch {
        lineCount = 0;
      }
      files.push({
        path: filePath,
        name: filePath.split('/').pop() ?? filePath,
        chunks: Number(row.chunks),
        lines: lineCount,
        firstLine: Number(row.first_line),
        lastLine: Number(row.last_line),
      });
    }
    ok(res, { files, documents: files.length, chunks: files.reduce((sum, file) => sum + file.chunks, 0) });
  }));
  app.get('/api/assets/:id/activities', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const name = String((get<{ name: string }>('SELECT name FROM asset WHERE id = ?', assetId))?.name ?? '');
    const rows = all<Row>('SELECT * FROM audit_event WHERE target LIKE ? ORDER BY created_at DESC LIMIT 20', `%${name}%`);
    ok(res, rows.map((a) => ({ id: a.id, createdAt: a.created_at, createdAtLabel: a.created_at_label, text: `${a.action} · ${a.result}` })));
  }));
  app.get('/api/assets/:id/capabilities', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, (all<Row>('SELECT * FROM asset_capability WHERE asset_id = ? ORDER BY id', assetId)).map((c) => ({
      id: c.id, name: c.capability, description: c.description,
      granted: Number(c.granted) === 1, locked: Number(c.locked) === 1, approval: c.approval,
    })));
  }));
  app.patch('/api/assets/:id/capabilities/:capId', wrap(async (req: Request, res: Response) => {
    await requireAssetId(req);
    const patch = body(req);
    if (typeof patch.granted === 'boolean') {
      run('UPDATE asset_capability SET granted = ? WHERE id = ? AND asset_id = ?', patch.granted ? 1 : 0, req.params.capId, req.params.id);
    }
    if (typeof patch.approval === 'string') {
      run('UPDATE asset_capability SET approval = ? WHERE id = ? AND asset_id = ?', patch.approval, req.params.capId, req.params.id);
    }
    const row = requireRow(get<Row>('SELECT * FROM asset_capability WHERE id = ?', req.params.capId), '能力');
    ok(res, { id: row.id, name: row.capability, description: row.description, granted: Number(row.granted) === 1, locked: Number(row.locked) === 1, approval: row.approval });
  }));
  /* B21：前端 searchAsset 走 GET ?q=（与后端 POST body 同一实现），修复方法不匹配导致的 404 降级。 */
  app.get('/api/assets/:id/search', wrap(async (req: Request, res: Response) => {
    ok(res, searchIndex(await requireAssetId(req), queryString(req, 'q')));
  }));
  app.post('/api/assets/:id/search', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const query = String(body(req).query ?? queryString(req, 'q'));
    /* B15：FTS5 全文检索（降级 LIKE），命中真实仓库分块。 */
    ok(res, searchIndex(assetId, query));
  }));
  app.get('/api/assets/:id/credential', wrap(async (req: Request, res: Response) => {
    ok(res, await credentialShape(await requireAssetId(req)));
  }));
  app.post('/api/assets/:id/credential/bind', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    /* B17：secret 走 IPC → safeStorage 加密落本机；DB 只存引用。 */
    ok(res, await bind(assetId, {
      label: String(body(req).label ?? ''),
      secret: String(body(req).secret ?? ''),
      username: String(body(req).username ?? ''),
      authMethod: String(body(req).method ?? ''),
    }, await identity(req)));
  }));
  app.post('/api/assets/:id/credential/renew', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await renew(assetId, await identity(req)));
  }));
  app.post('/api/assets/:id/credential/revoke', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await revoke(assetId, await identity(req)));
  }));
  app.get('/api/assets/:id', wrap(async (req: Request, res: Response) => {
    const row = get<{ workspace_id: string }>('SELECT workspace_id FROM asset WHERE id = ?', req.params.id);
    requireRow(row, '资产');
    assertWorkspace(String(row?.workspace_id ?? ''), workspaceGuard(req));
    ok(res, requireRow(await assetDetailShape(String(req.params.id)), '资产'));
  }));
  app.patch('/api/assets/:id', wrap(async (req: Request, res: Response) => {
    const id = await requireAssetId(req);
    const patch = body(req);
    if (typeof patch.name === 'string') run('UPDATE asset SET name = ? WHERE id = ?', patch.name, id);
    if (typeof patch.env === 'string') run('UPDATE asset SET env = ? WHERE id = ?', patch.env, id);
    ok(res, { id, ...patch });
  }));
  app.delete('/api/assets/:id', wrap(async (req: Request, res: Response) => {
    const id = await requireAssetId(req);
    /* 级联清理：asset_connection / credential_binding / asset_capability 有
     * REFERENCES asset(id) 外键（foreign_keys=ON），不先删子行主行删除会直接炸；
     * index_chunk / terminal_session / command_history 无外键但属于该资产的衍生物。 */
    run('DELETE FROM credential_binding WHERE asset_id = ?', id);
    run('DELETE FROM asset_connection WHERE asset_id = ?', id);
    run('DELETE FROM asset_capability WHERE asset_id = ?', id);
    run('DELETE FROM index_chunk WHERE asset_id = ?', id);
    run('DELETE FROM terminal_session WHERE asset_id = ?', id);
    run('DELETE FROM command_history WHERE asset_id = ?', id);
    run('DELETE FROM asset WHERE id = ?', id);
    writeAudit({
      workspaceId: workspaceGuard(req) || 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: 'asset.delete', target: id, result: '成功', severity: 'warn',
      detail: `资产 ${id} 已删除，索引 / 凭据绑定 / 终端会话一并清理`,
    });
    ok(res, { deleted: true });
  }));

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
    const payload = body(req);
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
    const payload = body(req);
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
    const payload = body(req);
    const mode = String(payload.mode ?? 'inclusive') === 'after' ? 'after' : 'inclusive';
    ok(res, await truncateMessages(String(req.params.id), String(payload.messageId ?? ''), mode));
  }));
  /* B16：SSE 流式端点 —— 逐事件推送（text_delta 增量 / tool_call / citation / conclusion），
   * 结束时推送 { type:'result', result: TurnResult }，与一次性端点同一持久化语义。 */
  app.post('/api/conversations/:id/stream', async (req: Request, res: Response) => {
    const payload = body(req);
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
    const payload = body(req);
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
    const scope = String(body(req).scope ?? 'once') === 'session' ? 'session' : 'once';
    ok(res, await respondApproval(String(req.params.id), String(req.params.messageId),
      String(body(req).decision ?? 'deny') === 'approve' ? 'approve' : 'deny', (await identity(req)).name, scope));
  }));
  app.post('/api/approvals/:messageId', wrap(async (req: Request, res: Response) => {
    const scope = String(body(req).scope ?? 'once') === 'session' ? 'session' : 'once';
    ok(res, await respondApproval(String(body(req).conversationId ?? 'c-gmv'), String(req.params.messageId),
      String(body(req).decision ?? 'deny') === 'approve' ? 'approve' : 'deny', (await identity(req)).name, scope));
  }));
  /* 回滚端点（V2 写能力层的 rollback 闸门）：按审批卡 payload.rollbackRef 分派。 */
  app.post('/api/conversations/:id/approvals/:messageId/rollback', wrap(async (req: Request, res: Response) => {
    ok(res, await rollbackApproval(String(req.params.id), String(req.params.messageId), (await identity(req)).name));
  }));
  app.post('/api/approvals/:messageId/rollback', wrap(async (req: Request, res: Response) => {
    ok(res, await rollbackApproval(String(body(req).conversationId ?? 'c-gmv'), String(req.params.messageId), (await identity(req)).name));
  }));
  app.post('/api/conversations/:id/command-suggestions', wrap(async (req: Request, res: Response) => {
    ok(res, await createCommandSuggestion(String(req.params.id), {
      command: String(body(req).command ?? ''), reason: String(body(req).reason ?? ''),
    }));
  }));
  app.post('/api/command-suggestions', wrap(async (req: Request, res: Response) => {
    ok(res, await createCommandSuggestion(String(body(req).conversationId ?? 'c-gmv'), {
      command: String(body(req).command ?? ''), reason: String(body(req).reason ?? ''),
    }));
  }));
  app.patch('/api/conversations/:id', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const payload = body(req);
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
    /* B13：无 usage_stat 行时按消息内容估算（中文约 2 字符/token），不再写死假值。 */
    const messages = all<Row>('SELECT payload FROM message WHERE conversation_id = ?', req.params.id);
    const chars = messages.reduce((sum, m) => sum + String(m.payload ?? '').length, 0);
    const contextBudget = 204800;
    ok(res, {
      contextUsed: Math.round(chars / 2),
      contextBudget,
      costCny: Number((messages.length * 0.03).toFixed(2)),
      model: 'Claude-Sonnet',
    });
  }));
  app.get('/api/artifacts/:id/download', wrap(async (req: Request, res: Response) => {
    const row = get<Row>('SELECT * FROM artifact WHERE id = ? OR file_name = ?', req.params.id, req.params.id);
    const fileName = String(row?.file_name ?? 'gmv_trend.png');
    bootstrapArtifacts();
    ok(res, {
      url: `/api/artifacts/file/${encodeURIComponent(fileName)}`,
      fileName,
      sizeBytes: artifactSize(fileName) || Number(row?.size_bytes ?? 0),
    });
  }));

  /* 产物预览（右栏「文件」Tab）：文本给内容、图片给可直连 URL、二进制只给元信息。
   * 沙箱不解析二进制 —— 遇到 docx/pdf 这类只如实说"不可内联预览"，不编造内容。 */
  app.get('/api/artifacts/:id/preview', wrap(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const row = get<Row>('SELECT * FROM artifact WHERE id = ? OR file_name = ?', id, id);
    bootstrapArtifacts();
    const fileName = String(row?.file_name ?? id);
    const sizeBytes = artifactSize(fileName);
    if (sizeBytes === 0) {
      fail(res, 'E_NOT_FOUND', '产物文件不存在', 404);
      return;
    }
    const ext = path.extname(fileName).toLowerCase();
    const textExt = new Set(['.txt', '.md', '.json', '.csv', '.log', '.yaml', '.yml', '.xml', '.html', '.htm', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.sql', '.sh']);
    const imageExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
    const mimeByExt: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      '.txt': 'text/plain;charset=utf-8', '.md': 'text/markdown;charset=utf-8', '.json': 'application/json;charset=utf-8',
      '.csv': 'text/csv;charset=utf-8', '.html': 'text/html;charset=utf-8', '.htm': 'text/html;charset=utf-8',
    };
    /* 预览用内联 URL（?inline=1）：<img> / PDF iframe 都能直接渲染，下载走 /download 端点。 */
    const downloadUrl = `/api/artifacts/file/${encodeURIComponent(fileName)}?inline=1`;
    if (imageExt.has(ext)) {
      ok(res, {
        fileName,
        sizeBytes,
        mime: mimeByExt[ext] ?? 'application/octet-stream',
        kind: 'image',
        url: downloadUrl,
        conversationId: row?.conversation_id ? String(row.conversation_id) : undefined,
      });
      return;
    }
    if (textExt.has(ext)) {
      /* 文本上限 200KB：超了只给前 200KB 并如实标注截断。 */
      const limit = 200 * 1024;
      let content = '';
      try {
        content = fs.readFileSync(artifactPath(fileName), 'utf8');
      } catch (error) {
        fail(res, 'E_READ_FAILED', `读取失败：${error instanceof Error ? error.message : String(error)}`, 500);
        return;
      }
      const truncated = content.length > limit;
      ok(res, {
        fileName,
        sizeBytes,
        mime: mimeByExt[ext] ?? 'text/plain;charset=utf-8',
        kind: 'text',
        content: truncated ? content.slice(0, limit) : content,
        url: downloadUrl,
        conversationId: row?.conversation_id ? String(row.conversation_id) : undefined,
      });
      return;
    }
    ok(res, {
      fileName,
      sizeBytes,
      mime: 'application/octet-stream',
      kind: 'binary',
      url: downloadUrl,
      conversationId: row?.conversation_id ? String(row.conversation_id) : undefined,
    });
  }));

  /* 内置浏览器：会话级当前地址。GET 供前端轮询（Agent 导航后跳转），
   * POST 供用户手动导航同步（Agent 才知道浏览器现在停在哪一页）。 */
  app.get('/api/conversations/:id/browser', wrap(async (req: Request, res: Response) => {
    ok(res, await readBrowserState(String(req.params.id)));
  }));
  app.post('/api/conversations/:id/browser', wrap(async (req: Request, res: Response) => {
    const normalized = normalizeBrowserUrl(body(req).url, { allowPrivate: true });
    if (!normalized.ok) {
      fail(res, 'E_INVALID_URL', normalized.reason ?? '地址不合法', 422);
      return;
    }
    ok(res, await writeBrowserState(String(req.params.id), normalized.url ?? '', 'user'));
  }));

  /* 页面快照：前端把当前页标题与正文回传，Agent 的 browser_read_page 读它。
   * 这是"Agent 能控制浏览器"的读侧 —— 只导航不看，等于盲飞。 */
  app.get('/api/conversations/:id/browser/page', wrap(async (req: Request, res: Response) => {
    ok(res, await readBrowserPage(String(req.params.id)));
  }));
  app.post('/api/conversations/:id/browser/page', wrap(async (req: Request, res: Response) => {
    const title = String(body(req).title ?? '').slice(0, 300);
    const text = String(body(req).text ?? '').slice(0, 20000);
    ok(res, await writeBrowserPage(String(req.params.id), title, text));
  }));

  /* ---------------- G6 终端 ---------------- */
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
    ok(res, { id: req.params.sid, assetId, cwd: String(body(req).cwd ?? cwd), createdAt: nowIso() });
  }));
  app.delete('/api/assets/:id/terminal/sessions/:sid', wrap(async (req: Request, res: Response) => {
    await requireAssetId(req);
    run('DELETE FROM terminal_session WHERE id = ?', req.params.sid);
    ok(res, { closed: true });
  }));
  app.post('/api/assets/:id/terminal/execute', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const result = await executeCommand(assetId, {
      sessionId: String(body(req).sessionId ?? 'sess-1'),
      command: String(body(req).command ?? ''),
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
  app.get('/api/skills', wrap(async (req: Request, res: Response) => {
    const problems = validateSkillRegistry();
    if (problems.length > 0) {
      throw new ApiFailure('E_INTERNAL', `技能登记表自检失败：${problems.join('；')}`);
    }
    /* 可用性判据（设计 §4）：requiresAssets ⊆ 工作区现有资产类型；
     * 缺失时返回 available:false + missing，前端显示「不可用」而非隐藏。 */
    const workspaceId = queryString(req, 'workspaceId', 'w-ops');
    const types = (all<Row>(
      'SELECT DISTINCT type FROM asset WHERE workspace_id = ?', workspaceId,
    )).map((row) => String(row.type));
    ok(res, SKILL_REGISTRY.map((skill) => skillShape(skill, types)));
  }));

  /* ---------------- 派生工具面 / 命令模板库（诊断与模型自描述） ---------------- */
  app.get('/api/tools', wrap(async (req: Request, res: Response) => {
    const workspaceId = queryString(req, 'workspaceId', 'w-ops');
    const face = await deriveToolFace(workspaceId);
    /* 精简形态：entry/schema 全量对象对诊断 UI 是噪音，只留契约字段（前端 ToolFaceTool）。 */
    const lean = (tool: typeof face.all[number]) => ({
      name: tool.name,
      assetId: tool.assetId,
      assetName: tool.assetName,
      assetEnv: tool.assetEnv,
      risk: tool.risk,
      gatedBy: tool.gatedBy,
      description: tool.entry.description,
      version: tool.entry.version,
    });
    ok(res, {
      workspaceId: face.workspaceId,
      workspaceTrust: face.workspaceTrust,
      all: face.all.map(lean),
      active: face.active.map(lean),
      derivationRules: face.derivationRules,
    });
  }));
  app.get('/api/cmd-templates', (_req, res) => {
    ok(res, CMD_TEMPLATES.map((template) => ({
      id: template.id, version: template.version, intent: template.intent, action: template.action,
      params: template.params, precheck: template.precheck, verify: template.verify,
      rollback: template.rollback, risk: template.risk, impact: template.impact,
    })));
  });

  /* ---------------- G7 SQL ---------------- */
  app.post('/api/assets/:id/sql/query', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const payload = body(req);
    const options = (payload.options ?? {}) as Row;
    const result = await runSqlQuery(String(payload.sql ?? ''), {
      maxRows: typeof options.maxRows === 'number' ? Number(options.maxRows) : undefined,
      timeoutMs: typeof options.timeoutMs === 'number' ? Number(options.timeoutMs) : undefined,
    }, await identity(req), assetId);
    ok(res, result);
  }));
  /**
   * 表清单按资产返回。
   *
   * 之前完全忽略 :id —— 任何资产（甚至不存在的）都能拿到同一份 sql_table_meta，
   * 多库资产等于摆设。现在：非 db 资产直接 422；db 资产返回的表清单来自它实际
   * 连接的库（当前所有 db 资产共用同一个演示库，这一点必须显式告诉前端，
   * 而不是靠"看起来每个库都有表"来糊过去）。
   */
  app.get('/api/assets/:id/sql/schema', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const asset = requireRow(get<Row>('SELECT * FROM asset WHERE id = ?', assetId), '资产');
    if (String(asset.type) !== 'db') {
      throw new ApiFailure('E_ASSET_NOT_DB', `资产 ${assetId} 不是数据库类型，没有 SQL 表结构`, {
        assetId, type: String(asset.type),
      });
    }
    const db = demoDb();
    const labels = all<Row>('SELECT * FROM sql_table_meta');
    const sharedWith = (all<Row>("SELECT id FROM asset WHERE type = 'db'")).map((row) => String(row.id));
    /* 对象树来自 sqlite_master 实读：表 / 视图 / 索引分类 + 真实行数。
     * 之前只取 type='table'，视图和索引在 Navicat 式树里是独立节点，现在补上。 */
    const { nodes, schemas } = listObjects();
    const tables = nodes
      .filter((node) => node.kind === 'table' || node.kind === 'view')
      .map((node) => {
        const label = labels.find((item) => String(item.name) === node.name);
        return {
          name: node.name,
          schema: String(label?.schema_name ?? node.schema),
          kind: node.kind,
          /* 行数一律用 COUNT(*) 实读值。sql_table_meta.rows_label 是种子里的
           * 演示数字（如 "1.2M"），而演示库真实只有 8 行 —— 让假标签盖住
           * 真数字，用户点开一看对不上，整棵树就不可信了。
           * 种子标签只在真库确实读不到行数时才作为兜底。 */
          rowsLabel: node.rowsLabel,
          totalRows: node.totalRows,
        };
      });
    const indexes = nodes.filter((node) => node.kind === 'index');
    ok(res, {
      assetId,
      env: String(asset.env ?? ''),
      /* 共用库必须明说：否则用户会以为 dev / prod 是两套真实隔离的库。 */
      dbLabel: '演示库 demo.sqlite（沙箱内所有 db 资产共用同一份数据）',
      sharedWith,
      tables,
      indexes,
      schemas,
    });
  }));
  /**
   * 多格式导出（Navicat 式）：CSV / JSON / Markdown / SQL INSERT。
   * 格式走白名单，未知格式回落到 CSV —— 导出动作本身也要记审计。
   */
  app.post('/api/assets/:id/sql/export', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const payload = body(req);
    const format = String(payload.format ?? 'csv').toLowerCase();
    const result = await runSqlQuery(String(payload.sql ?? 'SELECT * FROM "order"'), {}, await identity(req), assetId);
    const columns = result.columnNames.length > 0 ? result.columnNames : result.columnsSimple;
    let content: string;
    let fileName: string;
    let mime: string;
    if (format === 'json') {
      content = toJson(columns, result.rows);
      fileName = 'query_result.json';
      mime = 'application/json;charset=utf-8';
    } else if (format === 'md') {
      content = toMarkdown(columns, result.rows);
      fileName = 'query_result.md';
      mime = 'text/markdown;charset=utf-8';
    } else if (format === 'sql') {
      content = toInsertScript('query_result', columns, result.rows);
      fileName = 'query_result.sql';
      mime = 'application/sql;charset=utf-8';
    } else {
      content = toCsv(result);
      fileName = 'query_result.csv';
      mime = 'text/csv;charset=utf-8';
    }
    const auditId = writeAudit({
      workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: 'sql.export', target: String(req.params.id), result: '放行', severity: 'info',
      detail: `导出 ${result.rowCount} 行 · 格式 ${format}`,
    });
    ok(res, { content, fileName, mime, format, auditId });
  }));
  /**
   * 字段详情（旧 structure 端点，保留别名兼容）。
   * 之前要查 sql_table_meta 才会认表 —— 演示库里存在但未登记的表直接 404，
   * 那是元数据表与真实库的耦合，不该有。现在直接 PRAGMA 实读。
   */
  app.get('/api/assets/:id/sql/tables/:table/structure', wrap(async (req: Request, res: Response) => {
    await requireAssetId(req);
    const table = safeTableName(String(req.params.table));
    const { columns, indexes, foreignKeys } = tableFields(table);
    ok(res, { columns, indexes, foreignKeys });
  }));
  /**
   * 表数据浏览（Navicat 式）：支持排序 + 筛选 + 分页。
   * 排序列与筛选列都必须命中该表真实列（白名单），筛选值参数化绑定。
   * 之前只有 LIMIT/OFFSET 且无排序，用户想看最新数据只能自己写 SQL。
   */
  app.get('/api/assets/:id/sql/tables/:table/rows', wrap(async (req: Request, res: Response) => {
    await requireAssetId(req);
    const table = safeTableName(String(req.params.table));
    const page = Math.max(1, Number(queryString(req, 'page', '1')) || 1);
    const pageSize = Math.min(500, Math.max(1, Number(queryString(req, 'pageSize', '50')) || 50));
    const sortColumn = queryString(req, 'sort', '');
    const sortDirection = queryString(req, 'dir', 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
    /* 筛选条件用 JSON 传，避免 URL 编码歧义。解析失败要报错而不是静默忽略。 */
    let filters: BrowseFilter[] = [];
    const rawFilters = queryString(req, 'filters', '');
    if (rawFilters) {
      try {
        const parsed = JSON.parse(rawFilters);
        if (Array.isArray(parsed)) filters = parsed as BrowseFilter[];
      } catch {
        throw new ApiFailure('E_VALIDATION', '筛选条件格式非法');
      }
    }
    const result = browseRows(table, {
      page,
      pageSize,
      filters,
      sort: sortColumn ? { column: sortColumn, direction: sortDirection } : null,
    });
    ok(res, result);
  }));

  /** 字段详情：完整类型 / 默认值 / 可空 / 主键（PRAGMA table_info 实读）。 */
  app.get('/api/assets/:id/sql/tables/:table/fields', wrap(async (req: Request, res: Response) => {
    await requireAssetId(req);
    const table = safeTableName(String(req.params.table));
    ok(res, tableFields(table));
  }));

  /** DDL 预览：sqlite_master 里的真实建表语句 + 索引定义。 */
  app.get('/api/assets/:id/sql/tables/:table/ddl', wrap(async (req: Request, res: Response) => {
    await requireAssetId(req);
    const table = safeTableName(String(req.params.table));
    ok(res, tableDdl(table));
  }));

  /* ---------------- G8 文件 / 编辑器 ---------------- */
  /* 仓库根按资产解析：不同工作区的本地克隆互不串味，:id 不再被忽略。 */
  app.get('/api/assets/:id/files/tree', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    /* path 参数此前被忽略，前端只能整棵树拉回来自己筛；现在支持从子目录开始列。 */
    ok(res, await fileTree(assetId, queryString(req, 'path', '')));
  }));
  app.get('/api/assets/:id/files/content', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const rel = queryString(req, 'path', 'src/main/java/order/InventoryClient.java');
    ok(res, await readContent(assetId, rel));
  }));
  app.get('/api/assets/:id/files/outline', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await fileOutline(assetId, queryString(req, 'path', 'src/main/java/order/InventoryClient.java')));
  }));
  app.get('/api/assets/:id/files/git', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await gitSummary(assetId));
  }));
  /* B19：真实 git diff（对 HEAD），离线/非 git 环境由前端回落静态 diff。 */
  app.get('/api/assets/:id/files/diff', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await fileDiff(assetId, queryString(req, 'path', 'src/main/java/order/InventoryClient.java')));
  }));
  /* B19：模型 API Key —— 存取走 OS 钥匙串（safeStorage），只回状态不回明文。 */
  app.get('/api/settings/llm-key', wrap(async (_req: Request, res: Response) => {
    ok(res, await llmKeyStatus());
  }));
  app.post('/api/settings/llm-key', wrap(async (req: Request, res: Response) => {
    const secret = String(body(req).secret ?? '');
    if (!secret.trim()) throw new ApiFailure('E_VALIDATION', 'secret 不能为空');
    const who = await identity(req);
    const result = await setLlmKey(secret);
    writeAudit({
      workspaceId: 'w-ops', actor: who.name, source: 'user',
      action: 'credential.llm-key.set', target: 'vault/llm-api-key', result: result.stored ? '成功' : '降级',
      severity: result.stored ? 'info' : 'warn',
      detail: result.stored ? '模型 Key 已加密存入本机钥匙串（safeStorage）' : 'safeStorage 不可用，Key 未落盘',
    });
    ok(res, { ...result, source: result.stored ? 'keychain' : 'none' });
  }));
  /* C1 用户自配置模型：多条模型档案存 setting.model.llmProfiles，
   * 每条档案的 Key 单独存钥匙串（vault/llm-api-key/<档案 id>）。
   * 响应只含状态与预设，绝不含明文 Key。 */
  const llmConfigShape = async () => {
    const cfg = await llmRuntimeConfig();
    const key = await llmKeyStatus();
    const profileRows = await llmProfileList();
    const profiles = await Promise.all(
      profileRows.map(async (profile) => {
        const status = await llmProfileKeyStatus(profile);
        return { ...profile, keyConfigured: status.configured, keySource: status.source };
      }),
    );
    return {
      provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, source: cfg.source,
      keyConfigured: key.configured, keySource: key.source,
      presets: LLM_PRESETS,
      /* 已添加的模型列表 —— 设置页要显示它，输入框的模型切换器也用它。 */
      profiles,
      activeId: await llmActiveProfileId(),
    };
  };
  app.get('/api/settings/llm-config', wrap(async (_req: Request, res: Response) => {
    ok(res, await llmConfigShape());
  }));
  /* 老端点保留：语义变成"更新当前生效的那条档案"（还没有档案就建第一条）。 */
  app.put('/api/settings/llm-config', wrap(async (req: Request, res: Response) => {
    const who = await identity(req);
    const payload = body(req);
    const list = await llmProfileList();
    const activeId = await llmActiveProfileId();
    const target = list.find((p) => p.id === activeId) ?? list[0];
    const id = target?.id ?? newId('lp');
    const provider = typeof payload.provider === 'string' ? payload.provider.trim() : (target?.provider ?? 'custom');
    const preset = LLM_PRESETS.find((p) => p.id === provider);
    const baseUrl = (typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : (target?.baseUrl ?? '')).replace(/\/+$/, '')
      || preset?.baseUrl || '';
    const model = typeof payload.model === 'string' ? payload.model.trim() : (target?.model ?? '');
    if (!baseUrl || !model) {
      throw new ApiFailure('E_VALIDATION', 'API 端点与模型名不能为空');
    }
    const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : (target?.label ?? model);
    const profile: LlmProfile = { id, label, provider, baseUrl, model, local: preset?.local === true };
    const next = list.filter((p) => p.id !== id);
    next.push(profile);
    await saveLlmProfiles(next, id);
    /* Key 与配置分两处存：配置进 DB（非敏感），Key 进钥匙串（safeStorage 密文）。 */
    let keyStored: boolean | null = null;
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      const keyResult = await setLlmKey(payload.apiKey.trim(), llmProfileKeyRef(profile));
      keyStored = keyResult.stored;
    }
    writeAudit({
      workspaceId: 'w-ops', actor: who.name, source: 'user',
      action: 'setting.llm-config', target: profile.label,
      result: '生效', severity: 'info',
      detail: `provider=${provider} baseUrl=${baseUrl} model=${model}`
        + `${keyStored === null ? ' · Key 未变更' : keyStored ? ' · Key 已更新（钥匙串）' : ' · Key 更新失败（safeStorage 不可用）'}`,
    });
    ok(res, await llmConfigShape());
  }));

  /* ───────────── 模型档案（多模型）增删改查 ───────────── */

  /** 新增一条模型档案。第一条自动成为当前生效的。 */
  app.post('/api/settings/llm-profiles', wrap(async (req: Request, res: Response) => {
    const who = await identity(req);
    const payload = body(req);
    const provider = String(payload.provider ?? 'custom').trim() || 'custom';
    const preset = LLM_PRESETS.find((p) => p.id === provider);
    const baseUrl = String(payload.baseUrl ?? '').trim().replace(/\/+$/, '') || preset?.baseUrl || '';
    const model = String(payload.model ?? '').trim();
    if (!baseUrl) throw new ApiFailure('E_VALIDATION', 'API 端点不能为空');
    if (!model) throw new ApiFailure('E_VALIDATION', '模型名不能为空');
    const id = newId('lp');
    const label = String(payload.label ?? '').trim() || model;
    const profile: LlmProfile = { id, label, provider, baseUrl, model, local: preset?.local === true };
    const list = await llmProfileList();
    list.push(profile);
    const activeId = list.length === 1 ? id : (await llmActiveProfileId() || id);
    await saveLlmProfiles(list, activeId);
    let keyStored: boolean | null = null;
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      const keyResult = await setLlmKey(payload.apiKey.trim(), llmProfileKeyRef(profile));
      keyStored = keyResult.stored;
    }
    writeAudit({
      workspaceId: 'w-ops', actor: who.name, source: 'user',
      action: 'setting.llm-profile.add', target: label,
      result: '成功', severity: 'info',
      detail: `新增模型档案「${label}」· provider=${provider} model=${model} baseUrl=${baseUrl}`
        + `${keyStored === null ? ' · 未提供 Key' : keyStored ? ' · Key 已加密存入本机钥匙串' : ' · Key 未落盘（safeStorage 不可用）'}`,
    });
    ok(res, await llmConfigShape());
  }));

  /** 修改一条档案。留空 apiKey 表示不改动已保存的 Key。 */
  app.patch('/api/settings/llm-profiles/:id', wrap(async (req: Request, res: Response) => {
    const who = await identity(req);
    const id = String(req.params.id);
    const list = await llmProfileList();
    const index = list.findIndex((p) => p.id === id);
    if (index < 0) throw new ApiFailure('E_NOT_FOUND', `模型档案不存在：${id}`);
    const payload = body(req);
    const before = list[index];
    const provider = typeof payload.provider === 'string' ? payload.provider.trim() : before.provider;
    const preset = LLM_PRESETS.find((p) => p.id === provider);
    const baseUrl = (typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : before.baseUrl).replace(/\/+$/, '')
      || preset?.baseUrl || '';
    const model = typeof payload.model === 'string' ? payload.model.trim() : before.model;
    const label = typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : before.label;
    if (!baseUrl || !model) throw new ApiFailure('E_VALIDATION', 'API 端点与模型名不能为空');
    const profile: LlmProfile = { id, label, provider, baseUrl, model, local: preset?.local === true };
    list[index] = profile;
    await saveLlmProfiles(list, await llmActiveProfileId() || id);
    let keyStored: boolean | null = null;
    if (typeof payload.apiKey === 'string' && payload.apiKey.trim()) {
      const keyResult = await setLlmKey(payload.apiKey.trim(), llmProfileKeyRef(profile));
      keyStored = keyResult.stored;
    }
    writeAudit({
      workspaceId: 'w-ops', actor: who.name, source: 'user',
      action: 'setting.llm-profile.update', target: label,
      result: '生效', severity: 'info',
      detail: `修改模型档案「${before.label}」→「${label}」· provider=${provider} model=${model}`
        + `${keyStored === null ? ' · Key 未变更' : keyStored ? ' · Key 已更新（钥匙串）' : ' · Key 更新失败（safeStorage 不可用）'}`,
    });
    ok(res, await llmConfigShape());
  }));

  /** 删除一条档案，同时删掉它那把钥匙。 */
  app.delete('/api/settings/llm-profiles/:id', wrap(async (req: Request, res: Response) => {
    const who = await identity(req);
    const id = String(req.params.id);
    const list = await llmProfileList();
    const target = list.find((p) => p.id === id);
    if (!target) throw new ApiFailure('E_NOT_FOUND', `模型档案不存在：${id}`);
    const next = list.filter((p) => p.id !== id);
    let activeId = await llmActiveProfileId();
    if (activeId === id) activeId = next[0]?.id ?? '';
    await saveLlmProfiles(next, activeId);
    /* 档案没了，它那把钥匙也必须消失 —— 否则"已删除"只是界面上的一句话。 */
    const keyRemoved = await deleteSecret(llmProfileKeyRef(target));
    writeAudit({
      workspaceId: 'w-ops', actor: who.name, source: 'user',
      action: 'setting.llm-profile.remove', target: target.label,
      result: '成功', severity: 'warn',
      detail: `删除模型档案「${target.label}」（${target.model}）· 本机钥匙串中的 Key ${keyRemoved ? '已一并清除' : '未找到，无需清除'}`,
    });
    ok(res, await llmConfigShape());
  }));

  /** 把某条档案设为当前生效的。 */
  app.post('/api/settings/llm-profiles/:id/activate', wrap(async (req: Request, res: Response) => {
    const who = await identity(req);
    const id = String(req.params.id);
    const list = await llmProfileList();
    const target = list.find((p) => p.id === id);
    if (!target) throw new ApiFailure('E_NOT_FOUND', `模型档案不存在：${id}`);
    await saveLlmProfiles(list, id);
    writeAudit({
      workspaceId: 'w-ops', actor: who.name, source: 'user',
      action: 'setting.llm-profile.activate', target: target.label,
      result: '生效', severity: 'info',
      detail: `当前模型切换为「${target.label}」（${target.model} · ${target.baseUrl}）`,
    });
    ok(res, await llmConfigShape());
  }));

  app.post('/api/settings/llm-config/test', wrap(async (req: Request, res: Response) => {
    const who = await identity(req);
    const payload = body(req);
    const cfg = await llmRuntimeConfig();
    const baseUrl = String(payload.baseUrl ?? '').trim() || cfg.baseUrl;
    const model = String(payload.model ?? '').trim() || cfg.model;
    const inputKey = String(payload.apiKey ?? '').trim();
    /* 指定了档案就测那条档案自己的 Key —— 否则测的是全局 Key，测通了不代表这条能用。 */
    const profileId = String(payload.profileId ?? '').trim();
    const target = profileId ? (await llmProfileList()).find((p) => p.id === profileId) : null;
    const { apiKey } = await resolveLlmApiKey(target ? llmProfileKeyRef(target) : undefined);
    if (!baseUrl || !model) throw new ApiFailure('E_VALIDATION', '请先填写 API 端点与模型名');
    if (!inputKey && !apiKey && !target?.local) {
      throw new ApiFailure('E_VALIDATION', '尚未配置 API Key，请先保存或填写 Key');
    }
    const result = await testLlmConnection({ baseUrl, model, apiKey: inputKey || apiKey });
    writeAudit({
      workspaceId: 'w-ops', actor: who.name, source: 'user',
      action: 'setting.llm-config.test', target: `${baseUrl} · ${model}`,
      result: result.ok ? `成功 · ${result.latencyMs}ms` : `失败 · ${result.message.slice(0, 60)}`,
      severity: result.ok ? 'info' : 'warn',
      detail: result.ok ? `模型 ${result.model} 连通，延迟 ${result.latencyMs}ms` : `连通性测试失败：${result.message.slice(0, 180)}`,
    });
    ok(res, result);
  }));

  /* 动态模型列表：GET /models 实拉端点可用模型（LiteLLM 网关 / 任意 OpenAI 兼容端点）。
   * 模型名写死在预设里会过时，列表以端点为准；预设静态数组只作拉取失败时的兜底。 */
  app.post('/api/settings/llm-models', wrap(async (req: Request, res: Response) => {
    const who = await identity(req);
    const payload = body(req);
    const cfg = await llmRuntimeConfig();
    const baseUrl = String(payload.baseUrl ?? '').trim() || cfg.baseUrl;
    const result = await fetchLlmModels({
      baseUrl,
      provider: String(payload.provider ?? '').trim(),
      profileId: String(payload.profileId ?? '').trim(),
      apiKey: String(payload.apiKey ?? '').trim(),
    });
    writeAudit({
      workspaceId: 'w-ops', actor: who.name, source: 'user',
      action: 'setting.llm-models.fetch', target: baseUrl || String(payload.provider ?? '') || '—',
      result: result.source === 'live' ? `成功 · ${result.models.length} 个` : `回落兜底 · ${result.models.length} 个`,
      severity: result.source === 'live' ? 'info' : 'warn',
      detail: result.message,
    });
    ok(res, result);
  }));
  app.post('/api/assets/:id/files/save', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await save(assetId, String(body(req).path ?? ''), String(body(req).content ?? ''), await identity(req)));
  }));
  app.post('/api/assets/:id/files/agent-write', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await agentWrite(assetId, String(body(req).path ?? ''), String(body(req).patch ?? ''), await identity(req)));
  }));
  app.post('/api/assets/:id/files/patch', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await generatePatch(assetId, String(body(req).path ?? ''), String(body(req).patch ?? '')));
  }));

  /* ---------------- 本地工作区仓库（代码库 = 克隆到本地） ---------------- */
  /** 仓库状态：本地路径 / 远端 / 分支 / 最近提交 / 文件数 / 是否有未提交改动。 */
  app.get('/api/assets/:id/repo', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await repoStatus(assetId));
  }));
  /** 真实克隆：把远端仓库拉到该工作区的本地目录，然后可触发索引重建。 */
  app.post('/api/assets/:id/clone', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const who = await identity(req);
    const payload = body(req);
    const url = String(payload.url ?? '').trim();
    /* 令牌优先用本次请求带的；没带就从已绑定的凭据里取 ——
     * 接入时录进去的令牌，之后在代码库详情页点「重新克隆」不必再手输一遍。 */
    const token = payload.token ? String(payload.token) : (await credentialSecret(assetId)) ?? undefined;
    const result = await cloneRepository({
      assetId,
      url,
      branch: payload.branch ? String(payload.branch) : undefined,
      depth: payload.depth === undefined ? 1 : Number(payload.depth),
      token,
      pull: Boolean(payload.pull),
    });
    /* 克隆后立刻重建索引：仓库内容变了，检索结果必须跟着变。 */
    const indexed = await runIndex(assetId);
    run('UPDATE asset SET index_progress = ?, status = ? WHERE id = ?', 100, 'online', assetId);
    const asset = get<{ name: string; workspace_id: string }>('SELECT name, workspace_id FROM asset WHERE id = ?', assetId);
    writeAudit({
      workspaceId: String(asset?.workspace_id ?? 'w-ops'), actor: who.name, source: 'user',
      action: result.action === 'pulled' ? 'repo.pull' : 'repo.clone',
      target: String(asset?.name ?? assetId),
      result: '成功',
      severity: 'info',
      detail: `${result.action === 'pulled' ? '拉取最新' : '克隆'}到 ${result.localPath}`
        + ` · 分支 ${result.branch} · ${result.commit} · ${result.files} 个文件`
        + ` · 索引重建 ${indexed.chunks} 块 / ${indexed.files} 文件`,
    });
    ok(res, { ...result, index: indexed });
  }));
  /** 显式建立某个项目的本地工作区目录（项目一创建就有本地根）。 */
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
  app.get('/api/sensitive-rules', (_req, res) => ok(res, SENSITIVE_RULES));
  app.put('/api/sensitive-rules', wrap(async (req: Request, res: Response) => {
    const rules = Array.isArray(body(req).rules) ? (body(req).rules as Row[]) : SENSITIVE_RULES;
    const privacy = await settingRaw('privacy');
    privacy.sensitiveRules = rules.map((r) => String(r.pattern ?? ''));
    run('UPDATE setting SET raw = ? WHERE section = ?', JSON.stringify(privacy), 'privacy');
    ok(res, rules);
  }));

  /* ---------------- G9 设置 ---------------- */
  app.get('/api/settings', async (_req, res) => ok(res, await allSettings()));
  app.get('/api/settings/effective-policy', async (_req, res) => ok(res, await effectivePolicy()));
  app.get('/api/effective-policy', async (_req, res) => ok(res, await effectivePolicy()));
  app.post('/api/settings/permission-probe', wrap(async (req: Request, res: Response) => {
    const payload = body(req);
    const verdict = await probe({
      actor: payload.actor === 'agent' ? 'agent' : 'user',
      action: String(payload.action ?? 'read'),
      risk: payload.risk === 'high' || payload.risk === 'medium' ? payload.risk : 'low',
      workspaceId: 'w-ops',
      assetId: typeof payload.assetId === 'string' ? payload.assetId : undefined,
    }, kernelIdentity(await identity(req)));
    ok(res, {
      decision: verdict.effect,
      reason: verdict.reason,
      reasonCode: verdict.reasonCode,
      matchedPolicy: verdict.matchedPolicy,
      suggestion: verdict.suggestion,
      /* 约束必须回传：用户真正关心的是"会不会落盘 / 能不能执行"，
       * 只给一个 allow/deny/ask 的词，等于让人自己去猜副作用。 */
      constraints: verdict.constraints,
      risk: verdict.risk,
      auditId: verdict.auditId,
      serverLogId: verdict.serverLogId,
      readOnlyMode: verdict.readOnlyMode,
      effective: verdict.effective,
    });
  }));
  /**
   * 清除派生缓存。
   *
   * 只删"可以重建"的东西：上下文快照与用量统计。会话、消息、产物、审计与索引
   * 一律不动 —— 一个叫"清除数据"的按钮如果顺手删了会话，就是不可撤销的伤害。
   * 索引需要重建时走资产的 /index/progress，语义分开。
   */
  app.post('/api/maintenance/clear-cache', wrap(async (req: Request, res: Response) => {
    const snapshots = Number((get<Row>('SELECT COUNT(*) AS n FROM context_snapshot'))?.n ?? 0);
    const usage = Number((get<Row>('SELECT COUNT(*) AS n FROM usage_stat'))?.n ?? 0);
    run('DELETE FROM context_snapshot');
    run('DELETE FROM usage_stat');
    const auditId = writeAudit({
      workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: 'maintenance.clear-cache', target: '本机缓存', result: '成功', severity: 'info',
      detail: `清除上下文快照 ${snapshots} 条、用量统计 ${usage} 条；会话/产物/审计/索引未改动`,
    });
    ok(res, { clearedSnapshots: snapshots, clearedUsage: usage, kept: ['会话', '产物', '审计', '索引'], auditId });
  }));
  app.patch('/api/settings/:section', wrap(async (req: Request, res: Response) => {
    const section = String(req.params.section);
    requireRow(get<Row>('SELECT section FROM setting WHERE section = ?', section), '设置分区');
    const current = await settingRaw(section);
    const patch = body(req);
    Object.entries(patch).forEach(([key, value]) => {
      if (key.startsWith('perm.')) current[key.slice(5)] = value;
      else current[key] = value;
    });
    if (typeof patch.readOnlyMode === 'boolean') current.readOnlyMode = patch.readOnlyMode;
    run('UPDATE setting SET raw = ? WHERE section = ?', JSON.stringify(current), section);
    writeAudit({
      workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: `setting.change · ${section}`, target: section, result: '生效', severity: 'info',
      detail: `before→after: ${JSON.stringify(patch)}`,
    });
    ok(res, await allSettings());
  }));

  /* ---------------- G11 审计 ---------------- */
  app.get('/api/audit/export', wrap(async (req: Request, res: Response) => {
    const rows = await auditRows(req);
    const total = await auditTotal(req);
    const auditId = writeAudit({
      workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: 'audit.export', target: '审计日志', result: '成功', severity: 'info',
      detail: exportDetail(rows.length, total),
    });
    ok(res, { content: csvFromAudit(rows), fileName: 'devwork-audit.csv', auditId, exported: rows.length, total });
  }));
  app.post('/api/audit/export', wrap(async (req: Request, res: Response) => {
    const rows = await auditRows(req);
    const total = await auditTotal(req);
    const auditId = writeAudit({
      workspaceId: 'w-ops', actor: (await identity(req)).name, source: 'user',
      action: 'audit.export', target: '审计日志', result: '成功', severity: 'info',
      detail: exportDetail(rows.length, total),
    });
    const exportRow = get<Row>('SELECT * FROM audit_event WHERE id = ?', auditId);
    const withExport = exportRow ? [...rows, auditShape(exportRow)] : rows;
    /* exported 只数"筛选命中的记录"：末尾那条 audit.export 是元信息行，
       计进去会让"导出 206 条 / 共命中 205 条"自相矛盾。 */
    ok(res, { content: csvFromAudit(withExport), fileName: 'devwork-audit.csv', auditId, exported: rows.length, total });
  }));
  app.get('/api/audit', wrap(async (req: Request, res: Response) => {
    const page = Math.max(1, Number(queryString(req, 'page', '1')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(queryString(req, 'pageSize', '20')) || 20));
    const { where, params } = auditFilter(req);
    const total = await auditTotal(req);
    /* 分页在 SQL 里做：之前是取 500 行再 slice，翻到 26 页之后恒为空却仍报总数。 */
    const items = (all<Row>(
      `SELECT * FROM audit_event ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, (page - 1) * pageSize,
    )).map(auditShape);
    ok(res, { items, total, page, pageSize });
  }));
  app.get('/api/audit/:id', wrap(async (req: Request, res: Response) => {
    ok(res, auditShape(requireRow(get<Row>('SELECT * FROM audit_event WHERE id = ?', req.params.id), '审计')));
  }));

  /* ---------------- 静态产物下载 / 兜底 ---------------- */
  app.get('/api/artifacts/file/:name', wrap(async (req: Request, res: Response) => {
    bootstrapArtifacts();
    const target = artifactPath(String(req.params.name));
    if (artifactSize(String(req.params.name)) === 0) {
      fail(res, 'E_NOT_FOUND', '产物文件不存在', 404);
      return;
    }
    /* ?inline=1：预览内联渲染（PDF iframe、图片直连），按扩展名给 mime 且不带 attachment。
     * 默认仍是下载。svg/html 这类「活动内容」加 CSP sandbox —— 内联渲染也拿不到同源权限。 */
    if (req.query.inline !== undefined) {
      const ext = path.extname(target).toLowerCase();
      const inlineMime: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
        '.txt': 'text/plain;charset=utf-8', '.md': 'text/markdown;charset=utf-8',
        '.json': 'application/json;charset=utf-8', '.csv': 'text/csv;charset=utf-8',
        '.html': 'text/html;charset=utf-8', '.htm': 'text/html;charset=utf-8',
      };
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Type', inlineMime[ext] ?? 'application/octet-stream');
      if (ext === '.svg' || ext === '.html' || ext === '.htm') {
        res.setHeader('Content-Security-Policy', 'sandbox');
      }
      res.sendFile(target);
      return;
    }
    res.download(target, String(req.params.name));
  }));

  app.use('/api', (_req, res) => {
    fail(res, 'E_NOT_FOUND', '未找到对应的 REST 端点', 404);
  });
}
