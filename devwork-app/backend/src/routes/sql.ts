/**
 * sql 路由：SQL 查询 / 表结构 / 导出。
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
  resolveWorkspaceIdForAsset,
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
import { body, requireRow, requireAssetId } from './helpers';
import { parseBody } from '../http/validate';
import { sqlExportSchema, sqlQuerySchema } from '../../../shared/contracts';

export function registerSqlRoutes(app: Express): void {
  app.post('/api/assets/:id/sql/query', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const payload = parseBody(sqlQuerySchema, req);
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
    const payload = parseBody(sqlExportSchema, req);
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
      /* 导出的是这条资产的查询结果 → 归属从资产推导；资产不存在就记全局。 */
      workspaceId: resolveWorkspaceIdForAsset(assetId) || AUDIT_GLOBAL_SCOPE, actor: (await identity(req)).name, source: 'user',
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
}
