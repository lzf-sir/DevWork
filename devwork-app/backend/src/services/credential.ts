/**
 * CredentialService —— 5 态凭据（V9）。
 * 未绑定资产被工具调用时返回「需绑定凭据」而非连接异常；guest 绑定被拒。
 *
 * 接入资产时可以直接把账号 / 口令 / 令牌 / 私钥一并录进来（见 bind 的入参）：
 * 秘密经 safeStorage 加密存本机，库里只留 secret_ref；鉴权方式与账号名存在
 * credential_binding 的普通列里，方便详情页显示「绑的是谁、用哪种方式」。
 */
import { ApiFailure, type Identity } from '../http/core';
import { get, run, writeAudit } from '../db/database';
import { credentialShape } from '../db/repositories';
import { check, kernelIdentity } from '../kernel/permission';
import { loadSecret, storeSecret } from './secret-store';

export type CredentialState = 'unbound' | 'active' | 'expiring' | 'expired' | 'revoked';

/** 工具调用前置检查：未绑定直接抛 E_CREDENTIAL_REQUIRED。 */
export function requireCredential(assetId: string, identity: Identity): { state: CredentialState; label: string } {
  const shape = credentialShape(assetId);
  const state = String(shape.state) as CredentialState;
  if (state === 'unbound') {
    throw new ApiFailure('E_CREDENTIAL_REQUIRED', '需绑定凭据：该资产还没有绑定只读凭据');
  }
  if (state === 'expired') throw new ApiFailure('E_CREDENTIAL_EXPIRED', '凭据已过期，请轮换后重试');
  if (state === 'revoked') throw new ApiFailure('E_CREDENTIAL_REVOKED', '凭据已吊销，请重新绑定');
  check({
    actor: 'user', action: 'credential.bind', risk: 'medium', workspaceId: 'w-ops', assetId,
  }, kernelIdentity(identity));
  return { state, label: String(shape.label) };
}

/**
 * 写凭据状态。
 *
 * auth_method / username 用 COALESCE(NULLIF(?,''), 原值)：
 * 轮换与吊销只改状态，不该把「用的哪种鉴权、哪个账号」抹掉；
 * 而绑定时没填这两项，就保留原值而不是写成空串。
 */
function setState(
  assetId: string,
  state: CredentialState,
  label: string,
  identity: Identity,
  secretMode = '',
  extra?: { authMethod?: string; username?: string },
): void {
  const existing = get<{ id: string }>('SELECT id FROM credential_binding WHERE asset_id = ?', assetId);
  if (existing) {
    run(
      `UPDATE credential_binding SET state = ?, label = ?, last_used_label = ?, expires_at = ?,
         auth_method = COALESCE(NULLIF(?, ''), auth_method),
         username = COALESCE(NULLIF(?, ''), username)
       WHERE asset_id = ?`,
      state, label, '刚刚', state === 'active' || state === 'expiring' ? '2026-12-31' : '',
      extra?.authMethod ?? '', extra?.username ?? '', assetId,
    );
  } else {
    run(
      `INSERT INTO credential_binding (id,asset_id,user_name,state,label,secret_ref,last_used_label,expires_at,auth_method,username)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      `cred-${assetId}`, assetId, identity.name, state, label, `vault/${assetId}`, '刚刚', '2026-12-31',
      extra?.authMethod ?? '', extra?.username ?? '',
    );
  }
  writeAudit({
    workspaceId: 'w-ops', actor: identity.name, source: 'user',
    action: `credential.${state}`, target: assetId, result: '成功', severity: 'info',
    /* 审计只记方式与账号，绝不记秘密本身。 */
    detail: `凭据状态变更为 ${state}`
      + (extra?.authMethod ? ` · 鉴权方式 ${extra.authMethod}` : '')
      + `${secretMode ? ` · 秘密存储模式 ${secretMode}` : ''}`,
  });
}

/** 绑定凭据（B17）：秘密经 safeStorage 加密存本机，DB 只存引用；秘密本身绝不入库/上云。 */
export async function bind(
  assetId: string,
  input: { label: string; secret?: string; username?: string; authMethod?: string },
  identity: Identity,
): Promise<Record<string, unknown>> {
  const verdict = check({
    actor: 'user', action: 'credential.bind', risk: 'medium', workspaceId: 'w-ops', assetId,
  }, kernelIdentity(identity));
  if (verdict.effect === 'deny') {
    throw new ApiFailure('E_PERMISSION_DENIED', '当前操作被权限策略拒绝');
  }
  if (!input.label || input.label.trim() === '') {
    throw new ApiFailure('E_VALIDATION', 'label 必须是非空字符串');
  }
  /* 秘密**不做 trim**：口令首尾的空格是有意义的字符，去掉等于悄悄改写用户的凭据。
   * 是否为空只用 trim 判断，存的是原样。 */
  const secret = typeof input.secret === 'string' ? input.secret : '';
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const authMethod = typeof input.authMethod === 'string' ? input.authMethod.trim() : '';
  const hasSecret = secret.trim() !== '';
  const { mode } = hasSecret
    ? await storeSecret(`vault/${assetId}`, secret)
    : { mode: 'none' as const };
  setState(assetId, 'active', input.label, identity, hasSecret ? mode : '', { authMethod, username });
  run('UPDATE asset SET credential_bound = 1 WHERE id = ?', assetId);
  return { ...(credentialShape(assetId)), secretMode: hasSecret ? mode : 'none' };
}

/**
 * 读取已绑定凭据的秘密明文（仅本机）。
 *
 * 用途：某些动作真的需要凭据才能完成 —— 比如用私有仓库的令牌执行 git clone。
 * 未绑定 / 已过期 / 已吊销一律返回 null，不做任何"兜底猜测"。
 */
export async function credentialSecret(assetId: string): Promise<string | null> {
  const shape = credentialShape(assetId);
  const state = String(shape.state);
  if (state !== 'active' && state !== 'expiring') return null;
  return loadSecret(`vault/${assetId}`);
}

export function renew(assetId: string, identity: Identity): Record<string, unknown> {
  setState(assetId, 'active', `${assetId} · 只读凭据（已轮换）`, identity);
  return credentialShape(assetId);
}

export function revoke(assetId: string, identity: Identity): Record<string, unknown> {
  setState(assetId, 'revoked', '', identity);
  run('UPDATE asset SET credential_bound = 0 WHERE id = ?', assetId);
  return credentialShape(assetId);
}
