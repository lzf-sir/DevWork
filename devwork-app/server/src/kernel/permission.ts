/**
 * PermissionKernel —— 全系统唯一权限裁决 choke point（双保险）。
 * 判定顺序不可调换；任何 check() 裁决都会写审计并返回 auditId。
 * probe() 只做判定与 stdout 日志（serverLogId），不写审计，供 V7 前后对照。
 */
import { randomUUID } from 'node:crypto';
import { get, writeAudit } from '../db/database';
import { readOnlyMode, settingRaw } from '../db/repositories';
import { isWriteAction } from '../config/rules';

export type Actor = 'user' | 'agent' | 'system';
export type Risk = 'low' | 'medium' | 'high';
export type Effect = 'allow' | 'ask' | 'deny' | 'suggest';

export interface CapabilityRequest {
  actor: Actor;
  action: string;
  risk: Risk;
  workspaceId: string;
  assetId?: string;
  path?: string;
  payload?: Record<string, unknown>;
}

export interface PermissionContext {
  identityName?: string;
  source?: 'user' | 'agent' | 'system';
}

export interface PermissionDecision {
  effect: Effect;
  decision: Effect;
  reason: string;
  reasonCode: string;
  matchedPolicy: string;
  effective: Record<string, unknown>;
  suggestion?: string;
  constraints?: Record<string, unknown>;
  auditId: string;
  readOnlyMode: boolean;
  actor: Actor;
  action: string;
  risk: Risk;
  serverLogId?: string;
}

/**
 * action → 资产能力名的映射。
 *
 * 能力表里存的是 read / query / write 三档（种子与能力授权页都是这三档），
 * 而裁决请求传的是 sql.query.read 这类具体动作名。名字对不上时
 * capabilityFor() 恒返回 null，能力授权页的开关对裁决完全失效——
 * 这比"少一个功能"更糟：它让管理员以为自己关掉了某项能力。
 */
export function capabilityOf(action: string): 'read' | 'query' | 'write' {
  if (isWriteAction(action)) return 'write';
  if (/^sql\./.test(action)) return 'query';
  return 'read';
}

function capabilityFor(req: CapabilityRequest): { granted: boolean; approval: string } | null {
  if (!req.assetId) return null;
  const row = get<Record<string, unknown>>(
    'SELECT granted, approval, capability FROM asset_capability WHERE asset_id = ? AND capability = ?',
    req.assetId,
    capabilityOf(req.action),
  );
  return row ? { granted: Number(row.granted) === 1, approval: String(row.approval) } : null;
}

function suggestionText(req: CapabilityRequest): string {
  return `Agent 写操作被拦截，已生成建议（磁盘零变更）：${req.action}${req.path ? ` → ${req.path}` : ''}。请在会话中确认并手动执行。`;
}

/** 核心判定：不产生副作用（只读库里的设置 / 能力 / 资产环境）。 */
function decide(req: CapabilityRequest, ctx: PermissionContext, readOnly: boolean): Omit<PermissionDecision, 'auditId' | 'serverLogId'> {
  const perm = settingRaw('perm');
  const base = {
    readOnlyMode: readOnly,
    actor: req.actor,
    action: req.action,
    risk: req.risk,
    effective: {
      orgForceReadOnly: perm.orgForceReadOnly === true,
      workspaceTrust: perm.workspaceTrust ?? 'prod',
      userReadOnlyMode: perm.readOnlyMode === true,
    } as Record<string, unknown>,
  };
  const make = (
    effect: Effect,
    reasonCode: string,
    reason: string,
    matchedPolicy: string,
    extra: Partial<PermissionDecision> = {},
  ): Omit<PermissionDecision, 'auditId' | 'serverLogId'> => ({
    ...base,
    effect,
    decision: effect,
    reason,
    reasonCode,
    matchedPolicy,
    ...extra,
  });

  /* ① actor=user → allow（手动保存 / 终端放行）。没有账号与角色，不存在角色级拒绝。 */
  if (req.actor === 'user') {
    return make('allow', 'E_USER_MANUAL', '用户手动操作始终放行（只读只约束 Agent）', 'actor:user');
  }

  /* ② actor=agent 的写类动作：高风险 → 生成审批卡（未执行）；其余 → 拒绝并转建议。
   *
   * 判定顺序按设计 §8.1：先看能力表，再看风险。这里必须放在 ④ 之前，否则能力
   * 未授权也会先撞审批；也必须保留"写操作绝不自动执行"这条底线——ask 分支的
   * constraints.executable 恒为 false，respondApproval 只记录裁决，不碰磁盘。 */
  if (req.actor === 'agent' && isWriteAction(req.action)) {
    /* 生产环境访问策略（perm.p3）：对 env=prod 的资产，写操作按策略档位裁决，
     * 覆盖默认风险分级——这是设置页 p3 唯一的真实消费点。
     * p3 未显式设置时不改变默认行为（高风险写仍走审批卡，保持 P1-9 闭环语义）。 */
    const prodModeSetting = String(perm.p3 ?? '').trim();
    const prodEnv = req.assetId
      ? String((get<Record<string, unknown>>('SELECT env FROM asset WHERE id = ?', req.assetId))?.env ?? '')
      : '';
    if (prodEnv === 'prod' && prodModeSetting) {
      if (prodModeSetting === '完全禁止') {
        return make('deny', 'E_PROD_BLOCKED', '生产环境资产禁止 Agent 写操作（生产环境访问策略：完全禁止）', 'agent:prod-deny', {
          suggestion: suggestionText(req),
          constraints: { diskChanged: false, bytesWritten: 0, executable: false },
        });
      }
      if (prodModeSetting === '允许（需审批）') {
        return make('ask', 'E_APPROVAL_REQUIRED', '生产环境写操作需要人工审批（生产环境访问策略：允许·需审批）', 'agent:prod-ask', {
          suggestion: suggestionText(req),
          constraints: { approvalCard: true, executable: false, diskChanged: false, bytesWritten: 0 },
        });
      }
      /* 仅只读（默认）：一律转建议，不给审批卡——生产环境连"批准"入口都不该有。 */
      return make('suggest', 'E_PROD_READONLY', '生产环境资产只读（生产环境访问策略：仅只读），写操作转为建议', 'agent:prod-suggest', {
        suggestion: suggestionText(req),
        constraints: { diskChanged: false, bytesWritten: 0, executable: false },
      });
    }

    /* 写操作审批模式（perm.p2）：「每次询问」= 所有写操作都生成审批卡；
     * 其余档位（默认按风险分级 / 本会话内记住）= 仅高风险走审批，中低风险
     * 拒绝转建议。当前版本没有写执行通道，ask 与 deny 的区别只在 UI 卡片。 */
    const approvalMode = String(perm.p2 ?? '按风险分级');
    const cap = capabilityFor(req);
    const needsApproval = approvalMode === '每次询问' || req.risk === 'high' || cap?.approval === 'ask';
    if (needsApproval) {
      return make('ask', 'E_APPROVAL_REQUIRED', '高风险写操作需要人工审批（未执行）', 'agent:write-ask', {
        suggestion: suggestionText(req),
        constraints: { approvalCard: true, executable: false, diskChanged: false, bytesWritten: 0 },
      });
    }
    return make('deny', 'E_PERMISSION_DENIED', 'Agent 写操作恒被拒绝并转为建议（磁盘零变更）', 'agent:write-deny', {
      suggestion: suggestionText(req),
      constraints: { diskChanged: false, bytesWritten: 0, executable: false },
    });
  }

  /* ③ agent + risk>=medium + readOnlyMode → suggest（不执行、不生成审批卡）。 */
  if (req.actor === 'agent' && req.risk !== 'low' && readOnly) {
    return make('suggest', 'E_READONLY_SUGGEST', '只读模式下 Agent 中等 / 高风险动作转为生成建议', 'org:force-read-only', {
      suggestion: suggestionText(req),
      constraints: { executable: false },
    });
  }

  /* ④ capability approval=deny / granted=0 → deny。 */
  const cap = capabilityFor(req);
  if (cap && (!cap.granted || cap.approval === 'deny')) {
    return make('deny', 'E_PERMISSION_DENIED', '资产能力未授权', `capability:${req.action}`);
  }

  /* ⑤ approval=ask 且只读关闭 → ask（才生成审批卡）。 */
  if (cap && cap.approval === 'ask' && !readOnly) {
    return make('ask', 'E_APPROVAL_REQUIRED', '该能力需要人工审批', `capability:${req.action}:ask`, {
      constraints: { approvalCard: true },
    });
  }

  /* ⑥ 其余 allow。 */
  return make('allow', 'E_ALLOW', '只读能力自动放行', 'default:allow-read');
}

function auditFor(req: CapabilityRequest, ctx: PermissionContext, decision: Omit<PermissionDecision, 'auditId' | 'serverLogId'>): string {
  return writeAudit({
    workspaceId: req.workspaceId,
    actor: ctx.identityName ?? req.actor,
    source: ctx.source ?? (req.actor === 'agent' ? 'agent' : 'user'),
    action: `permission.check · ${req.action}`,
    target: req.assetId ?? req.path ?? '',
    result: decision.effect === 'deny' ? '拦截'
      : decision.effect === 'suggest' ? '转建议'
      : decision.effect === 'ask' ? '待审批'
      : '放行',
    severity: decision.effect === 'deny' ? 'warn' : 'info',
    detail: `${decision.reasonCode} · ${decision.matchedPolicy} · actor=${req.actor} · risk=${req.risk}`,
  });
}

/** 正式裁决：写审计并返回 auditId。 */
export function check(req: CapabilityRequest, ctx: PermissionContext = {}): PermissionDecision {
  const readOnly = readOnlyMode();
  const verdict = decide(req, ctx, readOnly);
  const auditId = auditFor(req, ctx, verdict);
  return { ...verdict, auditId };
}

/** 探测：不写审计，只打印带 serverLogId 的服务端日志，供 V7 前后对照。 */
export function probe(req: CapabilityRequest, ctx: PermissionContext = {}): PermissionDecision {
  const readOnly = readOnlyMode();
  const verdict = decide(req, ctx, readOnly);
  const serverLogId = `probe-${randomUUID()}`;
  // eslint-disable-next-line no-console
  console.log(
    `[PermissionKernel] serverLogId=${serverLogId} readOnlyMode=${readOnly} actor=${req.actor} action=${req.action} risk=${req.risk} → ${verdict.effect} (${verdict.reasonCode})`,
  );
  return { ...verdict, auditId: '', serverLogId };
}

export function kernelIdentity(identity: { name: string; actor: 'user' }): PermissionContext {
  return { identityName: identity.name, source: 'user' };
}
