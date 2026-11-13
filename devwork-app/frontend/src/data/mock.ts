/**
 * DevWork 原型复刻 —— 全部静态可序列化 mock 数据。
 * 数据集中在此文件，视图层只负责渲染与交互，不内嵌业务常量。
 */
import type { TurnUsage } from '../api/types';

/* ===================== 基础类型 ===================== */

export type ViewName =
  | 'chat'
  | 'detail-server'
  | 'detail-db'
  | 'detail-code'
  | 'detail-kb'
  | 'projects'
  | 'settings';

export type AssetGo = 'code' | 'db' | 'server' | 'kb';
/** 资产状态：indexing = 索引中（用状态点表示，不再暴露百分比）。 */
export type AssetStatus = 'ok' | 'warn' | 'offline' | 'nb' | 'indexing';

export interface AssetItem {
  id: string;
  name: string;
  icon: string;
  go?: AssetGo;
  env?: string;
  status: AssetStatus;
  title?: string;
}

export interface ConvItem {
  id: string;
  title: string;
  /** 资产绑定：这条会话是从哪个资产的页面唤起的（普通会话为空）。 */
  assetId?: string;
  /** 绑定资产的类型：code / db / server / kb。 */
  assetType?: string;
}

export interface AssetFolder {
  id: string;
  name: string;
  count: number;
  open: boolean;
  items: AssetItem[];
  /** 两层目录：子文件夹只能是叶子，服务端在写入侧强制 depth ≤ 2。 */
  subFolders?: AssetFolder[];
}

export interface ConvFolder {
  id: string;
  name: string;
  count: number;
  open: boolean;
  items: ConvItem[];
  subFolders?: ConvFolder[];
}

export interface SidebarData {
  assetFolders: AssetFolder[];
  looseAssets: AssetItem[];
  convFolders: ConvFolder[];
  looseConvs: ConvItem[];
}

export interface Project {
  id: string;
  name: string;
  desc: string;
  index: number;
  assetsLabel: string;
  convLabel: string;
  owner: string;
  recent: string;
  sidebar: SidebarData;
}

export type InlineSeg =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'cite'; id: number };

/**
 * 前端消息卡。usage 是单轮回复的 token 用量（服务端打在轮末卡片 payload 上），
 * 可选字段——历史消息 / 离线兜底没有用量时如实不显示。
 */
export type Message = (
  | { id: string; kind: 'user'; text: string; chips: string[] }
  | { id: string; kind: 'text'; text: string }
  | {
      id: string;
      kind: 'tool';
      name: string;
      status: string;
      /** 状态语义：ok 放行 / warn 失败或待审批 / deny 已拦截 / suggest 转建议。 */
      statusCls?: 'ok' | 'warn' | 'deny' | 'suggest';
      ms: string;
      args: string;
      result: string;
    }
  /** 审批卡：agents 的写操作待裁决。resolved 后按钮必须禁用，不能重复裁决。
   *  V2 起「批准」走三层防线真执行（hasPlan=true），回滚引用随裁决结果落卡。 */
  | {
      id: string;
      kind: 'approval';
      cmd: string;
      reason?: string;
      /** 只读信任边界下不可执行；approve 也只记录裁决，不落盘。 */
      executable?: boolean;
      resolved?: boolean;
      decision?: string;
      /** 卡片带可执行写计划（plan）：批准后服务端按 precheck→执行→校验→回滚 真跑。 */
      hasPlan?: boolean;
      /** 风险级别（low/medium/high），按钮与提示样式用。 */
      risk?: string;
      /** 裁决后才有：执行是否成功（仅 hasPlan 卡）。 */
      executionOk?: boolean;
      /** 裁决后才有：回滚引用 JSON（可回滚时非空，「回滚」按钮据此显示）。 */
      rollbackRef?: string | null;
      /** 本卡裁决时的 scope（once/session），展示「本会话免审」是否已生效。 */
      scope?: string;
    }
  /** 建议卡：deny / suggest 裁决的产物，只给命令与解释，没有批准按钮。 */
  | { id: string; kind: 'suggestion'; cmd: string; reason?: string; suggestion?: string }
  /** 计划卡：展开可看每一步目标与耗时（此前被压成一行文字，信息全丢）。 */
  | { id: string; kind: 'plan'; intent: string; steps: { goal: string; durationMs: number }[]; degraded?: boolean }
  /** 降级说明：未接入模型 / 模型调用失败时必须常驻可见，不能只弹一次 toast。 */
  | { id: string; kind: 'notice'; level: 'info' | 'warn'; title: string; content: string }
  | { id: string; kind: 'conclusion'; confidence: string; paras: InlineSeg[][]; note?: string }
  | { id: string; kind: 'artifact'; name: string; meta: string; desc: string }
) & { usage?: TurnUsage };

export interface Citation {
  id: number;
  title: string;
  source: string;
  locator: string;
  code: string;
  score: string;
}

export interface CapItem {
  /** B21：服务端 asset_capability 行 ID，切换单个能力时用于 PATCH 回写。 */
  id?: string;
  name: string;
  desc: string;
  on: boolean;
  lock?: boolean;
  lockHint?: string;
}

export interface TermLine {
  cls?: 'pr' | 'dm' | 'er' | 'ok';
  text: string;
}

export interface SettingControl {
  type: 'select' | 'input' | 'toggle' | 'button';
  options?: string[];
  value?: string;
  on?: boolean;
  label?: string;
  danger?: boolean;
  action?: string;
  bindReadOnly?: boolean;
  adminOnly?: boolean;
}

export interface SettingRow {
  id: string;
  name: string;
  desc: string;
  control: SettingControl;
  impact?: string;
}

export interface SettingSection {
  id: string;
  label: string;
  title: string;
  desc: string;
  rows: SettingRow[];
}

/* ===================== 工作区 / 侧栏 ===================== */

const SIDEBAR_OPS: SidebarData = {
  assetFolders: [
    {
      id: 'af-order',
      name: '订单系统',
      count: 4,
      open: true,
      items: [
        { id: 'a-order-service', name: 'order-service', icon: '▣', go: 'code', status: 'ok' },
        { id: 'a-inventory-client', name: 'inventory-client', icon: '▣', go: 'code', status: 'ok' },
        { id: 'a-common-lib', name: 'common-lib', icon: '▣', go: 'code', status: 'indexing' },
        { id: 'a-order-db-dev', name: 'order_db', icon: '▤', go: 'db', env: 'dev', status: 'ok' },
      ],
    },
    {
      id: 'af-prod',
      name: '生产环境',
      count: 2,
      open: false,
      items: [
        {
          id: 'a-order-db-prod',
          name: 'order_db',
          icon: '▤',
          go: 'db',
          env: 'prod',
          status: 'nb',
          title: '尚未绑定凭据',
        },
        { id: 'a-order-api', name: 'order-api-01', icon: '▥', go: 'server', env: 'prod', status: 'ok' },
      ],
    },
  ],
  looseAssets: [{ id: 'a-kb', name: '运营知识库', icon: '▧', go: 'kb', status: 'ok' }],
  convFolders: [
    {
      id: 'cf-issue',
      name: '故障排查',
      count: 3,
      open: true,
      items: [
        { id: 'c-slow', title: '慢查询排查' },
        { id: 'c-disk', title: '磁盘告警复盘' },
        { id: 'c-pool', title: '连接池耗尽' },
      ],
    },
    {
      id: 'cf-quarter',
      name: '季度汇报',
      count: 1,
      open: false,
      items: [{ id: 'c-quarter', title: '季度方案文档' }],
    },
  ],
  looseConvs: [{ id: 'c-gmv', title: 'GMV 归因' }],
};

const SIDEBAR_DATA: SidebarData = {
  assetFolders: [
    {
      id: 'af-dw',
      name: '数仓模型',
      count: 3,
      open: true,
      items: [
        { id: 'a-hive-meta', name: 'hive_meta', icon: '▤', go: 'db', env: 'prod', status: 'ok' },
        { id: 'a-dwd', name: 'dwd_order', icon: '▤', go: 'db', status: 'ok' },
        { id: 'a-metric', name: '指标字典', icon: '▧', go: 'kb', status: 'ok' },
      ],
    },
    {
      id: 'af-etl',
      name: '调度脚本',
      count: 1,
      open: false,
      items: [{ id: 'a-etl', name: 'etl-pipeline', icon: '▣', go: 'code', status: 'ok' }],
    },
  ],
  looseAssets: [{ id: 'a-monitor', name: '调度监控', icon: '▥', go: 'server', status: 'ok' }],
  convFolders: [
    {
      id: 'cf-metric',
      name: '指标治理',
      count: 2,
      open: true,
      items: [
        { id: 'c-metric-check', title: '指标口径核对' },
        { id: 'c-hive-part', title: 'Hive 分区治理' },
      ],
    },
    {
      id: 'cf-daily',
      name: '日常',
      count: 2,
      open: false,
      items: [
        { id: 'c-daily', title: '日报汇总' },
        { id: 'c-slowtask', title: '慢任务排查' },
      ],
    },
  ],
  looseConvs: [{ id: 'c-q3', title: 'Q3 复盘' }],
};

const SIDEBAR_DELIVERY: SidebarData = {
  assetFolders: [
    {
      id: 'af-onsite',
      name: '客户现场',
      count: 2,
      open: true,
      items: [
        { id: 'a-client-code', name: 'client-app', icon: '▣', go: 'code', status: 'ok' },
        { id: 'a-client-db', name: 'client_db', icon: '▤', go: 'db', env: 'prod', status: 'nb' },
      ],
    },
  ],
  looseAssets: [{ id: 'a-docs', name: '交付文档库', icon: '▧', go: 'kb', status: 'ok' }],
  convFolders: [
    {
      id: 'cf-onsite',
      name: '实施',
      count: 2,
      open: true,
      items: [
        { id: 'c-launch', title: 'A 集团上线检查' },
        { id: 'c-proof', title: '文档校对' },
      ],
    },
  ],
  looseConvs: [{ id: 'c-accept', title: '交付验收清单' }],
};

export const PROJECTS: Project[] = [
  {
    id: 'w-ops',
    name: '生产运维',
    desc: '线上排障与运维。接入订单库、API 服务器与运营知识库。',
    index: 86,
    assetsLabel: '7 个资产',
    convLabel: '12 个会话',
    owner: '仅我',
    recent: '2 分钟前',
    sidebar: SIDEBAR_OPS,
  },
  {
    id: 'w-data',
    name: '数据平台',
    desc: '数仓建模与指标口径治理，接入了 Hive 元数据与指标字典。',
    index: 100,
    assetsLabel: '4 个资产',
    convLabel: '38 个会话',
    owner: '仅我',
    recent: '昨天',
    sidebar: SIDEBAR_DATA,
  },
  {
    id: 'w-delivery',
    name: '交付项目',
    desc: '客户现场实施的代码与文档，只读接入，禁止任何写操作。',
    index: 64,
    assetsLabel: '3 个资产',
    convLabel: '6 个会话',
    owner: '仅我',
    recent: '3 天前',
    sidebar: SIDEBAR_DELIVERY,
  },
];

/** 输入框「@ 引用资产」候选项与会话气泡 chip 的跳转映射。
 *  id 用于把选择真实解析成 sendMessage.assetIds（C2 上下文挂载链路）。 */
export const ASSET_PICKER: { id: string; label: string; icon: string; go: AssetGo | null }[] = [
  { id: 'a-order-db-prod', label: '生产库', icon: '▤', go: 'db' },
  { id: 'a-kb', label: '运营知识库', icon: '▧', go: null },
  { id: 'a-order-service', label: 'order-service', icon: '▣', go: 'code' },
  { id: 'a-order-api', label: 'order-api-01', icon: '▥', go: 'server' },
  { id: 'a-order-db-dev', label: 'order_db (dev)', icon: '▤', go: 'db' },
  { id: 'a-common-lib', label: 'common-lib', icon: '▣', go: 'code' },
];

export const CHAT_CHIP_LINKS: Record<string, AssetGo | null> = {
  '生产库': 'db',
  '运营知识库': null,
  'order-service': 'code',
  'order-api-01': 'server',
};

/* ===================== 会话消息流 ===================== */

export const GMV_THREAD: Message[] = [
  {
    id: 'm-gmv-1',
    kind: 'user',
    text: '上月 GMV 为什么跌了？',
    chips: ['生产库', '运营知识库'],
  },
  {
    id: 'm-gmv-2',
    kind: 'text',
    text: '先看 orders 表结构和口径，再决定按哪个维度拆。',
  },
  {
    id: 'm-gmv-3',
    kind: 'tool',
    name: 'pg_sql_query',
    status: '已自动放行',
    ms: '1.8s',
    args: '{\n  "asset": "order_db (prod)",\n  "sql": "SELECT status, count(*) FROM \\"order\\" GROUP BY status",\n  "limit": 1000,\n  "read_only": true\n}',
    result: '返回 5 行 · 命中索引 idx_order_status · 采样口径 v2.3\n完整结果落盘：~/.devwork/runs/2026-11-12/gmv/tool-3.json',
  },
  {
    id: 'm-gmv-4',
    kind: 'approval',
    cmd: 'truncate',
  },
  {
    id: 'm-gmv-5',
    kind: 'conclusion',
    confidence: '0.82',
    paras: [
      [
        { t: 'text', v: '口径变更导致 GMV 下降 ' },
        { t: 'strong', v: '-12%' },
        { t: 'text', v: '，另有 ' },
        { t: 'strong', v: '3%' },
        { t: 'text', v: ' 为退款冲减' },
        { t: 'cite', id: 1 },
        { t: 'cite', id: 2 },
        { t: 'text', v: '。' },
      ],
      [
        {
          t: 'text',
          v: '若不调整口径，同口径下实际同比 +1.4%，未出现真实下滑。',
        },
      ],
    ],
  },
  {
    id: 'm-gmv-6',
    kind: 'artifact',
    name: 'GMV 趋势图',
    meta: 'gmv_trend.png · 1280×720',
    desc: '按周聚合的 GMV 趋势，标注了 2026-09 口径变更点与退款冲减区间。',
  },
];

export const INITIAL_THREADS: Record<string, Message[]> = {
  'c-gmv': GMV_THREAD,
  'c-slow': [
    { id: 'm-slow-1', kind: 'user', text: '最近一周慢查询变多了，帮我看一下瓶颈在哪。', chips: ['生产库'] },
    { id: 'm-slow-2', kind: 'text', text: '先取 slow_log 的 Top 语句，再对照最近一次索引变更。' },
    {
      id: 'm-slow-3',
      kind: 'tool',
      name: 'pg_sql_query',
      status: '已自动放行',
      ms: '0.9s',
      args: '{ "sql": "SELECT * FROM slow_log ORDER BY duration DESC LIMIT 20" }',
      result: '返回 20 行 · 最慢 3.42s · 集中在 order_item 的全表扫描',
    },
    {
      id: 'm-slow-4',
      kind: 'conclusion',
      confidence: '0.91',
      paras: [[{ t: 'text', v: '缺少 idx_order_item_sku 导致扫描放大，建议补索引（Agent 只生成建议，不执行）。' }]],
    },
  ],
  'c-disk': [
    { id: 'm-disk-1', kind: 'user', text: '昨晚磁盘告警复盘一下。', chips: ['order-api-01'] },
    { id: 'm-disk-2', kind: 'text', text: '已拉取 /var/log 的写入速率与容器日志体积，结论如下。' },
    {
      id: 'm-disk-3',
      kind: 'tool',
      name: 'log.tail',
      status: '已自动放行',
      ms: '1.2s',
      args: '{ "path": "/var/log/order-api/error.log", "lines": 200 }',
      result: '200 行 · ERROR 37 条 · 均为 inventory-service 超时',
    },
  ],
  'c-pool': [
    { id: 'm-pool-1', kind: 'user', text: '连接池为什么会耗尽？', chips: ['order-service'] },
    { id: 'm-pool-2', kind: 'text', text: '正在比对 InventoryClient 的超时配置与连接池上限。' },
    {
      id: 'm-pool-3',
      kind: 'tool',
      name: 'code.search',
      status: '已自动放行',
      ms: '0.6s',
      args: '{ "query": "setConnectTimeout", "repo": "order-service" }',
      result: '命中 4 处 · InventoryClient.java:41-42 最近改动',
    },
  ],
  'c-quarter': [
    { id: 'm-q-1', kind: 'user', text: '帮我整理季度方案文档的提纲。', chips: [] },
    { id: 'm-q-2', kind: 'text', text: '已按「目标 / 现状 / 举措 / 排期 / 风险」生成提纲，产物见右栏。' },
  ],
  'c-metric-check': [
    { id: 'm-mc-1', kind: 'user', text: 'GMV 口径和数仓的口径一致吗？', chips: ['生产库'] },
    { id: 'm-mc-2', kind: 'text', text: '正在比对指标字典 v2.3 与 dwd_order 的聚合逻辑。' },
  ],
  'c-hive-part': [
    { id: 'm-hp-1', kind: 'user', text: 'Hive 分区治理从哪张表开始？', chips: [] },
    { id: 'm-hp-2', kind: 'text', text: '建议先处理分区数最多的 dwd_order，共 1,120 个分区。' },
  ],
  'c-daily': [
    { id: 'm-d-1', kind: 'user', text: '生成今天的调度日报。', chips: [] },
    { id: 'm-d-2', kind: 'text', text: '已完成：成功 128 / 失败 2 / 平均耗时 4.2min。' },
  ],
  'c-slowtask': [
    { id: 'm-st-1', kind: 'user', text: '昨天哪几个任务最慢？', chips: [] },
    { id: 'm-st-2', kind: 'text', text: 'Top 3：dwd_order_merge 18min、ads_gmv 11min、dim_user 7min。' },
  ],
  'c-q3': [
    { id: 'm-q3-1', kind: 'user', text: 'Q3 复盘的核心结论是什么？', chips: [] },
    { id: 'm-q3-2', kind: 'text', text: '口径统一后，Q3 同口径同比 +6.8%，主要来自复购提升。' },
  ],
  'c-launch': [
    { id: 'm-l-1', kind: 'user', text: 'A 集团上线前检查清单。', chips: ['client-app'] },
    { id: 'm-l-2', kind: 'text', text: '9 项检查已列出，其中 2 项待客户确认（只读接入，不执行变更）。' },
  ],
  'c-proof': [
    { id: 'm-p-1', kind: 'user', text: '校对交付文档的术语。', chips: [] },
    { id: 'm-p-2', kind: 'text', text: '发现 6 处术语不一致，已生成修改建议（patch，未落盘）。' },
  ],
  'c-accept': [
    { id: 'm-a-1', kind: 'user', text: '交付验收还缺什么材料？', chips: [] },
    { id: 'm-a-2', kind: 'text', text: '缺压测报告与运维手册，验收清单已整理到右栏产物。' },
  ],
};

/* ===================== 引用浮层 ===================== */

export const CITATIONS: Record<number, Citation> = {
  1: {
    id: 1,
    title: 'GMV 口径说明 v2.3',
    source: '运营知识库 · docs/ops/metrics.md',
    locator: 'docs/ops/metrics.md:40-42',
    code: '40  自 2026-09 起，GMV 统计口径统一为：\n41  GMV 剔除退款金额，且不再计入\n42  内部测试订单（此前计入）。',
    score: '0.87',
  },
  2: {
    id: 2,
    title: '2026Q3 运营复盘',
    source: '运营知识库 · docs/ops/q3-review.md',
    locator: 'docs/ops/q3-review.md:88-90',
    code: '88  9 月退款冲减合计 3.0%，\n89  主要集中在 9/12 大促后的\n90  批量退货（约 1,204 笔）。',
    score: '0.72',
  },
  3: {
    id: 3,
    title: 'order_db · order 表采样',
    source: '生产库 · public.order',
    locator: 'SELECT status, count(*) FROM "order"',
    code: 'status   | count\n---------+--------\nPAID     | 812,441\nPENDING  |   1,283\nCLOSED   |   9,107',
    score: '0.65',
  },
};

/* ===================== 右栏数据 ===================== */

export const CTX_MOUNTED = [
  { name: '@ 生产库', meta: '6 表 · 只读', go: 'db' as AssetGo },
  { name: '@ 运营知识库', meta: '3 片段', go: null },
];
export const CTX_HITS = [
  { name: 'GMV 口径说明', meta: ['v2.3', '命中 0.87'] },
  { name: '2026Q3 运营复盘', meta: ['第 4 节', '命中 0.72'] },
];
export const CTX_BARS = [
  { name: '系统提示', width: 18, value: '3k' },
  { name: '检索结果', width: 62, value: '11k' },
  { name: '工具结果', width: 78, value: '14k' },
  { name: '历史对话', width: 22, value: '4k' },
];
export const RUN_TOOLS = [
  { name: 'pg_sql_query', meta: ['已自动放行', '1.8s'], pending: false },
  { name: 'pg_sql_query', meta: ['已自动放行', '0.9s'], pending: false },
  { name: 'fs_truncate_log', meta: ['待审批 · 未执行'], pending: true },
];
export const RUN_BARS = [
  { name: 'pg_sql_query', width: 88, value: '1.8s' },
  { name: 'kb_search', width: 42, value: '0.9s' },
  { name: 'chart_render', width: 26, value: '0.5s' },
];
export const OUTPUT_FILES = [
  { id: 'art-seed-1', tag: 'DOC', name: '季度复盘.docx', size: '86KB', bg: '#EAF1FE', fg: '#2F6FEB' },
  { id: 'art-seed-2', tag: 'PNG', name: 'gmv_trend.png', size: '128KB', bg: '#EAF1FE', fg: '#2F6FEB' },
];

/* ===================== 资产详情 · 概览 ===================== */

export const SERVER_METRICS = [
  { k: 'CPU', v: '23', s: '%' },
  { k: '内存', v: '4.2', s: '/ 8 GB' },
  { k: '磁盘', v: '62', s: '%' },
  { k: '运行时长', v: '3', s: '天 4 时' },
];
export const SERVER_CONN_KV = [
  { k: '主机', v: '10.20.1.31' },
  { k: '登录用户', v: 'deploy（密钥认证，无 sudo）' },
  { k: '系统', v: 'Ubuntu 22.04 LTS · 时区 Asia/Shanghai' },
  { k: '工作目录', v: '/opt/app' },
  { k: '运行容器', v: 'order-api:1.8.2 · redis:7.2 · nginx:1.25' },
];
export const SERVER_ACTIVITY_KV = [
  { k: '2 分钟前', v: '查看 docker ps（你）' },
  { k: '1 小时前', v: 'tail error.log（Agent · 会话「排查 QPS 下降」）' },
  { k: '昨天', v: 'journalctl -u order-api -n 200（你）' },
];

export const DB_METRICS = [
  { k: '表数量', v: '42', s: '' },
  { k: '索引耗时', v: '11', s: 'min' },
  { k: '平均查询', v: '42', s: 'ms' },
  { k: '连接数', v: '3', s: '/ 20' },
];
export const DB_CONN_KV = [
  { k: '连接串', v: 'order-db.prod:5432/order_db' },
  { k: '申请指引', v: '在 DBA 平台申请 prod 只读账号，命名格式 svc_<姓名>_ro' },
  { k: 'Schema', v: 'public（31 表）· biz（11 表）' },
  { k: '护栏', v: '自动 LIMIT 1000 · 语句超时 15s · 禁止 DDL/DML' },
  { k: '采样', v: '每表 20 行，用于理解字段形态' },
];
export const DB_ACTIVITY_KV = [
  { k: '3 分钟前', v: 'SELECT status, count(*) FROM "order" GROUP BY status · 38ms' },
  { k: '1 小时前', v: 'SELECT * FROM slow_log WHERE ... · 1,204 行 · Agent' },
];

export const CODE_METRICS = [
  { k: '文件', v: '1,284', s: '' },
  { k: '代码行', v: '86.4', s: 'k' },
  { k: '索引覆盖', v: '100', s: '%' },
  { k: '符号', v: '3,912', s: '' },
];
export const CODE_REPO_KV = [
  { k: '路径', v: '/Users/li/projects/order-service' },
  { k: '当前分支', v: 'feature/order-retry（领先 main 3 个提交）' },
  { k: '语言', v: 'Java 78% · TypeScript 19% · SQL 3%' },
  { k: '最近提交', v: 'a3f21c9 · 1 小时前 · 增加订单重试逻辑' },
  { k: '未提交改动', v: '2 个文件修改（在编辑器内可查看 diff）' },
];
export const CODE_ACTIVITY_KV = [
  { k: '1 小时前', v: '读取 InventoryClient.java（Agent · 会话「排查 QPS 下降」）' },
  { k: '今天', v: '审查 PR #4821 涉及 6 个文件' },
];

/* ===================== 能力授权 ===================== */

export const CAPS_SERVER: CapItem[] = [
  { name: '读取文件', desc: 'cat / head / tail / less · 限定 /opt/app 与 /var/log', on: true },
  { name: '执行只读命令', desc: '白名单 42 条 · ps / df / docker ps / journalctl / systemctl status', on: true },
  {
    name: '写入文件',
    desc: '只读模式下不可开启',
    on: false,
    lock: true,
    lockHint: '只读模式下不可开启：该项属于 Agent 写能力，请先关闭顶栏「只读模式」。',
  },
  {
    name: '重启服务 / 执行变更',
    desc: '只读模式下不可开启 · 需 M3 开放写权限',
    on: false,
    lock: true,
    lockHint: '只读模式下不可开启：需 M3 开放写权限，当前只能生成建议命令。',
  },
];

export const CAPS_DB: CapItem[] = [
  { name: '读取表结构', desc: 'schema / 列 / 索引 / 外键 · 用于生成查询与理解数据', on: true },
  { name: '只读查询', desc: '仅 SELECT · 自动 LIMIT 1000 · 语句超时 15s', on: true },
  {
    name: '写入数据（INSERT / UPDATE / DELETE）',
    desc: '只读模式下不可开启 · 生产库永久禁用',
    on: false,
    lock: true,
    lockHint: '生产库写操作永久禁用，仅提供只读凭据。',
  },
  {
    name: '修改表结构（DDL）',
    desc: '只读模式下不可开启 · 生产库永久禁用',
    on: false,
    lock: true,
    lockHint: '生产库 DDL 永久禁用，Agent 只能生成建议语句。',
  },
];

export const CAPS_CODE: CapItem[] = [
  { name: '读取代码', desc: '限定仓库根目录 · 排除 .env / *.pem / id_rsa', on: true },
  { name: '搜索与符号跳转', desc: '全文检索 + tree-sitter 符号索引 + LSP', on: true },
  { name: '用户手动编辑并保存', desc: '你的直接修改 · 首次确认后记住本次会话', on: true },
  {
    name: 'Agent 直接写入文件',
    desc: '只读模式下不可开启 · Agent 只能生成 patch 供你确认',
    on: false,
    lock: true,
    lockHint: '只读模式下不可开启：Agent 只能生成 patch，确认后由你手动落盘。',
  },
  {
    name: 'Git 写操作（commit / push / checkout）',
    desc: '只读模式下不可开启',
    on: false,
    lock: true,
    lockHint: '只读模式下不可开启：Git 写操作需 M3 开放权限。',
  },
];

/* ===================== 终端 ===================== */

export const TERMINAL_INITIAL: TermLine[] = [
  { cls: 'dm', text: '# 会话 1 · deploy@order-api-01 · 已连接 23ms' },
  { cls: 'pr', text: 'deploy@order-api-01:~$ docker ps' },
  { text: 'CONTAINER ID   IMAGE               STATUS       PORTS' },
  { text: '8f2a1c9d4e11   order-api:1.8.2     Up 3 days    8080/tcp' },
  { text: 'b71c0e228a03   redis:7.2           Up 3 days    6379/tcp' },
  { text: '' },
  { cls: 'pr', text: 'deploy@order-api-01:~$ tail -n 3 /var/log/order-api/error.log' },
  { cls: 'dm', text: '14:02:11 WARN  thread pool active=200/200' },
  { cls: 'er', text: '14:02:14 ERROR Timeout calling inventory-service' },
  { cls: 'er', text: '14:02:15 ERROR Timeout calling inventory-service' },
  { text: '' },
  { cls: 'pr', text: 'deploy@order-api-01:~$ rm -rf /var/log/order-api' },
  { cls: 'er', text: '✕ 已拦截：危险命令（rm -rf 命中黑名单）· 未发送到远端' },
  {
    cls: 'dm',
    text: '  只读模式下仅允许白名单命令。如需清理日志，请在会话中描述需求，由 Agent 生成建议命令。',
  },
  { text: '' },
];

export const COMMAND_BLACKLIST: { pattern: string; label: string }[] = [
  { pattern: 'rm -rf', label: 'rm -rf' },
  { pattern: 'rm -fr', label: 'rm -fr' },
  { pattern: 'mkfs', label: 'mkfs' },
  { pattern: 'shutdown', label: 'shutdown' },
  { pattern: 'reboot', label: 'reboot' },
  { pattern: 'dd ', label: 'dd' },
  { pattern: 'kill -9', label: 'kill -9' },
  { pattern: 'chmod 777', label: 'chmod 777' },
  { pattern: ':(){', label: 'fork bomb' },
  { pattern: '/dev/sda', label: '裸设备写入' },
];

export const COMMAND_WHITELIST: { prefix: string; output: TermLine[] }[] = [
  {
    prefix: 'docker ps',
    output: [
      { text: 'CONTAINER ID   IMAGE               STATUS       PORTS' },
      { text: '8f2a1c9d4e11   order-api:1.8.2     Up 3 days    8080/tcp' },
      { text: 'b71c0e228a03   redis:7.2           Up 3 days    6379/tcp' },
      { text: 'c93d7f1a2b40   nginx:1.25          Up 3 days    80/tcp' },
    ],
  },
  {
    prefix: 'tail',
    output: [
      { cls: 'dm', text: '14:02:11 WARN  thread pool active=200/200' },
      { cls: 'er', text: '14:02:14 ERROR Timeout calling inventory-service' },
      { cls: 'ok', text: '14:02:19 INFO  retry succeeded after 2 attempts' },
    ],
  },
  {
    prefix: 'ps',
    output: [
      { text: 'PID   USER    %CPU  %MEM  COMMAND' },
      { text: '1201  deploy   3.2   18.4  java -jar order-api.jar' },
      { text: '1338  redis    0.8   6.1   redis-server *:6379' },
    ],
  },
  {
    prefix: 'df',
    output: [
      { text: 'Filesystem      Size  Used Avail Use% Mounted on' },
      { text: '/dev/vda1        80G   49G   31G  62% /' },
    ],
  },
  {
    prefix: 'journalctl',
    output: [{ cls: 'dm', text: '-- Logs begin at Tue 2026-11-10 09:00:02 --' }, { cls: 'ok', text: 'order-api.service: Started Order API.' }],
  },
  {
    prefix: 'systemctl status',
    output: [{ cls: 'ok', text: '● order-api.service - active (running) since Tue 2026-11-10 09:00:12' }],
  },
  {
    prefix: 'cat',
    output: [{ cls: 'dm', text: '# /opt/app/application.yml · 只读预览（已脱敏）' }],
  },
  {
    prefix: 'head',
    output: [{ cls: 'dm', text: '# 文件前 10 行（只读）' }],
  },
  {
    prefix: 'free',
    output: [{ text: 'total   used   free   shared  buff/cache  available' }, { text: 'Mem:   8.0G  4.2G  1.1G   0.2G   2.5G       3.5G' }],
  },
  {
    prefix: 'uptime',
    output: [{ text: ' 14:06:02 up 3 days,  4:12,  1 user,  load average: 0.42, 0.51, 0.48' }],
  },
  {
    prefix: 'ls',
    output: [{ text: 'app.jar  application.yml  logs/  README.md  scripts/' }],
  },
  {
    prefix: 'whoami',
    output: [{ text: 'deploy' }],
  },
  {
    prefix: 'date',
    output: [{ text: 'Thu Nov 12 14:06:02 CST 2026' }],
  },
];

export const TERMINAL_HISTORY = [
  'docker ps',
  'tail -n 3 /var/log/order-api/error.log',
  'rm -rf /var/log/order-api',
];

/* ===================== 数据库 ===================== */

export const DB_TABLES_SQL = [
  { name: 'order', rows: '1.2M', group: 'public' },
  { name: 'order_item', rows: '4.8M', group: 'public' },
  { name: 'user', rows: '312k', group: 'public' },
  { name: 'payment', rows: '890k', group: 'public' },
  { name: 'slow_log', rows: '2.1M', group: 'public' },
  { name: 'inventory', rows: '120k', group: 'biz' },
  { name: 'campaign', rows: '38', group: 'biz' },
];

export const DB_TABLES_BROWSE = [
  { name: 'order', rows: '1.2M', group: 'public' },
  { name: 'order_item', rows: '4.8M', group: 'public' },
  { name: 'user', rows: '312k', group: 'public' },
  { name: 'payment', rows: '890k', group: 'public' },
];

/* 默认语句必须是**引擎真的能跑**的语法：演示库是 SQLite，写 PG 的
 * now() - interval '2 hours' 只会让用户第一次点执行就报错，还容易被误读成
 * "被安全策略拦截"。时间窗用 SQLite 的 datetime()；窗口取 7 天而非 2 小时，
 * 是因为演示库数据是静态种子的历史日期。 */
export const DEFAULT_SQL_TEXT =
  'SELECT id, user_id, status, amount, created_at\n' +
  'FROM "order"\n' +
  "WHERE status = 'PENDING'\n" +
  "  AND created_at >= datetime('now', '-7 days')\n" +
  'ORDER BY created_at DESC';

/** SQL 语法高亮（用于 contentEditable 初始内容与「格式化」后重绘）。 */
export function highlightSql(raw: string): string {
  const keywords =
    /\b(SELECT|FROM|WHERE|AND|OR|ORDER|BY|GROUP|HAVING|LIMIT|AS|JOIN|ON|IN|NOT|NULL|DESC|ASC|datetime|strftime|date|now|EXPLAIN|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/g;
  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return raw
    .split('\n')
    .map((line, idx) => {
      const num = String(idx + 1).padStart(2, ' ');
      let body = escapeHtml(line).replace(/('[^']*')/g, '<span class="str2">$1</span>');
      body = body.replace(keywords, '<span class="kw2">$1</span>');
      return `<span class="ln">${num} </span>${body}`;
    })
    .join('\n');
}

export const SQL_HIGHLIGHTED = highlightSql(DEFAULT_SQL_TEXT);

export const SQL_RESULT_COLUMNS = ['id', 'user_id', 'status', 'amount', 'created_at'];
export const SQL_RESULT_ROWS: string[][] = [
  ['9821431', '77301', 'PENDING', '1,299.00', '2026-11-12 14:02:41'],
  ['9821430', '41128', 'PENDING', '268.50', '2026-11-12 14:02:39'],
  ['9821429', '90210', 'PENDING', '4,800.00', '2026-11-12 14:02:38'],
  ['9821428', '33017', 'PENDING', '99.00', '2026-11-12 14:02:34'],
  ['9821427', '5544', 'PENDING', '1,050.00', '2026-11-12 14:02:31'],
  ['9821426', '61209', 'PENDING', '328.00', '2026-11-12 14:02:29'],
  ['9821425', '18872', 'PENDING', '2,199.00', '2026-11-12 14:02:27'],
  ['9821424', '7401', 'PENDING', '76.00', '2026-11-12 14:02:25'],
];

export const BROWSE_COLUMNS = ['id', 'user_id', 'status', 'amount', 'channel', 'remark', 'created_at'];
export const BROWSE_ROWS: string[][] = [
  ['9821431', '77301', 'PENDING', '1,299.00', 'APP', 'NULL', '2026-11-12 14:02:41'],
  ['9821430', '41128', 'PENDING', '268.50', 'WEB', 'NULL', '2026-11-12 14:02:39'],
  ['9821429', '90210', 'PAID', '4,800.00', 'APP', '加急', '2026-11-12 14:02:38'],
  ['9821428', '33017', 'PAID', '99.00', 'MINI', 'NULL', '2026-11-12 14:02:34'],
  ['9821427', '5544', 'CLOSED', '1,050.00', 'WEB', 'NULL', '2026-11-12 14:02:31'],
  ['9821426', '61209', 'PAID', '328.00', 'APP', 'NULL', '2026-11-12 14:02:29'],
  ['9821425', '18872', 'PENDING', '2,199.00', 'APP', '待补发票', '2026-11-12 14:02:27'],
  ['9821424', '7401', 'PAID', '76.00', 'MINI', 'NULL', '2026-11-12 14:02:25'],
];

export const BROWSE_INDEXES = [
  ['idx_order_pkey', 'PRIMARY', 'id', 'BTREE · 唯一'],
  ['idx_order_status', 'INDEX', 'status, created_at', 'BTREE · 非唯一'],
];
export const BROWSE_FKS = [
  ['fk_order_user', 'user_id', 'public.user(id)', 'ON DELETE RESTRICT'],
  ['fk_order_payment', 'payment_id', 'public.payment(id)', 'ON DELETE SET NULL'],
  ['fk_order_campaign', 'campaign_id', 'biz.campaign(id)', 'ON DELETE SET NULL'],
];
export const BROWSE_STRUCTURE = [
  ['id', 'bigint', 'NOT NULL', '主键'],
  ['user_id', 'bigint', 'NOT NULL', '外键 → user'],
  ['status', 'varchar(16)', 'NOT NULL', '枚举：PENDING/PAID/CLOSED'],
  ['amount', 'numeric(12,2)', 'NOT NULL', '单位：元'],
  ['channel', 'varchar(8)', 'NULL', 'APP/WEB/MINI'],
  ['remark', 'text', 'NULL', '可为空'],
  ['created_at', 'timestamp', 'NOT NULL', '默认 now()'],
];

/* ===================== 代码库 ===================== */

export interface CodeFile {
  name: string;
  path: string;
  lang: string;
  gutterStart: number;
  html: string;
  symbols: { sg: string; label: string; line?: number }[];
  modified: boolean;
}

export const CODE_FILES: CodeFile[] = [
  {
    name: 'InventoryClient.java',
    path: 'src/main/java/order/InventoryClient.java',
    lang: 'Java',
    gutterStart: 36,
    html:
      '<span class="cm3">@Component</span>\n' +
      '<span class="kw3">public class</span> <span class="ty3">InventoryClient</span> {\n' +
      '\n' +
      '  <span class="kw3">public</span> <span class="ty3">InventoryResp</span> deduct(<span class="ty3">String</span> sku, <span class="kw3">int</span> qty) {\n' +
      '    HttpComponentsClientHttpRequestFactory f =\n' +
      '        <span class="kw3">new</span> HttpComponentsClientHttpRequestFactory();\n' +
      '    <span class="mod">f.setConnectTimeout(800);</span>\n' +
      '    <span class="mod">f.setReadTimeout(2000);</span>\n' +
      '    restTemplate.setRequestFactory(f);\n' +
      '    <span class="kw3">return</span> restTemplate.postForObject(url, req, InventoryResp.class);\n' +
      '  }',
    symbols: [
      { sg: 'M', label: 'deduct(sku, qty)' },
      { sg: 'M', label: 'queryStock(sku)' },
      { sg: 'C', label: 'InventoryClient' },
    ],
    modified: true,
  },
  {
    name: 'OrderService.java',
    path: 'src/main/java/order/OrderService.java',
    lang: 'Java',
    gutterStart: 1,
    html:
      '<span class="kw3">package</span> com.example.order;\n' +
      '\n' +
      '<span class="cm3">@Service</span>\n' +
      '<span class="kw3">public class</span> <span class="ty3">OrderService</span> {\n' +
      '\n' +
      '  <span class="kw3">private final</span> <span class="ty3">OrderRepository</span> repository;\n' +
      '\n' +
      '  <span class="kw3">public</span> <span class="ty3">Order</span> findById(<span class="kw3">long</span> id) {\n' +
      '    <span class="kw3">return</span> repository.findById(id).orElseThrow();\n' +
      '  }\n' +
      '}',
    symbols: [
      { sg: 'M', label: 'findById(id)' },
      { sg: 'M', label: 'createOrder(req)' },
      { sg: 'C', label: 'OrderService' },
    ],
    modified: false,
  },
  {
    name: 'OrderController.java',
    path: 'src/main/java/order/OrderController.java',
    lang: 'Java',
    gutterStart: 1,
    html:
      '<span class="cm3">@RestController</span>\n' +
      '<span class="cm3">@RequestMapping("/api/orders")</span>\n' +
      '<span class="kw3">public class</span> <span class="ty3">OrderController</span> {\n' +
      '\n' +
      '  <span class="cm3">@GetMapping("/{id}")</span>\n' +
      '  <span class="kw3">public</span> <span class="ty3">Order</span> get(<span class="kw3">long</span> id) {\n' +
      '    <span class="kw3">return</span> service.findById(id);\n' +
      '  }\n' +
      '}',
    symbols: [
      { sg: 'M', label: 'get(id)' },
      { sg: 'M', label: 'list(page)' },
      { sg: 'C', label: 'OrderController' },
    ],
    modified: false,
  },
  {
    name: 'OrderRepository.java',
    path: 'src/main/java/order/OrderRepository.java',
    lang: 'Java',
    gutterStart: 1,
    html:
      '<span class="kw3">public interface</span> <span class="ty3">OrderRepository</span>\n' +
      '    <span class="kw3">extends</span> <span class="ty3">JpaRepository</span>&lt;Order, Long&gt; {\n' +
      '\n' +
      '  <span class="ty3">List</span>&lt;Order&gt; findByStatus(<span class="ty3">String</span> status);\n' +
      '}',
    symbols: [
      { sg: 'M', label: 'findByStatus(status)' },
      { sg: 'I', label: 'OrderRepository' },
    ],
    modified: false,
  },
  {
    name: 'pom.xml',
    path: 'pom.xml',
    lang: 'XML',
    gutterStart: 1,
    html:
      '&lt;<span class="ty3">project</span>&gt;\n' +
      '  &lt;<span class="ty3">modelVersion</span>&gt;4.0.0&lt;/<span class="ty3">modelVersion</span>&gt;\n' +
      '  &lt;<span class="ty3">artifactId</span>&gt;order-service&lt;/<span class="ty3">artifactId</span>&gt;\n' +
      '  &lt;<span class="ty3">version</span>&gt;1.8.2&lt;/<span class="ty3">version</span>&gt;\n' +
      '&lt;/<span class="ty3">project</span>&gt;',
    symbols: [{ sg: 'X', label: 'project' }, { sg: 'X', label: 'dependencies' }],
    modified: false,
  },
];

/* 节点带完整仓库相对路径：按文件名匹配会在同名文件（如两个 application.yml）
 * 上跳错位置，而 path 是唯一可用的身份。 */
export const CODE_TREE = [
  { label: 'src', depth: 0, caret: '▾', path: null },
  { label: 'main', depth: 1, caret: '▾', path: null },
  { label: 'java', depth: 2, caret: '▾', path: null },
  { label: 'order', depth: 3, caret: '▾', path: null },
  { label: 'InventoryClient.java', depth: 4, caret: '·', path: 'src/main/java/order/InventoryClient.java' },
  { label: 'OrderService.java', depth: 4, caret: '·', path: 'src/main/java/order/OrderService.java' },
  { label: 'OrderController.java', depth: 4, caret: '·', path: 'src/main/java/order/OrderController.java' },
  { label: 'OrderRepository.java', depth: 4, caret: '·', path: 'src/main/java/order/OrderRepository.java' },
  { label: 'resources', depth: 2, caret: '▸', path: null },
  { label: 'test', depth: 0, caret: '▸', path: null },
  { label: 'pom.xml', depth: 0, caret: '·', path: 'pom.xml' },
  { label: 'README.md', depth: 0, caret: '·', path: 'README.md' },
];

export const CODE_PATCH =
  '--- a/src/main/java/order/InventoryClient.java\n' +
  '+++ b/src/main/java/order/InventoryClient.java\n' +
  '@@ -39,8 +39,8 @@\n' +
  '     HttpComponentsClientHttpRequestFactory f =\n' +
  '         new HttpComponentsClientHttpRequestFactory();\n' +
  '-    f.setConnectTimeout(800);\n' +
  '-    f.setReadTimeout(2000);\n' +
  '+    f.setConnectTimeout(1500);\n' +
  '+    f.setReadTimeout(3500);\n' +
  '     restTemplate.setRequestFactory(f);\n' +
  '\n' +
  '# 只读模式仅约束 Agent：以上为建议 patch，需你确认后手动落盘。';

export const CODE_DIFF =
  'InventoryClient.java · 与 HEAD 对比（2 行修改）\n' +
  ' 41 -  f.setConnectTimeout(500);\n' +
  ' 41 +  f.setConnectTimeout(800);\n' +
  ' 42 -  f.setReadTimeout(1000);\n' +
  ' 42 +  f.setReadTimeout(2000);';

/* ===================== 设置 ===================== */

export const SETTINGS_SECTIONS: SettingSection[] = [
  {
    id: 'gen',
    label: '通用',
    title: '通用',
    desc: '启动行为、语言与默认项目',
    rows: [
      {
        id: 'g1',
        name: '默认项目',
        desc: '启动时自动打开的项目',
        control: { type: 'select', options: ['生产运维', '数据平台', '交付项目'], value: '生产运维' },
      },
      {
        id: 'g3',
        name: '关闭窗口时',
        desc: '后台任务（索引、长任务）会继续运行',
        control: { type: 'select', options: ['最小化到托盘', '退出应用'], value: '最小化到托盘' },
      },
      {
        id: 'g4',
        name: '启动时恢复上次会话',
        desc: '直接回到上次打开的会话与滚动位置',
        control: { type: 'toggle', on: true },
      },
    ],
  },
  {
    id: 'model',
    label: '模型',
    title: '模型',
    desc: '供应商预设、端点、模型名与 API Key 均由你自行配置（C1）',
    rows: [
      {
        /* 行 id 必须与服务端读取键一致（llm-gateway 读 settingRaw('model').maxTokens）。
         * 原来写的是 m3：前端把 200000 写进 model.m3，服务端只读 maxTokens，
         * 两者永不相遇——界面显示的上限和真正生效的上限从来不是一回事。 */
        id: 'maxTokens',
        name: '单任务 token 上限',
        desc: '作为 max_tokens 传给供应商；超过即中断，防止成本失控',
        control: { type: 'input', value: '8192' },
      },
    ],
  },
  {
    id: 'perm',
    label: '权限与安全',
    title: '权限与安全',
    desc: '约束 Agent 的行为，不约束你自己的手动操作',
    rows: [
      {
        id: 'p1',
        name: '只读模式',
        desc: 'Agent 只能读取与查询；写操作转为生成建议。你的手动编辑与终端输入不受影响',
        control: { type: 'toggle', on: true, bindReadOnly: true },
      },
      {
        id: 'p2',
        name: '写操作审批',
        desc: '每次询问=所有写操作弹审批；按风险分级=仅高风险弹审批，低风险直接执行',
        control: { type: 'select', options: ['每次询问', '本会话内记住', '按风险分级'], value: '每次询问' },
      },
      {
        id: 'p3',
        name: '生产环境访问',
        desc: '对标记为 prod 的资产：完全禁止=拒绝，仅只读=写转建议，允许=需审批',
        control: { type: 'select', options: ['仅只读', '完全禁止', '允许（需审批）'], value: '仅只读' },
      },
      {
        id: 'p4',
        name: '敏感文件排除',
        desc: '12 条规则，命中者不索引、不进入上下文',
        control: { type: 'button', label: '编辑规则', action: 'rules' },
      },
      {
        id: 'p5',
        name: '命令白名单',
        desc: '服务器终端可执行的 42 条只读命令',
        control: { type: 'button', label: '查看', action: 'whitelist' },
      },
    ],
  },
  {
    id: 'privacy',
    label: '数据与隐私',
    title: '数据与隐私',
    desc: '留存、脱敏与出网控制',
    rows: [
      {
        id: 'v1',
        name: '上下文留存',
        desc: '快照与用量统计超期自动清理；会话与产物不受影响',
        control: { type: 'select', options: ['180 天', '30 天', '永久保留'], value: '180 天' },
      },
      {
        id: 'v4',
        name: '审计日志',
        desc: '只追加，含命令全文与调用来源',
        control: { type: 'button', label: '导出 CSV', action: 'export-audit' },
      },
      {
        id: 'v5',
        name: '清除缓存',
        desc: '清空上下文快照与用量统计（会话、产物、审计与索引保留）',
        control: { type: 'button', label: '清除…', action: 'confirm-clear', danger: true },
      },
    ],
  },
  {
    /* 会话归档管理：归档会话的唯一管理入口（侧栏只负责「归档」动作）。
     * rows 留空 —— 列表由 ArchiveManagerCard 按实时数据渲染，不是静态配置行。 */
    id: 'archive',
    label: '会话归档',
    title: '会话归档管理',
    desc: '归档的会话在此恢复到侧栏，或彻底删除',
    rows: [],
  },
  {
    id: 'look',
    label: '外观',
    title: '外观',
    desc: '主题、字号与列表密度',
    rows: [
      {
        id: 'l1',
        name: '主题',
        desc: '深色模式为独立配色，不是简单反色',
        control: { type: 'select', options: ['跟随系统', '浅色', '深色'], value: '跟随系统' },
      },
      {
        id: 'l2',
        name: '界面字号',
        desc: '13 / 14 / 15px 三档',
        control: { type: 'select', options: ['标准 14px', '较小 13px', '较大 15px'], value: '标准 14px' },
      },
      {
        id: 'l3',
        name: '代码字体',
        desc: '影响编辑器、终端与代码块',
        control: { type: 'select', options: ['JetBrains Mono', 'SF Mono', 'Consolas'], value: 'JetBrains Mono' },
      },
      {
        id: 'l4',
        name: '左栏密度',
        desc: '紧凑模式下每项 24px 高',
        control: { type: 'select', options: ['标准', '紧凑'], value: '标准' },
      },
    ],
  },
  {
    id: 'about',
    label: '关于',
    title: '关于',
    desc: '版本、运行环境与诊断',
    rows: [
      {
        id: 'a1',
        name: '版本与构建',
        desc: '运行时读取前后端版本',
        control: { type: 'button', label: '检查更新', action: 'update' },
      },
      {
        id: 'a2',
        name: '日志目录',
        desc: '运行时读取系统日志路径',
        control: { type: 'button', label: '打开', action: 'open-logs' },
      },
      {
        id: 'a3',
        name: '导出诊断信息',
        desc: '含索引状态、存储驱动与最近错误，不含代码与凭据',
        control: { type: 'button', label: '导出', action: 'export-diag' },
      },
    ],
  },
];

export type AuditCategory = '命令执行' | '凭据访问' | '策略变更' | '成员变更';

export const ORG_AUDIT: {
  id?: string;
  time: string;
  actor: string;
  action: string;
  target: string;
  result: string;
  resultCls: string;
  category: AuditCategory;
}[] = [
  { time: '今天 09:42', actor: '本机用户', action: 'exec.run · systemctl status', target: 'order-api-01', result: '放行', resultCls: '', category: '命令执行' },
  { time: '今天 09:31', actor: '本机用户', action: 'secret.read · 绑定凭据', target: 'order_db (prod)', result: '成功', resultCls: '', category: '凭据访问' },
  { time: '今天 08:10', actor: 'Agent', action: 'tool.invoke · fs_truncate_log', target: 'order-api-01', result: '拦截', resultCls: 'pending', category: '命令执行' },
  { time: '昨天 18:22', actor: '本机用户', action: 'policy.change · 强制只读 开启', target: '我的组织', result: '生效', resultCls: '', category: '策略变更' },
  { time: '前天 11:18', actor: '本机用户', action: 'secret.read · 轮换凭据', target: 'order_db (dev)', result: '成功', resultCls: '', category: '凭据访问' },
];

/* ===================== 技能（离线兜底） ===================== */

/**
 * 技能登记表 —— 离线兜底副本，与服务端 server/src/config/skills.ts 一一对应。
 *
 * 两份清单必须保持一致：tests/skills.mjs 会把服务端登记表与这份常量逐字段比对，
 * 不一致直接失败。技能是「模型真的会看到的方法论」，一旦漂移就会出现
 * 「前端菜单里的技能，服务端没有」或反之，比没有技能更糟。
 */
export const MOCK_SKILLS: {
  id: string;
  label: string;
  desc: string;
  category: string;
  template: string;
  tools: { name: string }[];
}[] = [
  {
    id: 'bug-locator',
    label: 'Bug 定位',
    desc: '症状澄清 → 日志/代码/数据三层收敛 → 证据链 → 结论与修复建议',
    category: '排障',
    tools: [{ name: 'code_search' }, { name: 'code_read' }, { name: 'db_query' }, { name: 'kb_search' }, { name: 'srv_log_tail' }],
    template:
      '[技能：Bug 定位] 请按「① collect：澄清症状并拉取相关日志 → ② locate：日志→代码→数据三层收敛定位 → '
      + '③ verify：用真实证据复现或排除 → ④ report：结论 + 修复建议（patch 以 diff 文本给出）」四步执行；'
      + '每一步引用真实工具结果，证据不足时明说不足，不要跳到结论。修复 patch 默认只建议不落盘。',
  },
  {
    id: 'cmd-advisor',
    label: '命令顾问',
    desc: '澄清意图 → 影响面评估 → 模板匹配 → 建议卡（命令+回滚）',
    category: '排障',
    tools: [{ name: 'srv_status' }, { name: 'srv_log_tail' }, { name: 'ws_list_assets' }],
    template:
      '[技能：命令顾问] 请按「① intent：澄清要做什么 → ② impact：用 srv_status 评估影响面 → '
      + '③ match：只使用命令模板库覆盖的意图（模板外操作明确说「模板库不支持，只能给建议」） → '
      + '④ present：给出命令、影响面与回滚命令」执行；禁止编造模板外的 shell 命令去执行。',
  },
  {
    id: 'log-investigator',
    label: '日志排查',
    desc: '时间窗与范围 → aggregate 摸量 → 取样关联 → 时间线与根因假设',
    category: '排障',
    tools: [{ name: 'log_query' }, { name: 'srv_status' }, { name: 'code_search' }],
    template:
      '[技能：日志排查] 请按「① frame：定时间窗与服务范围 → ② query：先小 limit 摸量再按需加大 → '
      + '③ correlate：跨服务/关键词关联 → ④ report：时间线 + 根因假设（标注置信依据）」执行；'
      + '直接全量检索会被熔断，先窄后宽。',
  },
  {
    id: 'sql-analyst',
    label: 'SQL 分析',
    desc: '读表结构 → EXPLAIN 执行计划 → 索引/扫描量分析 → 优化建议（DDL 仅文本）',
    category: '数据',
    tools: [{ name: 'db_query' }, { name: 'db_schema' }, { name: 'kb_search' }],
    template:
      '[技能：SQL 分析] 请按「① read：db_schema 看表结构与索引 → ② analyze：EXPLAIN 看执行计划与扫描量 → '
      + '③ report：优化建议（建议 DDL 一律以文本给出，不执行）」执行；写操作仅限明确确认后的 DML 且走审批。',
  },
  {
    id: 'doc-generator',
    label: '文档生成',
    desc: '读代码与已有文档 → 按模板起草 → 校验引用真实性 → 产出',
    category: '文档',
    tools: [{ name: 'code_read' }, { name: 'code_search' }, { name: 'kb_search' }, { name: 'code_symbols' }],
    template:
      '[技能：文档生成] 请按「① collect：读代码与已有文档 → ② draft：按结构起草 → '
      + '③ validate：核对文档中引用的接口/参数/行号是否真实存在（防文档幻觉） → ④ present」执行；'
      + '引用不存在的接口比不写更糟，校验不过就删掉那段。',
  },
  {
    id: 'code-reviewer',
    label: '代码审查（深）',
    desc: '定范围 → 分维度过 checklist → 分级问题清单（blocker/warning/nit）',
    category: '代码',
    tools: [{ name: 'code_search' }, { name: 'code_read' }, { name: 'code_symbols' }, { name: 'code_diff' }],
    template:
      '[技能：代码审查（深）] 请按「① scope：确定审查范围（diff/文件/符号） → ② review：超时/重试/空值/边界/'
      + '并发/事务分维度过 → ③ report：分级问题清单（blocker/warning/nit），每条指到文件与行」执行；'
      + '全程只读，不改文件。',
  },
  {
    id: 'release-check',
    label: '发布检查',
    desc: '未提交 diff → 遗留标记 → 近期错误日志 → 服务状态 → 放行/阻断结论',
    category: '代码',
    tools: [{ name: 'code_diff' }, { name: 'code_todos' }, { name: 'log_query' }, { name: 'srv_status' }],
    template:
      '[技能：发布检查] 请按「① diff：code_diff 过未提交变更 → ② todos：code_todos 扫遗留标记（新增 FIXME/阻断性 TODO 要点名） → '
      + '③ errors：log_query 查近期 ERROR/WARN → ④ status：srv_status 确认当前服务状态 → '
      + '⑤ verdict：给出 放行 / 带条件放行 / 阻断 结论与依据」执行；每一步引用真实工具结果，查不到就明说，不猜。',
  },
  {
    id: 'api-explorer',
    label: 'API 探查',
    desc: '端点规范 → 白名单内真实调用验证 → 代码定位 → 调用说明',
    category: '代码',
    tools: [{ name: 'api_spec_read' }, { name: 'api_call_read' }, { name: 'kb_search' }, { name: 'code_search' }],
    template:
      '[技能：API 探查] 请按「① spec：api_spec_read 列端点规范 → ② probe：api_call_read 在只读白名单内真实调用验证（路径不在白名单就明说，不去猜） → '
      + '③ locate：code_search 定位对应实现 → ④ present：给出请求形态、响应示例与实现位置」执行；'
      + '全程只读端点，禁止构造副作用调用。',
  },
  {
    id: 'perf-triage',
    label: '性能分诊',
    desc: '慢请求摸量 → 表规模画像 → 代码热点定位 → 分诊结论',
    category: '排障',
    tools: [{ name: 'log_query' }, { name: 'db_tables' }, { name: 'db_query' }, { name: 'db_schema' }, { name: 'code_search' }],
    template:
      '[技能：性能分诊] 请按「① measure：log_query 摸慢请求量与分布（先窄时间窗） → ② profile：db_tables 看表规模，db_query+EXPLAIN 看扫描量 → '
      + '③ locate：code_search 找到对应查询实现 → ④ triage：分诊结论（索引缺失/查询写法/数据量/服务资源），每条带证据」执行；'
      + '优化建议以文本给出，DML 走审批。',
  },
  {
    id: 'slow-query',
    label: '慢查询排查',
    desc: '慢日志 Top N → 量级分布 → 口径与索引核对，三步定位慢 SQL',
    category: '数据',
    tools: [{ name: 'pg_sql_query' }, { name: 'kb_search' }],
    template:
      '[技能：慢查询排查] 请按「① 拉慢日志 Top N 语句 → ② 看命中语句的量级与耗时分布 → ③ 核对口径与索引」三步排查；'
      + '全程只读，每一步都要给出数据来源，查不到就直接说没有，不要推测。',
  },
  {
    id: 'gmv-attribution',
    label: 'GMV 归因',
    desc: '先确认口径，再按维度拆解，区分口径变化与业务变化',
    category: '数据',
    tools: [{ name: 'pg_sql_query' }, { name: 'kb_search' }],
    template:
      '[技能：GMV 归因] 请按「① 用知识库确认指标口径 → ② 按渠道/状态/时间维度拆解同比与环比 → ③ 区分口径变更与业务变化」三步归因；'
      + '结论必须标注引用角标，无法证实的部分写「暂无证据」。',
  },
  {
    id: 'code-review',
    label: '代码审查',
    desc: '定位变更 → 检查超时重试与边界 → 给风险等级和改法',
    category: '代码',
    tools: [{ name: 'code_search' }],
    template:
      '[技能：代码审查] 请按「① 定位变更文件与关键方法 → ② 检查超时/重试/空值与边界 → ③ 给出风险等级与具体改法」审查；'
      + '只做只读检索，不要修改任何文件，每条问题都要指到文件与行。',
  },
  {
    id: 'incident-review',
    label: '故障复盘',
    desc: '现象 → 时间线 → 直接/根本原因 → 改进项',
    category: '排障',
    tools: [{ name: 'pg_sql_query' }, { name: 'kb_search' }, { name: 'code_search' }],
    template:
      '[技能：故障复盘] 请按「① 现象与影响面 → ② 关键时间线与证据 → ③ 直接原因 / 根本原因 → ④ 改进项与验收标准」四段输出；'
      + '每条结论都要有引用，缺证据就写「无证据」，不要用常识补齐。',
  },
  {
    id: 'kb-digest',
    label: '口径核对',
    desc: '列出文档原文口径、当前数据口径与是否一致',
    category: '文档',
    tools: [{ name: 'kb_search' }],
    template:
      '[技能：口径核对] 请先检索知识库中与该问题相关的文档，逐条列出「文档原文口径 / 当前数据口径 / 是否一致」；'
      + '不一致时指出差异来源，不要自行调和两边。',
  },
];

/* ===================== 快捷键 ===================== */

export const SHORTCUTS = [
  { key: '⌘K / Ctrl+K', desc: '命令面板（搜会话、跳资产、切项目、执行命令）' },
  { key: '⌘N / Ctrl+N', desc: '新建会话' },
  { key: '⌘O / Ctrl+O', desc: '项目概览（切项目）' },
  { key: '⌘, / Ctrl+,', desc: '系统设置' },
  { key: '⌘B / Ctrl+B', desc: '折叠 / 展开左栏' },
  { key: '⌘\\ / Ctrl+\\', desc: '折叠 / 展开右栏（上下文面板）' },
  { key: '⌘↵ / Ctrl+↵', desc: '发送 / 在 SQL 查询页执行' },
  { key: '⇧↵', desc: '换行' },
  { key: 'Esc', desc: '关闭浮层 / 退出设置与概览 / 中断任务' },
  { key: '⌘. / Ctrl+.', desc: '停止生成' },
  { key: '⌘P / Ctrl+P', desc: '打开文件（代码库详情页内）' },
  { key: '⌘S / Ctrl+S', desc: '保存（代码编辑器内）' },
  { key: '⌘L / Ctrl+L', desc: '清屏（服务器终端内）' },
  { key: '?', desc: '快捷键速查' },
];
