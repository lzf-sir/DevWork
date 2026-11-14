/**
 * 会话右缘的入口坞（Dock）—— 侧边工作区的**唯一入口**，四个固定图标。
 *
 * 四种内容、两种开法：
 *   上下文 / 任务列表 / 浏览器 —— 点一下就在工作区新开（或激活）一个详情 tab；
 *   产物                        —— 先弹一个轻量列表让你选文件，选中才在工作区开详情。
 *
 * 为什么产物要分出来：产物是**清单**，清单不该占工作区版面。
 * 工作区只放详情（一份上下文、一份任务清单、一个网页、一个文件）；
 * 清单属于「选择动作」，浮层最合适 —— 选完即收，不留下一个空的列表 tab。
 *
 * 坞本身不存内容：高亮看的是「工作区当前显示的是不是它」，产物看浮层是否开着。
 */
import React, { useEffect } from 'react';
import { useStore, type BenchPaneKind } from '../store';
import { CloseIcon, FileIcon, GlobeIcon, SearchIcon, TodoIcon } from './icons';
import { ArtifactPane } from './SessionPanes';

interface DockItem {
  kind: Exclude<BenchPaneKind, 'artifact'> | 'artifact-picker';
  label: string;
  hint: string;
  icon: React.ReactNode;
}

const ITEMS: DockItem[] = [
  {
    kind: 'ctx',
    label: '上下文',
    hint: '它现在看到了什么：挂载资产 / 检索命中 / 上下文构成',
    icon: <SearchIcon size={15} strokeWidth={1.5} />,
  },
  {
    kind: 'todo',
    label: '任务列表',
    hint: '它要做的每一步：待办 / 进行中 / 已完成',
    icon: <TodoIcon size={15} strokeWidth={1.5} />,
  },
  {
    kind: 'artifact-picker',
    label: '产物',
    hint: '它产出了什么：先选文件，再在工作区看详情',
    icon: <FileIcon size={15} strokeWidth={1.5} />,
  },
  {
    kind: 'browser',
    label: '浏览器',
    hint: '内置浏览器，Agent 也能导航它',
    icon: <GlobeIcon size={15} strokeWidth={1.5} />,
  },
];

export default function ChatHudDock(): React.ReactElement {
  const { state, openBench, setArtifactPicker } = useStore();
  const pickerOpen = state.artifactPickerOpen;

  /** 点外部收起浮层：浮层是「选一个就走」的东西，挂着会挡住会话。 */
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.hud-dock')) return;
      setArtifactPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [pickerOpen, setArtifactPicker]);

  return (
    <div className="hud-dock">
      {ITEMS.map((item) => {
        const isPicker = item.kind === 'artifact-picker';
        /* 高亮的判据是「工作区此刻显示的是不是它」；产物看浮层是否开着。 */
        const active = isPicker
          ? pickerOpen
          : !state.rightCollapsed && state.benchActive === item.kind;
        return (
          <div className="hud-slot" key={item.kind}>
            <button
              className={`hud-btn${active ? ' on' : ''}`}
              type="button"
              title={`${item.label} · ${item.hint}`}
              aria-label={item.label}
              aria-expanded={isPicker ? pickerOpen : active}
              onClick={() => {
                if (isPicker) setArtifactPicker(!pickerOpen);
                else openBench(item.kind as Exclude<BenchPaneKind, 'artifact'>);
              }}
            >
              {item.icon}
              <span className="hud-tip">{item.label}</span>
            </button>
            {isPicker && pickerOpen ? (
              <div className="hud-pop" role="dialog" aria-label="产物">
                <div className="hud-pop-hd">
                  <span className="hud-pop-t">产物</span>
                  <span className="hud-pop-h">选一个，在工作区看详情</span>
                  <button
                    className="hud-pop-x"
                    type="button"
                    aria-label="收起"
                    onClick={() => setArtifactPicker(false)}
                  >
                    <CloseIcon size={12} strokeWidth={1.5} />
                  </button>
                </div>
                <div className="hud-pop-bd">
                  <ArtifactPane compact />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
