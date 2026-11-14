/**
 * assets 路由：资产 CRUD / 能力 / 凭据 / 索引 / 代码库。
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
import { body, optionalId, requireRow, requireAssetId } from './helpers';
import { parseBody } from '../http/validate';
import { assetPatchSchema, assetSearchSchema, capabilityPatchSchema, cloneRepoSchema, credentialInputSchema, indexProgressSchema } from '../../../shared/contracts';
import { assetCreateSchema } from '../../../shared/contracts';

export function registerAssetRoutes(app: Express): void {
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
    /* 契约校验：形状与枚举由 shared/contracts/asset.ts 定义，前后端同一份。
     * 失败抛 E_VALIDATION（HTTP 400），不会走到下面的清洗与落库。 */
    const payload = parseBody(assetCreateSchema, req);
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
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(indexProgressSchema, req);
    const id = await requireAssetId(req);
    const assetRow = get<{ type: string; workspace_id: string }>('SELECT type, workspace_id FROM asset WHERE id = ?', id);
    /* B15：代码资产触发真实索引管线（扫仓库 → 分块 → FTS5），不再模拟进度。 */
    const type = String(assetRow?.type ?? '');
    /* 审计写资产**真实归属**的工作区，不写死 w-ops —— 索引的是谁的资产就记谁的账。 */
    const ownerWorkspace = String(assetRow?.workspace_id ?? '');
    if (type === 'code') {
      const result = await runIndex(id);
      run('UPDATE asset SET index_progress = ?, status = ? WHERE id = ?', 100, 'online', id);
      const who = await identity(req);
      writeAudit({
        workspaceId: ownerWorkspace, actor: who.name, source: 'user',
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
        workspaceId: ownerWorkspace, actor: (await identity(req)).name, source: 'user',
        action: 'index.run', target: id, result: '成功', severity: 'info',
        detail: `重建知识库索引：${result.files} 个文档 / ${result.chunks} 个片段`,
      });
      ok(res, { indexProgress: 100, status: 'online', chunks: result.chunks, files: result.files });
      return;
    }
    const current = Number((get<{ index_progress: number }>('SELECT index_progress FROM asset WHERE id = ?', id))?.index_progress ?? 0);
    const to = typeof payload.to === 'number' ? Number(payload.to) : Math.min(100, current + Number(payload.delta ?? 10));
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
    const patch = parseBody(capabilityPatchSchema, req);
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
    const query = String(parseBody(assetSearchSchema, req).query ?? queryString(req, 'q'));
    /* B15：FTS5 全文检索（降级 LIKE），命中真实仓库分块。 */
    ok(res, searchIndex(assetId, query));
  }));
  app.get('/api/assets/:id/credential', wrap(async (req: Request, res: Response) => {
    ok(res, await credentialShape(await requireAssetId(req)));
  }));
  app.post('/api/assets/:id/credential/bind', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(credentialInputSchema, req);
    const assetId = await requireAssetId(req);
    /* B17：secret 走 IPC → safeStorage 加密落本机；DB 只存引用。 */
    ok(res, await bind(assetId, {
      label: String(payload.label ?? ''),
      secret: String(payload.secret ?? ''),
      username: String(payload.username ?? ''),
      authMethod: String(payload.method ?? ''),
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
    /* 统一走 requireAssetId：资产存在性 + 工作区归属一次性校验，
     * 不再另写一份守卫逻辑（两处守卫迟早会漂移）。 */
    const id = await requireAssetId(req);
    ok(res, requireRow(await assetDetailShape(id), '资产'));
  }));
  app.patch('/api/assets/:id', wrap(async (req: Request, res: Response) => {
    const id = await requireAssetId(req);
    const patch = parseBody(assetPatchSchema, req);
    if (typeof patch.name === 'string') run('UPDATE asset SET name = ? WHERE id = ?', patch.name, id);
    if (typeof patch.env === 'string') run('UPDATE asset SET env = ? WHERE id = ?', patch.env, id);
    ok(res, { id, ...patch });
  }));
  app.delete('/api/assets/:id', wrap(async (req: Request, res: Response) => {
    const id = await requireAssetId(req);
    /* 审计落资产**真实归属**的工作区：删的是谁的资产就记谁的账，
     * 不写死 w-ops、也不照抄请求方声明的 workspaceId（requireAssetId 已校验两者一致）。 */
    const ownerWorkspace = String((get<{ workspace_id: string }>('SELECT workspace_id FROM asset WHERE id = ?', id))?.workspace_id ?? '');
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
      workspaceId: ownerWorkspace, actor: (await identity(req)).name, source: 'user',
      action: 'asset.delete', target: id, result: '成功', severity: 'warn',
      detail: `资产 ${id} 已删除，索引 / 凭据绑定 / 终端会话一并清理`,
    });
    ok(res, { deleted: true });
  }));
  app.get('/api/assets/:id/repo', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    ok(res, await repoStatus(assetId));
  }));
  /** 真实克隆：把远端仓库拉到该工作区的本地目录，然后可触发索引重建。 */
  app.post('/api/assets/:id/clone', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const who = await identity(req);
    const payload = parseBody(cloneRepoSchema, req);
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
}
