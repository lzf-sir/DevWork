/**
 * 会话标签栏 —— 主区域顶部那一排，浏览器式语义。
 *
 * 为什么值得单独一条栏，而不是把「切换会话」留给侧栏：
 *   侧栏回答的是「历史上有哪些会话」（可能几百条，按文件夹排）；
 *   标签栏回答的是「我现在同时盯着哪几个」（通常 2~4 条）。
 * 两者的信息衰减方式完全不同 —— 侧栏越用越长，标签栏越用越短。
 *
 * 交互约定（与桌面浏览器对齐，不发明新操作）：
 *   · 左键 = 激活；中键 = 关闭；关闭按钮常驻但是淡的，hover 才实心；
 *   · ⌘/Ctrl + 1..9 = 按位置切换（见 App.tsx 的 useGlobalShortcuts）；
 *   · 双击标题 = 重命名（与侧栏同一套 prompt 弹窗）；
 *   · 关 tab 不删会话 —— 会话还在侧栏，重新点开就回来了。
 *
 * 两个状态点都不是装饰：
 *   · 蓝点 = 该会话正在生成（多 tab 并行的唯一可见证据，否则用户不知道切走的那个在跑）；
 *   · 橙点 = 该会话里有待审批卡（不切过去就没法处理的，必须能被看见）。
 */
import React from 'react';
import { useStore } from '../store';
import { PlayIcon, PlusIcon } from './icons';

export default function SessionTabBar(): React.ReactElement {
  const {
    state,
    closeSessionTab,
    setConversation,
    newConversation,
    toggleCollab,
    setModal,
    renameConversation,
  } = useStore();

  const collabOn = state.collabFor !== null && state.collabFor === state.activeConversationId;

  return (
    <div className="stabs" role="tablist" aria-label="打开的会话">
      {state.sessionTabs.map((tab) => {
        const active = tab.id === state.activeConversationId;
        const generating = state.streams[tab.id] !== undefined;
        /* 有待处理项的两条来源，缺一条就会「人在别的 tab 等你」：
         *   ① 会话里的审批/建议卡 —— 要在这一条会话里点；
         *   ② 这条会话的工单停在 person/* —— Agent 已经停下来，等你一句话。 */
        const cardPending = (state.threads[tab.id] ?? []).some(
          (message) => message.kind === 'approval' || message.kind === 'suggestion',
        );
        const waitingHere = state.waiting.filter((item) => item.conversationId === tab.id);
        const pending = cardPending || waitingHere.length > 0;
        const pendingNote = waitingHere.length > 0
          ? waitingHere.length > 1
            ? ` · ${waitingHere.length} 张单等你处理`
            : ` · ${waitingHere[0].waitingFor}`
          : cardPending
            ? ' · 有待处理项'
            : '';
        return (
          <div
            key={tab.id}
            className={`stab${active ? ' on' : ''}`}
            role="tab"
            aria-selected={active}
            /* 会话 id 落到 DOM 上：外部（自动化验收、调试）要能确认「这一格是哪个会话」。
             * 只靠标题文本判断，会在同名会话或标题还没回填时误判。 */
            data-tab-id={tab.id}
            title={`${tab.title || '未命名会话'}${generating ? ' · 正在生成' : ''}${pendingNote}`}
            onClick={() => {
              /* 已经激活就别再走一遍 setConversation：那会重拉消息、重置滚动位置，
               * 用户点自己脚下的 tab 只是想关掉别的东西，不是想刷新。 */
              if (active) {
                if (collabOn) toggleCollab(false);
                return;
              }
              setConversation(tab.id, tab.title);
            }}
            onAuxClick={(event) => {
              /* 中键关闭：和浏览器一致，误触成本最低。 */
              if (event.button === 1) {
                event.preventDefault();
                closeSessionTab(tab.id);
              }
            }}
            onDoubleClick={() => {
              setModal({
                kind: 'prompt',
                title: '重命名会话',
                label: '新的会话名称：',
                placeholder: tab.title,
                confirmLabel: '保存',
                onSubmit: (value) => renameConversation(tab.id, value),
              });
            }}
          >
            <span className={`stab-dot${generating ? ' run' : pending ? ' wait' : ''}`} aria-hidden="true" />
            <span className="stab-title">{tab.title || '未命名会话'}</span>
            <button
              className="stab-x"
              type="button"
              title="关闭标签页（会话不会被删除）"
              aria-label={`关闭 ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                closeSessionTab(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}

      <button className="stab-new" type="button" title="新建会话（⌘N）" aria-label="新建会话" onClick={newConversation}>
        <PlusIcon size={12} strokeWidth={1.8} />
      </button>

      <div className="stabs-fill" />

      {/* 协作流：不是一条会话 tab，而是「当前这条会话的执行链路」另一种看法，
          所以它钉在右侧、与左侧的会话 tab 有一条分隔线区分语义。 */}
      <button
        className={`stab-collab${collabOn ? ' on' : ''}`}
        type="button"
        title="协作流：这条会话从提问到派工、到产物，每一步在谁手里"
        aria-pressed={collabOn}
        onClick={() => toggleCollab()}
      >
        <PlayIcon size={12} strokeWidth={1.6} />
        协作流
      </button>
    </div>
  );
}
