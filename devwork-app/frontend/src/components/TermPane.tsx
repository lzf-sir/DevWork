/**
 * 终端（原右栏工作台的「终端」Tab）。
 *
 * 与「服务器详情」页的终端同源：都走服务端 PermissionKernel + CommandExecutor，
 * 前端只展示 allow / deny / suggest 三种裁决结果，不在前端猜权限。
 *
 * **当前没有入口挂它**：会话右缘的入口收敛成四个固定图标
 * （上下文 / 任务列表 / 产物 / 浏览器），终端不在其中。
 * 组件保留完整实现，等需要时从入口坞或命令面板接回来即可。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { api, type TermLine } from '../api/client';
import { useAssetCandidates } from '../hooks/useChatSession';
import { TerminalIcon } from './icons';

export default function TermPane(): React.ReactElement {
  const { state, addToast } = useStore();
  /* 资产候选按当前工作区取 —— 写死 w-ops 会把别的工作区的资产混进来。 */
  const assets = useAssetCandidates(state.workspaceId);
  /** 服务器类资产（终端只对服务器资产有效）。 */
  const servers = assets.filter((asset) => asset.type === 'server');
  const firstServerId = servers[0]?.id ?? '';
  const [assetId, setAssetId] = useState<string>('');
  const [sessionId, setSessionId] = useState<string>('');
  const [command, setCommand] = useState<string>('');
  const [lines, setLines] = useState<TermLine[]>([
    { cls: 'dm', text: '# 终端就绪 · 只读白名单内的命令可直接执行' },
    { text: '' },
  ]);
  const [busy, setBusy] = useState<boolean>(false);
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  /* 候选列表是异步回来的：拿到后把选中项对齐到真实服务器资产。 */
  useEffect(() => {
    if (!firstServerId) return;
    setAssetId(firstServerId);
  }, [firstServerId]);

  /* 会话列表：取最近一个；没有就新建一个。 */
  useEffect(() => {
    if (!assetId) return;
    let alive = true;
    void api.listTerminalSessions(assetId).then((envelope) => {
      if (!alive || !envelope.ok || !Array.isArray(envelope.data)) return;
      const last = envelope.data[envelope.data.length - 1];
      if (last?.id) {
        setSessionId(last.id);
        return;
      }
      void api.createTerminalSession(assetId).then((created) => {
        if (alive && created.ok) setSessionId(created.data.id);
      });
    });
    return () => {
      alive = false;
    };
  }, [assetId]);

  const run = (): void => {
    const value = command.trim();
    if (!value || !sessionId || busy) return;
    setBusy(true);
    setCommand('');
    setLines((prev) => [...prev, { cls: 'pr', text: `$ ${value}` }]);
    void api
      .executeCommand(assetId, { sessionId, command: value })
      .then((envelope) => {
        if (!envelope.ok) {
          setLines((prev) => [...prev, { cls: 'er', text: `✕ ${envelope.error?.message ?? '执行失败'}` }, { text: '' }]);
          return;
        }
        const result = envelope.data;
        const stdout = String(result.stdout ?? '');
        const output: TermLine[] = stdout
          .split('\n')
          .map((line) => (result.executed ? { text: line } : { cls: 'er', text: line }));
        const stderr = String(result.stderr ?? '').trim();
        if (stderr) output.push({ cls: 'er', text: stderr });
        if (!result.executed) {
          output.push({
            cls: 'dm',
            text: `  未执行（${result.decision}）：${result.reasonCode ?? 'E_POLICY'} · 只读模式下仅允许白名单命令`,
          });
        } else {
          output.push({ cls: 'dm', text: `  exit=${result.exitCode} · ${result.durationMs}ms` });
        }
        setLines((prev) => [...prev, ...output, { text: '' }]);
      })
      .catch(() => {
        setLines((prev) => [...prev, { cls: 'er', text: '✕ 网络异常，命令未送达服务端' }, { text: '' }]);
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="trmp">
      <div className="trmp-bar">
        <select
          className="trmp-sel"
          value={assetId}
          onChange={(event) => setAssetId(event.target.value)}
          aria-label="选择服务器资产"
        >
          {servers.length === 0 ? <option value={assetId}>order-api-01</option> : null}
          {servers.map((asset) => (
            <option key={asset.id} value={asset.id}>{asset.label}</option>
          ))}
        </select>
        <span className="trmp-sid" title={sessionId}>会话 {sessionId || '—'}</span>
        <button
          className="brp-nav"
          type="button"
          title="新建终端会话"
          aria-label="新建终端会话"
          onClick={() => {
            void api.createTerminalSession(assetId).then((envelope) => {
              if (!envelope.ok) {
                addToast('新建会话被拒：最多 5 个会话');
                return;
              }
              setSessionId(envelope.data.id);
              setLines((prev) => [...prev, { cls: 'dm', text: `# 已新建终端会话 ${envelope.data.id}` }, { text: '' }]);
            });
          }}
        >
          <TerminalIcon size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div className="trmp-out" ref={termRef}>
        {lines.map((line, index) => (
          <div className={`trmp-line${line.cls ? ` ${line.cls}` : ''}`} key={`${index}-${line.text.slice(0, 12)}`}>
            {line.text || '\u00a0'}
          </div>
        ))}
      </div>

      <div className="trmp-in">
        <input
          className="trmp-input"
          value={command}
          placeholder={sessionId ? '输入命令，回车执行' : '终端会话初始化中…'}
          disabled={!sessionId || busy}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') run();
          }}
        />
        <button className="trmp-run" type="button" disabled={!sessionId || busy} onClick={run}>
          {busy ? '…' : '执行'}
        </button>
      </div>
    </div>
  );
}
