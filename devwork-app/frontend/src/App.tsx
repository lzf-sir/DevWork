import React, { useEffect, useRef } from 'react';
import { useStore } from './store';
import {
  api,
  type Dict,
  type MessageCard,
  type Project,
  type Sidebar as SidebarPayload,
} from './api/client';
import { cardsToThread, toSidebarData } from './api/adapters';
import { applyLookSettings } from './look';
import TopBar from './components/TopBar';
import Sidebar from './components/Sidebar';
import WorkbenchPanel from './components/WorkbenchPanel';
import StatusBar from './components/StatusBar';
import CommandPalette from './components/CommandPalette';
import ShortcutHelp from './components/ShortcutHelp';
import { ModalHost, ToastStack } from './components/ui';
import ChatView from './views/ChatView';
import ServerDetail from './views/ServerDetail';
import DatabaseDetail from './views/DatabaseDetail';
import CodeDetail from './views/CodeDetail';
import KbDetail from './views/KbDetail';
import ProjectsView from './views/ProjectsView';
import ShadowView from './views/ShadowView';
import SettingsView from './views/SettingsView';
import AssetChatDock from './components/AssetChatDock';

/** 全局快捷键（设计 9.20）：Mac 用 ⌘，Windows 用 Ctrl 兼容。 */
function useGlobalShortcuts(): void {
  const store = useStore();
  const storeRef = useRef(store);
  storeRef.current = store;

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      /* 少数 KeyboardEvent（合成事件、个别输入法/无障碍工具派发的）不带 key，
       * 直接 toLowerCase() 会抛 TypeError，而它在 window 上，一抛就等于把
       * 全局快捷键整条链路打瘫。没有 key 就不是我们要处理的按键，安静退出。 */
      if (typeof event.key !== 'string') return;
      const api = storeRef.current;
      const s = api.state;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (event.key === 'Escape') {
        if (s.paletteOpen) {
          api.setPalette(false);
        } else if (s.helpOpen) {
          api.setHelp(false);
        } else if (s.modal) {
          api.setModal(null);
        } else if (s.configOpen) {
          /* 抽屉优先于「退出详情页」：Esc 先关抽屉，再按 Esc 才返回会话。 */
          api.setConfigOpen(false);
        } else if (s.citation) {
          api.setCitation(null);
        } else if (s.artifactPickerOpen) {
          /* 产物选择浮层：Esc 收起（它挂在会话右缘，选完就该走）。 */
          api.setArtifactPicker(false);
        } else if (s.collabFor) {
          /* 协作流是一层「视图」，Esc 先退回对话，不要越过它直接掐生成。 */
          api.toggleCollab(false);
        } else if (s.view === 'projects' || s.view === 'settings') {
          api.navigate('chat');
        } else {
          /* Esc 与 ⌘. 同一语义：真中断进行中的流式请求；没有流时如实提示。 */
          api.stopGeneration();
        }
        event.preventDefault();
        return;
      }

      if (mod) {
        switch (true) {
          /* ⌘1..⌘9：按位置切会话 tab —— 与浏览器一致，比「先找再点」快一档。 */
          case /^[1-9]$/.test(event.key):
            event.preventDefault();
            api.activateSessionTabAt(Number(event.key) - 1);
            return;
          case key === 'k':
            event.preventDefault();
            api.setPalette(!s.paletteOpen);
            return;
          case key === 'n':
            event.preventDefault();
            api.newConversation();
            return;
          case key === 'o':
            event.preventDefault();
            api.navigate('projects');
            return;
          case event.key === ',':
            event.preventDefault();
            api.navigate('settings');
            return;
          case key === 'b':
            event.preventDefault();
            api.toggleLeft();
            return;
          case event.key === '\\':
            event.preventDefault();
            api.toggleRight();
            return;
          case event.key === 'Enter':
            event.preventDefault();
            if (s.view === 'detail-db' && s.detailTab === 'main') api.emit('sqlRun');
            else api.emit('send');
            return;
          case event.key === '.':
            event.preventDefault();
            api.stopGeneration();
            return;
          case key === 'p' && s.view === 'detail-code':
            event.preventDefault();
            api.emit('openFile');
            return;
          case key === 's' && s.view === 'detail-code':
            event.preventDefault();
            api.emit('saveCode');
            return;
          case key === 'f' && s.view === 'detail-code':
            event.preventDefault();
            api.emit('find');
            return;
          case key === 'l' && s.view === 'detail-server' && s.detailTab === 'main':
            event.preventDefault();
            api.emit('clearTerm');
            return;
          default:
            break;
        }
      }

      if (!mod && !typing && event.key === '?') {
        event.preventDefault();
        api.setHelp(!s.helpOpen);
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}

export default function App(): React.ReactElement {
  useGlobalShortcuts();
  const { state, setApiMode, setStatus, hydrateFromRest } = useStore();

  /**
   * 主题落地：偏好存在 localStorage，'system' 时跟随 prefers-color-scheme，
   * 系统主题变化要实时跟随（不能只在启动时读一次）。
   */
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const resolved = state.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [state.theme]);

  /**
   * 启动探测：bootstrap() 判定 apiMode，并把 3 组工作区 / 侧栏 / 会话消息 / 状态栏
   * 全量从 REST 注入 store；断后端时全部保持内置 mock，视觉与交互零差异。
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      /* 不带 workspaceId：由服务端按「默认项目」设置（gen.g1）解析初始工作区。 */
      const boot = await api.bootstrap();
      if (!alive) return;
      /* 用本次 bootstrap 响应包络自带的 meta.apiMode 判定，不读可变的模块级
       * apiMode：后者会被并发的任一失败请求改成 mock，造成启动竞态（状态栏
       * 闪回「离线 Mock」）。后端包络固定 apiMode:'live'，降级包络为 'mock'。 */
      const mode = boot.meta?.apiMode === 'live' ? 'live' : 'mock';
      setApiMode(mode);
      if (!boot.ok || mode !== 'live') {
        setStatus('离线 Mock');
        return;
      }
      setStatus('就绪');

      const workspaces = await api.listWorkspaces();
      if (!alive || !workspaces.ok) return;
      const sidebars = await Promise.all(workspaces.data.map((ws) => api.getSidebar(ws.id)));
      if (!alive) return;

      const projects: Project[] = workspaces.data.map((ws, index) => ({
        id: ws.id,
        name: ws.name,
        desc: ws.description,
        index: ws.indexProgress,
        assetsLabel: `${ws.assetsCount} 个资产`,
        convLabel: `${ws.conversationsCount} 个会话`,
        owner: ws.owner,
        recent: ws.recentLabel,
        sidebar: sidebars[index]?.ok
          ? toSidebarData(sidebars[index].data)
          : { assetFolders: [], looseAssets: [], convFolders: [], looseConvs: [] },
      }));

      const payload = boot.data as unknown as Dict;
      const messages = (payload.messages ?? []) as unknown as MessageCard[];
      const statusBar = (payload.statusBar ?? {}) as Dict;
      /* 会话键必须来自服务端返回的当前会话，不能写死 'c-gmv'：
       * 否则切到 w-data 之类的项目，消息仍被塞进生产运维的会话里。 */
      const currentConversationId = typeof payload.currentConversationId === 'string'
        ? payload.currentConversationId
        : '';
      const convTitle = (() => {
        const sidebarPayload = (payload.sidebar ?? {}) as SidebarPayload;
        const folders = sidebarPayload.convFolders ?? [];
        const flat: Dict[] = [
          ...folders.flatMap((folder) => ((folder.items as unknown as Dict[]) ?? [])),
          ...((sidebarPayload.looseConvs ?? []) as unknown as Dict[]),
        ];
        const hit = flat.find((item) => String(item.id ?? '') === currentConversationId);
        return hit ? String(hit.title ?? '') : '';
      })();
      hydrateFromRest({
        projects,
        /* 服务端解析出的当前工作区是权威值：资产级请求靠它注入 workspaceId，
         * 丢掉它会让前端与后端对「当前在哪个工作区」的认知分叉。 */
        workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined,
        activeConversationId: currentConversationId || undefined,
        /* 有真实会话时**必须**用服务端标题（哪怕侧栏里没找到、结果为空），
         * 否则开发态的演示标题（GMV 归因）会被当成真会话的名字留在 tab 上。 */
        activeConversationTitle: currentConversationId ? convTitle : undefined,
        readOnlyMode: typeof payload.readOnlyMode === 'boolean' ? payload.readOnlyMode : undefined,
        statusBar: {
          model: typeof statusBar.model === 'string' ? statusBar.model : undefined,
          contextUsed: typeof statusBar.contextUsed === 'number' ? statusBar.contextUsed : undefined,
          costCny: typeof statusBar.costCny === 'number' ? statusBar.costCny : undefined,
          state: typeof statusBar.state === 'string' ? statusBar.state : undefined,
        },
        threads:
          messages.length > 0 && currentConversationId
            ? { [currentConversationId]: cardsToThread(messages) }
            : undefined,
      });
    })();
    return () => {
      alive = false;
    };
  }, [setApiMode, setStatus, hydrateFromRest]);

  /**
   * 外观设置（l2 字号 / l3 代码字体 / l4 密度）真实生效：启动时从服务端读一次并应用，
   * 此后设置页每次保存外观项都会即时重新应用（见 SettingsView.applyLookRows）。
   */
  useEffect(() => {
    void api.getSettings().then((envelope) => {
      if (!envelope.ok) return;
      const look = (envelope.data.raw ?? {}) as Record<string, Record<string, unknown>>;
      applyLookSettings({
        fontSize: typeof look.look?.l2 === 'string' ? look.look.l2 : undefined,
        monoFont: typeof look.look?.l3 === 'string' ? look.look.l3 : undefined,
        density: typeof look.look?.l4 === 'string' ? look.look.l4 : undefined,
      });
    });
  }, []);

  return (
    <>
      <TopBar />
      <div className="body">
        <Sidebar />
        <div className="main">
          <div className="main-page">
            <ChatView />
            <ServerDetail />
            <DatabaseDetail />
            <CodeDetail />
            <KbDetail />
            <ProjectsView />
            <ShadowView />
            <SettingsView />
          </div>
          {/* 资产会话坞：与页面**并排的一列**（可折叠展开），不是浮层抽屉。 */}
          <AssetChatDock />
        </div>
        <WorkbenchPanel />
      </div>
      <StatusBar />
      <CommandPalette />
      <ShortcutHelp />
      <ModalHost />
      <ToastStack />
    </>
  );
}
