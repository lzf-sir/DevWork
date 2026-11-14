/**
 * Mock fallback 数据层。
 * 唯一允许引用 src/data/mock.ts 的文件；组件一律不直接 import 业务常量。
 * mockFallthrough 的 data 形状与 REST `data` 保持一致，保证断后端时 8 个视图全部可跑。
 */
export * from '../data/mock';

import type { ViewSnapshot } from './snapshot';
import type { TurnUsage } from './types';
import type { AssetGo, CapItem } from '../data/mock';
import {
  PROJECTS,
  INITIAL_THREADS,
  ASSET_PICKER,
  CHAT_CHIP_LINKS,
  CITATIONS,
  CTX_MOUNTED,
  CTX_HITS,
  CTX_BARS,
  RUN_TOOLS,
  RUN_BARS,
  OUTPUT_FILES,
  SETTINGS_SECTIONS,
  ORG_AUDIT,
  COMMAND_WHITELIST,
  COMMAND_BLACKLIST,
  MOCK_SKILLS,
  TERMINAL_INITIAL,
  DB_TABLES_SQL,
  DB_TABLES_BROWSE,
  SQL_RESULT_COLUMNS,
  SQL_RESULT_ROWS,
  BROWSE_COLUMNS,
  BROWSE_ROWS,
  BROWSE_INDEXES,
  BROWSE_FKS,
  BROWSE_STRUCTURE,
  CODE_FILES,
  CODE_TREE,
  CODE_DIFF,
  CODE_PATCH,
  TERMINAL_HISTORY,
  DEFAULT_SQL_TEXT,
  SQL_HIGHLIGHTED,
  highlightSql,
  SHORTCUTS,
  SERVER_METRICS,
  SERVER_CONN_KV,
  SERVER_ACTIVITY_KV,
  DB_METRICS,
  DB_CONN_KV,
  DB_ACTIVITY_KV,
  CODE_METRICS,
  CODE_REPO_KV,
  CODE_ACTIVITY_KV,
  CAPS_SERVER,
  CAPS_DB,
  CAPS_CODE,
} from '../data/mock';

import type { ApiEnvelope, ApiError, ApiMeta, Dict, HttpMethod } from './types';

let requestCounter = 0;

/* ── 模型档案（离线兜底）─────────────────────────────────────────────────
 * 断后端时设置页仍要能看到「已添加的模型」列表、能加、能删 ——
 * 否则离线开发时整个模型分区是空的，看起来像功能没做。
 * Key 在离线下一律「未配置」：离线环境没有钥匙串，如实说没有。
 */
const MOCK_LLM_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek（深度求索）', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'], keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'ollama', label: '本地 Ollama（无需 Key）', baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5:7b', 'llama3.1:8b'], keyUrl: 'https://ollama.com/library', local: true },
  { id: 'litellm', label: 'LiteLLM 网关（自部署 · 一个 Key 走所有上游）', baseUrl: 'http://localhost:4000/v1', models: [], keyUrl: 'https://docs.litellm.ai/docs/proxy/quick_start' },
  { id: 'custom', label: '自定义（OpenAI 兼容端点）', baseUrl: '', models: [], keyUrl: '' },
];

interface MockLlmProfile {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  local: boolean;
}

let mockLlmProfiles: MockLlmProfile[] = [
  { id: 'mock-1', label: 'DeepSeek Chat', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', local: false },
];
let mockLlmActiveId = 'mock-1';

/** 离线下的模型配置视图：Key 一律未配置（离线没有钥匙串）。 */
function mockLlmConfigShape(): Dict {
  const active = mockLlmProfiles.find((p) => p.id === mockLlmActiveId) ?? mockLlmProfiles[0];
  return {
    provider: active?.provider ?? 'custom',
    baseUrl: active?.baseUrl ?? '',
    model: active?.model ?? '',
    source: mockLlmProfiles.length > 0 ? 'db' : 'none',
    keyConfigured: false,
    keySource: 'none',
    presets: MOCK_LLM_PRESETS,
    profiles: mockLlmProfiles.map((p) => ({ ...p, keyConfigured: false, keySource: 'none' })),
    activeId: mockLlmActiveId,
  };
}

function meta(): ApiMeta {
  requestCounter += 1;
  return {
    requestId: `mock-${Date.now()}-${requestCounter}`,
    ts: Date.now(),
    apiMode: 'mock',
  };
}

export function mockOk<T>(data: T): ApiEnvelope<T> {
  return { ok: true, data, error: null, meta: meta() };
}

export function mockFail<T>(code: string, message: string, details?: unknown): ApiEnvelope<T> {
  const error: ApiError = { code, message, details };
  return { ok: false, data: {} as T, error, meta: meta() };
}

function projectById(id: string) {
  return PROJECTS.find((p) => p.id === id) ?? PROJECTS[0];
}

function workspaceShape(id: string): Dict {
  const project = projectById(id);
  return {
    id: project.id,
    name: project.name,
    description: project.desc,
    indexProgress: project.index,
    assetsCount: Number(project.assetsLabel.replace(/\D/g, '')) || 0,
    conversationsCount: Number(project.convLabel.replace(/\D/g, '')) || 0,
    owner: project.owner,
    recentLabel: project.recent,
    trustLevel: project.id === 'w-ops' ? 'prod' : 'normal',
  };
}

function sidebarShape(id: string): Dict {
  const project = projectById(id);
  return {
    workspaceId: id,
    assetFolders: project.sidebar.assetFolders.map((f) => ({
      id: f.id,
      name: f.name,
      count: f.count,
      open: f.open,
      collapsed: !f.open,
      items: f.items.map((a) => ({
        id: a.id,
        name: a.name,
        icon: a.icon,
        go: a.go ?? null,
        env: a.env ?? null,
        status: a.status,
      })),
    })),
    looseAssets: project.sidebar.looseAssets.map((a) => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      go: a.go ?? null,
      env: a.env ?? null,
      status: a.status,
    })),
    convFolders: project.sidebar.convFolders.map((f) => ({
      id: f.id,
      name: f.name,
      count: f.count,
      open: f.open,
      collapsed: !f.open,
      items: f.items.map((c) => ({ id: c.id, title: c.title })),
    })),
    looseConvs: project.sidebar.looseConvs.map((c) => ({ id: c.id, title: c.title })),
  };
}

function statusBarShape(): Dict {
  return {
    model: 'Claude-Sonnet',
    contextUsed: 32768,
    contextBudget: 204800,
    costCny: 0.42,
    state: '就绪',
  };
}

function panelsShape(): Dict {
  return {
    context: { mounted: CTX_MOUNTED, hits: CTX_HITS, bars: CTX_BARS },
    execution: { tools: RUN_TOOLS, timings: RUN_BARS, pending: RUN_TOOLS.filter((t) => t.pending) },
    artifacts: { items: OUTPUT_FILES, note: '产物会随会话保存，也可发布到资料库或直接下载。' },
  };
}

function citationDetail(id: string): Dict {
  const num = Number(id.replace(/\D/g, '')) || 1;
  const citation = CITATIONS[num] ?? CITATIONS[1];
  return {
    id: `cit-${num}`,
    title: citation.title,
    source: citation.source,
    locator: citation.locator,
    snippet: citation.code,
    code: citation.code,
    score: citation.score,
    confidence: Number(citation.score),
    version: 'v2.3',
  };
}

/** 模拟 Agent Gateway 的完整轨迹：routing → plan → text → tool_call → citation → conclusion → artifact → done。 */
function messageTurn(content: string): Dict {
  const stamp = new Date().toISOString();
  const base = `m-${Date.now()}`;
  const cards: Dict[] = [
    {
      id: `${base}-u`,
      conversationId: 'c-gmv',
      kind: 'bubble',
      payload: { content, chips: [] },
      createdAt: stamp,
      actor: 'user',
    },
    {
      id: `${base}-plan`,
      conversationId: 'c-gmv',
      kind: 'plan',
      payload: {
        intent: 'general',
        steps: [
          { goal: '识别意图并挂载资产', durationMs: 120 },
          { goal: '检索已挂载资产', durationMs: 310 },
          { goal: '汇总结论与证据链', durationMs: 180 },
        ],
      },
      createdAt: stamp,
      actor: 'agent',
    },
    {
      id: `${base}-text`,
      conversationId: 'c-gmv',
      kind: 'text',
      payload: { content: '已收到。正在检索已挂载资产并整理上下文，随后给出结论。' },
      createdAt: stamp,
      actor: 'agent',
    },
    {
      id: `${base}-tool`,
      conversationId: 'c-gmv',
      kind: 'tool_row',
      payload: {
        name: 'kb_search + pg_sql_query',
        status: '已自动放行',
        durationMs: 600,
        args: JSON.stringify({ query: content, assets: ['生产库', '运营知识库'], read_only: true, limit: 1000 }),
        result: '检索命中 3 个片段 · 采样 20 行 · 只读模式：未执行任何写操作',
        auditId: `aud-${Date.now()}`,
      },
      createdAt: stamp,
      actor: 'agent',
    },
    {
      id: `${base}-suggestion`,
      conversationId: 'c-gmv',
      kind: 'suggestion',
      payload: {
        command: 'truncate',
        executable: false,
        decision: 'suggest',
        reason: '只读模式下 Agent 写操作转为生成建议',
        auditId: `aud-${Date.now()}-s`,
      },
      createdAt: stamp,
      actor: 'agent',
    },
    {
      id: `${base}-conclusion`,
      conversationId: 'c-gmv',
      kind: 'conclusion',
      payload: {
        confidence: '0.86',
        citationIds: ['cit-1', 'cit-2'],
        paras: [
          [
            { t: 'text', v: '已完成分析：' },
            { t: 'strong', v: content },
            { t: 'text', v: '。本次仅使用只读检索，未对生产环境产生任何写操作。' },
            { t: 'cite', id: 1 },
            { t: 'cite', id: 2 },
          ],
        ],
      },
      createdAt: stamp,
      actor: 'agent',
    },
    {
      id: `${base}-artifact`,
      conversationId: 'c-gmv',
      kind: 'artifact',
      payload: {
        name: 'GMV 趋势图',
        meta: 'gmv_trend.png · 1280×720',
        desc: '按周聚合的 GMV 趋势，标注口径变更点。',
        /* 演示用量：按内容体量粗估（与服务端估算口径一致），promptTokens 无真值如实 null。 */
        usage: {
          promptTokens: null,
          completionTokens: Math.max(1, Math.ceil((content.length + 120) / 1.5)),
          totalTokens: Math.max(1, Math.ceil((content.length + 120) / 1.5)),
          costCny: 0,
          model: 'Claude-Sonnet（mock）',
        } satisfies TurnUsage,
      },
      createdAt: stamp,
      actor: 'agent',
    },
  ];
  return {
    messages: cards,
    citations: [citationDetail('cit-1'), citationDetail('cit-2')],
    artifacts: OUTPUT_FILES.map((f) => ({ id: f.name, name: f.name, sizeBytes: 131072, fileName: f.name })),
    panels: panelsShape(),
    statusBar: statusBarShape(),
    intent: 'general',
    gateway: 'mock',
  };
}

function terminalResult(command: string): Dict {
  const lower = command.toLowerCase();
  const denied = COMMAND_BLACKLIST.find((rule) => lower.includes(rule.pattern));
  if (denied) {
    return {
      executed: false,
      decision: 'deny',
      reasonCode: 'E_BLACKLIST_HIT',
      command,
      stdout: `✕ 已拦截：危险命令（${denied.label} 命中黑名单）· 未发送到远端`,
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      spawnCount: 0,
      degraded: false,
      dispatcher: 'kernel:deny',
      cwd: 'sandbox/terminal',
      auditId: `aud-term-${Date.now()}`,
    };
  }
  const allowed = COMMAND_WHITELIST.find((rule) => lower.startsWith(rule.prefix));
  if (!allowed) {
    return {
      executed: false,
      decision: 'deny',
      reasonCode: 'E_NOT_WHITELISTED',
      command,
      stdout: '✕ 已拦截：命令不在白名单（42 条）· 未发送到远端',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
      spawnCount: 0,
      degraded: false,
      dispatcher: 'kernel:deny',
      cwd: 'sandbox/terminal',
      auditId: `aud-term-${Date.now()}`,
    };
  }
  return {
    executed: true,
    decision: 'allow',
    command,
    stdout: allowed.output.map((line) => line.text).join('\n'),
    stderr: '',
    exitCode: 0,
    durationMs: 42,
    spawnCount: 0,
    degraded: false,
    dispatcher: 'node:builtin',
    cwd: 'sandbox/terminal',
    auditId: `aud-term-${Date.now()}`,
  };
}

function sqlResult(sql: string): Dict {
  return {
    columns: SQL_RESULT_COLUMNS,
    rows: SQL_RESULT_ROWS,
    rowCount: 1283,
    durationMs: 42,
    statusText: '执行成功 · 1,283 行 · 42ms · 已自动追加 LIMIT 1000',
    guard: { injected: !/\bLIMIT\b/i.test(sql), appliedLimit: 1000, notice: '生产环境 · 只读执行 · 已自动追加 LIMIT 1000' },
    dbChecksumBefore: 'sha256:mock',
    dbChecksumAfter: 'sha256:mock',
  };
}

function tableRows(table: string): Dict {
  const meta = DB_TABLES_BROWSE.find((t) => t.name === table) ?? DB_TABLES_BROWSE[0];
  return {
    columns: BROWSE_COLUMNS,
    rows: BROWSE_ROWS,
    page: 1,
    totalPages: 1205,
    totalRows: 1204331,
    tableLabel: `${meta.group}.${table}`,
  };
}

function settingsShape(): Dict {
  return {
    sections: SETTINGS_SECTIONS.map((s) => ({
      id: s.id,
      label: s.label,
      title: s.title,
      desc: s.desc,
      rows: s.rows.map((r) => ({ id: r.id, name: r.name, desc: r.desc, control: r.control, impact: r.impact ?? null })),
    })),
    raw: { 'perm.readOnlyMode': true },
  };
}

function orgAuditShape(): Dict {
  return {
    items: ORG_AUDIT.map((row, index) => ({
      id: `aud-${index}`,
      createdAt: new Date().toISOString(),
      createdAtLabel: row.time,
      actor: row.actor,
      source: row.actor === 'Agent' ? 'agent' : 'user',
      action: row.action,
      target: row.target,
      result: row.result,
      severity: row.result === '拦截' ? 'warn' : 'info',
      detail: `${row.category} · ${row.time}`,
      category: row.category,
    })),
    total: ORG_AUDIT.length,
  };
}

/**
 * 资产 ID → 资产类型。
 * 真实库里类型存在 asset.type；mock 里没有这张表，就从侧栏数据的 go 字段反查
 * （go 的取值与类型一一对应：code / db / server / kb）。
 */
function assetGoOf(assetId: string): AssetGo | null {
  for (const project of PROJECTS) {
    for (const folder of project.sidebar.assetFolders) {
      const hit = folder.items.find((item) => item.id === assetId);
      if (hit) return hit.go ?? null;
    }
    const loose = project.sidebar.looseAssets.find((item) => item.id === assetId);
    if (loose) return loose.go ?? null;
  }
  return null;
}

/**
 * 能力集合按资产类型分流。
 *
 * 早期实现把 server / db / code 三套能力合并返回，结果任何资产的抽屉都列出
 * 13 项开关 —— 与真实库「asset_capability 按 asset_id 分行」的语义不符，
 * 用户会以为这个资产有十三个能力。mock 必须与真实库同口径。
 */
function capsForAsset(assetId: string): CapItem[] {
  const go = assetGoOf(assetId);
  if (go === 'server') return CAPS_SERVER;
  if (go === 'db') return CAPS_DB;
  if (go === 'code') return CAPS_CODE;
  return [];
}

/** mock 资产详情：按类型给出与真实 REST 同形状的切片（label/value/sub、k/v、granted/locked）。 */
function assetDetailShape(assetId: string): Dict {
  const go = assetGoOf(assetId) ?? 'server';
  const metrics =
    go === 'db' ? DB_METRICS : go === 'code' ? CODE_METRICS : go === 'kb' ? [] : SERVER_METRICS;
  const kv =
    go === 'db'
      ? DB_CONN_KV
      : go === 'code'
        ? CODE_REPO_KV
        : go === 'kb'
          ? []
          : SERVER_CONN_KV;
  const activity =
    go === 'db' ? DB_ACTIVITY_KV : go === 'code' ? CODE_ACTIVITY_KV : go === 'kb' ? [] : SERVER_ACTIVITY_KV;
  const tabs =
    go === 'db' ? ['SQL 查询', '数据浏览'] : go === 'code' ? ['编辑器'] : go === 'kb' ? ['文档', '检索'] : ['终端'];
  return {
    ...workspaceShape('w-ops'),
    id: assetId,
    type: go,
    status: 'ok',
    subtitle: go === 'server' ? 'SSH · deploy@10.20.1.31 · /opt/app' : '离线兜底 · 未连接后端',
    pills: [{ tone: 'ok', text: '在线' }, { tone: 'ro', text: '只读' }],
    tabs,
    metrics: metrics.map((m) => ({ label: m.k, value: m.v, sub: m.s })),
    kv: kv.map((row) => ({ k: row.k, v: row.v })),
    activities: activity.map((row, i) => ({
      id: `act-${assetId}-${i}`,
      createdAtLabel: row.k,
      text: row.v,
    })),
    capabilities: capsForAsset(assetId).map((c, i) => ({
      id: `cap-${assetId}-${i}`,
      name: c.name,
      description: c.desc,
      granted: c.on,
      locked: !!c.lock,
    })),
    statusBar: statusBarShape(),
  };
}

function parsePath(path: string): { clean: string; query: URLSearchParams } {
  const [raw, qs = ''] = path.split('?');
  return { clean: raw.replace(/\/+$/, ''), query: new URLSearchParams(qs) };
}

/**
 * 按 REST 路径分派 mock 响应。
 * 仅当网络层失败 / 超时 / 5xx 时由 request() 调用；后端合法 4xx 包络不会走到这里。
 */
export function mockFallthrough<T>(method: HttpMethod, path: string, body?: unknown): ApiEnvelope<T> {
  const { clean, query } = parsePath(path);
  const payload = (body ?? {}) as Dict;
  const data = (value: unknown): ApiEnvelope<T> => mockOk<T>(value as T);
  const fail = (code: string, message: string): ApiEnvelope<T> => mockFail<T>(code, message);

  if (clean === '/health') {
    return data({ status: 'ok', driver: 'node:sqlite', wal: true, version: '0.4.2-mock', time: new Date().toISOString() });
  }
  if (clean === '/bootstrap') {
    const id = query.get('workspaceId') ?? 'w-ops';
    return data({
      workspaceId: id,
      workspaceName: projectById(id).name,
      apiMode: 'mock',
      readOnlyMode: true,
    });
  }
  if (clean === '/workspaces' && method === 'GET') return data(PROJECTS.map((p) => workspaceShape(p.id)));
  if (clean === '/workspaces' && method === 'POST') {
    const name = String(payload.name ?? '新项目');
    return data(workspaceShape('w-new'));
  }
  if (/^\/workspaces\/[^/]+\/switch$/.test(clean) && method === 'POST') {
    const id = clean.split('/')[2];
    return data({
      workspaceId: id,
      workspaceName: projectById(id).name,
      sidebar: sidebarShape(id),
      ...panelsShape(),
      statusBar: statusBarShape(),
    });
  }
  if (/^\/workspaces\/[^/]+$/.test(clean)) return data(workspaceShape(clean.split('/')[2]));
  if (clean === '/sidebar') return data(sidebarShape(query.get('workspaceId') ?? 'w-ops'));
  if (clean === '/status-bar') return data(statusBarShape());
  if (clean === '/folders' && method === 'GET') return data([]);
  if (clean === '/folders' && method === 'POST') return data({ id: 'f-new', ...payload });
  if (clean === '/folders/reorder') return data({ ok: true });
  if (clean === '/items/move') return data({ ok: true });
  if (clean === '/assets' && method === 'GET') return data([]);
  if (clean === '/assets' && method === 'POST') return data({ id: 'a-new', ...payload });
  if (/^\/assets\/[^/]+\/activities$/.test(clean)) {
    return data([...SERVER_ACTIVITY_KV, ...DB_ACTIVITY_KV, ...CODE_ACTIVITY_KV].map((r, i) => ({
      id: `act-${i}`, createdAt: new Date().toISOString(), createdAtLabel: r.k, text: r.v,
    })));
  }
  if (/^\/assets\/[^/]+\/capabilities$/.test(clean)) {
    const assetId = clean.split('/')[2];
    return data(capsForAsset(assetId).map((c, i) => ({
      id: `cap-${assetId}-${i}`, name: c.name, description: c.desc, granted: c.on, locked: !!c.lock,
    })));
  }
  if (/^\/assets\/[^/]+\/search$/.test(clean)) return data([]);
  if (/^\/assets\/[^/]+\/credential/.test(clean)) {
    return data({ assetId: 'a-order-db-prod', state: 'unbound', label: '' });
  }
  if (/^\/assets\/[^/]+\/index\/progress$/.test(clean)) return data({ indexProgress: 62, status: 'indexing' });
  if (/^\/assets\/[^/]+$/.test(clean) && method === 'DELETE') return data({ deleted: true });
  if (/^\/assets\/[^/]+$/.test(clean)) {
    return data(assetDetailShape(clean.split('/')[2]));
  }

  if (clean === '/conversations' && method === 'GET') {
    /* archived=1：归档管理页离线兜底 —— 给一条样例归档会话，页面结构可跑通。 */
    if (query.get('archived') === '1') {
      return data([{
        id: 'c-archived-mock',
        workspaceId: query.get('workspaceId') ?? 'w-ops',
        title: '磁盘告警复盘（归档样例）',
        folderId: null,
        assetId: null,
        assetType: null,
        createdAt: '2026-11-10T09:30:00.000Z',
        archivedAt: '2026-11-12T08:00:00.000Z',
      }]);
    }
    return data([]);
  }
  if (clean === '/conversations' && method === 'POST') return data({ id: 'c-new', ...payload });
  if (/^\/conversations\/[^/]+\/messages$/.test(clean) && method === 'POST') {
    return data(messageTurn(String(payload.content ?? '')));
  }
  /* 消息时间线截断兜底：离线没有服务端库可截，如实报 0 条，前端仍做本地截断。 */
  if (/^\/conversations\/[^/]+\/messages\/truncate$/.test(clean) && method === 'POST') {
    return data({ deleted: 0, mode: String(payload.mode ?? 'inclusive'), artifacts: 0, files: 0, citations: 0, toolCalls: 0 });
  }
  if (/^\/conversations\/[^/]+\/messages$/.test(clean)) return data([]);
  if (/^\/conversations\/[^/]+\/export$/.test(clean)) return data({ content: '会话导出（mock）', fileName: 'devwork-chat.txt' });
  if (/^\/conversations\/[^/]+\/citations$/.test(clean)) return data([citationDetail('cit-1'), citationDetail('cit-2')]);
  if (/^\/conversations\/[^/]+\/context$/.test(clean)) return data(panelsShape().context);
  if (/^\/conversations\/[^/]+\/execution$/.test(clean)) return data(panelsShape().execution);
  if (/^\/conversations\/[^/]+\/artifacts$/.test(clean)) return data(panelsShape().artifacts);
  if (/^\/conversations\/[^/]+\/usage$/.test(clean)) return data(statusBarShape());
  /* 上下文用量明细（输入框小按钮）：离线时给一份结构正确的估算，
   * 不假装是真实预算 —— 提示文案由 UI 的「离线」状态兜住。 */
  if (/^\/conversations\/[^/]+\/context-usage$/.test(clean)) {
    const used = 32000;
    const budget = 128000;
    return data({
      used, budget, ratio: used / budget, autoCompactAt: 0.8,
      state: 'ok', windowSource: 'default', model: '未接入模型',
      breakdown: [
        { name: '系统与工具', tokens: 1520 },
        { name: '历史对话', tokens: used - 1520 },
      ],
      messages: { total: 6, inWindow: 6, folded: 0 },
      summary: null,
      shouldCompact: false,
    });
  }
  if (/^\/conversations\/[^/]+\/compact$/.test(clean)) {
    return data({ skipped: true, reason: '离线 Mock：没有真实会话上下文可压缩', before: 0, after: 0, freed: 0, covered: 0 });
  }
  /* B21：会话重命名 / 删除 / 归档的离线兜底（与后端语义一致）。 */
  if (/^\/conversations\/[^/]+$/.test(clean) && method === 'DELETE') return data({ deleted: true });
  if (/^\/conversations\/[^/]+$/.test(clean) && method === 'PATCH') {
    return data({
      id: clean.split('/')[2],
      title: String(payload.title ?? 'GMV 归因'),
      /* 归档回显：true 记当前时间，false 清空 —— 与服务端 archived_at 语义对齐。 */
      archivedAt: payload.archived === true ? new Date().toISOString() : null,
    });
  }
  if (/^\/conversations\/[^/]+$/.test(clean)) return data({ id: clean.split('/')[2], title: 'GMV 归因' });
  if (/^\/citations\/[^/]+$/.test(clean)) return data(citationDetail(clean.split('/')[2]));
  if (/^\/approvals\/[^/]+$/.test(clean)) return data({ id: clean.split('/')[2], decision: payload.decision ?? 'suggest' });
  if (clean === '/command-suggestions') return data({ id: 'sug-1', command: payload.command ?? '', executable: false, auditId: 'aud-sug' });
  if (/^\/artifacts\/[^/]+\/download$/.test(clean)) return data({ url: '/api/artifacts/mock', fileName: 'gmv_trend.png', sizeBytes: 131072 });
  /* 产物预览（右栏「文件」Tab）：与服务端 /artifacts/:id/preview 同构 ——
   * 文本给内容、图片给 URL、二进制只给元信息。mock 产物 id（art-seed-*）映射回真实
   * 文件名，否则离线演示时文件预览只会显示「产物不存在」。 */
  if (/^\/artifacts\/[^/]+\/preview$/.test(clean)) {
    const id = decodeURIComponent(clean.split('/')[2]);
    const row = OUTPUT_FILES.find((f) => f.id === id || f.name === id);
    const fileName = row?.name ?? id;
    const inlineUrl = `/api/artifacts/file/${encodeURIComponent(fileName)}?inline=1`;
    if (/\.png$/i.test(fileName)) {
      return data({ fileName, sizeBytes: 131072, mime: 'image/png', kind: 'image', url: inlineUrl });
    }
    if (/\.docx$/i.test(fileName)) {
      return data({ fileName, sizeBytes: 88064, mime: 'application/octet-stream', kind: 'binary', url: inlineUrl });
    }
    if (/\.(md|markdown|txt|json|csv|tsv|log|ya?ml|xml|html?|js|ts|tsx|jsx|py|java|go|sql|sh)$/i.test(fileName)) {
      return data({ fileName, sizeBytes: 128, mime: 'text/plain;charset=utf-8', kind: 'text', content: `（mock）${fileName} 的文本内容。`, url: inlineUrl });
    }
    return data({ fileName, sizeBytes: 0, mime: 'application/octet-stream', kind: 'binary', url: inlineUrl });
  }

  if (/^\/assets\/[^/]+\/terminal\/sessions$/.test(clean)) {
    return data([{ id: 'sess-1', assetId: 'a-order-api', cwd: 'sandbox/terminal', createdAt: new Date().toISOString() }]);
  }
  if (/^\/assets\/[^/]+\/terminal\/execute$/.test(clean)) return data(terminalResult(String(payload.command ?? '')));
  if (/^\/assets\/[^/]+\/terminal\/history$/.test(clean)) return data([]);
  if (clean === '/commands/whitelist') return data(COMMAND_WHITELIST.map((w, i) => ({ id: `w-${i}`, pattern: w.prefix, description: '只读白名单' })));
  if (clean === '/commands/blacklist') return data(COMMAND_BLACKLIST.map((b, i) => ({ id: `b-${i}`, pattern: b.pattern, description: b.label })));
  /* 技能登记表（离线兜底）：与服务端 registry 保持一致，由 tests/skills.mjs 校验不漂移。 */
  if (clean === '/skills') return data(MOCK_SKILLS);

  if (/^\/assets\/[^/]+\/sql\/query$/.test(clean)) {
    const sql = String(payload.sql ?? '');
    const statement = sql.trim();
    /* 离线降级态与服务端 SqlGuard 保持同口径：空语句 / 危险关键字（含引号、
     * 注释内）/ 多语句 / 首关键字非 SELECT|WITH|EXPLAIN 一律拒绝，避免断后端时
     * 出现「服务端拒绝、mock 却放行」的语义落差（QA 指出的降级态规则弱问题）。 */
    const cleaned = statement
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/--[^\n]*/g, ' ')
      .trim()
      .replace(/;+\s*$/, '')
      .trim();
    const firstWord = (cleaned.match(/^\s*([A-Za-z]+)/)?.[1] ?? '').toUpperCase();
    const forbidden = /\b(DROP|INSERT|UPDATE|DELETE|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|load_extension|BEGIN|COMMIT|ROLLBACK|GRANT|REVOKE|MERGE|EXEC)\b/i;
    if (
      statement === ''
      || forbidden.test(statement.toUpperCase())
      || /;/.test(cleaned)
      || !['SELECT', 'WITH', 'EXPLAIN'].includes(firstWord)
    ) {
      return fail('E_SQL_REJECTED', '只读执行：禁止 DML / DDL / 多语句，未发送到数据库');
    }
    return data(sqlResult(sql));
  }
  if (/^\/assets\/[^/]+\/sql\/schema$/.test(clean)) {
    return data({
      tables: DB_TABLES_SQL.map((t) => ({ name: t.name, schema: t.group, rowsLabel: t.rows, kind: 'table' as const, totalRows: 8 })),
      indexes: [],
      schemas: ['public'],
    });
  }
  if (/^\/assets\/[^/]+\/sql\/tables\/[^/]+\/structure$/.test(clean)) {
    return data({ columns: BROWSE_STRUCTURE.map((r) => ({ name: r[0], type: r[1], nullable: r[2] === 'NULL', note: r[3], defaultValue: null, primaryKey: r[0] === 'id' })), indexes: BROWSE_INDEXES, foreignKeys: BROWSE_FKS });
  }
  if (/^\/assets\/[^/]+\/sql\/tables\/[^/]+\/fields$/.test(clean)) {
    return data({
      columns: BROWSE_STRUCTURE.map((r) => ({ name: r[0], type: r[1], nullable: r[2] === 'NULL', note: r[3], defaultValue: null, primaryKey: r[0] === 'id' })),
      indexes: BROWSE_INDEXES,
      foreignKeys: BROWSE_FKS,
    });
  }
  if (/^\/assets\/[^/]+\/sql\/tables\/[^/]+\/ddl$/.test(clean)) {
    return data({ name: 'order', sql: '-- 离线降级：无真实 DDL 可读', indexes: [] });
  }
  if (/^\/assets\/[^/]+\/sql\/tables\/[^/]+\/rows$/.test(clean)) {
    return data(tableRows(decodeURIComponent(clean.split('/')[5] ?? 'order')));
  }
  if (/^\/assets\/[^/]+\/sql\/export$/.test(clean)) {
    return data({ content: [SQL_RESULT_COLUMNS.join(','), ...SQL_RESULT_ROWS.map((r) => r.join(','))].join('\n'), fileName: 'query_result.csv', mime: 'text/csv;charset=utf-8', format: 'csv', auditId: 'aud-sql' });
  }

  if (/^\/assets\/[^/]+\/files\/tree$/.test(clean)) {
    return data(CODE_TREE.map((n) => ({ name: n.label, path: n.path ?? n.label, depth: n.depth, caret: n.caret, isFile: !!n.path })));
  }
  if (/^\/assets\/[^/]+\/files\/content$/.test(clean)) {
    const file = CODE_FILES.find((f) => f.path === query.get('path')) ?? CODE_FILES[0];
    return data({ path: file.path, html: file.html, plain: file.html.replace(/<[^>]+>/g, ''), gutterStart: file.gutterStart, language: file.lang });
  }
  if (/^\/assets\/[^/]+\/files\/outline$/.test(clean)) {
    return data({
      symbols: CODE_FILES[0].symbols.map((s) => ({ ...s, line: 1 })),
      references: ['离线模式 · 引用计数不可用'],
      git: ['离线模式 · git 不可用'],
    });
  }
  if (/^\/assets\/[^/]+\/files\/save$/.test(clean)) {
    return data({ path: String(payload.path ?? ''), bytesWritten: String(payload.content ?? '').length, diskChanged: true, auditId: 'aud-save' });
  }
  if (/^\/assets\/[^/]+\/files\/agent-write$/.test(clean)) {
    return data({ decision: 'deny', bytesWritten: 0, diskChanged: false, suggestion: 'Agent 写操作被拦截，已生成 patch 建议（磁盘零变更）', auditId: 'aud-agent-write' });
  }
  if (/^\/assets\/[^/]+\/files\/patch$/.test(clean)) return data({ patch: '--- a/file\n+++ b/file\n', applicable: false });
  if (/^\/assets\/[^/]+\/files\/git$/.test(clean)) return data({ branch: 'feature/order-retry', lastCommit: 'a3f21c9', log: 'a3f21c9 · 增加订单重试逻辑' });
  /* B19：离线回落静态 diff / Key 状态如实报 none；离线写入一律「不落盘」诚实降级。 */
  if (/^\/assets\/[^/]+\/files\/diff$/.test(clean)) return data({ diff: CODE_DIFF, clean: false });
  if (clean === '/settings/llm-key') {
    return method === 'POST'
      ? data({ stored: false, mode: 'none' as const, source: 'none' as const })
      : data({ configured: false, source: 'none' as const });
  }
  /* 模型档案：断后端时也能增删改查，离线开发的设置页不至于空白一片。 */
  if (clean === '/settings/llm-config' && method === 'GET') return data(mockLlmConfigShape());
  if (clean === '/settings/llm-config' && method === 'PUT') {
    const provider = String(payload.provider ?? 'custom');
    const preset = MOCK_LLM_PRESETS.find((p) => p.id === provider);
    const baseUrl = String(payload.baseUrl ?? '').trim() || preset?.baseUrl || '';
    const model = String(payload.model ?? '').trim();
    if (baseUrl && model) {
      const id = mockLlmActiveId || 'mock-1';
      const next = mockLlmProfiles.filter((p) => p.id !== id);
      next.push({
        id, label: String(payload.label ?? model).trim() || model, provider,
        baseUrl, model, local: preset?.local === true,
      });
      mockLlmProfiles = next;
      mockLlmActiveId = id;
    }
    return data(mockLlmConfigShape());
  }
  if (clean === '/settings/llm-config/test') {
    return data({ ok: false, latencyMs: 0, model: String(payload.model ?? ''), message: '离线 Mock 模式无法测试连通性（后端不可达）' });
  }
  if (clean === '/settings/llm-models' && method === 'POST') {
    /* 离线拉不了端点列表：回落该预设的静态推荐，前端如实标注「可能过时」。 */
    const preset = MOCK_LLM_PRESETS.find((p) => p.id === String(payload.provider ?? ''));
    return data({ models: preset?.models ?? [], source: 'fallback', message: '离线 Mock 模式无法从端点实拉模型列表，显示预设推荐（可能过时）' });
  }
  if (clean === '/settings/llm-profiles' && method === 'POST') {
    const provider = String(payload.provider ?? 'custom');
    const preset = MOCK_LLM_PRESETS.find((p) => p.id === provider);
    const baseUrl = String(payload.baseUrl ?? '').trim() || preset?.baseUrl || '';
    const model = String(payload.model ?? '').trim();
    if (baseUrl && model) {
      const id = `mock-${mockLlmProfiles.length + 1}`;
      mockLlmProfiles = [...mockLlmProfiles, {
        id, label: String(payload.label ?? model).trim() || model, provider,
        baseUrl, model, local: preset?.local === true,
      }];
      if (mockLlmProfiles.length === 1) mockLlmActiveId = id;
    }
    return data(mockLlmConfigShape());
  }
  const profileMatch = /^\/settings\/llm-profiles\/([^/]+)(\/activate)?$/.exec(clean);
  if (profileMatch) {
    const id = profileMatch[1];
    if (profileMatch[2] === '/activate') {
      if (mockLlmProfiles.some((p) => p.id === id)) mockLlmActiveId = id;
      return data(mockLlmConfigShape());
    }
    if (method === 'PATCH') {
      mockLlmProfiles = mockLlmProfiles.map((p) => (p.id === id
        ? {
          ...p,
          label: String(payload.label ?? p.label).trim() || p.label,
          baseUrl: String(payload.baseUrl ?? p.baseUrl).trim() || p.baseUrl,
          model: String(payload.model ?? p.model).trim() || p.model,
        }
        : p));
      return data(mockLlmConfigShape());
    }
    if (method === 'DELETE') {
      mockLlmProfiles = mockLlmProfiles.filter((p) => p.id !== id);
      if (mockLlmActiveId === id) mockLlmActiveId = mockLlmProfiles[0]?.id ?? '';
      return data(mockLlmConfigShape());
    }
  }
  if (clean === '/sensitive-rules') return data(Array.from({ length: 12 }, (_, i) => ({ id: `sr-${i}`, pattern: ['.env*', '*.pem', 'id_rsa*', '*.key', 'secrets/**'][i % 5], description: '敏感文件排除' })));
  /* 派生工具面必须实算（资产×能力×信任级别），离线没有这个能力就如实说没有 ——
   * 返回空对象会让前端把 undefined 当数组用，崩在渲染里。 */
  if (clean === '/tools') return fail('E_NOT_FOUND', '离线 Mock 模式不提供派生工具面（需连接后端实算）');

  if (clean === '/settings') return data(settingsShape());
  if (clean === '/settings/permission-probe') {
    const actor = String(payload.actor ?? 'user');
    const action = String(payload.action ?? 'read');
    const writeAction = /write|ddl|restart|patch|exec\.write/i.test(action);
    const decision = actor === 'user' ? 'allow' : writeAction ? 'suggest' : 'allow';
    return data({ decision, reason: actor === 'user' ? '用户手动操作放行' : 'Agent 写操作转建议', auditId: 'aud-probe', readOnlyMode: true });
  }
  if (/^\/settings\//.test(clean)) return data(settingsShape());
  if (clean === '/effective-policy') return data({ readOnlyMode: true, orgForceReadOnly: true, workspaceTrust: 'prod', source: 'org' });
  if (clean === '/audit/export') {
    return data({ content: '时间,操作人,动作,对象,结果\n' + ORG_AUDIT.map((r) => [r.time, r.actor, r.action, r.target, r.result].join(',')).join('\n'), fileName: 'devwork-audit.csv', auditId: 'aud-export' });
  }
  if (clean === '/audit') return data(orgAuditShape());
  if (/^\/audit\/[^/]+$/.test(clean)) return data(orgAuditShape().items);

  return data({ ok: true, method, path: clean } as Dict);
}

/** 终端初始历史（供 ServerDetail 在离线态保持与原型一致）。 */
export const TERMINAL_INITIAL_LINES = TERMINAL_INITIAL;
export const DB_METRIC_CARDS = { server: SERVER_METRICS, db: DB_METRICS, code: CODE_METRICS };

/**
 * 离线 fallback 快照：唯一把 src/data/mock.ts 业务常量暴露给渲染层的地方。
 * live 时由 LiveDataProvider 用 api.*() 的 REST 结果整体覆盖；组件只消费
 * useLiveData()，不直接 import 任何 mock 常量。
 */
export const MOCK_SNAPSHOT: ViewSnapshot = {
  PROJECTS,
  ASSET_PICKER,
  CHAT_CHIP_LINKS,
  CITATIONS,
  INITIAL_THREADS,
  CTX_MOUNTED,
  CTX_HITS,
  CTX_BARS,
  RUN_TOOLS,
  RUN_BARS,
  OUTPUT_FILES,
  SERVER_METRICS,
  SERVER_CONN_KV,
  SERVER_ACTIVITY_KV,
  CAPS_SERVER,
  TERMINAL_INITIAL,
  TERMINAL_HISTORY,
  COMMAND_BLACKLIST,
  COMMAND_WHITELIST,
  DB_METRICS,
  DB_CONN_KV,
  DB_ACTIVITY_KV,
  CAPS_DB,
  DB_TABLES_SQL,
  DB_TABLES_BROWSE,
  DEFAULT_SQL_TEXT,
  SQL_HIGHLIGHTED,
  SQL_RESULT_COLUMNS,
  SQL_RESULT_ROWS,
  BROWSE_COLUMNS,
  BROWSE_ROWS,
  BROWSE_INDEXES,
  BROWSE_FKS,
  BROWSE_STRUCTURE,
  CODE_METRICS,
  CODE_REPO_KV,
  CODE_ACTIVITY_KV,
  CAPS_CODE,
  CODE_FILES,
  CODE_TREE,
  CODE_DIFF,
  CODE_PATCH,
  SETTINGS_SECTIONS,
  ORG_AUDIT,
  SHORTCUTS,
  highlightSql,
};
