/**
 * 工单分区：这是「要我做什么」的那一屏。
 *
 * 排序原则：待人的排最前，其次在跑，最后是已结束的。
 * 不是按时间倒序 —— 时间倒序会把最该处理的那张压在下面。
 */
import React from 'react';
import { useStore } from '../../store';
import { api } from '../../api/client';
import { STAGE_LABEL, isWaitingHuman, stageClass } from './labels';
import type { ShadowData } from './useShadowData';
import TicketDetailPanel from './TicketDetail';

type Filter = 'all' | 'waiting' | 'running' | 'ended';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'waiting', label: '待人' },
  { value: 'running', label: '在跑' },
  { value: 'ended', label: '已结束' },
];

/** 排序权重：待人 0 → 在跑 1 → 等新事件 2 → 已结束 3。 */
function orderOf(stage: string, state: string): number {
  if (state === 'ended') return 3;
  if (isWaitingHuman(stage)) return 0;
  if (stage === 'working' || stage === 'queued') return 1;
  return 2;
}

export default function TicketsPanel({ data }: { data: ShadowData }): React.ReactElement {
  const { setConversation, navigate } = useStore();
  const [filter, setFilter] = React.useState<Filter>('all');
  const [query, setQuery] = React.useState('');

  const counts = React.useMemo(() => ({
    all: data.tickets.length,
    waiting: data.tickets.filter((item) => item.state === 'open' && isWaitingHuman(item.stage)).length,
    running: data.tickets.filter((item) => item.state === 'open' && !isWaitingHuman(item.stage)).length,
    ended: data.tickets.filter((item) => item.state === 'ended').length,
  }), [data.tickets]);

  const rows = React.useMemo(() => {
    const matched = data.tickets.filter((ticket) => {
      if (filter === 'waiting') return ticket.state === 'open' && isWaitingHuman(ticket.stage);
      if (filter === 'running') return ticket.state === 'open' && !isWaitingHuman(ticket.stage);
      if (filter === 'ended') return ticket.state === 'ended';
      return true;
    });
    const keyword = query.trim().toLowerCase();
    const filtered = keyword
      ? matched.filter((ticket) => `${ticket.title} ${ticket.shortName} ${ticket.reportNote}`
        .toLowerCase().includes(keyword))
      : matched;
    /* 排序在筛选之后：先按状态分组，再按创建时间倒序 —— 同组里新的在前。 */
    return [...filtered].sort((a, b) => {
      const diff = orderOf(a.stage, a.state) - orderOf(b.stage, b.state);
      if (diff !== 0) return diff;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  }, [data.tickets, filter, query]);

  const kpi = [
    {
      label: '进行中',
      value: data.ticketStats?.open ?? 0,
      hint: `并发上限 ${data.ticketStats?.maxConcurrent ?? 1}`,
      tone: '',
    },
    {
      label: '等你处理',
      value: data.ticketStats?.waitingHuman ?? 0,
      hint: '回答 / 验收 / 受阻',
      tone: (data.ticketStats?.waitingHuman ?? 0) > 0 ? 'warn' : 'acc',
    },
    {
      label: '打扰密度',
      value: data.ticketStats?.attentionPerTicket ?? 0,
      hint: '每张单平均问几次人 · 目标 ≤1.5',
      tone: '',
    },
    {
      label: '累计派工',
      value: data.ticketStats?.assignments ?? 0,
      hint: `失败 ${data.ticketStats?.failedAssignments ?? 0} 轮`,
      tone: '',
    },
  ];

  return (
    <>
      <div className="sh-kpis">
        {kpi.map((item) => (
          <div className={`sh-kpi${item.tone ? ` ${item.tone}` : ''}`} key={item.label}>
            <div className="n">{item.value}</div>
            <div className="l">{item.label}</div>
            <div className="h">{item.hint}</div>
          </div>
        ))}
      </div>

      <div className="sh-toolbar">
        <div className="sh-seg sh-filter">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={filter === item.value ? 'on' : ''}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
              <span className="c">{counts[item.value]}</span>
            </button>
          ))}
        </div>
        <input
          className="sh-search"
          value={query}
          placeholder="搜标题 / 短名"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className="btn"
          disabled={data.ticketBusy === '__step__'}
          title="手动推一轮循环：研判 → 派单 → 执行 → 回收"
          onClick={() => void data.stepLoop()}
        >
          {data.ticketBusy === '__step__' ? '推进中…' : '立即推进'}
        </button>
      </div>

      <div className="sh-panel sh-tickets">
        {rows.length === 0 ? (
          <div className="sh-meta">
            {data.tickets.length === 0
              ? '还没有工单：事件被接单、且授权被认可（或 auto 签发）后才会建单。'
              : '这个筛选下没有工单。'}
          </div>
        ) : null}
        {rows.map((ticket) => {
          const active = data.detailId === ticket.id;
          return (
            <div className={`sh-trow${active ? ' on' : ''}`} key={ticket.id}>
              <div
                className="sh-tline"
                role="button"
                tabIndex={0}
                title="展开详情"
                onClick={() => data.openDetail(ticket.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') data.openDetail(ticket.id);
                }}
              >
                <span className={`sh-tag ${stageClass(ticket.stage)}`}>
                  {STAGE_LABEL[ticket.stage] ?? ticket.stage}
                </span>
                <span className="sh-ttitle" title={ticket.title}>{ticket.title}</span>
                <span className="sh-meta sh-tnote" title={ticket.reportNote}>
                  {ticket.question ? '' : (ticket.reportNote || ticket.matchedRules.join(' / '))}
                </span>
                <span className="sh-narrow">
                  {ticket.conversationId ? (
                    <button
                      className="btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (ticket.conversationId) {
                          setConversation(ticket.conversationId, `工单 · ${ticket.title.slice(0, 16)}`);
                        }
                        navigate('chat');
                      }}
                    >
                      看轨迹
                    </button>
                  ) : null}
                  {['person/failed', 'person/blocked'].includes(ticket.stage) ? (
                    <button
                      className="btn"
                      disabled={data.ticketBusy === ticket.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void data.runTicketAction(ticket.id, () => api.retryTicket(ticket.id), '已重新排队');
                      }}
                    >
                      重派
                    </button>
                  ) : null}
                  {ticket.state === 'open' ? (
                    <button
                      className="btn"
                      disabled={data.ticketBusy === ticket.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        void data.runTicketAction(ticket.id, () => api.stopTicket(ticket.id), '已停止');
                      }}
                    >
                      停止
                    </button>
                  ) : null}
                </span>
              </div>
              {ticket.question ? (
                <div className="sh-tq">
                  <span className="sh-warn">问：{ticket.question.question}</span>
                  <input
                    value={data.answers[ticket.id] ?? ''}
                    placeholder="直接回答，工单会接着跑"
                    onChange={(event) => data.setAnswers((prev) => ({ ...prev, [ticket.id]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void data.answerTicket(ticket);
                    }}
                  />
                  <button
                    className="btn p"
                    disabled={data.ticketBusy === ticket.id || !(data.answers[ticket.id] ?? '').trim()}
                    onClick={() => void data.answerTicket(ticket)}
                  >
                    回答
                  </button>
                </div>
              ) : null}
              {active ? <TicketDetailPanel data={data} /> : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
