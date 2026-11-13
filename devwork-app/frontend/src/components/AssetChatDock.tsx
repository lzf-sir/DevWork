/**
 * 资产会话坞（Asset Chat Dock）—— 在资产详情页内直接显示 AI 会话区域。
 *
 * 为什么是「坞」而不是跳到会话页：
 * 用户在代码库里看到一段代码、在数据库里看到一张表、在终端里看到一行报错，
 * 问题的上下文就在眼前。此时跳走 = 上下文丢失，回来还要重新 @ 一次资产。
 * 所以会话区是**页面内的一列**，与详情页并排：页面本体还在，会话随时能问。
 *
 * 形态要求（用户明确提的）：**折叠 / 展开，不是弹出式抽屉**。
 *  - 展开：占布局一列（默认 460px，可拖拽调宽），页面内容相应让位；
 *  - 折叠：收成一条 40px 窄边条，宽度全还给内容，点一下原样回来；
 *  - 关闭（×）：会话仍保留在会话列表里，只是这页不再显示它。
 *
 * 三条硬约束：
 *  ① 每次点入口都是**一条新会话**（会话列表里看得见、能回访）；
 *  ② 会话**默认绑定当前资产**（绑定写在服务端，每轮消息都带上它）；
 *  ③ 快捷操作是**真提问**（点一下就发一轮，不是占位按钮）。
 */
import React, { useEffect, useMemo } from 'react';
import { useStore } from '../store';
import ChatThread from './ChatThread';
import Composer from './Composer';
import { Resizer, usePanelWidth } from './Resizer';
import { ArrowIcon, AssetIcon, CloseIcon, PanelIcon, PlusIcon } from './icons';
import { useAssetCandidates, useConversationSender } from '../hooks/useChatSession';
import { ASSET_TYPE_LABEL, assetQuickActions } from '../utils/assetActions';

export default function AssetChatDock(): React.ReactElement | null {
  const {
    state,
    closeAssetChat,
    openAssetChat,
    setConversation,
    setConversationModel,
    addToast,
    toggleAssetChatCollapsed,
  } = useStore();
  const chat = state.assetChat;
  const collapsed = state.assetChatCollapsed;

  const assets = useAssetCandidates(state.workspaceId);
  const sender = useConversationSender(chat?.conversationId ?? '', {
    boundAssetIds: chat ? [chat.assetId] : [],
    assets,
  });
  /* 列宽可拖拽：宽度是布局偏好，落 localStorage 跨重启保留。 */
  const panel = usePanelWidth({ storageKey: 'devwork-asset-chat-w', initial: 460, min: 340, max: 720 });

  /* 换会话（= 又点了一次入口）时清掉上一条会话的草稿与引用，
   * 否则会出现「上一条会话没发出去的文字被发到新会话里」。 */
  useEffect(() => {
    sender.setDraft('');
    sender.setAttachments([]);
    sender.setPicked([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.conversationId]);

  /* 绑定资产始终以 chip 形式挂在输入框上：用户看得见「这轮问的是谁」。
   * 发送后 Composer 会清空 chip，这里把它补回来 —— 绑定是会话属性，
   * 不该因为发了一轮就消失。 */
  useEffect(() => {
    if (!chat) return;
    const bound = assets.find((asset) => asset.id === chat.assetId);
    if (!bound) return;
    sender.setPicked((prev) => (prev.some((item) => item.id === bound.id) ? prev : [bound, ...prev]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat?.conversationId, chat?.assetId, assets, sender.picked]);

  /* 会话坞是资产详情页的一部分：离开详情页（去会话页 / 项目 / 设置）就自动收起，
   * 否则它会占着一个与它无关的页面的位置。 */
  useEffect(() => {
    if (!chat) return;
    if (!state.view.startsWith('detail-')) closeAssetChat();
  }, [state.view, chat, closeAssetChat]);

  const messages = state.threads[chat?.conversationId ?? ''] ?? [];
  const actions = useMemo(
    () => (chat ? assetQuickActions(chat.assetType, chat.assetName) : []),
    [chat?.assetType, chat?.assetName],
  );

  if (!chat) return null;

  const typeLabel = ASSET_TYPE_LABEL[chat.assetType] ?? '资产';
  const dockStyle = { '--dock-w': `${panel.width}px` } as React.CSSProperties;

  /** 快捷操作：直接以绑定资产发起一轮提问。 */
  const runQuick = (prompt: string, label: string): void => {
    if (!chat.conversationId) return;
    sender.send(undefined, prompt);
    addToast(`已发送快捷操作「${label}」`);
  };

  /* 折叠态：只留一条窄边条 —— 会话还在，宽度还给内容。 */
  if (collapsed) {
    return (
      <aside className="adock collapsed" data-view="asset-chat" data-collapsed="1">
        <div className="adock-fold">
          <button
            className="ib"
            type="button"
            title="展开会话区"
            aria-label="展开会话区"
            onClick={toggleAssetChatCollapsed}
          >
            <ArrowIcon dir="left" size={14} strokeWidth={1.4} />
          </button>
          <span className="adock-fold-ic" title={`绑定 ${chat.assetName} · ${typeLabel}`}>
            <AssetIcon type={chat.assetType} size={13} strokeWidth={1.3} />
          </span>
          <span className="adock-foldlbl" title={chat.title}>
            {chat.title}
          </span>
        </div>
      </aside>
    );
  }

  return (
    <aside className="adock" data-view="asset-chat" data-collapsed="0" style={dockStyle}>
      {/* 左边界拖拽手柄：左移变宽，和右栏手柄同一套逻辑。 */}
      <Resizer edge="left" dragging={panel.dragging} onBegin={panel.beginDrag} onReset={panel.reset} />

      <div className="adock-hd">
        <button
          className="ib"
          type="button"
          title="折叠会话区（宽度还给页面）"
          aria-label="折叠会话区"
          onClick={toggleAssetChatCollapsed}
        >
          <ArrowIcon dir="right" size={14} strokeWidth={1.4} />
        </button>
        <span className="adock-ic">
          <AssetIcon type={chat.assetType} size={14} strokeWidth={1.3} />
        </span>
        <div className="adock-t">
          <div className="adock-title" title={chat.title}>
            {chat.title}
          </div>
          <div className="adock-sub">
            已绑定 {chat.assetName} · {typeLabel} · 只读优先
          </div>
        </div>
        <button
          className="ib"
          type="button"
          title="再开一条绑定该资产的会话"
          aria-label="新建资产会话"
          onClick={() => openAssetChat({ assetId: chat.assetId, assetName: chat.assetName, assetType: chat.assetType })}
        >
          <PlusIcon size={14} strokeWidth={1.5} />
        </button>
        <button
          className="ib"
          type="button"
          title="在会话页打开这条会话"
          aria-label="在会话页打开"
          onClick={() => {
            setConversation(chat.conversationId, chat.title);
            closeAssetChat();
          }}
        >
          <PanelIcon size={14} strokeWidth={1.3} />
        </button>
        <button
          className="ib"
          type="button"
          title="关闭会话区（会话仍保留在会话列表里）"
          aria-label="关闭会话区"
          onClick={closeAssetChat}
        >
          <CloseIcon size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div className="adock-quick">
        <span className="adock-qt">快捷操作</span>
        {actions.map((action) => (
          <button
            className="qbtn"
            key={action.id}
            type="button"
            title={action.prompt}
            onClick={() => runQuick(action.prompt, action.label)}
          >
            {action.label}
          </button>
        ))}
      </div>

      <ChatThread
        messages={messages}
        conversationId={chat.conversationId}
        streamText={sender.streamText}
        compact
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
        model={state.conversationModels[chat.conversationId] ?? ''}
        onModelChange={(model) => setConversationModel(chat.conversationId, model)}
        onCommand={(id) => {
          if (id === 'new') {
            openAssetChat({ assetId: chat.assetId, assetName: chat.assetName, assetType: chat.assetType });
          }
        }}
        readOnly={state.readOnly}
        meter={
          <>
            绑定资产 {chat.assetName} · 本会话 ¥{state.cost.toFixed(2)}
          </>
        }
      />
    </aside>
  );
}
