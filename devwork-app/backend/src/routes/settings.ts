/**
 * settings 路由：设置 / LLM 配置 / 权限策略 / 维护。
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
import { body, requireRow } from './helpers';
import { parseBody } from '../http/validate';
import { llmKeySchema, llmProfileSchema, llmTestSchema, llmModelsSchema } from '../../../shared/contracts';

export function registerSettingsRoutes(app: Express): void {
  app.get('/api/settings/llm-key', wrap(async (_req: Request, res: Response) => {
    ok(res, await llmKeyStatus());
  }));
  app.post('/api/settings/llm-key', wrap(async (req: Request, res: Response) => {
    /* 契约校验：secret 必填且非空白（trim 由 schema 完成）。 */
    const { secret } = parseBody(llmKeySchema, req);
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
    const payload = parseBody(llmProfileSchema, req);
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
    const payload = parseBody(llmProfileSchema, req);
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
    const payload = parseBody(llmProfileSchema, req);
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
    const payload = parseBody(llmTestSchema, req);
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
    const payload = parseBody(llmModelsSchema, req);
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
}
