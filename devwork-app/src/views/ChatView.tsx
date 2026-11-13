import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';

import { DownloadSvg, DotsSvg, downloadFile } from '../components/ui';
import ChatThread from '../components/ChatThread';
import Composer from '../components/Composer';
import ChatHudDock from '../components/ChatHudDock';
import { useAssetCandidates, useConversationSender } from '../hooks/useChatSession';

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
  } = useStore();
  /** B21：会话操作下拉菜单（重命名 / 删除）。 */
  const [menuOpen, setMenuOpen] = useState<boolean>(false);

  const assets = useAssetCandidates(state.workspaceId);
  const sender = useConversationSender(state.activeConversationId, { assets });

  const messages = state.threads[state.activeConversationId] ?? [];

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
        meter={
          <>
            上下文 {state.ctxTokens}k / 200k · 本会话 ¥{state.cost.toFixed(2)}
          </>
        }
      />

      {/* 会话右侧的三个悬浮按钮（上下文 / 执行 / 产物）：点开出气泡，问完即收。 */}
      <ChatHudDock />
    </div>
  );
}
