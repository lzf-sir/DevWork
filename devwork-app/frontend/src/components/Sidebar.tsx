import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { AssetIcon, ChartIcon, DotsIcon, GearIcon, PlusIcon } from './icons';
import { ASSET_TYPE_LABEL } from '../utils/assetActions';
import AssetConnect from './AssetConnect';
import { Resizer, usePanelWidth } from './Resizer';
import { waitingLevel as levelOf, waitingTip as tipOf, waitingBadgeText } from '../utils/waiting';
import { api } from '../api/client';
import type { AssetFolder, AssetItem, ConvFolder, SidebarData, ViewName } from '../api/client';

/* 「待人」状态搬到 store 了（state.waiting，全局 10 秒一刷）。
 *
 * 原来这里自己 30 秒拉一次 stats，能工作但有两个问题：
 *   ① 只有侧栏知道 —— 会话 tab 上自然就画不出橙点，人被要在别的会话里找；
 *   ② 30 秒对阻塞态太慢，Agent 停下来等人，半分钟后界面才动一下。
 * 现在侧栏、会话 tab、协作流读的是同一份快照，数字不会再互相打架。 */

/** 折叠状态以服务端为准：这里只是渲染期的乐观副本。 */
function initialFolderState(data: SidebarData): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const walkAssets = (folders: AssetFolder[]): void => {
    folders.forEach((folder) => {
      result[folder.id] = folder.open;
      walkAssets(folder.subFolders ?? []);
    });
  };
  const walkConvs = (folders: ConvFolder[]): void => {
    folders.forEach((folder) => {
      result[folder.id] = folder.open;
      walkConvs(folder.subFolders ?? []);
    });
  };
  walkAssets(data.assetFolders);
  walkConvs(data.convFolders);
  return result;
}

interface MenuItem {
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => void;
}

interface MenuState {
  top: number;
  left: number;
  items: MenuItem[];
}

/** 数据侧图标字符 → 资产类型：类型字段缺失时用它反推，保证配色与图形一致。 */
const GLYPH_KIND: Record<string, string> = {
  '▤': 'db',
  '▣': 'code',
  '▥': 'server',
  '▧': 'kb',
};

/** 空态侧栏数据：一个工作区都没有时（打包态首次启动）用它顶住首屏。
 *  以前这里直接解引用 project.sidebar，空列表会在渲染期抛错 —— React 卸载整棵树 = 白屏。 */
const EMPTY_SIDEBAR: SidebarData = {
  assetFolders: [],
  looseAssets: [],
  convFolders: [],
  looseConvs: [],
};

/** 左栏：208px，资产中心 / 会话两个分区 + 底部固定入口。
 *  收起 / 展开入口统一在窗口左上角（顶栏 .menu-toggle），本组件内不再放折叠按钮。 */
export default function Sidebar(): React.ReactElement {
  const { state, navigate, setConversation, addToast, reloadSidebar, setModal, newConversation, renameConversation, removeConversation, archiveConversation, setActiveAsset, toggleCollab, openAssetForm, closeAssetForm } =
    useStore();
  const project = state.projects.find((p) => p.id === state.workspaceId) ?? state.projects[0];
  const data = project?.sidebar ?? EMPTY_SIDEBAR;
  const [folders, setFolders] = useState<Record<string, boolean>>(() => initialFolderState(data));
  /* 待人状态：读全局快照，不再本组件轮询。
   * 颜色与文案的计算搬去 utils/waiting —— 任务栏徽标和这里必须用同一套说法。 */
  const waiting = state.waiting;
  const waitingHere = waiting.filter((item) => item.conversationId === state.activeConversationId);
  const waitingLevel = levelOf(waiting);
  const waitingTip = tipOf(waiting);
  /** 点徽标：当前会话就有单在等你 → 直接开它的协作流；否则去工单页看全量。
   *  不偷偷切会话 —— 你正在写的那句话比省一次点击值钱。 */
  const openWaiting = (): void => {
    if (waitingHere.length > 0) {
      toggleCollab(true);
      return;
    }
    navigate('shadow');
  };
  /** 左栏宽度：180~260px，拖拽手柄在右边界，宽度落 localStorage。 */
  const { width, dragging, beginDrag, reset: resetWidth } = usePanelWidth({
    storageKey: 'devwork-side-width', initial: 208, min: 180, max: 260,
  });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  /** 服务端会话列表里已有的 id：本地 extraConversations 与它们重合时只显示一份。 */
  const serverConvIds = useMemo(() => {
    const ids = new Set<string>();
    const walk = (folders: ConvFolder[]): void => {
      folders.forEach((folder) => {
        folder.items.forEach((item) => ids.add(item.id));
        walk(folder.subFolders ?? []);
      });
    };
    walk(data.convFolders);
    data.looseConvs.forEach((item) => ids.add(item.id));
    return ids;
  }, [data]);
  const localOnlyConvs = useMemo(
    () => state.extraConversations.filter((item) => !serverConvIds.has(item.id)),
    [state.extraConversations, serverConvIds],
  );

  useEffect(() => {
    setFolders(initialFolderState(data));
  }, [state.workspaceId, data]);

  /* 菜单靠 mousedown 关闭：打开菜单的那次 click 之前 mousedown 已经过去，
   * 不会出现「刚点开就被同一次点击关掉」的经典竞态。 */
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest('.smenu')) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const openMenu = useCallback((event: React.MouseEvent, items: MenuItem[]): void => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const height = items.length * 30 + 12;
    setMenu({
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
      left: Math.min(rect.right + 4, window.innerWidth - 196),
      items,
    });
  }, []);

  /* 折叠状态必须落库：否则切项目 / 重启应用抽屉全弹开。 */
  const toggleFolder = (id: string, open: boolean): void => {
    const next = !open;
    setFolders((prev) => ({ ...prev, [id]: next }));
    void api
      .updateFolder(id, { collapsed: !next })
      .then((envelope) => {
        if (envelope.ok) return;
        setFolders((prev) => ({ ...prev, [id]: open }));
        addToast(`折叠状态保存失败：${envelope.error?.message ?? '未知错误'}`);
      })
      .catch(() => {
        setFolders((prev) => ({ ...prev, [id]: open }));
        addToast('折叠状态保存失败：网络异常');
      });
  };

  const createFolder = (kind: 'asset' | 'conversation', parentId?: string): void => {
    setModal({
      kind: 'prompt',
      title: parentId ? '新建子文件夹' : '新建文件夹',
      label: parentId ? '子文件夹名称（目录最多两层）' : '文件夹名称',
      placeholder: kind === 'asset' ? '例如：订单域' : '例如：待复盘',
      confirmLabel: '创建',
      onSubmit: (value: string) => {
        void api
          .createFolder({ workspaceId: state.workspaceId, kind, name: value, parentId: parentId ?? null })
          .then(async (envelope) => {
            if (!envelope.ok) {
              addToast(`创建失败：${envelope.error?.message ?? '未知错误'}`);
              return;
            }
            await reloadSidebar();
            addToast(`已创建文件夹「${value}」`);
          })
          .catch(() => addToast('创建失败：网络异常'));
      },
    });
  };

  const renameFolder = (folder: { id: string; name: string }): void => {
    setModal({
      kind: 'prompt',
      title: '重命名文件夹',
      label: `「${folder.name}」的新名称`,
      placeholder: folder.name,
      confirmLabel: '保存',
      onSubmit: (value: string) => {
        void api
          .updateFolder(folder.id, { name: value })
          .then(async (envelope) => {
            if (!envelope.ok) {
              addToast(`重命名失败：${envelope.error?.message ?? '未知错误'}`);
              return;
            }
            await reloadSidebar();
            addToast('文件夹已重命名');
          })
          .catch(() => addToast('重命名失败：网络异常'));
      },
    });
  };

  const removeFolder = (folder: { id: string; name: string; count: number }): void => {
    setModal({
      kind: 'confirm',
      title: '删除文件夹',
      body: `删除「${folder.name}」后，里面的 ${folder.count} 个条目会上提到上一级，不会被一起删除。`,
      confirmLabel: '删除文件夹',
      danger: true,
      onConfirm: () => {
        void api
          .deleteFolder(folder.id)
          .then(async (envelope) => {
            if (!envelope.ok) {
              addToast(`删除失败：${envelope.error?.message ?? '未知错误'}`);
              return;
            }
            await reloadSidebar();
            addToast(`已删除文件夹「${folder.name}」`);
          })
          .catch(() => addToast('删除失败：网络异常'));
      },
    });
  };

  const moveSession = (item: { id: string; title: string }, targetFolderId: string | null): void => {
    void api
      .moveItem({ itemId: item.id, kind: 'conversation', targetFolderId })
      .then(async (envelope) => {
        if (!envelope.ok) {
          addToast(`移动失败：${envelope.error?.message ?? '未知错误'}`);
          return;
        }
        await reloadSidebar();
        addToast(targetFolderId ? `已移动到文件夹` : '已移出文件夹');
      })
      .catch(() => addToast('移动失败：网络异常'));
  };

  /* 资产删除：破坏性操作，确认后走服务端 DELETE（子表级联清理），当前正看该资产则退回聊天。 */
  const removeAsset = (asset: AssetItem): void => {
    setModal({
      kind: 'confirm',
      title: '删除资产',
      body: `删除「${asset.name}」后不可恢复。它的索引、凭据绑定与终端会话会一并清理。`,
      confirmLabel: '删除资产',
      danger: true,
      onConfirm: () => {
        void api
          .deleteAsset(asset.id)
          .then(async (envelope) => {
            if (!envelope.ok) {
              addToast(`删除失败：${envelope.error?.message ?? '未知错误'}`);
              return;
            }
            if (state.activeAssetId === asset.id && state.view.startsWith('detail-')) navigate('chat');
            await reloadSidebar();
            addToast(`已删除资产「${asset.name}」`);
          })
          .catch(() => addToast('删除失败：网络异常'));
      },
    });
  };

  /* 会话删除不可恢复 → 确认弹窗；想留底就先「归档」（菜单里排在删除前面）。 */
  const confirmRemoveSession = (item: { id: string; title: string }): void => {
    setModal({
      kind: 'confirm',
      title: '删除会话',
      body: `删除「${item.title}」后不可恢复，消息记录一并移除。想留着以后再看，请先「归档」。`,
      confirmLabel: '删除会话',
      danger: true,
      onConfirm: () => removeConversation(item.id),
    });
  };

  const renderAsset = (asset: AssetItem): React.ReactElement => {
    /* 高亮必须同时锚定「资产身份」和「详情视图」：只看 view 的话，所有 go 相同的资产
     * （如三个代码库都是 detail-code）会一起亮；只看 activeAssetId 的话，初始值会让
     * order-service 在未点击时就显示选中。 */
    const isCurrent = !!asset.go && state.view === `detail-${asset.go}` && state.activeAssetId === asset.id;
    /* 图标配色按类型区分；类型缺失时从数据侧字符反推，保证颜色与图形永远一致。 */
    const kind = asset.go ?? GLYPH_KIND[asset.icon] ?? 'code';
    let status: React.ReactNode = null;
    if (asset.status === 'ok') status = <span className="sd" />;
    else if (asset.status === 'warn') status = <span className="sd w" />;
    else if (asset.status === 'nb') status = <span className="sd nb" />;
    else if (asset.status === 'offline') status = <span className="sd" style={{ background: 'var(--danger)' }} />;
    else if (asset.status === 'indexing') status = <span className="sd idx" title="索引中" />;

    return (
      <div
        className={`aitem${isCurrent ? ' cur' : ''}`}
        data-go={asset.go}
        title={asset.title || asset.name}
        key={asset.id}
        onClick={() => {
          if (asset.go) {
            /* 先记下选中的资产：详情页据此绑定自己的本地仓库（代码库 = 克隆到本地）。 */
            setActiveAsset(asset.id);
            navigate(`detail-${asset.go}` as ViewName);
          } else {
            addToast(`${asset.name}：该类型资产暂未提供详情页`);
          }
        }}
      >
        <span className={`ai ai-${kind}`}>
          <AssetIcon type={asset.go} glyph={asset.icon} size={13} strokeWidth={1.4} />
        </span>
        <span className="t">{asset.name}</span>
        {asset.env ? <span className="etag">{asset.env}</span> : null}
        {status}
        <span
          className="more"
          title="资产操作"
          onClick={(event) =>
            openMenu(event, [
              /* 编辑排最上面：它是最常按的那一项（改名、换库、改白名单都在这里）。 */
              { label: '编辑资产…', run: () => openAssetForm(asset.id) },
              { label: '删除资产', danger: true, run: () => removeAsset(asset) },
            ])
          }
        >
          <DotsIcon size={14} />
        </span>
      </div>
    );
  };

  const renameSession = (item: { id: string; title: string }): void => {
    setModal({
      kind: 'prompt',
      title: '重命名会话',
      label: `「${item.title}」的新标题`,
      placeholder: item.title,
      confirmLabel: '保存',
      onSubmit: (value: string) => renameConversation(item.id, value),
    });
  };

  const renderSession = (item: { id: string; title: string; assetId?: string; assetType?: string }): React.ReactElement => (
    <div
      className={`sitem${state.activeConversationId === item.id ? ' on' : ''}`}
      key={item.id}
      onClick={() => setConversation(item.id, item.title)}
    >
      {/* 资产会话徽标：这条会话是从某个资产的页面唤起的（默认绑定该资产）。 */}
      {item.assetId ? (
        <span className="abind" title={`资产会话 · 绑定 ${ASSET_TYPE_LABEL[item.assetType ?? ''] ?? '资产'}`}>
          <AssetIcon type={item.assetType} size={11} strokeWidth={1.4} />
        </span>
      ) : null}
      <span className="t">{item.title}</span>
        <span
          className="more"
          title="会话操作"
          onClick={(event) =>
            openMenu(event, [
              /* 先归档、后删除：归档是无损收起（设置页可恢复），删除才是终点。 */
              { label: '归档', run: () => archiveConversation(item.id) },
              { label: '重命名', hint: 'PATCH', run: () => renameSession(item) },
              ...data.convFolders.map((folder) => ({
                label: `移到「${folder.name}」`,
                run: () => moveSession(item, folder.id),
              })),
              { label: '移出文件夹', run: () => moveSession(item, null) },
              { label: '删除会话', danger: true, run: () => confirmRemoveSession(item) },
            ])
          }
        >
          <DotsIcon size={14} />
        </span>
    </div>
  );

  /* 资产 / 会话文件夹共用一套渲染：差异只在叶子节点与菜单项。 */
  const renderFolder = (
    folder: AssetFolder | ConvFolder,
    kind: 'asset' | 'conversation',
    depth: number,
  ): React.ReactElement => {
    const open = folders[folder.id] ?? folder.open;
    const kids = kind === 'asset' ? (folder as AssetFolder).items : null;
    const subFolders = folder.subFolders ?? [];
    return (
      <React.Fragment key={folder.id}>
        <div
          className={`folder${open ? ' open' : ''}`}
          style={depth > 1 ? { paddingLeft: 16 } : undefined}
          onClick={() => toggleFolder(folder.id, open)}
        >
          <span className="cv" />
          <span className="t">{folder.name}</span>
          <span className="n">{folder.count}</span>
          <span
            className="mo"
            title="文件夹操作"
            onClick={(event) =>
              openMenu(event, [
                { label: '重命名', run: () => renameFolder(folder) },
                ...(depth < 2
                  ? [{ label: '新建子文件夹', run: () => createFolder(kind, folder.id) }]
                  : []),
                { label: '删除文件夹', danger: true, run: () => removeFolder(folder) },
              ])
            }
          >
            <DotsIcon size={14} />
          </span>
        </div>
        <div className={`kids${open ? '' : ' hide'}`}>
          {kind === 'asset'
            ? kids?.map(renderAsset)
            : (folder as ConvFolder).items.map((item) => renderSession(item))}
          {subFolders.map((sub) => renderFolder(sub, kind, depth + 1))}
        </div>
      </React.Fragment>
    );
  };

  return (
    <aside
      className={`side${state.leftCollapsed ? ' off' : ''}`}
      style={{ ['--side-w' as string]: `${width}px` } as React.CSSProperties}
    >
      <div className="side-scroll">
        <div className="sec-t">
          <span>资产中心</span>
          <span className="sec-acts">
            <span
              className="add"
              title="接入资产 / 新建文件夹"
              onClick={(event) =>
                openMenu(event, [
                  { label: '接入资产…', run: () => openAssetForm() },
                  { label: '新建文件夹', run: () => createFolder('asset') },
                ])
              }
            >
              <PlusIcon size={13} strokeWidth={1.6} />
            </span>
          </span>
        </div>

        {data.assetFolders.length === 0 && data.looseAssets.length === 0 ? (
          <div className="sempty">还没有资产。点右上角的加号按钮选择「接入资产」。</div>
        ) : null}
        {data.assetFolders.map((folder) => renderFolder(folder, 'asset', 1))}
        {data.looseAssets.map(renderAsset)}

        <div className="divider" />

        <div className="sec-t">
          会话
          <span
            className="add"
            title="新建会话 / 新建文件夹"
            onClick={(event) =>
              openMenu(event, [
                { label: '新建会话（⌘N）', run: newConversation },
                { label: '新建文件夹', run: () => createFolder('conversation') },
              ])
            }
          >
            <PlusIcon size={13} strokeWidth={1.6} />
          </span>
        </div>

        {data.convFolders.length === 0 && data.looseConvs.length === 0 && state.extraConversations.length === 0 ? (
          <div className="sempty">还没有会话。按 ⌘N 或点上方加号按钮新建。</div>
        ) : null}
        {data.convFolders.map((folder) => renderFolder(folder, 'conversation', 1))}
        {data.looseConvs.map((item) => renderSession(item))}
        {/* 本地镜像只补服务端还没有回填的那几条，避免同一条会话出现两次。 */}
        {localOnlyConvs.map((item) => renderSession(item))}
      </div>

      <div className="side-foot">
        {/* 智能体工作台：工单 / 准入 / 账本三区。
            放在设置旁边而不是主导航：它是「管理这台机器的行为」的入口，
            不是日常聊天动作。有单在等人时，右侧直接显示数字 —— 
            藏在页面里的待办等于没有待办。 */}
        <div
          className={`sfoot${state.view === 'shadow' ? ' on' : ''}`}
          onClick={() => navigate('shadow')}
          title={waitingTip || undefined}
        >
          <ChartIcon size={14} strokeWidth={1.4} />
          智能体
          {waiting.length > 0 ? (
            /* 可点的徽标：点它 = 去看「谁在等我」。只画个数字不给入口，
             * 等于告诉人有事又不告诉人往哪走。 */
            <button
              type="button"
              className={`sh-side-badge lv-${waitingLevel}`}
              title={waitingTip}
              aria-label={waitingTip.replace(/\n/g, '，')}
              onClick={(event) => {
                event.stopPropagation();
                openWaiting();
              }}
            >
              {waitingBadgeText(waiting)}
            </button>
          ) : (
            <span className="k">P3</span>
          )}
        </div>
        <div className={`sfoot${state.view === 'settings' ? ' on' : ''}`} onClick={() => navigate('settings')}>
          <GearIcon size={14} strokeWidth={1.4} />
          系统设置
          <span className="k">⌘,</span>
        </div>
      </div>

      {/* 接入 / 编辑资产共用一个弹窗：侧栏与详情页都从这里进（editId 为空 = 新建）。 */}
      {state.assetForm ? <AssetConnect editId={state.assetForm.id} onClose={closeAssetForm} /> : null}

      {/* 左栏右边界拖拽手柄：180~260px（设计 §9.18）。 */}
      <Resizer edge="right" dragging={dragging} onBegin={beginDrag} onReset={resetWidth} />

      {menu ? (
        <div className="smenu" ref={menuRef} style={{ top: menu.top, left: menu.left }} role="menu">
          {menu.items.map((item) => (
            <button
              key={item.label}
              type="button"
              className={`smenu-i${item.danger ? ' danger' : ''}`}
              onClick={() => {
                setMenu(null);
                item.run();
              }}
            >
              <span>{item.label}</span>
              {item.hint ? <span className="h">{item.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
