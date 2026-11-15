/**
 * system 路由：健康检查 / 启动自检。
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
import { DEFAULT_WORKSPACE_ID, PORT, browserAllowPrivate } from '../config';
import { searchBackend } from '../services/web-search';
import { APP_VERSION } from '../config/version';

type Row = Record<string, unknown>;
import { probeTools, requireRow } from './helpers';

export function registerSystemRoutes(app: Express): void {
  app.get('/api/health', (_req, res) => {
    const driver = detectDriver();
    const tools = probeTools();
    ok(res, {
      status: driver === 'none' ? 'degraded' : 'ok',
      node: process.version,
      driver,
      wal: hasWal(),
      /* 版本号只有一个来源：config/version.ts。硬编码过一次，发版就报错了旧版本。 */
      version: APP_VERSION,
      gitAvailable: tools.git,
      dockerAvailable: tools.docker,
      port: PORT,
      /* 内置浏览器是否放行私有网段：设置页要显示这条安全开关的真实状态。
       * 必须显式为 boolean —— 缺字段时前端 `undefined ? '已放行' : '已拦截'`
       * 会把"没上报"渲染成"已拦截"，等于谎报安全状态。函数每次读 env，故不缓存。 */
      browserAllowPrivate: browserAllowPrivate() === true,
      /* 外部检索后端是否配置。与 browserAllowPrivate 同理必须是显式 boolean：
       * 「没上报」不能被前端渲染成「没配置」，否则用户会去查一个其实已经好的配置。
       * 模型也可以据此决定"先 search 还是直接 fetch"，所以这条口径要能被查到。 */
      webSearch: searchBackend().configured,
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
    const workspaceId = queryString(req, 'workspaceId', '') || defaultWs || DEFAULT_WORKSPACE_ID;
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
}
