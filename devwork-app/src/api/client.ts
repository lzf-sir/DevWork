/**
 * 统一 API 客户端 —— 前端所有数据访问的唯一入口。
 * - 组件只 import 本文件（`api` 与业务常量均从此导出），禁止直接引用 src/data/mock.ts。
 * - 仅网络层失败 / 连接拒绝 / 超时 / 5xx 才降级到 mockFallthrough；
 *   后端返回的合法 4xx JSON 包络原样返回，绝不降级。
 * - bootstrap() 用 health() 探测 apiMode，供状态栏显示「就绪 / 离线 Mock」。
 */
/*
 * B2：不再 re-export ./mock 的运行时业务常量。组件的所有可变业务数据统一由
 * src/api/live.tsx 的 useLiveData()（内部走 api.*()）提供；离线 fallback 只存在于
 * src/api/mock.ts。此处仅导出纯类型（编译期擦除，运行时零开销）。
 */
export type {
  ViewName,
  AssetGo,
  AssetStatus,
  AssetItem,
  ConvItem,
  AssetFolder,
  ConvFolder,
  SidebarData,
  Project,
  InlineSeg,
  Message,
  CapItem,
  TermLine,
  SettingControl,
  SettingRow,
  SettingSection,
  CodeFile,
  AuditCategory,
} from './mock';
/* 显式导出 REST 类型，避免与 mock 常量中的同名类型（Citation 等）产生歧义。 */
export type {
  ApiClient,
  ApiEnvelope,
  ApiError,
  ApiMeta,
  ApiMode,
  ArtifactPreview,
  Asset,
  AssetDetail,
  AssetInput,
  BrowserPage,
  BrowserState,
  Dict,
  Folder,
  FolderInput,
  Health,
  Bootstrap,
  KbDocument,
  KbDocumentList,
  SearchHit,
  Skill,
  Workspace,
  Sidebar,
  StatusBar,
  MessageCard,
  MessageTurn,
  CitationDetail,
  ExecResult,
  SqlResult,
  PermissionDecision,
  SettingsSection,
  AuditEvent,
  TruncateMessagesInput,
  TruncateMessagesResult,
  TurnUsage,
} from './types';

import { mockFallthrough } from './mock';
import type {
  Activity,
  AgentWriteInput,
  AgentWriteResult,
  ApiClient,
  ApiEnvelope,
  ApiError,
  ApiMode,
  ArtifactPanel,
  Asset,
  AssetDetail,
  AssetInput,
  AuditEvent,
  AuditQuery,
  ArtifactPreview,
  BlacklistRule,
  Bootstrap,
  BrowserPage,
  BrowserState,
  Capability,
  CapabilityPatch,
  Citation,
  CitationDetail,
  CloneRepoInput,
  CloneRepoResult,
  CommandHistory,
  CommandSuggestion,
  ContextPanel,
  Conversation,
  ConversationInput,
  Credential,
  CredentialBindInput,
  Dict,
  EffectivePolicy,
  ExecResult,
  ExecuteCommandInput,
  ExecutionPanel,
  FileContent,
  FileNode,
  FileOutline,
  FileDiff,
  LlmKeyStatus,
  LlmKeySetResult,
  LlmConfig,
  LlmConfigInput,
  LlmModelList,
  LlmModelListInput,
  LlmProfileInput,
  LlmTestResult,
  Folder,
  FolderInput,
  GitSummary,
  Health,
  HttpMethod,
  KbDocumentList,
  MessageCard,
  MessageTurn,
  MoveItemInput,
  PatchInput,
  PermissionDecision,
  PermissionProbeInput,
  RepoStatus,
  SaveFileInput,
  SaveFileResult,
  SearchHit,
  SendMessageInput,
  SensitiveRule,
  Settings,
  SettingsSection,
  Sidebar,
  Skill,
  SqlQueryOptions,
  SqlResult,
  SqlSchema,
  ToolFace,
  TruncateMessagesInput,
  TruncateMessagesResult,
  StatusBar,
  SuggestionInput,
  SwitchResult,
  TableDdl,
  TableFields,
  TableRows,
  TableRowsParams,
  TableStructure,
  TerminalSession,
  Usage,
  WhitelistEntry,
  Workspace,
  WorkspaceInput,
} from './types';

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
export const BASE: string = env?.VITE_API_BASE ?? '/api';

export let apiMode: ApiMode = 'mock';
let lastRequestFallback = false;

export function wasLastRequestFallback(): boolean {
  return lastRequestFallback;
}

function requestId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalize<T>(value: unknown, apiModeHint: ApiMode): ApiEnvelope<T> {
  if (value && typeof value === 'object' && 'ok' in value && 'data' in value) {
    const envelope = value as ApiEnvelope<T>;
    return {
      ...envelope,
      meta: envelope.meta ?? { requestId: requestId(), ts: Date.now(), apiMode: apiModeHint },
    };
  }
  return {
    ok: true,
    data: value as T,
    error: null,
    meta: { requestId: requestId(), ts: Date.now(), apiMode: apiModeHint },
  };
}

/**
 * 统一请求。仅 TypeError / 连接拒绝 / 超时 / 5xx（或响应非 JSON）降级到 mock。
 * 后端合法 4xx（含 E_SQL_REJECTED 422、E_PERMISSION_DENIED 403）原样返回。
 *
 * **打包态不做 mock 降级**（__PACKAGED__ 由 vite define 注入）：
 * 交付给用户的程序里，演示数据不该出现在任何界面。
 * 后端不通就如实返回错误包络，让用户看到真实原因（后端没起 / 端口占用 /
 * 权限拒绝），而不是一份看着正常的假数据。
 * 开发态保留原有兜底：本地起后端前也能看界面。
 */
export function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ApiEnvelope<T>> {
  const timeoutMs = opts?.timeoutMs ?? 2500;
  const signal = opts?.signal ?? AbortSignal.timeout(timeoutMs);
  lastRequestFallback = false;

  return fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
    .then(async (response) => {
      if (response.status >= 500) {
        throw new Error(`server ${response.status}`);
      }
      const raw: unknown = await response.json();
      return normalize<T>(raw, 'live');
    })
    .catch((error: unknown) => {
      if (__PACKAGED__) {
        /* 打包态：如实报错，不回落到演示数据。 */
        apiMode = 'live';
        lastRequestFallback = true;
        return {
          ok: false,
          data: null as unknown as T,
          error: {
            code: 'E_BACKEND_UNREACHABLE',
            message: `无法连接后端服务（${method} ${path}）：${describeError(error)}`,
          },
          meta: { requestId: requestId(), ts: Date.now(), apiMode: 'live' },
        };
      }
      lastRequestFallback = true;
      apiMode = 'mock';
      return mockFallthrough<T>(method, path, body);
    });
}

/** 把底层异常翻译成一句人话，让报错页能直接展示。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || /timeout/i.test(error.message)) {
      return '请求超时，后端服务未在预期时间内响应';
    }
    if (/Failed to fetch|NetworkError|fetch failed/i.test(error.message)) {
      return '后端服务未启动或端口无法访问';
    }
    return error.message;
  }
  return String(error ?? '未知错误');
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : '';
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

export const api: ApiClient = {
  /* ---- 系统 / 引导 ---- */
  health: () => request<Health>('GET', '/health'),
  bootstrap: (workspaceId?: string) =>
    request<Bootstrap>('GET', `/bootstrap${qs({ workspaceId })}`).then((envelope) => {
      /* 用本次响应包络自带的 meta.apiMode 判定，避免并发请求共享
       * lastRequestFallback 造成的竞态（任一请求失败会污染其他请求的判定）。 */
      apiMode = envelope.meta?.apiMode === 'live' ? 'live' : 'mock';
      return envelope;
    }),
  listWorkspaces: () => request<Workspace[]>('GET', '/workspaces'),
  createWorkspace: (input: WorkspaceInput) => request<Workspace>('POST', '/workspaces', input),
  getWorkspace: (id: string) => request<Workspace>('GET', `/workspaces/${enc(id)}`),
  updateWorkspace: (id: string, patch: Partial<WorkspaceInput>) => request<Workspace>('PATCH', `/workspaces/${enc(id)}`, patch),
  deleteWorkspace: (id: string) => request<{ deleted: true }>('DELETE', `/workspaces/${enc(id)}`),
  switchWorkspace: (id: string) => request<SwitchResult>('POST', `/workspaces/${enc(id)}/switch`),
  getSidebar: (workspaceId: string) => request<Sidebar>('GET', `/sidebar${qs({ workspaceId })}`),
  getStatusBar: (workspaceId: string) => request<StatusBar>('GET', `/status-bar${qs({ workspaceId })}`),

  /* ---- 文件夹 ---- */
  listFolders: (workspaceId: string, kind: 'asset' | 'conversation') =>
    request<Folder[]>('GET', `/folders${qs({ workspaceId, kind })}`),
  createFolder: (input: FolderInput) => request<Folder>('POST', '/folders', input),
  updateFolder: (id: string, patch: Partial<FolderInput>) => request<Folder>('PATCH', `/folders/${enc(id)}`, patch),
  deleteFolder: (id: string) => request<{ movedToParentId: string | null; affected: number }>('DELETE', `/folders/${enc(id)}`),
  reorderFolders: (ids: string[]) => request<{ ok: true }>('POST', '/folders/reorder', { ids }),
  moveItem: (input: MoveItemInput) => request<{ ok: true }>('POST', '/items/move', input),

  /* ---- 资产 / 能力 / 凭据 ---- */
  listAssets: (workspaceId: string, type?: string) => request<Asset[]>('GET', `/assets${qs({ workspaceId, type })}`),
  createAsset: (input: AssetInput) => request<Asset>('POST', '/assets', input),
  getAsset: (id: string) => request<AssetDetail>('GET', `/assets/${enc(id)}`),
  updateAsset: (id: string, patch: Partial<AssetInput>) => request<Asset>('PATCH', `/assets/${enc(id)}`, patch),
  deleteAsset: (id: string) => request<{ deleted: true }>('DELETE', `/assets/${enc(id)}`),
  advanceIndex: (id: string, patch?: { delta?: number; to?: number }) =>
    request<{ indexProgress: number; status: string }>('POST', `/assets/${enc(id)}/index/progress`, patch ?? {}),
  getAssetActivities: (id: string) => request<Activity[]>('GET', `/assets/${enc(id)}/activities`),
  listCapabilities: (assetId: string) => request<Capability[]>('GET', `/assets/${enc(assetId)}/capabilities`),
  updateCapability: (assetId: string, capId: string, patch: CapabilityPatch) =>
    request<Capability>('PATCH', `/assets/${enc(assetId)}/capabilities/${enc(capId)}`, patch),
  searchAsset: (assetId: string, query: string) =>
    request<SearchHit[]>('GET', `/assets/${enc(assetId)}/search${qs({ q: query })}`),
  listDocuments: (assetId: string) => request<KbDocumentList>('GET', `/assets/${enc(assetId)}/documents`),
  getCredential: (assetId: string) => request<Credential>('GET', `/assets/${enc(assetId)}/credential`),
  bindCredential: (assetId: string, input: CredentialBindInput) =>
    request<Credential>('POST', `/assets/${enc(assetId)}/credential/bind`, input),
  renewCredential: (assetId: string) => request<Credential>('POST', `/assets/${enc(assetId)}/credential/renew`),
  revokeCredential: (assetId: string) => request<Credential>('POST', `/assets/${enc(assetId)}/credential/revoke`),

  /* ---- 会话 / 消息 / 引用 ---- */
  listConversations: (workspaceId?: string, opts?: { archived?: boolean }) =>
    request<Conversation[]>('GET', `/conversations${qs({
      workspaceId,
      archived: opts?.archived ? '1' : '',
    })}`),
  createConversation: (input: ConversationInput) => request<Conversation>('POST', '/conversations', input),
  updateConversation: (id: string, patch: Partial<ConversationInput>) =>
    request<Conversation>('PATCH', `/conversations/${enc(id)}`, patch),
  deleteConversation: (id: string) => request<{ deleted: true }>('DELETE', `/conversations/${enc(id)}`),
  listMessages: (conversationId: string) => request<MessageCard[]>('GET', `/conversations/${enc(conversationId)}/messages`),
  sendMessage: (conversationId: string, input: SendMessageInput) =>
    request<MessageTurn>('POST', `/conversations/${enc(conversationId)}/messages`, input, { timeoutMs: 30000 }),
  /* 消息时间线截断（撤回 / 编辑重发 / 重试共用）：inclusive 连目标删，after 保留目标删其后。 */
  truncateMessages: (conversationId: string, input: TruncateMessagesInput) =>
    request<TruncateMessagesResult>('POST', `/conversations/${enc(conversationId)}/messages/truncate`, input),
  /* B16：SSE 流式发送。逐事件解析，text_delta 走回调增量渲染；
   * 流不可用 / 无 result / 网络失败一律降级到一次性 sendMessage；
   * 「停止生成」传入 signal 手动中止 —— 中止不降级，直接返回 E_ABORTED。 */
  streamMessage: async (conversationId, input, onTextDelta, signal) => {
    try {
      const response = await fetch(`${BASE}/conversations/${enc(conversationId)}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: signal ?? null,
      });
      if (!response.ok || !response.body) throw new Error(`stream http ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let final: ApiEnvelope<MessageTurn> | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((item) => item.startsWith('data: '));
          if (!line) continue;
          let payload: { ok?: boolean; data?: { type?: string; content?: string; result?: MessageTurn }; error?: ApiError };
          try { payload = JSON.parse(line.slice(6)); } catch { continue; }
          if (payload.data?.type === 'result' && payload.data.result) {
            final = { ok: true, data: payload.data.result, error: null, meta: { requestId: requestId(), ts: Date.now(), apiMode: 'live' } };
          } else if (payload.data?.type === 'text_delta' && payload.data.content) {
            onTextDelta?.(payload.data.content);
          } else if (payload.ok === false) {
            final = { ok: false, data: null as unknown as MessageTurn, error: payload.error ?? { code: 'E_INTERNAL', message: '流式响应失败' }, meta: { requestId: requestId(), ts: Date.now(), apiMode: 'live' } };
          }
        }
      }
      if (!final) throw new Error('stream ended without result');
      return final;
    } catch (error) {
      /* 手动中断不是失败：不降级重发（否则"停止"反而触发一轮新的完整请求）。 */
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return {
          ok: false,
          data: null as unknown as MessageTurn,
          error: { code: 'E_ABORTED', message: '已手动停止生成' },
          meta: { requestId: requestId(), ts: Date.now(), apiMode: 'live' },
        };
      }
      return api.sendMessage(conversationId, input);
    }
  },
  uploadAttachment: (conversationId, input) =>
    request<{ id: string; name: string; fileName: string; sizeBytes: number }>(
      'POST', `/conversations/${enc(conversationId)}/attachments`, input, { timeoutMs: 30000 },
    ),
  exportConversation: (conversationId: string, format?: 'md' | 'json') =>
    request<{ content: string; fileName: string }>('GET', `/conversations/${enc(conversationId)}/export${qs({ format })}`),
  listCitations: (conversationId: string) => request<Citation[]>('GET', `/conversations/${enc(conversationId)}/citations`),
  getCitation: (citationId: string) => request<CitationDetail>('GET', `/citations/${enc(citationId)}`),
  respondApproval: (conversationId: string, messageId: string, decision: 'approve' | 'deny', scope: 'once' | 'session' = 'once') =>
    request<MessageCard>('POST', `/approvals/${enc(messageId)}`, { conversationId, decision, scope }),
  rollbackApproval: (conversationId: string, messageId: string) =>
    request<{ ok: boolean; message: string; auditId?: string }>('POST', `/approvals/${enc(messageId)}/rollback`, { conversationId }),
  getToolFace: (workspaceId?: string) => request<ToolFace>('GET', `/tools${qs({ workspaceId })}`),
  createCommandSuggestion: (conversationId: string, input: SuggestionInput) =>
    request<CommandSuggestion>('POST', '/command-suggestions', { conversationId, ...input }),

  /* ---- 右栏 3 Tab / 用量 / 产物 ---- */
  getContextPanel: (conversationId: string) => request<ContextPanel>('GET', `/conversations/${enc(conversationId)}/context`),
  getExecutionPanel: (conversationId: string) => request<ExecutionPanel>('GET', `/conversations/${enc(conversationId)}/execution`),
  getArtifactPanel: (conversationId: string) => request<ArtifactPanel>('GET', `/conversations/${enc(conversationId)}/artifacts`),
  getUsage: (conversationId: string) => request<Usage>('GET', `/conversations/${enc(conversationId)}/usage`),
  downloadArtifact: (artifactId: string) =>
    request<{ url: string; fileName: string; sizeBytes: number }>('GET', `/artifacts/${enc(artifactId)}/download`),
  /* 产物预览（右栏「文件」Tab）：文本给内容、图片给 URL、二进制只给元信息。 */
  getArtifactPreview: (artifactId: string) => request<ArtifactPreview>('GET', `/artifacts/${enc(artifactId)}/preview`),
  /* 内置浏览器状态（会话级）：Agent 的 browser_navigate 写这里，前端轮询后跳转。 */
  getBrowserState: (conversationId: string) => request<BrowserState>('GET', `/conversations/${enc(conversationId)}/browser`),
  setBrowserState: (conversationId: string, url: string) =>
    request<BrowserState>('POST', `/conversations/${enc(conversationId)}/browser`, { url }),
  /* 页面快照：前端回传 → Agent 的 browser_read_page 读。 */
  getBrowserPage: (conversationId: string) => request<BrowserPage>('GET', `/conversations/${enc(conversationId)}/browser/page`),
  setBrowserPage: (conversationId: string, payload: { title: string; text: string }) =>
    request<BrowserPage>('POST', `/conversations/${enc(conversationId)}/browser/page`, payload),

  /* ---- 终端 ---- */
  listTerminalSessions: (assetId: string) => request<TerminalSession[]>('GET', `/assets/${enc(assetId)}/terminal/sessions`),
  createTerminalSession: (assetId: string) => request<TerminalSession>('POST', `/assets/${enc(assetId)}/terminal/sessions`),
  updateTerminalSession: (assetId: string, sid: string, patch: { cwd?: string }) =>
    request<TerminalSession>('PATCH', `/assets/${enc(assetId)}/terminal/sessions/${enc(sid)}`, patch),
  closeTerminalSession: (assetId: string, sid: string) =>
    request<{ closed: true }>('DELETE', `/assets/${enc(assetId)}/terminal/sessions/${enc(sid)}`),
  executeCommand: (assetId: string, input: ExecuteCommandInput) =>
    request<ExecResult>('POST', `/assets/${enc(assetId)}/terminal/execute`, input, { timeoutMs: 12000 }),
  getCommandHistory: (assetId: string, sid: string) =>
    request<CommandHistory[]>('GET', `/assets/${enc(assetId)}/terminal/history${qs({ sid })}`),
  getCommandWhitelist: () => request<WhitelistEntry[]>('GET', '/commands/whitelist'),
  getCommandBlacklist: () => request<BlacklistRule[]>('GET', '/commands/blacklist'),
  /* 技能登记表（服务端唯一事实来源）：输入框「/ 技能」菜单的数据源。 */
  listSkills: () => request<Skill[]>('GET', '/skills'),

  /* ---- SQL ---- */
  /* B11：后端 SQL 超时为 15s（worker.terminate），前端必须放宽到 16s，否则合法慢查询被 abort 降级 mock。 */
  runSqlQuery: (assetId: string, sql: string, options?: SqlQueryOptions) =>
    request<SqlResult>('POST', `/assets/${enc(assetId)}/sql/query`, { sql, options: options ?? {} }, { timeoutMs: 16000 }),
  getSqlSchema: (assetId: string) => request<SqlSchema>('GET', `/assets/${enc(assetId)}/sql/schema`),
  getTableRows: (assetId: string, table: string, params: TableRowsParams) =>
    request<TableRows>('GET', `/assets/${enc(assetId)}/sql/tables/${enc(table)}/rows${qs({
      page: params.page,
      pageSize: params.pageSize,
      sort: params.sort ?? '',
      dir: params.dir ?? 'asc',
      filters: params.filters && params.filters.length > 0 ? JSON.stringify(params.filters) : '',
    })}`),
  getTableStructure: (assetId: string, table: string) =>
    request<TableStructure>('GET', `/assets/${enc(assetId)}/sql/tables/${enc(table)}/structure`),
  /** 字段详情（含默认值 / 主键标记），比 structure 更完整。 */
  getTableFields: (assetId: string, table: string) =>
    request<TableFields>('GET', `/assets/${enc(assetId)}/sql/tables/${enc(table)}/fields`),
  /** DDL 预览：真实建表语句。 */
  getTableDdl: (assetId: string, table: string) =>
    request<TableDdl>('GET', `/assets/${enc(assetId)}/sql/tables/${enc(table)}/ddl`),
  exportSqlCsv: (assetId: string, sql: string, format: 'csv' | 'json' | 'md' | 'sql' = 'csv') =>
    request<{ content: string; fileName: string; mime: string; format: string; auditId: string }>(
      'POST',
      `/assets/${enc(assetId)}/sql/export`,
      { sql, format },
      { timeoutMs: 16000 },
    ),

  /* ---- 文件 / 编辑器 ---- */
  getFileTree: (assetId: string) => request<FileNode[]>('GET', `/assets/${enc(assetId)}/files/tree`),
  getFileContent: (assetId: string, path: string) =>
    request<FileContent>('GET', `/assets/${enc(assetId)}/files/content${qs({ path })}`),
  getFileOutline: (assetId: string, path: string) =>
    request<FileOutline>('GET', `/assets/${enc(assetId)}/files/outline${qs({ path })}`),
  getFileDiff: (assetId: string, path: string) =>
    request<FileDiff>('GET', `/assets/${enc(assetId)}/files/diff${qs({ path })}`),
  saveFile: (assetId: string, input: SaveFileInput) =>
    request<SaveFileResult>('POST', `/assets/${enc(assetId)}/files/save`, input),
  requestAgentWrite: (assetId: string, input: AgentWriteInput) =>
    request<AgentWriteResult>('POST', `/assets/${enc(assetId)}/files/agent-write`, input),
  generatePatch: (assetId: string, input: PatchInput) =>
    request<{ patch: string; applicable: false }>('POST', `/assets/${enc(assetId)}/files/patch`, input),
  getGitSummary: (assetId: string) => request<GitSummary>('GET', `/assets/${enc(assetId)}/files/git`),

  /* ---- 本地工作区仓库（代码库 = 克隆到本地） ---- */
  getRepoStatus: (assetId: string) => request<RepoStatus>('GET', `/assets/${enc(assetId)}/repo`),
  cloneRepo: (assetId: string, input: CloneRepoInput) =>
    request<CloneRepoResult>('POST', `/assets/${enc(assetId)}/clone`, input, { timeoutMs: 320000 }),
  ensureWorkspaceDir: (workspaceId: string) =>
    request<{ workspaceId: string; localRoot: string }>('POST', `/workspaces/${enc(workspaceId)}/local-dir`, {}),
  getSensitiveRules: () => request<SensitiveRule[]>('GET', '/sensitive-rules'),
  updateSensitiveRules: (rules: SensitiveRule[]) => request<SensitiveRule[]>('PUT', '/sensitive-rules', { rules }),

  /* ---- 设置 ---- */
  getSettings: () => request<Settings>('GET', '/settings'),
  updateSettings: (section: SettingsSection, patch: Dict) => request<Settings>('PATCH', `/settings/${enc(section)}`, patch),
  getEffectivePolicy: () => request<EffectivePolicy>('GET', '/effective-policy'),
  probePermission: (input: PermissionProbeInput) => request<PermissionDecision>('POST', '/settings/permission-probe', input),
  clearCache: () =>
    request<{ clearedSnapshots: number; clearedUsage: number; kept: string[]; auditId: string }>(
      'POST', '/maintenance/clear-cache', {},
    ),
  getLlmKeyStatus: () => request<LlmKeyStatus>('GET', '/settings/llm-key'),
  setLlmKey: (secret: string) => request<LlmKeySetResult>('POST', '/settings/llm-key', { secret }),
  getLlmConfig: () => request<LlmConfig>('GET', '/settings/llm-config', undefined, { timeoutMs: 5000 }),
  saveLlmConfig: (input: LlmConfigInput) => request<LlmConfig>('PUT', '/settings/llm-config', input, { timeoutMs: 8000 }),
  testLlmConfig: (input: LlmConfigInput & { profileId?: string }) =>
    request<LlmTestResult>('POST', '/settings/llm-config/test', input, { timeoutMs: 25000 }),
  /* 从端点实拉模型列表（GET /models）；拉取失败服务端会回落预设推荐。 */
  fetchLlmModels: (input: LlmModelListInput) =>
    request<LlmModelList>('POST', '/settings/llm-models', input, { timeoutMs: 15000 }),
  /* ---- 模型档案（可添加多个模型）---- */
  addLlmProfile: (input: LlmProfileInput) =>
    request<LlmConfig>('POST', '/settings/llm-profiles', input, { timeoutMs: 8000 }),
  updateLlmProfile: (id: string, input: LlmProfileInput) =>
    request<LlmConfig>('PATCH', `/settings/llm-profiles/${enc(id)}`, input, { timeoutMs: 8000 }),
  removeLlmProfile: (id: string) =>
    request<LlmConfig>('DELETE', `/settings/llm-profiles/${enc(id)}`, undefined, { timeoutMs: 8000 }),
  activateLlmProfile: (id: string) =>
    request<LlmConfig>('POST', `/settings/llm-profiles/${enc(id)}/activate`, {}, { timeoutMs: 8000 }),

  /* ---- 审计 ---- */
  listAudit: (query: AuditQuery) =>
    request<{ items: AuditEvent[]; total: number; page: number; pageSize: number }>('GET', `/audit${qs({ ...query })}`),
  getAuditEvent: (id: string) => request<AuditEvent>('GET', `/audit/${enc(id)}`),
  exportAuditCsv: (query: AuditQuery) =>
    request<{ content: string; fileName: string; auditId: string; exported: number; total: number }>(
      'POST', '/audit/export', query,
    ),
};
