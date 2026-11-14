import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { downloadFile } from './ui';
import { api, type ViewName } from '../api/client';
import { useLiveData } from '../api/live';
import { AssetTypeIcon, ChatIcon, ProjectIcon, SearchIcon, TerminalIcon } from './icons';
interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint: string;
  /** 分组图标：会话 / 资产 / 项目 / 命令各一枚，扫读时先靠形状定位分组。 */
  icon: React.ReactNode;
  run: () => void;
}

/** ⌘K 命令面板：搜索会话 / 资产 / 项目 / 命令，回车执行跳转。 */
export default function CommandPalette(): React.ReactElement {
  const { state, setPalette, navigate, setConversation, setWorkspace, openBench, setArtifactPicker, setHelp, setModal, focusApproval, newConversation, setReadOnly, toggleLeft, toggleRight, addToast, addProject, setDetailTab, stopGeneration } =
    useStore();
  /* B2：审计列表由 REST 装配；B6：只读开关写服务端再同步本地状态。 */
  const { ORG_AUDIT } = useLiveData();
  const [query, setQuery] = useState<string>('');
  const [index, setIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /** B6：只读开关统一写 /api/settings/perm，再按 effective-policy 同步本地状态。 */
  const toggleReadOnlyRest = useCallback((): void => {
    const next = !state.readOnly;
    void api.updateSettings('perm', { readOnlyMode: next }).then((envelope) => {
      if (!envelope.ok) {
        addToast(`只读开关更新失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      void api.getEffectivePolicy().then((policy) => {
        setReadOnly(policy.ok ? policy.data.readOnlyMode : next);
        addToast(`只读模式已切换为${policy.ok ? (policy.data.readOnlyMode ? '开' : '关') : next ? '开' : '关'}`);
      });
    });
  }, [state.readOnly, setReadOnly, addToast]);

  const items = useMemo<PaletteItem[]>(() => {
    const result: PaletteItem[] = [];
    const project = state.projects.find((p) => p.id === state.workspaceId) ?? state.projects[0];
    const sidebar = project.sidebar;

    sidebar.convFolders.forEach((folder) =>
      folder.items.forEach((item) =>
        result.push({
          id: `conv-${item.id}`,
          group: '会话',
          label: item.title,
          hint: folder.name,
          icon: <ChatIcon size={13} strokeWidth={1.4} />,
          run: () => setConversation(item.id, item.title),
        }),
      ),
    );
    sidebar.looseConvs.forEach((item) =>
      result.push({
        id: `conv-${item.id}`,
        group: '会话',
        label: item.title,
        hint: '当前项目',
        icon: <ChatIcon size={13} strokeWidth={1.4} />,
        run: () => setConversation(item.id, item.title),
      }),
    );
    state.extraConversations.forEach((item) =>
      result.push({
        id: `conv-${item.id}`,
        group: '会话',
        label: item.title,
        hint: '新建',
        icon: <ChatIcon size={13} strokeWidth={1.4} />,
        run: () => setConversation(item.id, item.title),
      }),
    );

    const pushAsset = (id: string, name: string, go: string | undefined, folder: string): void => {
      result.push({
        id: `asset-${id}`,
        group: '资产',
        label: name,
        hint: folder,
        icon: <AssetTypeIcon type={go} size={13} strokeWidth={1.4} />,
        run: () => {
          if (go) navigate(`detail-${go}` as ViewName);
          else addToast(`${name}：检索型资产，暂无独立详情页`);
        },
      });
    };
    sidebar.assetFolders.forEach((folder) =>
      folder.items.forEach((asset) => pushAsset(asset.id, asset.name, asset.go, folder.name)),
    );
    sidebar.looseAssets.forEach((asset) => pushAsset(asset.id, asset.name, asset.go, '当前项目'));

    state.projects.forEach((projectItem) =>
      result.push({
        id: `pj-${projectItem.id}`,
        group: '项目',
        label: projectItem.name,
        icon: <ProjectIcon size={13} strokeWidth={1.4} />,
        hint: `索引 ${projectItem.index}% · ${projectItem.assetsLabel}`,
        run: () => setWorkspace(projectItem.id),
      }),
    );

    const commands: { label: string; hint: string; run: () => void }[] = [
      { label: '新建会话', hint: '⌘N', run: newConversation },
      { label: '项目概览', hint: '⌘O', run: () => navigate('projects') },
      { label: '系统设置', hint: '⌘,', run: () => navigate('settings') },
      { label: '智能体（工单 / 准入 / 账本）', hint: 'agent', run: () => navigate('shadow') },
      { label: '服务器终端', hint: 'detail-server', run: () => { navigate('detail-server'); setDetailTab('main'); } },
      { label: '数据库 SQL 查询', hint: 'detail-db', run: () => { navigate('detail-db'); setDetailTab('main'); } },
      { label: '代码库编辑器', hint: 'detail-code', run: () => { navigate('detail-code'); setDetailTab('main'); } },
      { label: '工作区 · 上下文', hint: 'tab', run: () => { navigate('chat'); openBench('ctx'); } },
      { label: '工作区 · 任务列表', hint: 'tab', run: () => { navigate('chat'); openBench('todo'); } },
      { label: '工作区 · 内置浏览器', hint: 'tab', run: () => { navigate('chat'); openBench('browser'); } },
      { label: '产物 · 选文件看详情', hint: '浮层', run: () => { navigate('chat'); setArtifactPicker(true); } },
      { label: '跳到待审批卡', hint: '', run: focusApproval },
      {
        label: '切换只读模式',
        hint: state.readOnly ? '当前：开' : '当前：关',
        run: toggleReadOnlyRest,
      },
      { label: '折叠 / 展开左栏', hint: '⌘B', run: toggleLeft },
      { label: '折叠 / 展开右栏', hint: '⌘\\', run: toggleRight },
      { label: '停止生成', hint: '⌘.', run: stopGeneration },
      { label: '快捷键速查', hint: '?', run: () => setHelp(true) },
      {
        label: '新建项目',
        hint: '',
        run: () =>
          setModal({
            kind: 'prompt',
            title: '新建项目',
            label: '输入项目名称：',
            placeholder: '例如：支付链路',
            confirmLabel: '创建',
            onSubmit: (value: string) => {
              /* B2：新建项目写 REST，成功 / 离线均保持本地即时反馈。 */
              void api.createWorkspace({ name: value, description: '新项目 · 尚未接入资产，索引准备中。' }).then((envelope) => {
                if (!envelope.ok) addToast(`新建项目失败：${envelope.error?.message ?? '未知错误'}`);
                else addToast(`已创建项目「${envelope.data.name}」· 服务端已落库`);
              });
              addProject(value);
              navigate('projects');
            },
          }),
      },
      {
        label: '导出审计 CSV',
        hint: '',
        run: () => {
          /* 服务端生成 CSV（含导出动作自身的审计留痕）。 */
          void api.exportAuditCsv({}).then((envelope) => {
            if (!envelope.ok) {
              addToast(`审计导出失败：${envelope.error?.message ?? '未知错误'}`);
              return;
            }
            downloadFile(envelope.data.fileName, envelope.data.content);
            addToast(`审计 CSV 已导出（${envelope.data.exported} 条）· 导出动作已记入审计`);
          });
        },
      },
      {
        label: '查看命令详情',
        hint: '审批卡',
        run: () => {
          /* 从当前会话的真实消息流里找最近的审批/建议卡，不再展示写死的演示命令。 */
          const thread = state.threads[state.activeConversationId] ?? [];
          const card = [...thread].reverse().find((m) => m.kind === 'approval' || m.kind === 'suggestion');
          if (!card || (card.kind !== 'approval' && card.kind !== 'suggestion')) {
            setModal({
              kind: 'info',
              title: '当前无待审批命令',
              body: '本会话还没有产生待审批或被拦截的命令。Agent 发起高风险写操作时，卡片会出现在会话流里。',
            });
            return;
          }
          setModal({
            kind: 'command',
            title: `命令详情 · ${card.kind === 'approval' ? '待审批' : '已拦截·建议'}`,
            command: card.cmd,
            body: card.kind === 'approval'
              ? '来源：Agent 发起 · 只读模式下不可执行，仅生成建议。可在会话中批准或拒绝。'
              : `来源：Agent 发起 · ${card.suggestion ?? '未执行任何写操作，磁盘零变更。'}`,
          });
        },
      },
    ];
    commands.forEach((command, idx) =>
      result.push({
        id: `cmd-${idx}`,
        group: '命令',
        label: command.label,
        hint: command.hint,
        icon: <TerminalIcon size={13} strokeWidth={1.4} />,
        run: command.run,
      }),
    );

    return result;
  }, [
    state.projects,
    state.workspaceId,
    state.extraConversations,
    state.readOnly,
    state.threads,
    state.activeConversationId,
    ORG_AUDIT,
    setConversation,
    navigate,
    addToast,
    setWorkspace,
    openBench,
    setArtifactPicker,
    setHelp,
    setModal,
    focusApproval,
    newConversation,
    toggleReadOnlyRest,
    toggleLeft,
    toggleRight,
    addProject,
    setDetailTab,
    stopGeneration,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => item.label.toLowerCase().includes(needle) || item.group.toLowerCase().includes(needle));
  }, [items, query]);

  useEffect(() => {
    if (state.paletteOpen) {
      setQuery('');
      setIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [state.paletteOpen]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!state.paletteOpen) {
    return <></>;
  }

  const execute = (position: number): void => {
    const item = filtered[position];
    if (!item) return;
    setPalette(false);
    item.run();
  };

  let lastGroup = '';

  return (
    <div className="ovl" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setPalette(false);
    }}>
      <div className="palette" onMouseDown={(event) => event.stopPropagation()}>
        <div className="pinput-wrap">
          <SearchIcon size={14} strokeWidth={1.5} className="pinput-ic" />
          <input
            className="pinput"
            ref={inputRef}
            value={query}
            placeholder="搜索会话 / 资产 / 项目 / 命令…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIndex((prev) => Math.min(filtered.length - 1, prev + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setIndex((prev) => Math.max(0, prev - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                execute(index);
              }
            }}
          />
        </div>
        <div className="plist">
          {filtered.length === 0 ? <div className="pempty">没有匹配结果</div> : null}
          {filtered.map((item, position) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <React.Fragment key={item.id}>
                {showGroup ? <div className="pgroup">{item.group}</div> : null}
                <div
                  className={`pitem${position === index ? ' on' : ''}`}
                  onMouseEnter={() => setIndex(position)}
                  onClick={() => execute(position)}
                >
                  <span className="pitem-ic">{item.icon}</span>
                  <span>{item.label}</span>
                  {item.hint ? <span className="ph2">{item.hint}</span> : null}
                </div>
              </React.Fragment>
            );
          })}
        </div>
        <div className="pfoot">↑↓ 选择 · ↵ 执行 · Esc 关闭 · 共 {filtered.length} 项</div>
      </div>
    </div>
  );
}
