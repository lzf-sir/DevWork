import React from 'react';
import { useStore } from '../store';
import { useLiveData } from '../api/live';

/** `?` 快捷键速查浮层：与命令面板同一套轻量样式。 */
export default function ShortcutHelp(): React.ReactElement {
  const { state, setHelp } = useStore();
  /* B2：快捷键清单一律走 REST 装配层（离线时回落 fallback 快照）。 */
  const { SHORTCUTS } = useLiveData();
  if (!state.helpOpen) {
    return <></>;
  }
  return (
    <div className="ovl" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setHelp(false);
    }}>
      <div className="help" onMouseDown={(event) => event.stopPropagation()}>
        <h3>快捷键速查（Windows 用 Ctrl 兼容）</h3>
        {SHORTCUTS.map((item) => (
          <div className="hrow" key={item.key}>
            <span className="hk">{item.key}</span>
            <span className="hd">{item.desc}</span>
          </div>
        ))}
        <div className="mfoot" style={{ marginTop: 12 }}>
          <button className="btn p" onClick={() => setHelp(false)}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
