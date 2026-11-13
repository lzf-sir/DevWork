/**
 * artifacts 路由：产物下载 / 预览。
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

export function registerArtifactRoutes(app: Express): void {
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

}
