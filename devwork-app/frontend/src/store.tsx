import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  ConvItem,
  Message,
  Project,
  ViewName,
  WaitingTicket,
} from './api/client';
/* B2：初始状态只取 api 层的离线 fallback 快照，组件不直接引用 src/data/mock.ts。
 * 启动后由 App.bootstrap()/hydrateFromRest() 用 REST 结果整体覆盖。 */
import { MOCK_SNAPSHOT } from './api/mock';
import { api as restApi, setCurrentWorkspaceId } from './api/client';
import { cardsToThread, toSidebarData } from './api/adapters';
import { waitingLevel } from './utils/waiting';

/**
 * 合并本轮返回的卡片到时间线：**同 id 原位替换，其余追加**。
 *
 * 为什么不能直接 concat：任务清单卡是"一张卡原位更新"的（服务端每次更新都
 * 回传同一个消息 id）。直接追加会让长任务每推进一步就多一张清单，
 * 20 步之后时间线全是清单副本，用户反而看不出进度。
 */
function mergeThread(current: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return current;
  const next = [...current];
  incoming.forEach((card) => {
    const index = next.findIndex((item) => item.id === card.id);
    if (index >= 0) next[index] = card;
    else next.push(card);
  });
  return next;
}

/* ===================== 类型 ===================== */

export type HotkeyKind = 'send' | 'sqlRun' | 'openFile' | 'saveCode' | 'clearTerm' | 'stop' | 'find';

/** 主题偏好。'system' 跟随 prefers-color-scheme，实际生效值由 App 解析。 */
export type Theme = 'system' | 'light' | 'dark';export const THEME_LABEL: Record<Theme, string> = { system: '跟随系统', light: '浅色', dark: '深色' };
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
 * 侧边工作区能装的内容类型。
 *
 * 只放**详情**：清单类内容（产物列表）不进工作区，用浮层选完再开详情 tab。
 *   ctx     —— 上下文：这一轮它看到了什么、走了几步
 *   todo    —— 任务列表：长任务的待办清单与进度
 *   browser —— 内置浏览器：看网页（Agent 也能导航它）
 *   artifact—— 单个产物的详情预览（按文件区分，可并存多个）
 *
 * 入口只有会话右缘那四个固定图标，kind 与入口一一对应；
 * 产物是唯一「一个文件一个 tab」的 kind，它的入口先弹选择浮层。
 */
export type BenchPaneKind = 'ctx' | 'todo' | 'browser' | 'artifact';

/** 工作区里一个 tab。key 唯一：常驻类 kind 就用 kind 本身，产物用 `artifact:<id>`。 */
export interface BenchTab {
  key: string;
  kind: BenchPaneKind;
  title: string;
  /** kind === 'artifact' 时指向哪个产物。 */
  artifactId?: string;
}

/** 各类内容在 tab 上的默认标题（产物 tab 用文件名，不查这张表）。 */
export const BENCH_TITLES: Record<Exclude<BenchPaneKind, 'artifact'>, string> = {
  ctx: '上下文',
  todo: '任务列表',
  browser: '浏览器',
};

/** 工作区 tab 上限：再多就不是「并排看几个」，而是把 tab 栏当历史列表用了。 */
const BENCH_TAB_LIMIT = 12;

/** 追加 tab 并保留最近 N 个（已经在里面的不重复加）。 */
function pushBenchTab(tabs: BenchTab[], tab: BenchTab): BenchTab[] {
  if (tabs.some((item) => item.key === tab.key)) {
    return tabs.map((item) => (item.key === tab.key ? { ...item, title: tab.title } : item));
  }
  return [...tabs, tab].slice(-BENCH_TAB_LIMIT);
}

/**
 * 会话标签页 —— 主区域顶部那一排，每个 tab 一条会话。
 *
 * 与 `activeConversationId` 的分工：
 *   **tabs 回答「打开了哪些」，activeConversationId 回答「正在看哪个」。**
 * 只加 tab 而不改 active 的语义，是为了让所有读 `state.activeConversationId`
 * 的旧代码零改动就能工作；而每个 tab 自己的草稿 / 流式文本 / 模型选择
 * 都按 conversationId 分桶存（草稿在 useChatSession 的模块级缓存，流式文本在 streams，
 * 模型选择在 conversationModels），
 * 所以切 tab 既不会丢字，也不会把 A 会话的流式内容画到 B 会话里。
 */
export interface SessionTab {
  id: string;
  title: string;
}

/** 会话 tab 的本地持久化：只存 id/title，重启后恢复「上次开着的几个会话」。 */
const SESSION_TABS_KEY = 'devwork-session-tabs';

export function readStoredSessionTabs(): SessionTab[] {
  try {
    const raw = localStorage.getItem(SESSION_TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SessionTab => {
        if (!item || typeof item !== 'object') return false;
        const row = item as Partial<SessionTab>;
        return typeof row.id === 'string' && row.id !== '' && typeof row.title === 'string';
      })
      .slice(0, 20);
  } catch {
    /* 存坏了就当没开过，不影响启动。 */
    return [];
  }
}

function persistSessionTabs(tabs: SessionTab[]): void {
  try {
    /* 只持久化**服务端真 id**。c-new-* / c-asset-* 是还没落库的本地临时 id，
     * 存下来重启后就变成一排点开是空的幽灵标签页 —— 恢复得越多越像坏了。
     * 它们拿到真 id 之后会再走一次持久化，所以不会真的丢。 */
    const durable = tabs.filter((tab) => !/^c-(new|asset)-/.test(tab.id));
    localStorage.setItem(SESSION_TABS_KEY, JSON.stringify(durable));
  } catch {
    /* 存不进去也不影响本次会话。 */
  }
}

/** 打开或激活一条 tab（纯函数，便于在 setState 回调里安全使用）。 */
function upsertSessionTab(tabs: SessionTab[], id: string, title: string): SessionTab[] {
  if (!id) return tabs;
  if (tabs.some((tab) => tab.id === id)) {
    return tabs.map((tab) => (tab.id === id ? { ...tab, title: title || tab.title } : tab));
  }
  /* 上限 20：再多就不是「并行盯几个」，而是把 tab 栏当历史列表用了。 */
  return [...tabs, { id, title: title || '未命名会话' }].slice(-20);
}

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
  /** 侧边工作区打开着的 tab（按打开顺序）。是「内容显示区」，不是固定栏位。 */
  benchTabs: BenchTab[];
  /** 工作区当前激活的 tab key（空串 = 一个都没开，显示空态）。 */
  benchActive: string;
  /** 产物选择浮层是否打开 —— 产物清单不进工作区，只在浮层里选，选完开详情 tab。 */
  artifactPickerOpen: boolean;
  /** 内置浏览器当前地址（用户手动导航与 Agent 导航共用这一份）。 */
  browserUrl: string;
  detailTab: string;
  /** 资产配置抽屉（能力授权 / 凭据 / 资产信息）是否打开。 */
  configOpen: boolean;
  settingsSection: string;
  orgSection: string;
  ctxTokens: number;
  /** 上下文预算（k）：跟着模型窗口走，改动只在服务端（模型/设置页），前端只展示。 */
  ctxBudget: number;
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
  /** 打开着的会话 tab（按打开顺序；activeConversationId 指向其中一项）。 */
  sessionTabs: SessionTab[];
  /** 每个会话各自的流式文本：多 tab 并行时按会话各画各的，绝不串台。 */
  streams: Record<string, string>;
  /** 协作流视图正对着哪个会话（null = 未打开）。协作流不属于会话 tab，是它的伴随视图。 */
  collabFor: string | null;
  /**
   * 「待人」清单：谁停下来等我了。
   *
   * 刻意放在全局而不是各组件自取：侧栏徽标、会话 tab 橙点、命令面板说的是
   * 同一件事，各拉一次就会出现「侧栏 2、tab 上没点」这种自相矛盾的界面。
   */
  waiting: WaitingTicket[];
  /** 上次成功拉到待人清单的时间（ISO）。失败时保留旧值，徽标不闪没。 */
  waitingAt: string;
}

export interface StoreApi {
  state: AppState;
  navigate: (view: ViewName) => void;
  /**
   * 在侧边工作区打开某类内容：已开则激活，未开则新加一个 tab（并展开工作区）。
   * 这是会话右缘图标与命令面板共用的**唯一入口**。
   */
  openBench: (kind: Exclude<BenchPaneKind, 'artifact'>) => void;
  /** 关闭工作区某个 tab；关的是激活页时激活邻位（右侧优先，其次左侧）。 */
  closeBench: (key: string) => void;
  /** 切换工作区激活 tab。 */
  setBenchActive: (key: string) => void;
  /** 开 / 关产物选择浮层（产物清单不进工作区，只在这里选）。 */
  setArtifactPicker: (open: boolean) => void;
  /** 更新内置浏览器地址。 */
  setBrowserUrl: (url: string) => void;
  /** 在侧边工作区打开一个产物预览 —— 每个产物占一个独立 tab，已开则聚焦。 */
  openArtifact: (artifact: { id: string; name: string }) => void;
  /** 关闭某个产物的 tab（按产物 id）。 */
  closeArtifact: (id: string) => void;
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
  applyUsage: (usage: { contextUsed?: number; contextBudget?: number; costCny?: number }) => void;
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
  /** 流式请求前注册 AbortController（按会话分桶）；stopGeneration 停的是**当前会话**那条流。 */
  registerAbort: (controller: AbortController | null, conversationId?: string) => void;
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
  /** 打开一条会话 tab 并激活（已打开则只激活，不重复添加）。 */
  openSessionTab: (id: string, title: string) => void;
  /** 关闭一条会话 tab；关的是激活页时激活邻位（右侧优先，其次左侧）。 */
  closeSessionTab: (id: string) => void;
  /** 会话 tab 重命名同步：改名后 tab 标题跟着变。 */
  retitleSessionTab: (id: string, title: string) => void;
  /** 按 tab 下标激活会话（⌘1..⌘9 用；越界忽略）。 */
  activateSessionTabAt: (index: number) => void;
  /** 写某会话的流式文本；传 null 表示该会话本轮结束。 */
  setStream: (conversationId: string, text: string | null) => void;
  /** 打开 / 关闭协作流视图（跟随当前会话）。 */
  toggleCollab: (open?: boolean) => void;
  /**
   * 拉一次待人清单。
   *
   * 对外暴露是因为「刚答完一个问题」这类时刻必须立刻复核，不能等下一轮轮询：
   * 你答完还看着那个红点，会以为没提交成功。
   */
  refreshWaiting: () => Promise<void>;
  setApiMode: (mode: 'live' | 'mock') => void;
  stopGeneration: () => void;
  hydrateFromRest: (payload: {
    projects?: Project[];
    statusBar?: { model?: string; contextUsed?: number; contextBudget?: number; costCny?: number; state?: string };
    readOnlyMode?: boolean;
    threads?: Record<string, Message[]>;
    /** 服务端判定的当前会话：切项目后前端不能再假设是 c-gmv。 */
    activeConversationId?: string;
    activeConversationTitle?: string;
    /** 服务端判定的当前工作区：资产级请求靠它注入 workspaceId。 */
    workspaceId?: string;
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
  /* 工作区默认**收起**：不占版面、不预置任何 tab。
   * 它是「点了才来」的展示区 —— 用户没点入口之前，右侧留给会话本身。 */
  rightCollapsed: true,
  workspaceId: 'w-ops',
  activeConversationId: __PACKAGED__ ? '' : 'c-gmv',
  activeAssetId: 'a-order-service',
  activeConversationTitle: __PACKAGED__ ? '' : 'GMV 归因',
  extraConversations: [],
  assetChat: null,
  assetChatCollapsed: readStoredAssetChatCollapsed(),
  threads: __PACKAGED__ ? {} : MOCK_SNAPSHOT.INITIAL_THREADS,
  /* 不预置任何 tab：进来就是空的，等用户从右缘图标点开第一个。 */
  benchTabs: [],
  benchActive: '',
  artifactPickerOpen: false,
  browserUrl: '',
  detailTab: 'main',
  configOpen: false,
  settingsSection: 'gen',
  orgSection: 'm',
  ctxTokens: 32,
  ctxBudget: 128,
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
  /* tab 恢复交给 hydrateFromRest：初始只有「当前会话」这一条真数据，
   * 直接灌 localStorage 里的旧 id 会出现「tab 指向一个服务端已删的会话」。 */
  sessionTabs: [],
  streams: {},
  collabFor: null,
  /* 待人清单从空开始：不知道就显示「没有」比显示一个假数字安全。
   * 首次拉取在 Provider 的 effect 里，启动几百毫秒后就会有真值。 */
  waiting: [],
  waitingAt: '',
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
  /* 初始状态里如果已经有一条当前会话（开发态 / 恢复态），就同步建出它的 tab。
   * 不做这一步的话，启动到 bootstrap 返回之间会有几百毫秒「会话在、标签栏空」的错位，
   * 看起来像是标签栏坏了而不是还没加载完。 */
  const [state, setState] = useState<AppState>(() => {
    const base: AppState = { ...INITIAL_STATE };
    if (base.activeConversationId) {
      base.sessionTabs = [{ id: base.activeConversationId, title: base.activeConversationTitle }];
    }
    return base;
  });
  /* 回调里需要「当前」工作区，但 useCallback 不能依赖 state 否则每次渲染都换引用；
   * stateRef 让 newConversation 这类命令式动作读到最新值，而不是写死 'w-ops'。 */
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;
  /** 初始化时那一条 tab 的 id —— 它只是「先占个位」，bootstrap 回来后要被真实会话替换掉。 */
  const seededTabId = useRef<string>(INITIAL_STATE.activeConversationId);
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

  /** 打开某类内容：已开则激活，未开则追加。同时展开工作区（点图标就是要看见它）。 */
  const openBench = useCallback((kind: Exclude<BenchPaneKind, 'artifact'>) => {
    setState((prev) => ({
      ...prev,
      benchTabs: pushBenchTab(prev.benchTabs, { key: kind, kind, title: BENCH_TITLES[kind] }),
      benchActive: kind,
      rightCollapsed: false,
    }));
  }, []);

  /** 关闭 tab；关的是激活页时优先激活右侧邻居，否则左侧。
   *  **关掉最后一个 tab 自动收起工作区** —— 空栏只是占版面，缩回去把宽度还给会话。 */
  const closeBench = useCallback((key: string) => {
    setState((prev) => {
      const index = prev.benchTabs.findIndex((tab) => tab.key === key);
      if (index < 0) return prev;
      const tabs = prev.benchTabs.filter((tab) => tab.key !== key);
      /* 关的不是激活页：激活页保持不变。关的是激活页：落到邻居，全关完就没激活页。 */
      const nextActive = prev.benchActive === key
        ? (tabs[index] ?? tabs[index - 1] ?? null)?.key ?? ''
        : prev.benchActive;
      return {
        ...prev,
        benchTabs: tabs,
        benchActive: nextActive,
        rightCollapsed: tabs.length === 0 ? true : prev.rightCollapsed,
      };
    });
  }, []);

  const setBenchActive = useCallback((key: string) => {
    setState((prev) => (
      prev.benchTabs.some((tab) => tab.key === key)
        ? { ...prev, benchActive: key, rightCollapsed: false }
        : prev
    ));
  }, []);

  const setBrowserUrl = useCallback((url: string) => patch({ browserUrl: url }), [patch]);
  const setArtifactPicker = useCallback((open: boolean) => patch({ artifactPickerOpen: open }), [patch]);
  /** 打开产物预览：每个产物一个独立 tab（key 带 id，同名不同 id 也是两个 tab）。
   *  选完即收浮层 —— 浮层只负责「选哪个」，内容归工作区。 */
  const openArtifact = useCallback((artifact: { id: string; name: string }) => {
    const key = `artifact:${artifact.id}`;
    setState((prev) => ({
      ...prev,
      benchTabs: pushBenchTab(prev.benchTabs, {
        key, kind: 'artifact', title: artifact.name, artifactId: artifact.id,
      }),
      benchActive: key,
      rightCollapsed: false,
      artifactPickerOpen: false,
    }));
  }, []);

  const closeArtifact = useCallback((id: string) => {
    closeBench(`artifact:${id}`);
  }, [closeBench]);
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
      /* 先同步 api 层的工作区：资产级请求靠这个值注入 workspaceId，
       * 顺序上必须早于下面任何一次资产请求发出。 */
      setCurrentWorkspaceId(id);
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
    setState((prev) => {
      /* 从侧栏点会话有两种意图：切过去看，以及把它留在 tab 栏上。
       * 两者同源，所以这里顺手把它加成 tab —— 否则「切过去的会话」和
       * 「开着的 tab」会变成两套互相不知道对方存在的状态。 */
      const sessionTabs = upsertSessionTab(prev.sessionTabs, id, title);
      persistSessionTabs(sessionTabs);
      return {
        ...prev,
        sessionTabs,
        view: 'chat',
        activeConversationId: id,
        activeConversationTitle: title,
        citation: null,
        statusText: '就绪',
      };
    });
    loadThread(id);
  }, [loadThread]);

  /* ---------- 多会话 tabs ---------- */

  /** 打开 / 激活一条会话 tab；已打开就只激活，不重复添加。 */
  const openSessionTab = useCallback((id: string, title: string) => {
    if (!id) return;
    setState((prev) => {
      const sessionTabs = upsertSessionTab(prev.sessionTabs, id, title);
      persistSessionTabs(sessionTabs);
      return {
        ...prev,
        sessionTabs,
        view: 'chat',
        activeConversationId: id,
        activeConversationTitle: title || prev.activeConversationTitle,
        citation: null,
      };
    });
    loadThread(id);
  }, [loadThread]);

  /**
   * 关闭 tab —— **关 tab 不等于删会话**：会话仍在侧栏，随时能再打开。
   * 关的是激活页时，优先激活右邻，没有右邻再取左邻；
   * 全关完则 activeConversationId 置空，主区域显式提示「从左侧选一条会话」，
   * 而不是偷偷替你切到另一条会话（那样用户会以为自己关错了）。
   */
  const closeSessionTab = useCallback((id: string) => {
    setState((prev) => {
      const index = prev.sessionTabs.findIndex((tab) => tab.id === id);
      if (index < 0) return prev;
      const sessionTabs = prev.sessionTabs.filter((tab) => tab.id !== id);
      const wasActive = prev.activeConversationId === id;
      const nextActive = wasActive
        ? sessionTabs[Math.min(index, sessionTabs.length - 1)]?.id ?? ''
        : prev.activeConversationId;
      const nextTitle = wasActive
        ? sessionTabs.find((tab) => tab.id === nextActive)?.title ?? ''
        : prev.activeConversationTitle;
      const streams = { ...prev.streams };
      delete streams[id];
      persistSessionTabs(sessionTabs);
      return {
        ...prev,
        sessionTabs,
        streams,
        activeConversationId: nextActive,
        activeConversationTitle: nextTitle,
        collabFor: prev.collabFor === id ? null : prev.collabFor,
      };
    });
  }, []);

  /** 会话改名同步到 tab 标题（否则 tab 上还挂着旧名字）。 */
  const retitleSessionTab = useCallback((id: string, title: string) => {
    setState((prev) => {
      if (!prev.sessionTabs.some((tab) => tab.id === id)) return prev;
      const sessionTabs = prev.sessionTabs.map((tab) => (tab.id === id ? { ...tab, title } : tab));
      persistSessionTabs(sessionTabs);
      return { ...prev, sessionTabs };
    });
  }, []);

  /** ⌘1..⌘9：按位置激活 tab。 */
  const activateSessionTabAt = useCallback((index: number) => {
    setState((prev) => {
      const tab = prev.sessionTabs[index];
      if (!tab) return prev;
      return {
        ...prev,
        view: 'chat',
        activeConversationId: tab.id,
        activeConversationTitle: tab.title,
        citation: null,
      };
    });
  }, []);

  /** 流式文本按会话存：两个会话可以同时在生成，各自画各自的。 */
  const setStream = useCallback((conversationId: string, text: string | null) => {
    if (!conversationId) return;
    setState((prev) => {
      const streams = { ...prev.streams };
      if (text === null) delete streams[conversationId];
      else streams[conversationId] = text;
      return { ...prev, streams };
    });
  }, []);

  /** 协作流视图：跟随当前会话开 / 关。 */
  const toggleCollab = useCallback((open?: boolean) => {
    setState((prev) => {
      const next = open ?? prev.collabFor !== prev.activeConversationId;
      return { ...prev, collabFor: next ? prev.activeConversationId : null };
    });
  }, []);

  /* 待人探针：全局唯一一处拉取。
   *
   * 为什么 10 秒而不是侧栏原来那 30 秒：这张清单代表「Agent 已经停下来等你」，
   * 是阻塞态。半分钟才亮一次的红点，会让人先怀疑界面坏了，再怀疑任务死了。
   * 也不做 1 秒：待人状态的变化频率取决于人自己，拉太勤只是白耗。
   *
   * 失败保留上一次结果 —— 网络抖一下就把红点清掉，比不显示更危险。 */
  const refreshWaiting = useCallback(async () => {
    try {
      const envelope = await restApi.getWaitingTickets(20);
      if (!envelope.ok) return;
      setState((prev) => ({
        ...prev,
        waiting: envelope.data.items ?? [],
        waitingAt: new Date().toISOString(),
      }));
    } catch {
      /* 网络异常：保留上一份快照，等下一轮。 */
    }
  }, []);

  useEffect(() => {
    void refreshWaiting();
    const timer = window.setInterval(() => { void refreshWaiting(); }, 10000);
    /* 切回窗口立刻复核一次：人离开过一阵再回来，第一眼看到的必须是最新状态。 */
    const onFocus = (): void => { void refreshWaiting(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshWaiting]);

  /* 把待人状态同步到桌面壳：窗口标题 `(4) DevWork`、任务栏/Dock 徽标、托盘提示。
   *
   * 为什么必须做这一层：窗口最小化、被别的应用盖住、收进托盘时，界面里画的
   * 红点一个都看不见 —— 而「Agent 停下来等你」正是最该被余光捕捉到的状态。
   *
   * 只在数字或等级真的变了才推：轮询每 10 秒跑一次，但一条没变的状态
   * 反复穿过 IPC 去重画任务栏图标，纯属白耗。 */
  const attentionRef = useRef('');
  useEffect(() => {
    const count = state.waiting.length;
    const level = waitingLevel(state.waiting);
    const key = `${count}:${level}`;
    if (attentionRef.current === key) return;
    attentionRef.current = key;
    /* 吞掉异常：外壳没注册这个通道（旧版壳 / Web 模式）时，
     * 任务栏没画上不该在控制台留一条未处理的 rejection。 */
    void window.desktop?.setAttention?.({ count, level })?.catch(() => undefined);
  }, [state.waiting]);

  const newConversation = useCallback(() => {
    convSeq.current += 1;
    const seq = convSeq.current;
    const localId = `c-new-${seq}`;
    const title = `新会话 ${seq}`;
    setState((prev) => {
      const sessionTabs = upsertSessionTab(prev.sessionTabs, localId, title);
      persistSessionTabs(sessionTabs);
      return {
        ...prev,
        view: 'chat',
        sessionTabs,
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
      };
    });
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
          /* tab / 草稿 / 流式文本都挂在本地临时 id 上，换真 id 时要一起搬，
           * 否则这条会话会「tab 还在、草稿没了」，看起来像丢字。 */
          const sessionTabs = prev.sessionTabs.map((tab) => (tab.id === localId ? { ...tab, id: realId } : tab));
          persistSessionTabs(sessionTabs);
          const streams = { ...prev.streams };
          if (localId in streams) {
            streams[realId] = streams[localId];
            delete streams[localId];
          }
          return {
            ...prev,
            sessionTabs,
            streams,
            extraConversations: prev.extraConversations.map((c) => (c.id === localId ? { ...c, id: realId } : c)),
            activeConversationId: prev.activeConversationId === localId ? realId : prev.activeConversationId,
            collabFor: prev.collabFor === localId ? realId : prev.collabFor,
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
    setState((prev) => {
      const sessionTabs = prev.sessionTabs.map((tab) => (tab.id === id ? { ...tab, title: trimmed } : tab));
      if (sessionTabs.some((tab) => tab.id === id)) persistSessionTabs(sessionTabs);
      return {
        ...prev,
        sessionTabs,
        activeConversationTitle: prev.activeConversationId === id ? trimmed : prev.activeConversationTitle,
        extraConversations: prev.extraConversations.map((c) => (c.id === id ? { ...c, title: trimmed } : c)),
      };
    });
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
        const streams = { ...prev.streams };
        delete streams[id];
        const index = prev.sessionTabs.findIndex((tab) => tab.id === id);
        const sessionTabs = prev.sessionTabs.filter((tab) => tab.id !== id);
        if (index >= 0) persistSessionTabs(sessionTabs);
        const wasActive = prev.activeConversationId === id;
        /* 删掉的正好是激活 tab：优先接右邻，没有就接左邻；一个都不剩就清空 active，
         * 主区域会提示「从左侧选一条会话」—— 不再硬塞一个 'c-gmv' 的假回落。 */
        const fallback = wasActive ? sessionTabs[Math.min(index < 0 ? 0 : index, sessionTabs.length - 1)] : undefined;
        return {
          ...prev,
          threads,
          streams,
          sessionTabs,
          extraConversations: prev.extraConversations.filter((c) => c.id !== id),
          activeConversationId: wasActive ? fallback?.id ?? '' : prev.activeConversationId,
          activeConversationTitle: wasActive ? fallback?.title ?? '' : prev.activeConversationTitle,
          collabFor: prev.collabFor === id ? null : prev.collabFor,
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
        threads: { ...prev.threads, [target]: mergeThread(current, reply) },
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
      return { ...prev, threads: { ...prev.threads, [conversationId]: mergeThread(current, reply) } };
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

  /**
   * 流式请求的中止控制器 —— **按会话分桶**。
   *
   * 多 tab 之后一个 ref 不够用了：A 会话在生成、切到 B 会话按 Esc，
   * 单个 ref 会把 A 的流停掉，而 B 毫发无伤 —— 用户看到的是「按了没反应」。
   * 分桶后「停止生成」只停当前激活会话那条流，其余会话继续跑。
   */
  const abortRef = useRef<Record<string, AbortController>>({});
  const registerAbort = useCallback((controller: AbortController | null, conversationId?: string) => {
    const id = conversationId ?? stateRef.current.activeConversationId;
    if (!id) return;
    if (controller) abortRef.current[id] = controller;
    else delete abortRef.current[id];
  }, []);

  /** 停止生成：真中断**当前会话**的 SSE 流（⌘. / Esc / 命令面板同一入口）。
   *  没有进行中的流时如实说明，不再假装"已停止"。 */
  const stopGeneration = useCallback(() => {
    const id = stateRef.current.activeConversationId;
    const controller = id ? abortRef.current[id] : undefined;
    if (id && controller) {
      controller.abort();
      delete abortRef.current[id];
      setState((prev) => ({ ...prev, statusText: '已停止生成' }));
      addToast('已停止生成（流式请求已中断）');
    } else if (Object.keys(abortRef.current).length > 0) {
      /* 当前会话没在生成，但别的 tab 还在跑：说清楚，别让人以为按坏了。 */
      addToast('当前会话没有进行中的生成（其它标签页仍在运行，切过去再停）');
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
      statusBar?: { model?: string; contextUsed?: number; contextBudget?: number; costCny?: number; state?: string };
      readOnlyMode?: boolean;
      threads?: Record<string, Message[]>;
      activeConversationId?: string;
      activeConversationTitle?: string;
      workspaceId?: string;
    }) => {
      /* 服务端给的当前工作区是权威值：api 层注入 workspaceId 依赖它，
       * 必须与 state.workspaceId 一起落，否则两侧会指向不同工作区。 */
      if (payload.workspaceId) setCurrentWorkspaceId(payload.workspaceId);
      setState((prev) => {
        const nextActive = payload.activeConversationId ?? prev.activeConversationId;
        const nextTitle = payload.activeConversationTitle ?? prev.activeConversationTitle;
        /* tab 恢复：localStorage 里存的是「上次开着哪几个」，
         * 但**当前会话永远以服务端为准** —— 存过的 tab 可能指向已删会话，
         * 盲信它会出现「一启动就有个空 tab」。 */
        const onlySeeded =
          prev.sessionTabs.length === 1 && prev.sessionTabs[0].id === seededTabId.current;
        let sessionTabs = onlySeeded
          ? readStoredSessionTabs()
          : prev.sessionTabs.length > 0
            ? prev.sessionTabs
            : readStoredSessionTabs();
        /* 初始化那条只是占位（开发态还会是演示会话 c-gmv）：
         * 真实会话一到就必须顶掉它，否则标签栏会同时挂着「演示会话」和「真实会话」两条，
         * 而点前者是一条永远拉不到消息的空会话。 */
        if (nextActive) sessionTabs = upsertSessionTab(sessionTabs, nextActive, nextTitle);
        if (sessionTabs.length > 0) persistSessionTabs(sessionTabs);
        return {
          ...prev,
          sessionTabs,
          workspaceId: payload.workspaceId ?? prev.workspaceId,
          activeConversationId: nextActive,
          activeConversationTitle: nextTitle,
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
          /* 预算按 1000 折算：128000 tokens 应该显示 128k，而不是 125k。 */
          ctxBudget:
            typeof payload.statusBar?.contextBudget === 'number'
              ? Math.max(1, Math.round(payload.statusBar.contextBudget / 1000))
              : prev.ctxBudget,
          statusText: payload.statusBar?.state ?? prev.statusText,
        };
      });
    },
    [],
  );

  /** B18：上下文用量真值 —— 服务端按上下文预算口径计算，不再 +1k/+0.03 模拟。
   *  budget 一起回写：预算跟着模型走，写死 200k 会让 32k 模型一直显示"还有九成余量"。 */
  const applyUsage = useCallback((usage: { contextUsed?: number; contextBudget?: number; costCny?: number }) => {
    setState((prev) => ({
      ...prev,
      ctxTokens:
        typeof usage.contextUsed === 'number'
          ? Math.max(1, Math.round(usage.contextUsed / 1024))
          : prev.ctxTokens,
      ctxBudget:
        typeof usage.contextBudget === 'number' && usage.contextBudget > 0
          ? Math.max(1, Math.round(usage.contextBudget / 1000))
          : prev.ctxBudget,
      cost: typeof usage.costCny === 'number' ? Number(usage.costCny.toFixed(2)) : prev.cost,
    }));
  }, []);

  const api = useMemo<StoreApi>(
    () => ({
      state,
      navigate,
      openBench,
      closeBench,
      setBenchActive,
      setArtifactPicker,
      setBrowserUrl,
      openArtifact,
      closeArtifact,
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
      openSessionTab,
      closeSessionTab,
      retitleSessionTab,
      activateSessionTabAt,
      setStream,
      toggleCollab,
      refreshWaiting,
      setApiMode,
      stopGeneration,
      hydrateFromRest,
    }),
    [
      state,
      navigate,
      openBench,
      closeBench,
      setBenchActive,
      setArtifactPicker,
      setBrowserUrl,
      openArtifact,
      closeArtifact,
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
      openSessionTab,
      closeSessionTab,
      retitleSessionTab,
      activateSessionTabAt,
      setStream,
      toggleCollab,
      refreshWaiting,
      setApiMode,
      stopGeneration,
      hydrateFromRest,
    ],
  );

  return <StoreContext.Provider value={api}>{children}</StoreContext.Provider>;
}
