/**
 * shadow 路由：P1 影子链路的读面与开关。
 *
 * 设计原则：这里的端点全部**不产生执行副作用**。
 *   - 注入事件只写 trigger，等 tick 研判
 *   - 改策略只写 setting，下一次 tick 生效
 *   - 没有任何端点会创建工单、派工、跑工具
 * 所以它可以开放给前端做「影子决策」面板，而不需要走审批链路。
 */
import type { Express, Request, Response } from 'express';
import { ApiFailure, identity, ok, queryString, wrap } from '../http/core';
import { parseBody } from '../http/validate';
import { writeAudit, AUDIT_GLOBAL_SCOPE } from '../db/database';
import { workspaceGuard } from './helpers';
import {
  shadowEnabledSchema,
  shadowFireSchema,
  shadowMandateReviewSchema,
  shadowPolicySchema,
  shadowSourceSchema,
  shadowTriggerSchema,
} from '../../../shared/contracts';
import {
  exportShadowCsv,
  fireSourceNow,
  ingestTrigger,
  listShadowDecisions,
  listShadowMandates,
  listShadowTriggers,
  reviewMandate,
  saveShadowPolicy,
  setSourceEnabled,
  setSuperagentEnabled,
  shadowStats,
  shadowStatus,
  tickOnce,
  updateSourceConfig,
  type SourceKind,
} from '../services/shadow-scheduler';

export function registerShadowRoutes(app: Express): void {
  app.get('/api/shadow/status', wrap(async (_req: Request, res: Response) => {
    ok(res, shadowStatus());
  }));

  app.get('/api/shadow/stats', wrap(async (_req: Request, res: Response) => {
    ok(res, shadowStats());
  }));

  /** 账本导出：影子期的价值在离线核对，不能只留在 SQLite 里。 */
  app.get('/api/shadow/export', wrap(async (req: Request, res: Response) => {
    const limit = Number(queryString(req, 'limit', '1000')) || 1000;
    ok(res, exportShadowCsv(limit));
  }));

  /** 总开关。env 优先级更高，这里改的是「设置页」那一档。 */
  app.patch('/api/shadow/enabled', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(shadowEnabledSchema, req);
    ok(res, { enabled: setSuperagentEnabled(payload.enabled) });
  }));

  app.get('/api/shadow/decisions', wrap(async (req: Request, res: Response) => {
    const limit = Number(queryString(req, 'limit', '50')) || 50;
    const wouldAcceptOnly = queryString(req, 'wouldAccept', '') === '1';
    const reasonCode = queryString(req, 'reason', '');
    ok(res, listShadowDecisions({ limit, wouldAcceptOnly, reasonCode }));
  }));

  /* 事件列表：决策只回答「判了什么」，这个回答「吃了什么」—— 人工抽查 Gate 必须两面对照。 */
  app.get('/api/shadow/triggers', wrap(async (req: Request, res: Response) => {
    const limit = Number(queryString(req, 'limit', '50')) || 50;
    ok(res, listShadowTriggers({
      limit,
      disposition: queryString(req, 'disposition', ''),
      threadKey: queryString(req, 'threadKey', ''),
    }));
  }));

  /**
   * 注入一条事件。
   *
   * 返回 created=false 表示幂等命中（同一 idemKey 已存在）——
   * 这不是错误，是「同一事件不重复接单」的正常结果，所以仍然 200。
   */
  app.post('/api/shadow/triggers', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(shadowTriggerSchema, req);
    const result = ingestTrigger(payload);
    ok(res, {
      ...result,
      disposition: result.created ? 'pending' : 'duplicate',
      hint: result.created ? '已入队，下一次 tick（≤800ms）完成研判' : '同一幂等键已存在，未重复入队',
    }, result.created ? 201 : 200);
  }));

  /* 授权草案：决策说「会接」，草案说「接了能拿到多大范围」。两者分开看才审得动。 */
  app.get('/api/shadow/mandates', wrap(async (req: Request, res: Response) => {
    const limit = Number(queryString(req, 'limit', '50')) || 50;
    ok(res, listShadowMandates({ limit, status: queryString(req, 'status', '') }));
  }));

  app.post('/api/shadow/mandates/:id/review', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(shadowMandateReviewSchema, req);
    let reviewed;
    try {
      reviewed = reviewMandate(String(req.params.id), payload);
    } catch (error) {
      /* 已定稿的草案不允许二次表态：语义冲突用 409，而不是 400。 */
      throw new ApiFailure('E_ALREADY_RESOLVED', error instanceof Error ? error.message : '草案已定稿');
    }
    if (!reviewed) throw new ApiFailure('E_NOT_FOUND', '授权草案不存在');
    writeAudit({
      workspaceId: workspaceGuard(req) || AUDIT_GLOBAL_SCOPE,
      actor: identity(req).name, source: 'user',
      action: 'superagent.mandate.review', target: `mandate:${String(req.params.id)}`,
      result: payload.status === 'rejected' ? '拦截' : '放行', severity: 'info',
      detail: `草案 ${payload.status}${payload.actions ? ` · 保留 ${payload.actions.length} 个动作` : ''}${payload.note ? ` · ${payload.note}` : ''}`,
    });
    ok(res, reviewed);
  }));

  /** 手动跑一次 tick：面板「立即研判」按钮与测试都靠它，避免等定时器。 */
  app.post('/api/shadow/tick', wrap(async (_req: Request, res: Response) => {
    const result = await tickOnce();
    ok(res, result);
  }));

  app.patch('/api/shadow/policy', wrap(async (req: Request, res: Response) => {
    const patch = parseBody(shadowPolicySchema, req);
    const before = shadowStatus().policy as Record<string, unknown>;
    const next = saveShadowPolicy({
      ...patch,
      rules: patch.rules?.map((rule) => ({
        id: rule.id,
        name: rule.name ?? rule.id,
        enabled: rule.enabled !== false,
        keywords: rule.keywords ?? [],
        assetTypes: rule.assetTypes ?? [],
        /* 范围原样透传：这里少一个字段，下游就少一份授权依据。
         * 缺省值补齐成「只读、不写」——最严的那种默认。 */
        scope: rule.scope ? {
          actions: rule.scope.actions,
          riskCeiling: rule.scope.riskCeiling ?? 'low',
          maxWrites: rule.scope.maxWrites ?? 0,
        } : undefined,
      })),
    });
    /* 策略变更必须留痕：决策账本里每条都记 policyVersion，
     * 没有变更记录就无法解释「为什么前天那单接了、今天不接」。 */
    writeAudit({
      /* 影子策略是全局配置（一张表一份），归属如实记为 global。 */
      workspaceId: AUDIT_GLOBAL_SCOPE,
      actor: identity(req).name, source: 'user',
      action: 'superagent.policy.update', target: '影子策略',
      result: '成功', severity: 'info',
      detail: `${String(before.policyVersion ?? '')} → ${next.policyVersion} · mode=${next.acceptMode} · 白名单 ${next.allowedActors.length} 人 · 规则 ${next.rules.filter((r) => r.enabled).length}/${next.rules.length} 启用`,
    });
    ok(res, next);
  }));

  app.patch('/api/shadow/sources', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(shadowSourceSchema, req);
    /* 工作区维度：影子源按工作区各一份，缺了它「改 A 的巡检」会连 B 一起改。
     * 前端带上 workspaceId 就精确落到那个工作区；没带则只动最早的源（不再波及全部）。 */
    const workspaceId = workspaceGuard(req);
    /* 先改配置再开关：开关会按最新配置重排下次触发，顺序反了会用旧时间。 */
    if (payload.schedule) updateSourceConfig(payload.kind as SourceKind, payload.schedule, workspaceId);
    const changed = setSourceEnabled(payload.kind as SourceKind, payload.enabled, workspaceId);
    if (changed === 0) {
      throw new ApiFailure('E_NOT_FOUND', `事件源 ${payload.kind} 尚未登记，请先启动一次服务`);
    }
    writeAudit({
      /* 归属取请求声明的工作区；全局面板未声明时如实记「全局」，不伪装成 w-ops。 */
      workspaceId: workspaceId || AUDIT_GLOBAL_SCOPE,
      actor: identity(req).name, source: 'user',
      action: 'superagent.source.toggle', target: `source:${payload.kind}`,
      result: payload.enabled ? '放行' : '拦截', severity: 'info',
      detail: `事件源 ${payload.kind} ${payload.enabled ? '启用' : '停用'}${payload.schedule ? ` · 配置 ${JSON.stringify(payload.schedule)}` : ''}`,
    });
    ok(res, { kind: payload.kind, enabled: payload.enabled });
  }));

  /**
   * 立即触发一次。
   *
   * 等价于「假装现在到点了」：只投递一条 Trigger，**不推进** next_fire_at ——
   * 手动跑一次不该把明天的巡检挪走。
   */
  app.post('/api/shadow/sources/fire', wrap(async (req: Request, res: Response) => {
    const payload = parseBody(shadowFireSchema, req);
    const result = fireSourceNow(payload.kind as SourceKind);
    if (!result) {
      throw new ApiFailure('E_NOT_FOUND', `事件源 ${payload.kind} 尚未登记，请先启动一次服务`);
    }
    writeAudit({
      workspaceId: workspaceGuard(req) || AUDIT_GLOBAL_SCOPE,
      actor: identity(req).name, source: 'user',
      action: 'superagent.source.fire', target: `source:${payload.kind}`,
      result: '放行', severity: 'info',
      detail: `手动触发 ${payload.kind} · trigger=${result.triggerId} · created=${result.created}`,
    });
    ok(res, result, result.created ? 201 : 200);
  }));
}
