/**
 * 工单详情：一张单的全部事实，就地展开。
 *
 * 为什么不做成弹窗：详情是「边看边判断」的东西 —— 人往往要对照列表里
 * 另一张单的 stage 才能决定这张该不该停。模态弹窗会把列表挡住。
 *
 * 五块内容按「人会问的问题」排序：
 *   卡在哪 → 我能动多大范围 → 跑了几轮 → 它问过我什么 → 期间来了什么
 */
import React from 'react';
import { useStore } from '../../store';
import { api } from '../../api/client';
import {
  MANDATE_STATUS,
  STAGE_LABEL,
  dateTimeOf,
  durationOf,
  isWaitingHuman,
  stageClass,
  tokensOf,
} from './labels';
import type { ShadowData } from './useShadowData';

const REPORT_LABEL: Record<string, string> = {
  progress: '进行中',
  waiting: '等待',
  ready: '已完成',
  blocked: '受阻',
  failed: '失败',
  dropped: '丢弃',
};

export default function TicketDetailPanel({ data }: { data: ShadowData }): React.ReactElement {
  const { setConversation, navigate, addToast } = useStore();
  const detail = data.detail;
  const [copied, setCopied] = React.useState(false);

  if (data.detailLoading && !detail) {
    return <div className="sh-detail"><div className="sh-meta">读取详情…</div></div>;
  }
  if (!detail) {
    return <div className="sh-detail"><div className="sh-meta">详情读取失败，刷新重试。</div></div>;
  }

  const scope = detail.mandate?.scope;
  const workdir = detail.assignments.length > 0
    ? detail.assignments[detail.assignments.length - 1].workdir
    : '';

  const copyPath = (): void => {
    if (!workdir) return;
    void navigator.clipboard?.writeText(workdir).then(() => {
      setCopied(true);
      addToast('工作目录已复制');
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="sh-detail">
      <div className="sh-dhead">
        <span className={`sh-tag ${stageClass(detail.stage)}`}>
          {STAGE_LABEL[detail.stage] ?? detail.stage}
        </span>
        <span className="sh-dtitle" title={detail.title}>{detail.title}</span>
        <span className="sh-code">{detail.shortName}</span>
        <span className="sh-narrow">
          {detail.conversationId ? (
            <button
              className="btn"
              onClick={() => {
                if (detail.conversationId) {
                  setConversation(detail.conversationId, `工单 · ${detail.title.slice(0, 16)}`);
                }
                navigate('chat');
              }}
            >
              看轨迹
            </button>
          ) : null}
          {['person/failed', 'person/blocked'].includes(detail.stage) ? (
            <button
              className="btn"
              disabled={data.ticketBusy === detail.id}
              onClick={() => void data.runTicketAction(detail.id, () => api.retryTicket(detail.id), '已重新排队')}
            >
              重派
            </button>
          ) : null}
          {detail.state === 'open' ? (
            <button
              className="btn"
              disabled={data.ticketBusy === detail.id}
              onClick={() => void data.runTicketAction(detail.id, () => api.stopTicket(detail.id), '已停止')}
            >
              停止
            </button>
          ) : null}
          <button className="btn" onClick={() => data.closeDetail()}>收起</button>
        </span>
      </div>

      {detail.reportNote ? (
        <div className={`sh-dnote${detail.report === 'failed' || detail.report === 'blocked' ? ' bad' : ''}`}>
          {detail.reportNote}
        </div>
      ) : null}

      <div className="sh-dgrid">
        <div className="sh-dcell">
          <span className="k">轮次</span>
          <span className="v">{detail.totals.rounds}</span>
          <span className="s">{detail.totals.failedRounds > 0 ? `失败 ${detail.totals.failedRounds} 轮` : '无失败'}</span>
        </div>
        <div className="sh-dcell">
          <span className="k">Token</span>
          <span className="v">{tokensOf(detail.totals.tokensIn + detail.totals.tokensOut)}</span>
          <span className="s">入 {tokensOf(detail.totals.tokensIn)} / 出 {tokensOf(detail.totals.tokensOut)}</span>
        </div>
        <div className="sh-dcell">
          <span className="k">墙钟时长</span>
          <span className="v">{durationOf(detail.totals.wallMs)}</span>
          <span className="s">首轮开始 → 最近结束</span>
        </div>
        <div className="sh-dcell">
          <span className="k">期间新消息</span>
          <span className="v">{detail.totals.inboxCount}</span>
          <span className="s">同线程投递进来</span>
        </div>
      </div>

      {detail.mandate ? (
        <div className="sh-dsec">
          <div className="sh-dlabel">
            <span>授权范围</span>
            <span className={`sh-tag ${detail.mandate.status === 'accepted' ? 'ex'
              : detail.mandate.status === 'rejected' ? 'bad' : 'in'}`}>
              {MANDATE_STATUS[detail.mandate.status as keyof typeof MANDATE_STATUS] ?? detail.mandate.status}
            </span>
            <span className="sh-meta">
              {detail.mandate.strength} · {detail.mandate.policyVersion}
              {detail.mandate.reviewedAt ? ` · ${dateTimeOf(detail.mandate.reviewedAt)} 表态` : ''}
              {detail.mandate.note.startsWith('auto:') ? ' · 系统自动签发' : ''}
            </span>
          </div>
          <div className="sh-dscope">
            <span className="sh-tag">
              {scope?.level === 'asset'
                ? `${scope.assets?.length ?? 0} 个资产`
                : `工作区级 ${(scope?.assetTypes ?? []).join('/') || '—'}`}
            </span>
            <span className="sh-tag">风险≤{scope?.riskCeiling ?? '—'}</span>
            <span className={`sh-tag ${(scope?.maxWrites ?? 0) > 0 ? 'bad' : ''}`}>
              {scope?.maxWrites ?? 0} 次写
            </span>
            {(scope?.actions ?? []).map((action) => (
              <span className="sh-tag" key={action}>{action}</span>
            ))}
          </div>
          {detail.mandate.note && !detail.mandate.note.startsWith('auto:') ? (
            <div className="sh-meta">表态说明：{detail.mandate.note}</div>
          ) : null}
        </div>
      ) : null}

      <div className="sh-dsec">
        <div className="sh-dlabel">
          <span>派工轮次</span>
          <span className="sh-meta">{detail.assignments.length} 条记录</span>
        </div>
        {detail.assignments.length === 0 ? (
          <div className="sh-meta">还没有派工：授权认可后由循环自动派发。</div>
        ) : (
          <div className="sh-tbl sh-dtbl">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 108 }}>开始</th>
                  <th style={{ width: 62 }}>状态</th>
                  <th style={{ width: 68 }}>结果</th>
                  <th style={{ width: 74 }}>耗时</th>
                  <th style={{ width: 84 }}>Token</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {detail.assignments.map((item) => {
                  const used = item.startedAt && item.endedAt
                    ? Date.parse(item.endedAt) - Date.parse(item.startedAt)
                    : 0;
                  return (
                    <tr key={item.id}>
                      <td className="sh-code">{dateTimeOf(item.startedAt)}</td>
                      <td>{item.state === 'running' ? '执行中' : item.state === 'pending' ? '排队' : '已结束'}</td>
                      <td>
                        <span className={`sh-tag ${item.report === 'failed' || item.report === 'blocked' ? 'bad'
                          : item.report === 'ready' ? 'ex' : ''}`}>
                          {REPORT_LABEL[item.report] ?? (item.report || '—')}
                        </span>
                      </td>
                      <td className="sh-code">{used > 0 ? durationOf(used) : '—'}</td>
                      <td className="sh-code">{tokensOf(item.tokensIn + item.tokensOut)}</td>
                      <td className="sh-body-clip" title={item.reportNote}>{item.reportNote || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail.attentions.length > 0 ? (
        <div className="sh-dsec">
          <div className="sh-dlabel">
            <span>提问历史</span>
            <span className="sh-meta">
              {detail.attentions.filter((item) => item.answeredAt).length} 已答 /
              {' '}{detail.attentions.length} 总计
            </span>
          </div>
          {detail.attentions.map((item) => (
            <div className="sh-dask" key={item.id}>
              <div className="sh-dask-q">
                <span className={item.answeredAt ? 'sh-ok' : 'sh-warn'}>
                  {item.answeredAt ? '已答' : '待答'}
                </span>
                {item.question}
              </div>
              <div className="sh-meta">
                {dateTimeOf(item.askedAt)}
                {item.impact ? ` · 影响：${item.impact}` : ''}
              </div>
              {item.answer ? <div className="sh-dask-a">→ {item.answer}</div> : null}
            </div>
          ))}
        </div>
      ) : null}

      {detail.inbox.length > 0 ? (
        <div className="sh-dsec">
          <div className="sh-dlabel">
            <span>收件箱</span>
            <span className="sh-meta">这张单开始后，同线程投进来的消息</span>
          </div>
          {detail.inbox.map((item) => (
            <div className="sh-dinbox" key={item.triggerId}>
              <span className="sh-code">{dateTimeOf(item.receivedAt)}</span>
              <span className="sh-dinbox-actor">{item.actor}</span>
              <span className="sh-dinbox-body" title={item.body}>{item.body}</span>
            </div>
          ))}
        </div>
      ) : null}

      {workdir ? (
        <div className="sh-dsec">
          <div className="sh-dlabel">
            <span>工作目录</span>
            <button className="btn" onClick={copyPath}>{copied ? '已复制' : '复制路径'}</button>
          </div>
          <code className="sh-dpath">{workdir}</code>
          <div className="sh-meta">
            代码资产在本单自己的 git worktree 里，改它不会影响共享仓库。
          </div>
        </div>
      ) : null}

      {isWaitingHuman(detail.stage) && !detail.question ? (
        <div className="sh-dnote">
          这张单在等你（{STAGE_LABEL[detail.stage]}）。重派会重新排队；停止会结束整张单。
        </div>
      ) : null}
    </div>
  );
}
