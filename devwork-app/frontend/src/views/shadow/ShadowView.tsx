/**
 * 智能体工作台。
 *
 * 三个分区，回答三个不同的问题：
 *   工单 —— 它现在在干什么？我该做什么？（待人排最前）
 *   准入 —— 谁能让它干活、它能动多大范围？
 *   账本 —— 它为什么接 / 为什么不接？
 *
 * 为什么不再是一整页长列表：P1 时这一页只有一个问题（本来会接哪些单），
 * 一屏拉到底正好。P3 之后它同时是执行台和策略台，混在一页的代价是
 * 「待人」这种需要立刻看见的东西被压在第 8 个面板下面。
 */
import React from 'react';
import { useStore } from '../../store';
import { ChartIcon, PlayIcon, RefreshIcon } from '../../components/icons';
import { useShadowData } from './useShadowData';
import TicketsPanel from './TicketsPanel';
import GatePanel from './GatePanel';
import LedgerPanel from './LedgerPanel';

type Tab = 'tickets' | 'gate' | 'ledger';

export default function ShadowView(): React.ReactElement {
  const { state } = useStore();
  const data = useShadowData();
  const [tab, setTab] = React.useState<Tab>('tickets');

  const waiting = data.ticketStats?.waitingHuman ?? 0;
  const drafts = data.mandates.filter((item) => item.status === 'draft').length;

  const tabs: { value: Tab; label: string; badge: number; hint: string }[] = [
    { value: 'tickets', label: '工单', badge: waiting, hint: '在跑的单与等你处理的单' },
    { value: 'gate', label: '准入', badge: 0, hint: '模式、白名单、事件源、规则' },
    { value: 'ledger', label: '账本', badge: drafts, hint: '授权草案与决策记录' },
  ];

  return (
    <div className={`view${state.view === 'shadow' ? ' on' : ''}`} data-view="shadow">
      <div className="chead">
        <ChartIcon size={13} strokeWidth={1.5} className="sh-title-ic" />
        <div className="ctitle">智能体</div>
        <div className="sh-tabs" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              title={item.hint}
              className={`sh-tab${tab === item.value ? ' on' : ''}`}
              onClick={() => setTab(item.value)}
            >
              {item.label}
              {item.badge > 0 ? <span className="sh-badge">{item.badge}</span> : null}
            </button>
          ))}
        </div>
        <div className="acts">
          <button
            className={`btn${data.status?.enabled === false ? '' : ' p'}`}
            title="总开关：关停后两个循环只空转，不读不写"
            onClick={() => void data.toggleEnabled()}
          >
            {data.status?.enabled === false ? '已关停' : '运行中'}
          </button>
          <button className="btn" onClick={() => void data.runTick()} disabled={data.ticking}>
            <PlayIcon size={12} strokeWidth={1.6} />
            {data.ticking ? '研判中…' : '立即研判'}
          </button>
          <button className="btn" onClick={() => void data.load()} disabled={data.loading}>
            <RefreshIcon size={12} strokeWidth={1.6} />
            {data.loading ? '读取中…' : '刷新'}
          </button>
        </div>
      </div>

      <div className="sh-body">
        {tab === 'tickets' ? <TicketsPanel data={data} /> : null}
        {tab === 'gate' ? <GatePanel data={data} /> : null}
        {tab === 'ledger' ? <LedgerPanel data={data} /> : null}

        <div className="sh-foot">
          {tab === 'tickets'
            ? '工单会真的动手：只在授权范围内调工具、写操作仍逐次审批。待人的单排在最上面。'
            : tab === 'gate'
              ? '这一屏改的是「下一次决策的依据」。改完立即生效，不需要重启；策略版本会自增。'
              : '账本只记录、不执行。同一条事件的「为什么没接」和「接了能拿到多大范围」在这里对照看。'}
        </div>
      </div>
    </div>
  );
}
