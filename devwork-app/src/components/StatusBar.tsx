import React from 'react';
import { useStore } from '../store';
import { ChartIcon, ModelIcon } from './icons';

/** 状态栏：30px。模型、上下文占用、本会话费用、就绪状态。 */
export default function StatusBar(): React.ReactElement {
  const { state } = useStore();
  return (
    /* data-api-mode 供桌面端 CDP 自动化无歧义断言真实 apiMode（不改变任何视觉）。 */
    <div className="sbar" data-api-mode={state.apiMode} data-status={state.statusText}>
      <span className="sitem">
        <span className="sic">
          <ModelIcon size={12} strokeWidth={1.4} />
        </span>
        模型 {state.model}
      </span>
      <span className="sitem">
        <span className="sic">
          <ChartIcon size={12} strokeWidth={1.4} />
        </span>
        上下文 {state.ctxTokens}k/200k
      </span>
      <span>本会话 ¥{state.cost.toFixed(2)}</span>
      {state.statusNote ? <span>{state.statusNote}</span> : null}
      <span className="r">
        <span>{state.apiMode === 'live' ? 'REST 已连接' : '离线 Mock'}</span>
        <span>
          <span className="dotok" />
          {state.statusText}
        </span>
      </span>
    </div>
  );
}
