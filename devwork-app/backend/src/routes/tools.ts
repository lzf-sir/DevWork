/**
 * tools 路由：技能 / 工具面板 / 命令模板。
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
import { deriveToolFace, validateToolCatalog } from '../config/tool-catalog';
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

export function registerToolRoutes(app: Express): void {
  app.get('/api/skills', wrap(async (req: Request, res: Response) => {
    const problems = validateSkillRegistry();
    if (problems.length > 0) {
      throw new ApiFailure('E_INTERNAL', `技能登记表自检失败：${problems.join('；')}`);
    }
    /* 可用性判据（设计 §4）：requiresAssets ⊆ 工作区现有资产类型；
     * 缺失时返回 available:false + missing，前端显示「不可用」而非隐藏。 */
    const workspaceId = queryString(req, 'workspaceId', DEFAULT_WORKSPACE_ID);
    const types = (all<Row>(
      'SELECT DISTINCT type FROM asset WHERE workspace_id = ?', workspaceId,
    )).map((row) => String(row.type));
    ok(res, SKILL_REGISTRY.map((skill) => skillShape(skill, types)));
  }));

  /* ---------------- 派生工具面 / 命令模板库（诊断与模型自描述） ---------------- */
  app.get('/api/tools', wrap(async (req: Request, res: Response) => {
    /* 与 /api/skills 同口径：自检不过就 500 报出来。
     * 工具目录与权限表漂移的后果是"换个名字就能绕过审批"，静默返回一个错的面更糟。 */
    const catalogProblems = validateToolCatalog();
    if (catalogProblems.length > 0) {
      throw new ApiFailure('E_INTERNAL', `工具目录自检失败：${catalogProblems.join('；')}`);
    }
    const workspaceId = queryString(req, 'workspaceId', DEFAULT_WORKSPACE_ID);
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
}
