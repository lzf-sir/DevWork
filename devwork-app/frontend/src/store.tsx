import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ConvItem,
  Message,
  Project,
  ViewName,
} from './api/client';
/* B2：初始状态只取 api 层的离线 fallback 快照，组件不直接引用 src/data/mock.ts。
 * 启动后由 App.bootstrap()/hydrateFromRest() 用 REST 结果整体覆盖。 */
import { MOCK_SNAPSHOT } from './api/mock';
import { api as restApi } from './api/client';
import { cardsToThread, toSidebarData } from './api/adapters';

/* ===================== 类型 ===================== */

export type HotkeyKind = 'send' | 'sqlRun' | 'openFile' | 'saveCode' | 'clearTerm' | 'stop' | 'find';

/** 主题偏好。'system' 跟随 prefers-color-scheme，实际生效值由 App 解析。 */
export type Theme = 'system' | 'light' | 'dark';
export const THEME_LABEL: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
const THEME_KEY = 'devwork-theme';

export function readStoredTheme(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    /* localStorage 不可用（隐私模式 / file://）时退回跟随系统，不影响渲染。 */
  }
  return 'system';
}

/* 会话级模型选择：conversationId → 模型名。存本地（客户端偏好），不改服务端全局配置。 */
const CONVERSATION_MODELS_KEY = 'devwork-conversation-models';

export function readStoredConversationModels(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CONVERSATION_MODELS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, string> = {};
    Object.entries(parsed).forEach(([id, model]) => {
      if (typeof model === 'string' && model) result[id] = model;
    });
    return result;
  } catch {
    /* 存坏了就当没有偏好，不影响主流程。 */
    return {};
  }
}

export interface ToastItem {
  id: number;
  text: string;
}

/**
 * 资产会话坞 —— 资产详情页（代码库 / 数据 / 终端）内嵌的 AI 会话。
 *
 * 一次点击 = 一条新会话：会话落在服务端（会话列表里看得见），
 * 并且默认绑定当前资产 —— 绑定会随每一轮消息下发给服务端，
 * 所以「对这个资产提问」与「对这个资产做快捷操作」走的是同一条链路。
 */
export interface AssetChatState {
  /** 会话 id（服务端真实 id；离线时是本地临时 id）。 */
  conversationId: string;
  /** 会话标题（侧栏里显示的就是它）。 */
  title: string;
  /** 绑定的资产 id。 */
  assetId: string;
  /** 绑定资产名称。 */
  assetName: string;
  /** 绑定资产类型：code / db / server / kb。 */
  assetType: string;
}

/* 资产会话坞的折叠状态是**布局偏好**（跟左栏折叠一个性质），落 localStorage 跨重启保留。 */
const ASSET_CHAT_COLLAPSED_KEY = 'devwork-asset-chat-collapsed';

export function readStoredAssetChatCollapsed(): boolean {
  try {
    return localStorage.getItem(ASSET_CHAT_COLLAPSED_KEY) === '1';
  } catch {
    /* localStorage 不可用时默认展开（用户想看到会话）。 */
  }
  return false;
}

export interface CitationState {
  id: number;
  top: number;
  left: number;
}

/**
 * 会话区右侧的**悬浮气泡面板**。
 *
 * 原来「上下文 / 执行 / 产物」是右栏里的三个常驻 Tab，但它们回答的是
 * 「刚才那轮到底怎么回事」——**追问型**信息，而不是「我现在在做什么」的常驻信息。
 * 摆在右栏常驻，会把右栏这个位置占满，真正的工具位（浏览器 / 文件）反而没地方放。
 * 所以改成：三个悬浮按钮贴在会话区右缘，点开才出气泡，问完即收。
 */
export type HudPane = 'ctx' | 'run' | 'out' | null;

/** 右栏工作台的 Tab：内置浏览器 / 文件查看 / 终端。 */
export type BenchTab = 'browser' | 'file' | 'term';

export type ModalSpec =
  | {
      kind: 'confirm';
      title: string;
      body: string;
      confirmLabel: string;
      danger?: boolean;
      onConfirm: () => void;
    }
  | { kind: 'info'; title: string; body: string; mono?: boolean }
  | {
      kind: 'prompt';
      title: string;
      label: string;
      placeholder?: string;
      confirmLabel: string;
      /** B20：密码遮蔽（模型 Key 等秘密输入不回显）。 */
      masked?: boolean;
      onSubmit: (value: string) => void;
    }
  | { kind: 'command'; title: string; command: string; body: string }
  | { kind: 'files'; title: string; files: string[]; onPick: (file: string) => void };

export interface AppState {
  view: ViewName;
  readOnly: boolean;
  /** 主题偏好：跟随系统 / 浅色 / 深色。客户端偏好，落 localStorage。 */
  theme: Theme;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  workspaceId: string;
  activeConversationId: string;
  /** 当前选中的资产 id：代码库详情页据此绑定自己的本地仓库（不再写死 a-order-service）。 */
  activeAssetId: string;
  activeConversationTitle: string;
  extraConversations: ConvItem[];
  /** 资产会话坞：当前在页面内显示的资产会话（null = 未唤起）。 */
  assetChat: AssetChatState | null;
  /** 资产会话坞是否折叠（折叠 = 只留一条窄边条，页面空间全还给内容）。 */
  assetChatCollapsed: boolean;
  threads: Record<string, Message[]>;
  /** 会话区右侧悬浮气泡：当前展开的面板（null = 全收）。 */
  hudPane: HudPane;
  /** 右栏工作台当前 Tab。 */
  benchTab: BenchTab;
  /** 内置浏览器当前地址（用户手动导航与 Agent 导航共用这一份）。 */
  browserUrl: string;
  /** 右栏「文件」Tab 已打开的产物标签页（按打开顺序，可多个并存）。 */
  artifactTabs: { id: string; name: string }[];
  /** 右栏「文件」Tab 正在查看的产物（= artifactTabs 里的激活项；null = 无打开项）。 */
  artifactView: { id: string; name: string } | null;
  detailTab: string;
  /** 资产配置抽屉（能力授权 / 凭据 / 资产信息）是否打开。 */
  configOpen: boolean;
  settingsSection: string;
  orgSection: string;
  ctxTokens: number;
  cost: number;
  statusText: string;
  statusNote: string;
  model: string;
  apiMode: 'live' | 'mock';
  toasts: ToastItem[];
  paletteOpen: boolean;
  helpOpen: boolean;
  modal: ModalSpec | null;
  citation: CitationState | null;
  approvalSeq: number;
  hotkey: { kind: HotkeyKind; seq: number } | null;
  projects: Project[];
  /** 待粘贴到终端的命令（审批/建议卡「复制并去终端」链路）。 */
  termPreset: string;
  /** 待打开的源文件定位（引用浮层「打开」→ 编辑器跳到对应行）。 */
  pendingSource: { path: string; line?: number } | null;
  /** 数据浏览「右键按此值筛选」→ SQL 查询页待回填的语句（消费后清空）。 */
  sqlPreset: string | null;
  /** 会话级模型选择：conversationId → 模型名（空 = 跟随全局默认）。 */
  conversationModels: Record<string, string>;
}

export interface StoreApi {
  state: AppState;
  navigate: (view: ViewName) => void;
  /** 开 / 关会话区右侧的悬浮气泡面板。 */
  setHudPane: (pane: HudPane) => void;
  /** 切换右栏工作台 Tab。 */
  setBenchTab: (tab: BenchTab) => void;
  /** 更新内置浏览器地址。 */
  setBrowserUrl: (url: string) => void;
  /** 在右栏「文件」Tab 里打开某个产物（已开则聚焦，未开则新增标签页）。 */
  openArtifact: (artifact: { id: string; name: string }) => void;
  /** 关闭「文件」Tab 里的某个标签页（关闭的是激活页时激活邻位）。 */
  closeArtifact: (id: string) => void;
  /** 切换「文件」Tab 的激活标签页。 */
  setArtifactActive: (id: string) => void;
  /** 切换主题：写入 localStorage + 立即生效（App 的 effect 负责落 DOM）。 */
  setTheme: (theme: Theme) => void;
  setDetailTab: (tab: string) => void;
  /** 打开 / 关闭资产配置抽屉。 */
  setConfigOpen: (open: boolean) => void;
  setSettingsSection: (section: string) => void;
  setOrgSection: (section: string) => void;
  toggleReadOnly: () => void;
  setReadOnly: (value: boolean) => void;
  toggleLeft: () => void;
  toggleRight: () => void;
  setRightCollapsed: (value: boolean) => void;
  setWorkspace: (id: string) => void;
  /** 选中资产：详情页据此决定读哪个本地仓库。 */
  setActiveAsset: (id: string) => void;
  setConversation: (id: string, title: string) => void;
  newConversation: () => void;
  /**
   * 从资产详情页唤起 AI 会话：**每次调用都新建一条会话**（会话列表里看得见），
   * 并把该会话绑定到当前资产上。
   */
  openAssetChat: (input: { assetId: string; assetName: string; assetType: string }) => void;
  /** 关闭页面内的会话坞（会话本身保留在会话列表里）。 */
  closeAssetChat: () => void;
  /** 折叠 / 展开会话坞（布局形态切换，状态落 localStorage）。 */
  toggleAssetChatCollapsed: () => void;
  /** B21：会话重命名 —— 本地立即生效，服务端 PATCH 落库。 */
  renameConversation: (id: string, title: string) => void;
  /** B21：会话删除 —— 服务端 DELETE 后本地清理并回落到默认会话。 */
  removeConversation: (id: string) => void;
  /** 会话归档：侧栏收起，进入设置页「会话归档」管理（可恢复 / 彻底删除）。 */
  archiveConversation: (id: string) => void;
  /** 从归档恢复：会话回到原文件夹，侧栏重新可见。 */
  unarchiveConversation: (id: string) => void;
  addProject: (name: string) => void;
  /** 追加消息到指定会话（默认追加到当前会话）。 */
  sendMessage: (text: string, assistantCards?: Message[], conversationId?: string) => void;
  /**
   * 消息时间线截断（本地镜像）：撤回 / 编辑重发 / 重试共用。
   * inclusive 连目标一起删；after 保留目标（用户气泡）删其后全部内容。
   * 服务端落库由 api.truncateMessages 负责，这里只管 threads 里的展示态。
   */
  truncateThread: (conversationId: string, messageId: string, mode: 'inclusive' | 'after') => void;
  /** 只追加助手卡片（重试回填）：用户气泡已存在，任何 user 卡都被过滤掉。 */
  appendAssistantCards: (conversationId: string, cards: Message[]) => void;
  /** B18：发送消息后用服务端真实用量估算更新顶栏（contextUsed→k、costCny）。 */
  applyUsage: (usage: { contextUsed?: number; costCny?: number }) => void;
  addToast: (text: string) => void;
  setPalette: (open: boolean) => void;
  setHelp: (open: boolean) => void;
  setModal: (modal: ModalSpec | null) => void;
  setCitation: (citation: CitationState | null) => void;
  focusApproval: () => void;
  emit: (kind: HotkeyKind) => void;
  setTermPreset: (command: string) => void;
  /** 数据浏览右键筛选 → SQL 查询页回填（消费方读后应清空）。 */
  setSqlPreset: (sql: string | null) => void;
  /** ChatView 发起流式请求前注册 AbortController；stopGeneration 调用它真中断。 */
  registerAbort: (controller: AbortController | null) => void;
  /** 打开源文件并跳到指定行；无路径的引用不走这里（UI 应禁用「打开」）。 */
  openSource: (path: string, line?: number) => void;
  /** CodeDetail 消费完待打开定位后调用，避免每次渲染重复跳转。 */
  consumeSource: () => void;
  /** 文件夹 / 资产 / 会话发生写操作后重拉侧栏（含折叠状态与计数）。 */
  reloadSidebar: () => Promise<void>;
  setStatus: (text: string) => void;
  setModel: (name: string) => void;
  /** 会话级模型切换：只影响该会话下一条消息，不改服务端全局模型配置。 */
  setConversationModel: (conversationId: string, model: string) => void;
  setApiMode: (mode: 'live' | 'mock') => void;
  stopGeneration: () => void;
  hydrateFromRest: (payload: {
    projects?: Project[];
    statusBar?: { model?: string; contextUsed?: number; costCny?: number; state?: string };
    readOnlyMode?: boolean;
    threads?: Record<string, Message[]>;
    /** 服务端判定的当前会话：切项目后前端不能再假设是 c-gmv。 */
    activeConversationId?: string;
    activeConversationTitle?: string;
  }) => void;
}

/**
 * 初始状态。
 *
 * 打包态（__PACKAGED__）：项目列表与会话消息**初始为空** ——
 * 交付给用户的程序不该一打开就显示 GMV 归因这类演示内容。
 * 真实数据由 App.tsx 的 bootstrap 流程从后端灌进来；
 * 后端确实没有数据时，就诚实地空着。
 *
 * 开发态：保留原型初始值，本地没起后端也能看到完整界面。
 */
const INITIAL_STATE: AppState = {
  view: 'chat',
  readOnly: true,
  theme: readStoredTheme(),
  leftCollapsed: false,
  rightCollapsed: false,
  workspaceId: 'w-ops',
  activeConversationId: __PACKAGED__ ? '' : 'c-gmv',
  activeAssetId: 'a-order-service',
  activeConversationTitle: __PACKAGED__ ? '' : 'GMV 归因',
  extraConversations: [],
  assetChat: null,
  assetChatCollapsed: readStoredAssetChatCollapsed(),
  threads: __PACKAGED__ ? {} : MOCK_SNAPSHOT.INITIAL_THREADS,
  hudPane: null,
  benchTab: 'browser',
  browserUrl: '',
  artifactTabs: [],
  artifactView: null,
  detailTab: 'main',
  configOpen: false,
  settingsSection: 'gen',
  orgSection: 'm',
  ctxTokens: 32,
  cost: 0.42,
  statusText: '就绪',
  statusNote: '',
  model: 'Claude-Sonnet',
  apiMode: 'mock',
  toasts: [],
  paletteOpen: false,
  helpOpen: false,
  modal: null,
  citation: null,
  approvalSeq: 0,
  hotkey: null,
  projects: MOCK_SNAPSHOT.PROJECTS,
  termPreset: '',
  pendingSource: null,
  sqlPreset: null,
  conversationModels: readStoredConversationModels(),
};

const StoreContext = createContext<StoreApi | null>(null);

/** 资产类型 → 中文名（会话坞提示文案用）。 */
const ASSET_TYPE_LABEL: Record<string, string> = {
  code: '代码库',
  db: '数据库',
  server: '服务器',
  kb: '知识库',
};

/** 读取全局状态；必须在 StoreProvider 内使用。 */
export function useStore(): StoreApi {
  const ctx = useContext(StoreContext);
  if (!ctx) {
    throw new Error('useStore 必须在 StoreProvider 内部使用');
  }
  return ctx;
}

export function StoreProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [state, setState] = useState<AppState>(INITIAL_STATE);
  /* 回调里需要「当前」工作区，但 useCallback 不能依赖 state 否则每次渲染都换引用；
   * stateRef 让 newConversation 这类命令式动作读到最新值，而不是写死 'w-ops'。 */
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;
  const toastSeq = useRef<number>(0);
  const msgSeq = useRef<number>(0);
  const convSeq = useRef<number>(0);
  /** 资产会话坞的会话序号：按资产分别计数（同资产的第 2 条才叫「(2)」）。 */
  const assetSeq = useRef<Record<string, number>>({});
  const hotkeySeq = useRef<number>(0);

  const patch = useCallback((partial: Partial<AppState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  const addToast = useCallback((text: string) => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setState((prev) => ({ ...prev, toasts: [...prev.toasts, { id, text }] }));
    window.setTimeout(() => {
      setState((prev) => ({ ...prev, toasts: prev.toasts.filter((t) => t.id !== id) }));
    }, 2600);
  }, []);

  /** 切换中栏视图；进入详情页时直接落在主功能区（概览已并入配置抽屉）。 */
  const navigate = useCallback((view: ViewName) => {
    setState((prev) => ({
      ...prev,
      view,
      detailTab: view.startsWith('detail-') ? 'main' : prev.detailTab,
      configOpen: false,
      statusText: '就绪',
      citation: null,
    }));
  }, []);

  const setHudPane = useCallback((pane: HudPane) => patch({ hudPane: pane }), [patch]);
  const setBenchTab = useCallback((tab: BenchTab) => patch({ benchTab: tab }), [patch]);
  const setBrowserUrl = useCallback((url: string) => patch({ browserUrl: url }), [patch]);
  /** 在右栏打开产物：切到「文件」Tab 并展开右栏 —— 产物不该只在气泡里看一眼。
   * 多标签：已开则聚焦，未开则追加；上限 12 个，超出挤掉最旧的非激活页。 */
  const openArtifact = useCallback((artifact: { id: string; name: string }) => {
    setState((prev) => {
      const tabs = prev.artifactTabs;
      const exists = tabs.some((tab) => tab.id === artifact.id);
      let nextTabs = tabs;
      if (!exists) {
        nextTabs = [...tabs, artifact];
        if (nextTabs.length > 12) {
          const drop = nextTabs.findIndex((tab) => tab.id !== artifact.id);
          if (drop >= 0) nextTabs = nextTabs.filter((_, index) => index !== drop);
        }
      }
      return {
        ...prev,
        benchTab: 'file',
        rightCollapsed: false,
        artifactTabs: nextTabs,
        artifactView: artifact,
      };
    });
  }, []);

  /** 关闭标签页；关的是激活页时优先激活右侧邻居，否则左侧。 */
  const closeArtifact = useCallback((id: string) => {
    setState((prev) => {
      const index = prev.artifactTabs.findIndex((tab) => tab.id === id);
      if (index < 0) return prev;
      const tabs = prev.artifactTabs.filter((tab) => tab.id !== id);
      let active = prev.artifactView;
      if (active?.id === id) {
        active = tabs[index] ?? tabs[index - 1] ?? null;
      }
      return { ...prev, artifactTabs: tabs, artifactView: active };
    });
  }, []);

  const setArtifactActive = useCallback((id: string) => {
    setState((prev) => {
      const tab = prev.artifactTabs.find((item) => item.id === id);
      return tab ? { ...prev, artifactView: tab } : prev;
    });
  }, []);
  const setTheme = useCallback((theme: Theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 存不进去也不影响本次会话内的切换。 */
    }
    patch({ theme });
  }, [patch]);
  const setDetailTab = useCallback((tab: string) => patch({ detailTab: tab }), [patch]);
  const setConfigOpen = useCallback((open: boolean) => patch({ configOpen: open }), [patch]);
  const setSettingsSection = useCallback((section: string) => patch({ settingsSection: section }), [patch]);
  const setOrgSection = useCallback((section: string) => patch({ orgSection: section }), [patch]);
  const setRightCollapsed = useCallback((value: boolean) => patch({ rightCollapsed: value }), [patch]);
  const setStatus = useCallback((text: string) => patch({ statusText: text }), [patch]);
  const setModel = useCallback((name: string) => patch({ model: name }), [patch]);
  /** 会话级模型切换：写内存 + 落 localStorage（客户端偏好，跨重启保留）。 */
  const setConversationModel = useCallback((conversationId: string, model: string) => {
    setState((prev) => {
      const next = { ...prev.conversationModels };
      if (model) next[conversationId] = model;
      else delete next[conversationId];
      try {
        localStorage.setItem(CONVERSATION_MODELS_KEY, JSON.stringify(next));
      } catch {
        /* 存不进去也不影响本次会话内的切换。 */
      }
      return { ...prev, conversationModels: next };
    });
  }, []);
  const setApiMode = useCallback((mode: 'live' | 'mock') => patch({ apiMode: mode }), [patch]);
  const setPalette = useCallback((open: boolean) => patch({ paletteOpen: open, helpOpen: false }), [patch]);
  const setHelp = useCallback((open: boolean) => patch({ helpOpen: open, paletteOpen: false }), [patch]);
  const setModal = useCallback((modal: ModalSpec | null) => patch({ modal }), [patch]);
  const setCitation = useCallback((citation: CitationState | null) => patch({ citation }), [patch]);

  const toggleReadOnly = useCallback(() => {
    setState((prev) => ({ ...prev, readOnly: !prev.readOnly }));
  }, []);

  const setReadOnly = useCallback((value: boolean) => patch({ readOnly: value }), [patch]);

  const toggleLeft = useCallback(() => {
    setState((prev) => {
      const next = !prev.leftCollapsed;
      return { ...prev, leftCollapsed: next, statusNote: next ? '左栏已折叠' : '' };
    });
  }, []);

  const toggleRight = useCallback(() => {
    setState((prev) => {
      const next = !prev.rightCollapsed;
      return { ...prev, rightCollapsed: next, statusNote: next ? '右栏已折叠' : '' };
    });
  }, []);

  /** 会话历史懒加载：本地已有内容不覆盖；切走后不注入（避免竞态串台）。 */
  const loadThread = useCallback((id: string) => {
    void restApi
      .listMessages(id)
      .then((envelope) => {
        if (!envelope.ok || !Array.isArray(envelope.data) || envelope.data.length === 0) return;
        const cards = cardsToThread(envelope.data);
        if (cards.length === 0) return;
        setState((prev) => {
          if (prev.activeConversationId !== id) return prev;
          if ((prev.threads[id] ?? []).length > 0) return prev;
          return { ...prev, threads: { ...prev.threads, [id]: cards } };
        });
      })
      .catch(() => undefined);
  }, []);

  const setWorkspace = useCallback(
    (id: string) => {
      let target: ConvItem | undefined;
      setState((prev) => {
        const project = prev.projects.find((p) => p.id === id);
        /* 取该项目下第一个非空文件夹里的会话；全空时再看散装会话。 */
        const firstInFolders = project?.sidebar.convFolders
          .map((folder) => folder.items[0])
          .find((item): item is ConvItem => !!item);
        target = project ? firstInFolders ?? project.sidebar.looseConvs[0] : undefined;
        return {
          ...prev,
          workspaceId: id,
          view: 'chat',
          activeConversationId: target?.id ?? prev.activeConversationId,
          activeConversationTitle: target?.title ?? prev.activeConversationTitle,
          statusText: '就绪',
          statusNote: project ? `已切换至 ${project.name} · 索引 ${project.index}%` : '',
          citation: null,
        };
      });
      /* 切项目必须把目标会话的消息拉回来，否则切过去是一片空白对话。 */
      if (target) loadThread(target.id);
      addToast('已切换项目 · 后台任务不中断，结果仍回到原项目会话');
    },
    [addToast, loadThread],
  );

  /* 选中资产：代码库 / 数据库等详情页据此绑定自己的本地仓库与数据源。 */
  const setActiveAsset = useCallback((id: string) => {
    patch({ activeAssetId: id });
  }, [patch]);

  /* B20：切换会话 + 真历史懒加载 —— 本地无线索时拉服务端消息卡；
   * 已有本地会话（欢迎语/进行中消息）不覆盖；已切走不注入。 */
  const setConversation = useCallback((id: string, title: string) => {
    setState((prev) => ({
      ...prev,
      view: 'chat',
      activeConversationId: id,
      activeConversationTitle: title,
      citation: null,
      statusText: '就绪',
    }));
    loadThread(id);
  }, [loadThread]);

  const newConversation = useCallback(() => {
    convSeq.current += 1;
    const seq = convSeq.current;
    const localId = `c-new-${seq}`;
    const title = `新会话 ${seq}`;
    setState((prev) => ({
      ...prev,
      view: 'chat',
      extraConversations: [...prev.extraConversations, { id: localId, title }],
      activeConversationId: localId,
      activeConversationTitle: title,
      threads: {
        ...prev.threads,
        [localId]: [
          {
            id: `m-${localId}`,
            kind: 'text' as const,
            text: '开始第一次对话。可以试试：查一下订单库最近 1 小时的慢查询 / 看一下 order-service 的重试逻辑 / 生成一份季度复盘。',
          },
        ],
      },
      citation: null,
      statusText: '就绪',
    }));
    /* B20：会话真持久化 —— 服务端创建成功后把本地临时 ID 换成真实 ID，
     * 之后发消息/历史/用量都落到同一个服务端会话。离线时保留本地 ID（mock 兜底）。 */
    void restApi
      .createConversation({ workspaceId: stateRef.current.workspaceId, title })
      .then((envelope) => {
        const realId = envelope.ok ? envelope.data.id : '';
        if (!realId || realId === 'c-new') return; // 离线假 ID 不换
        setState((prev) => {
          const threads = { ...prev.threads };
          const thread = threads[localId];
          delete threads[localId];
          if (thread) threads[realId] = thread;
          return {
            ...prev,
            extraConversations: prev.extraConversations.map((c) => (c.id === localId ? { ...c, id: realId } : c)),
            activeConversationId: prev.activeConversationId === localId ? realId : prev.activeConversationId,
            threads,
          };
        });
      })
      .catch(() => undefined);
    addToast('已新建会话');
  }, [addToast]);

  /* B21：会话重命名 —— 活动会话改标题、extraConversations 同步；服务端 PATCH 落库（离线 mock 兜底 ok）。 */
  const renameConversation = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) {
      addToast('名称不能为空');
      return;
    }
    setState((prev) => ({
      ...prev,
      activeConversationTitle: prev.activeConversationId === id ? trimmed : prev.activeConversationTitle,
      extraConversations: prev.extraConversations.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
    }));
    void restApi
      .updateConversation(id, { title: trimmed })
      .then((envelope) => {
        addToast(envelope.ok ? '会话已重命名' : `重命名失败：${envelope.error?.message ?? '未知错误'}`);
      })
      .catch(() => addToast('重命名失败：网络异常'));
  }, [addToast]);

  /* B21：会话删除 —— 服务端 DELETE 后本地清理；删除的是活动会话则回落到默认会话。 */
  const removeConversation = useCallback(
    (id: string) => {
      setState((prev) => {
        const threads = { ...prev.threads };
        delete threads[id];
        const wasActive = prev.activeConversationId === id;
        return {
          ...prev,
          threads,
          extraConversations: prev.extraConversations.filter((c) => c.id !== id),
          activeConversationId: wasActive ? 'c-gmv' : prev.activeConversationId,
          activeConversationTitle: wasActive ? 'GMV 归因' : prev.activeConversationTitle,
        };
      });
      void restApi
        .deleteConversation(id)
        .then((envelope) => {
          addToast(envelope.ok ? '会话已删除' : `删除失败：${envelope.error?.message ?? '未知错误'}`);
        })
        .catch(() => addToast('删除失败：网络异常'));
      addToast('正在删除会话…');
    },
    [addToast],
  );

  /**
   * 写操作后的侧栏刷新：一次拉全部工作区的 sidebar，按 id 合并回 projects。
   *
   * 声明位置有讲究：archiveConversation / unarchiveConversation 的 useCallback
   * 依赖数组里要引用它，而依赖数组在**每次渲染时立即求值** —— 若本函数声明在
   * 它们之后，const 的暂时性死区（TDZ）会让 StoreProvider 首次渲染就抛
   * "Cannot access 'reloadSidebar' before initialization"，整页白屏。
   * 本函数不依赖任何后声明的 state，提到使用点之前即可。
   */
  const reloadSidebar = useCallback(async () => {
    const workspaces = await restApi.listWorkspaces();
    if (!workspaces.ok || !Array.isArray(workspaces.data)) return;
    const sidebars = await Promise.all(workspaces.data.map((workspace) => restApi.getSidebar(workspace.id)));
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((project) => {
        const index = workspaces.data.findIndex((workspace) => workspace.id === project.id);
        const sidebar = index >= 0 ? sidebars[index] : undefined;
        return sidebar?.ok ? { ...project, sidebar: toSidebarData(sidebar.data) } : project;
      }),
    }));
  }, []);

  /* 会话归档：从侧栏收起（服务端记 archived_at），设置页「会话归档」里可恢复 / 彻底删除。
   * 归档的是活动会话时回落到默认会话 —— 与 removeConversation 同一套回落语义。 */
  const archiveConversation = useCallback(
    (id: string) => {
      setState((prev) => {
        const wasActive = prev.activeConversationId === id;
        return {
          ...prev,
          extraConversations: prev.extraConversations.filter((c) => c.id !== id),
          activeConversationId: wasActive ? 'c-gmv' : prev.activeConversationId,
          activeConversationTitle: wasActive ? 'GMV 归因' : prev.activeConversationTitle,
        };
      });
      void restApi
        .updateConversation(id, { archived: true })
        .then((envelope) => {
          addToast(envelope.ok ? '会话已归档 · 设置页可恢复或删除' : `归档失败：${envelope.error?.message ?? '未知错误'}`);
          void reloadSidebar();
        })
        .catch(() => addToast('归档失败：网络异常'));
    },
    [addToast, reloadSidebar],
  );

  /* 从归档恢复：清 archived_at，会话回到原文件夹（folder_id 一直留着，恢复即归位）。 */
  const unarchiveConversation = useCallback(
    (id: string) => {
      void restApi
        .updateConversation(id, { archived: false })
        .then((envelope) => {
          addToast(envelope.ok ? '会话已恢复到侧栏' : `恢复失败：${envelope.error?.message ?? '未知错误'}`);
          void reloadSidebar();
        })
        .catch(() => addToast('恢复失败：网络异常'));
    },
    [addToast, reloadSidebar],
  );

  const addProject = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        addToast('项目名称不能为空');
        return;
      }
      setState((prev) => ({
        ...prev,
        projects: [
          ...prev.projects,
          {
            id: `w-new-${prev.projects.length + 1}`,
            name: trimmed,
            desc: '新项目 · 尚未接入资产，索引准备中。',
            index: 0,
            assetsLabel: '0 个资产',
            convLabel: '0 个会话',
            owner: '仅我',
            recent: '刚刚',
            sidebar: {
              assetFolders: [],
              looseAssets: [],
              convFolders: [],
              looseConvs: [],
            },
          },
        ],
      }));
      addToast(`已创建项目「${trimmed}」`);
    },
    [addToast],
  );

  /**
   * 追加用户消息 + 助手轨迹，并更新计量与状态栏。
   * assistantCards 由 api.sendMessage() 返回的结构化卡片转换而来；离线时 fallback 到内置轨迹。
   * conversationId 缺省追加到当前会话；资产会话坞走自己的会话，必须显式传。
   */
  const sendMessage = useCallback((text: string, assistantCards?: Message[], conversationId?: string) => {
    const clean = text.trim();
    if (!clean) return;
    const base = ++msgSeq.current;
    const localReply: Message[] = [
      { id: `m-u-${base}`, kind: 'user', text: clean, chips: [] },
      {
        id: `m-t-${base}`,
        kind: 'text',
        text: '已收到。正在检索已挂载资产并整理上下文，随后给出结论。',
      },
      {
        id: `m-tool-${base}`,
        kind: 'tool',
        name: 'kb_search + pg_sql_query',
        status: '已自动放行',
        ms: '0.6s',
        args: `{\n  "query": ${JSON.stringify(clean)},\n  "assets": ["生产库", "运营知识库"],\n  "read_only": true,\n  "limit": 1000\n}`,
        result: '检索命中 3 个片段 · 采样 20 行 · 只读模式：未执行任何写操作\n完整结果落盘：~/.devwork/runs/latest/tool.json',
      },
      {
        id: `m-c-${base}`,
        kind: 'conclusion',
        confidence: '0.86',
        paras: [
          [
            { t: 'text' as const, v: '已完成分析：' },
            { t: 'strong' as const, v: clean },
            { t: 'text' as const, v: '。本次仅使用只读检索，未对生产环境产生任何写操作。' },
          ],
        ],
      },
    ];
    const reply = assistantCards && assistantCards.length > 0 ? assistantCards : localReply;
    setState((prev) => {
      const target = conversationId ?? prev.activeConversationId;
      const current = prev.threads[target] ?? [];
      /* 假计量只在离线 Mock 兜底时执行；live 模式的真值由 applyUsage 从服务端取回，
       * 否则每次发送都会把真实用量顶掉 +1k/+0.03 的编造值。 */
      const mock = prev.apiMode === 'mock';
      return {
        ...prev,
        threads: { ...prev.threads, [target]: [...current, ...reply] },
        ctxTokens: mock ? Math.min(200, prev.ctxTokens + 1) : prev.ctxTokens,
        cost: mock ? Number((prev.cost + 0.03).toFixed(2)) : prev.cost,
        statusText: '已响应 · 0.6s',
      };
    });
  }, []);

  /** 本地时间线截断：按消息 id 定位（活体消息 id 与服务端一致），找不到则如实不动。 */
  const truncateThread = useCallback((conversationId: string, messageId: string, mode: 'inclusive' | 'after') => {
    setState((prev) => {
      const current = prev.threads[conversationId] ?? [];
      const index = current.findIndex((message) => message.id === messageId);
      if (index < 0) return prev;
      const kept = mode === 'after' ? current.slice(0, index + 1) : current.slice(0, index);
      return { ...prev, threads: { ...prev.threads, [conversationId]: kept } };
    });
  }, []);

  /** 重试回填：只追加助手卡片（服务端 regenerate 不回气泡；离线 mock 回了也滤掉）。 */
  const appendAssistantCards = useCallback((conversationId: string, cards: Message[]) => {
    const reply = cards.filter((card) => card.kind !== 'user');
    if (reply.length === 0) return;
    setState((prev) => {
      const current = prev.threads[conversationId] ?? [];
      return { ...prev, threads: { ...prev.threads, [conversationId]: [...current, ...reply] } };
    });
  }, []);

  const focusApproval = useCallback(() => {
    setState((prev) => ({
      ...prev,
      view: 'chat',
      approvalSeq: prev.approvalSeq + 1,
      citation: null,
    }));
  }, []);

  const emit = useCallback((kind: HotkeyKind) => {
    hotkeySeq.current += 1;
    const seq = hotkeySeq.current;
    setState((prev) => ({ ...prev, hotkey: { kind, seq } }));
  }, []);

  const setTermPreset = useCallback((command: string) => {
    setState((prev) => ({ ...prev, termPreset: command }));
  }, []);

  const setSqlPreset = useCallback((sql: string | null) => {
    setState((prev) => ({ ...prev, sqlPreset: sql }));
  }, []);

  /** 流式请求的中止控制器：ChatView 每次发送前注册，「停止生成」据此真中断 SSE。 */
  const abortRef = useRef<AbortController | null>(null);
  const registerAbort = useCallback((controller: AbortController | null) => {
    abortRef.current = controller;
  }, []);

  /** 停止生成：真中断当前 SSE 流（⌘. / Esc / 命令面板同一入口）。
   *  没有进行中的流时如实说明，不再假装"已停止"。 */
  const stopGeneration = useCallback(() => {
    const controller = abortRef.current;
    if (controller) {
      controller.abort();
      abortRef.current = null;
      setState((prev) => ({ ...prev, statusText: '已停止生成' }));
      addToast('已停止生成（流式请求已中断）');
    } else {
      addToast('当前没有进行中的生成任务');
    }
  }, [addToast]);

  /** 引用「打开」：切到代码详情并带行号，由 CodeDetail 消费后清空（避免重复跳转）。 */
  const openSource = useCallback((path: string, line?: number) => {
    setState((prev) => ({
      ...prev,
      view: 'detail-code',
      detailTab: 'main',
      citation: null,
      pendingSource: { path, line },
      statusText: `打开 ${path}${line ? `:${line}` : ''}`,
    }));
  }, []);

  const consumeSource = useCallback(() => {
    setState((prev) => (prev.pendingSource ? { ...prev, pendingSource: null } : prev));
  }, []);

  /**
   * 资产会话坞：从资产详情页（代码库 / 数据 / 终端）唤起 AI 会话。
   *
   * 三件事必须同时成立，缺一不可：
   *  ① **每次点击都是一条新会话** —— 会话列表里看得见、能回访；
   *  ② **会话默认绑定当前资产** —— 绑定写在服务端（conversation.asset_id），
   *     每一轮消息都会带上这个资产，Agent 天然就在这个资产的上下文里；
   *  ③ **会话区显示在当前页面** —— 不跳走，右侧浮出会话坞，页面本体还在。
   */
  const openAssetChat = useCallback(
    (input: { assetId: string; assetName: string; assetType: string }) => {
      const { assetId, assetName, assetType } = input;
      if (!assetId) {
        addToast('该资产没有 id，无法唤起会话');
        return;
      }
      assetSeq.current[assetId] = (assetSeq.current[assetId] ?? 0) + 1;
      const seq = assetSeq.current[assetId];
      const localId = `c-asset-${assetId}-${seq}`;
      const title = seq === 1 ? `AI 助手 · ${assetName}` : `AI 助手 · ${assetName} (${seq})`;
      const typeLabel = ASSET_TYPE_LABEL[assetType] ?? '资产';
      setState((prev) => ({
        ...prev,
        assetChat: { conversationId: localId, title, assetId, assetName, assetType },
        /* 点入口就是「我要看会话」：折叠状态下也要自动展开。 */
        assetChatCollapsed: false,
        /* 本地即时镜像：侧栏不等服务端回包就能看到这条会话。 */
        extraConversations: [...prev.extraConversations, { id: localId, title, assetId, assetType }],
        threads: {
          ...prev.threads,
          [localId]: [
            {
              id: `m-${localId}`,
              kind: 'notice' as const,
              level: 'info' as const,
              title: `已绑定资产 · ${assetName}`,
              content: `本会话默认挂在「${assetName}」（${typeLabel}）上：每一轮提问都会带上这个资产，Agent 只会读它，不会碰别的资产。\n可以直接提问，也可以用下面的快捷操作。`,
            },
          ],
        },
        statusText: '就绪',
      }));
      /* 服务端建会话（带资产绑定）→ 换成真实 id，之后发消息 / 历史 / 用量都落到同一条会话。 */
      void restApi
        .createConversation({
          workspaceId: stateRef.current.workspaceId,
          title,
          assetId,
          assetType,
        })
        .then((envelope) => {
          const realId = envelope.ok ? envelope.data.id : '';
          if (!realId || realId === 'c-new') return; // 离线假 id 不换
          setState((prev) => {
            const threads = { ...prev.threads };
            const thread = threads[localId];
            delete threads[localId];
            if (thread) threads[realId] = thread;
            return {
              ...prev,
              extraConversations: prev.extraConversations.map((c) =>
                c.id === localId ? { ...c, id: realId } : c,
              ),
              assetChat:
                prev.assetChat?.conversationId === localId
                  ? { ...prev.assetChat, conversationId: realId }
                  : prev.assetChat,
              threads,
            };
          });
        })
        .catch(() => undefined);
      /* 侧栏刷新：服务端会话列表里也要出现这条（本地 extraConversations 只是即时镜像）。 */
      void reloadSidebar();
      addToast(`已新建资产会话 · 绑定 ${assetName}`);
    },
    [addToast, reloadSidebar],
  );

  /** 关闭页面内的会话坞：会话本身保留在会话列表里，随时能回访。 */
  const closeAssetChat = useCallback(() => {
    setState((prev) => ({ ...prev, assetChat: null }));
  }, []);

  /**
   * 折叠 / 展开会话坞。
   *
   * 折叠不是「关掉」：折叠后只留一条窄边条，页面空间全还给内容，
   * 再点一下会话原样回来（草稿、消息都在）。这是布局偏好，落 localStorage。
   */
  const toggleAssetChatCollapsed = useCallback(() => {
    setState((prev) => {
      const next = !prev.assetChatCollapsed;
      try {
        localStorage.setItem(ASSET_CHAT_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* 存不下就算了：折叠状态退化成只在本次会话内有效。 */
      }
      return { ...prev, assetChatCollapsed: next, statusNote: next ? '会话区已折叠' : '' };
    });
  }, []);

  /** 启动时把 REST 数据注入全局状态；断后端时保留内置 mock（视觉零差异）。 */
  const hydrateFromRest = useCallback(
    (payload: {
      projects?: Project[];
      statusBar?: { model?: string; contextUsed?: number; costCny?: number; state?: string };
      readOnlyMode?: boolean;
      threads?: Record<string, Message[]>;
      activeConversationId?: string;
      activeConversationTitle?: string;
    }) => {
      setState((prev) => ({
        ...prev,
        activeConversationId: payload.activeConversationId ?? prev.activeConversationId,
        activeConversationTitle: payload.activeConversationTitle ?? prev.activeConversationTitle,
        projects: payload.projects && payload.projects.length > 0 ? payload.projects : prev.projects,
        threads:
          payload.threads && Object.keys(payload.threads).length > 0
            ? { ...prev.threads, ...payload.threads }
            : prev.threads,
        readOnly: typeof payload.readOnlyMode === 'boolean' ? payload.readOnlyMode : prev.readOnly,
        model: payload.statusBar?.model ?? prev.model,
        cost: typeof payload.statusBar?.costCny === 'number' ? payload.statusBar.costCny : prev.cost,
        ctxTokens:
          typeof payload.statusBar?.contextUsed === 'number'
            ? Math.round(payload.statusBar.contextUsed / 1024)
            : prev.ctxTokens,
        statusText: payload.statusBar?.state ?? prev.statusText,
      }));
    },
    [],
  );

  /** B18：上下文用量真值 —— 服务端按消息体量估算，不再 +1k/+0.03 模拟。 */
  const applyUsage = useCallback((usage: { contextUsed?: number; costCny?: number }) => {
    setState((prev) => ({
      ...prev,
      ctxTokens:
        typeof usage.contextUsed === 'number'
          ? Math.max(1, Math.round(usage.contextUsed / 1024))
          : prev.ctxTokens,
      cost: typeof usage.costCny === 'number' ? Number(usage.costCny.toFixed(2)) : prev.cost,
    }));
  }, []);

  const api = useMemo<StoreApi>(
    () => ({
      state,
      navigate,
      setHudPane,
      setBenchTab,
      setBrowserUrl,
      openArtifact,
      closeArtifact,
      setArtifactActive,
      setTheme,
      setDetailTab,
      setConfigOpen,
      setSettingsSection,
      setOrgSection,
      toggleReadOnly,
      setReadOnly,
      toggleLeft,
      toggleRight,
      setRightCollapsed,
      setWorkspace,
      setActiveAsset,
      setConversation,
      newConversation,
      openAssetChat,
      closeAssetChat,
      toggleAssetChatCollapsed,
      renameConversation,
      removeConversation,
      archiveConversation,
      unarchiveConversation,
      addProject,
      sendMessage,
      truncateThread,
      appendAssistantCards,
      applyUsage,
      addToast,
      setPalette,
      setHelp,
      setModal,
      setCitation,
      focusApproval,
      emit,
      setTermPreset,
      setSqlPreset,
      registerAbort,
      openSource,
      consumeSource,
      reloadSidebar,
      setStatus,
      setModel,
      setConversationModel,
      setApiMode,
      stopGeneration,
      hydrateFromRest,
    }),
    [
      state,
      navigate,
      setHudPane,
      setBenchTab,
      setBrowserUrl,
      openArtifact,
      closeArtifact,
      setArtifactActive,
      setTheme,
      setDetailTab,
      setConfigOpen,
      setSettingsSection,
      setOrgSection,
      toggleReadOnly,
      setReadOnly,
      toggleLeft,
      toggleRight,
      setRightCollapsed,
      setWorkspace,
      setActiveAsset,
      setConversation,
      newConversation,
      openAssetChat,
      closeAssetChat,
      toggleAssetChatCollapsed,
      renameConversation,
      removeConversation,
      archiveConversation,
      unarchiveConversation,
      addProject,
      sendMessage,
      truncateThread,
      appendAssistantCards,
      applyUsage,
      addToast,
      setPalette,
      setHelp,
      setModal,
      setCitation,
      focusApproval,
      emit,
      setTermPreset,
      setSqlPreset,
      registerAbort,
      openSource,
      consumeSource,
      reloadSidebar,
      setStatus,
      setModel,
      setConversationModel,
      setApiMode,
      stopGeneration,
      hydrateFromRest,
    ],
  );

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}
