/**
 * 侧边工作区（Workbench）—— 会话右侧的**内容显示区**。
 *
 * 形态：一条动态 tab 栏 + 一块内容区。
 *   - 只装**详情**：一份上下文、一份任务清单、一个网页、一个产物文件。
 *     清单类内容（产物列表）不进这里 —— 它在会话右缘的浮层里选，选完才开详情 tab。
 *   - 内容是**进来了才占位**的：点入口图标就在这一栏新开 tab；
 *     同一个入口再点一次只是激活已有 tab，不重复开。
 *   - tab 可多开、可关闭（× / 中键）。关掉的只是这一栏的显示，不删任何数据。
 *   - 全关完就回到空态，等下一次入口点击 —— 不偷偷替用户开一个「默认页」。
 *
 * 宽度可拖（260~720）、⌘\ 折叠，行为与旧右栏一致。
 */
import React from 'react';
import { useStore, type BenchTab } from '../store';
import { useLiveVersion } from '../api/live';
import { ArrowIcon, CloseIcon, PanelIcon } from './icons';
import { Resizer, usePanelWidth } from './Resizer';
import BrowserPane from './BrowserPane';
import { ArtifactPreviewPane } from './ArtifactPreview';
import { ContextPane, TodoListPane } from './SessionPanes';

/** 一个 tab 的内容。工作区只装**详情**：清单类内容走浮层选择，不在这里占位。 */
function BenchBody({ tab }: { tab: BenchTab }): React.ReactElement {
  switch (tab.kind) {
    case 'browser':
      return <BrowserPane />;
    case 'artifact':
      return <ArtifactPreviewPane artifact={{ id: tab.artifactId ?? '', name: tab.title }} />;
    case 'todo':
      return (
        <div className="pane-scroll">
          <TodoListPane />
        </div>
      );
    case 'ctx':
    default:
      return (
        <div className="pane-scroll">
          <ContextPane />
        </div>
      );
  }
}

export default function WorkbenchPanel(): React.ReactElement {
  const { state, closeBench, setBenchActive, toggleRight } = useStore();
  /** 数据版本：产物等切片刷新后强制重渲染。 */
  const revision = useLiveVersion();

  /** 宽度：260~720px，拖拽手柄在左边界，宽度落 localStorage。
   * 上限 720（原设计 §9.18 的 420）——代码/表格/PDF 预览塞不进 420。 */
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
          {/* tab 列表单独一层滚动：收起按钮不跟着滚，永远钉在栏右端。 */}
          <div className="ptabs-scroll" role="tablist" aria-label="侧边工作区">
            {state.benchTabs.map((tab) => {
              const active = tab.key === state.benchActive;
              return (
                <div
                  className={`ptab${active ? ' on' : ''}`}
                  data-p={tab.kind}
                  key={tab.key}
                  role="tab"
                  aria-selected={active}
                  title={tab.title}
                  onClick={() => setBenchActive(tab.key)}
                  /* 中键关闭：与浏览器 / 编辑器同一套肌肉记忆。 */
                  onAuxClick={(event) => {
                    if (event.button === 1) {
                      event.preventDefault();
                      closeBench(tab.key);
                    }
                  }}
                >
                  <span className="ptab-name">{tab.title}</span>
                  <button
                    className="ptab-close"
                    type="button"
                    title="关闭"
                    aria-label={`关闭 ${tab.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeBench(tab.key);
                    }}
                  >
                    <CloseIcon size={9} strokeWidth={1.8} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            className="ptab-x"
            type="button"
            title="收起工作区（⌘\）"
            aria-label="收起工作区"
            onClick={toggleRight}
          >
            <ArrowIcon dir="right" size={12} strokeWidth={1.6} />
          </button>
        </div>
        <div className="pbody">
          {state.benchTabs.length === 0 ? (
            <div className="bench-empty">
              <div className="bench-empty-t">工作区是空的</div>
              <div className="bench-empty-d">
                点会话右缘的图标，把要看的内容放进这一栏 —— 上下文、任务列表、
                浏览器、还有单个产物的详情，都能同时开着，各自占一个标签。
              </div>
            </div>
          ) : (
            /* 已开的 tab 全部保持挂载，只切显示 —— 切回来时浏览器停在原页面、
               终端滚动缓冲还在、产物预览不重新拉。tab 的语义就是「它还开着」。 */
            state.benchTabs.map((tab) => (
              <div
                className={`pb${tab.key === state.benchActive ? ' on' : ''}`}
                data-p={tab.kind}
                key={tab.key}
              >
                <BenchBody tab={tab} />
              </div>
            ))
          )}
        </div>
      </aside>
      {/* 收起后：展开按钮停在工作区原本的右上角（与收起按钮同一坐标）。 */}
      {state.view === 'chat' && state.rightCollapsed ? (
        <button
          className="ptab-x bench-restore no-drag"
          type="button"
          title="展开工作区（⌘\）"
          aria-label="展开工作区"
          aria-pressed={false}
          onClick={toggleRight}
        >
          <PanelIcon side="right" size={13} />
        </button>
      ) : null}
    </>
  );
}
