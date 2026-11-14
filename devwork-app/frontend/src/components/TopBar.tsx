import React from 'react';
import { useStore } from '../store';
import { ArrowIcon, CodeIcon, PanelIcon, SearchIcon } from './icons';

/** 顶栏：44px。左侧「菜单」折叠按钮固定在窗口左上角（收起 / 展开共用一个按钮）；
 *  工作区下拉、全局搜索（居中）；右侧「开发者模式」开关 + Windows 窗口控制按钮。
 *  右栏（会话面板）的收起 / 展开按钮不再放在顶栏，见 ContextPanel。 */
export default function TopBar(): React.ReactElement {
  const { state, navigate, toggleLeft, setPalette } = useStore();
  const project = state.projects.find((p) => p.id === state.workspaceId) ?? state.projects[0];
  /* 一个工作区都没有时（打包态首次启动）没有名字可显示，如实写「未选择项目」而不是让渲染炸掉。 */
  const wsName = project?.name ?? '未选择项目';

  /** Windows 窗口控制按钮；Web 模式下 window.desktop 不存在，点击保持无副作用。 */
  const desktopClose = (): void => { void window.desktop?.close(); };
  const desktopMinimize = (): void => { void window.desktop?.minimize(); };
  const desktopMaximize = (): void => { void window.desktop?.maximize(); };
  const handleDoubleClick = (): void => { void window.desktop?.maximize(); };

  /** 开发者工具开关状态：挂载时向主进程对账，之后靠事件流保持同步
   *  （F12 / DevTools 自身关闭都会推过来，按钮高亮不丢真值）。 */
  const [devtoolsOpen, setDevtoolsOpen] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void window.desktop?.isDevToolsOpen().then((open) => { if (alive) setDevtoolsOpen(open); });
    const off = window.desktop?.onDevToolsChange((open) => { if (alive) setDevtoolsOpen(open); });
    return () => { alive = false; off?.(); };
  }, []);
  const toggleDevTools = (): void => {
    /* 返回值即切换后状态，乐观更新；事件流兜底校正。 */
    void window.desktop?.toggleDevTools().then((open) => setDevtoolsOpen(open));
  };

  return (
    <div className="topbar" onDoubleClick={handleDoubleClick}>
      {/* 菜单折叠：固定在窗口左上角，状态切换只换图标，位置永远不变。 */}
      <button
        className="chrome-toggle menu-toggle no-drag"
        type="button"
        title={state.leftCollapsed ? '展开菜单（⌘B）' : '收起菜单（⌘B）'}
        aria-label={state.leftCollapsed ? '展开菜单' : '收起菜单'}
        aria-pressed={state.leftCollapsed}
        onClick={toggleLeft}
      >
        {state.leftCollapsed ? <PanelIcon side="left" /> : <ArrowIcon dir="left" size={13} strokeWidth={1.6} />}
      </button>
      <div className="wsdrop no-drag" title="切换项目" onClick={() => navigate('projects')}>
        <i />
        <span id="wsname">{wsName}</span>
        <span className="chev" />
      </div>
      <div className="grow" />
      {/* 全局搜索栏：居中，点击打开命令面板 */}
      <div className="topbar-search no-drag" title="全局搜索（⌘K）" onClick={() => setPalette(true)}>
        <SearchIcon size={13} className="topbar-search-icon" />
        <span className="topbar-search-placeholder">搜索会话 / 资产 / 项目 / 命令…</span>
        <span className="kbd">⌘K</span>
      </div>
      <div className="grow" />
      {/* 开发者模式：切换 DevTools 停靠右侧；Web 模式无 desktop 桥，按钮不渲染。 */}
      {window.desktop && (
        <button
          className={`chrome-toggle devmode-toggle no-drag${devtoolsOpen ? ' on' : ''}`}
          type="button"
          title={devtoolsOpen ? '关闭开发者工具' : '开发者模式：在右侧显示开发者工具'}
          aria-label="开发者模式"
          aria-pressed={devtoolsOpen}
          onClick={toggleDevTools}
        >
          <CodeIcon size={13} strokeWidth={1.6} />
          <span className="devmode-label">开发者模式</span>
        </button>
      )}
      {/* Windows 窗口控制按钮：最小化 / 最大化 / 关闭 */}
      <div className="win-controls no-drag">
        <button type="button" className="wc-btn" title="最小化" aria-label="最小化" onClick={desktopMinimize}>
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
        <button type="button" className="wc-btn" title="最大化" aria-label="最大化" onClick={desktopMaximize}>
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.6" y="0.6" width="8.8" height="8.8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
        <button type="button" className="wc-btn wc-close" title="关闭" aria-label="关闭" onClick={desktopClose}>
          <svg width="10" height="10" viewBox="0 0 10 10"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.2" /><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.2" /></svg>
        </button>
      </div>
    </div>
  );
}
