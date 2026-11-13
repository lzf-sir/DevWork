import React, { useEffect, useRef } from 'react';
import { CapList, KV, MetricGrid, SectionTitle } from './ui';
import { CloseIcon } from './icons';
import type { CapItem } from '../api/client';

/**
 * 资产配置抽屉（右侧滑出）。
 *
 * 能力授权 / 凭据绑定 / 资产信息三块内容收在这里，不再占用详情页的 Tab 位；
 * 详情页因此只保留「主功能区」一个默认落点。
 * 能力开关复用 CapList —— 传 assetId 时切换会真的 PATCH 落库并失败回滚。
 */

export interface AssetConfigDrawerProps {
  /** 抽屉是否展开（受 store.configOpen 控制）。 */
  open: boolean;
  /** 资产名称，作为抽屉标题。 */
  title: string;
  /** 副标题（连接串 / 仓库路径等），可空。 */
  sub?: string;
  /** 能力项；为空则不渲染「能力授权」分区。 */
  caps?: CapItem[];
  /** 能力项对应的资产 ID —— 传了才会真的落库。 */
  assetId?: string;
  /** 只读模式下锁定部分能力。 */
  readOnly?: boolean;
  /** 凭据区块（数据库资产用）：绑定 / 轮换。 */
  credential?: React.ReactNode;
  /** 资产指标卡（概览页搬过来的）。 */
  metrics?: { k: string; v: string; s?: string }[];
  /** 连接 / 仓库等键值信息。 */
  kv?: { k: string; v: React.ReactNode }[];
  /** 最近活动。 */
  activity?: { k: string; v: React.ReactNode }[];
  /** 自定义追加区块（如知识库的文档清单）。 */
  children?: React.ReactNode;
  /** 关闭回调。 */
  onClose: () => void;
}

export default function AssetConfigDrawer({
  open,
  title,
  sub,
  caps,
  assetId,
  readOnly,
  credential,
  metrics,
  kv,
  activity,
  children,
  onClose,
}: AssetConfigDrawerProps): React.ReactElement | null {
  const panelRef = useRef<HTMLDivElement>(null);

  /* 抽屉打开时把焦点移进面板，Esc 关闭后焦点回到触发按钮（键盘可达性）。 */
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => panelRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="dwrmask"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dwr" role="dialog" aria-modal="true" aria-label={`${title} 配置`} tabIndex={-1} ref={panelRef}>
        <div className="dwr-h">
          <div className="dwr-t">{title}</div>
          <div className="dwr-s">{sub ?? '资产配置'}</div>
          <button className="dwr-x" type="button" aria-label="关闭配置抽屉" onClick={onClose}>
            <CloseIcon size={13} strokeWidth={1.5} />
          </button>
        </div>

        <div className="dwr-b">
          {caps && caps.length > 0 ? (
            <>
              <SectionTitle>能力授权</SectionTitle>
              <CapList items={caps} readOnly={!!readOnly} assetId={assetId} />
            </>
          ) : null}

          {credential ? (
            <>
              <SectionTitle>我的凭据</SectionTitle>
              <div className="dwr-cred">{credential}</div>
            </>
          ) : null}

          {metrics && metrics.length > 0 ? (
            <>
              <SectionTitle>资产信息</SectionTitle>
              <MetricGrid items={metrics} />
            </>
          ) : null}

          {kv && kv.length > 0 ? (
            <>
              <SectionTitle>连接与权限</SectionTitle>
              <KV rows={kv} />
            </>
          ) : null}

          {activity && activity.length > 0 ? (
            <>
              <SectionTitle>最近活动</SectionTitle>
              <KV rows={activity} />
            </>
          ) : null}

          {children}
        </div>
      </div>
    </div>
  );
}
