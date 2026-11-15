import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import type { CapItem } from '../api/client';
import SensitiveRulesEditor from './SensitiveRulesEditor';
import {
  ArrowIcon,
  ChartIcon,
  DotsIcon,
  DownloadIcon,
  ErrorIcon,
  GearIcon,
  LockIcon,
  PanelIcon,
  SendIcon,
  WarningIcon,
} from './icons';
/* ===================== 图标兼容导出 =====================
   旧组件名（*Svg）保留为薄封装，新代码直接用 components/icons 里的具名图标。
   这样既不用改动所有调用点，也能保证全站图标风格一致。 */

export function LockSvg(): React.ReactElement {
  return <LockIcon size={12} strokeWidth={1.3} />;
}

export function TriangleSvg(): React.ReactElement {
  return <WarningIcon size={13} strokeWidth={1.3} />;
}

export function DownloadSvg(): React.ReactElement {
  return <DownloadIcon size={14} strokeWidth={1.3} />;
}

export function DotsSvg(): React.ReactElement {
  return <DotsIcon size={14} />;
}

export function GearSvg(): React.ReactElement {
  return <GearIcon size={14} strokeWidth={1.5} />;
}

export function ChartSvg(): React.ReactElement {
  return <ChartIcon size={15} strokeWidth={1.3} />;
}

export function SendSvg(): React.ReactElement {
  return <SendIcon size={14} strokeWidth={1.5} />;
}

/** 侧栏 / 面板图标：side=left 高亮左列，side=right 高亮右列。 */
export function PanelSvg({ side = 'left', size = 14 }: { side?: 'left' | 'right'; size?: number }): React.ReactElement {
  return <PanelIcon side={side} size={size} strokeWidth={1.3} />;
}

/** 收起 / 展开箭头：dir=left 指向左侧，dir=right 指向右侧。 */
export function ChevronSvg({ dir = 'left' }: { dir?: 'left' | 'right' }): React.ReactElement {
  return <ArrowIcon dir={dir} size={12} strokeWidth={1.6} />;
}

/* ===================== 通用骨架片段 ===================== */

export function Banner({
  children,
  tone = 'warn',
  icon,
}: {
  children: React.ReactNode;
  tone?: 'warn' | 'ok';
  icon?: React.ReactNode;
}): React.ReactElement {
  const defaultIcon = tone === 'warn' ? <LockSvg /> : <span className="sdot" />;
  return (
    <div className={`banner${tone === 'ok' ? ' ok' : ''}`}>
      {icon ?? defaultIcon}
      {children}
    </div>
  );
}

export function MetricGrid({ items }: { items: { k: string; v: string; s?: string }[] }): React.ReactElement {
  return (
    <div className="ov-grid">
      {items.map((item) => (
        <div className="mcard" key={item.k}>
          <div className="k">{item.k}</div>
          <div className="v">
            {item.v}
            {item.s ? <s>{item.s}</s> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

export function KV({ rows }: { rows: { k: string; v: React.ReactNode }[] }): React.ReactElement {
  return (
    <div className="kv">
      {rows.map((row) => (
        <div className="kr" key={row.k}>
          <div className="kk">{row.k}</div>
          <div className="vv">{row.v}</div>
        </div>
      ))}
    </div>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="sect-t">{children}</div>;
}

export function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: 'ok' | 'ro' | 'plain';
}): React.ReactElement {
  return <div className={`pill${tone === 'plain' ? '' : ` ${tone}`}`}>{children}</div>;
}

export function DetailHeader({
  icon,
  name,
  sub,
  pills,
  actions,
}: {
  /** 资产类型图标（React 节点）。传 SVG 组件而非字符，全站图标风格才统一。 */
  icon: React.ReactNode;
  name: string;
  sub: string;
  pills: React.ReactNode;
  actions: React.ReactNode;
}): React.ReactElement {
  const { navigate } = useStore();
  return (
    <div className="dhead">
      <button className="back" type="button" title="返回会话" aria-label="返回会话" onClick={() => navigate('chat')}>
        <ArrowIcon dir="left" size={14} strokeWidth={1.6} />
      </button>
      <div className="dicon">{icon}</div>
      <div>
        <div className="dname">{name}</div>
        <div className="dsub">{sub}</div>
      </div>
      {pills}
      <div className="dacts">{actions}</div>
    </div>
  );
}

export function DetailTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}): React.ReactElement | null {
  /* 只剩一个 Tab 时整行不渲染：详情页默认落在主功能区，
   * 一行「终端 / 编辑器」这样的单选项没有信息量，还白占 40px 高度。 */
  if (tabs.length <= 1) return null;
  return (
    <div className="dtabs">
      {tabs.map((tab) => (
        <div
          className={`dtab${active === tab.id ? ' on' : ''}`}
          data-dt={tab.id}
          key={tab.id}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </div>
      ))}
    </div>
  );
}

/** 能力授权列表：lock 项在只读模式下不允许开启并给出说明。
 * B21：开关真化 —— 传入 assetId 时切换即 PATCH /assets/:id/capabilities/:capId 落库，
 * 乐观更新 + 失败回滚；离线态走 mock 兜底（同样返回 ok）。 */
export function CapList({
  items,
  readOnly,
  assetId,
}: {
  items: CapItem[];
  readOnly: boolean;
  assetId?: string;
}): React.ReactElement {
  const { addToast } = useStore();
  const [states, setStates] = useState<boolean[]>(items.map((item) => item.on));

  useEffect(() => {
    setStates(items.map((item) => item.on));
  }, [items]);

  const toggle = (index: number): void => {
    const item = items[index];
    if (item.lock && readOnly && !states[index]) {
      addToast(item.lockHint ?? '只读模式下不可开启该项');
      return;
    }
    const next = !states[index];
    setStates((prev) => prev.map((value, i) => (i === index ? next : value)));
    addToast(`${item.name}：${next ? '已开启' : '已关闭'}${assetId && item.id ? ' · 已保存' : ''}`);
    if (assetId && item.id) {
      void api
        .updateCapability(assetId, item.id, { granted: next })
        .then((envelope) => {
          if (!envelope.ok) {
            setStates((prev) => prev.map((value, i) => (i === index ? !next : value)));
            addToast(`保存失败：${envelope.error?.message ?? '未知错误'}`);
          }
        })
        .catch(() => {
          setStates((prev) => prev.map((value, i) => (i === index ? !next : value)));
          addToast('保存失败：网络异常，已回滚');
        });
    }
  };

  return (
    <div className="caps">
      {items.map((item, index) => {
        const locked = !!item.lock && readOnly;
        return (
          <div className={`cap${locked ? ' lock' : ''}`} key={item.name}>
            <div className="ci">
              <div className="cn">{item.name}</div>
              <div className="cd">{item.desc}</div>
            </div>
            <div
              className={`sw${states[index] ? '' : ' off'}`}
              role="switch"
              aria-checked={states[index]}
              onClick={() => toggle(index)}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ===================== 工具函数 ===================== */

export function copyToClipboard(text: string): void {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      void navigator.clipboard.writeText(text);
    } else {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
  } catch {
    /* 剪贴板不可用时静默降级，仍给出 UI 反馈 */
  }
}

/**
 * 触发浏览器下载。默认加 UTF-8 BOM —— Excel 打开 CSV 不加 BOM 会中文乱码；
 * 导出 Markdown / JSON 这类非 CSV 格式要传 bom=false，否则文件开头会多一个不可见字符。
 */
export function downloadFile(
  filename: string,
  content: string,
  mime = 'text/csv;charset=utf-8',
  bom = true,
): void {
  const blob = new Blob([bom ? '\uFEFF' : '', content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ===================== 全局浮层 ===================== */

export function ToastStack(): React.ReactElement {
  const { state } = useStore();
  return (
    /* 资产会话坞展开时把 toast 抬高：否则它会压在坞的发送按钮上。
     * 折叠态只占 40px 窄边条，不挡右下角，不用抬高。 */
    <div className={`toast-wrap${state.assetChat && !state.assetChatCollapsed ? ' dock-open' : ''}`}>
      {state.toasts.map((toast) => {
        /* 文案以 ✕ 开头 = 失败，⚠ 开头 = 需注意，其余为中性提示。
         * 用图标而不是字符，toast 的语气才能一眼分辨。 */
        const text = toast.text;
        const isError = text.startsWith('✕');
        const isWarn = text.startsWith('⚠');
        const body = isError || isWarn ? text.slice(1).trim() : text;
        return (
          <div className={`toast${isError ? ' err' : isWarn ? ' warn' : ''}`} key={toast.id}>
            {isError ? (
              <span className="tic">
                <ErrorIcon size={13} strokeWidth={1.5} />
              </span>
            ) : isWarn ? (
              <span className="tic">
                <WarningIcon size={13} strokeWidth={1.5} />
              </span>
            ) : null}
            <span>{body}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ModalHost(): React.ReactElement {
  const { state, setModal, addToast } = useStore();
  const [input, setInput] = useState<string>('');
  const modal = state.modal;

  useEffect(() => {
    setInput('');
  }, [modal]);

  if (!modal) {
    return <></>;
  }

  const close = (): void => setModal(null);

  const footer = (buttons: React.ReactNode): React.ReactElement => (
    <div className="mfoot">{buttons}</div>
  );

  let body: React.ReactNode = null;
  let foot: React.ReactNode = null;

  if (modal.kind === 'confirm') {
    body = <div className="mbody">{modal.body}</div>;
    foot = footer(
      <>
        <button className="btn" onClick={close}>
          取消
        </button>
        <button
          className={`btn${modal.danger ? ' danger' : ' p'}`}
          onClick={() => {
            close();
            modal.onConfirm();
          }}
        >
          {modal.confirmLabel}
        </button>
      </>,
    );
  } else if (modal.kind === 'info') {
    body = <div className={`mbody${modal.mono ? ' mono' : ''}`}>{modal.body}</div>;
    foot = footer(
      <button className="btn p" onClick={close}>
        知道了
      </button>,
    );
  } else if (modal.kind === 'prompt') {
    body = (
      <>
        <div className="mbody">{modal.label}</div>
        <input
          className="minput"
          type={modal.masked ? 'password' : 'text'}
          value={input}
          placeholder={modal.placeholder ?? ''}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && input.trim()) {
              close();
              modal.onSubmit(input.trim());
            }
          }}
          autoFocus
        />
      </>
    );
    foot = footer(
      <>
        <button className="btn" onClick={close}>
          取消
        </button>
        <button
          className="btn p"
          onClick={() => {
            if (!input.trim()) {
              addToast('请输入内容');
              return;
            }
            close();
            modal.onSubmit(input.trim());
          }}
        >
          {modal.confirmLabel}
        </button>
      </>,
    );
  } else if (modal.kind === 'command') {
    body = (
      <>
        <div className="mbody">Agent 发起的命令（只读模式下只生成建议，不执行）：</div>
        <div className="mbody mono">{modal.command}</div>
        <div className="mbody">{modal.body}</div>
      </>
    );
    foot = footer(
      <>
        <button
          className="btn"
          onClick={() => {
            copyToClipboard(modal.command);
            addToast('命令已复制到剪贴板');
          }}
        >
          复制
        </button>
        <button className="btn p" onClick={close}>
          关闭
        </button>
      </>,
    );
  } else if (modal.kind === 'rules') {
    /* 编辑器自带按钮区（保存要看草稿是否合法），所以这里不给 footer。
     * onSaved 只回传条数：调用方（设置页）用它刷新摘要，不关心具体规则内容。 */
    body = <SensitiveRulesEditor onClose={close} onSaved={(rules) => modal.onSaved?.(rules.length)} />;
  } else if (modal.kind === 'files') {
    body = (
      <div className="mfiles">
        {modal.files.map((file) => (
          <button
            className="mfile"
            key={file}
            onClick={() => {
              close();
              modal.onPick(file);
            }}
          >
            {file}
          </button>
        ))}
      </div>
    );
    foot = footer(
      <button className="btn" onClick={close}>
        取消
      </button>,
    );
  }

  return (
    <div className="ovl" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <div className={`modal${modal.kind === 'rules' ? ' modal-rules' : ''}`} onMouseDown={(event) => event.stopPropagation()}>
        <h3>{modal.title}</h3>
        {body}
        {foot}
      </div>
    </div>
  );
}
