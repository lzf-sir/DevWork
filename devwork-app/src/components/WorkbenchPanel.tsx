/**
 * 右栏工作台（Workbench）—— 内置浏览器 / 文件 / 终端。
 *
 * 定位变了：这一栏原来装的是「上下文 / 执行 / 产物」——**追问型**信息，
 * 现在那三块搬到了会话右缘的悬浮气泡里（见 components/ChatHudDock）。
 * 这一栏改装**工具**：能直接操作的东西。
 *
 * 为什么这么分：
 *   追问型信息的特点是「问完就走」，常驻一栏会占掉最贵的位置；
 *   工具型信息的特点是「随时要用」，就该有一栏固定位置，而且要能多开几种。
 *
 * 三个 Tab 各自对应一类"现场"：
 *   浏览器 —— 看网页（Agent 也能导航它）；
 *   文件   —— 看产物（文本 / 图片内联，二进制只给下载）；
 *   终端   —— 看命令行现场（裁决仍由服务端权限内核做）。
 *
 * 宽度可拖（260~720，文件/代码预览需要版面，上限从 420 放宽）、⌘\ 折叠，行为与旧右栏一致。
 */
import React from 'react';
import { useStore, type BenchTab } from '../store';
import { useLiveVersion } from '../api/live';
import { ArrowIcon, PanelIcon } from './icons';
import { Resizer, usePanelWidth } from './Resizer';
import BrowserPane from './BrowserPane';
import FilePane from './FilePane';
import TermPane from './TermPane';

const TABS: { id: BenchTab; label: string }[] = [
  { id: 'browser', label: '浏览器' },
  { id: 'file', label: '文件' },
  { id: 'term', label: '终端' },
];

export default function WorkbenchPanel(): React.ReactElement {
  const { state, setBenchTab, toggleRight } = useStore();
  /** 数据版本：产物等切片刷新后强制重渲染。 */
  const revision = useLiveVersion();

  /** 宽度：260~720px，拖拽手柄在左边界，宽度落 localStorage。
   * 上限 720（原设计 §9.18 的 420）——「文件」Tab 现在要放代码/表格/PDF 预览，420 塞不下。 */
  const { width, dragging, beginDrag, reset: resetWidth } = usePanelWidth({
    storageKey: 'devwork-bench-width', initial: 300, min: 260, max: 720,
  });

  const hidden = state.view !== 'chat' || state.rightCollapsed;

  return (
    <>
      <aside
        className={`bench${hidden ? ' off' : ''}`}
        id="bench"
        data-revision={revision}
        style={{ ['--bench-w' as string]: `${width}px` } as React.CSSProperties}
      >
        {/* 右栏左边界拖拽手柄：260~720px（设计 §9.18 原为 260~420，预览需要版面而放宽）。 */}
        <Resizer edge="left" dragging={dragging} onBegin={beginDrag} onReset={resetWidth} />
        <div className="ptabs">
          {TABS.map((tab) => (
            <div
              className={`ptab${state.benchTab === tab.id ? ' on' : ''}`}
              data-p={tab.id}
              key={tab.id}
              onClick={() => setBenchTab(tab.id)}
            >
              {tab.label}
            </div>
          ))}
          <button
            className="ptab-x"
            type="button"
            title="收起工作台（⌘\）"
            aria-label="收起工作台"
            onClick={toggleRight}
          >
            <ArrowIcon dir="right" size={12} strokeWidth={1.6} />
          </button>
        </div>
        <div className="pbody">
          <div className={`pb${state.benchTab === 'browser' ? ' on' : ''}`} data-p="browser">
            <BrowserPane />
          </div>
          <div className={`pb${state.benchTab === 'file' ? ' on' : ''}`} data-p="file">
            <FilePane />
          </div>
          <div className={`pb${state.benchTab === 'term' ? ' on' : ''}`} data-p="term">
            <TermPane />
          </div>
        </div>
      </aside>
      {/* 收起后：展开按钮停在工作台原本的右上角（与收起按钮同一坐标）。 */}
      {state.view === 'chat' && state.rightCollapsed ? (
        <button
          className="ptab-x bench-restore no-drag"
          type="button"
          title="展开工作台（⌘\）"
          aria-label="展开工作台"
          aria-pressed={false}
          onClick={toggleRight}
        >
          <PanelIcon side="right" size={13} />
        </button>
      ) : null}
    </>
  );
}
