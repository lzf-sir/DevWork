/**
 * 工具登记表 —— 权限裁决、凭据检查、网关 tool_call 事件的**唯一事实来源**。
 *
 * 为什么必须集中：网关曾经把模型调用的 risk 写死成 'low'、write 写死成 false，
 * 而落在哪张资产的凭据校验又是另一份表。两份表一漂移，模型挑一个写工具就能
 * 绕过审批——这属于安全缺陷而不是代码风格问题。
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
  browser_navigate: {
    assetId: 'w-ops', action: 'browser.navigate',
    needsCredential: false, risk: 'low', label: '浏览器导航',
  },
  browser_read_page: {
    assetId: 'w-ops', action: 'browser.read',
    needsCredential: false, risk: 'low', label: '读取当前页面',
  },
  code_search: {
    assetId: 'a-order-service', action: 'code.search.read',
    needsCredential: false, risk: 'low', label: '代码库',
  },
  code_read: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '读取代码文件',
  },
  code_symbols: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '符号大纲',
  },
  code_diff: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '查看 diff',
  },
  db_query: {
    assetId: 'a-order-db-dev', action: 'sql.query.read',
    needsCredential: true, risk: 'low', label: '只读 SQL 查询',
  },
  db_schema: {
    assetId: 'a-order-db-dev', action: 'sql.query.read',
    needsCredential: false, risk: 'low', label: '读表结构',
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
  db_tables: {
    assetId: 'a-order-db-dev', action: 'sql.query.read',
    needsCredential: false, risk: 'low', label: '表行数画像',
  },
  code_todos: {
    assetId: 'a-order-service', action: 'code.read',
    needsCredential: false, risk: 'low', label: '标记扫描',
  },
  /* ===== V2 写能力层 ===== */
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
