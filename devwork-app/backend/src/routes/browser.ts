/**
 * browser 路由：内置浏览器状态与页面。
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
import { body } from './helpers';
import { parseBody } from '../http/validate';
import { browserNavSchema, browserPageSchema } from '../../../shared/contracts';

export function registerBrowserRoutes(app: Express): void {
  app.get('/api/conversations/:id/browser', wrap(async (req: Request, res: Response) => {
    ok(res, await readBrowserState(String(req.params.id)));
  }));
  app.post('/api/conversations/:id/browser', wrap(async (req: Request, res: Response) => {
    const normalized = normalizeBrowserUrl(parseBody(browserNavSchema, req).url, { allowPrivate: true });
    if (!normalized.ok) {
      fail(res, 'E_INVALID_URL', normalized.reason ?? '地址不合法', 422);
      return;
    }
    ok(res, await writeBrowserState(String(req.params.id), normalized.url ?? '', 'user'));
  }));

  /* 页面快照：前端把当前页标题与正文回传，Agent 的 browser(mode=read) 读它。
   * 这是"Agent 能控制浏览器"的读侧 —— 只导航不看，等于盲飞。 */
  app.get('/api/conversations/:id/browser/page', wrap(async (req: Request, res: Response) => {
    ok(res, await readBrowserPage(String(req.params.id)));
  }));
  app.post('/api/conversations/:id/browser/page', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(browserPageSchema, req);
    const title = String(payload.title ?? '').slice(0, 300);
    const text = String(payload.text ?? '').slice(0, 20000);
    ok(res, await writeBrowserPage(String(req.params.id), title, text));
  }));

  /* ---------------- G6 终端 ---------------- */
}
