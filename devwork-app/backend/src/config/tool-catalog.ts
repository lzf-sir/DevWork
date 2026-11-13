/**
 * ToolCatalog —— 工具派生管线（对应 devwork-asset-capability-design.md §1/§2/§3）。
 *
 * 三条硬规则（设计文档判断一/二/三）：
 * 1. 工具面从「工作区资产 × 能力声明 × 信任级别」派生，不是写死的清单；
 * 2. 权限跟 Capability 走：派生时把资产实例的风险与约束一起算出来；
 * 3. prod 资产的 write/exec 组**不存在**（不是 ask）——派生阶段就剪掉。
 *
 * 与旧 TOOL_REGISTRY（config/tools.ts）的关系：
 * 旧表是「静态兜底 + 演示轨迹遗留名」。派生管线产出的工具面供 OpenAI 网关
 * toolsSpec 与 GET /api/tools 使用；执行器（agent-tools.ts）两个名字空间都认。
 */
import { all, get } from '../db/database';

export type ToolRisk = 'low' | 'medium' | 'high';
export type AssetType = 'code' | 'db' | 'server' | 'kb' | 'log' | 'api';

/** 目录条目：一种「逻辑工具」。派生时绑定具体资产实例后才是可调用工具。 */
export interface CatalogEntry {
  name: string;
  group: 'common' | 'code' | 'db' | 'server' | 'kb' | 'log' | 'api';
  /** 绑定的资产类型；'workspace' 表示跨资产通用。 */
  assetType: AssetType | 'workspace';
  /** 只读动作名（参与权限裁决与能力映射）。 */
  action: string;
  /** 写动作名；只读工具为 undefined。 */
  writeAction?: string;
  risk: ToolRisk;
  /** v1 = 只读主干；v2 = 写能力层。 */
  version: 'v1' | 'v2';
  label: string;
  /** 给模型看的描述（决定它会不会用对）。 */
  description: string;
  /** 给模型的参数 schema（简化 JSON Schema properties）。 */
  params: Record<string, { type: string; description: string }>;
  required?: string[];
  needsCredential?: boolean;
}

/** 参数统一包一层 object，符合 OpenAI function calling 形态。 */
function schemaOf(entry: CatalogEntry): Record<string, unknown> {
  return {
    type: 'object',
    properties: entry.params,
    required: entry.required ?? [],
  };
}

/** ============ 工具目录（设计 §2 全景清单的可执行版） ============ */
export const TOOL_CATALOG: CatalogEntry[] = [
  /* ---- 跨资产通用 ---- */
  {
    name: 'ws_list_assets', group: 'common', assetType: 'workspace',
    action: 'asset.read', risk: 'low', version: 'v1',
    label: '资产清单', needsCredential: false,
    description: '列出当前工作区全部资产（id/类型/名称/环境/状态）。派生管线的自描述入口：先看清单再挑工具。',
    params: {},
  },
  {
    name: 'browser_navigate', group: 'common', assetType: 'workspace',
    action: 'browser.navigate', risk: 'low', version: 'v1',
    label: '浏览器导航', needsCredential: false,
    description: '让应用内置浏览器跳到指定网址（仅 http/https；本机与内网地址会被拦截）。导航后地址同步到右栏「浏览器」Tab，用户能看到 Agent 停在哪一页。',
    params: { url: { type: 'string', description: '目标网址（http/https）' } },
    required: ['url'],
  },
  {
    name: 'browser_read_page', group: 'common', assetType: 'workspace',
    action: 'browser.read', risk: 'low', version: 'v1',
    label: '读取当前页面', needsCredential: false,
    description: '读取内置浏览器当前页面的标题与正文快照（前端回传的文本，最长 8000 字符）。导航完先读一页再回答，别凭空猜页面内容。',
    params: {},
  },
  /* ---- codebase ---- */
  {
    name: 'code_search', group: 'code', assetType: 'code',
    action: 'code.search.read', risk: 'low', version: 'v1',
    label: '代码检索', needsCredential: false,
    description: '在代码库索引中做全文检索（FTS5），返回片段/路径/行号/相关度。',
    params: { query: { type: 'string', description: '检索关键词（空格分词）' } },
    required: ['query'],
  },
  {
    name: 'code_read', group: 'code', assetType: 'code',
    action: 'code.read', risk: 'low', version: 'v1',
    label: '读取代码文件', needsCredential: false,
    description: '按相对路径读取代码库文件内容（敏感文件被 12 条规则拦截，返回打码说明而非内容）。',
    params: { path: { type: 'string', description: '仓库内相对路径' } },
    required: ['path'],
  },
  {
    name: 'code_symbols', group: 'code', assetType: 'code',
    action: 'code.read', risk: 'low', version: 'v1',
    label: '符号大纲', needsCredential: false,
    description: '读一个文件的符号大纲（类/方法+行号）、引用计数与最后 git 修改记录。',
    params: { path: { type: 'string', description: '仓库内相对路径' } },
    required: ['path'],
  },
  {
    name: 'code_diff', group: 'code', assetType: 'code',
    action: 'code.read', risk: 'low', version: 'v1',
    label: '查看 diff', needsCredential: false,
    description: '查看某文件相对 git HEAD 的工作区变更；clean 时如实返回无变更。',
    params: { path: { type: 'string', description: '仓库内相对路径' } },
    required: ['path'],
  },
  {
    name: 'code_todos', group: 'code', assetType: 'code',
    action: 'code.read', risk: 'low', version: 'v1',
    label: '标记扫描', needsCredential: false,
    description: '扫描仓库源码中的 TODO / FIXME / HACK 标记，返回文件、行号与标记内容（发布前检查遗漏用）。',
    params: { max: { type: 'number', description: '最多返回条数（默认 30，上限 100）' } },
  },
  /* ---- database ---- */
  {
    name: 'db_query', group: 'db', assetType: 'db',
    action: 'sql.query.read', risk: 'low', version: 'v1',
    label: '只读 SQL 查询', needsCredential: true,
    description: '对数据库执行只读 SQL（仅 SELECT/WITH/EXPLAIN，单语句，自动 LIMIT），返回行数与采样。',
    params: { sql: { type: 'string', description: '只读 SQL 语句' } },
    required: ['sql'],
  },
  {
    name: 'db_schema', group: 'db', assetType: 'db',
    action: 'sql.query.read', risk: 'low', version: 'v1',
    label: '读表结构', needsCredential: false,
    description: '列出数据库全部表，或读取指定表的列/索引/外键/DDL。不消耗查询预算，排查前先看结构。',
    params: { table: { type: 'string', description: '表名；缺省返回全部表清单' } },
  },
  {
    name: 'db_tables', group: 'db', assetType: 'db',
    action: 'sql.query.read', risk: 'low', version: 'v1',
    label: '表行数画像', needsCredential: false,
    description: '逐表 COUNT(*) 得到行数画像（上限 20 表），数据规模判断/排查数据倾斜用。',
    params: { tables: { type: 'string', description: '逗号分隔的表名列表；缺省取全部表（上限 20）' } },
  },
  /* ---- knowledge ---- */
  {
    name: 'kb_search', group: 'kb', assetType: 'kb',
    action: 'kb.search.read', risk: 'low', version: 'v1',
    label: '知识库检索', needsCredential: false,
    description: '在知识库文档索引中检索片段，返回标题/位置/片段/相关度。',
    params: { query: { type: 'string', description: '检索关键词' } },
    required: ['query'],
  },
  /* ---- server ---- */
  {
    name: 'srv_status', group: 'server', assetType: 'server',
    action: 'cmd.exec.read', risk: 'low', version: 'v1',
    label: '服务状态', needsCredential: false,
    description: '读取服务器资产状态：进程总数（真实 tasklist/ps）、主机资源（内存/CPU/uptime）与终端会话数。',
    params: {},
  },
  {
    name: 'srv_log_tail', group: 'server', assetType: 'server',
    action: 'log.read', risk: 'low', version: 'v1',
    label: '日志尾部', needsCredential: false,
    description: '读取服务日志最后 N 行（真实日志文件，非编造）。',
    params: { lines: { type: 'string', description: '行数，默认 20，上限 100' } },
  },
  /* ---- log 资产 ---- */
  {
    name: 'log_query', group: 'log', assetType: 'log',
    action: 'log.read', risk: 'low', version: 'v1',
    label: '日志检索', needsCredential: false,
    description: '按时间窗与关键词检索结构化日志（时间戳\\t级别\\t消息），先 aggregate 摸量再取样的节奏。',
    params: {
      query: { type: 'string', description: '关键词（可选）' },
      from: { type: 'string', description: '起始时间 ISO（可选）' },
      to: { type: 'string', description: '结束时间 ISO（可选）' },
      limit: { type: 'string', description: '返回条数上限，默认 30' },
    },
  },
  /* ---- api 资产 ---- */
  {
    name: 'api_spec_read', group: 'api', assetType: 'api',
    action: 'api.read', risk: 'low', version: 'v1',
    label: 'API 规范', needsCredential: false,
    description: '读取 API 资产的端点清单（方法/路径/说明/副作用标注）。调用前先看规范。',
    params: {},
  },
  {
    name: 'api_call_read', group: 'api', assetType: 'api',
    action: 'api.read', risk: 'low', version: 'v1',
    label: '调用只读接口', needsCredential: false,
    description: '调用 GET 类只读接口（路径必须在规范清单内），返回真实 HTTP 响应。副作用接口被排除。',
    params: { path: { type: 'string', description: 'API 路径（以 /api/ 开头）' } },
    required: ['path'],
  },
  /* ================= V2 写能力层 ================= */
  {
    name: 'code_edit', group: 'code', assetType: 'code',
    action: 'code.read', writeAction: 'patch.apply', risk: 'high', version: 'v2',
    label: '修改代码文件', needsCredential: false,
    description: '修改代码库文件内容。走审批卡：批准后 precheck（基线未变）→ 落盘（先快照）→ 可一键回滚。',
    params: {
      path: { type: 'string', description: '仓库内相对路径' },
      content: { type: 'string', description: '修改后的完整文件内容' },
    },
    required: ['path', 'content'],
  },
  {
    name: 'db_query_write', group: 'db', assetType: 'db',
    action: 'sql.query.read', writeAction: 'sql.query.write', risk: 'high', version: 'v2',
    label: '数据库写入', needsCredential: true,
    description: '执行单条 DML（INSERT/UPDATE/DELETE）。走审批卡：备份库文件 → 事务执行 → 报告影响行数，可回滚到备份。',
    params: { sql: { type: 'string', description: '单条 DML 语句（DDL 一律拒绝）' } },
    required: ['sql'],
  },
  {
    name: 'srv_exec', group: 'server', assetType: 'server',
    action: 'cmd.exec.read', writeAction: 'exec.write', risk: 'high', version: 'v2',
    label: '执行运维操作', needsCredential: false,
    description: '意图导向的命令模板执行（设计 §6.3）：先 GET cmd-templates 看支持哪些意图；模板外操作一律拒绝转建议。',
    params: {
      action: { type: 'string', description: '意图名，如 restart_service / rotate_log / backup_file' },
      params: { type: 'string', description: 'JSON 对象：模板参数（参数取值必须是白名单枚举）' },
    },
    required: ['action'],
  },
  {
    name: 'fs_write_file', group: 'common', assetType: 'workspace',
    action: 'file.read', writeAction: 'file.write', risk: 'high', version: 'v2',
    label: '写入工作区文件', needsCredential: false,
    description: '写入工作区内代码库文件（同 code_edit 的审批/快照/回滚管线，供 doc-generator 等技能使用）。',
    params: {
      path: { type: 'string', description: '仓库内相对路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
];

export function catalogEntry(name: string): CatalogEntry | undefined {
  return TOOL_CATALOG.find((entry) => entry.name === name);
}

/* ================= 派生管线 ================= */

export interface DerivedTool {
  name: string;
  /** 绑定的资产实例 id（凭据校验/能力裁决/审计都落在这里）。 */
  assetId: string;
  assetName: string;
  assetEnv: string;
  entry: CatalogEntry;
  /** 风险（资产实例化后的最终值）。 */
  risk: ToolRisk;
  /** 被什么规则挡住而不进模型工具面（诊断用，如 prod-env / prod-workspace）。 */
  gatedBy?: string;
  /** 给模型的 function calling 形态。 */
  schema: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
}

export interface ToolFace {
  workspaceId: string;
  workspaceTrust: string;
  /** 全部派生结果（含被剪枝的，gatedBy 标注原因）——诊断与 UI 展示用。 */
  all: DerivedTool[];
  /** 实际进入模型工具面的子集（无 gatedBy）。 */
  active: DerivedTool[];
  derivationRules: string[];
}

interface AssetRow {
  id: string; type: string; name: string; env: string; status: string; credential_bound: number;
}

/** 资产查询独立成函数：避免与派生结果变量 all 同名遮蔽（TDZ 会把导入的 all 变成不可调用）。 */
function allAssets(workspaceId: string): AssetRow[] {
  return all<AssetRow>(
    'SELECT id, type, name, env, status, credential_bound FROM asset WHERE workspace_id = ? ORDER BY created_at, id',
    workspaceId,
  );
}

/** 资产是否有索引切片（主实例优先选真有内容的资产，避免绑到空壳）。 */
function hasIndexChunks(assetId: string): boolean {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM index_chunk WHERE asset_id = ?', assetId);
  return Number(row?.n ?? 0) > 0;
}

/** 每类资产挑一个「主实例」：有索引切片 > 在线且已绑凭据 > 在线 > 顺位第一。 */
function primaryAssetOf(assets: AssetRow[], type: AssetType): AssetRow | undefined {
  const pool = assets.filter((a) => a.type === type);
  if (pool.length === 0) return undefined;
  const bound = pool.filter((a) => a.status === 'online' && Number(a.credential_bound) === 1);
  /* 索引切片判定要查库，故用顺序循环代替 find(async ...)。 */
  for (const candidate of bound) {
    if (hasIndexChunks(candidate.id)) return candidate;
  }
  return (
    bound[0]
    ?? pool.find((a) => a.status === 'online')
    ?? pool[0]
  );
}

/**
 * 派生一个工作区的工具面。
 *
 * 派生规则（设计 §3 的可执行版）：
 * R1 按资产裁剪：工作区没有该类型资产 → 整组不派生；
 * R2 prod 判定以资产 env 为准（与权限内核 p3 同口径）：env=prod 的资产不派生 v2 写工具；
 * R3 工作区 trust_level 仅作标注输出（信任边界在资产级落地，避免种子标注与真实能力漂移）；
 * R4 每类资产只绑一个主实例（有索引切片优先），工具面 ≤30 预算约束。
 */
export function deriveToolFace(workspaceId: string): ToolFace {
  const workspace = get<{ trust_level: string }>('SELECT trust_level FROM workspace WHERE id = ?', workspaceId);
  const workspaceTrust = String(workspace?.trust_level ?? 'normal');
  const assets = allAssets(workspaceId);

  const rules: string[] = [
    'R1 按资产裁剪：无该类型资产 → 整组不派生',
    'R2 prod 判定以资产 env 为准（与权限内核同口径）：env=prod → v2 写工具不派生（不存在，而非 ask）',
    'R3 工作区 trust_level 仅作标注（信任边界在资产级落地）',
    'R4 每类资产绑一个主实例（有索引切片优先，工具面 ≤30 预算约束）',
  ];

  const primaries = new Map<AssetType | 'workspace', AssetRow | undefined>();
  for (const type of (['code', 'db', 'server', 'kb', 'log', 'api'] as AssetType[])) {
    primaries.set(type, primaryAssetOf(assets, type));
  }

  const derivedAll: DerivedTool[] = [];
  for (const entry of TOOL_CATALOG) {
    let asset: AssetRow | undefined;
    if (entry.assetType === 'workspace') {
      asset = { id: workspaceId, type: 'workspace', name: 'workspace', env: '', status: 'online', credential_bound: 1 };
    } else {
      asset = primaries.get(entry.assetType);
    }
    if (!asset) {
      /* R1：没有对应资产 → 整条不进（连诊断列表都不进，与设计语义一致）。 */
      continue;
    }
    let gatedBy: string | undefined;
    if (entry.version === 'v2' && asset.env === 'prod') gatedBy = 'prod-env';
    const derived: DerivedTool = {
      name: entry.name,
      assetId: asset.id,
      assetName: asset.name,
      assetEnv: asset.env,
      entry,
      risk: entry.risk,
      gatedBy,
      schema: {
        type: 'function',
        function: {
          name: entry.name,
          description: `${entry.description}（绑定资产：${asset.name} · ${asset.id}${asset.env ? ` · ${asset.env}` : ''}）`,
          parameters: schemaOf(entry),
        },
      },
    };
    derivedAll.push(derived);
  }

  return {
    workspaceId,
    workspaceTrust,
    all: derivedAll,
    active: derivedAll.filter((tool) => !tool.gatedBy),
    derivationRules: rules,
  };
}

/** 网关 toolsSpec 形态：只放行 active。 */
export function gatewayToolFace(face: ToolFace): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return face.active.map((tool) => tool.schema);
}

/** 按名字取派生工具（执行器用）。 */
export function derivedTool(face: ToolFace, name: string): DerivedTool | undefined {
  return face.all.find((tool) => tool.name === name);
}
