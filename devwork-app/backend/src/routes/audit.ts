/**
 * audit 路由：审计查询与导出。
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
import { PORT } from '../config';

type Row = Record<string, unknown>;
import { requireRow, auditFilter, auditRows, auditTotal, exportDetail, csvFromAudit } from './helpers';

export function registerAuditRoutes(app: Express): void {
  app.get('/api/audit/export', wrap(async (req: Request, res: Response) => {
    const rows = await auditRows(req);
    const total = await auditTotal(req);
    const auditId = writeAudit({
      /* 导出的是「筛选命中的全部记录」，跨工作区；它不属于任何单个工作区。 */
      workspaceId: AUDIT_GLOBAL_SCOPE, actor: (await identity(req)).name, source: 'user',
      action: 'audit.export', target: '审计日志', result: '成功', severity: 'info',
      detail: exportDetail(rows.length, total),
    });
    ok(res, { content: csvFromAudit(rows), fileName: 'devwork-audit.csv', auditId, exported: rows.length, total });
  }));
  app.post('/api/audit/export', wrap(async (req: Request, res: Response) => {
    const rows = await auditRows(req);
    const total = await auditTotal(req);
    const auditId = writeAudit({
      /* 导出的是「筛选命中的全部记录」，跨工作区；它不属于任何单个工作区。 */
      workspaceId: AUDIT_GLOBAL_SCOPE, actor: (await identity(req)).name, source: 'user',
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
}
