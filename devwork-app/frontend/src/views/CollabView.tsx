/**
 * 协作流视图 —— 一条会话从「人问了一句」到「谁在做、做到哪一步」的全链路。
 *
 * 为什么它不该是右栏里的一格：
 *   协作流的信息形状是**两条并排的时间线**（会话侧：我问了什么；
 *   执行侧：它接单没有、第几轮、卡在哪）。并排才看得出「第 3 轮开始变慢」
 *   或者「这次提问根本没触发派工」；塞进 300px 的栏位里，两条线只能垂直堆叠，
 *   那就不再是协作流，而是两份列表。
 *
 * 数据只有一个入口：GET /api/conversations/:id/tickets。
 * 前端不串 /tickets/:id —— 串出来的时间线对不齐，人也看不出轮次之间的快慢差异。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import type { TicketAssignment, TicketDetail } from '../api/types';
import { buildContextTurns } from '../utils/contextSteps';
import { CloseIcon, PlayIcon, RefreshIcon } from '../components/icons';
import { STAGE_LABEL, isWaitingHuman, stageClass } from './shadow/labels';

/** 毫秒 → 「1.2s / 340ms / 2m14s」。协作流里最常比的就是这个数。 */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

/** 本地时间 HH:mm:ss：只用于「什么时候刷新的」这一句，不做时区换算。 */
function fmtClock(iso: string): string {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) return '';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function roundWallMs(assignment: TicketAssignment): number {
  const start = Date.parse(assignment.startedAt);
  const end = assignment.endedAt ? Date.parse(assignment.endedAt) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.max(0, end - start);
}

/** 授权范围说人话：只列真正有信息量的字段，空的一律不显示。 */
function scopeText(ticket: TicketDetail): string {
  const scope = ticket.mandate?.scope;
  if (!scope) return '未签发授权';
  const parts = [
    scope.assetTypes?.length ? scope.assetTypes.join('/') : '',
    scope.actions?.length ? scope.actions.join('/') : '',
    scope.riskCeiling ? `风险 ≤ ${scope.riskCeiling}` : '',
    typeof scope.maxWrites === 'number' ? `写 ≤ ${scope.maxWrites}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : '范围未限定';
}

export default function CollabView({ conversationId }: { conversationId: string }): React.ReactElement {
  const { state, toggleCollab, navigate, addToast, refreshWaiting } = useStore();
  const [tickets, setTickets] = useState<TicketDetail[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [refreshedAt, setRefreshedAt] = useState<string>('');
  /* 就地回答的草稿与忙碌标记：按工单 id 存。
   * 放组件内而不是 store —— 一句话的草稿不值得让整个应用重渲染。 */
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>('');

  /** silent = 后台轮询：不闪 loading 骨架，避免每 5 秒整页抖一下。 */
  const load = useCallback(
    async (silent = false): Promise<void> => {
      if (!conversationId) return;
      if (!silent) setLoading(true);
      try {
        const envelope = await api.listConversationTickets(conversationId, 20);
        if (envelope.ok) {
          setTickets(envelope.data.items ?? []);
          setError('');
          setRefreshedAt(fmtClock(new Date().toISOString()));
        } else {
          setError(envelope.error?.message ?? '工单接口不可用');
          setTickets([]);
        }
      } catch {
        setError('网络异常，取不到工单');
        setTickets([]);
      } finally {
        setLoading(false);
      }
    },
    [conversationId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** 只要还有未结束的工单就每 5 秒刷一次：这是「盯着看」的页面，静止的数据等于骗人。 */
  const live = tickets.some((ticket) => ticket.state === 'open');
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      void load(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [live, load]);

  /* 会话侧：复用上下文面板那套「轮 / 步」折叠口径 ——
   * 同一个概念在两个面板里用不同的算法解释，是最容易让人失去信任的事。 */
  const messages = state.threads[conversationId] ?? [];
  const turns = useMemo(
    () => buildContextTurns(messages, state.streams[conversationId] ?? null),
    [messages, state.streams, conversationId],
  );

  /**
   * 就地回答。
   *
   * 为什么这件事必须在这里做：待人清单会把人从任务栏一路引到这张卡片上，
   * 到了却还要再跳一次工单页才能说一句话 —— 那条路径上每一次跳转都是一次流失。
   *
   * 提交成功后立刻 `refreshWaiting()`：侧栏徽标、tab 橙点、任务栏数字读的都是
   * 那一份快照，等下一轮 10 秒轮询的话，人会盯着没消掉的红点怀疑没提交成功。
   */
  const submitAnswer = useCallback(
    async (ticketId: string, attentionId: string): Promise<void> => {
      const text = (answers[ticketId] ?? '').trim();
      if (!text || busy) return;
      setBusy(ticketId);
      try {
        const envelope = await api.answerTicket(ticketId, { attentionId, answer: text });
        if (!envelope.ok) {
          addToast(`回答失败：${envelope.error?.message ?? '未知错误'}`);
          return;
        }
        setAnswers((prev) => ({ ...prev, [ticketId]: '' }));
        /* 文案用服务端那一句：回答之后到底发生了什么（重新排队 / 直接起跑）
         * 只有服务端知道，前端自己编一句迟早会说错。 */
        addToast(envelope.data?.message || '已回答');
        await load(true);
        void refreshWaiting();
      } finally {
        setBusy('');
      }
    },
    [answers, busy, addToast, load, refreshWaiting],
  );

  /** 验收 / 重排 / 停止：这三件事同样不该逼人跳页。文案说人话，动作保持原语义。 */
  const runAction = useCallback(
    async (
      ticketId: string,
      action: () => Promise<{ ok: boolean; data?: unknown; error?: { message?: string } | null }>,
      fallback: string,
    ): Promise<void> => {
      if (busy) return;
      setBusy(ticketId);
      try {
        const envelope = await action();
        /* 服务端给了文案就用它的：动作到底是什么语义（停止 / 重排 / 已结束）
         * 只有它知道，前端再翻译一遍就是两个真相。 */
        const serverMessage = (envelope.data as { message?: string } | undefined)?.message;
        addToast(envelope.ok ? serverMessage || fallback : `操作失败：${envelope.error?.message ?? '未知错误'}`);
        if (envelope.ok) {
          await load(true);
          void refreshWaiting();
        }
      } finally {
        setBusy('');
      }
    },
    [busy, addToast, load, refreshWaiting],
  );

  const totals = useMemo(() => {
    return tickets.reduce(
      (acc, ticket) => ({
        rounds: acc.rounds + ticket.totals.rounds,
        failed: acc.failed + ticket.totals.failedRounds,
        waiting: acc.waiting + (isWaitingHuman(ticket.stage) ? 1 : 0),
      }),
      { rounds: 0, failed: 0, waiting: 0 },
    );
  }, [tickets]);

  return (
    <div className="collab">
      <div className="collab-hd">
        <div className="collab-hd-t">
          <PlayIcon size={13} strokeWidth={1.7} />
          <b>协作流</b>
          <span className="collab-hd-sub">{state.activeConversationTitle || '未命名会话'}</span>
        </div>
        <div className="collab-hd-meta">
          <span className={`collab-live${live ? ' on' : ''}`}>
            <i />
            {live ? '实时刷新' : '已静止'}
          </span>
          <span className="collab-kpi">{tickets.length} 张工单 · {totals.rounds} 轮派工</span>
          {totals.waiting > 0 ? <span className="collab-kpi warn">{totals.waiting} 张等你</span> : null}
          {totals.failed > 0 ? <span className="collab-kpi bad">{totals.failed} 轮失败</span> : null}
          {refreshedAt ? <span className="collab-ts">{refreshedAt}</span> : null}
          <button className="ib" type="button" title="立即刷新" onClick={() => void load()}>
            <RefreshIcon size={13} strokeWidth={1.5} />
          </button>
          <button
            className="ib"
            type="button"
            title="关闭协作流（回到对话）"
            onClick={() => toggleCollab(false)}
          >
            <CloseIcon size={13} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      <div className="collab-cols">
        {/* ── 左：会话侧 ── */}
        <section className="collab-col">
          <div className="collab-col-hd">
            <span>我问了什么</span>
            <span className="collab-col-n">{turns.length} 轮</span>
          </div>
          <div className="collab-col-body">
            {turns.length === 0 ? (
              <div className="collab-empty-lite">这条会话还没有内容。</div>
            ) : (
              turns.map((turn) => (
                <div className="cv-turn" key={`${turn.index}-${turn.ask.slice(0, 10)}`}>
                  <div className="cv-turn-hd">
                    <span className={`ctx-turn-no${turn.running ? ' run' : ''}`}>{turn.index}</span>
                    <span className="cv-turn-ask">{turn.ask || '（空提问）'}</span>
                  </div>
                  {turn.chips.length > 0 ? (
                    <div className="ctx-turn-chips">
                      {turn.chips.map((chip) => (
                        <span key={chip}>{chip}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="cv-turn-steps">
                    {turn.steps.length === 0 ? (
                      <span className="cv-muted">（还没有步骤）</span>
                    ) : (
                      turn.steps.map((step) => (
                        <span className="cv-step" key={step.id} data-status={step.status}>
                          <i />
                          {step.label}
                        </span>
                      ))
                    )}
                  </div>
                  <div className="cv-turn-foot">
                    {turn.tokens
                      ? `in ${turn.tokens.prompt ?? '—'} / out ${turn.tokens.completion} tok`
                      : 'token 无真值'}
                    {turn.toolMs > 0 ? ` · 工具 ${fmtDuration(turn.toolMs)}` : ''}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* ── 右：执行侧 ── */}
        <section className="collab-col">
          <div className="collab-col-hd">
            <span>谁在做、做到哪</span>
            <span className="collab-col-n">{tickets.length} 张</span>
          </div>
          <div className="collab-col-body">
            {loading ? <div className="collab-empty-lite">正在读取工单…</div> : null}

            {!loading && error ? (
              <div className="collab-empty">
                <b>取不到工单数据</b>
                <p>{error}</p>
                <p className="cv-muted">
                  会话本身不受影响：这里只读，失败不会动任何东西。后端未启动或该接口未注册时，
                  协作流会一直停在这一屏。
                </p>
                <button className="btn" type="button" onClick={() => void load()}>
                  重试
                </button>
              </div>
            ) : null}

            {!loading && !error && tickets.length === 0 ? (
              <div className="collab-empty">
                <b>这条会话还没有被接单</b>
                <p>
                  协作流记的是「它自己决定去做」之后的过程：事件 → 研判 → 工单 → 派工 →
                  轮次 → 产物。单纯的问答不会建单，所以这里空着是正常的。
                </p>
                <p className="cv-muted">
                  想让它动手，要么在提问里明确点名要求做事，要么去执行中心把准入模式与白名单配好。
                </p>
                <button className="btn" type="button" onClick={() => navigate('shadow')}>
                  去看准入规则
                </button>
              </div>
            ) : null}

            {tickets.map((ticket) => {
              /* 一张单同时最多一个未答提问（服务端 recomputeStage 按它定人阶段），
               * 所以就地问答只针对这一个 —— 列一排输入框只会让人不知道填哪个。 */
              const openQuestion = ticket.attentions.find((item) => item.answer === null) ?? null;
              const draft = answers[ticket.id] ?? '';
              const waitingHere = ticket.state === 'open' && isWaitingHuman(ticket.stage);
              const options = (openQuestion?.options ?? []).map((option) => String(option)).filter(Boolean);
              return (
              <article className="tk" key={ticket.id} data-stage={ticket.stage}>
                <header className="tk-hd">
                  <span className={`tk-stage ${stageClass(ticket.stage)}`}>
                    {STAGE_LABEL[ticket.stage] ?? ticket.stage}
                  </span>
                  <span className="tk-name">#{ticket.shortName}</span>
                  <span className="tk-state">
                    {ticket.state === 'open' ? '进行中' : `已结束${ticket.endedReason ? ` · ${ticket.endedReason}` : ''}`}
                  </span>
                </header>

                <div className="tk-title">{ticket.title}</div>

                <div className="tk-scope">
                  <span className="tk-scope-k">授权</span>
                  {ticket.mandate
                    ? `${ticket.mandate.status} · ${ticket.mandate.strength} · ${scopeText(ticket)}`
                    : '未签发（影子期只记录不执行）'}
                </div>

                <div className="tk-rounds">
                  {ticket.assignments.length === 0 ? (
                    <div className="cv-muted">还没有派工轮次</div>
                  ) : (
                    ticket.assignments.map((assignment, index) => (
                      <div className="tk-round" key={assignment.id} data-state={assignment.state}>
                        <span className="tk-round-no">#{index + 1}</span>
                        <span className="tk-round-state">{assignment.state}</span>
                        <span className="tk-round-dur">{fmtDuration(roundWallMs(assignment))}</span>
                        <span className="tk-round-tok">
                          {assignment.tokensIn}/{assignment.tokensOut} tok
                        </span>
                        {assignment.attempts > 1 ? (
                          <span className="tk-round-retry">重试 {assignment.attempts - 1}</span>
                        ) : null}
                        {assignment.report ? (
                          <span className={`tk-round-report${assignment.report === 'failed' ? ' bad' : ''}`}>
                            {assignment.report}
                          </span>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>

                {ticket.attentions.length > 0 ? (
                  <div className="tk-block">
                    <div className="tk-block-hd">它问过人的 {ticket.attentions.length} 个问题</div>
                    {ticket.attentions.map((item) => (
                      <div className="tk-q" key={item.id}>
                        <div className="tk-q-q">{item.question}</div>
                        {item.answer !== null ? (
                          <div className="tk-q-a">{item.answer}</div>
                        ) : item.blocking && ticket.state === 'open' ? (
                          /* 就地回答：人已经被任务栏/徽标引到这张卡片上，
                           * 再让他跳一次工单页才能说一句话，等于白引。 */
                          <div className="tk-ans">
                            {options.length > 0 ? (
                              <div className="tk-ans-opts">
                                {options.map((option) => (
                                  <button
                                    type="button"
                                    key={option}
                                    className={`tk-opt${draft === option ? ' on' : ''}`}
                                    onClick={() =>
                                      setAnswers((prev) => ({ ...prev, [ticket.id]: option }))
                                    }
                                  >
                                    {option}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                            <div className="tk-ans-row">
                              <input
                                value={draft}
                                className="tk-ans-input"
                                placeholder="直接回答，工单会接着跑"
                                aria-label={`回答：${item.question}`}
                                onChange={(event) =>
                                  setAnswers((prev) => ({ ...prev, [ticket.id]: event.target.value }))
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                                    void submitAnswer(ticket.id, item.id);
                                  }
                                }}
                              />
                              <button
                                type="button"
                                className="btn p"
                                disabled={busy === ticket.id || draft.trim() === ''}
                                onClick={() => void submitAnswer(ticket.id, item.id)}
                              >
                                {busy === ticket.id ? '提交中…' : '回答'}
                              </button>
                            </div>
                            <div className="tk-ans-hint">
                              {item.impact || '它的下一步取决于这句话'} · 回车提交
                            </div>
                          </div>
                        ) : (
                          <div className="tk-q-a">
                            {item.blocking ? '等你回答（阻塞中）' : '未回答'}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* 非「等问题」的待人阶段：验收 / 受阻 / 失败，同样就地给出两个出口。
                 * 验收通过 = 结束这张单（stop）；打回重做 = 重新排队（retry）。 */}
                {waitingHere && !openQuestion ? (
                  <div className="tk-acts">
                    <span className="tk-acts-hint">
                      {ticket.stage === 'person/review' ? '它交东西了，等你验收' : '它停了，等你决定'}
                    </span>
                    {ticket.stage === 'person/review' ? (
                      <button
                        type="button"
                        className="btn p"
                        disabled={busy === ticket.id}
                        title="验收通过：结束这张工单"
                        onClick={() =>
                          void runAction(ticket.id, () => api.stopTicket(ticket.id), '已验收，工单结束')
                        }
                      >
                        验收通过
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn"
                      disabled={busy === ticket.id}
                      title="重新排队：让它再跑一轮"
                      onClick={() =>
                        void runAction(ticket.id, () => api.retryTicket(ticket.id), '已重新排队')
                      }
                    >
                      重新排队
                    </button>
                    {ticket.stage !== 'person/review' ? (
                      <button
                        type="button"
                        className="btn"
                        disabled={busy === ticket.id}
                        title="停止这张工单"
                        onClick={() =>
                          void runAction(ticket.id, () => api.stopTicket(ticket.id), '已停止')
                        }
                      >
                        停止
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {ticket.inbox.length > 0 ? (
                  <div className="tk-block">
                    <div className="tk-block-hd">期间收到的 {ticket.inbox.length} 条事件</div>
                    {ticket.inbox.slice(0, 5).map((item) => (
                      <div className="tk-inbox" key={item.triggerId}>
                        <span className="tk-inbox-actor">{item.actor || '匿名'}</span>
                        <span className="tk-inbox-body">{item.body}</span>
                        <span className="tk-inbox-at">{fmtClock(item.receivedAt)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}

                <div className="tk-foot">
                  共 {ticket.totals.rounds} 轮 · 失败 {ticket.totals.failedRounds} ·{' '}
                  {ticket.totals.tokensIn}/{ticket.totals.tokensOut} tok · 起于 {fmtClock(ticket.createdAt)}
                </div>
              </article>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
