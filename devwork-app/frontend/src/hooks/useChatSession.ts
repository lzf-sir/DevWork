/**
 * 会话通用 Hook —— 会话页与资产会话坞共用。
 *
 * 抽出来的原因不是"少写几行"，而是两条链路的语义必须一致：
 *  ① 资产候选（@ 引用）要来自同一份真实资产表 —— 两处各拉一次，
 *     就会出现「会话页能引用生产库、资产坞引用不到」；
 *  ② 发送链路（SSE 流式 / 附件 / 用量回写 / 中断）只有一条实现 ——
 *     资产坞如果自己写一份，"停止生成"就会中断不了它。
 *
 * 多 tab 之后新增一条：**所有「正在输入中」的状态都按会话分桶**。
 * 草稿 / @ 选中的资产 / 待发附件放在模块级缓存（不进全局 store，
 * 否则每敲一个字都要让整个应用重渲染一遍）；
 * 流式文本放 store（tab 栏要能看见「哪个会话在生成」，跨组件可见）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { api, apiMode, type Message } from '../api/client';
import { cardsToThread } from '../api/adapters';
import { useLiveData, useLiveRefresh } from '../api/live';
import { assetTypeIcon, assetTypeLabel, type AssetCandidate } from '../components/Composer';
import { resolveAssetIds } from '../utils/composer';

/** 附件条目：id 是服务端产物 id，name 是原始文件名。 */
type Attachment = { id: string; name: string };

/**
 * 未发送的输入态缓存：conversationId → 内容。
 *
 * 为什么放模块级而不是 useRef / useState：
 *   · useState 活不过 tab 切换（组件不重挂载，但参数变了要换一份）；
 *   · useRef 同理，一份 ref 装不下多个会话；
 *   · 放 store 会让每个按键都触发全局 context 更新，Markdown 长列表跟着重渲染。
 * 模块级 Map 是这里唯一「按会话独立、又不惊动 React 树」的位置。
 */
interface DraftState {
  text: string;
  picked: AssetCandidate[];
  attachments: Attachment[];
}

const draftCache = new Map<string, DraftState>();

function readDraft(conversationId: string): DraftState {
  return draftCache.get(conversationId) ?? { text: '', picked: [], attachments: [] };
}

function writeDraft(conversationId: string, patch: Partial<DraftState>): DraftState {
  const next = { ...readDraft(conversationId), ...patch };
  if (conversationId) draftCache.set(conversationId, next);
  return next;
}

/** 会话被删除时清掉它的草稿，避免同名新会话继承旧字。 */
export function clearDraftCache(conversationId: string): void {
  draftCache.delete(conversationId);
}

/**
 * 可被 @ 引用的资产：live 用真实资产表，内置表只在断后端时兜底。
 * 两张表**不能混用** —— 离线兜底里的旧资产在库里并不存在，
 * 混进来用户就能引用一个查不到的资产。
 */
export function useAssetCandidates(workspaceId: string): AssetCandidate[] {
  const { ASSET_PICKER } = useLiveData();
  const [liveAssets, setLiveAssets] = useState<AssetCandidate[]>([]);

  useEffect(() => {
    let alive = true;
    void api
      .listAssets(workspaceId)
      .then((envelope) => {
        if (!alive || !envelope.ok || !Array.isArray(envelope.data)) return;
        setLiveAssets(
          envelope.data.map((asset) => ({
            id: asset.id,
            label: asset.name,
            type: asset.type,
            icon: assetTypeIcon(asset.type),
            tag: asset.env || undefined,
            hint: [
              assetTypeLabel(asset.type),
              asset.env,
              asset.credentialBound ? null : '未绑定凭据',
            ]
              .filter(Boolean)
              .join(' · '),
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  return useMemo<AssetCandidate[]>(() => {
    if (liveAssets.length > 0) return liveAssets;
    return ASSET_PICKER.map((asset) => ({
      id: asset.id,
      label: asset.label,
      icon: asset.icon,
      type: asset.go ?? '',
      hint: '离线兜底资产',
    }));
  }, [liveAssets, ASSET_PICKER]);
}

export interface ConversationSender {
  draft: string;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  picked: AssetCandidate[];
  setPicked: React.Dispatch<React.SetStateAction<AssetCandidate[]>>;
  attachments: { id: string; name: string }[];
  setAttachments: React.Dispatch<React.SetStateAction<{ id: string; name: string }[]>>;
  uploading: boolean;
  uploadFiles: (files: FileList | null) => void;
  /** SSE 流式增量文本（null = 非流式中）。 */
  streamText: string | null;
  /**
   * 发送：可选地带上本轮真实解析出的资产 id；
   * 快捷操作会直接带上自己的提问文本（不等输入框状态回流）。
   */
  send: (assetIds?: string[], text?: string) => void;
  /** 撤回用户消息：该消息及其后的全部内容回退到发送前状态（时间线截断）。 */
  recall: (messageId: string) => void;
  /** 编辑后重发：清掉原消息及回复，用编辑后的文本直接走发送链路（无需回到输入框）。 */
  editAndSend: (messageId: string, text: string) => void;
  /** 重试：保留用户气泡，清掉其后内容并流式重新生成。 */
  retry: (userMessageId: string) => void;
}

export interface SenderOptions {
  /** 资产绑定会话的绑定资产 —— 每一轮都随消息下发，
   *  即便用户没有手动 @ 它（服务端也会按会话绑定再兜一次）。 */
  boundAssetIds?: string[];
  /** @ 引用的候选资产表（与 Composer 共用同一份）。 */
  assets?: AssetCandidate[];
}

/** 会话发送器：流式发送 / 附件上传 / 用量回写 / 中断。 */
export function useConversationSender(
  conversationId: string,
  options: SenderOptions = {},
): ConversationSender {
  const { boundAssetIds = [], assets = [] } = options;
  const { state, sendMessage, appendAssistantCards, truncateThread, applyUsage, registerAbort, addToast, setStream } = useStore();
  const refresh = useLiveRefresh();

  /* 草稿 / @ 选中 / 待发附件：以 conversationId 为键，从模块级缓存取。
   * conversationId 一变就从缓存回灌 —— 这就是「切 tab 字还在」的全部实现。 */
  const [draftState, setDraftState] = useState<DraftState>(() => readDraft(conversationId));
  useEffect(() => {
    setDraftState(readDraft(conversationId));
  }, [conversationId]);

  const draft = draftState.text;
  const picked = draftState.picked;
  const attachments = draftState.attachments;

  const setDraft = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (value) => {
      setDraftState((prev) => {
        const text = typeof value === 'function' ? value(prev.text) : value;
        return writeDraft(conversationId, { text });
      });
    },
    [conversationId],
  );

  const setPicked = useCallback<React.Dispatch<React.SetStateAction<AssetCandidate[]>>>(
    (value) => {
      setDraftState((prev) => {
        const next = typeof value === 'function' ? value(prev.picked) : value;
        return writeDraft(conversationId, { picked: next });
      });
    },
    [conversationId],
  );

  const setAttachments = useCallback<React.Dispatch<React.SetStateAction<Attachment[]>>>(
    (value) => {
      setDraftState((prev) => {
        const next = typeof value === 'function' ? value(prev.attachments) : value;
        return writeDraft(conversationId, { attachments: next });
      });
    },
    [conversationId],
  );

  const [uploading, setUploading] = useState<boolean>(false);
  /** 流式文本读 store 里按会话存的那一份：切换 tab 不丢，tab 栏也能据此点亮状态点。 */
  const streamText = state.streams[conversationId] ?? null;
  /** 流式增量的同步镜像（按会话）：手动中断时用它把已收到的文本落进本地会话。 */
  const streamTextCache = useRef<Record<string, string>>({});

  const boundKey = boundAssetIds.join(',');

  /** @ 引用解析：点选 chip + 正文里的 @名称；绑定资产永远排最前。 */
  const resolveSendAssetIds = useCallback(
    (content: string, explicit?: string[]): string[] => {
      const pickedIds = explicit ?? resolveAssetIds(content, assets, picked);
      const bound = boundKey ? boundKey.split(',').filter(Boolean) : [];
      return [...new Set([...bound, ...pickedIds])];
    },
    [assets, picked, boundKey],
  );

  /**
   * 一轮生成的网络执行体 —— 发送 / 编辑重发 / 重试 共用同一条链路（SSE 流式 + 一次性兜底）。
   * regenerate=true 时服务端沿用已有用户气泡（不重复插入），回填只追加助手卡片。
   */
  const runTurn = useCallback(
    (content: string, assetIds: string[], attachmentNames: string[], options: { regenerate?: boolean } = {}): void => {
      const regenerate = options.regenerate === true;
      /* 会话级模型覆盖：只在用户显式选过模型时带上，空串表示跟随全局默认。 */
      const model = state.conversationModels[conversationId] ?? '';
      const input = {
        content,
        assetIds,
        attachments: attachmentNames,
        ...(model ? { model } : {}),
        ...(regenerate ? { regenerate: true } : {}),
      };
      /** 落地一轮结果：普通发送带用户气泡；重试只回填助手卡（气泡还留着）。 */
      const appendTurn = (cards: Message[] | undefined, fallbackText?: string): void => {
        if (regenerate) {
          const reply = cards && cards.length > 0
            ? cards
            : fallbackText
              ? [{ id: `m-t-${Date.now()}`, kind: 'text' as const, text: fallbackText }]
              : [];
          appendAssistantCards(conversationId, reply);
        } else {
          sendMessage(content, cards, conversationId);
        }
      };

      if (apiMode === 'live') {
        setStream(conversationId, '');
        streamTextCache.current[conversationId] = '';
        /* 注册 AbortController（按会话）—— 「停止生成」/ Esc 据此真中断这一条流。 */
        const controller = new AbortController();
        registerAbort(controller, conversationId);
        void api
          .streamMessage(conversationId, input, (delta) => {
            const buffer = (streamTextCache.current[conversationId] ?? '') + delta;
            streamTextCache.current[conversationId] = buffer;
            setStream(conversationId, buffer);
          }, controller.signal)
          .then((envelope) => {
            setStream(conversationId, null);
            registerAbort(null, conversationId);
            if (!envelope.ok && envelope.error?.code === 'E_ABORTED') {
              /* 手动中断：保留已收到的增量文本，不再降级重发完整请求。 */
              const partial = streamTextCache.current[conversationId] ?? '';
              if (partial.trim()) appendTurn(undefined, partial);
              addToast('已停止生成');
              void api.getUsage(conversationId).then((usage) => {
                if (usage.ok) applyUsage(usage.data);
              });
              return;
            }
            const cards = envelope.ok ? cardsToThread(envelope.data.messages ?? []) : [];
            appendTurn(cards.length > 0 ? cards : undefined);
            if (!envelope.ok && envelope.error) addToast(`下发失败：${envelope.error.message}`);
            refresh();
            /* 顶栏用量真值（服务端按消息估算，不再 +1k/+0.03 模拟）。 */
            void api.getUsage(conversationId).then((usage) => {
              if (usage.ok) applyUsage(usage.data);
            });
          })
          .catch(() => {
            setStream(conversationId, null);
            registerAbort(null, conversationId);
            appendTurn(undefined, '网络异常，本轮回复未生成');
          });
        return;
      }
      /* 离线：一次性接口；mockFallthrough 返回同样的完整结构化轨迹。 */
      void api
        .sendMessage(conversationId, input)
        .then((envelope) => {
          const cards = envelope.ok ? cardsToThread(envelope.data.messages ?? []) : [];
          appendTurn(cards.length > 0 ? cards : undefined);
          if (!envelope.ok && envelope.error) addToast(`下发失败：${envelope.error.message}`);
          void api.getUsage(conversationId).then((usage) => {
            if (usage.ok) applyUsage(usage.data);
          });
        })
        .catch(() => appendTurn(undefined, '网络异常，本轮回复未生成'));
    },
    [conversationId, state.conversationModels, sendMessage, appendAssistantCards, applyUsage, registerAbort, addToast, refresh, setStream],
  );

  const send = useCallback(
    (resolvedAssetIds?: string[], text?: string): void => {
      const content = (text ?? draft).trim();
      if (!content) {
        addToast('请输入你的问题后再发送');
        return;
      }
      const assetIds = resolveSendAssetIds(content, resolvedAssetIds);
      const attachmentNames = attachments.map((item) => item.name);
      setDraft('');
      setPicked([]);
      setAttachments([]);
      runTurn(content, assetIds, attachmentNames);
    },
    [draft, attachments, resolveSendAssetIds, runTurn, addToast],
  );

  /** 撤回：本地先截（即时反馈），服务端落库截断兜底；用量随服务端重算回写。 */
  const recall = useCallback(
    (messageId: string): void => {
      if (streamText !== null) {
        addToast('正在生成中，请先停止生成再撤回');
        return;
      }
      truncateThread(conversationId, messageId, 'inclusive');
      void api.truncateMessages(conversationId, { messageId, mode: 'inclusive' }).then((envelope) => {
        if (!envelope.ok) {
          addToast(`服务端回退失败：${envelope.error?.message ?? '网络异常'}`);
          return;
        }
        const extra = [
          envelope.data.artifacts ? `产物 ${envelope.data.artifacts} 个` : '',
          envelope.data.files ? `文件 ${envelope.data.files} 个` : '',
          envelope.data.citations ? `引用 ${envelope.data.citations} 条` : '',
          envelope.data.toolCalls ? `工具调用 ${envelope.data.toolCalls} 条` : '',
        ].filter(Boolean).join('、');
        addToast(`已撤回 · 会话已回到这条消息之前（清掉 ${envelope.data.deleted} 条${extra ? `，并清理${extra}` : ''}）`);
        void api.getUsage(conversationId).then((usage) => {
          if (usage.ok) applyUsage(usage.data);
        });
      });
    },
    [conversationId, streamText, truncateThread, applyUsage, addToast],
  );

  /** 编辑重发：清场后走正常发送链路 —— 编辑框就是发送入口，不用回到输入框。 */
  const editAndSend = useCallback(
    (messageId: string, text: string): void => {
      const content = text.trim();
      if (!content) {
        addToast('编辑后的内容不能为空');
        return;
      }
      if (streamText !== null) {
        addToast('正在生成中，请先停止生成再编辑');
        return;
      }
      truncateThread(conversationId, messageId, 'inclusive');
      void api.truncateMessages(conversationId, { messageId, mode: 'inclusive' });
      runTurn(content, resolveSendAssetIds(content), []);
    },
    [conversationId, streamText, truncateThread, resolveSendAssetIds, runTurn, addToast],
  );

  /**
   * 重试：保留用户气泡，清掉其后内容并重新生成。
   * 服务端截断后回传气泡原始载荷（assetIds / attachments 不丢）；离线时按本地文本兜底。
   */
  const retry = useCallback(
    (userMessageId: string): void => {
      if (streamText !== null) {
        addToast('正在生成中，请先停止生成再重试');
        return;
      }
      const thread = state.threads[conversationId] ?? [];
      const index = thread.findIndex((message) => message.id === userMessageId);
      if (index < 0 || thread[index].kind !== 'user') {
        addToast('找不到对应的用户消息，无法重试');
        return;
      }
      const localText = thread[index].text;
      truncateThread(conversationId, userMessageId, 'after');
      void api.truncateMessages(conversationId, { messageId: userMessageId, mode: 'after' }).then((envelope) => {
        const bubble = envelope.ok ? envelope.data.bubble : undefined;
        if (!envelope.ok && envelope.error?.code !== 'E_NOT_FOUND') {
          addToast('服务端未记录该消息，已按本地内容重试');
        }
        runTurn(
          bubble?.content || localText,
          bubble?.assetIds?.length ? bubble.assetIds : [],
          bubble?.attachments ?? [],
          { regenerate: true },
        );
      });
    },
    [conversationId, streamText, state.threads, truncateThread, runTurn, addToast],
  );

  /** C3：附件真上传 —— 文件读成 base64 POST 给服务端，落盘产物目录并登记 artifact。 */
  const uploadFiles = useCallback(
    (files: FileList | null): void => {
      if (!files || files.length === 0) return;
      setUploading(true);
      Array.from(files).forEach((file) => {
        if (file.size > 10 * 1024 * 1024) {
          addToast(`附件 ${file.name} 超过 10MB 上限，已跳过`);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = String(reader.result ?? '').split(',')[1] ?? '';
          void api.uploadAttachment(conversationId, { name: file.name, contentBase64: base64 }).then((envelope) => {
            if (!envelope.ok) {
              addToast(`附件上传失败：${envelope.error?.message ?? '未知错误'}`);
              return;
            }
            setAttachments((prev) =>
              prev.some((item) => item.name === file.name)
                ? prev
                : [...prev, { id: envelope.data.id, name: file.name }],
            );
            addToast(`附件 ${file.name} 已上传（${Math.max(1, Math.round(envelope.data.sizeBytes / 1024))}KB）· 发送时随消息提交`);
            refresh();
          });
        };
        reader.onerror = () => addToast(`附件 ${file.name} 读取失败`);
        reader.readAsDataURL(file);
      });
      setUploading(false);
    },
    [conversationId, addToast, refresh],
  );

  return {
    draft,
    setDraft,
    picked,
    setPicked,
    attachments,
    setAttachments,
    uploading,
    uploadFiles,
    streamText,
    send,
    recall,
    editAndSend,
    retry,
  };
}
