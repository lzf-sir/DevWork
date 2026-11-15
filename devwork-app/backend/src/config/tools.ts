/**
 * 工具登记表 —— 权限裁决、凭据检查、网关 tool_call 事件的**唯一事实来源**。
 *
 * 为什么必须集中：网关曾经把模型调用的 risk 写死成 'low'、write 写死成 false，
 * 而落在哪张资产的凭据校验又是另一份表。两份表一漂移，模型挑一个写工具就能
 * 绕过审批——这属于安全缺陷而不是代码风格问题。
 *
 * 目录（config/tool-catalog.ts）与这张表的关系：
 *   · 目录负责"给模型看什么"（描述、参数、mode 枚举、派生绑定）；
 *   · 这张表负责"裁决什么"（动作名、写动作、风险档、凭据要求）。
 * 两边由 validateToolCatalog() 逐项比对，任何一处漂移都会在测试期报出来。
 *
 * 表里同时保留 V10 已合并的旧工具名（`deprecatedAliasOf` 标注）：它们不再进模型
 * 工具面，但历史轨迹、审计查询、旧技能模板仍按旧名指向它们，所以不能删。
 */
import { isWriteAction } from './rules';

export type ToolRisk = 'low' | 'medium' | 'high';

export interface ToolSpec {
  /** 归属资产：凭据校验、能力授权、审计都落在这里。 */
  assetId: string;
  /** 只读动作名（写工具用 writeAction）。 */
  action: string;
  /** 写工具的动作名；只读工具为 undefined。 */
  writeAction?: string;
  /** 只有需要外部连接的资产才要求绑定凭据；本地索引不需要。 */
  needsCredential: boolean;
  risk: ToolRisk;
  label: string;
  /** 已合并的旧名：指向现行工具（执行器入口会按别名归一，权限仍走本条记录）。 */
  deprecatedAliasOf?: string;
}

export const TOOL_REGISTRY: Record<string, ToolSpec> = {
  /* ===== 派生工具面的静态登记（默认绑定主实例资产）=====
   * 派生管线（config/tool-catalog.ts）会在运行时按工作区重算资产绑定；
   * 这里的 assetId 是兜底默认值，执行器优先用派生结果。 */
  ws_list_assets: {
    assetId: 'w-ops', action: 'asset.read',
    needsCredential: false, risk: 'low', label: '资产清单',
  },
  /* 任务清单是 Agent 自己的状态，不碰任何用户资产，所以：
   *  - action 用 'todo.plan' 而不是 'todo.write' —— isWriteAction 会按 write 判定，
   *    那样每一步清单更新都会弹出审批卡，长任务根本没法跑；
   *  - risk=low、无 writeAction → 直接走 capability=read 的自动放行分支。 */
  todo_write: {
    assetId: 'w-ops', action: 'todo.plan',
    needsCredential: false, risk: 'low', label: '任务清单',
  },
  /* 会话笔记与任务清单同理：写的是 Agent 自己的笔记表，不是用户资产。
   * 动作名 'memo.note' 刻意不含 write —— 否则每条笔记都要弹审批，长任务没法跑。 */
  memo: {
    assetId: 'w-ops', action: 'memo.note',
    needsCredential: false, risk: 'low', label: '会话笔记',
  },
  /* 合并后的浏览器工具：导航与读页共用一个动作名（browser.page.read）。
   * 上一跳与下一跳的语义差别记在 args.mode 里（tool_call.args 存的是原始参数），
   * 审计要还原"当时是导航还是读页"看参数即可。 */
  browser: {
    assetId: 'w-ops', action: 'browser.page.read',
    needsCredential: false, risk: 'low', label: '内置浏览器',
  },
  /* 服务端抓取：与内置浏览器的区别是"不依赖前端回传快照"。
   * 它不出网到私有网段（web-fetch.ts 自己守重定向），所以 risk 仍是 low——
   * 但 action 单独叫 web.fetch.read：将来若要做"外网访问开关"，
   * 能力授权页可以只关这一项而不影响内置浏览器。 */
  web_fetch: {
    assetId: 'w-ops', action: 'web.fetch.read',
    needsCredential: false, risk: 'low', label: '抓取网页',
  },
  /* 外部检索与 web_fetch 同档：都是"读外面"，都不写任何本地状态。
   * 未配置搜索后端时工具自己会明确拒绝，不需要在这里多一档。 */
  web_search: {
    assetId: 'w-ops', action: 'web.fetch.read',
    needsCredential: false, risk: 'low', label: '外部检索',
  },
  /* 子代理只读：它自己不能再写（执行层强制），所以这里按只读档登记。 */
  subtask: {
    assetId: 'w-ops', action: 'subtask.read',
    needsCredential: false, risk: 'low', label: '子代理调研',
  },
  /* 技能清单 / 加载：Agent 自己的提示词资产，不碰用户数据 → 不弹审批。 */
  skill: {
    assetId: 'w-ops', action: 'skill.read',
    needsCredential: false, risk: 'low', label: '技能',
  },
  /* grep / glob / index / refs 合并成 code_find，共用同一档能力（code.search.read）：
   * 四种判据都是"只读地看代码"，拆成不同 capability 只会让授权页多几个永远开着的开关。 */
  code_find: {
    assetId: 'a-order-service', action: 'code.search.read',
    needsCredential: false, risk: 'low', label: '定位代码',
  },
  /* 读正文 / 符号大纲 / diff 合并成 code_view，共用 code.read。 */
  code_view: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '看代码文件',
  },
  code_todos: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '标记扫描',
  },
  /* git 历史单独一档（git.read）：将来若有"允许看代码但禁止翻历史"的场景，
   * 这是一个真实的开关（比如只给了某文件的部分读取权时）。 */
  git_history: {
    assetId: 'a-order-service', action: 'git.read',
    needsCredential: false, risk: 'low', label: 'git 历史',
  },
  db_query: {
    assetId: 'a-order-db-dev', action: 'sql.query.read',
    needsCredential: true, risk: 'low', label: '只读 SQL 查询',
  },
  /* 表清单 / 结构 / 行数画像合并成 db_inspect：都不消耗查询预算。 */
  db_inspect: {
    assetId: 'a-order-db-dev', action: 'sql.query.read',
    needsCredential: false, risk: 'low', label: '看库结构与规模',
  },
  kb_search: {
    assetId: 'a-kb', action: 'kb.search.read',
    needsCredential: false, risk: 'low', label: '运营知识库',
  },
  srv_status: {
    assetId: 'a-order-api', action: 'cmd.exec.read',
    needsCredential: false, risk: 'low', label: '服务状态',
  },
  srv_log_tail: {
    assetId: 'a-order-api', action: 'log.read',
    needsCredential: false, risk: 'low', label: '日志尾部',
  },
  log_query: {
    assetId: 'a-order-log', action: 'log.read',
    needsCredential: false, risk: 'low', label: '日志检索',
  },
  api_spec_read: {
    assetId: 'a-devwork-api', action: 'api.read',
    needsCredential: false, risk: 'low', label: 'API 规范',
  },
  api_call_read: {
    assetId: 'a-devwork-api', action: 'api.read',
    needsCredential: false, risk: 'low', label: '调用只读接口',
  },
  /* ===== V2 写能力层 ===== */
  /* 整文件写 + 精确替换合并：mode 决定走哪条管线，但**读写档只看工具名**，
   * 所以名字仍是 code_edit，审批照旧逐次弹卡。 */
  code_edit: {
    assetId: 'a-order-service', action: 'code.read', writeAction: 'patch.apply',
    needsCredential: false, risk: 'high', label: '修改代码文件',
  },
  db_query_write: {
    assetId: 'a-order-db-dev', action: 'sql.query.read', writeAction: 'sql.query.write',
    needsCredential: true, risk: 'high', label: '数据库写入',
  },
  srv_exec: {
    assetId: 'a-order-api', action: 'cmd.exec.read', writeAction: 'exec.write',
    needsCredential: false, risk: 'high', label: '执行运维操作（模板）',
  },
  fs_write_file: {
    assetId: 'a-order-service', action: 'file.read', writeAction: 'file.write',
    needsCredential: false, risk: 'high', label: '写入工作区文件',
  },
  /* 文件组织（move/copy/mkdir/delete）：写动作独立一档，不与 patch.apply 共用——
   * 审计里"改内容"和"改位置/删文件"是两类事，混在一起事后没法分辨。
   * 只作用于代码库仓库（工作区文件不在此列，落点不同）。 */
  fs_manage: {
    assetId: 'a-order-service', action: 'code.read', writeAction: 'fs.manage',
    needsCredential: false, risk: 'high', label: '文件组织',
  },

  /* ===== V10 已合并的旧名（不进工具面，但必须可执行）=====
   * LEGACY_TOOL_ALIASES（tool-catalog.ts）把调用归一成上面的正式名；
   * 这里保留各自的记录，是因为历史 tool_call/audit 行按旧名查询，
   * 而权限裁决也必须能对旧名给出**与当年一致**的读写档（不许因改名提权）。 */
  browser_navigate: {
    assetId: 'w-ops', action: 'browser.navigate',
    needsCredential: false, risk: 'low', label: '浏览器导航', deprecatedAliasOf: 'browser',
  },
  browser_read_page: {
    assetId: 'w-ops', action: 'browser.read',
    needsCredential: false, risk: 'low', label: '读取当前页面', deprecatedAliasOf: 'browser',
  },
  skill_list: {
    assetId: 'w-ops', action: 'skill.read',
    needsCredential: false, risk: 'low', label: '技能清单', deprecatedAliasOf: 'skill',
  },
  skill_load: {
    assetId: 'w-ops', action: 'skill.read',
    needsCredential: false, risk: 'low', label: '加载技能', deprecatedAliasOf: 'skill',
  },
  code_search: {
    assetId: 'a-order-service', action: 'code.search.read',
    needsCredential: false, risk: 'low', label: '代码库', deprecatedAliasOf: 'code_find',
  },
  code_grep: {
    assetId: 'a-order-service', action: 'code.search.read',
    needsCredential: false, risk: 'low', label: '内容搜索', deprecatedAliasOf: 'code_find',
  },
  code_glob: {
    assetId: 'a-order-service', action: 'code.search.read',
    needsCredential: false, risk: 'low', label: '文件查找', deprecatedAliasOf: 'code_find',
  },
  code_read: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '读取代码文件', deprecatedAliasOf: 'code_view',
  },
  code_symbols: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '符号大纲', deprecatedAliasOf: 'code_view',
  },
  code_diff: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '查看 diff', deprecatedAliasOf: 'code_view',
  },
  db_schema: {
    assetId: 'a-order-db-dev', action: 'sql.query.read',
    needsCredential: false, risk: 'low', label: '读表结构', deprecatedAliasOf: 'db_inspect',
  },
  db_tables: {
    assetId: 'a-order-db-dev', action: 'sql.query.read',
    needsCredential: false, risk: 'low', label: '表行数画像', deprecatedAliasOf: 'db_inspect',
  },
  /* 与 code_edit 共用 patch.apply 这一档写能力，但语义更窄（只改 oldString 命中的那段）。 */
  code_edit_str: {
    assetId: 'a-order-service', action: 'code.read', writeAction: 'patch.apply',
    needsCredential: false, risk: 'high', label: '精确替换代码', deprecatedAliasOf: 'code_edit',
  },

  /* ===== 演示轨迹遗留名（MockGateway 模板在用，不可删） ===== */
  pg_sql_query: {
    assetId: 'a-order-db-prod', action: 'sql.query.read',
    needsCredential: true, risk: 'low', label: '生产库',
  },
  fs_truncate_log: {
    assetId: 'a-order-api', action: 'file.read', writeAction: 'file.write',
    needsCredential: false, risk: 'high', label: 'order-api 日志',
  },
  fs_delete: {
    assetId: 'a-order-api', action: 'file.read', writeAction: 'file.write',
    needsCredential: false, risk: 'high', label: 'order-api 文件',
  },
  'fs.delete': {
    assetId: 'a-order-api', action: 'file.read', writeAction: 'file.write',
    needsCredential: false, risk: 'high', label: 'order-api 文件',
  },
  patch_apply: {
    assetId: 'a-order-service', action: 'code.search.read', writeAction: 'patch.apply',
    needsCredential: false, risk: 'high', label: '代码补丁',
  },
  'patch.apply': {
    assetId: 'a-order-service', action: 'code.search.read', writeAction: 'patch.apply',
    needsCredential: false, risk: 'high', label: '代码补丁',
  },
  service_restart: {
    assetId: 'a-order-api', action: 'cmd.exec.read', writeAction: 'service.restart',
    needsCredential: false, risk: 'high', label: '重启服务',
  },
  'service.restart': {
    assetId: 'a-order-api', action: 'cmd.exec.read', writeAction: 'service.restart',
    needsCredential: false, risk: 'high', label: '重启服务',
  },
  db_write: {
    assetId: 'a-order-db-prod', action: 'sql.query.read', writeAction: 'sql.query.write',
    needsCredential: true, risk: 'high', label: '生产库写入',
  },
  db_ddl: {
    assetId: 'a-order-db-prod', action: 'sql.query.read', writeAction: 'sql.ddl',
    needsCredential: true, risk: 'high', label: '生产库 DDL',
  },
};

/** 未知工具的保守默认：当作高风险写操作，宁可多一道审批也不放行。 */
const UNKNOWN: ToolSpec = {
  assetId: 'a-order-db-prod', action: 'tool.read', writeAction: 'file.write',
  needsCredential: false, risk: 'high', label: '未知工具',
};

export function toolSpec(name: string): ToolSpec {
  return TOOL_REGISTRY[name] ?? { ...UNKNOWN, label: `未知工具 ${name}` };
}

/** 该工具是否写类（用于决定要不要走审批/建议分支）。 */
export function toolIsWrite(name: string): boolean {
  const spec = TOOL_REGISTRY[name];
  if (spec) return !!spec.writeAction;
  return isWriteAction(name);
}

/** 实际参与裁决的动作名：写工具用 writeAction，只读工具用 action。 */
export function toolAction(name: string): string {
  const spec = toolSpec(name);
  return toolIsWrite(name) ? (spec.writeAction ?? 'file.write') : spec.action;
}

export function toolRisk(name: string): ToolRisk {
  return toolSpec(name).risk;
}

/** 该名字是不是已合并的旧名（诊断/提示词用：告诉模型"这个名还能用，但请改用新名"）。 */
export function toolAliasOf(name: string): string | undefined {
  return TOOL_REGISTRY[name]?.deprecatedAliasOf;
}
