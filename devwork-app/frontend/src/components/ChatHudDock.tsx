/**
 * 会话悬浮按钮坞（HUD Dock）—— 上下文 / 执行 / 产物。
 *
 * 为什么从右栏搬到这里：
 * 右栏那个位置应该留给**工具**（内置浏览器 / 文件 / 终端），因为工具回答的是
 * 「我现在能操作什么」；而上下文 / 执行 / 产物回答的是「刚才那轮到底怎么回事」——
 * 是**追问**，问完就收。三块都常驻右栏，等于把工具位挤没了。
 *
 * 形态：三个按钮贴在会话区右缘（垂直居中），点一个弹一个气泡。
 *   - 气泡挂在按钮上（按钮的子节点），所以永远对准被点的那个按钮；
 *   - 同时只开一个（再点另一个直接切换），不叠三张皮；
 *   - 点别处 / 按 Esc 收起。
 *
 * 数据来自 LiveDataProvider（跟随活跃会话），气泡内容复用 components/SessionPanes。
 */
import React, { useEffect } from 'react';
import { useStore, type HudPane } from '../store';
import { CloseIcon, FileIcon, SearchIcon, TerminalIcon } from './icons';
import { ArtifactPane, ContextPane, ExecutionPane } from './SessionPanes';

interface HudItem {
  id: Exclude<HudPane, null>;
  label: string;
  hint: string;
  icon: React.ReactNode;
}

const ITEMS: HudItem[] = [
  { id: 'ctx', label: '上下文', hint: '它现在看到了什么：挂载资产 / 检索命中 / 上下文构成', icon: <SearchIcon size={15} strokeWidth={1.5} /> },
  { id: 'run', label: '执行', hint: '它跑了什么：工具调用 / 耗时 / 待审批项', icon: <TerminalIcon size={15} strokeWidth={1.5} /> },
  { id: 'out', label: '产物', hint: '它产出了什么：文件列表，可下载或在右栏预览', icon: <FileIcon size={15} strokeWidth={1.5} /> },
];

export default function ChatHudDock(): React.ReactElement {
  const { state, setHudPane } = useStore();
  const open = state.hudPane;

  /** 点外部收起：气泡是「问完即走」的东西，一直挂着会挡住会话。 */
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.hud-dock')) return;
      setHudPane(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, setHudPane]);

  /** 气泡内容按当前 Tab 渲染，三份内容共用 SessionPanes。 */
  const body = (pane: Exclude<HudPane, null>): React.ReactNode => {
    if (pane === 'ctx') return <ContextPane compact />;
    if (pane === 'run') return <ExecutionPane compact />;
    return <ArtifactPane compact />;
  };

  return (
    <div className="hud-dock" data-open={open ?? ''}>
      {ITEMS.map((item) => {
        const active = open === item.id;
        return (
          <div className="hud-slot" key={item.id}>
            <button
              className={`hud-btn${active ? ' on' : ''}`}
              type="button"
              title={`${item.label} · ${item.hint}`}
              aria-label={item.label}
              aria-expanded={active}
              onClick={() => setHudPane(active ? null : item.id)}
            >
              {item.icon}
              <span className="hud-tip">{item.label}</span>
            </button>
            {active ? (
              <div className="hud-pop" role="dialog" aria-label={item.label}>
                <div className="hud-pop-hd">
                  <span className="hud-pop-t">{item.label}</span>
                  <span className="hud-pop-h">{item.hint}</span>
                  <button className="hud-pop-x" type="button" aria-label="收起" onClick={() => setHudPane(null)}>
                    <CloseIcon size={12} strokeWidth={1.5} />
                  </button>
                </div>
                <div className="hud-pop-bd">{body(item.id)}</div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
