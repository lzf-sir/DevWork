/**
 * files 路由：文件树 / 内容 / 大纲 / git / 写回。
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
import { findSymbolOccurrences, scanTodos } from '../services/code-nav';
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
import { body, requireAssetId } from './helpers';
import { parseBody } from '../http/validate';
import { agentWriteSchema, patchFileSchema, saveFileSchema } from '../../../shared/contracts';

export function registerFileRoutes(app: Express): void {
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
  /**
   * 符号级引用（界面右侧「引用」面板的数据源）。
   *
   * 与 `files/outline` 里的 `references` **不是同一种东西**，两者数字不一致是正常的：
   *   · outline → 文件级粗扫：任何符号名在别的文件里**作为子串**出现过就算一次，
   *     注释与字符串照算，同名不同符号也合并。它回答的是「大概去哪些文件找」；
   *   · 本路由 → 符号级精确：先抹掉注释与字符串再匹配，并按 import 关系做跨文件收敛。
   *     它回答的是「这 N 处到底是不是同一个符号」。
   * 界面必须分开表述，不能让用户以为其中一个错了。
   *
   * 整仓扫描（有界：文件数 4000、单文件 512KB）是同步的，所以超时放宽；
   * symbols 只收单个标识符——传正则或整段文本请走 code_find(mode=regex)。
   */
  app.get('/api/assets/:id/files/refs', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const symbol = queryString(req, 'symbol', '').trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) {
      throw new ApiFailure(
        'E_VALIDATION',
        `symbol 必须是单个标识符（字母/数字/下划线/$，且不以数字开头）：${symbol || '（空）'}`,
      );
    }
    ok(res, await findSymbolOccurrences(assetId, symbol, { max: Number(queryString(req, 'max', '40')) }));
  }));

  /**
   * 遗留标记（TODO / FIXME / HACK）—— 界面右栏「遗留标记」与底部明细面板的数据源。
   *
   * 与 `code_todos` 工具**同一实现**（`scanTodos`），所以那些让工具不撒谎的字段
   * 在这里也必须原样透出：`owner`（所属符号，`undefined` 还得分「模块级」和「非代码文件」两种）、
   * `skippedLarge` / `walkTruncated` / `stoppedAtCap`（三个独立的"为什么可能没扫全"）。
   * 任何在路由层把它们压成一个 `truncated` 的写法，都会让界面失去说真话的依据。
   *
   * 整仓遍历是同步的，同 refs 一样是「点一次付一次」：界面不自动触发。
   */
  app.get('/api/assets/:id/files/todos', wrap(async (req: Request, res: Response) => {
    const assetId = await requireAssetId(req);
    const subPath = queryString(req, 'subPath', '').trim();
    ok(res, await scanTodos(assetId, {
      /* scanTodos 内部把 max 夹在 1..100，默认就给上限值：界面要的是"能看多少给多少"，
         再由 stoppedAtCap 告诉用户这次是否提前结束。 */
      max: Number(queryString(req, 'max', '100')),
      ...(subPath ? { subPath } : {}),
    }));
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
  app.post('/api/assets/:id/files/save', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(saveFileSchema, req);
    const assetId = await requireAssetId(req);
    ok(res, await save(assetId, String(payload.path ?? ''), String(payload.content ?? ''), await identity(req)));
  }));
  app.post('/api/assets/:id/files/agent-write', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(agentWriteSchema, req);
    const assetId = await requireAssetId(req);
    ok(res, await agentWrite(assetId, String(payload.path ?? ''), String(payload.patch ?? ''), await identity(req)));
  }));
  app.post('/api/assets/:id/files/patch', wrap(async (req: Request, res: Response) => {
    /* 契约校验一次，块内统一用 payload：同一请求重复解析只是浪费。 */
    const payload = parseBody(patchFileSchema, req);
    const assetId = await requireAssetId(req);
    ok(res, await generatePatch(assetId, String(payload.path ?? ''), String(payload.patch ?? '')));
  }));

  /* ---------------- 本地工作区仓库（代码库 = 克隆到本地） ---------------- */
  /** 仓库状态：本地路径 / 远端 / 分支 / 最近提交 / 文件数 / 是否有未提交改动。 */
}
