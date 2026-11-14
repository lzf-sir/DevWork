/**
 * SessionApprovals —— 会话级「本会话内允许此类操作」记忆 + 连拒熔断器。
 *
 * 设计依据（devwork-asset-capability-design.md §6.4 / §5.4）：
 * - 审批卡「本会话内允许」的记忆键 = intent + targetType + riskLevel 三元组，
 *   **不含具体参数**：restart order-api 记住了，restart payment-api 不继承；
 *   会话结束即失效，不落盘（进程内存，服务重启清零——故意的，授权不该比进程活得久）。
 * - 连拒熔断：同会话内写操作连续 3 次 Deny/转建议 → 本轮任务熔断，
 *   后续写意图直接拒绝并提示降级路径，防止 Agent 换姿势重试变相越权。
 */

export type ApprovalKey = string;

/** key: `${conversationId}` → Set<`${action}|${targetType}|${risk}`> */
const sessionGrants = new Map<string, Set<ApprovalKey>>();

/** key: `${conversationId}` → 连续拒绝计数 */
const denyStreaks = new Map<string, number>();

export const DENY_BREAKER_THRESHOLD = 3;

/** 组装记忆键（不含具体参数——设计 §6.4 的硬规则）。 */
export function approvalKeyOf(action: string, targetType: string, risk: string): ApprovalKey {
  return `${action}|${targetType}|${risk}`;
}

/**
 * 1.0 已下线，仅保留给未来版本；当前无调用方（respondApproval 不再 grant）。
 *
 * 不删函数的原因：`tests/agent-tools.mjs:261` 仍用它验证记忆键与连续拒绝熔断的底层行为，
 * 直接删会打断测试。若要恢复会话免审，必须同时恢复三处：前端入口
 * + respondApproval 里的 grant 调用 + shared/contracts 的口径说明，缺一不可。
 */
export function grantSessionApproval(conversationId: string, key: ApprovalKey): void {
  const set = sessionGrants.get(conversationId) ?? new Set<ApprovalKey>();
  set.add(key);
  sessionGrants.set(conversationId, set);
}

export function hasSessionApproval(conversationId: string, key: ApprovalKey): boolean {
  return sessionGrants.get(conversationId)?.has(key) ?? false;
}

export function sessionApprovalCount(conversationId: string): number {
  return sessionGrants.get(conversationId)?.size ?? 0;
}

export function clearSessionApprovals(conversationId: string): void {
  sessionGrants.delete(conversationId);
  denyStreaks.delete(conversationId);
}

/** 写操作被拒（deny/suggest）时 +1；通过审批执行或 allow 时清零。 */
export function recordWriteDeny(conversationId: string): number {
  const next = (denyStreaks.get(conversationId) ?? 0) + 1;
  denyStreaks.set(conversationId, next);
  return next;
}

export function recordWriteSuccess(conversationId: string): void {
  denyStreaks.set(conversationId, 0);
}

/** 熔断是否已触发。 */
export function breakerTripped(conversationId: string): boolean {
  return (denyStreaks.get(conversationId) ?? 0) >= DENY_BREAKER_THRESHOLD;
}

export function breakerStatus(conversationId: string): { tripped: boolean; streak: number; threshold: number } {
  const streak = denyStreaks.get(conversationId) ?? 0;
  return { tripped: streak >= DENY_BREAKER_THRESHOLD, streak, threshold: DENY_BREAKER_THRESHOLD };
}
