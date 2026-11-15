import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { useLiveData } from '../api/live';
import { useAssetTarget } from '../hooks/useAssetTarget';
import { Banner, DetailHeader, DetailTabs, GearSvg, Pill } from '../components/ui';
import { CaretIcon, ChatIcon, CloseIcon, CodeIcon, DotsIcon, FolderIcon, FileTypeIcon } from '../components/icons';
import AssetConfigDrawer from '../components/AssetConfigDrawer';
import { highlight, markAll } from '../utils/highlight';
import type { RepoStatus } from '../api/types';

const TABS = [
  { id: 'main', label: '编辑器' },
];

/** 树节点（mock 与 live 装配形状对齐：file 为空串/null 表示目录）。 */
type TreeNode = { label: string; depth: number; caret: string; path: string | null };

/** 代码库详情：默认落在编辑器主功能区；能力授权 / 仓库信息收进右侧配置抽屉。 */
export default function CodeDetail(): React.ReactElement {
  const { state, setDetailTab, addToast, setModal, consumeSource, setConfigOpen, openAssetChat, openAssetForm } = useStore();
  /* B2：指标 / KV / 活动 / 能力 / 文件树 / diff / patch 全部由 REST 装配层提供。 */
  const {
    CAPS_CODE,
    CODE_ACTIVITY_KV,
    CODE_DIFF,
    CODE_FILES,
    CODE_METRICS,
    CODE_PATCH,
    CODE_REPO_KV,
    CODE_TREE,
  } = useLiveData();
  const [activePath, setActivePath] = useState<string>('src/main/java/order/InventoryClient.java');
  const [modified, setModified] = useState<boolean>(true);
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 42, col: 31 });
  /** B18：编辑态标记 —— 一旦输入就不再重放高亮（DOM 为准），保光标稳定。 */
  const [edited, setEdited] = useState<boolean>(false);
  /** B2：当前文件内容优先 /api/.../files/content，离线时回落 REST 装配的文件表。 */
  const [liveContent, setLiveContent] = useState<Record<string, string>>({});
  /** B18：大纲 / 引用 / per-file git 来自服务端真实扫描。 */
  const [outline, setOutline] = useState<{ symbols: { sg: string; label: string; line?: number }[]; references: string[]; git: string[] } | null>(null);
  /** B18：仓库分支（git 真查），离线回落静态值。 */
  const [branch, setBranch] = useState<string>('feature/order-retry');
  /** B18：目录树收起集合（按节点下标）。 */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  /** B19：查找态（⌘F）—— null 关闭；编辑态不支持。 */
  const [find, setFind] = useState<{ open: boolean; query: string; index: number } | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  /* 当前选中的代码库资产：详情页据此绑定**自己的**本地克隆目录，不再写死 a-order-service。
   * 优先用用户刚点过的那个（它一定在本工作区），否则取本工作区第一个代码库资产。 */
  const codeAsset = useAssetTarget('code');
  const assetId = codeAsset?.id ?? '';
  /* 真实文件树（按资产拉取）；离线 / mock 模式回落 CODE_TREE。 */
  const [tree, setTree] = useState<TreeNode[]>([]);
  /* 本地仓库状态：本地路径 / 分支 / 提交 / 是否有未提交改动。 */
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [assetName, setAssetName] = useState<string>('');
  /* 克隆面板：URL / 分支 / 深度 —— 「代码库 = 克隆到本地」的入口。 */
  const [cloneOpen, setCloneOpen] = useState<boolean>(false);
  const [cloneUrl, setCloneUrl] = useState<string>('');
  const [cloneBranch, setCloneBranch] = useState<string>('');
  const [cloneDepth, setCloneDepth] = useState<string>('1');
  const [cloneBusy, setCloneBusy] = useState<boolean>(false);

  /* B18：解析当前路径 → 文件元数据；不在 CODE_FILES 的真实仓库文件合成一个空壳条目。 */
  const file = useMemo(() => {
    const base = CODE_FILES.find((item) => item.path === activePath)
      ?? CODE_FILES.find((item) => item.name === activePath.split('/').pop())
      ?? ({
        name: activePath.split('/').pop() ?? activePath,
        path: activePath,
        html: '<div>&nbsp;</div>',
        gutterStart: 1,
        lang: activePath.split('.').pop() ?? '',
        symbols: [],
        modified: false,
      });
    const plain = liveContent[activePath];
    if (plain === undefined || edited) return base;
    /* B19：查找态优先 —— 全量 <mark> 标注（放弃语法高亮换准确定位）。 */
    if (find?.open && find.query) {
      return { ...base, html: markAll(plain, find.query, find.index).html };
    }
    /* B18：查看态应用语法高亮（每行一个 div，与 gutter 对齐）。 */
    return { ...base, html: highlight(plain, activePath) };
  }, [activePath, CODE_FILES, liveContent, edited, find]);

  /** 打开文件 / 切换文件时拉取真实仓库内容 + 大纲（路径越界与敏感文件由服务端拒绝）。 */
  const loadContent = (path: string): void => {
    setActivePath(path);
    setEdited(false);
    void api.getFileContent(assetId, path).then((envelope) => {
      if (!envelope.ok) return;
      const plain = String(envelope.data.plain ?? '');
      if (plain) setLiveContent((prev) => ({ ...prev, [path]: plain }));
    });
    void api.getFileOutline(assetId, path).then((envelope) => {
      if (envelope.ok) setOutline(envelope.data);
    });
  };

  /* 资产切换 → 重新拉树 / 仓库状态 / 分支；默认打开的文件优先用演示路径，
   * 真实克隆的仓库没有那个路径时退到树里第一个文件。 */
  useEffect(() => {
    let cancelled = false;
    setLiveContent({});
    /* 没有选中资产（打包态首屏就是这种）时不要发 `/assets//...`：
     * 空 id 只会换来一串 404，界面本来也没有可渲染的树。 */
    if (!assetId) {
      setTree([]);
      setRepo(null);
      return () => { cancelled = true; };
    }
    void api.getFileTree(assetId).then((envelope) => {
      if (cancelled || !envelope.ok) return;
      const nodes: TreeNode[] = envelope.data.map((n) => ({
        label: n.name, depth: n.depth, caret: n.caret, path: n.isFile ? n.path : null,
      }));
      setTree(nodes);
      const defaultPath = 'src/main/java/order/InventoryClient.java';
      const hit = envelope.data.find((n) => n.isFile && n.path === defaultPath);
      const first = envelope.data.find((n) => n.isFile);
      const target = hit?.path ?? first?.path;
      if (target) loadContent(target);
    });
    void api.getRepoStatus(assetId).then((envelope) => {
      if (!cancelled && envelope.ok) setRepo(envelope.data);
    });
    void api.getAsset(assetId).then((envelope) => {
      if (!cancelled && envelope.ok) setAssetName(envelope.data.name);
    });
    void api.getGitSummary(assetId).then((envelope) => {
      if (!cancelled && envelope.ok && envelope.data.branch) setBranch(envelope.data.branch);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, state.assetRevision]);

  /* 引用浮层「打开」→ 加载源文件并跳到真实行号。
   * 内容是从 /files/content 异步拉的，所以要等 DOM 渲染出对应行再滚；
   * 给 20 次 × 120ms 的上限，超时如实提示而不是无限等。 */
  useEffect(() => {
    const pending = state.pendingSource;
    if (!pending) return;
    loadContent(pending.path);
    const line = pending.line;
    if (!line) {
      addToast(`已打开 ${pending.path}`);
      consumeSource();
      return;
    }
    let tries = 0;
    const timer = window.setInterval(() => {
      const target = codeRef.current?.children[line - 1] as HTMLElement | undefined;
      if (target) {
        window.clearInterval(timer);
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.style.background = 'var(--accent-weak, rgba(99,102,241,0.18))';
        window.setTimeout(() => { target.style.background = ''; }, 1200);
        addToast(`已跳到 ${pending.path}:${line}`);
      } else if (++tries > 20) {
        window.clearInterval(timer);
        addToast(`已打开 ${pending.path}，但第 ${line} 行未能定位`);
      }
    }, 120);
    consumeSource();
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.pendingSource]);

  /* 可打开的文件清单：优先用当前资产的真实文件树；拉不到才回落全局装配。 */
  const filePaths = useMemo(() => {
    const fromTree = tree.filter((node) => node.path).map((node) => node.path as string);
    if (fromTree.length > 0) return fromTree;
    return CODE_FILES.map((item) => item.path);
  }, [tree, CODE_FILES]);

  /* 行数：兼容两种 HTML 格式 —— mock 的 \n 分行文本 与 highlight/markAll 的每行 <div>。
   * 取两者较大值，避免 highlight 输出（join('') 无 \n）导致 gutter 只显示 1 行。 */
  const lineCount = Math.max(
    file.html.split('\n').length,
    (file.html.match(/<div>/g) || []).length,
    1,
  );

  const save = (): void => {
    setModified(false);
    addToast(`已保存 ${file.name} · 用户手动修改不受只读模式限制`);
    // actor=user 是唯一真实落盘路径；服务端 FileService 校验路径与敏感规则后写盘 + 审计。
    void api
      .saveFile(assetId, { path: file.path, content: codeRef.current?.innerText ?? '' })
      .then((envelope) => {
        if (!envelope.ok) {
          addToast(`保存被拒绝：${envelope.error?.code ?? 'E_INTERNAL'} ${envelope.error?.message ?? ''}`);
          setModified(true);
          return;
        }
        addToast(`服务端已落盘 ${envelope.data.bytesWritten} 字节 · diskChanged=${envelope.data.diskChanged}`);
        /* 保存成功后重拉大纲（符号随内容变化）。 */
        void api.getFileOutline(assetId, file.path).then((result) => {
          if (result.ok) setOutline(result.data);
        });
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!state.hotkey || state.view !== 'detail-code') return;
    if (state.hotkey.kind === 'openFile') {
      // ⌘P 在代码库详情内任意 Tab 均可用，选中后自动进入编辑器。
      setModal({
        kind: 'files',
        title: '打开文件 ⌘P · order-service',
        files: filePaths,
        onPick: (path: string) => {
          setDetailTab('main');
          loadContent(path);
          addToast(`已打开 ${path}`);
        },
      });
    } else if (state.hotkey.kind === 'saveCode' && state.detailTab === 'main') {
      save();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hotkey]);

  /* B18：大纲符号跳行 —— 滚动到对应行并短暂高亮。 */
  const jumpToLine = (line: number): void => {
    const target = codeRef.current?.children[line - 1] as HTMLElement | undefined;
    if (!target) {
      addToast(`跳转到第 ${line} 行（内容未加载）`);
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.style.background = 'var(--accent-weak, rgba(99,102,241,0.18))';
    window.setTimeout(() => {
      target.style.background = '';
    }, 900);
  };

  /* B19：⌘F 查找条开关（编辑态如实提示不可用）。 */
  useEffect(() => {
    if (!state.hotkey || state.hotkey.kind !== 'find') return;
    if (state.view !== 'detail-code' || state.detailTab !== 'main') return;
    if (edited) {
      addToast('查找在编辑态暂不可用（高亮暂停）· 保存后即可查找');
      return;
    }
    setFind((prev) => (prev?.open ? null : { open: true, query: '', index: 0 }));
    window.setTimeout(() => findInputRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hotkey]);

  /* B19：查找数据（命中位置 → 行号映射）。 */
  const findData = useMemo(() => {
    const plain = liveContent[activePath];
    if (!find?.open || !find.query || plain === undefined || edited) return null;
    return markAll(plain, find.query, find.index);
  }, [find, liveContent, activePath, edited]);

  /* 当前命中滚入视野。 */
  useEffect(() => {
    if (!find?.open || !findData || findData.lineOf.length === 0) return;
    const line = findData.lineOf[Math.min(find.index, findData.lineOf.length - 1)];
    const target = codeRef.current?.children[line - 1] as HTMLElement | undefined;
    target?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find?.index, findData]);

  const findStep = (delta: number): void => {
    if (!findData || findData.lineOf.length === 0) return;
    const total = findData.lineOf.length;
    setFind((prev) => (prev ? { ...prev, index: (prev.index + delta + total) % total } : prev));
  };

  const updateCursor = (): void => {
    const el = codeRef.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0 || !selection.anchorNode) return;
    if (!el.contains(selection.anchorNode)) return;
    try {
      const range = document.createRange();
      range.setStart(el, 0);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      const parts = range.toString().split('\n');
      setCursor({
        line: file.gutterStart + parts.length - 1,
        col: parts[parts.length - 1].length + 1,
      });
    } catch {
      /* 忽略无法计算光标位置的边界情况 */
    }
  };

  const gutter = Array.from({ length: lineCount }, (_, index) => file.gutterStart + index).join('\n');

  /* B18：目录树展开/收起 —— 真文件树按祖先目录过滤。 */
  const visibleNodes = useMemo(() => {
    /* 优先用按资产拉到的真实树；拉不到才回落全局装配的 CODE_TREE。 */
    const source: TreeNode[] = tree.length > 0 ? tree : (CODE_TREE as unknown as TreeNode[]);
    const result: { node: TreeNode; index: number }[] = [];
    const dirStack: { index: number; depth: number }[] = [];
    source.forEach((node, index) => {
      while (dirStack.length > 0 && dirStack[dirStack.length - 1].depth >= node.depth) dirStack.pop();
      const hidden = dirStack.some((dir) => collapsed.has(dir.index));
      if (!hidden) result.push({ node: node as TreeNode, index });
      if (!node.path) dirStack.push({ index, depth: node.depth });
    });
    return result;
  }, [tree, CODE_TREE, collapsed]);

  const toggleDir = (index: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  /** ⋯ 菜单：重建索引 / 分支详情 / 重命名 —— 全部走真实端点。 */
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const reindexAsset = (): void => {
    void api.advanceIndex(assetId).then((envelope) => {
      addToast(envelope.ok ? `已推进索引：${envelope.data.indexProgress}% · ${envelope.data.status}` : `索引推进失败：${envelope.error?.message ?? '未知错误'}`);
      void api.getRepoStatus(assetId).then((result) => {
        if (result.ok) setRepo(result.data);
      });
    });
  };
  const showBranch = (): void => {
    void api.getGitSummary(assetId).then((envelope) => {
      setModal({
        kind: 'info',
        title: `仓库分支 · ${assetName || assetId}`,
        body: envelope.ok
          ? Object.entries(envelope.data as unknown as Record<string, unknown>).map(([k, v]) => `${k}：${String(v)}`).join('\n')
          : 'git 摘要查询失败（离线或非 git 环境）',
        mono: true,
      });
    });
  };
  /** 真实 clone：把远端仓库拉到该项目的本地工作区目录，随后自动重建索引。 */
  const runClone = (): void => {
    const url = cloneUrl.trim();
    if (!url) {
      addToast('请先填写仓库地址');
      return;
    }
    setCloneBusy(true);
    void api.cloneRepo(assetId, {
      url,
      branch: cloneBranch.trim() || undefined,
      depth: Number(cloneDepth) || 0,
    }).then((envelope) => {
      setCloneBusy(false);
      if (!envelope.ok) {
        addToast(`克隆失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      const result = envelope.data;
      setCloneOpen(false);
      setCloneUrl('');
      setCloneBranch('');
      addToast(`已${result.action === 'pulled' ? '拉取' : '克隆'}到 ${result.localPath} · ${result.branch}@${result.commit} · 索引 ${result.index.chunks} 块`);
      /* 重新拉树与仓库状态：文件列表与分支都变了。 */
      void api.getFileTree(assetId).then((result2) => {
        if (!result2.ok) return;
        setTree(result2.data.map((n) => ({
          label: n.name, depth: n.depth, caret: n.caret, path: n.isFile ? n.path : null,
        })));
      });
      void api.getRepoStatus(assetId).then((result2) => {
        if (result2.ok) setRepo(result2.data);
      });
      void api.getGitSummary(assetId).then((result2) => {
        if (result2.ok && result2.data.branch) setBranch(result2.data.branch);
      });
    }).catch(() => {
      setCloneBusy(false);
      addToast('克隆失败：网络异常');
    });
  };
  const showRepoInfo = (): void => {
    if (!repo) {
      addToast('仓库状态未知');
      return;
    }
    setModal({
      kind: 'info',
      title: `本地仓库 · ${assetName || assetId}`,
      body: [
        `本地路径：${repo.absolutePath}`,
        `工作区相对路径：${repo.localPath || '—'}`,
        `远端地址：${repo.cloneUrl || '—'}`,
        `分支：${repo.branch || '—'}`,
        `提交：${repo.commit || '—'}`,
        `最近提交：${repo.lastCommit || '—'}`,
        `文件数：${repo.files}`,
        `未提交改动：${repo.dirty ? '有' : '无'}`,
        repo.error ? `异常：${repo.error}` : '',
      ].filter(Boolean).join('\n'),
      mono: true,
    });
  };
  /* 编辑资产：仓库地址 / 分支 / 索引模式 / 忽略规则 / 敏感文件规则与鉴权，
   * 全在同一张表单里改。只给"重命名"的话，填错一个分支就只能删了重建。 */
  const editAsset = (): void => {
    if (!assetId) {
      addToast('还没有可编辑的代码库资产');
      return;
    }
    openAssetForm(assetId);
  };

  return (
    <div className={`view${state.view === 'detail-code' ? ' on' : ''}`} data-view="detail-code">
      <DetailHeader
        icon={<CodeIcon size={15} strokeWidth={1.4} />}
        name={assetName || '代码库'}
        sub={repo?.cloned
          ? `本地工作区 · ${repo.localPath} · ${repo.branch || branch}`
          : `尚未克隆到本地 · ${branch}`}
        pills={
          <>
            <Pill tone="ok">
              <span className="sdot" />
              {repo?.cloned ? '已索引' : '待克隆'}
            </Pill>
            <Pill tone="ro">只读</Pill>
          </>
        }
        actions={
          <>
            <button
              className="btn p"
              onClick={() =>
                openAssetChat({ assetId, assetName: assetName || '代码库', assetType: 'code' })
              }
              title="在当前页面唤起一条绑定该代码库的 AI 会话"
            >
              <ChatIcon size={13} strokeWidth={1.4} />
              AI 会话
            </button>
            <button className="btn" onClick={() => setCloneOpen((value) => !value)}>
              {repo?.cloned ? '拉取最新' : '克隆仓库'}
            </button>
            <button
              className="btn p"
              onClick={() =>
                setModal({
                  kind: 'files',
                  title: '打开文件 ⌘P · order-service',
                  files: filePaths,
                  onPick: (path: string) => {
                    setDetailTab('main');
                    loadContent(path);
                    addToast(`已打开 ${path}`);
                  },
                })
              }
            >
              打开文件 ⌘P
            </button>
            <button
              className="dcfg"
              type="button"
              title="资产配置（能力授权 / 仓库信息）"
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
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); setCloneOpen((value) => !value); }}>
                  {repo?.cloned ? '拉取最新 / 换仓库' : '克隆仓库到本地'}
                </div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); showRepoInfo(); }}>仓库信息</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); reindexAsset(); }}>重建索引</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); showBranch(); }}>查看分支</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); editAsset(); }}>编辑资产…</div>
              </div>
            ) : null}
          </>
        }
      />
      <DetailTabs tabs={TABS} active={state.detailTab} onChange={setDetailTab} />

        <div className={`dbody${state.detailTab === 'main' ? ' on' : ''}`} data-dt="main">
        <Banner>
          {state.readOnly
            ? '只读模式仅约束 Agent：你的手动修改可直接保存；Agent 的提议修改以 patch 形式提供，确认后才会落盘'
            : '只读已关闭：你的手动修改可直接保存；Agent 的提议修改仍以 patch 形式提供，确认后才会落盘'}
        </Banner>
        {cloneOpen ? (
          <div style={{ borderBottom: '1px solid var(--gray-700, #2a2f3a)', padding: '10px 12px' }}>
            <div style={{ fontSize: 12, color: 'var(--gray-400)', marginBottom: 8 }}>
              克隆到本地工作区：仓库会被拉到该项目自己的目录下（workspaces/&lt;项目&gt;/&lt;仓库&gt;），
              与其他项目的仓库互不干扰。私有仓库请确保本机已配置 SSH Key 或 Git 凭据助手。
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={cloneUrl}
                onChange={(event) => setCloneUrl(event.target.value)}
                placeholder="仓库地址 · https://host/org/repo.git 或 git@host:org/repo.git"
                style={{
                  flex: '2 1 320px', background: 'var(--gray-800, rgba(255,255,255,0.04))',
                  border: '1px solid var(--gray-700, #2a2f3a)', borderRadius: 6,
                  color: 'inherit', padding: '5px 9px', outline: 'none', fontSize: 12,
                }}
              />
              <input
                value={cloneBranch}
                onChange={(event) => setCloneBranch(event.target.value)}
                placeholder="分支（可空）"
                style={{
                  flex: '0 1 140px', background: 'var(--gray-800, rgba(255,255,255,0.04))',
                  border: '1px solid var(--gray-700, #2a2f3a)', borderRadius: 6,
                  color: 'inherit', padding: '5px 9px', outline: 'none', fontSize: 12,
                }}
              />
              <input
                value={cloneDepth}
                onChange={(event) => setCloneDepth(event.target.value)}
                placeholder="深度"
                title="浅克隆深度；填 0 为全量克隆"
                style={{
                  flex: '0 1 64px', background: 'var(--gray-800, rgba(255,255,255,0.04))',
                  border: '1px solid var(--gray-700, #2a2f3a)', borderRadius: 6,
                  color: 'inherit', padding: '5px 9px', outline: 'none', fontSize: 12,
                }}
              />
              <button className="btn p" onClick={runClone} disabled={cloneBusy}>
                {cloneBusy ? '克隆中…' : repo?.cloned ? '拉取' : '克隆'}
              </button>
              <button className="btn" onClick={() => setCloneOpen(false)} disabled={cloneBusy}>取消</button>
            </div>
          </div>
        ) : null}
        <div className="split">
          <div className="ftree">
            {visibleNodes.map(({ node, index }) => {
              const isDir = !node.path;
              const isCollapsed = collapsed.has(index);
              return (
                <div
                  className={`fnode${!isDir && node.path === file.path ? ' on' : ''}`}
                  key={`${index}:${node.label}`}
                  style={{ paddingLeft: 10 + node.depth * 14 }}
                  onClick={() => {
                    if (isDir) {
                      toggleDir(index);
                    } else if (node.path) {
                      /* 用节点的完整路径直连读盘：不再按文件名反查，重名文件也不会跳错。 */
                      loadContent(node.path);
                      addToast(`已打开 ${node.path}`);
                    }
                  }}
                >
                  <span className="ic">
                    {isDir ? (
                      <CaretIcon dir={isCollapsed ? 'right' : 'down'} size={10} strokeWidth={1.6} />
                    ) : (
                      <span style={{ width: 10, display: 'inline-block' }} />
                    )}
                  </span>
                  <span className="ftic">
                    {isDir ? (
                      <span style={{ color: '#d4a017', display: 'inline-flex' }}>
                        <FolderIcon size={13} strokeWidth={1.4} />
                      </span>
                    ) : (
                      <FileTypeIcon name={node.label} size={13} strokeWidth={1.4} />
                    )}
                  </span>
                  {node.label}
                  {!isDir && node.path === file.path && modified ? <span className="md" /> : null}
                </div>
              );
            })}
          </div>
          <div className="editor">
            <div className="ebar">
              <span className="fn">{file.name}</span>
              {modified ? (
                <>
                  <span className="moddot" />
                  <span style={{ color: 'var(--gray-400)' }}>已修改</span>
                </>
              ) : (
                <span style={{ color: 'var(--gray-400)' }}>已保存</span>
              )}
              {edited ? <span style={{ color: 'var(--gray-400)', fontSize: 11 }}>编辑态 · 高亮暂停</span> : null}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  className="btn"
                  onClick={() => {
                    /* B19：真实 git diff（对 HEAD）；离线/非 git 回落静态 CODE_DIFF。 */
                    void api.getFileDiff(assetId, file.path).then((envelope) => {
                      if (!envelope.ok) {
                        setModal({ kind: 'info', title: 'Diff · 与 HEAD 对比', body: CODE_DIFF, mono: true });
                        return;
                      }
                      if (envelope.data.clean) {
                        addToast('工作区与 HEAD 一致 · 无未提交变更');
                        return;
                      }
                      setModal({
                        kind: 'info',
                        title: `Diff · ${file.name} · 与 HEAD 对比（git 真查）`,
                        body: envelope.data.diff,
                        mono: true,
                      });
                    });
                  }}
                >
                  Diff
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    /* B2：patch 由服务端生成（applicable:false，磁盘零变更）。 */
                    void api
                      .generatePatch(assetId, { path: file.path, patch: CODE_PATCH })
                      .then((envelope) => {
                        const patch = envelope.ok ? envelope.data.patch : CODE_PATCH;
                        setModal({
                          kind: 'command',
                          title: '生成 patch（建议 · 不落盘）',
                          command: patch,
                          body: '只读模式仅约束 Agent：这是 Agent 生成的建议 patch，需你确认后手动保存。',
                        });
                        addToast('patch 已生成（Agent 建议，未落盘）');
                      });
                  }}
                >
                  生成 patch
                </button>
                <button className="btn p" onClick={save}>
                  保存 ⌘S
                </button>
              </span>
            </div>
            {find?.open ? (
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                  borderBottom: '1px solid var(--gray-700, #2a2f3a)', fontSize: 12,
                }}
              >
                <span style={{ color: 'var(--gray-400)' }}>查找</span>
                <input
                  ref={findInputRef}
                  value={find.query}
                  onChange={(event) => setFind({ open: true, query: event.target.value, index: 0 })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      findStep(event.shiftKey ? -1 : 1);
                    } else if (event.key === 'Escape') {
                      event.stopPropagation();
                      setFind(null);
                    }
                  }}
                  placeholder="输入关键词 · Enter 下一个 · Shift+Enter 上一个 · Esc 关闭"
                  style={{
                    flex: 1, background: 'var(--gray-800, rgba(255,255,255,0.04))',
                    border: '1px solid var(--gray-700, #2a2f3a)', borderRadius: 6,
                    color: 'inherit', padding: '3px 8px', outline: 'none',
                  }}
                />
                <span style={{ color: 'var(--gray-400)', minWidth: 64, textAlign: 'right' }}>
                  {findData && findData.lineOf.length > 0
                    ? `${Math.min(find.index + 1, findData.lineOf.length)} / ${findData.lineOf.length}`
                    : '0 个'}
                </span>
                <button className="btn" onClick={() => findStep(-1)} title="上一个 (Shift+Enter)">‹</button>
                <button className="btn" onClick={() => findStep(1)} title="下一个 (Enter)">›</button>
                <button className="btn" onClick={() => setFind(null)} title="关闭 (Esc)" aria-label="关闭查找">
                  <CloseIcon size={12} strokeWidth={1.5} />
                </button>
              </div>
            ) : null}
            <div className="codewrap">
              <div className="gutter">{gutter}</div>
              <div
                className="codebody"
                key={activePath}
                ref={codeRef}
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                dangerouslySetInnerHTML={{ __html: file.html }}
                onClick={updateCursor}
                onKeyUp={updateCursor}
                onInput={() => {
                  if (!modified) setModified(true);
                  if (!edited) setEdited(true);
                }}
              />
            </div>
          </div>
          <div className="rinfo">
            <div className="rt">大纲</div>
            {(outline?.symbols ?? file.symbols).map((symbol) => (
              <div
                className="sym"
                key={`${symbol.label}:${symbol.line ?? 0}`}
                onClick={() => jumpToLine(symbol.line ?? 1)}
                style={{ cursor: 'pointer' }}
                title={symbol.line ? `跳转到第 ${symbol.line} 行` : undefined}
              >
                <span className="sg">{symbol.sg}</span>
                {symbol.label}
                {symbol.line ? <span style={{ marginLeft: 'auto', color: 'var(--gray-400)', fontSize: 10.5 }}>:{symbol.line}</span> : null}
              </div>
            ))}
            <div className="rt" style={{ marginTop: 16 }}>
              引用
            </div>
            {(outline?.references ?? ['被 3 处引用', '会话引用 2 次']).map((reference) => (
              <div className="sym" key={reference} style={{ color: reference.startsWith('·') ? 'var(--gray-300)' : 'var(--gray-400)' }}>
                {reference}
              </div>
            ))}
            <div className="rt" style={{ marginTop: 16 }}>
              Git
            </div>
            {(outline?.git ?? ['最后修改 a3f21c9', '1 小时前 · 黎']).map((item) => (
              <div className="sym" key={item} style={{ color: 'var(--gray-400)' }}>
                {item}
              </div>
            ))}
          </div>
        </div>
        <div className="dbar2">
          <span>{branch}</span>
          <span>UTF-8</span>
          <span>{file.lang}</span>
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span className="sr">
            <span>⌘F 查找</span>
            <span>⌘P 跳转文件</span>
            <span>点击大纲符号跳行</span>
          </span>
        </div>
      </div>

        <AssetConfigDrawer
        open={state.configOpen && state.view === 'detail-code'}
        title={assetName || '代码库'}
        sub={branch}
        caps={CAPS_CODE}
        assetId={assetId}
        readOnly={state.readOnly}
        metrics={CODE_METRICS}
        kv={CODE_REPO_KV.map((row) => ({ k: row.k, v: row.v }))}
        activity={CODE_ACTIVITY_KV.map((row) => ({ k: row.k, v: row.v }))}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  );
}
