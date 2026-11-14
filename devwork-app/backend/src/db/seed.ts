/**
 * 幂等种子数据（V1）。
 * `SELECT COUNT(*) FROM workspace` 为 0 才在单事务插入；重启绝不覆盖用户改动。
 * 文案与 HTML 原型逐字一致。
 */
import { all, get, nowIso, run, tx } from './database';
import { orgName } from './repositories';
import { COMMAND_BLACKLIST, COMMAND_WHITELIST, SENSITIVE_RULES } from '../config/rules';
import { CLEAN_MODE } from '../config';
import { APP_VERSION } from '../config/version';

const STAMP = '2026-11-12T09:00:00.000Z';

interface AssetSeed {
  id: string;
  ws: string;
  folder: string | null;
  type: string;
  name: string;
  env: string;
  status: string;
  progress: number;
  bound: number;
  subtitle: string;
}

const WORKSPACES: [string, string, string, number, number, number, string, string, string][] = [
  ['w-ops', '生产运维', '线上排障与运维。接入订单库、API 服务器与运营知识库。', 86, 7, 12, '仅我', '2 分钟前', 'prod'],
  ['w-data', '数据平台', '数仓建模与指标口径治理，接入了 Hive 元数据与指标字典。', 100, 4, 38, '仅我', '昨天', 'normal'],
  ['w-delivery', '交付项目', '客户现场实施的代码与文档，只读接入，禁止任何写操作。', 64, 3, 6, '仅我', '3 天前', 'readonly'],
];

const FOLDERS: [string, string, 'asset' | 'conversation', string | null, string, number, number, number][] = [
  ['af-order', 'w-ops', 'asset', null, '订单系统', 4, 0, 0],
  ['af-prod', 'w-ops', 'asset', null, '生产环境', 2, 1, 1],
  ['cf-issue', 'w-ops', 'conversation', null, '故障排查', 3, 0, 0],
  ['cf-quarter', 'w-ops', 'conversation', null, '季度汇报', 1, 1, 1],
  ['af-dw', 'w-data', 'asset', null, '数仓模型', 3, 0, 0],
  ['af-etl', 'w-data', 'asset', null, '调度脚本', 1, 1, 1],
  ['cf-metric', 'w-data', 'conversation', null, '指标治理', 2, 0, 0],
  ['cf-daily', 'w-data', 'conversation', null, '日常', 2, 1, 1],
  ['af-onsite', 'w-delivery', 'asset', null, '客户现场', 2, 0, 0],
  ['cf-onsite', 'w-delivery', 'conversation', null, '实施', 2, 0, 0],
];

const ASSETS: AssetSeed[] = [
  { id: 'a-order-service', ws: 'w-ops', folder: 'af-order', type: 'code', name: 'order-service', env: '', status: 'online', progress: 100, bound: 1, subtitle: 'Git · main · 128 文件' },
  { id: 'a-inventory-client', ws: 'w-ops', folder: 'af-order', type: 'code', name: 'inventory-client', env: '', status: 'online', progress: 100, bound: 1, subtitle: 'Git · main · 42 文件' },
  { id: 'a-common-lib', ws: 'w-ops', folder: 'af-order', type: 'code', name: 'common-lib', env: '', status: 'indexing', progress: 62, bound: 1, subtitle: 'Git · 索引中' },
  { id: 'a-order-db-dev', ws: 'w-ops', folder: 'af-order', type: 'db', name: 'order_db', env: 'dev', status: 'online', progress: 100, bound: 1, subtitle: 'PostgreSQL · dev · 只读' },
  { id: 'a-order-db-prod', ws: 'w-ops', folder: 'af-prod', type: 'db', name: 'order_db', env: 'prod', status: 'unbound', progress: 100, bound: 0, subtitle: '尚未绑定凭据' },
  { id: 'a-order-api', ws: 'w-ops', folder: 'af-prod', type: 'server', name: 'order-api-01', env: 'prod', status: 'online', progress: 100, bound: 1, subtitle: 'SSH · deploy@10.20.1.31 · /opt/app' },
  { id: 'a-kb', ws: 'w-ops', folder: null, type: 'kb', name: '运营知识库', env: '', status: 'online', progress: 100, bound: 1, subtitle: '3 片段 · v2.3' },
  { id: 'a-hive-meta', ws: 'w-data', folder: 'af-dw', type: 'db', name: 'hive_meta', env: 'prod', status: 'online', progress: 100, bound: 1, subtitle: 'Hive Metastore · 只读' },
  { id: 'a-dwd', ws: 'w-data', folder: 'af-dw', type: 'db', name: 'dwd_order', env: '', status: 'online', progress: 100, bound: 1, subtitle: '1,120 分区' },
  { id: 'a-metric', ws: 'w-data', folder: 'af-dw', type: 'kb', name: '指标字典', env: '', status: 'online', progress: 100, bound: 1, subtitle: 'v2.3' },
  { id: 'a-etl', ws: 'w-data', folder: 'af-etl', type: 'code', name: 'etl-pipeline', env: '', status: 'online', progress: 100, bound: 1, subtitle: 'Git · main' },
  { id: 'a-client-code', ws: 'w-delivery', folder: 'af-onsite', type: 'code', name: 'client-app', env: '', status: 'online', progress: 100, bound: 1, subtitle: 'Git · release/1.0 · 只读接入' },
  { id: 'a-client-db', ws: 'w-delivery', folder: 'af-onsite', type: 'db', name: 'client_db', env: 'prod', status: 'unbound', progress: 100, bound: 0, subtitle: '尚未绑定凭据' },
  { id: 'a-docs', ws: 'w-delivery', folder: null, type: 'kb', name: '交付文档库', env: '', status: 'online', progress: 100, bound: 1, subtitle: '只读接入' },
];

/** 主工作区 6 个会话（原型可见 5 个 + 排查 QPS 下降）。 */
const CONVERSATIONS: [string, string, string | null, string, number][] = [
  ['c-gmv', 'w-ops', null, 'GMV 归因', 0],
  ['c-slow', 'w-ops', 'cf-issue', '慢查询排查', 0],
  ['c-disk', 'w-ops', 'cf-issue', '磁盘告警复盘', 1],
  ['c-pool', 'w-ops', 'cf-issue', '连接池耗尽', 2],
  ['c-quarter', 'w-ops', 'cf-quarter', '季度方案文档', 0],
  ['c-qps', 'w-ops', 'cf-issue', '排查 QPS 下降', 3],
  ['c-metric-check', 'w-data', 'cf-metric', '指标口径核对', 0],
  ['c-hive-part', 'w-data', 'cf-metric', 'Hive 分区治理', 1],
  ['c-q3', 'w-data', null, 'Q3 复盘', 0],
  ['c-launch', 'w-delivery', 'cf-onsite', 'A 集团上线检查', 0],
  ['c-accept', 'w-delivery', null, '交付验收清单', 0],
];

const GMV_MESSAGES: [string, string, string, string, string][] = [
  ['m-gmv-1', 'bubble', 'user', JSON.stringify({ content: '上月 GMV 为什么跌了？', chips: ['生产库', '运营知识库'] }), STAMP],
  ['m-gmv-2', 'text', 'agent', JSON.stringify({ content: '先看 orders 表结构和口径，再决定按哪个维度拆。' }), STAMP],
  [
    'm-gmv-3', 'tool_row', 'agent',
    JSON.stringify({
      name: 'pg_sql_query', toolName: 'pg_sql_query', status: '已自动放行', decision: 'allow',
      durationMs: 1800,
      args: '{\n  "asset": "order_db (prod)",\n  "sql": "SELECT status, count(*) FROM \\"order\\" GROUP BY status",\n  "limit": 1000,\n  "read_only": true\n}',
      result: '返回 5 行 · 命中索引 idx_order_status · 采样口径 v2.3\n完整结果落盘：~/.devwork/runs/2026-11-12/gmv/tool-3.json',
    }), STAMP,
  ],
  ['m-gmv-4', 'approval_card', 'agent', JSON.stringify({ command: 'truncate', decision: 'ask', executable: false, reason: 'fs_truncate_log 属于高风险写操作，待你审批' }), STAMP],
  [
    'm-gmv-5', 'conclusion', 'agent',
    JSON.stringify({
      confidence: '0.82', citationIds: ['cit-1', 'cit-2'],
      content: '口径变更导致 GMV 下降 -12%，另有 3% 为退款冲减[1][2]',
      paras: [
        [
          { t: 'text', v: '口径变更导致 GMV 下降 ' }, { t: 'strong', v: '-12%' },
          { t: 'text', v: '，另有 ' }, { t: 'strong', v: '3%' },
          { t: 'text', v: ' 为退款冲减' }, { t: 'cite', id: 1 }, { t: 'cite', id: 2 }, { t: 'text', v: '。' },
        ],
        [{ t: 'text', v: '若不调整口径，同口径下实际同比 +1.4%，未出现真实下滑。' }],
      ],
    }), STAMP,
  ],
  [
    'm-gmv-6', 'artifact', 'agent',
    JSON.stringify({
      name: 'GMV 趋势图', meta: 'gmv_trend.png · 1280×720',
      desc: '按周聚合的 GMV 趋势，标注了 2026-09 口径变更点与退款冲减区间。',
      fileName: 'gmv_trend.png', fileType: 'PNG', sizeBytes: 131072,
    }), STAMP,
  ],
];

const OTHER_MESSAGES: [string, string, string, string][] = [
  ['c-slow', '最近一周慢查询变多了，帮我看一下瓶颈在哪。', '先取 slow_log 的 Top 语句，再对照最近一次索引变更。', '生产库'],
  ['c-disk', '昨晚磁盘告警复盘一下。', '已拉取 /var/log 的写入速率与容器日志体积，结论如下。', 'order-api-01'],
  ['c-pool', '连接池为什么会耗尽？', '正在比对 InventoryClient 的超时配置与连接池上限。', 'order-service'],
  ['c-quarter', '帮我整理季度方案文档的提纲。', '已按「目标 / 现状 / 举措 / 排期 / 风险」生成提纲，产物见右栏。', ''],
  ['c-qps', '排查一下昨晚 QPS 下降的原因。', '已拉取网关 5 分钟粒度指标与下游超时日志，正在归因。', 'order-api-01'],
  ['c-metric-check', 'GMV 口径和数仓的口径一致吗？', '正在比对指标字典 v2.3 与 dwd_order 的聚合逻辑。', '生产库'],
  ['c-hive-part', 'Hive 分区治理从哪张表开始？', '建议先处理分区数最多的 dwd_order，共 1,120 个分区。', ''],
  ['c-q3', 'Q3 复盘的核心结论是什么？', '口径统一后，Q3 同口径同比 +6.8%，主要来自复购提升。', ''],
  ['c-launch', 'A 集团上线前检查清单。', '9 项检查已列出，其中 2 项待客户确认（只读接入，不执行变更）。', 'client-app'],
  ['c-accept', '交付验收还缺什么材料？', '缺压测报告与运维手册，验收清单已整理到右栏产物。', ''],
];

const CITATIONS: [string, string, string, string, string, string, number, string][] = [
  ['cit-1', 'c-gmv', 'GMV 口径说明 v2.3', '运营知识库 · docs/ops/metrics.md', 'docs/ops/metrics.md:40-42',
    '40  自 2026-09 起，GMV 统计口径统一为：\n41  GMV 剔除退款金额，且不再计入\n42  内部测试订单（此前计入）。', 0.87, 'v2.3'],
  ['cit-2', 'c-gmv', '2026Q3 运营复盘', '运营知识库 · docs/ops/q3-review.md', 'docs/ops/q3-review.md:88-90',
    '88  9 月退款冲减合计 3.0%，\n89  主要集中在 9/12 大促后的\n90  批量退货（约 1,204 笔）。', 0.72, '2026Q3'],
  ['cit-3', 'c-gmv', 'order_db · order 表采样', '生产库 · public.order', 'sql:SELECT status, count(*) FROM "order"',
    'status   | count\n---------+--------\nPAID     | 812,441\nPENDING  |   1,283\nCLOSED   |   9,107', 0.65, 'v2.3'],
];

const CONTEXT_PAYLOADS: [string, string][] = [
  ['context', JSON.stringify({
    mountedAssets: [
      { assetId: 'a-order-db-prod', name: '@ 生产库', meta: '6 表 · 只读' },
      { assetId: 'a-kb', name: '@ 运营知识库', meta: '3 片段' },
    ],
    mounted: [
      { name: '@ 生产库', meta: '6 表 · 只读', go: 'db' },
      { name: '@ 运营知识库', meta: '3 片段', go: null },
    ],
    hits: [
      { name: 'GMV 口径说明', version: 'v2.3', locator: 'docs/ops/metrics.md:40-42', score: 0.87, meta: ['v2.3', '命中 0.87'] },
      { name: '2026Q3 运营复盘', version: '第 4 节', locator: 'docs/ops/q3-review.md:88-90', score: 0.72, meta: ['第 4 节', '命中 0.72'] },
    ],
    tokenBreakdown: [
      { name: '系统提示', tokens: 3000 }, { name: '检索结果', tokens: 11000 },
      { name: '工具结果', tokens: 14000 }, { name: '历史对话', tokens: 4000 },
    ],
    bars: [
      { name: '系统提示', width: 18, value: '3k' }, { name: '检索结果', width: 62, value: '11k' },
      { name: '工具结果', width: 78, value: '14k' }, { name: '历史对话', width: 22, value: '4k' },
    ],
    totalTokens: 32000, budget: 204800,
  })],
  ['execution', JSON.stringify({
    steps: [
      { name: 'pg_sql_query', status: '已自动放行', durationMs: 1800, pending: false },
      { name: 'kb_search', status: '已自动放行', durationMs: 900, pending: false },
      { name: 'fs_truncate_log', status: '待审批 · 未执行', durationMs: 0, pending: true },
    ],
    tools: [
      { name: 'pg_sql_query', meta: ['已自动放行', '1.8s'], pending: false },
      { name: 'pg_sql_query', meta: ['已自动放行', '0.9s'], pending: false },
      { name: 'fs_truncate_log', meta: ['待审批 · 未执行'], pending: true },
    ],
    durations: [
      { name: 'pg_sql_query', width: 88, value: '1.8s' }, { name: 'kb_search', width: 42, value: '0.9s' },
      { name: 'chart_render', width: 26, value: '0.5s' },
    ],
    timings: [
      { name: 'pg_sql_query', width: 88, value: '1.8s' }, { name: 'kb_search', width: 42, value: '0.9s' },
      { name: 'chart_render', width: 26, value: '0.5s' },
    ],
    pendingApprovals: [{ name: 'fs_truncate_log', meta: ['待审批 · 未执行'] }],
    pending: [{ name: 'fs_truncate_log', meta: ['待审批 · 未执行'] }],
  })],
  ['artifacts', JSON.stringify({
    items: [
      { tag: 'DOC', name: '季度复盘.docx', size: '86KB', sizeBytes: 88064, bg: '#EAF1FE', fg: '#2F6FEB' },
      { tag: 'PNG', name: 'gmv_trend.png', size: '128KB', sizeBytes: 131072, bg: '#EAF1FE', fg: '#2F6FEB' },
    ],
    note: '产物会随会话保存，也可发布到资料库或直接下载。',
  })],
];

const SETTINGS: [string, string][] = [
  ['gen', JSON.stringify({ language: '简体中文', launch: '自动', telemetry: false })],
  ['model', JSON.stringify({ temperature: 0.2, maxTokens: 8192 })],
  ['perm', JSON.stringify({ readOnlyMode: true, orgForceReadOnly: false, workspaceTrust: 'prod', allowManualWrite: true, _policySeedVersion: 2 })],
  ['privacy', JSON.stringify({ indexEnabled: true, sensitiveRules: SENSITIVE_RULES.map((r) => r.pattern), retentionDays: 30 })],
  ['look', JSON.stringify({ theme: '浅色', density: '标准', fontSize: 13 })],
  /* 版本号从 config/version.ts 派生：种子只负责「首次启动时先写一份」，
   * 老库的覆盖由 migrateAboutVersion() 负责。 */
  ['about', JSON.stringify({ version: APP_VERSION, channel: '桌面版', build: 'devwork-app' })],
  /* 组织名：**可配置**，不再硬编码「订单中台」。
   * 那是原型期的虚构组织名，交付给用户的程序里属于残留的演示痕迹。
   * 打包态用中性默认名，用户可在设置里改成自己的组织。 */
  ['org', JSON.stringify({ name: '我的组织' })],
];

/**
 * 审计种子（仅开发态播种，clean 模式不播）。
 * target 用 @org 占位，插入时替换成真实组织名 —— 避免组织名在这里硬编码一份。
 */
const AUDIT_SEED: [string, string, string, string, string, string, string, string, string][] = [
  ['aud-seed-1', 'w-ops', '本机用户', 'user', 'exec.run · systemctl status', 'order-api-01', '放行', 'info', '今天 09:42'],
  ['aud-seed-2', 'w-ops', '本机用户', 'user', 'secret.read · 绑定凭据', 'order_db (prod)', '成功', 'info', '今天 09:31'],
  ['aud-seed-3', 'w-ops', 'Agent', 'agent', 'tool.invoke · fs_truncate_log', 'order-api-01', '拦截', 'warn', '今天 08:10'],
  ['aud-seed-4', 'w-ops', '本机用户', 'user', 'policy.change · 强制只读 开启', '@org', '生效', 'info', '昨天 18:22'],
];

const SQL_META: [string, string, string, number][] = [
  ['order', 'public', '1.2M', 1204331],
  ['order_item', 'public', '4.8M', 4800000],
  ['user', 'public', '312k', 312000],
  ['payment', 'public', '890k', 890000],
  ['slow_log', 'public', '2.1M', 2100000],
  ['inventory', 'biz', '120k', 120000],
  ['campaign', 'biz', '38', 38],
];

/**
 * 干净模式下的空工作区。
 *
 * 仍然需要**一个**工作区：bootstrap 路由按 workspaceId 取工作区，
 * 没有它整个应用无法启动。但它必须是空的 —— 没有资产、没有会话，
 * 是「等待用户接入真实资源」的起点，而不是演示素材。
 *
 * id 仍叫 w-ops：前端 store、路由默认值、审计默认字段都引用了这个 id，
 * 改 id 会牵连一串硬编码。这里改的是**内容**，不是标识。
 */
const CLEAN_WORKSPACE: [string, string, string, number, number, number, string, string, string][] = [
  ['w-ops', '我的工作区', '还没有接入任何资产。添加数据库、服务器或代码仓库后，这里会显示它们。', 0, 0, 0, '仅我', '刚刚', 'normal'],
];

/**
 * V9 幂等资产扩展：派生管线需要 log / api 两类资产才能覆盖全部七组工具。
 * 老库（workspace 非空）不会重跑 seedIfEmpty，所以这里单独做存在性检查后补插。
 */
export function ensureAgentV9Assets(): void {
  const extra: AssetSeed[] = [
    { id: 'a-order-log', ws: 'w-ops', folder: null, type: 'log', name: 'order-log', env: '', status: 'online', progress: 100, bound: 1, subtitle: '本地日志 · devwork.log' },
    { id: 'a-devwork-api', ws: 'w-ops', folder: null, type: 'api', name: 'devwork-api', env: '', status: 'online', progress: 100, bound: 1, subtitle: 'REST · 只读端点 · /api/*' },
  ];
  for (const a of extra) {
    const exists = get<{ n: number }>('SELECT COUNT(*) AS n FROM asset WHERE id = ?', a.id);
    if ((exists?.n ?? 0) > 0) continue;
    const config = JSON.stringify({ dbPath: '', reservedExternalMount: false });
    run(
      `INSERT INTO asset (id,workspace_id,folder_id,type,name,env,status,index_progress,credential_bound,subtitle,config,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      a.id, a.ws, a.folder, a.type, a.name, a.env, a.status, a.progress, a.bound, a.subtitle, config, nowIso(),
    );
    run(
      `INSERT INTO asset_connection (id,asset_id,env,endpoint,options) VALUES (?,?,?,?,?)`,
      `conn-${a.id}`, a.id, a.env || 'dev', a.type === 'log' ? 'file:devwork.log' : '127.0.0.1:3001', '{}',
    );
    run(
      `INSERT INTO credential_binding (id,asset_id,user_name,state,label,secret_ref,last_used_label,expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      `cred-${a.id}`, a.id, '本机', 'active', `${a.name} · 本地无需凭据`, '', '—', '—',
    );
    for (const [index, cap] of ['read', 'query', 'write'].entries()) {
      run(
        `INSERT INTO asset_capability (id,asset_id,capability,granted,approval,locked,description)
         VALUES (?,?,?,?,?,?,?)`,
        `cap-${a.id}-${index}`, a.id, cap, cap === 'write' ? 0 : 1,
        cap === 'write' ? 'deny' : 'auto', index === 0 ? 1 : 0,
        cap === 'write' ? 'Agent 写操作恒被拒绝并转建议' : '只读能力',
      );
    }
  }
}

/** 幂等插入全部初始数据。仅 workspace 表为空时执行。 */
export function seedIfEmpty(): void {
  const existing = all<{ n: number }>('SELECT COUNT(*) AS n FROM workspace');
  if ((existing[0]?.n ?? 0) > 0) return;

  if (CLEAN_MODE) {
    seedCleanSkeleton();
    return;
  }

  tx(() => {
    for (const w of WORKSPACES) {
      run(
        `INSERT INTO workspace (id,name,description,index_progress,assets_count,conversations_count,owner_label,recent_label,trust_level,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], STAMP,
      );
    }

    for (const f of FOLDERS) {
      run(
        `INSERT INTO folder (id,workspace_id,kind,parent_id,name,collapsed,sort_order,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        f[0], f[1], f[2], f[3], f[4], f[6], f[7], STAMP,
      );
    }

    for (const a of ASSETS) {
      const config = JSON.stringify({ dbPath: '', reservedExternalMount: false });
      run(
        `INSERT INTO asset (id,workspace_id,folder_id,type,name,env,status,index_progress,credential_bound,subtitle,config,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        a.id, a.ws, a.folder, a.type, a.name, a.env, a.status, a.progress, a.bound, a.subtitle, config, STAMP,
      );
      run(
        `INSERT INTO asset_connection (id,asset_id,env,endpoint,options) VALUES (?,?,?,?,?)`,
        `conn-${a.id}`, a.id, a.env || 'dev', a.type === 'server' ? '10.20.1.31:22' : a.type === 'db' ? '127.0.0.1:5432' : '', '{}',
      );
      run(
        `INSERT INTO credential_binding (id,asset_id,user_name,state,label,secret_ref,last_used_label,expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        `cred-${a.id}`, a.id, '本机', a.bound === 0 ? 'unbound' : 'active',
        a.bound === 0 ? '' : `${a.name} · 只读凭据`, a.bound === 0 ? '' : `vault/${a.id}`,
        a.bound === 0 ? '—' : '今天 09:31', a.bound === 0 ? '' : '2026-12-31',
      );
      for (const [index, cap] of ['read', 'query', 'write'].entries()) {
        run(
          `INSERT INTO asset_capability (id,asset_id,capability,granted,approval,locked,description)
           VALUES (?,?,?,?,?,?,?)`,
          `cap-${a.id}-${index}`, a.id, cap, cap === 'write' ? 0 : 1,
          cap === 'write' ? 'deny' : 'auto', index === 0 ? 1 : 0,
          cap === 'write' ? 'Agent 写操作恒被拒绝并转建议' : '只读能力',
        );
      }
    }

    for (const c of CONVERSATIONS) {
      run(
        `INSERT INTO conversation (id,workspace_id,folder_id,title,sort_order,created_at)
         VALUES (?,?,?,?,?,?)`,
        c[0], c[1], c[2], c[3], c[4], STAMP,
      );
      run(
        `INSERT INTO usage_stat (id,conversation_id,context_used,context_budget,cost_cny,model)
         VALUES (?,?,?,?,?,?)`,
        `usage-${c[0]}`, c[0], 32768, 204800, 0.42, 'Claude-Sonnet',
      );
    }

    /* GMV_MESSAGES 的元组顺序是 [id, kind, actor, payload, stamp]，而表的列顺序是
     * (id, conversation_id, kind, payload, actor, created_at) —— **前两位之外的顺序不同**。
     * 原来按 m[0..4] 顺位取值，payload 落成了 'agent'、actor 落成了那段 JSON，
     * 于是演示会话里那张审批卡一点「批准」就 500（JSON.parse('agent')）。
     * 已存在的演示库仍是脏行，删掉 backend/.runtime 重建即可（不为演示数据写迁移）。 */
    for (const m of GMV_MESSAGES) {
      run(
        `INSERT INTO message (id,conversation_id,kind,payload,actor,created_at) VALUES (?,?,?,?,?,?)`,
        m[0], 'c-gmv', m[1], m[3], m[2], m[4],
      );
    }
    for (const entry of OTHER_MESSAGES) {
      const [conv, question, answer, chip] = entry;
      run(
        `INSERT INTO message (id,conversation_id,kind,payload,actor,created_at) VALUES (?,?,?,?,?,?)`,
        `m-${conv}-1`, conv, 'bubble', JSON.stringify({ content: question, chips: chip ? [chip] : [] }), 'user', STAMP,
      );
      run(
        `INSERT INTO message (id,conversation_id,kind,payload,actor,created_at) VALUES (?,?,?,?,?,?)`,
        `m-${conv}-2`, conv, 'text', JSON.stringify({ content: answer }), 'agent', STAMP,
      );
    }

    run(
      `INSERT INTO tool_call (id,message_id,conversation_id,tool_name,args,result,permission,duration_ms,audit_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      'tc-gmv-1', 'm-gmv-3', 'c-gmv', 'pg_sql_query', '{"read_only":true,"limit":1000}',
      '返回 5 行 · 命中索引 idx_order_status', 'allow', 1800, 'aud-seed-tool', STAMP,
    );
    run(
      `INSERT INTO tool_call (id,message_id,conversation_id,tool_name,args,result,permission,duration_ms,audit_id,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      'tc-gmv-2', 'm-gmv-4', 'c-gmv', 'fs_truncate_log', '{"risk":"high"}',
      '未执行 · 转建议 / 待审批', 'suggest', 0, 'aud-seed-3', STAMP,
    );

    for (const c of CITATIONS) {
      run(
        `INSERT INTO citation (id,conversation_id,title,source,locator,snippet,confidence,version)
         VALUES (?,?,?,?,?,?,?,?)`,
        c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7],
      );
    }

    run(
      `INSERT INTO artifact (id,conversation_id,name,file_name,size_bytes,meta,created_at) VALUES (?,?,?,?,?,?,?)`,
      'art-doc', 'c-gmv', '季度复盘.docx', '季度复盘.docx', 88064, 'DOC · 86KB', STAMP,
    );
    run(
      `INSERT INTO artifact (id,conversation_id,name,file_name,size_bytes,meta,created_at) VALUES (?,?,?,?,?,?,?)`,
      'art-png', 'c-gmv', 'GMV 趋势图', 'gmv_trend.png', 131072, 'PNG · 128KB · 1280×720', STAMP,
    );

    /* 设置先播：AUDIT_SEED 里有一行的 target 取自组织名（setting.org.name），
     * 设置没落库前 orgName() 只能给默认值，审计行就会写错。 */
    for (const s of SETTINGS) {
      run(`INSERT INTO setting (section,raw) VALUES (?,?)`, s[0], s[1]);
    }

    for (const a of AUDIT_SEED) {
      run(
        `INSERT INTO audit_event (id,workspace_id,conversation_id,actor,source,action,target,result,severity,detail,created_at,created_at_label)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        a[0], a[1], 'c-gmv', a[2], a[3], a[4],
        /* @org 占位替换成当前组织名，避免组织名在种子数据里再写死一份。 */
        a[5] === '@org' ? orgName() : a[5],
        a[6], a[7], 'seed 初始审计', STAMP, a[8],
      );
    }

    for (const [index, entry] of CONTEXT_PAYLOADS.entries()) {
      run(
        `INSERT INTO context_snapshot (id,conversation_id,kind,payload,created_at) VALUES (?,?,?,?,?)`,
        `ctx-gmv-${index}`, 'c-gmv', entry[0], entry[1], STAMP,
      );
    }

    for (const w of COMMAND_WHITELIST) {
      run(
        `INSERT INTO command_whitelist (id,pattern,description,dispatcher) VALUES (?,?,?,?)`,
        w.id, w.pattern, w.description, w.dispatcher,
      );
    }
    for (const b of COMMAND_BLACKLIST) {
      run(
        `INSERT INTO command_blacklist_rule (id,pattern,description,platform) VALUES (?,?,?,?)`,
        b.id, b.pattern, b.description, b.platform,
      );
    }
    for (const s of SQL_META) {
      run(
        `INSERT INTO sql_table_meta (name,schema_name,rows_label,total_rows,page_label) VALUES (?,?,?,?,?)`,
        s[0], s[1], s[2], s[3], '第 1 / 1,205 页',
      );
    }

    for (const chunk of [
      ['ic-1', 'a-kb', 'w-ops', 'doc', 'docs/ops/metrics.md', 'GMV 口径说明', 40, 42, 'GMV 剔除退款金额，且不再计入内部测试订单。', 0.87],
      ['ic-2', 'a-kb', 'w-ops', 'doc', 'docs/ops/q3-review.md', '2026Q3 运营复盘', 88, 90, '9 月退款冲减合计 3.0%。', 0.72],
      ['ic-3', 'a-order-service', 'w-ops', 'code', 'src/main/java/InventoryClient.java', 'setConnectTimeout', 41, 42, 'connectTimeout = 1500;', 0.65],
    ]) {
      run(
        `INSERT INTO index_chunk (id,asset_id,workspace_id,kind,path,symbol,start_line,end_line,content,score)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        chunk[0] as string, chunk[1] as string, chunk[2] as string, chunk[3] as string,
        chunk[4] as string, chunk[5] as string, chunk[6] as number, chunk[7] as number,
        chunk[8] as string, chunk[9] as number,
      );
    }
  });
}

/**
 * 干净模式的初始骨架（打包态专用）。
 *
 * **只建应用运行必需的结构性配置**，不建任何演示素材：
 *   ✅ 建：1 个空工作区、设置项、命令黑白名单
 *   ❌ 不建：演示文件夹 / 资产 / 会话 / 消息 / 引用 / 产物 / 审计记录 /
 *             索引分块 / SQL 表元数据
 *
 * 为什么保留这些「配置」：权限内核要靠命令黑白名单与设置项判定读写，
 * 设置页的控件骨架要靠 setting 表回填 ——
 * 缺任何一项，应用要么起不来、要么功能无声失效。
 * 它们描述的是「程序怎么运行」，不是「你的业务里有什么」，所以不算假数据。
 */
function seedCleanSkeleton(): void {
  tx(() => {
    for (const w of CLEAN_WORKSPACE) {
      run(
        `INSERT INTO workspace (id,name,description,index_progress,assets_count,conversations_count,owner_label,recent_label,trust_level,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        w[0], w[1], w[2], w[3], w[4], w[5], w[6], w[7], w[8], nowIso(),
      );
    }

    for (const s of SETTINGS) {
      run(`INSERT INTO setting (section,raw) VALUES (?,?)`, s[0], s[1]);
    }
    for (const w of COMMAND_WHITELIST) {
      run(
        `INSERT INTO command_whitelist (id,pattern,description,dispatcher) VALUES (?,?,?,?)`,
        w.id, w.pattern, w.description, w.dispatcher,
      );
    }
    for (const b of COMMAND_BLACKLIST) {
      run(
        `INSERT INTO command_blacklist_rule (id,pattern,description,platform) VALUES (?,?,?,?)`,
        b.id, b.pattern, b.description, b.platform,
      );
    }
  });
  // eslint-disable-next-line no-console
  console.log('[DevWork] 干净模式：已建立空工作区与结构配置（无演示数据）');
}

/**
 * B6 一次性设置迁移：老版本把 orgForceReadOnly 与 readOnlyMode 同时默认 true，
 * 使 `readOnlyMode() = raw.readOnlyMode || raw.orgForceReadOnly` 中单独关闭
 * readOnlyMode 永远无效。新种子默认 orgForceReadOnly=false；已存在的业务库
 * 在此迁移到同一语义，并用 _policySeedVersion=2 标记，避免覆盖用户后续改动。
 */
export function migrateLegacySettings(): void {
  const row = get<{ raw: string }>("SELECT raw FROM setting WHERE section = 'perm'");
  if (!row) return;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(String(row.raw)) as Record<string, unknown>;
  } catch {
    return;
  }
  if (raw._policySeedVersion === 2) return;
  raw.orgForceReadOnly = false;
  raw.readOnlyMode = true;
  raw._policySeedVersion = 2;
  run('UPDATE setting SET raw = ? WHERE section = ?', JSON.stringify(raw), 'perm');
  // eslint-disable-next-line no-console
  console.log('[DevWork] perm 设置已迁移：orgForceReadOnly=false（只读开关可单独关闭）');
}

/**
 * 幂等补齐能力行：早期版本创建资产时不写 asset_capability，
 * 导致用户自建资产的「能力授权」页空白、权限裁决退回全局规则。
 * 启动时给缺行的资产补上 read / query / write 三档（写档要求人工确认）。
 */
export function backfillAssetCapabilities(): void {
  const assets = all<{ id: string }>('SELECT id FROM asset');
  const caps = [
    ['read', 'auto', '只读能力（自动放行）'],
    ['query', 'auto', '数据查询能力（自动放行）'],
    ['write', 'ask', 'Agent 写操作需人工确认'],
  ] as const;
  let filled = 0;
  for (const asset of assets) {
    const existing = all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM asset_capability WHERE asset_id = ?',
      asset.id,
    )[0]?.n ?? 0;
    if (existing > 0) continue;
    caps.forEach(([cap, approval, description], index) => {
      run(
        `INSERT INTO asset_capability (id,asset_id,capability,granted,approval,locked,description)
         VALUES (?,?,?,?,?,?,?)`,
        `cap-${asset.id}-${index}`, asset.id, cap, 1, approval, index === 0 ? 1 : 0, description,
      );
    });
    filled += 1;
  }
  if (filled > 0) {
    // eslint-disable-next-line no-console
    console.log(`[DevWork] 已为 ${filled} 个资产补齐能力行（read/query/write）`);
  }
}
