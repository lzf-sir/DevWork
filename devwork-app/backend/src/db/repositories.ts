/**
 * 数据形状组装层：把 25 张表的行转成 REST 响应形状。
 * 同时兼容前端 api/mock.ts 的字段名与架构师契约的 5 个关键形状（super-set）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { all, get, newId, nowIso } from './database';
import { tryResolveRepoRoot } from '../services/workspace-repos';
import { SENSITIVE_RULES } from '../config/rules';

export type Row = Record<string, unknown>;

function str(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface WorkspaceShape {
  id: string;
  name: string;
  description: string;
  indexProgress: number;
  assetsCount: number;
  conversationsCount: number;
  owner: string;
  recentLabel: string;
  trustLevel: string;
  desc: string;
  index: number;
  assetsLabel: string;
  convLabel: string;
  recent: string;
}

export function workspaceShape(row: Row): WorkspaceShape {
  /* 项目卡三件套（资产数 / 会话数 / 索引进度）实时从资产与会话表统计，
   * 不再读种子阶段写死的 workspace.assets_count —— 否则建了资产、跑完索引，
   * 项目卡永远还是那组老数字。 */
  const wsId = str(row.id);
  const assetStats = get<Row>(
    'SELECT COUNT(*) AS n, COALESCE(AVG(index_progress), 0) AS avg_index FROM asset WHERE workspace_id = ?',
    wsId,
  );
  const assetsCount = Number(assetStats?.n ?? 0);
  const conversationsCount = Number((get<Row>('SELECT COUNT(*) AS n FROM conversation WHERE workspace_id = ?', wsId))?.n ?? 0);
  const indexProgress = assetsCount > 0 ? Math.round(Number(assetStats?.avg_index ?? 0)) : num(row.index_progress);
  return {
    id: wsId,
    name: str(row.name),
    description: str(row.description),
    indexProgress,
    assetsCount,
    conversationsCount,
    owner: str(row.owner_label, '仅我'),
    recentLabel: str(row.recent_label),
    trustLevel: str(row.trust_level, 'normal'),
    desc: str(row.description),
    index: indexProgress,
    assetsLabel: `${assetsCount} 个资产`,
    convLabel: `${conversationsCount} 个会话`,
    recent: str(row.recent_label),
  };
}

export function workspaceById(id: string): WorkspaceShape | null {
  const row = get<Row>('SELECT * FROM workspace WHERE id = ?', id);
  return row ? workspaceShape(row) : null;
}

export function listWorkspaces(): WorkspaceShape[] {
  const rows = all<Row>('SELECT * FROM workspace ORDER BY created_at');
  /* 不用 .map(workspaceShape)：回调里要 查询，map 会变成发射后不管。 */
  const out: WorkspaceShape[] = [];
  for (const row of rows) out.push(workspaceShape(row));
  return out;
}

/** 状态栏：用量与成本来自 usage_stat 真值；没有会话上下文时才回落到"未开始"。
 *  此前恒返回 32768 / 0.42，用户改了代码也永远看到同一个数——假数比没有数更糟。 */
export function statusBarShape(conversationId?: string): Row {
  const row = conversationId
    ? get<Row>('SELECT context_used, context_budget, cost_cny, model FROM usage_stat WHERE conversation_id = ?', conversationId)
    : undefined;
  if (!row) {
    return { model: '未接入模型', contextUsed: 0, contextBudget: 128000, costCny: 0, state: '就绪' };
  }
  return {
    model: str(row.model) || '未接入模型',
    contextUsed: num(row.context_used),
    contextBudget: num(row.context_budget) || 128000,
    costCny: num(row.cost_cny),
    state: '就绪',
  };
}

const ICON_BY_TYPE: Record<string, string> = { code: '▣', db: '▤', server: '▥', kb: '▧' };
const GO_BY_TYPE: Record<string, string | null> = { code: 'code', db: 'db', server: 'server', kb: 'kb' };

/** 资产状态：nb=未绑定凭据 / indexing=索引中 / ok=在线 / warn=其他异常。
 *  注意：不再输出索引进度百分比 —— 侧栏只保留一个状态点。 */
function assetStatus(row: Row): string {
  if (num(row.credential_bound) === 0) return 'nb';
  if (str(row.status) === 'indexing') return 'indexing';
  return str(row.status) === 'online' ? 'ok' : 'warn';
}

function assetLeaf(row: Row): Row {
  const status = assetStatus(row);
  return {
    id: str(row.id),
    name: str(row.name),
    icon: ICON_BY_TYPE[str(row.type)] ?? '▣',
    go: GO_BY_TYPE[str(row.type)] ?? null,
    env: str(row.env) || null,
    status,
    title: str(row.subtitle),
    indexProgress: num(row.index_progress),
    credentialBound: num(row.credential_bound) === 1,
    locked: num(row.credential_bound) === 0,
  };
}

/** 树化：只返回顶层文件夹，把 parent_id 指向自己的挂在 children 上（写入侧保证 depth ≤ 2）。 */
function folderTree(folders: Row[], leafOf: (folderId: string) => unknown[]): Row[] {
  const build = (row: Row, depth: number): Row => {
    const id = str(row.id);
    const items = leafOf(id);
    const kids = depth < 2
      ? folders.filter((f) => str(f.parent_id) === id).map((f) => build(f, depth + 1))
      : [];
    return {
      id,
      name: str(row.name),
      /* 计数含子文件夹里的条目，否则父级数字会比眼睛看到的少。 */
      count: items.length + kids.reduce((sum, kid) => sum + Number(kid.count ?? 0), 0),
      open: num(row.collapsed) === 0,
      collapsed: num(row.collapsed) === 1,
      items,
      children: items,
      subFolders: kids,
      parentId: row.parent_id ? str(row.parent_id) : null,
      type: 'folder',
    };
  };
  return folders.filter((f) => !f.parent_id).map((f) => build(f, 1));
}

/** 契约形状 ④ + 前端渲染形状（super-set）。 */
export function sidebarShape(workspaceId: string): Row {
  const ws = workspaceById(workspaceId);
  const folders = all<Row>(
    "SELECT * FROM folder WHERE workspace_id = ? AND kind = 'asset' ORDER BY sort_order",
    workspaceId,
  );
  const convFolders = all<Row>(
    "SELECT * FROM folder WHERE workspace_id = ? AND kind = 'conversation' ORDER BY sort_order",
    workspaceId,
  );
  const assets = all<Row>('SELECT * FROM asset WHERE workspace_id = ? ORDER BY created_at', workspaceId);
  /* 已归档会话不进侧栏：归档管理页（GET /api/conversations?archived=1）才是它们的入口。 */
  const conversations = all<Row>(
    'SELECT * FROM conversation WHERE workspace_id = ? AND archived_at IS NULL ORDER BY sort_order',
    workspaceId,
  );

  const assetFolders = folderTree(folders, (folderId) =>
    assets.filter((a) => str(a.folder_id) === folderId).map(assetLeaf));
  const looseAssets = assets.filter((a) => !a.folder_id).map(assetLeaf);
  const convTree = folderTree(convFolders, (folderId) =>
    conversations
      .filter((c) => str(c.folder_id) === folderId)
      .map((c) => ({
        id: str(c.id),
        title: str(c.title),
        /* 资产绑定：为空表示普通会话。 */
        assetId: str(c.asset_id),
        assetType: str(c.asset_type),
      })));
  const looseConvs = conversations
    .filter((c) => !c.folder_id)
    .map((c) => ({
      id: str(c.id),
      title: str(c.title),
      assetId: str(c.asset_id),
      assetType: str(c.asset_type),
    }));

  const assetTree = [...assetFolders, ...looseAssets.map((a) => ({ ...a, type: 'asset' }))];
  const conversationTree = [...convTree, ...looseConvs.map((c) => ({ ...c, type: 'conversation' }))];
  const firstConversation = conversations.find((c) => str(c.id) === 'c-gmv') ?? conversations[0];

  return {
    workspaceId,
    workspace: ws ? { ...ws, isDefault: workspaceId === 'w-ops' } : null,
    assetFolders,
    looseAssets,
    convFolders: convTree,
    looseConvs,
    assetTree,
    conversationTree,
    /* 资产绑定的会话在侧栏里带一个徽标，让用户知道这条会话是从哪个资产唤起的。 */
    assetConversations: conversations
      .filter((c) => str(c.asset_id) !== '')
      .map((c) => ({ id: str(c.id), title: str(c.title), assetId: str(c.asset_id), assetType: str(c.asset_type) })),
    currentConversationId: firstConversation ? str(firstConversation.id) : '',
    readOnlyMode: readOnlyMode(),
    statusBar: statusBarShape(),
  };
}

/** 只读总开关：设置项里的强制只读与本地只读任一开启即生效。 */
export function readOnlyMode(): boolean {
  const perm = get<Row>("SELECT raw FROM setting WHERE section = 'perm'");
  const raw = json<Row>(perm?.raw ?? '{}', {});
  return raw.readOnlyMode === true || raw.orgForceReadOnly === true;
}

export function effectivePolicy(): Row {
  const perm = get<Row>("SELECT raw FROM setting WHERE section = 'perm'");
  const raw = json<Row>(perm?.raw ?? '{}', {});
  return {
    readOnlyMode: readOnlyMode(),
    orgForceReadOnly: raw.orgForceReadOnly === true,
    workspaceTrust: str(raw.workspaceTrust, 'prod'),
    source: raw.orgForceReadOnly === true ? 'org' : 'workspace',
  };
}

export function settingRaw(section: string): Row {
  const row = get<Row>('SELECT raw FROM setting WHERE section = ?', section);
  return json<Row>(row?.raw ?? '{}', {});
}

/**
 * 组织名。
 *
 * 原来这里硬编码「订单中台」——原型期的虚构组织名。交付给用户的程序里
 * 带着它，用户会以为程序已经被预置到了某个业务组织里。改成读 setting，
 * 打包态播种中性默认名（「我的组织」），用户可在设置里改。
 */
export function orgName(): string {
  const name = String((settingRaw('org')).name ?? '').trim();
  return name || '我的组织';
}

export function allSettings(): Row {
  const raw: Row = {};
  /* 原来写成 all(...).forEach(...)：回调里要 await，forEach 不等待就会静默丢写。改 for...of。 */
  const rows = all<Row>('SELECT section, raw FROM setting ORDER BY section');
  for (const row of rows) {
    raw[str(row.section)] = json<Row>(row.raw, {});
  }
  return {
    raw,
    sections: [
      { id: 'gen', label: '通用', title: '通用', desc: '语言、启动与遥测', rows: [] },
      { id: 'model', label: '模型', title: '模型与推理', desc: '默认模型与上下文预算', rows: [] },
      { id: 'perm', label: '权限', title: '权限与只读', desc: '只读只约束 Agent，不约束你的手动操作', rows: [] },
      { id: 'privacy', label: '隐私', title: '索引与隐私', desc: '敏感文件排除规则', rows: [] },
      { id: 'archive', label: '会话归档', title: '会话归档管理', desc: '归档的会话在此恢复或彻底删除', rows: [] },
      { id: 'look', label: '外观', title: '外观', desc: '主题与密度', rows: [] },
      { id: 'about', label: '关于', title: '关于 DevWork', desc: '版本与构建信息', rows: [] },
    ],
    'perm.readOnlyMode': readOnlyMode(),
  };
}

export function messageCard(row: Row): Row {
  const payload = json<Row>(row.payload, {});
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    kind: str(row.kind, 'text'),
    role: str(row.actor) === 'user' ? 'user' : 'assistant',
    content: str(payload.content),
    payload,
    actor: str(row.actor, 'agent'),
    createdAt: str(row.created_at),
  };
}

export function listMessageCards(conversationId: string): Row[] {
  return (all<Row>(
    'SELECT * FROM message WHERE conversation_id = ? ORDER BY created_at, id',
    conversationId,
  )).map(messageCard);
}

export function citationShape(row: Row): Row {
  const assetId = str(row.path).startsWith('docs/') ? 'a-kb' : str(row.path) === '' ? 'a-kb' : 'a-order-service';
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    assetId,
    assetName: str(row.source),
    title: str(row.title),
    source: str(row.source),
    locator: str(row.locator),
    snippet: str(row.snippet),
    code: str(row.snippet),
    confidence: num(row.confidence),
    score: String(num(row.confidence)),
    version: str(row.version),
    /* 源文件定位：null 表示该引用没有可打开的源文件（UI 应禁用「打开」而不是弹假提示）。 */
    path: row.path === null || row.path === undefined ? null : String(row.path),
    startLine: row.start_line === null || row.start_line === undefined ? null : num(row.start_line),
    endLine: row.end_line === null || row.end_line === undefined ? null : num(row.end_line),
  };
}

export function listCitations(conversationId: string): Row[] {
  return (all<Row>('SELECT * FROM citation WHERE conversation_id = ?', conversationId)).map(citationShape);
}

export function artifactShape(row: Row): Row {
  return {
    id: str(row.id),
    conversationId: str(row.conversation_id),
    name: str(row.name),
    fileName: str(row.file_name),
    fileType: str(row.meta).split(' · ')[0],
    sizeBytes: num(row.size_bytes),
    sizeLabel: str(row.meta).split(' · ')[1] ?? '',
    meta: str(row.meta),
  };
}

export function listArtifacts(conversationId: string): Row[] {
  return (all<Row>('SELECT * FROM artifact WHERE conversation_id = ?', conversationId)).map(artifactShape);
}

export function panelShape(conversationId: string, kind: string): Row {
  const row = get<Row>(
    'SELECT payload FROM context_snapshot WHERE conversation_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
    conversationId,
    kind,
  );
  return json<Row>(row?.payload ?? '{}', {});
}

export function allPanels(conversationId: string): Row {
  return {
    context: panelShape(conversationId, 'context'),
    execution: panelShape(conversationId, 'execution'),
    artifacts: panelShape(conversationId, 'artifacts'),
  };
}

export function assetDetailShape(assetId: string): Row | null {
  const row = get<Row>('SELECT * FROM asset WHERE id = ?', assetId);
  if (!row) return null;
  const type = str(row.type);
  const tabs = type === 'server'
    ? ['终端']
    : type === 'db'
      ? ['SQL 查询', '数据浏览']
      : type === 'code'
        ? ['编辑器']
        : ['文档', '检索'];
  const capabilities = (all<Row>(
    'SELECT * FROM asset_capability WHERE asset_id = ? ORDER BY id',
    assetId,
  )).map((c) => ({
    id: str(c.id), name: str(c.capability), description: str(c.description),
    granted: num(c.granted) === 1, locked: num(c.locked) === 1, approval: str(c.approval),
  }));
  const activities = (all<Row>(
    "SELECT * FROM audit_event WHERE target LIKE ? ORDER BY created_at DESC LIMIT 8",
    `%${str(row.name)}%`,
  )).map((a) => ({
    id: str(a.id), createdAt: str(a.created_at), createdAtLabel: str(a.created_at_label),
    text: `${str(a.action)} · ${str(a.result)}`,
  }));
  /* 凭据方式与账号：接入时录入的，详情页要让人看清「绑的是谁、用哪种方式」。 */
  const credential = get<Row>(
    'SELECT auth_method, username, label FROM credential_binding WHERE asset_id = ?',
    assetId,
  );
  const authMethod = credential ? str(credential.auth_method) : '';
  const methodText = authMethod === 'password' ? '账号密码'
    : authMethod === 'token' ? '访问令牌'
      : authMethod === 'sshkey' ? 'SSH 私钥'
        : '';
  const credentialUser = credential ? str(credential.username) : '';
  const bound = num(row.credential_bound) === 1;
  return {
    id: assetId,
    workspaceId: str(row.workspace_id),
    type,
    name: str(row.name),
    env: str(row.env),
    status: assetStatus(row),
    indexProgress: num(row.index_progress),
    credentialBound: bound,
    subtitle: str(row.subtitle),
    pills: [
      { tone: 'ok', text: type === 'server' ? '在线' : '已连接' },
      { tone: 'ro', text: '只读' },
    ],
    tabs,
    metrics: [
      { label: '索引状态', value: str(row.status) === 'indexing' ? '索引中' : '已索引', sub: str(row.status) === 'indexing' ? '进行中' : '可用' },
      { label: '资产类型', value: type, sub: str(row.env) || '—' },
      { label: '凭据', value: bound ? '已绑定' : '未绑定', sub: methodText || '只读' },
    ],
    kv: [
      { k: '工作区', v: str(row.workspace_id) },
      { k: '环境', v: str(row.env) || '—' },
      { k: '连接', v: str(row.subtitle) },
      { k: 'dbPath', v: json<Row>(row.config, {}).dbPath ?? '' },
    ],
    activities,
    capabilities,
    statusBar: statusBarShape(),
    credentialLine: !bound
      ? '尚未绑定凭据'
      : `只读凭据已绑定${methodText ? ` · ${methodText}` : ''}${credentialUser ? ` · ${credentialUser}` : ''}`,
  };
}

export function credentialShape(assetId: string): Row {
  const row = get<Row>('SELECT * FROM credential_binding WHERE asset_id = ?', assetId);
  return {
    assetId,
    state: row ? str(row.state, 'unbound') : 'unbound',
    label: row ? str(row.label) : '',
    lastUsedLabel: row ? str(row.last_used_label) : '—',
    expiresAt: row ? str(row.expires_at) : '',
    /* 鉴权方式与账号名不是秘密，明文存着，详情页要能看清「绑的是谁、用哪种方式」。 */
    authMethod: row ? str(row.auth_method) : '',
    username: row ? str(row.username) : '',
  };
}

/**
 * 审计分类的唯一判定处。
 *
 * 之前前端用 /member|policy|credential/ 的正则自己分一遍类，服务端又支持
 * action/actor/from/to 筛选但没人用 —— 两套口径迟早不一致，而且"筛选态"只是
 * 视觉筛选，导出 CSV 时仍是全量。分类放服务端，查询与展示共用同一份。
 */
/** 兜底桶：不匹配任何已知前缀的动作都归这里。 */
export const AUDIT_FALLBACK_CATEGORY = '其他';

export const AUDIT_CATEGORIES = ['命令执行', '凭据访问', '策略变更', '成员变更', AUDIT_FALLBACK_CATEGORY] as const;

/**
 * 权限校验记录的固定外壳。
 *
 * 审计库里同一个域会有两种写法：`sql.query · SELECT ...` 和
 * `permission.check · sql.query.read`。若按原始 action 前缀分类，后者会全部
 * 掉进"其他"——命令执行桶里看不到被拦下的 SQL，等于筛选在骗人。
 * 所以先剥外壳再分类，JS 判定与 SQL 条件共用这一份定义。
 */
const PERMISSION_PREFIX = 'permission.check · ';

/** 归一化后的动作，供 SQL 侧的 LIKE 使用（与 auditNormalizeAction 等价）。 */
const NORMALIZED_ACTION_SQL =
  `CASE WHEN action LIKE '${PERMISSION_PREFIX}%' THEN substr(action, ${PERMISSION_PREFIX.length + 1}) ELSE action END`;

const CATEGORY_PREFIXES: Record<string, string[]> = {
  命令执行: ['cmd.', 'terminal.', 'exec.', 'sql.', 'service.', 'tool.invoke', 'approval.'],
  凭据访问: ['credential.', 'secret.'],
  策略变更: ['policy.', 'setting.', 'perm.', 'workspace.'],
  成员变更: ['member.', 'org.', 'invite.'],
};

export function auditNormalizeAction(action: string): string {
  return action.startsWith(PERMISSION_PREFIX) ? action.slice(PERMISSION_PREFIX.length) : action;
}

/** 分类 → 动作前缀列表；导出查询与展示共用，避免两套口径。 */
export function auditPrefixesFor(category: string): string[] {
  return CATEGORY_PREFIXES[category] ?? [];
}

export function auditCategoryFor(action: string): string {
  const normalized = auditNormalizeAction(action);
  const hit = Object.entries(CATEGORY_PREFIXES).find(([, prefixes]) =>
    prefixes.some((prefix) => normalized.startsWith(prefix)));
  return hit ? hit[0] : AUDIT_FALLBACK_CATEGORY;
}

/**
 * 分类 → SQL 片段 + 参数。
 *
 * 兜底桶"其他"必须用【排除法】表达：list 里它是"不匹配任何前缀"，
 * 若按前缀查就是 1=0，筛出来永远是空的（前端看起来像筛坏了）。
 */
export function auditCategoryCondition(category: string): { sql: string; params: string[] } {
  const like = (prefixes: string[]): string =>
    `(${prefixes.map(() => `${NORMALIZED_ACTION_SQL} LIKE ?`).join(' OR ')})`;
  if (category === AUDIT_FALLBACK_CATEGORY) {
    const every = Object.values(CATEGORY_PREFIXES).flat();
    if (every.length === 0) return { sql: '1 = 1', params: [] };
    return { sql: `NOT ${like(every)}`, params: every.map((prefix) => `${prefix}%`) };
  }
  const prefixes = auditPrefixesFor(category);
  if (prefixes.length === 0) return { sql: '1 = 0', params: [] };
  return { sql: like(prefixes), params: prefixes.map((prefix) => `${prefix}%`) };
}

export function auditShape(row: Row): Row {
  const action = str(row.action);
  return {
    id: str(row.id),
    createdAt: str(row.created_at),
    createdAtLabel: str(row.created_at_label),
    actor: str(row.actor),
    source: str(row.source, 'user'),
    action,
    category: auditCategoryFor(action),
    target: str(row.target),
    result: str(row.result),
    severity: str(row.severity, 'info'),
    detail: str(row.detail),
    workspaceId: str(row.workspace_id),
    conversationId: str(row.conversation_id),
  };
}

/** 文件树：敏感文件（12 规则）一律不出现。规则优先读设置页（PUT /api/sensitive-rules 落库值），
 * 库里没有时才回落内置常量 —— 否则规则编辑器改了也不生效。 */
export function isSensitive(rel: string): boolean {
  const dbRules = (settingRaw('privacy')).sensitiveRules;
  const rules: string[] = Array.isArray(dbRules) && dbRules.length > 0
    ? dbRules.map(String)
    : SENSITIVE_RULES.map((rule) => rule.pattern);
  const lower = rel.toLowerCase().replace(/\\/g, '/');
  return rules.some((pattern) => {
    const patternLower = pattern.toLowerCase();
    if (patternLower.endsWith('/')) {
      const dir = patternLower.slice(0, -1);
      return lower.split('/').includes(dir) || lower.includes(`${dir}/`);
    }
    if (patternLower.startsWith('*')) {
      const ext = patternLower.slice(1);
      return lower.endsWith(ext);
    }
    if (patternLower.startsWith('.')) return path.basename(lower).startsWith(patternLower);
    return lower.includes(patternLower);
  });
}

export interface FileTreeEntry {
  name: string;
  path: string;
  depth: number;
  caret: string;
  isFile: boolean;
}

/* 树递归必须有上限：大型仓库无限制递归会把整棵树塞进一次响应，
 * 前端渲染卡死、接口超时。深度 8 层 / 2000 条足够覆盖真实工程结构。 */
const TREE_MAX_DEPTH = 8;
const TREE_MAX_ENTRIES = 2000;

export function fileTree(assetId: string, relative = ''): FileTreeEntry[] {
  const repoRoot = path.resolve(tryResolveRepoRoot(assetId));
  const base = path.resolve(repoRoot, relative || '.');
  if (base !== repoRoot && !base.startsWith(`${repoRoot}${path.sep}`)) return [];
  const entries: FileTreeEntry[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return entries;
  }
  names.sort((a, b) => (fs.statSync(path.join(base, a)).isDirectory() === fs.statSync(path.join(base, b)).isDirectory()
    ? a.localeCompare(b)
    : fs.statSync(path.join(base, a)).isDirectory() ? -1 : 1));
  const depth = relative ? relative.split('/').length : 0;
  for (const name of names) {
    if (entries.length >= TREE_MAX_ENTRIES) break;
    if (name === '.git') continue;
    const rel = relative ? `${relative}/${name}` : name;
    if (isSensitive(rel)) continue;
    const absolute = path.join(base, name);
    const isFile = fs.statSync(absolute).isFile();
    entries.push({ name, path: rel, depth, caret: isFile ? '·' : '▸', isFile });
    if (!isFile && depth + 1 < TREE_MAX_DEPTH) entries.push(...(fileTree(assetId, rel)));
  }
  return entries;
}

export function gitSummary(assetId: string): Row {
  const cwd = path.resolve(tryResolveRepoRoot(assetId));
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    } catch {
      return '';
    }
  };
  return {
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || 'main',
    lastCommit: run(['rev-parse', '--short', 'HEAD']) || 'a3f21c9',
    log: run(['log', '-1', '--pretty=format:%h · %s']) || 'a3f21c9 · seed order-service',
  };
}

export function newAuditId(): string {
  return newId('aud');
}

export function stamp(): string {
  return nowIso();
}
