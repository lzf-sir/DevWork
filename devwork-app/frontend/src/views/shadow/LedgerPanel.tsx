/**
 * 账本分区：授权草案 + 决策记录 + 原因分布。
 *
 * 这一屏回答的是「它为什么接 / 为什么不接」，而不是「它现在在干什么」。
 * 前者要看趋势和口径，后者要看单张单的状态 —— 两种问题不该挤在一屏。
 */
import React from 'react';
import {
  MANDATE_STATUS,
  REASON_LABEL,
  SOURCE_LABEL,
  clip,
  timeOf,
} from './labels';
import type { ShadowData } from './useShadowData';

export default function LedgerPanel({ data }: { data: ShadowData }): React.ReactElement {
  const [acceptOnly, setAcceptOnly] = React.useState(false);
  const status = data.status;
  const stats = data.stats;

  const byTrigger = React.useMemo(
    () => new Map(data.triggers.map((item) => [item.id, item])),
    [data.triggers],
  );

  const rows = React.useMemo(
    () => data.decisions.filter((item) => (acceptOnly ? item.wouldAccept : true)).slice(0, 60),
    [data.decisions, acceptOnly],
  );

  const kpi = [
    {
      label: '24h 研判',
      value: stats?.last24h.decided ?? 0,
      hint: stats ? `累计 ${stats.decisions.total} 条` : '—',
      tone: '',
    },
    {
      label: '24h 本来会接',
      value: stats?.last24h.estimatedDailyAccept ?? 0,
      hint: '这个数决定 auto 能不能开',
      tone: 'acc',
    },
    {
      label: '接单率',
      value: `${Math.round((stats?.decisions.wouldAcceptRate ?? 0) * 100)}%`,
      hint: `命中 ${stats?.decisions.wouldAccept ?? 0} / ${stats?.decisions.total ?? 0}`,
      tone: '',
    },
    {
      label: '待研判',
      value: stats?.triggers.pending ?? 0,
      hint: status?.tick.lastTickAt ? `最近 ${timeOf(status.tick.lastTickAt)}` : '未开始',
      tone: stats && stats.triggers.pending > 0 ? 'warn' : '',
    },
  ];

  const draftCount = data.mandates.filter((item) => item.status === 'draft').length;

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

      {/* 授权草案：决策说「会接」，这里说「接了能拿到多大范围」。
          必须先审范围，再谈接单 —— 没有范围，Mandate 就是一句口号。 */}
      <div className="sh-panel sh-mandates">
        <div className="sh-mhead">
          <span className="sh-tname">授权草案</span>
          <span className="sh-meta">
            {draftCount} 份待表态 · 共 {data.mandates.length} 份 ·
            {stats?.mandates ? ` 已认可 ${stats.mandates.accepted} / 收窄 ${stats.mandates.narrowed} / 否决 ${stats.mandates.rejected}` : ''}
          </span>
        </div>
        {data.mandates.length === 0 ? (
          <div className="sh-meta">还没有草案：事件命中规则才会产出。</div>
        ) : null}
        {data.mandates.slice(0, 10).map((mandate) => (
          <div className="sh-mrow" key={mandate.id}>
            <span className={`sh-tag ${mandate.status === 'draft' ? 'in'
              : mandate.status === 'rejected' ? 'bad' : 'ex'}`}>
              {MANDATE_STATUS[mandate.status]}
            </span>
            <span className="sh-scope">
              {mandate.scopeUndefined
                ? <em className="sh-warn">范围不足</em>
                : mandate.scope.level === 'asset'
                  ? `${mandate.scope.assets.length} 资产`
                  : `工作区级 ${mandate.scope.assetTypes.join('/')}`}
              {' · '}{mandate.scope.actions.length} 动作
              {' · '}风险≤{mandate.scope.riskCeiling}
              {' · '}{mandate.scope.maxWrites} 次写
            </span>
            <span className="sh-acts">
              {mandate.scope.actions.slice(0, 3).map((action) => (
                <span className="sh-tag" key={action}>{action}</span>
              ))}
              {mandate.scope.actions.length > 3
                ? <span className="sh-tag">+{mandate.scope.actions.length - 3}</span>
                : null}
            </span>

            {mandate.scopeUndefined ? (
              <span className="sh-narrow">
                <span className="sh-warn">范围不足：既没挂资产，规则也没给资产类型</span>
                <button className="btn" onClick={() => void data.review(mandate.id, 'rejected')}>否决</button>
              </span>
            ) : data.narrowing === mandate.id ? (
              <span className="sh-narrow">
                {mandate.scope.actions.map((action) => (
                  <button
                    key={action}
                    type="button"
                    className={`sh-chip${data.keptActions.includes(action) ? ' on' : ''}`}
                    onClick={() => data.setKeptActions((prev) => (
                      prev.includes(action) ? prev.filter((item) => item !== action) : [...prev, action]
                    ))}
                  >
                    {action}
                  </button>
                ))}
                <button className="btn p" onClick={() => void data.review(mandate.id, 'narrowed', data.keptActions)}>
                  保存收窄
                </button>
                <button className="btn" onClick={() => data.setNarrowing(null)}>取消</button>
              </span>
            ) : mandate.status === 'draft' ? (
              <span className="sh-narrow">
                <button className="btn p" onClick={() => void data.review(mandate.id, 'accepted')}>认可</button>
                <button
                  className="btn"
                  onClick={() => {
                    data.setNarrowing(mandate.id);
                    data.setKeptActions(mandate.scope.actions);
                  }}
                >
                  收窄
                </button>
                <button className="btn" onClick={() => void data.review(mandate.id, 'rejected')}>否决</button>
              </span>
            ) : (
              <span className="sh-meta">
                {timeOf(mandate.reviewedAt ?? '')}
                {mandate.note.startsWith('auto:') ? ' · 自动签发' : ''}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="sh-toolbar">
        <span className="sh-tname">决策账本</span>
        <span className="sh-meta">最近 {data.decisions.length} 条 · 展示 {rows.length} 条</span>
        <label className="sh-check">
          <input type="checkbox" checked={acceptOnly} onChange={(event) => setAcceptOnly(event.target.checked)} />
          只看本来会接
        </label>
        <span className="sh-meta sh-retention">留存 {status?.retentionDays ?? 30} 天</span>
        <button className="btn" onClick={() => void data.exportCsv()}>导出 CSV</button>
      </div>

      {rows.length === 0 ? (
        <div className="sh-empty">
          还没有决策。发一条消息（会自动进入账本），或点顶部「立即研判」。
        </div>
      ) : (
        <div className="sh-tbl">
          <table>
            <thead>
              <tr>
                <th style={{ width: 74 }}>时间</th>
                <th style={{ width: 78 }}>来源</th>
                <th style={{ width: 70 }}>强度</th>
                <th style={{ width: 72 }}>本来会接</th>
                <th style={{ width: 150 }}>被挡住的原因</th>
                <th style={{ width: 110 }}>命中规则</th>
                <th>输入</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((decision) => {
                const trigger = byTrigger.get(decision.triggerId);
                return (
                  <tr key={decision.id}>
                    <td className="sh-code">{timeOf(decision.createdAt)}</td>
                    <td>{SOURCE_LABEL[trigger?.sourceKind ?? ''] ?? trigger?.sourceKind ?? '—'}</td>
                    <td>
                      <span className={`sh-tag ${decision.strength === 'explicit' ? 'ex' : 'in'}`}>
                        {decision.strength}
                      </span>
                    </td>
                    <td>
                      {decision.wouldAccept
                        ? <span className="sh-ok">是</span>
                        : <span className="sh-no">—</span>}
                    </td>
                    <td title={decision.reason}>
                      {REASON_LABEL[decision.reasonCode] ?? decision.reasonCode}
                    </td>
                    <td>
                      {decision.matchedRules.length > 0
                        ? decision.matchedRules.map((id) => (
                          <span className="sh-tag" key={id}>
                            {(status?.policy.rules ?? []).find((rule) => rule.id === id)?.name ?? id}
                          </span>
                        ))
                        : <span className="sh-no">—</span>}
                    </td>
                    <td className="sh-body-clip" title={trigger?.body ?? ''}>
                      {trigger ? clip(trigger.body || `（${trigger.actor} 的系统事件）`) : '（事件已过期清理）'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {stats && stats.byReason.length > 0 ? (
        <div className="sh-panel sh-breakdown">
          <span className="sh-plabel">原因分布</span>
          <div className="sh-chips">
            {stats.byReason.map((item) => (
              <span className="sh-chip ghost" key={item.reasonCode} title={item.reasonCode}>
                {REASON_LABEL[item.reasonCode] ?? item.reasonCode}
                <span className="c">{item.count}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
