/**
 * ChatThread —— 会话消息流（五类卡片 + 引用浮层）。
 *
 * 从 ChatView 抽出，供两处复用：
 *  1. 会话页（ChatView）—— 全屏对话；
 *  2. 资产详情页内嵌的 AI 会话坞（AssetChatDock）—— 在当前页面右侧显示会话区域。
 *
 * 抽出来不是为了少写几行，而是为了**同一套渲染**：两处如果各写一份卡片渲染，
 * 迟早会出现「会话页有引用浮层、会话坞没有」这类割裂。
 *
 * 引用浮层依赖全局 state.citation（Esc 关闭、点外部关闭都在 App 层统一处理），
 * 所以这里只负责画浮层与取数。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { api, type InlineSeg, type Message, type ViewName } from '../api/client';
import { useLiveData } from '../api/live';
import { ChartSvg, TriangleSvg, copyToClipboard } from './ui';
import { CaretIcon, CloseIcon } from './icons';
import Markdown, { renderInline } from './Markdown';

export interface ChatThreadProps {
  /** 当前会话的消息列表。 */
  messages: Message[];
  /** 会话 id：审批 / 建议卡的裁决都落到这个会话上。 */
  conversationId: string;
  /** SSE 流式增量文本（null = 非流式中）。 */
  streamText?: string | null;
  /** 紧凑模式：资产会话坞里宽度窄，隐藏过重的留白。 */
  compact?: boolean;
  /** 撤回用户消息：该消息及其后内容整体回退（缺省不渲染撤回按钮）。 */
  onRecall?: (messageId: string) => void;
  /** 编辑后重发：内联编辑框直接发送，不经过底部输入框。 */
  onEditSend?: (messageId: string, text: string) => void;
  /** 重试该轮回复（传入该轮用户消息 id，保留气泡重新生成）。 */
  onRetry?: (userMessageId: string) => void;
}

/** 卡片 → 可复制的纯文本（复制 / 重试操作条用）。 */
function plainTextOf(message: Message): string {
  if (message.kind === 'user' || message.kind === 'text') return message.text;
  if (message.kind === 'conclusion') {
    return message.paras
      .map((line) => line.map((seg) => (seg.t === 'cite' ? `[${seg.id}]` : seg.v)).join(''))
      .join('\n');
  }
  return '';
}

/** token 展示：≥1k 用 k 计，别让 4 位数占满操作条。 */
function formatTokens(n: number): string {
  if (n >= 100000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 轮末卡片上的 usage → 操作条右侧的用量文案。 */
function usageTextOf(usage: Message['usage']): string {
  if (!usage) return '';
  const parts: string[] = [];
  const total = usage.totalTokens ?? usage.completionTokens;
  if (typeof total === 'number') {
    /* promptTokens 只有模型真回传才有；估算模式下如实标注"输出"，不冒充全量。 */
    parts.push(usage.promptTokens != null ? `tokens ${formatTokens(total)}` : `输出 tokens ${formatTokens(total)}`);
  }
  if (typeof usage.costCny === 'number') parts.push(`¥${usage.costCny.toFixed(2)}`);
  if (usage.model) parts.push(usage.model);
  return parts.join(' · ');
}

export default function ChatThread(props: ChatThreadProps): React.ReactElement {
  const {
    messages,
    conversationId,
    streamText = null,
    compact = false,
    onRecall,
    onEditSend,
    onRetry,
  } = props;
  const {
    state,
    navigate,
    addToast,
    setModal,
    setTermPreset,
    setCitation,
    openBench,
    setArtifactPicker,
    openArtifact,
    openSource,
  } = useStore();
  const { CHAT_CHIP_LINKS, CITATIONS } = useLiveData();
  /** 引用浮层的实时详情：优先 /api/citations/:id，失败时回落 REST 装配的引用表。 */
  const [citationLive, setCitationLive] = useState<Record<number, {
    title: string; source: string; locator: string; code: string; score: string;
    path: string | null; startLine: number | null;
  }>>({});
  const [openTools, setOpenTools] = useState<Record<string, boolean>>({});
  /* 产物展开态按消息 id 记：一个会话里可能有多张产物卡，用全局布尔会"点一张全展开"。 */
  const [openArtifacts, setOpenArtifacts] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState<boolean>(false);
  /* 内联编辑：用户消息就地改写直接发送，不经过底部输入框。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState<string>('');

  /**
   * 轮次结构：用户气泡 → 该轮末条下标。
   * 撤回/编辑挂在每条用户消息下（没回复也要能撤回）；
   * 复制/重试与用量条只挂在**有回复的**轮末。
   */
  const turns = useMemo(() => {
    const list: { userIndex: number; endIndex: number }[] = [];
    messages.forEach((message, index) => {
      if (message.kind === 'user') {
        if (list.length > 0) list[list.length - 1].endIndex = index - 1;
        list.push({ userIndex: index, endIndex: messages.length - 1 });
      }
    });
    return list;
  }, [messages]);
  const turnByUserIndex = useMemo(
    () => new Map(turns.map((turn) => [turn.userIndex, turn])),
    [turns],
  );
  const turnByEndIndex = useMemo(
    () => new Map(turns.filter((turn) => turn.endIndex > turn.userIndex).map((turn) => [turn.endIndex, turn])),
    [turns],
  );

  const threadRef = useRef<HTMLDivElement>(null);
  const tinRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, conversationId, streamText]);

  useEffect(() => {
    if (state.approvalSeq === 0) return;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 1400);
    const card = document.getElementById('appr-card');
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return () => window.clearTimeout(timer);
  }, [state.approvalSeq]);

  useEffect(() => {
    if (!state.citation) return;
    const handler = (event: MouseEvent): void => {
      const target = event.target as HTMLElement;
      if (target.closest('.cite-pop') || target.closest('.cite')) return;
      setCitation(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [state.citation, setCitation]);

  const openCitation = (id: number, event: React.MouseEvent<HTMLSpanElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    const tin = tinRef.current?.getBoundingClientRect();
    const top = rect.bottom - (tin?.top ?? 0) + 8;
    const left = Math.max(0, Math.min(rect.left - (tin?.left ?? 0), (tin?.width ?? 780) - 408));
    setCitation({ id, top, left });
    /* 引用详情走 REST；离线时 api 层自动回落，浮层仍可用 CITATIONS 展示。 */
    void api.getCitation(`cit-${id}`).then((envelope) => {
      if (!envelope.ok) return;
      const detail = envelope.data;
      setCitationLive((prev) => ({
        ...prev,
        [id]: {
          title: detail.title,
          source: detail.source,
          locator: detail.locator,
          code: detail.code || detail.snippet,
          score: detail.score,
          path: detail.path ?? null,
          startLine: detail.startLine ?? null,
        },
      }));
    });
  };

  const renderSegments = (segments: InlineSeg[], keyPrefix = 'seg'): React.ReactNode =>
    segments.map((seg, index) => {
      if (seg.t === 'cite') {
        return (
          <span className="cite" key={`${keyPrefix}-cite-${index}`} onClick={(event) => openCitation(seg.id, event)}>
            [{seg.id}]
          </span>
        );
      }
      if (seg.t === 'strong') {
        return <strong key={`${keyPrefix}-strong-${index}`}>{seg.v}</strong>;
      }
      /* 文本段再过一遍行内 Markdown：模型回复里的 `code` 与 **加粗** 不能当字面量显示。 */
      return (
        <React.Fragment key={`${keyPrefix}-text-${index}`}>
          {renderInline(seg.v, `${keyPrefix}-t${index}`)}
        </React.Fragment>
      );
    });

  /* ---------------- 消息操作：撤回 / 编辑重发 / 重试 ---------------- */

  /** 编辑后重发：就地把消息改写重发（不经过底部输入框）；带走后续内容时先确认。 */
  const submitEdit = (message: Message, turn: { userIndex: number; endIndex: number }): void => {
    const doSend = (): void => {
      setEditingId(null);
      onEditSend?.(message.id, editText);
    };
    const isLastTurn = turn.endIndex >= messages.length - 1;
    if (isLastTurn) {
      doSend();
      return;
    }
    setModal({
      kind: 'confirm',
      title: '编辑后重新发送',
      body: `编辑重发会删除这条消息及其后的 ${messages.length - turn.userIndex} 条内容（含本次回复及后续对话），以编辑后的文本重新发送，不可恢复。`,
      confirmLabel: '重新发送',
      danger: true,
      onConfirm: doSend,
    });
  };

  /** 撤回：该消息及其后全部内容回退到发送前状态。删除面大，一律确认。 */
  const doRecall = (message: Message, turn: { userIndex: number; endIndex: number }): void => {
    setModal({
      kind: 'confirm',
      title: '撤回消息',
      body: `撤回后将删除这条消息及其后的 ${messages.length - turn.userIndex} 条内容（含本次回复及其产物），不可恢复。`,
      confirmLabel: '撤回',
      danger: true,
      onConfirm: () => onRecall?.(message.id),
    });
  };

  /** 重试：保留用户气泡，其后内容清掉重新生成；若该轮之后还有对话，先确认。 */
  const doRetry = (turn: { userIndex: number; endIndex: number }): void => {
    const run = (): void => onRetry?.(messages[turn.userIndex].id);
    const isLastTurn = turn.endIndex >= messages.length - 1;
    if (isLastTurn) {
      run();
      return;
    }
    setModal({
      kind: 'confirm',
      title: '重新生成回复',
      body: `重试将删除这条消息之后的 ${messages.length - turn.userIndex - 1} 条内容（含后续对话）并重新生成，不可恢复。`,
      confirmLabel: '重新生成',
      danger: true,
      onConfirm: run,
    });
  };

  /** 用户消息下方的操作条（编辑中就地换成编辑框）。 */
  const renderUserActions = (message: Message, turn: { userIndex: number; endIndex: number }): React.ReactNode => {
    if (editingId === message.id && message.kind === 'user') {
      return (
        <div className="edit-box">
          <textarea
            value={editText}
            autoFocus
            onChange={(event) => setEditText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditingId(null);
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitEdit(message, turn);
            }}
            rows={Math.min(10, Math.max(2, editText.split('\n').length + 1))}
          />
          <div className="edit-acts">
            <span className="hint">Esc 取消 · ⌘↵ 发送</span>
            <button className="btn" onClick={() => setEditingId(null)}>取消</button>
            <button className="btn p" onClick={() => submitEdit(message, turn)}>发送</button>
          </div>
        </div>
      );
    }
    return (
      <div className="msg-acts">
        <button
          className="btn"
          onClick={() => {
            copyToClipboard(message.kind === 'user' ? message.text : plainTextOf(message));
            addToast('消息已复制');
          }}
        >
          复制
        </button>
        {onEditSend && message.kind === 'user' ? (
          <button
            className="btn"
            onClick={() => {
              setEditingId(message.id);
              setEditText(message.text);
            }}
          >
            编辑
          </button>
        ) : null}
        {onRecall ? (
          <button className="btn" onClick={() => doRecall(message, turn)}>
            撤回
          </button>
        ) : null}
      </div>
    );
  };

  /** 回复轮末的操作条：复制 / 重试 + 该轮 token 用量。 */
  const renderReplyBar = (turn: { userIndex: number; endIndex: number }): React.ReactNode => {
    const copyText = messages
      .slice(turn.userIndex + 1, turn.endIndex + 1)
      .map(plainTextOf)
      .filter(Boolean)
      .join('\n\n');
    const usage = usageTextOf(messages[turn.endIndex].usage);
    return (
      <div className="reply-acts">
        <button
          className="btn"
          onClick={() => {
            copyToClipboard(copyText);
            addToast('回复已复制');
          }}
        >
          复制
        </button>
        {onRetry ? (
          <button className="btn" onClick={() => doRetry(turn)}>
            重试
          </button>
        ) : null}
        {usage ? <span className="usage">{usage}</span> : null}
      </div>
    );
  };

  const renderMessage = (message: Message): React.ReactNode => {
    switch (message.kind) {
      case 'user':
        /* 编辑中：气泡原位换成编辑框（在操作条渲染），这里不再画气泡。 */
        if (editingId === message.id) return null;
        return (
          <div className="bub" key={message.id}>
            {message.text}
            {message.chips.length > 0 ? (
              <span className="at">
                {message.chips.map((chip) => (
                  <span
                    className="atchip"
                    key={chip}
                    onClick={() => {
                      const go = CHAT_CHIP_LINKS[chip];
                      if (go) navigate(`detail-${go}` as ViewName);
                      else addToast(`@ ${chip}：检索型资产，已在右栏上下文挂载`);
                    }}
                  >
                    @ {chip}
                  </span>
                ))}
              </span>
            ) : null}
          </div>
        );
      case 'text':
        return (
          <div className="msg" key={message.id}>
            <p>{message.text}</p>
          </div>
        );
      case 'plan': {
        const totalMs = message.steps.reduce((sum, step) => sum + step.durationMs, 0);
        return (
          <div className="plan" key={message.id}>
            <div className="ph">
              <span className="pt">{message.steps.length} 步计划</span>
              <span className="pi">
                {message.intent} · 预计 {(totalMs / 1000).toFixed(1)}s
                {message.degraded ? ' · 演示轨迹' : ''}
              </span>
            </div>
            <ol>
              {message.steps.map((step, index) => (
                <li key={`${message.id}-step-${index}`}>
                  <span>{step.goal}</span>
                  <span className="pd">{step.durationMs}ms</span>
                </li>
              ))}
            </ol>
          </div>
        );
      }
      /* 任务清单：长任务的执行进度就靠这张卡。同一张卡原位更新（id 不变），
       * 所以长任务推进时用户看到的是一份清单在变，而不是一串历史清单。 */
      case 'todo': {
        const { progress, items } = message;
        const allDone = progress.total > 0 && progress.done === progress.total;
        return (
          <div className={`todo${allDone ? ' alldone' : ''}`} key={message.id} data-todo-progress={progress.percent}>
            <div className="th">
              <span className="tt">{allDone ? '任务已完成' : '任务清单'}</span>
              <span className="tp">{progress.done}/{progress.total}</span>
              {progress.blocked > 0 ? <span className="tb warn">{progress.blocked} 项受阻</span> : null}
              {message.degraded ? <span className="tb">演示轨迹</span> : null}
              <div className="tbar" title={`完成度 ${progress.percent}%（由状态数推导，不是模型自报）`}>
                <i style={{ width: `${progress.percent}%` }} />
              </div>
            </div>
            <ul>
              {items.map((item, index) => (
                <li key={`${message.id}-${item.id}`} className={`ti ${item.status}`}>
                  <span className="tic" aria-hidden>
                    {item.status === 'done' ? '✓' : item.status === 'doing' ? '▸' : item.status === 'blocked' ? '!' : index + 1}
                  </span>
                  <span className="tit">{item.title}</span>
                  {item.note ? <span className="tin">{item.note}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        );
      }
      /* 压缩摘要卡：上下文被折叠的证据。默认收起正文，点开能核对提炼得对不对；
       * 必须明说「原始消息还在」—— 否则用户会以为历史被删了。 */
      case 'summary': {
        return (
          <div className="ctxfold" key={message.id} data-source={message.source}>
            <div className="cfh">
              <span className="cft">已折叠早前 {message.messages} 条对话</span>
              <span className="cfm">
                {message.mode === 'auto' ? '自动压缩' : '手动压缩'} ·{' '}
                {message.source === 'model'
                  ? `模型提炼${message.model ? `（${message.model}）` : ''}`
                  : '规则提炼（未接入模型）'}
                {message.freedTokens > 0 ? ` · 省下约 ${message.freedTokens} tokens` : ''}
              </span>
            </div>
            <details className="cfd">
              <summary>查看摘要内容</summary>
              <pre>{message.content}</pre>
            </details>
            <div className="cfn">原始消息仍完整保留在时间线里，只是不再整段发给模型。</div>
          </div>
        );
      }
      case 'notice':
        return (
          <div className={`notice ${message.level}`} key={message.id} data-notice={message.level}>
            <div className="nt">{message.title}</div>
            {message.content.split(/\r?\n/).map((line, index) => (
              <p key={`${message.id}-line-${index}`}>{line}</p>
            ))}
          </div>
        );
      case 'tool': {
        const open = !!openTools[message.id];
        return (
          <React.Fragment key={message.id}>
            <div className="toolrow" onClick={() => setOpenTools((prev) => ({ ...prev, [message.id]: !prev[message.id] }))}>
              <CaretIcon dir={open ? 'down' : 'right'} size={10} strokeWidth={1.6} className="caret2" />
              <span className="tn">{message.name}</span>
              <span className={`st ${message.statusCls ?? 'ok'}`}>{message.status}</span>
              <span className="ms">{message.ms}</span>
            </div>
            {open ? (
              <div className="toolexp">
                <div className="pt">参数 JSON</div>
                <pre>{message.args}</pre>
                <div className="pt">结果摘要</div>
                <pre>{message.result}</pre>
              </div>
            ) : null}
          </React.Fragment>
        );
      }
      case 'approval': {
        /* 审批卡：Agent 的高风险写操作挂起在这里等裁决。
         * 三条硬约束：① 已裁决后按钮全部禁用（服务端也会挡重复裁决）；
         * ② 没有 plan（演示轨迹遗留名 / 无可执行内容）时批准只记裁决不执行，文案要如实说；
         * ③ 裁决结果来自服务端 auditId，不在前端编。
         * V2：hasPlan=true 的卡批准后服务端按 precheck→执行→校验→回滚 真执行；
         * 「本会话允许」登记会话级审批记忆（键=intent+targetType+risk，不含参数）；
         * 已批准且产生 rollbackRef 的卡给「回滚」按钮。 */
        const deliverToTerminal = (): void => {
          copyToClipboard(message.cmd);
          setTermPreset(message.cmd);
          navigate('detail-server');
        };
        const resolved = message.resolved === true;
        const executableCard = message.hasPlan === true;
        const decidedLabel = message.decision === 'approve'
          ? (executableCard
            ? (message.executionOk ? '已批准并执行' : '已批准（执行失败，无副作用）')
            : '已批准（仅记录裁决，未执行）')
          : '已拒绝';
        const decide = (scope: 'once' | 'session'): void => {
          void api.respondApproval(conversationId, message.id, 'approve', scope).then((envelope) => {
            if (envelope.ok) {
              addToast(scope === 'session'
                ? '已批准执行 · 本会话内同类操作免审（按 intent+类型+风险记忆，不放宽到不同目标）'
                : executableCard
                  ? '已批准 · precheck→执行→校验 管线已跑完，回滚引用见卡片'
                  : '已批准 · 裁决已记入审计（无可执行内容，磁盘零变更）');
            } else {
              addToast(`批准失败：${envelope.error?.message ?? '网络异常'}`);
            }
          });
        };
        return (
          <div className={`appr${flash ? ' flash' : ''}`} id="appr-card" key={message.id}>
            <span className="ic">
              <TriangleSvg />
            </span>
            <span className="txt">
              {resolved ? decidedLabel : '待审批'}：<code>{message.cmd}</code>
              {message.reason ? <>{' '}{message.reason} </> : null}{' '}
              <span style={{ color: 'var(--gray-400)', fontSize: 11.5 }}>
                {resolved
                  ? (message.scope === 'session' ? '（本会话免审已生效 · 裁决已记入审计）' : '（裁决已记入审计）')
                  : executableCard
                    ? '（Agent 发起 · 批准后按 precheck→执行→校验→回滚 管线真执行）'
                    : state.readOnly
                      ? '（Agent 发起 · 只读模式下不可执行）'
                      : '（Agent 发起 · 需确认后执行）'}
              </span>
            </span>
            <span className="bs">
              <button
                className="btn"
                onClick={() => {
                  copyToClipboard(message.cmd);
                  addToast('命令已复制到剪贴板');
                }}
              >
                复制命令
              </button>
              {!executableCard ? (
                <button className="btn" onClick={deliverToTerminal}>
                  复制并去终端
                </button>
              ) : null}
              <button
                className="btn"
                onClick={() =>
                  setModal({
                    kind: 'command',
                    title: '命令详情 · Agent 待审批操作',
                    command: message.cmd,
                    body: executableCard
                      ? '来源：Agent 发起。批准后由服务端写执行器真执行：预检通过才落盘，落盘前留快照/备份，结果与回滚引用写回本卡。'
                      : state.readOnly
                        ? '来源：Agent 发起。只读模式下该命令只生成建议、不执行；你的手动终端输入不受此约束。'
                        : '来源：Agent 发起。该操作无可执行内容，批准只记录裁决，不会自动落盘。',
                  })
                }
              >
                查看命令
              </button>
              {resolved && message.decision === 'approve' && message.rollbackRef ? (
                <button
                  className="btn"
                  onClick={() => {
                    void api.rollbackApproval(conversationId, message.id).then((envelope) => {
                      addToast(envelope.ok
                        ? `回滚完成：${envelope.data?.message?.slice(0, 80) ?? '已按回滚引用恢复'}`
                        : `回滚失败：${envelope.error?.message ?? '网络异常'}`);
                    });
                  }}
                >
                  回滚
                </button>
              ) : null}
              <button
                className="btn"
                disabled={resolved}
                onClick={() => {
                  /* 裁决写回服务端审计，成功后刷新 REST 数据切片。 */
                  void api.respondApproval(conversationId, message.id, 'deny').then((envelope) => {
                    addToast(envelope.ok
                      ? '已拒绝该操作 · 裁决已记入审计'
                      : `拒绝失败：${envelope.error?.message ?? '网络异常'}`);
                  });
                }}
              >
                拒绝
              </button>
              {!state.readOnly ? (
                <button className="btn p" disabled={resolved} onClick={() => decide('once')}>
                  {executableCard ? '批准执行' : '批准'}
                </button>
              ) : null}
              {!state.readOnly && executableCard ? (
                <button className="btn p" disabled={resolved} onClick={() => decide('session')} title="本会话内同类操作（intent+类型+风险）免审；不含具体参数，不同目标不继承">
                  批准并本会话免审
                </button>
              ) : null}
            </span>
          </div>
        );
      }
      case 'suggestion': {
        /* 建议卡：deny / suggest 的产物。它没有「批准」按钮 —— 那不是审批，
         * 是 Agent 想做事但被拦下，只能由用户自己决定要不要手动执行。 */
        return (
          <div className="appr sugg" key={message.id}>
            <span className="ic">
              <TriangleSvg />
            </span>
            <span className="txt">
              已拦截 · 仅生成建议：<code>{message.cmd}</code>
              {message.reason ? <>{' '}{message.reason} </> : null}
              <span style={{ color: 'var(--gray-400)', fontSize: 11.5 }}>
                （{message.suggestion ?? '未执行任何写操作，磁盘零变更'}）
              </span>
            </span>
            <span className="bs">
              <button
                className="btn"
                onClick={() => {
                  copyToClipboard(message.cmd);
                  addToast('建议命令已复制');
                }}
              >
                复制建议
              </button>
              <button
                className="btn"
                onClick={() => {
                  setTermPreset(message.cmd);
                  navigate('detail-server');
                }}
              >
                去终端执行
              </button>
            </span>
          </div>
        );
      }
      case 'conclusion':
        return (
          <div className="concl" key={message.id}>
            <div className="ch">
              <span className="ct">结论</span>
              <span className="conf">置信度 {message.confidence}</span>
            </div>
            {/* 段落 / 标题 / 列表 / 代码块统一交给 Markdown 渲染，引用角标仍可点。 */}
            <Markdown
              paras={message.paras}
              renderLine={(segments, key) => renderSegments(segments, key)}
              onCopy={(code) => {
                copyToClipboard(code);
                addToast('代码已复制');
              }}
            />
          </div>
        );
      case 'artifact':
        return (
          <React.Fragment key={message.id}>
            <div
              className="art"
              onClick={() => setOpenArtifacts((prev) => ({ ...prev, [message.id]: !prev[message.id] }))}
            >
              <div className="thumb">
                <ChartSvg />
              </div>
              <div>
                <div className="an">{message.name}</div>
                <div className="am">{message.meta}</div>
              </div>
              <span className="open">{openArtifacts[message.id] ? '收起产物' : '展开产物'}</span>
            </div>
            {openArtifacts[message.id] ? (
              <div className="artexp">
                <div className="ph">{`${message.name} · ${message.meta}`}</div>
                <div style={{ fontSize: 11.5, color: 'var(--gray-400)', marginTop: 8 }}>{message.desc}</div>
                <div className="artexp-btns">
                  <button
                    className="btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      /* 产物在工作区新开一个预览 tab —— 预览需要版面，塞在会话里看不了。 */
                      openArtifact({ id: message.name, name: message.name });
                      addToast(`已在工作区打开 ${message.name}`);
                    }}
                  >
                    在新标签页打开
                  </button>
                  <button
                    className="btn"
                    onClick={(event) => {
                      event.stopPropagation();
                      setArtifactPicker(true);
                    }}
                  >
                    看本次全部产物
                  </button>
                </div>
              </div>
            ) : null}
          </React.Fragment>
        );
      default:
        return null;
    }
  };

  const citation = state.citation
    ? { ...(CITATIONS[state.citation.id] ?? { id: state.citation.id, title: '引用', source: '', locator: '', code: '', score: '—' }), ...(citationLive[state.citation.id] ?? {}) }
    : null;

  return (
    <div className={`thread${compact ? ' compact' : ''}`} ref={threadRef}>
      <div className="tin" ref={tinRef}>
        {messages.map((message, index) => {
          const turn = turnByUserIndex.get(index);
          const replyTurn = turnByEndIndex.get(index);
          return (
            <React.Fragment key={message.id}>
              {renderMessage(message)}
              {message.kind === 'user' && turn ? renderUserActions(message, turn) : null}
              {replyTurn ? renderReplyBar(replyTurn) : null}
            </React.Fragment>
          );
        })}
        {streamText !== null ? (
          <div className="msg" data-streaming="1">
            <p>
              {streamText || '正在连接模型…'}
              <span style={{ opacity: 0.6 }}>▍</span>
            </p>
          </div>
        ) : null}

        {state.citation && citation ? (
          <div
            className="cite-pop"
            style={{ top: state.citation.top, left: state.citation.left }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="cph">
              <span className="cpt">
                [{citation.id}] {citation.title}
              </span>
              <button className="cpx" onClick={() => setCitation(null)} aria-label="关闭引用浮层">
                <CloseIcon size={12} strokeWidth={1.5} />
              </button>
            </div>
            <div className="cpsrc">
              {citation.source} · {citation.locator}
            </div>
            <pre className="cpcode">{citation.code}</pre>
            <div className="cpmeta">命中 {citation.score}</div>
            <div className="cpbtns">
              <button
                className="btn"
                disabled={!citation.path}
                title={citation.path ? `打开 ${citation.locator}` : '该引用没有可打开的源文件'}
                onClick={() => {
                  if (!citation.path) {
                    addToast('该引用没有可打开的源文件');
                    return;
                  }
                  openSource(citation.path, citation.startLine ?? undefined);
                  addToast(`已打开 ${citation.locator}`);
                }}
              >
                打开
              </button>
              <button
                className="btn"
                onClick={() => {
                  copyToClipboard(`${citation.locator}\n${citation.code}`);
                  addToast('引用片段已复制');
                }}
              >
                复制
              </button>
              <button
                className="btn"
                onClick={() => {
                  setCitation(null);
                  openBench('ctx');
                  addToast('已在工作区打开「上下文」');
                }}
              >
                看全部
              </button>
              <button className="btn" onClick={() => setCitation(null)}>
                关闭
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
