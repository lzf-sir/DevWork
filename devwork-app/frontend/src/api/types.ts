/**
 * DevWork REST 实体与包络类型。
 * 契约来源：架构师 §6 / 主理人中转 spec。实体先定义为宽松 interface，联调时再收紧。
 */

export type Dict = Record<string, unknown>;
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
export type ApiMode = 'live' | 'mock';

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiMeta {
  requestId: string;
  ts: number;
  apiMode?: ApiMode;
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T;
  error: ApiError | null;
  meta?: ApiMeta;
}

/* ---------------- 系统 / 引导 ---------------- */

export interface Health {
  status: 'ok' | 'degraded';
  driver: 'node:sqlite' | 'sql.js' | 'none';
  wal: boolean;
  version: string;
  time: string;
  /**
   * 内网访问开关（`DEVWORK_BROWSER_ALLOW_PRIVATE=1`）当前是否生效。
   *
   * 声明为**可选**是诚实的做法：后端未上报时是 `undefined`，前端必须显示
   * 「未上报」而不是默认 `false` —— 否则 env 开着的时候界面会说"未开启"，
   * 那是我们这一轮一直在修的那类"界面说谎"。
   */
  browserAllowPrivate?: boolean;
}

export interface Bootstrap {
  workspaceId: string;
  workspaceName: string;
  apiMode: ApiMode;
  readOnlyMode: boolean;
}

/* ---------------- 工作区 / 侧栏 / 状态栏 ---------------- */

export interface Workspace {
  id: string;
  name: string;
  description: string;
  indexProgress: number;
  assetsCount: number;
  conversationsCount: number;
  owner: string;
  recentLabel: string;
  trustLevel: string;
}

export interface WorkspaceInput {
  name: string;
  description?: string;
}

export interface SwitchResult {
  workspaceId: string;
  workspaceName: string;
  sidebar: Dict;
  context: Dict;
  execution: Dict;
  artifacts: Dict;
  statusBar: StatusBar;
}

export interface Sidebar {
  workspaceId: string;
  assetFolders: Dict[];
  looseAssets: Dict[];
  convFolders: Dict[];
  looseConvs: Dict[];
}

export interface StatusBar {
  model: string;
  contextUsed: number;
  contextBudget: number;
  costCny: number;
  state: string;
}

/* ---------------- 文件夹 / 资产 ---------------- */

export interface Folder {
  id: string;
  workspaceId: string;
  kind: 'asset' | 'conversation';
  name: string;
  collapsed: boolean;
  sortOrder: number;
  count: number;
}

export interface FolderInput {
  workspaceId: string;
  kind: 'asset' | 'conversation';
  name: string;
  parentId?: string | null;
  /** 折叠状态也走 PATCH —— 侧栏抽屉的展开/收起要能跨会话保持。 */
  collapsed?: boolean;
}

export interface MoveItemInput {
  itemId: string;
  kind: 'asset' | 'conversation';
  targetFolderId: string | null;
}

export interface Asset {
  id: string;
  workspaceId: string;
  type: string;
  name: string;
  env?: string;
  status: string;
  indexProgress?: number;
  credentialBound?: boolean;
  /** 凭据绑定失败时的原因（如实回传，不含糊成"已接入"）。 */
  credentialError?: string;
}

/** 鉴权方式。与后端 credential_binding.auth_method 一致。 */
export type AuthMethod = 'password' | 'token' | 'sshkey' | 'none';

/** 接入资产时一起提交的凭据。秘密走凭据通道，绝不进 asset.config。 */
export interface AssetCredentialInput {
  /** 凭据标签（人读，例：「账号密码 · readonly」）。 */
  label: string;
  /** 鉴权方式。 */
  method: AuthMethod;
  /** 账号名（令牌 / 私钥可以为空）。 */
  username?: string;
  /** 秘密明文（口令 / 令牌 / 私钥）：服务端经 safeStorage 加密存本机，库里只留引用。 */
  secret?: string;
}

/* 写入载荷的真源在 shared/contracts（zod 推导）：type 收紧为资产类型枚举，
 * 传错类型现在会变成编译错误，而不是等后端 400。 */
import type { AssetCreateInput as AssetCreateInputContract } from '../../../shared/contracts';
export type AssetInput = AssetCreateInputContract;

export interface AssetDetail extends Asset {
  subtitle: string;
  pills: Dict[];
  tabs: string[];
  metrics: Dict[];
  kv: Dict[];
  activities: Dict[];
  capabilities: Capability[];
  statusBar: Dict;
  /** 结构化配置（服务端白名单过滤后落库的那份）：编辑表单据此预填，绝不含秘密。 */
  config?: Dict;
  /** 连接串 / 仓库地址（config.endpoint 或 config.cloneUrl 的回读值）。 */
  endpoint?: string;
  /** 已绑定的鉴权方式与账号名：回显「绑的是谁、用哪种方式」，秘密本身永不回显。 */
  authMethod?: string;
  credentialUsername?: string;
}

export interface Activity {
  id: string;
  createdAt: string;
  createdAtLabel: string;
  text: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  granted: boolean;
  locked: boolean;
}

export interface CapabilityPatch {
  granted?: boolean;
  approval?: 'auto' | 'ask' | 'deny';
}

export interface SearchHit {
  id: string;
  title: string;
  /** 可直接消费的定位串（doc 为 path:起-止，code 为 path:行）。 */
  locator: string;
  /** 真实源文件路径与行号 —— 没有它「打开」只能弹假提示。 */
  path: string;
  startLine: number;
  endLine: number;
  kind: 'code' | 'doc';
  score: number;
}

export interface KbDocument {
  path: string;
  name: string;
  chunks: number;
  lines: number;
  firstLine: number;
  lastLine: number;
}

export interface KbDocumentList {
  files: KbDocument[];
  documents: number;
  chunks: number;
}

export interface Credential {
  assetId: string;
  state: 'unbound' | 'active' | 'expiring' | 'expired' | 'revoked';
  label: string;
  lastUsedLabel?: string;
  expiresAt?: string;
  /** 鉴权方式（password / token / sshkey）。 */
  authMethod?: string;
  /** 资产侧的账号名（不是绑定人的名字）。 */
  username?: string;
}

export interface CredentialBindInput {
  label: string;
  secretRef?: string;
  /** B17：凭据明文（仅传输用于 safeStorage 加密存储，DB 只存引用）。 */
  secret?: string;
  /** 鉴权方式。 */
  method?: AuthMethod;
  /** 资产侧的账号名。 */
  username?: string;
}

/* ---------------- 会话 / 消息 / 引用 ---------------- */

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  folderId?: string | null;
  /** 资产绑定：从资产详情页唤起的会话默认挂在这个资产上（普通会话为空）。 */
  assetId?: string | null;
  /** 绑定资产的类型：code / db / server / kb。 */
  assetType?: string | null;
  createdAt: string;
  /** 归档时间：null/缺省 = 活跃会话；非空 = 已归档（侧栏隐藏，归档管理页可恢复 / 删除）。 */
  archivedAt?: string | null;
}

export interface ConversationInput {
  workspaceId: string;
  title: string;
  folderId?: string | null;
  /** 绑定资产（可选）：服务端每轮自动并入该会话的 assetIds。 */
  assetId?: string | null;
  assetType?: string | null;
  /** 归档开关（PATCH 用）：true 归档、false 恢复；创建时忽略。 */
  archived?: boolean;
}

/** 结构化会话卡片。payload 按 kind 存放 chips / steps / confidence / citationIds 等。 */
export interface MessageCard {
  id: string;
  conversationId: string;
  kind:
    | 'bubble'
    | 'plan'
    | 'todo'
    | 'summary'
    | 'text'
    | 'tool_row'
    | 'approval_card'
    | 'suggestion'
    | 'conclusion'
    | 'artifact'
    | 'notice'
    | 'patch'
    // 兼容前端渲染的等价别名
    | 'user'
    | 'tool';
  payload: Dict;
  createdAt: string;
  actor: 'user' | 'agent' | 'system';
}

export interface Citation {
  id: string;
  title: string;
  source: string;
  locator: string;
  snippet: string;
  confidence: number;
  version?: string;
  /** 源文件定位：null 表示没有可打开的源文件（UI 应禁用「打开」）。 */
  path?: string | null;
  startLine?: number | null;
  endLine?: number | null;
}

export interface CitationDetail extends Citation {
  code: string;
  score: string;
}

export interface MessageTurn {
  messages: MessageCard[];
  citations: Citation[];
  artifacts: Dict[];
  panels: { context: Dict; execution: Dict; artifacts: Dict };
  statusBar: StatusBar;
  intent: string;
  gateway: 'mock' | 'openai-compatible';
}

/* 写入载荷的唯一真源在 shared/contracts（zod schema 推导）；
 * 这里只做转出，避免前后端各写一份接口定义再靠人肉对齐。 */
import type { SendMessageInput as SendMessageInputContract } from '../../../shared/contracts';
export type SendMessageInput = SendMessageInputContract;

/** 手动压缩的入参（全字段可选：不传就按当前模型窗口的默认水位）。 */
import type { CompactContextInput as CompactContextInputContract } from '../../../shared/contracts';
export type CompactContextInput = CompactContextInputContract;

/** 消息时间线截断（撤回 / 编辑重发 / 重试共用）。 */
export interface TruncateMessagesInput {
  messageId: string;
  /** inclusive 连目标一起删；after 保留目标（用户气泡）删其后全部内容。 */
  mode: 'inclusive' | 'after';
}

export interface TruncateMessagesResult {
  deleted: number;
  mode: string;
  /** after 模式下回传被保留气泡的原始载荷（重试时复用 assetIds / attachments）。 */
  bubble?: { content: string; assetIds: string[]; attachments: string[]; chips: string[] };
  /** 随消息一并清掉的下游产物：产物行 / 磁盘文件 / 引用行 / 工具调用行。 */
  artifacts: number;
  files: number;
  citations: number;
  toolCalls: number;
}

/** 单轮回复的 token 用量（写在轮末卡片 payload.usage 上）。 */
export interface TurnUsage {
  /** 模型真回传的输入侧 tokens；估算模式下为 null（不编造）。 */
  promptTokens?: number | null;
  completionTokens?: number;
  totalTokens?: number;
  costCny?: number;
  model?: string;
}

/* ---------------- 任务清单 / 上下文压缩 ---------------- */

/** 清单项状态：只有四种。没有「进展顺利」这种无法判断真假的中间态。 */
export type TodoStatus = 'pending' | 'doing' | 'done' | 'blocked';

export interface TodoProgressView {
  done: number;
  total: number;
  doing: number;
  blocked: number;
  percent: number;
}

/** 上下文用量明细：输入框小按钮的浮层读它。 */
export interface ContextUsage {
  /** 本轮真实会发给模型的 token 估算（系统 + 工具 + 清单 + 摘要 + 历史 + 本轮输入）。 */
  used: number;
  budget: number;
  ratio: number;
  /** 自动压缩水位（0~1，默认 0.8）。 */
  autoCompactAt: number;
  state: 'ok' | 'near' | 'over';
  /** 预算来源：设置页覆盖 / 按模型名推断 / 默认值。 */
  windowSource: 'setting' | 'model' | 'default';
  model: string;
  breakdown: { name: string; tokens: number }[];
  messages: { total: number; inWindow: number; folded: number };
  summary: { messages: number; tokens: number; source: string; mode: string; at: string; model: string } | null;
  shouldCompact: boolean;
}

/** 一次压缩的结果。skipped 时 reason 说明为什么不该压（不是失败）。 */
export interface CompactionResult {
  skipped: boolean;
  reason?: string;
  before: number;
  after: number;
  freed: number;
  /** 被折叠的消息条数（原始消息仍在时间线里）。 */
  covered: number;
  cardId?: string;
  summary?: { content: string; source: 'model' | 'rule'; model: string; messages: number; tokens: number };
  /** 摘要卡的 API 形状，前端插进时间线用。 */
  card?: MessageCard;
}

export interface SuggestionInput {
  command: string;
  reason: string;
}

export interface CommandSuggestion {
  id: string;
  command: string;
  executable: false;
  auditId: string;
}

/* ---------------- 右栏 / 用量 / 产物 ---------------- */

export interface ContextPanel {
  mounted: Dict[];
  hits: Dict[];
  bars: Dict[];
}

export interface ExecutionPanel {
  tools: Dict[];
  timings: Dict[];
  pending: Dict[];
}

export interface ArtifactPanel {
  items: Dict[];
  note: string;
}

/**
 * 产物预览（右栏「文件」Tab）。
 *
 * 文本类产物直接给内容（前端内联渲染），图片类给可直连的 URL，
 * 二进制不给内容只给元信息 —— 沙箱不解析二进制，如实说"不可预览"。
 */
export interface ArtifactPreview {
  fileName: string;
  sizeBytes: number;
  mime: string;
  /** text = 文本内容；image = 图片 URL；binary = 不可内联预览。 */
  kind: 'text' | 'image' | 'binary';
  content?: string;
  url?: string;
  /** 产物归属的会话（跨会话产物也能定位）。 */
  conversationId?: string;
}

/**
 * 内置浏览器的会话级状态。
 *
 * Agent 的 browser_navigate 工具把地址写进这里，前端浏览器 Tab 轮询后跳转 ——
 * 这条链路让「Agent 控制浏览器」是真的，而不是只在文案上写着。
 */
export interface BrowserState {
  url: string;
  updatedAt: string;
  /** 最近一次变更的来源：agent（Agent 驱动）/ user（用户手动）。 */
  by: 'agent' | 'user' | 'none';
}

/**
 * 内置浏览器当前页的正文快照。
 *
 * 前端把渲染后的标题与正文回传服务端，Agent 的 browser_read_page 读它 ——
 * 没有这份快照，"Agent 导航了"就只是"Agent 报了个地址"，它并没真的看过页面。
 */
export interface BrowserPage {
  title: string;
  text: string;
  capturedAt: string;
  url: string;
}

export interface Usage {
  contextUsed: number;
  contextBudget: number;
  costCny: number;
}

/* ---------------- 终端 ---------------- */

export interface TerminalSession {
  id: string;
  assetId: string;
  cwd: string;
  createdAt: string;
}

export interface ExecuteCommandInput {
  sessionId: string;
  command: string;
}

export interface ExecResult {
  executed: boolean;
  decision: 'allow' | 'deny' | 'suggest';
  reasonCode?: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  spawnCount: number;
  degraded?: boolean;
  dispatcher?: string;
  cwd?: string;
  auditId: string;
}

export interface CommandHistory {
  id: string;
  command: string;
  createdAt: string;
  result: string;
}

export interface WhitelistEntry {
  id: string;
  pattern: string;
  description: string;
}

export interface BlacklistRule {
  id: string;
  pattern: string;
  description: string;
}

/* ---------------- SQL ---------------- */

export interface SqlQueryOptions {
  maxRows?: number;
  timeoutMs?: number;
}

export interface SqlResult {
  /* 服务端 /sql/query 同时返回三种列视图：columns 为对象数组（含 name/type/nullable），
   * columnNames / columnsSimple 为字符串数组。前端统一经 sqlColumnNames() 收窄。 */
  columns: { name: string; type: string; nullable: boolean }[];
  columnNames: string[];
  columnsSimple: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
  statusText: string;
  guard: { injected: boolean; appliedLimit: number; notice: string };
  dbChecksumBefore: string;
  dbChecksumAfter: string;
}

export interface SqlSchema {
  /** 这份表清单属于哪个资产（服务端按 :id 校验过类型）。 */
  assetId?: string;
  env?: string;
  /** 库来源说明；沙箱内多个 db 资产共用同一个演示库时在这里写清楚。 */
  dbLabel?: string;
  sharedWith?: string[];
  tables: { name: string; schema: string; rowsLabel: string; totalRows?: number; kind?: 'table' | 'view' }[];
  /** 索引对象（Navicat 式对象树里是独立分类）。 */
  indexes?: { name: string; schema: string; rowsLabel: string; totalRows?: number }[];
  /** schema 分组列表，用于左侧树的分组标题。 */
  schemas?: string[];
}

export interface TableRowsParams {
  page: number;
  pageSize: number;
  /** 排序列；服务端只接受该表真实列名。 */
  sort?: string;
  /** 排序方向。 */
  dir?: 'asc' | 'desc';
  /** 筛选条件数组，服务端参数化绑定。 */
  filters?: BrowseFilter[];
}

export interface BrowseFilter {
  column: string;
  operator: string;
  value: string | number | null;
}

export interface TableRows {
  columns: string[];
  rows: unknown[][];
  page: number;
  pageSize?: number;
  totalPages: number;
  totalRows: number;
  /** 服务端实际应用的 WHERE（参数化前的样子），用于在 UI 上明示过滤口径。 */
  appliedWhere?: string;
  appliedOrder?: string;
}

/** 字段详情（PRAGMA 实读）。 */
export interface TableField {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  note: string;
}

export interface TableFields {
  columns: TableField[];
  indexes: string[][];
  foreignKeys: string[][];
}

/** DDL 预览（sqlite_master 原文）。 */
export interface TableDdl {
  name: string;
  sql: string;
  indexes: { name: string; sql: string }[];
}

export interface TableStructure {
  columns: { name: string; type: string; nullable: boolean; note: string; defaultValue?: string | null; primaryKey?: boolean }[];
  indexes: string[][];
  foreignKeys: string[][];
}

/* ---------------- 文件 / 编辑器 ---------------- */

export interface FileNode {
  name: string;
  path: string;
  depth: number;
  caret: string;
  isFile: boolean;
  modified?: boolean;
}

export interface FileContent {
  path: string;
  html: string;
  plain: string;
  gutterStart: number;
  language: string;
}

export interface FileOutline {
  symbols: { sg: string; label: string; line?: number }[];
  references: string[];
  git: string[];
}

export interface FileDiff {
  diff: string;
  clean: boolean;
}

export interface LlmKeyStatus {
  configured: boolean;
  source: 'keychain' | 'env' | 'none';
}

export interface LlmKeySetResult {
  stored: boolean;
  mode: 'safeStorage' | 'none';
  source: 'keychain' | 'none';
}

/* ---- C1 用户自配置模型 ---- */

export interface LlmPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  keyUrl: string;
  local?: boolean;
}

/**
 * 一条模型档案 = 一个模型 + 它自己的端点 + 它自己的 Key。
 * 多模型并行：不同供应商的模型各自一套配置，切换时连端点与 Key 一起换。
 */
export interface LlmProfile {
  id: string;
  /** 用户给这条档案起的名字，列表里显示它。 */
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  /** 本地端点（Ollama / vLLM）无需 Key。 */
  local: boolean;
  keyConfigured: boolean;
  keySource: 'keychain' | 'env' | 'none';
}

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  model: string;
  /** db = 设置页配置生效；env = 环境变量兜底；none = 未配置。 */
  source: 'db' | 'env' | 'none';
  keyConfigured: boolean;
  keySource: 'keychain' | 'env' | 'none';
  presets: LlmPreset[];
  /** 已添加的模型列表。 */
  profiles: LlmProfile[];
  /** 当前生效的档案 id。 */
  activeId: string;
}

export interface LlmConfigInput {
  provider?: string;
  baseUrl?: string;
  model?: string;
  /** 留空表示不修改已保存的 Key。 */
  apiKey?: string;
}

/** 新增 / 修改模型档案的入参。 */
export interface LlmProfileInput {
  label?: string;
  provider?: string;
  baseUrl?: string;
  model?: string;
  /** 留空表示不修改已保存的 Key。 */
  apiKey?: string;
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

/**
 * 端点实拉的模型列表（GET /models）。
 * 模型名写死会过时，列表以端点为准；拉取失败回落预设静态推荐并如实标注。
 */
export interface LlmModelList {
  models: string[];
  /** live = 端点实拉；fallback = 预设静态兜底。 */
  source: 'live' | 'fallback';
  message: string;
}

export interface LlmModelListInput {
  baseUrl?: string;
  provider?: string;
  profileId?: string;
  /** 未保存档案时临时用的 Key；留空则取档案 / 全局已存的。 */
  apiKey?: string;
}

/* ---- 技能（提示词级 Skill）：服务端登记表驱动 ---- */

export interface SkillTool {
  name: string;
  /** 工具归属资产的显示名（来自服务端工具登记表）。 */
  label?: string;
  risk?: 'low' | 'medium' | 'high' | 'unknown';
  readOnly?: boolean;
}

export interface SkillBudget {
  maxToolCalls?: number;
  maxTokens?: number;
}

export interface SkillWriteTool {
  name: string;
  label?: string;
  risk?: 'low' | 'medium' | 'high' | 'unknown';
  needsApproval: boolean;
}

export interface SkillAvailability {
  /** 依赖资产齐备才可用；缺失时前端显示「不可用」而非隐藏（设计 §4）。 */
  available: boolean;
  /** 工作区缺失的资产类型（db/code/server/log/api/kb）。 */
  missing: string[];
}

/** 派生工具面（诊断视图）。字段与服务端 deriveToolFace 返回对齐，
 *  entry/schema 等重对象在 UI 只挑需要的字段用。 */
export interface ToolFaceTool {
  name: string;
  assetId: string;
  assetName: string;
  assetEnv: string;
  risk: string;
  /** 被什么规则挡住而不进模型工具面（如 prod-env）；undefined = 在工具面内。 */
  gatedBy?: string;
  /** 工具描述（entry.description）。 */
  description?: string;
  /** V1 / V2。 */
  version?: string;
}

export interface ToolFace {
  workspaceId: string;
  workspaceTrust: string;
  all: ToolFaceTool[];
  active: ToolFaceTool[];
  derivationRules: string[];
}

export interface Skill {
  id: string;
  label: string;
  desc: string;
  category: string;
  /** 插入输入框的模板（用户可编辑后随消息提交）。 */
  template: string;
  tools: SkillTool[];
  /** 依赖资产类型：工作区缺类型 → 不可用。 */
  requiresAssets?: string[];
  /** 方法论预算：防止一个技能把整轮上下文吃光。 */
  budget?: SkillBudget;
  /** 可用性（服务端按工作区资产计算；离线兜底缺省视为可用）。 */
  availability?: SkillAvailability;
  /** 声明的 V2 写工具（全部走审批，技能不能偷偷带上免审工具）。 */
  writeTools?: SkillWriteTool[];
}

export interface SaveFileInput {
  path: string;
  content: string;
}

export interface SaveFileResult {
  path: string;
  bytesWritten: number;
  diskChanged: boolean;
  auditId: string;
}

export interface AgentWriteInput {
  path: string;
  patch: string;
}

export interface AgentWriteResult {
  decision: 'deny' | 'suggest';
  bytesWritten: 0;
  diskChanged: false;
  suggestion: string;
  auditId: string;
}

export interface PatchInput {
  path: string;
  patch?: string;
}

export interface GitSummary {
  branch: string;
  lastCommit: string;
  log: string;
}

/** 本地工作区仓库状态（代码库 = 克隆到本地）。 */
export interface RepoStatus {
  /** 是否已在本地克隆（false = 还没克隆或目录已丢）。 */
  cloned: boolean;
  /** 相对本地工作区根的路径，形如 `w-ops/order-service`。 */
  localPath: string;
  /** 本地绝对路径。 */
  absolutePath: string;
  /** 远端地址（已脱敏，不含 token）。 */
  cloneUrl: string;
  branch: string;
  commit: string;
  lastCommit: string;
  files: number;
  /** 是否有未提交改动。 */
  dirty: boolean;
  /** 异常说明（如目录缺失）。 */
  error: string;
}

export interface CloneRepoInput {
  /** 远端仓库地址：http(s) / ssh / git / file。 */
  url: string;
  branch?: string;
  /** 浅克隆深度，0 表示全量克隆。 */
  depth?: number;
  /** 私有仓库访问令牌；仅在内存中拼进 URL，不落库。 */
  token?: string;
  /** 已有克隆时是否拉取最新。 */
  pull?: boolean;
}

export interface CloneRepoResult {
  localPath: string;
  absolutePath: string;
  branch: string;
  commit: string;
  files: number;
  action: 'cloned' | 'pulled';
  remote: string;
  index: { chunks: number; files: number };
}

export interface SensitiveRule {
  id: string;
  pattern: string;
  description: string;
}

/* ---------------- 设置 ---------------- */

export type SettingsSection = 'gen' | 'model' | 'perm' | 'privacy' | 'look' | 'about';

export interface Settings {
  sections: Dict[];
  raw: Dict;
}

export interface EffectivePolicy {
  readOnlyMode: boolean;
  orgForceReadOnly: boolean;
  workspaceTrust: string;
  source: string;
}

export interface PermissionProbeInput {
  actor: 'user' | 'agent';
  action: string;
  risk?: 'low' | 'medium' | 'high';
  assetId?: string;
}

export interface PermissionDecision {
  decision: 'allow' | 'ask' | 'deny' | 'suggest';
  reason: string;
  reasonCode?: string;
  matchedPolicy?: string;
  suggestion?: string;
  /** 约束是用户最关心的部分：会不会落盘 / 能不能执行。 */
  constraints?: Dict;
  risk?: 'low' | 'medium' | 'high';
  auditId: string;
  serverLogId?: string;
  readOnlyMode: boolean;
}

/* ---------------- 审计 ---------------- */

export interface AuditQuery {
  /** 服务端分类（命令执行 / 凭据访问 / 策略变更 / 成员变更 / 其他）。 */
  category?: string;
  actor?: string;
  assetId?: string;
  action?: string;
  from?: string;
  to?: string;
  result?: string;
  page?: number;
  /** 每页条数，服务端上限 100。 */
  pageSize?: number;
}

export interface AuditEvent {
  id: string;
  createdAt: string;
  createdAtLabel: string;
  actor: string;
  source: 'user' | 'agent' | 'system';
  action: string;
  /** 服务端判定的分类，前端不再自己用正则推一遍。 */
  category?: string;
  target: string;
  result: string;
  severity: 'info' | 'warn' | 'critical';
  detail: string;
}

/* ---------------- ApiClient ---------------- */

/* ---------------- 影子链路（P1） ---------------- */

export type ShadowAcceptMode = 'off' | 'observe' | 'auto';
export type ShadowStrength = 'explicit' | 'inferred';

export interface ShadowRuleScope {
  actions: string[];
  riskCeiling?: 'low' | 'medium' | 'high';
  maxWrites?: number;
}

export interface ShadowRule {
  id: string;
  name: string;
  enabled: boolean;
  keywords: string[];
  assetTypes?: string[];
  /** 命中这条规则给出的授权范围。缺了它草案发不出来。 */
  scope?: ShadowRuleScope;
}

export interface ShadowPolicy {
  acceptMode: ShadowAcceptMode;
  allowedActors: string[];
  allowedBots: string[];
  threadRatePerHour: number;
  /** auto 每小时最多自动签发几份。0 = 关掉自动签发。 */
  autoMaxPerHour: number;
  /** 是否允许 auto 签发「有写权限」的范围。默认 false。 */
  autoAllowWrites: boolean;
  rules: ShadowRule[];
  policyVersion: string;
}

export interface ShadowSource {
  kind: string;
  enabled: boolean;
  triggers: number;
  lastSeenAt: string;
  /** 定时源的下次触发时刻（ISO）；其余源为空串。 */
  nextFireAt: string;
  /** 只有定时源有：调度方式与巡检提示语。 */
  schedule?: ShadowScheduleConfig;
}

export interface ShadowScheduleConfig {
  schedule?: 'daily' | 'interval';
  at?: string;
  everyMinutes?: number;
  prompt?: string;
}

export interface ShadowStatus {
  enabled: boolean;
  running: boolean;
  phase: string;
  retentionDays: number;
  tick: { count: number; lastTickAt: string; lastTickMs: number; intervalMs: number; batch: number };
  policy: ShadowPolicy;
  sources: ShadowSource[];
}

/** 一条决策。P1 的 kind 恒为 ignore —— 会不会接单看 wouldAccept。 */
export interface ShadowDecision {
  id: string;
  threadId: string;
  triggerId: string;
  kind: string;
  strength: ShadowStrength;
  /** true = 「本来会接这单」，影子期的核心产出。 */
  wouldAccept: boolean;
  reasonCode: string;
  reason: string;
  matchedRules: string[];
  policyVersion: string;
  evalMs: number;
  createdAt: string;
}

export interface ShadowTrigger {
  id: string;
  threadId: string;
  threadKey: string;
  sourceKind: string;
  actor: string;
  actorKind: string;
  addressed: boolean;
  body: string;
  disposition: string;
  decisionId: string;
  idemKey: string;
  receivedAt: string;
}

/** 授权草案的范围。assets 为空 = 范围未定（规则没写清 / 事件不挂资产）。 */
export interface ShadowMandateScope {
  /** asset = 收窄到一个具体资产；workspace = 工作区级（必须带 assetTypes 白名单）。 */
  level: 'workspace' | 'asset';
  workspaceId: string;
  assets: string[];
  assetTypes: string[];
  actions: string[];
  riskCeiling: 'low' | 'medium' | 'high';
  maxWrites: number;
}

export interface ShadowMandate {
  id: string;
  decisionId: string;
  /** P2 才挂工单；影子期恒为 null。 */
  ticketId: string | null;
  status: 'draft' | 'accepted' | 'narrowed' | 'rejected';
  strength: string;
  policyVersion: string;
  requester: string;
  scope: ShadowMandateScope;
  matchedRules: string[];
  attentionBudget: number;
  note: string;
  createdAt: string;
  reviewedAt: string | null;
  scopeUndefined: boolean;
  readOnly: boolean;
}

export type TicketStage =
  | 'grant' | 'queued' | 'working' | 'idle'
  | 'person/answer' | 'person/review' | 'person/blocked' | 'person/failed';

export interface TicketQuestion {
  id: string;
  question: string;
  options: unknown[];
  impact: string;
  askedAt: string;
}

/** 工单：P2 的执行单元。stage 由后端从事实推导，前端只显示。 */
export interface ShadowTicket {
  id: string;
  shortName: string;
  workspaceId: string;
  threadId: string;
  title: string;
  state: 'open' | 'ended';
  stage: TicketStage;
  endedReason: string;
  conversationId: string | null;
  mandateId: string | null;
  mandateStatus: string;
  matchedRules: string[];
  report: string;
  reportNote: string;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
  endedAt: string | null;
  /** 待人时的结构化提问：面板直接给输入框，不让人翻执行日志。 */
  question: TicketQuestion | null;
}

/** 一次派工。轮次多了之后，这张表是判断「它到底卡在哪一轮」的唯一依据。 */
export interface TicketAssignment {
  id: string;
  state: 'pending' | 'running' | 'ended' | string;
  report: string;
  reportNote: string;
  tokensIn: number;
  tokensOut: number;
  attempts: number;
  workdir: string;
  workerSession: string;
  startedAt: string;
  endedAt: string | null;
}

export interface TicketAttentionItem {
  id: string;
  question: string;
  options: unknown[];
  impact: string;
  blocking: boolean;
  askedAt: string;
  answeredAt: string | null;
  answer: string | null;
}

export interface TicketInboxItem {
  triggerId: string;
  actor: string;
  body: string;
  receivedAt: string;
}

/** 详情：一张单的全部事实。后端一次合成，前端不再串四个接口对时间线。 */
export interface TicketDetail extends ShadowTicket {
  mandate: {
    id: string;
    status: string;
    strength: string;
    policyVersion: string;
    requester: string;
    note: string;
    reviewedAt: string | null;
    scope: {
      level?: 'workspace' | 'asset';
      assets?: string[];
      assetTypes?: string[];
      actions?: string[];
      riskCeiling?: string;
      maxWrites?: number;
    };
    matchedRules: string[];
  } | null;
  assignments: TicketAssignment[];
  attentions: TicketAttentionItem[];
  inbox: TicketInboxItem[];
  totals: {
    rounds: number;
    failedRounds: number;
    tokensIn: number;
    tokensOut: number;
    wallMs: number;
    inboxCount: number;
  };
}

/**
 * 「待人」条目：谁在等我、等我做什么、等了多久。
 *
 * 只含 person/* 四种阶段（等你回答 / 待你验收 / 受阻待决 / 失败待处理），
 * 与 TicketStats.waitingHuman 同一口径 —— 侧栏数字点开必须正好是这个长度。
 */
export interface WaitingTicket {
  id: string;
  shortName: string;
  title: string;
  stage: string;
  /** 人话版阶段名，服务端给（同一个词不该有第二种译法）。 */
  waitingFor: string;
  conversationId: string | null;
  conversationTitle: string;
  workspaceId: string;
  /** 开始等的那一刻：有未答提问取提问时间，否则取工单创建时间。 */
  since: string;
  question: {
    id: string;
    question: string;
    options: unknown[];
    impact: string;
  } | null;
}

export interface WaitingSnapshot {
  items: WaitingTicket[];
  total: number;
  byStage: Record<string, number>;
}

export interface TicketStats {
  total: number;
  open: number;
  waitingHuman: number;
  endedByHuman: number;
  assignments: number;
  failedAssignments: number;
  attention: { asked: number; answered: number };
  /** 打扰密度：每张工单平均问了几次人。设计目标 ≤1.5。 */
  attentionPerTicket: number;
  stages: Record<string, number>;
  maxConcurrent: number;
  loop?: { running: boolean; intervalMs: number; steps: number; lastStepAt: string };
}

export interface ShadowStats {
  triggers: { total: number; pending: number; decided: number };
  /** auto 的实时水位：预算是否用满，决定「没接单」是判断还是刹车。 */
  auto?: {
    issuedLastHour: number;
    maxPerHour: number;
    budgetLeft: number;
    allowWrites: boolean;
    mode: string;
  };
  mandates?: {
    total: number; draft: number; accepted: number; narrowed: number; rejected: number;
    scopeUndefined: number;
    /** 粒度分布。 */
    levelAsset: number;
    levelWorkspace: number;
  };
  decisions: { total: number; wouldAccept: number; wouldAcceptRate: number };
  last24h: { decided: number; wouldAccept: number; estimatedDailyAccept: number };
  byReason: { reasonCode: string; count: number; wouldAccept: number }[];
  bySource: { kind: string; triggers: number }[];
}

export interface ApiClient {
  health(): Promise<ApiEnvelope<Health>>;
  bootstrap(workspaceId?: string): Promise<ApiEnvelope<Bootstrap>>;
  listWorkspaces(): Promise<ApiEnvelope<Workspace[]>>;
  createWorkspace(input: WorkspaceInput): Promise<ApiEnvelope<Workspace>>;
  getWorkspace(id: string): Promise<ApiEnvelope<Workspace>>;
  updateWorkspace(id: string, patch: Partial<WorkspaceInput>): Promise<ApiEnvelope<Workspace>>;
  deleteWorkspace(id: string): Promise<ApiEnvelope<{ deleted: true }>>;
  switchWorkspace(id: string): Promise<ApiEnvelope<SwitchResult>>;
  getSidebar(workspaceId: string): Promise<ApiEnvelope<Sidebar>>;
  getStatusBar(workspaceId: string): Promise<ApiEnvelope<StatusBar>>;

  listFolders(workspaceId: string, kind: 'asset' | 'conversation'): Promise<ApiEnvelope<Folder[]>>;
  createFolder(input: FolderInput): Promise<ApiEnvelope<Folder>>;
  updateFolder(id: string, patch: Partial<FolderInput>): Promise<ApiEnvelope<Folder>>;
  deleteFolder(id: string): Promise<ApiEnvelope<{ movedToParentId: string | null; affected: number }>>;
  reorderFolders(ids: string[]): Promise<ApiEnvelope<{ ok: true }>>;
  moveItem(input: MoveItemInput): Promise<ApiEnvelope<{ ok: true }>>;

  listAssets(workspaceId: string, type?: string): Promise<ApiEnvelope<Asset[]>>;
  createAsset(input: AssetInput): Promise<ApiEnvelope<Asset>>;
  getAsset(id: string): Promise<ApiEnvelope<AssetDetail>>;
  updateAsset(id: string, patch: Partial<AssetInput>): Promise<ApiEnvelope<Asset>>;
  deleteAsset(id: string): Promise<ApiEnvelope<{ deleted: true }>>;
  advanceIndex(id: string, patch?: { delta?: number; to?: number }): Promise<ApiEnvelope<{
    indexProgress: number;
    status: string;
    /** code / kb 走真实索引管线时返回的文件数与块数。 */
    chunks?: number;
    files?: number;
  }>>;
  getAssetActivities(id: string): Promise<ApiEnvelope<Activity[]>>;
  listCapabilities(assetId: string): Promise<ApiEnvelope<Capability[]>>;
  updateCapability(assetId: string, capId: string, patch: CapabilityPatch): Promise<ApiEnvelope<Capability>>;
  searchAsset(assetId: string, query: string): Promise<ApiEnvelope<SearchHit[]>>;
  /** 知识库文档清单（真实索引块统计 + 磁盘行数）。 */
  listDocuments(assetId: string): Promise<ApiEnvelope<KbDocumentList>>;
  getCredential(assetId: string): Promise<ApiEnvelope<Credential>>;
  bindCredential(assetId: string, input: CredentialBindInput): Promise<ApiEnvelope<Credential>>;
  renewCredential(assetId: string): Promise<ApiEnvelope<Credential>>;
  revokeCredential(assetId: string): Promise<ApiEnvelope<Credential>>;

  /** 会话列表。opts.archived=true 只返回已归档（跨工作区，归档管理页用）；默认只返回活跃会话。 */
  listConversations(workspaceId?: string, opts?: { archived?: boolean }): Promise<ApiEnvelope<Conversation[]>>;
  createConversation(input: ConversationInput): Promise<ApiEnvelope<Conversation>>;
  updateConversation(id: string, patch: Partial<ConversationInput>): Promise<ApiEnvelope<Conversation>>;
  deleteConversation(id: string): Promise<ApiEnvelope<{ deleted: true }>>;
  listMessages(conversationId: string): Promise<ApiEnvelope<MessageCard[]>>;
  sendMessage(conversationId: string, input: SendMessageInput): Promise<ApiEnvelope<MessageTurn>>;
  /** 消息时间线截断（撤回 / 编辑重发 / 重试共用）。 */
  truncateMessages(conversationId: string, input: TruncateMessagesInput): Promise<ApiEnvelope<TruncateMessagesResult>>;
  /** SSE 流式发送：text_delta 增量回调；signal 用于「停止生成」真中断。失败自动降级一次性 sendMessage（手动中止除外）。 */
  streamMessage(conversationId: string, input: SendMessageInput, onTextDelta?: (delta: string) => void, signal?: AbortSignal): Promise<ApiEnvelope<MessageTurn>>;
  uploadAttachment(conversationId: string, input: { name: string; contentBase64: string }): Promise<ApiEnvelope<{ id: string; name: string; fileName: string; sizeBytes: number }>>;
  exportConversation(conversationId: string, format?: 'md' | 'json'): Promise<ApiEnvelope<{ content: string; fileName: string }>>;
  listCitations(conversationId: string): Promise<ApiEnvelope<Citation[]>>;
  getCitation(citationId: string): Promise<ApiEnvelope<CitationDetail>>;
  respondApproval(
    conversationId: string,
    messageId: string,
    decision: 'approve' | 'deny',
    /**
     * 1.0 一律 `once`：后端按单次批准处理，`'session'` 仅为兼容旧客户端保留（不生效）。
     * 前端不要再提供会话级免审入口 —— 点了不生效的按钮等于界面说谎。
     */
    scope?: 'once' | 'session',
  ): Promise<ApiEnvelope<MessageCard>>;
  /** 回滚闸门：按审批卡 payload.rollbackRef 执行恢复（仅已批准且产生了回滚引用的卡）。 */
  rollbackApproval(conversationId: string, messageId: string): Promise<ApiEnvelope<{ ok: boolean; message: string; auditId?: string }>>;
  /** 派生工具面诊断：当前工作区资产×能力×信任级别算出的工具清单与裁剪原因。 */
  getToolFace(workspaceId?: string): Promise<ApiEnvelope<ToolFace>>;
  createCommandSuggestion(conversationId: string, input: SuggestionInput): Promise<ApiEnvelope<CommandSuggestion>>;

  getContextPanel(conversationId: string): Promise<ApiEnvelope<ContextPanel>>;
  getExecutionPanel(conversationId: string): Promise<ApiEnvelope<ExecutionPanel>>;
  getArtifactPanel(conversationId: string): Promise<ApiEnvelope<ArtifactPanel>>;
  getUsage(conversationId: string): Promise<ApiEnvelope<Usage>>;
  /** 上下文用量明细（输入框小按钮）：占用 / 预算 / 构成 / 上次压缩。 */
  getContextUsage(conversationId: string, model?: string): Promise<ApiEnvelope<ContextUsage>>;
  /** 手动压缩：把早前对话折叠成摘要卡，原始消息不动。 */
  compactContext(conversationId: string, input?: CompactContextInput): Promise<ApiEnvelope<CompactionResult>>;
  downloadArtifact(artifactId: string): Promise<ApiEnvelope<{ url: string; fileName: string; sizeBytes: number }>>;
  /** 产物预览（右栏「文件」Tab）：文本给内容、图片给 URL、二进制只给元信息。 */
  getArtifactPreview(artifactId: string): Promise<ApiEnvelope<ArtifactPreview>>;
  /** 内置浏览器当前地址（会话级）。 */
  getBrowserState(conversationId: string): Promise<ApiEnvelope<BrowserState>>;
  /** 设置内置浏览器地址（用户手动导航时同步，Agent 才能看到当前页）。 */
  setBrowserState(conversationId: string, url: string): Promise<ApiEnvelope<BrowserState>>;
  /** 读内置浏览器当前页的正文快照（Agent 的 browser_read_page 读的就是它）。 */
  getBrowserPage(conversationId: string): Promise<ApiEnvelope<BrowserPage>>;
  /** 回传当前页快照（前端在页面加载 / 导航后调用）。 */
  setBrowserPage(conversationId: string, payload: { title: string; text: string }): Promise<ApiEnvelope<BrowserPage>>;

  listTerminalSessions(assetId: string): Promise<ApiEnvelope<TerminalSession[]>>;
  createTerminalSession(assetId: string): Promise<ApiEnvelope<TerminalSession>>;
  updateTerminalSession(assetId: string, sid: string, patch: { cwd?: string }): Promise<ApiEnvelope<TerminalSession>>;
  closeTerminalSession(assetId: string, sid: string): Promise<ApiEnvelope<{ closed: true }>>;
  executeCommand(assetId: string, input: ExecuteCommandInput): Promise<ApiEnvelope<ExecResult>>;
  getCommandHistory(assetId: string, sid: string): Promise<ApiEnvelope<CommandHistory[]>>;
  getCommandWhitelist(): Promise<ApiEnvelope<WhitelistEntry[]>>;
  getCommandBlacklist(): Promise<ApiEnvelope<BlacklistRule[]>>;
  /** 技能登记表（服务端唯一事实来源）：输入框「/ 技能」菜单的数据源。 */
  listSkills(): Promise<ApiEnvelope<Skill[]>>;

  runSqlQuery(assetId: string, sql: string, options?: SqlQueryOptions): Promise<ApiEnvelope<SqlResult>>;
  getSqlSchema(assetId: string): Promise<ApiEnvelope<SqlSchema>>;  getTableRows(assetId: string, table: string, params: TableRowsParams): Promise<ApiEnvelope<TableRows>>;
  getTableStructure(assetId: string, table: string): Promise<ApiEnvelope<TableStructure>>;
  /** 字段详情（含默认值 / 主键标记）。 */
  getTableFields(assetId: string, table: string): Promise<ApiEnvelope<TableFields>>;
  /** DDL 预览：真实建表语句。 */
  getTableDdl(assetId: string, table: string): Promise<ApiEnvelope<TableDdl>>;
  exportSqlCsv(
    assetId: string,
    sql: string,
    format?: 'csv' | 'json' | 'md' | 'sql',
  ): Promise<ApiEnvelope<{ content: string; fileName: string; mime: string; format: string; auditId: string }>>;

  getFileTree(assetId: string): Promise<ApiEnvelope<FileNode[]>>;
  getFileContent(assetId: string, path: string): Promise<ApiEnvelope<FileContent>>;
  getFileOutline(assetId: string, path: string): Promise<ApiEnvelope<FileOutline>>;
  getFileDiff(assetId: string, path: string): Promise<ApiEnvelope<FileDiff>>;
  getLlmKeyStatus(): Promise<ApiEnvelope<LlmKeyStatus>>;
  setLlmKey(secret: string): Promise<ApiEnvelope<LlmKeySetResult>>;
  getLlmConfig(): Promise<ApiEnvelope<LlmConfig>>;
  saveLlmConfig(input: LlmConfigInput): Promise<ApiEnvelope<LlmConfig>>;
  testLlmConfig(input: LlmConfigInput & { profileId?: string }): Promise<ApiEnvelope<LlmTestResult>>;
  /** 从端点实拉模型列表（失败回落预设推荐）。 */
  fetchLlmModels(input: LlmModelListInput): Promise<ApiEnvelope<LlmModelList>>;
  /* ---- 模型档案（可添加多个模型）---- */
  addLlmProfile(input: LlmProfileInput): Promise<ApiEnvelope<LlmConfig>>;
  updateLlmProfile(id: string, input: LlmProfileInput): Promise<ApiEnvelope<LlmConfig>>;
  removeLlmProfile(id: string): Promise<ApiEnvelope<LlmConfig>>;
  activateLlmProfile(id: string): Promise<ApiEnvelope<LlmConfig>>;
  saveFile(assetId: string, input: SaveFileInput): Promise<ApiEnvelope<SaveFileResult>>;
  requestAgentWrite(assetId: string, input: AgentWriteInput): Promise<ApiEnvelope<AgentWriteResult>>;
  generatePatch(assetId: string, input: PatchInput): Promise<ApiEnvelope<{ patch: string; applicable: false }>>;
  getGitSummary(assetId: string): Promise<ApiEnvelope<GitSummary>>;

  /* ---- 本地工作区仓库（代码库 = 克隆到本地） ---- */
  getRepoStatus(assetId: string): Promise<ApiEnvelope<RepoStatus>>;
  cloneRepo(assetId: string, input: CloneRepoInput): Promise<ApiEnvelope<CloneRepoResult>>;
  ensureWorkspaceDir(workspaceId: string): Promise<ApiEnvelope<{ workspaceId: string; localRoot: string }>>;

  getSensitiveRules(): Promise<ApiEnvelope<SensitiveRule[]>>;
  updateSensitiveRules(rules: SensitiveRule[]): Promise<ApiEnvelope<SensitiveRule[]>>;

  getSettings(): Promise<ApiEnvelope<Settings>>;
  updateSettings(section: SettingsSection, patch: Dict): Promise<ApiEnvelope<Settings>>;
  getEffectivePolicy(): Promise<ApiEnvelope<EffectivePolicy>>;
  probePermission(input: PermissionProbeInput): Promise<ApiEnvelope<PermissionDecision>>;
  /** 清除派生缓存（上下文快照 / 用量统计）；会话、产物、审计、索引不动。 */
  clearCache(): Promise<ApiEnvelope<{ clearedSnapshots: number; clearedUsage: number; kept: string[]; auditId: string }>>;

  listAudit(query: AuditQuery): Promise<ApiEnvelope<{ items: AuditEvent[]; total: number; page: number; pageSize: number }>>;
  getAuditEvent(id: string): Promise<ApiEnvelope<AuditEvent>>;
  exportAuditCsv(query: AuditQuery): Promise<ApiEnvelope<{ content: string; fileName: string; auditId: string; exported: number; total: number }>>;

  /* ---- 影子链路（P1：只记录，不执行） ---- */
  getShadowStatus(): Promise<ApiEnvelope<ShadowStatus>>;
  getShadowStats(): Promise<ApiEnvelope<ShadowStats>>;
  listShadowDecisions(query?: { limit?: number; wouldAccept?: boolean; reason?: string }): Promise<ApiEnvelope<{ items: ShadowDecision[]; total: number }>>;
  listShadowTriggers(query?: { limit?: number; disposition?: string; threadKey?: string }): Promise<ApiEnvelope<{ items: ShadowTrigger[]; total: number }>>;
  runShadowTick(): Promise<ApiEnvelope<{ picked: number; evaluated: number; skipped: number }>>;
  updateShadowPolicy(patch: Partial<Omit<ShadowPolicy, 'policyVersion'>>): Promise<ApiEnvelope<ShadowPolicy>>;
  setShadowSource(kind: string, enabled: boolean, schedule?: ShadowScheduleConfig): Promise<ApiEnvelope<{ kind: string; enabled: boolean }>>;
  /** 立即触发一次（等价于「假装现在到点了」）；不推进下次到点时间。 */
  fireShadowSource(kind: string): Promise<ApiEnvelope<{ triggerId: string; threadId: string; created: boolean }>>;
  listShadowMandates(query?: { limit?: number; status?: string }): Promise<ApiEnvelope<{ items: ShadowMandate[]; total: number }>>;
  /** 人对草案表态。narrowed 时 services 端只会取交集，传新动作无效。 */
  listTickets(query?: { limit?: number; stage?: string; state?: string }): Promise<ApiEnvelope<{ items: ShadowTicket[]; total: number }>>;
  getTicketStats(): Promise<ApiEnvelope<TicketStats>>;
  /** 待人清单：侧栏徽标与会话 tab 橙点共用同一份事实。 */
  getWaitingTickets(limit?: number): Promise<ApiEnvelope<WaitingSnapshot>>;
  /** 按会话反查工单（协作流视图）：服务端一次合成详情，前端不再串 /tickets/:id。 */
  listConversationTickets(id: string, limit?: number): Promise<ApiEnvelope<{ items: TicketDetail[]; total: number }>>;
  getTicket(id: string): Promise<ApiEnvelope<TicketDetail>>;
  answerTicket(id: string, input: { attentionId: string; answer: string }): Promise<ApiEnvelope<{ message: string; ticket: ShadowTicket }>>;
  stopTicket(id: string): Promise<ApiEnvelope<{ ticket: ShadowTicket }>>;
  retryTicket(id: string): Promise<ApiEnvelope<{ message: string; ticket: ShadowTicket }>>;
  /** 手动推一轮 Agent 循环（研判 → 派单 → 执行 → 回收）。 */
  stepTickets(): Promise<ApiEnvelope<Record<string, unknown>>>;
  setShadowEnabled(enabled: boolean): Promise<ApiEnvelope<{ enabled: boolean }>>;
  exportShadowCsv(limit?: number): Promise<ApiEnvelope<{ content: string; fileName: string; rows: number }>>;
  reviewShadowMandate(id: string, input: { status: 'accepted' | 'narrowed' | 'rejected'; note?: string; actions?: string[] }): Promise<ApiEnvelope<ShadowMandate>>;
}
