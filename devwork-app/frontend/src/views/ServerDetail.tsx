import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { api, type TermLine } from '../api/client';
import { useLiveData, useLiveRefresh } from '../api/live';
import { Banner, DetailHeader, DetailTabs, GearSvg, KV, MetricGrid, Pill } from '../components/ui';
import { ChatIcon, DotsIcon, ServerIcon } from '../components/icons';
import AssetConfigDrawer from '../components/AssetConfigDrawer';

const TABS = [
  { id: 'main', label: '终端' },
];

/** 服务器详情：默认落在终端主功能区；能力授权 / 资产信息收进右侧配置抽屉。 */
export default function ServerDetail(): React.ReactElement {
  const { state, setDetailTab, setModal, addToast, setConfigOpen, openAssetChat } = useStore();
  const refresh = useLiveRefresh();
  /* B2：指标 / KV / 活动 / 能力 / 终端历史 / 黑白名单全部由 REST 装配层提供。 */
  const {
    CAPS_SERVER,
    COMMAND_BLACKLIST,
    COMMAND_WHITELIST,
    SERVER_ACTIVITY_KV,
    SERVER_CONN_KV,
    SERVER_METRICS,
    TERMINAL_HISTORY,
    TERMINAL_INITIAL,
  } = useLiveData();
  const [sessionCount, setSessionCount] = useState<number>(1);
  /** B21：当前终端会话 ID —— 列表取最近一个，新建后切换；执行命令不再写死 sess-1。 */
  const [sessionId, setSessionId] = useState<string>('sess-1');
  const [lines, setLines] = useState<TermLine[]>(TERMINAL_INITIAL);
  const [command, setCommand] = useState<string>('');
  const [history, setHistory] = useState<string[]>(TERMINAL_HISTORY);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const termRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** ⋯ 菜单（重命名 / 新建终端 / 断开当前会话）。 */
  const [menuOpen, setMenuOpen] = useState<boolean>(false);

  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    if (!state.hotkey || state.hotkey.kind !== 'clearTerm') return;
    if (state.view !== 'detail-server' || state.detailTab !== 'main') return;
    setLines([{ cls: 'dm', text: '# 终端已清屏 · 命令历史仍可用 ↑↓ 翻阅' }, { text: '' }]);
    addToast('终端已清屏（⌘L / Ctrl+L）');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hotkey]);

  /* B14：审批/建议卡「复制并去终端」把命令经 termPreset 送达这里，预填输入框。 */
  useEffect(() => {
    if (!state.termPreset) return;
    setCommand(state.termPreset);
    setDetailTab('main');
    addToast(`命令已粘贴到终端输入框：${state.termPreset}`);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.termPreset]);

  /* B2：会话数来自 GET /api/assets/:id/terminal/sessions（服务端上限 5）。 */
  useEffect(() => {
    let alive = true;
    void api.listTerminalSessions('a-order-api').then((envelope) => {
      if (alive && envelope.ok && Array.isArray(envelope.data)) {
        setSessionCount(Math.max(1, envelope.data.length));
        const last = envelope.data[envelope.data.length - 1];
        if (last?.id) setSessionId(last.id);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  /** B2/B4：新建会话走 POST，超过上限由服务端返回 409 E_TERMINAL_SESSION_LIMIT。 */
  const createSession = (): void => {
    setDetailTab('main');
    void api.createTerminalSession('a-order-api').then((envelope) => {
      if (!envelope.ok) {
        setLines((prev) => [
          ...prev,
          { cls: 'er', text: `✕ 新建会话被拒：${envelope.error?.code ?? 'E_TERMINAL_SESSION_LIMIT'} · 最多 5 个会话` },
          { text: '' },
        ]);
        addToast('终端会话已达上限 5 个');
        return;
      }
      void api.listTerminalSessions('a-order-api').then((listed) => {
        if (listed.ok && Array.isArray(listed.data)) setSessionCount(Math.max(1, listed.data.length));
      });
      setSessionId(envelope.data.id);
      setLines((prev) => [...prev, { cls: 'dm', text: `# 已新建终端会话 ${envelope.data.id} · 沿用只读白名单` }, { text: '' }]);
      addToast('新建终端 · 会话已创建');
    });
  };

  const appendResult = (prompt: TermLine, linesToAppend: TermLine[]): void => {
    setLines((prev) => [...prev, prompt, ...linesToAppend, { text: '' }]);
  };

  const runCommand = (raw: string): void => {
    const value = raw.trim();
    if (!value) return;
    setHistory((prev) => [...prev, value]);
    setHistoryIndex(-1);
    setCommand('');
    const prompt: TermLine = { cls: 'pr', text: `deploy@order-api-01:~$ ${value}` };

    // 裁决由服务端 PermissionKernel + CommandExecutor 完成；前端只展示 allow / deny / suggest。
    void api
      .executeCommand('a-order-api', { sessionId, command: value })
      .then((envelope) => {
        if (!envelope.ok) {
          appendResult(prompt, [{ cls: 'er', text: `✕ ${envelope.error?.message ?? '执行失败'}` }]);
          return;
        }
        const result = envelope.data;
        const stdout = String(result.stdout ?? '');
        const output: TermLine[] = stdout
          .split('\n')
          .map((line) => (result.executed ? { text: line } : { cls: 'er', text: line }));
        if (!result.executed) {
          output.push({
            cls: 'dm',
            text: '  只读模式下仅允许白名单命令。如需清理日志，请在会话中描述需求，由 Agent 生成建议命令。',
          });
          addToast('✕ 已拦截危险命令 · 未发送到远端');
        } else if (result.degraded) {
          addToast('命令已降级执行（工具缺失，已返回 127）');
        }
        if (result.stderr) output.push({ cls: 'dm', text: String(result.stderr) });
        appendResult(prompt, output);
      })
      .catch(() => {
        // 极端情况下的本地兜底，保证终端永远有反馈。
        const lower = value.toLowerCase();
        const denied = COMMAND_BLACKLIST.find((item) => lower.includes(item.pattern));
        if (denied) {
          appendResult(prompt, [
            { cls: 'er', text: `✕ 已拦截：危险命令（${denied.label} 命中黑名单）· 未发送到远端` },
            { cls: 'dm', text: '  只读模式下仅允许白名单命令。如需清理日志，请在会话中描述需求，由 Agent 生成建议命令。' },
          ]);
          return;
        }
        const allowed = COMMAND_WHITELIST.find((item) => lower.startsWith(item.prefix));
        appendResult(prompt, allowed ? allowed.output : [{ cls: 'er', text: '✕ 已拦截：命令不在白名单（42 条）· 未发送到远端' }]);
      });
  };

  /** ⋯ 菜单：重命名资产（PATCH /assets/:id）与断开当前会话（DELETE terminal session）。 */
  const renameAsset = (): void => {
    setModal({
      kind: 'prompt',
      title: '重命名资产 · order-api-01',
      label: '新的资产名称：',
      placeholder: 'order-api-01',
      confirmLabel: '保存',
      onSubmit: (value: string) => {
        if (!value.trim()) {
          addToast('名称不能为空');
          return;
        }
        void api.updateAsset('a-order-api', { name: value.trim() }).then((envelope) => {
          addToast(envelope.ok ? '资产已重命名' : `重命名失败：${envelope.error?.message ?? '未知错误'}`);
          refresh();
        });
      },
    });
  };
  const disconnectSession = (): void => {
    void api.closeTerminalSession('a-order-api', sessionId).then((envelope) => {
      if (!envelope.ok) {
        addToast(`断开失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      setLines((prev) => [...prev, { cls: 'dm', text: `# 会话 ${sessionId} 已断开` }, { text: '' }]);
      addToast(`终端会话 ${sessionId} 已断开`);
      void api.listTerminalSessions('a-order-api').then((listed) => {
        if (listed.ok && Array.isArray(listed.data)) {
          setSessionCount(Math.max(1, listed.data.length));
          const last = listed.data[listed.data.length - 1];
          if (last?.id) setSessionId(last.id);
        }
      });
    });
  };

  return (
    <div className={`view${state.view === 'detail-server' ? ' on' : ''}`} data-view="detail-server">
      <DetailHeader
        icon={<ServerIcon size={15} strokeWidth={1.4} />}
        name="order-api-01"
        sub="SSH · deploy@10.20.1.31 · /opt/app"
        pills={
          <>
            <Pill tone="ok">
              <span className="sdot" />
              在线
            </Pill>
            <Pill tone="ro">只读</Pill>
          </>
        }
        actions={
          <>
            <button
              className="btn p"
              onClick={() =>
                openAssetChat({ assetId: 'a-order-api', assetName: 'order-api-01', assetType: 'server' })
              }
              title="在当前页面唤起一条绑定该服务器的 AI 会话"
            >
              <ChatIcon size={13} strokeWidth={1.4} />
              AI 会话
            </button>
            <button className="btn p" onClick={createSession}>
              新建终端
            </button>
            <button
              className="dcfg"
              type="button"
              title="资产配置（能力授权 / 资产信息）"
              aria-label="资产配置"
              onClick={() => setConfigOpen(true)}
            >
              <GearSvg />
            </button>
            <div className="amore" onClick={() => setMenuOpen((value) => !value)}>
              <DotsIcon size={14} />
            </div>
            {menuOpen ? (
              <div className="cmenu" onMouseLeave={() => setMenuOpen(false)}>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); renameAsset(); }}>重命名资产</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); createSession(); }}>新建终端会话</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); disconnectSession(); }}>断开当前会话</div>
              </div>
            ) : null}
          </>
        }
      />
      <DetailTabs tabs={TABS} active={state.detailTab} onChange={setDetailTab} />

      <div className={`dbody${state.detailTab === 'main' ? ' on' : ''}`} data-dt="main">
        <Banner>
          {state.readOnly
            ? '只读模式：仅放行 42 条只读命令白名单，其余命令在本地拦截、不发送到远端'
            : '只读已关闭：Agent 可提议执行命令；你的输入仍按白名单本地校验，危险命令依旧拦截'}
        </Banner>
        <div className="term" ref={termRef} onClick={() => inputRef.current?.focus()}>
          {lines.map((line, index) => (
            <div className={`termline${line.cls ? ` ${line.cls}` : ''}`} key={index}>
              {line.text}
            </div>
          ))}
          <div className="termline termin">
            <span className="pr">deploy@order-api-01:~$</span>
            {' '}
            <input
              ref={inputRef}
              className="terminput"
              value={command}
              placeholder=""
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  runCommand(command);
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  if (history.length === 0) return;
                  const next = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
                  setHistoryIndex(next);
                  setCommand(history[next]);
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  if (historyIndex < 0) return;
                  const next = historyIndex + 1;
                  if (next >= history.length) {
                    setHistoryIndex(-1);
                    setCommand('');
                  } else {
                    setHistoryIndex(next);
                    setCommand(history[next]);
                  }
                }
              }}
            />
          </div>
        </div>
        <div className="termbar">
          <span>
            <span className="sdot" /> 本地沙箱 · 白名单终端
          </span>
          <span>会话 {sessionId} · {sessionCount}/5</span>
          <span className="sr">
            <span>↑↓ 历史</span>
            <span>⌘L 清屏</span>
            <span>⌘K 命令面板</span>
          </span>
        </div>
      </div>

      <AssetConfigDrawer
        open={state.configOpen && state.view === 'detail-server'}
        title="order-api-01"
        sub="SSH · deploy@10.20.1.31 · /opt/app"
        caps={CAPS_SERVER}
        assetId="a-order-api"
        readOnly={state.readOnly}
        metrics={SERVER_METRICS}
        kv={SERVER_CONN_KV.map((row) => ({ k: row.k, v: row.v }))}
        activity={SERVER_ACTIVITY_KV.map((row) => ({ k: row.k, v: row.v }))}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  );
}