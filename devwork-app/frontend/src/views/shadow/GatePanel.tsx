/**
 * 准入分区：所有「谁能让它干活、它能动多大范围」的旋钮。
 *
 * 这一屏改的每一个开关都会直接影响**下一次**决策，所以每项都带一句
 * 「改它会怎样」的说明 —— 不是装饰，是因为这些开关的语义不直观：
 * 关掉一个源，看起来只是少了一类事件，实际是少了一条它能主动发现问题的路径。
 */
import React from 'react';
import {
  MODES,
  SCHEDULE_PRESETS,
  SOURCE_LABEL,
  formatWhen,
} from './labels';
import type { ShadowData } from './useShadowData';

export default function GatePanel({ data }: { data: ShadowData }): React.ReactElement {
  const status = data.status;
  const policy = status?.policy;
  const scheduleSource = status?.sources.find((item) => item.kind === 'schedule');

  const scheduleValue = (() => {
    const config = scheduleSource?.schedule;
    if (!config) return SCHEDULE_PRESETS[0].value;
    if (config.schedule === 'interval') return `interval:${config.everyMinutes ?? 60}`;
    return `daily:${config.at ?? '09:30'}`;
  })();
  /* 库里的值可能不在预设里（通过 API 改过）——补一个选项，别让 select 显示空。 */
  const presetOptions = SCHEDULE_PRESETS.map((item) => ({ value: item.value, label: item.label }));
  const scheduleOptions = presetOptions.some((item) => item.value === scheduleValue)
    ? presetOptions
    : [
      {
        value: scheduleValue,
        label: scheduleValue.startsWith('interval:')
          ? `每 ${scheduleValue.slice('interval:'.length)} 分钟`
          : `每天 ${scheduleValue.slice('daily:'.length)}`,
      },
      ...presetOptions,
    ];

  const auto = data.stats?.auto;
  const autoMax = policy?.autoMaxPerHour ?? 0;
  const autoUsed = auto?.issuedLastHour ?? 0;

  return (
    <>
      <div className="sh-panel">
        <span className="sh-plabel">准入模式</span>
        <div className="sh-seg">
          {MODES.map((mode) => (
            <button
              key={mode.value}
              type="button"
              title={mode.hint}
              className={policy?.acceptMode === mode.value ? 'on' : ''}
              onClick={() => void data.setMode(mode.value)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <span className="sh-meta">策略 {policy?.policyVersion ?? '—'}</span>

        {/* 只有真的开了 auto，刹车才有意义 —— 平时不占版面。 */}
        {policy?.acceptMode === 'auto' ? (
          <>
            <span className="sh-vline" />
            <span className="sh-plabel">每小时最多签</span>
            <select
              className="sh-rate"
              value={autoMax}
              onChange={(event) => void data.setAuto({ autoMaxPerHour: Number(event.target.value) })}
            >
              {[0, 1, 3, 5, 10].map((value) => (
                <option key={value} value={value}>{value === 0 ? '不自动签' : `${value} 份`}</option>
              ))}
            </select>
            <label className="sh-check sh-auto-write" title="默认关闭：auto 只自动接只读的活">
              <input
                type="checkbox"
                checked={policy.autoAllowWrites}
                onChange={(event) => void data.setAuto({ autoAllowWrites: event.target.checked })}
              />
              允许自动签写权限
            </label>
            {autoMax === 0 ? (
              <span className="sh-warn">已关自动签发：auto 退化成 observe，仍需人批</span>
            ) : null}
            {policy.autoAllowWrites ? (
              <span className="sh-warn">写操作也会被自动授权，慎用</span>
            ) : null}
          </>
        ) : null}
      </div>

      {policy?.acceptMode === 'auto' ? (
        <div className="sh-panel sh-autobar">
          <span className="sh-plabel">本小时自动签发</span>
          <span className="sh-gauge">
            {Array.from({ length: Math.max(autoMax, 1) }).map((_, index) => (
              <i key={index} className={`seg${index < autoUsed ? ' on' : ''}`} />
            ))}
          </span>
          <span className="sh-meta">
            {autoUsed} / {autoMax} 份 · 剩余 {auto?.budgetLeft ?? 0}
          </span>
          {autoMax > 0 && autoUsed >= autoMax ? (
            <span className="sh-warn">预算已用尽，本小时剩余事件只产草案，等人批</span>
          ) : null}
        </div>
      ) : null}

      {/* 授权名单：Gate 判的就是「谁能发起」。这里能改，等于授权真的在人的手里。 */}
      <div className="sh-panel sh-auth">
        <span className="sh-plabel">白名单</span>
        <div className="sh-chips">
          {(policy?.allowedActors ?? []).map((name) => (
            <span className="sh-chip on" key={name} title="移除这个人">
              {name}
              <button
                type="button"
                className="sh-x"
                aria-label={`移除 ${name}`}
                onClick={() => data.removeFrom('allowedActors', name)}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="sh-chip add" onClick={() => data.promptAdd('allowedActors')}>
            + 添加人
          </button>
        </div>
        {policy && policy.allowedActors.length === 0
          ? <span className="sh-warn">白名单为空：谁都不能让它干活</span>
          : null}

        <span className="sh-vline" />

        <span className="sh-plabel">机器人</span>
        <div className="sh-chips">
          {(policy?.allowedBots ?? []).map((name) => (
            <span className="sh-chip on" key={name} title="移除这个机器人">
              {name}
              <button
                type="button"
                className="sh-x"
                aria-label={`移除 ${name}`}
                onClick={() => data.removeFrom('allowedBots', name)}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="sh-chip add" onClick={() => data.promptAdd('allowedBots')}>
            + 添加机器人
          </button>
        </div>

        <span className="sh-vline" />

        <span className="sh-plabel">每小时上限</span>
        <select
          className="sh-rate"
          value={policy?.threadRatePerHour ?? 1}
          onChange={(event) => void data.setRate(Number(event.target.value))}
        >
          {[1, 2, 3, 5].map((value) => (
            <option key={value} value={value}>{value} 次/线程</option>
          ))}
        </select>
        <span className="sh-meta">只约束自动化事件；人不受限</span>
      </div>

      <div className="sh-panel sh-sources">
        <span className="sh-plabel">事件源</span>
        <div className="sh-chips">
          {(status?.sources ?? []).map((source) => (
            <button
              key={source.kind}
              type="button"
              className={`sh-chip${source.enabled ? ' on' : ''}`}
              title={`${SOURCE_LABEL[source.kind] ?? source.kind} · 已收 ${source.triggers} 条`}
              onClick={() => void data.toggleSource(source.kind, !source.enabled)}
            >
              <i className="dot" />
              {SOURCE_LABEL[source.kind] ?? source.kind}
              <span className="c">{source.triggers}</span>
            </button>
          ))}
        </div>
        {status && !status.enabled ? <span className="sh-warn">已关停（DEVWORK_SUPERAGENT=off）</span> : null}
      </div>

      {scheduleSource ? (
        <div className="sh-panel sh-schedule">
          <span className="sh-plabel">定时巡检</span>
          <select
            value={scheduleValue}
            onChange={(event) => void data.applySchedule(event.target.value)}
          >
            {scheduleOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <span className="sh-meta">
            {scheduleSource.enabled ? `下次 ${formatWhen(scheduleSource.nextFireAt)}` : '未启用（开关在上方「定时巡检」chip）'}
          </span>
          <button className="btn" onClick={() => void data.fireNow()} disabled={data.firing || !scheduleSource.enabled}>
            {data.firing ? '投递中…' : '立即巡检'}
          </button>
          <span className="sh-meta">手动跑一次不改变下次到点时间</span>
        </div>
      ) : null}

      <div className="sh-panel sh-rules">
        <span className="sh-plabel">规则</span>
        <div className="sh-chips">
          {(policy?.rules ?? []).map((rule) => (
            <button
              key={rule.id}
              type="button"
              className={`sh-chip${rule.enabled ? ' on' : ''}`}
              title={`${rule.keywords.join(' / ') || '不看关键词'}\n命中即给出：${rule.scope?.actions.join('、') || '（无范围，不会签授权）'}`}
              onClick={() => void data.toggleRule(rule.id)}
            >
              <i className="dot" />
              {rule.name}
            </button>
          ))}
        </div>
        <span className="sh-meta">点一下启停；停用的规则不参与「值不值得接」的判断</span>
      </div>

      {/* 规则愿意给多大范围 —— 这是授权算不算得出来的唯一来源，必须能看见。 */}
      <div className="sh-panel sh-rulescope">
        <div className="sh-mhead">
          <span className="sh-tname">规则给出的范围</span>
          <span className="sh-meta">命中这条规则时，最多允许动多大</span>
        </div>
        {(policy?.rules ?? []).length === 0 ? (
          <div className="sh-meta">没有规则：任何事件都不会被接。</div>
        ) : null}
        {(policy?.rules ?? []).map((rule) => (
          <div className="sh-rrow" key={rule.id}>
            <span className={`sh-tag ${rule.enabled ? 'ex' : ''}`}>{rule.name}</span>
            <span className="sh-meta">
              {rule.scope
                ? `${rule.scope.actions.length} 动作 · 风险≤${rule.scope.riskCeiling ?? 'low'} · ${rule.scope.maxWrites ?? 0} 次写`
                : '未声明范围（命中也不会签授权）'}
            </span>
            <span className="sh-acts">
              {(rule.scope?.actions ?? []).slice(0, 4).map((action) => (
                <span className="sh-tag" key={action}>{action}</span>
              ))}
              {(rule.scope?.actions.length ?? 0) > 4
                ? <span className="sh-tag">+{(rule.scope?.actions.length ?? 0) - 4}</span>
                : null}
            </span>
            <span className="sh-meta">资产类型 {(rule.assetTypes ?? []).join('/') || '不限'}</span>
          </div>
        ))}
      </div>
    </>
  );
}
