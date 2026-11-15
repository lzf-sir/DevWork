import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AuthMethod, Credential } from '../api/types';
import { useStore } from '../store';

/**
 * 资产凭据区块：真实状态 + 绑定 / 轮换 / 吊销。
 *
 * 这一块原来写死了「已绑定 prod-pg-readonly · 最后使用 刚刚」，吊销入口根本不存在；
 * 更麻烦的是「已吊销」和「未绑定」在库里都是 `credential_bound = 0`，界面若只显示
 * 「未绑定」，用户会以为从来没配过 —— 而事实是配过、被收回、现在需要重新绑。
 * 所以状态必须按 5 态显示，不能压成 1 个布尔。
 *
 * 另两件必须说清的事：
 *   · 吊销会**真的抹掉本机密文**（不只是改状态），所以确认弹窗要讲后果；
 *   · 轮换必须输入新秘密，只改标签不叫轮换。
 */

const STATE_META: Record<Credential['state'], { label: string; tone: string; hint: string }> = {
  unbound: { label: '未绑定', tone: 'plain', hint: '还没有绑定凭据，相关工具会返回「需绑定凭据」而不是连接失败。' },
  active: { label: '已绑定', tone: 'ok', hint: '' },
  expiring: { label: '即将过期', tone: 'warn', hint: '凭据即将到期，到期后查询会被拒绝，请尽快轮换。' },
  expired: { label: '已过期', tone: 'bad', hint: '凭据已过期，需轮换后才能继续访问。' },
  revoked: { label: '已吊销', tone: 'bad', hint: '凭据已吊销且本机密文已删除。要恢复访问必须重新绑定。' },
};

export interface AssetCredentialProps {
  assetId: string;
  /** 凭据标签（人读，例如「prod 只读账号」）。绑定与轮换沿用它。 */
  label: string;
  /** 鉴权方式，默认按口令处理。 */
  method?: AuthMethod;
  /** 状态变更后通知父级：资产的绑定徽标需要重拉。 */
  onChanged?: () => void;
}

export default function AssetCredential({
  assetId,
  label,
  method = 'password',
  onChanged,
}: AssetCredentialProps): React.ReactElement {
  const { addToast, setModal } = useStore();
  const [cred, setCred] = useState<Credential | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = (): void => {
    void api.getCredential(assetId).then((envelope) => {
      if (!envelope.ok) {
        setError(envelope.error?.message ?? '读取凭据状态失败');
        setLoading(false);
        return;
      }
      setError('');
      setCred(envelope.data);
      setLoading(false);
    });
  };

  useEffect(() => {
    setLoading(true);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const applyResult = (
    envelope: { ok: boolean; data?: Credential; error?: { message?: string } | null },
    success: string,
    options: { secretModeAware?: boolean } = {},
  ): void => {
    setBusy(false);
    if (!envelope.ok) {
      addToast(`${success}失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    if (envelope.data) setCred(envelope.data);
    /* bind / renew 的响应带 secretMode：`none` 意味着秘密**没有落盘**（本机无系统
     * 钥匙串）。这时候不能只说「已保存」——重启后查询会失败，而用户不会想到是这个原因。 */
    if (options.secretModeAware && envelope.data?.secretMode === 'none') {
      addToast(`${success.replace(/ ·.*$/, '')} · 但本机没有可用的系统钥匙串：秘密没有被持久化，只保存了引用`);
    } else {
      addToast(success);
    }
    onChanged?.();
    reload();
  };

  const bind = (): void => {
    setModal({
      kind: 'prompt',
      title: '绑定只读凭据',
      label: `「${label}」的凭据值（将经系统钥匙串 safeStorage 加密存本机，不进数据库、不上云）：`,
      placeholder: '密码 / 令牌 / 私钥',
      confirmLabel: '绑定',
      masked: true,
      onSubmit: (secret: string) => {
        if (secret.trim() === '') {
          addToast('凭据值不能为空');
          return;
        }
        setBusy(true);
        void api.bindCredential(assetId, { label, secret, method }).then((envelope) => {
          applyResult(envelope, '凭据已绑定 · 秘密存本机钥匙串，库里只留引用', { secretModeAware: true });
        });
      },
    });
  };

  const rotate = (): void => {
    setModal({
      kind: 'prompt',
      title: '轮换凭据',
      label: `「${label}」的新凭据值（旧密文会被覆盖）—— 轮换必须换秘密本身，只改标签不算轮换：`,
      placeholder: '新的密码 / 令牌 / 私钥',
      confirmLabel: '轮换',
      masked: true,
      onSubmit: (secret: string) => {
        if (secret.trim() === '') {
          addToast('轮换必须输入新的凭据值：只改标签而不换秘密，等于没有轮换');
          return;
        }
        setBusy(true);
        void api.renewCredential(assetId, { label, secret, method }).then((envelope) => {
          applyResult(envelope, '凭据已轮换 · 新密文已写入本机钥匙串', { secretModeAware: true });
        });      },
    });
  };

  const revoke = (): void => {
    setModal({
      kind: 'confirm',
      title: `吊销「${label}」`,
      body: [
        '吊销后三件事会同时发生：',
        '· 这个资产在 Agent 侧立刻失去访问权（工具调用返回「凭据已吊销」）；',
        '· 本机加密存储的凭据密文被删除（不是只改个状态）；',
        '· 要恢复访问只能重新绑定一份新凭据。',
        '',
        '这个操作会记入审计，但不能撤销。',
      ].join('\n'),
      confirmLabel: '确认吊销',
      danger: true,
      onConfirm: () => {
        setBusy(true);
        void api.revokeCredential(assetId).then((envelope) => {
          applyResult(envelope, '凭据已吊销 · 本机密文已删除');
        });
      },
    });
  };

  if (loading) return <div className="cred-line">正在读取凭据状态…</div>;
  if (error) return <div className="cred-err">{error}</div>;

  const state = cred?.state ?? 'unbound';
  const meta = STATE_META[state];
  const bound = state === 'active' || state === 'expiring' || state === 'expired';

  return (
    <div className="cred">
      <div className="cred-head">
        <span className={`cred-badge ${meta.tone}`}>{meta.label}</span>
        {bound && cred?.label ? <span className="cred-label">{cred.label}</span> : null}
      </div>

      {bound ? (
        <div className="cred-kv">
          {cred?.authMethod ? (
            <div>
              <span className="cred-k">鉴权方式</span>
              <span className="cred-v">{cred.authMethod}</span>
            </div>
          ) : null}
          {cred?.username ? (
            <div>
              <span className="cred-k">账号</span>
              <span className="cred-v">{cred.username}</span>
            </div>
          ) : null}
          <div>
            <span className="cred-k">到期</span>
            <span className="cred-v">{cred?.expiresAt ? cred.expiresAt : '不自动过期'}</span>
          </div>
          <div>
            <span className="cred-k">最近使用</span>
            <span className="cred-v">{cred?.lastUsedLabel || '—'}</span>
          </div>
        </div>
      ) : null}

      {meta.hint ? <div className={`cred-hint ${meta.tone}`}>{meta.hint}</div> : null}

      <div className="cred-actions">
        {bound ? (
          <>
            <button className="btn" type="button" onClick={rotate} disabled={busy}>
              轮换凭据
            </button>
            <button className="btn danger" type="button" onClick={revoke} disabled={busy}>
              吊销
            </button>
          </>
        ) : (
          <button className="btn p" type="button" onClick={bind} disabled={busy}>
            {state === 'revoked' ? '重新绑定凭据' : '绑定凭据'}
          </button>
        )}
        {state === 'expired' ? (
          <button className="btn" type="button" onClick={revoke} disabled={busy}>
            吊销
          </button>
        ) : null}
      </div>

      {busy ? <div className="cred-line">正在提交…</div> : null}
    </div>
  );
}
