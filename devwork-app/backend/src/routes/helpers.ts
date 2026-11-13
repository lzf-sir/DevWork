/**
 * 路由层公共辅助：请求解析、工作区隔离守卫、审计筛选与导出格式。
 * 从原 routes/index.ts 原样提取，供各域模块共用。
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

/** git / docker 可用性探测，结果缓存（进程生命周期内不变）。 */
let toolProbeCache: { git: boolean; docker: boolean } | null = null;
export function probeTools(): { git: boolean; docker: boolean } {
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

export function body(req: Request): Row {
  return (req.body ?? {}) as Row;
}

/** 只把字符串当作可选 id，其余一律 null，避免把未知类型写进 SQLite。 */
export function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function assertWorkspace(resourceWorkspaceId: string, requested: string): void {
  if (requested && requested !== resourceWorkspaceId) {
    throw new ApiFailure('E_WORKSPACE_MISMATCH', `资源不属于工作区 ${requested}（实际 ${resourceWorkspaceId}）`);
  }
}

export function workspaceGuard(req: Request): string {
  return queryString(req, 'workspaceId');
}

export function requireRow<T>(value: T | undefined | null, label: string): T {
  if (!value) throw new ApiFailure('E_NOT_FOUND', `${label}不存在`);
  return value;
}

/**
 * 合并 query + body 作为筛选参数，body 优先。
 * POST /api/audit/export 由 client.ts 用 body 传 AuditQuery，GET 系列用 query。
 */
export function requestParams(req: Request): Row {
  const fromQuery = (req.query ?? {}) as Row;
  const payload = req.body;
  const fromBody: Row = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Row)
    : {};
  return { ...fromQuery, ...fromBody };
}

export function paramString(params: Row, key: string): string {
  const value = params[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 校验 /api/assets/:id/* 的资产存在性 + 工作区归属，杜绝未知 id 伪造数据。 */
export async function requireAssetId(req: Request): Promise<string> {
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
export function auditFilter(req: Request): { where: string; params: string[] } {
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

export async function auditRows(req: Request): Promise<Row[]> {
  const { where, params } = auditFilter(req);
  const rows = all<Row>(
    `SELECT * FROM audit_event ${where} ORDER BY created_at DESC, id DESC LIMIT ${AUDIT_MAX_ROWS}`,
    ...params,
  );
  return rows.map(auditShape);
}

/** 真实命中总数：不能拿"截断后的行数"冒充 total，那会让分页页码说谎。 */
export async function auditTotal(req: Request): Promise<number> {
  const { where, params } = auditFilter(req);
  const row = get<Row>(`SELECT COUNT(*) AS n FROM audit_event ${where}`, ...params);
  return Number(row?.n ?? 0);
}

/** 导出达到上限时必须说清楚，不能让用户以为拿到了全量。 */
export function exportDetail(exported: number, total: number): string {
  if (exported >= AUDIT_MAX_ROWS && total > exported) {
    return `导出 ${exported} 条审计记录（CSV，已达单次上限 ${AUDIT_MAX_ROWS}，服务端共命中 ${total} 条）`;
  }
  return `导出 ${exported} 条审计记录（CSV，服务端共命中 ${total} 条）`;
}

/** Excel on Windows 直接打开中文 CSV 需要 UTF-8 BOM + CRLF。 */
export function csvFromAudit(rows: Row[]): string {
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
