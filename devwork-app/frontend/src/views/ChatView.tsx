import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';

import { DownloadSvg, DotsSvg, downloadFile } from '../components/ui';
import ChatThread from '../components/ChatThread';
import Composer from '../components/Composer';
import ChatHudDock from '../components/ChatHudDock';
import SessionTabBar from '../components/SessionTabBar';
import CollabView from './CollabView';
import { useAssetCandidates, useConversationSender } from '../hooks/useChatSession';
import { useContextUsage } from '../hooks/useContextUsage';
import { cardsToThread } from '../api/adapters';

/** 会话页：五类卡片 + 真实可输入发送 + 引用浮层。
 *  消息渲染与发送链路已抽到 components/ChatThread 与 hooks/useChatSession，
 *  资产详情页内嵌的会话坞复用同一套实现。 */
export default function ChatView(): React.ReactElement {
  const {
    state,
    addToast,
    setModal,
    renameConversation,
    removeConversation,
    newConversation,
    setConversationModel,
    appendAssistantCards,
    applyUsage,
  } = useStore();
  /** B21：会话操作下拉菜单（重命名 / 删除）。 */
  const [menuOpen, setMenuOpen] = useState<boolean>(false);

  const assets = useAssetCandidates(state.workspaceId);
  const sender = useConversationSender(state.activeConversationId, { assets });

  const messages = state.threads[state.activeConversationId] ?? [];

  /* 上下文用量 + 压缩：消息条数变了就重算（每轮结束都会变），不做轮询。
   * 压缩成功后把摘要卡插进本地时间线 —— 它已经在服务端落库了，这里只是不等刷新。 */
  const ctx = useContextUsage(state.activeConversationId, {
    model: state.conversationModels[state.activeConversationId] ?? '',
    refreshKey: messages.length,
    onCompacted: (result) => {
      if (result.skipped) {
        addToast(result.reason ?? '当前上下文不需要压缩');
        return;
      }
      if (result.card) {
        const card = cardsToThread([result.card]);
        if (card.length > 0) appendAssistantCards(state.activeConversationId, card);
      }
      applyUsage({ contextUsed: result.after, contextBudget: ctx.usage?.budget });
      addToast(
        `已压缩：折叠 ${result.covered} 条对话，约省下 ${result.freed} tokens`
        + `（${result.summary?.source === 'model' ? '模型提炼' : '规则提炼'}；原始消息仍在时间线）`,
      );
    },
    onNotice: (message) => addToast(message),
  });

  /** 没有任何 tab 时主区域给明确空态，不偷偷切到别的会话。 */
  const noTab = !state.activeConversationId;
  /** 协作流是「当前会话的另一种看法」：collabFor 跟 active 不一致时不该串到别的会话。 */
  const collabOpen = state.collabFor !== null && state.collabFor === state.activeConversationId;

  /** 全球快捷键 ⌘↵ 发送（视图外不响应）。 */
  useEffect(() => {
    if (!state.hotkey || state.hotkey.kind !== 'send' || state.view !== 'chat') return;
    sender.send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hotkey]);

  /** B21：离线回落 —— 服务端导出不可用时本地拼接纯文本。 */
  const exportLocal = (): void => {
    const lines = messages.map((message) => {
      if (message.kind === 'user' || message.kind === 'text') return message.text;
      if (message.kind === 'tool') return `[工具] ${message.name} · ${message.status} · ${message.ms}`;
      if (message.kind === 'approval') return `[待审批] ${message.cmd}`;
      if (message.kind === 'suggestion') return `[已拦截·建议] ${message.cmd}`;
      if (message.kind === 'artifact') return `[产物] ${message.name}`;
      if (message.kind === 'plan') return `[计划] ${message.steps.map((step) => step.goal).join(' → ')}`;
      /* 清单与压缩摘要也要进导出文本：会话记录里少了它们，
       * 事后完全看不出"这个长任务推进到哪一步、上下文被折叠过几次"。 */
      if (message.kind === 'todo') {
        const marks = { done: '✓', doing: '▸', blocked: '!', pending: '·' } as const;
        return `[任务清单 ${message.progress.done}/${message.progress.total}] `
          + message.items.map((item) => `${marks[item.status]} ${item.title}`).join(' / ');
      }
      if (message.kind === 'summary') {
        return `[上下文压缩] 折叠 ${message.messages} 条对话（${message.source === 'model' ? '模型提炼' : '规则提炼'}）`;
      }
      if (message.kind === 'notice') return `[提示] ${message.title} / ${message.content.replace(/\r?\n/g, ' ')}`;
      return `[结论] 置信度 ${message.confidence}`;
    });
    downloadFile('devwork-chat.txt', lines.join('\n\n'), 'text/plain;charset=utf-8');
    addToast('会话已导出为 devwork-chat.txt（本地导出）');
  };

  /** 导出会话：优先走服务端真导出（含卡片结构化摘要），离线/失败回落本地拼接。
   *  顶栏导出按钮与 /导出会话 命令共用这一条路径。 */
  const exportConversation = (): void => {
    void api
      .exportConversation(state.activeConversationId, 'md')
      .then((envelope) => {
        if (envelope.ok && envelope.meta?.apiMode === 'live' && envelope.data?.content) {
          downloadFile(envelope.data.fileName, envelope.data.content, 'text/markdown;charset=utf-8');
          addToast(`会话已导出为 ${envelope.data.fileName}（服务端导出）`);
          return;
        }
        exportLocal();
      })
      .catch(exportLocal);
  };

  return (
    <div className={`view${state.view === 'chat' ? ' on' : ''}`} data-view="chat">
      {/* 多会话标签栏：一条会话一个 tab，切换不重挂载、草稿与流式状态按会话隔离。 */}
      <SessionTabBar />

      {noTab ? (
        <div className="stab-empty">
          <div className="stab-empty-t">没有打开的会话</div>
          <div className="stab-empty-d">
            从左侧会话列表选一条，或按 <span className="kbd">⌘N</span> 新建。上面那排标签页是你在
            同时盯着的几条会话，关掉标签页不会删除会话本身。
          </div>
        </div>
      ) : collabOpen ? (
        /* 协作流：同一会话的另一种看法（步骤 / 派工 / 待人），占满整条主区域宽度。 */
        <CollabView conversationId={state.activeConversationId} />
      ) : (
        <>
          <div className={`chead${state.rightCollapsed ? ' bench-collapsed' : ''}`}>
            <div className="ctitle">{state.activeConversationTitle}</div>
            <div className="acts">
              <div className="ib" title="导出" onClick={exportConversation}>
                <DownloadSvg />
              </div>
              <div
                className="ib"
                title="会话操作"
                onClick={() => setMenuOpen((value) => !value)}
              >
                <DotsSvg />
              </div>
              {menuOpen ? (
                <div className="cmenu" onMouseLeave={() => setMenuOpen(false)}>
                  <div
                    className="cmenu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setModal({
                        kind: 'prompt',
                        title: '重命名会话',
                        label: '新的会话名称：',
                        placeholder: state.activeConversationTitle,
                        confirmLabel: '保存',
                        onSubmit: (value) => renameConversation(state.activeConversationId, value),
                      });
                    }}
                  >
                    重命名
                  </div>
                  <div
                    className="cmenu-item danger"
                    onClick={() => {
                      setMenuOpen(false);
                      setModal({
                        kind: 'confirm',
                        title: '删除会话',
                        body: `确定删除「${state.activeConversationTitle}」？将同时删除服务端会话与全部消息，不可恢复。`,
                        confirmLabel: '删除',
                        danger: true,
                        onConfirm: () => removeConversation(state.activeConversationId),
                      });
                    }}
                  >
                    删除会话
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          <ChatThread
            messages={messages}
            conversationId={state.activeConversationId}
            streamText={sender.streamText}
            onRecall={sender.recall}
            onEditSend={sender.editAndSend}
            onRetry={sender.retry}
          />

          <Composer
            value={sender.draft}
            onChange={sender.setDraft}
            onSend={(assetIds) => sender.send(assetIds)}
            assets={assets}
            picked={sender.picked}
            onPickedChange={sender.setPicked}
            attachments={sender.attachments}
            onAttachmentsChange={sender.setAttachments}
            onUpload={sender.uploadFiles}
            uploading={sender.uploading}
            model={state.conversationModels[state.activeConversationId] ?? ''}
            onModelChange={(model) => setConversationModel(state.activeConversationId, model)}
            onCommand={(id) => {
              if (id === 'new') newConversation();
              if (id === 'export') exportConversation();
            }}
            readOnly={state.readOnly}
            context={{
              usage: ctx.usage,
              loading: ctx.loading,
              compacting: ctx.compacting,
              onRefresh: ctx.refresh,
              onCompact: ctx.compact,
            }}
            meter={
              <>
                上下文 {state.ctxTokens}k / {ctx.usage ? `${Math.round(ctx.usage.budget / 1000)}k` : `${state.ctxBudget}k`} · 本会话 ¥{state.cost.toFixed(2)}
              </>
            }
          />

          {/* 会话右侧的三个悬浮按钮（上下文 / 执行 / 产物）：点开出气泡，问完即收。 */}
          <ChatHudDock />
        </>
      )}
    </div>
  );
}
