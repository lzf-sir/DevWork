/**
 * LiveDataProvider —— 前端业务数据的唯一装配点。
 *
 * 所有可变业务数据（审计 / 设置 / 凭据 / 能力 / 上下文 / 产物 /
 * SQL 结果 / 表结构 / 文件树 / 白黑名单 / 引用）统一通过
 * src/api/client.ts 的 api.*() 从 REST 拉取；单个接口失败时保留该切片的
 * 离线 fallback，不影响整页渲染。组件只通过 useLiveData() 消费，不再 import
 * 任何静态业务常量。
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './client';
import { useStore } from '../store';
import { MOCK_SNAPSHOT } from './mock';
import { baseSnapshot } from './empty';
import { sqlColumnNames, sqlRows } from './adapters';
import type { ViewSnapshot } from './snapshot';
import type { ApiEnvelope, Dict } from './types';

/** 启动装配用的合法 SQLite 只读查询：原型 SQL 含 now()/interval（PG 语法），
 * demo.sqlite 会返回 422，故用等价的只读采样查询拉取真实列与行。 */
const SNAPSHOT_SQL = 'SELECT id, user_id, status, amount, channel, remark, created_at FROM "order" LIMIT 8';

interface LiveContextValue {
  data: ViewSnapshot;
  /** 写操作后重新拉取全部 REST 切片。 */
  refresh: () => void;
  /** 每次成功刷新自增，供需要强制重渲染的视图使用。 */
  version: number;
}

const LiveContext = createContext<LiveContextValue>({
  data: baseSnapshot(),
  refresh: () => undefined,
  version: 0,
});

/** 单个 REST 切片的安全读取：网络失败 / 4xx / 5xx 一律返回 null。 */
async function safe<T>(promise: Promise<ApiEnvelope<T>>): Promise<T | null> {
  try {
    const envelope = await promise;
    return envelope.ok ? envelope.data : null;
  } catch {
    return null;
  }
}

function rows<T = Dict>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function field(item: unknown, key: string, fallback = ''): string {
  if (!item || typeof item !== 'object') return fallback;
  const value = (item as Dict)[key];
  return value === null || value === undefined ? fallback : String(value);
}

function objectOf(value: unknown): Dict {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : {};
}

/**
 * 扩展名 → 语言标签。
 *
 * 代码视图按扩展名标注语言。打包态用户接入的是任意仓库，
 * 这里给常见扩展名一个可读标签，其余按大写扩展名兜底。
 */
const LANG_BY_EXT: Record<string, string> = {
  java: 'Java', js: 'JavaScript', jsx: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', c: 'C', h: 'C', cpp: 'C++', hpp: 'C++',
  cs: 'C#', php: 'PHP', swift: 'Swift', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala',
  sh: 'Shell', bash: 'Shell', sql: 'SQL', json: 'JSON', yaml: 'YAML', yml: 'YAML',
  toml: 'TOML', xml: 'XML', html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
  md: 'Markdown', vue: 'Vue', dart: 'Dart', lua: 'Lua', pl: 'Perl', r: 'R',
};

/** 把 REST 响应安全地赋给快照切片（形状不同时以 unknown 中转，避免 any 泄漏）。 */
function assign<K extends keyof ViewSnapshot>(next: ViewSnapshot, key: K, value: unknown): void {
  if (value === null || value === undefined) return;
  next[key] = value as ViewSnapshot[K];
}

function metricCards(detail: unknown): Array<{ k: string; v: string; s: string }> {
  return rows<Dict>(objectOf(detail).metrics).map((m) => ({
    k: field(m, 'label'), v: field(m, 'value'), s: field(m, 'sub'),
  }));
}

function kvRows(detail: unknown, fallbackLabel: string): Array<{ k: string; v: string }> {
  const list = rows<Dict>(objectOf(detail).kv);
  return list.length > 0
    ? list.map((r) => ({ k: field(r, 'k'), v: field(r, 'v') }))
    : [{ k: fallbackLabel, v: '—' }];
}

function capItems(value: unknown): Array<{ id?: string; name: string; desc: string; on: boolean; lock?: boolean; lockHint?: string }> {
  return rows<Dict>(value).map((c) => ({
    id: typeof c.id === 'string' ? c.id : undefined,
    name: field(c, 'name'),
    desc: field(c, 'description'),
    on: c.granted === true,
    lock: c.locked === true,
    lockHint: c.locked === true ? '组织级能力，需管理员在策略页调整。' : undefined,
  }));
}

function activityKv(value: unknown): Array<{ k: string; v: string }> {
  return rows<Dict>(value).slice(0, 6).map((a) => ({
    k: field(a, 'createdAtLabel', '刚刚'), v: field(a, 'text'),
  }));
}

/* ---- 右栏三段 + 引用：抽成纯函数，供「全量装配」与「按会话局部刷新」共用 ---- */

function applyContextPanel(next: ViewSnapshot, ctx: unknown): void {
  const ctxData = objectOf(ctx);
  if (rows(ctxData.mounted).length > 0) {
    assign(next, 'CTX_MOUNTED', rows<Dict>(ctxData.mounted).map((m) => ({
      name: field(m, 'name'), meta: field(m, 'meta'),
      go: (m.go ?? null) as 'code' | 'db' | 'server' | null,
    })));
  }
  if (rows(ctxData.hits).length > 0) {
    assign(next, 'CTX_HITS', rows<Dict>(ctxData.hits).map((h) => ({
      name: field(h, 'name'),
      meta: rows(h.meta).map((v) => String(v)),
    })));
  }
  if (rows(ctxData.bars).length > 0) {
    assign(next, 'CTX_BARS', rows<Dict>(ctxData.bars).map((b) => ({
      name: field(b, 'name'), width: Number(b.width ?? 0), value: field(b, 'value'),
    })));
  }
}

function applyExecutionPanel(next: ViewSnapshot, execution: unknown): void {
  const execData = objectOf(execution);
  if (rows(execData.tools).length > 0) {
    assign(next, 'RUN_TOOLS', rows<Dict>(execData.tools).map((t) => ({
      name: field(t, 'name'),
      meta: rows(t.meta).map((v) => String(v)),
      pending: t.pending === true || field(t, 'name').includes('truncate'),
    })));
    assign(next, 'RUN_BARS', rows<Dict>(execData.timings).map((t) => ({
      name: field(t, 'name'), width: Number(t.width ?? 0), value: field(t, 'value'),
    })));
  }
}

function applyArtifactPanel(next: ViewSnapshot, artifacts: unknown): void {
  const artifactItems = rows<Dict>(objectOf(artifacts).items);
  if (artifactItems.length > 0) {
    assign(next, 'OUTPUT_FILES', artifactItems.map((f) => ({
      /* id：产物下载（/api/artifacts/:id/download）的真实定位。 */
      id: field(f, 'id', field(f, 'name')),
      tag: field(f, 'tag', 'DOC'), name: field(f, 'name'), size: field(f, 'size'),
      bg: field(f, 'bg', '#EAF1FE'), fg: field(f, 'fg', '#2F6FEB'),
    })));
  }
}

function applyCitations(next: ViewSnapshot, citations: unknown): void {
  const citationRows = rows<Dict>(citations);
  if (citationRows.length === 0) return;
  const mapped: Record<number, ViewSnapshot['CITATIONS'][number]> = {};
  citationRows.slice(0, 8).forEach((c, index) => {
    mapped[index + 1] = {
      id: index + 1,
      title: field(c, 'title'),
      source: field(c, 'source'),
      locator: field(c, 'locator'),
      code: field(c, 'snippet', field(c, 'code')),
      score: field(c, 'score', '0.80'),
    };
  });
  assign(next, 'CITATIONS', mapped);
}

/** 只刷新「会话级」数据（右栏三段 + 引用）。切会话时用它，避免 30 个请求全量重拉。 */
async function loadPanels(conversationId: string): Promise<Partial<ViewSnapshot>> {
  const [ctx, execution, artifacts, citations] = await Promise.all([
    safe(api.getContextPanel(conversationId)),
    safe(api.getExecutionPanel(conversationId)),
    safe(api.getArtifactPanel(conversationId)),
    safe(api.listCitations(conversationId)),
  ]);
  const next = {} as ViewSnapshot;
  applyContextPanel(next, ctx);
  applyExecutionPanel(next, execution);
  applyArtifactPanel(next, artifacts);
  applyCitations(next, citations);
  return next as Partial<ViewSnapshot>;
}

/** 从 REST 结果装配一份完整的 ViewSnapshot。 */
async function loadSnapshot(conversationId: string, conversationWorkspaceId: string): Promise<ViewSnapshot> {
  /* 底板：打包态是「结构在、数据空」，开发态是原型快照。
   * 后续每个切片只在拿到真实数据时覆盖对应字段。 */
  const next: ViewSnapshot = { ...baseSnapshot() };

  /**
   * 先解析本次要展示的资产。
   *
   * 原来这里是写死的 a-order-api / a-order-db-prod / a-order-service ——
   * 那是开发期的演示资产 id。打包给用户后，用户接入的资产 id 完全不同，
   * 写死会导致详情面板永远 404（然后被 mock 兜底填上一份假数据）。
   *
   * 现在从真实资产表里按类型各取一个：server → 服务器视图、
   * db → 数据库视图、code → 代码视图。用户没接对应类型就是空，不会串味。
   */
  const assetList = await safe(api.listAssets(conversationWorkspaceId));
  const assets = Array.isArray(assetList) ? assetList as unknown as Dict[] : rows<Dict>(objectOf(assetList).items);
  const pickAsset = (type: string): string => {
    const hit = assets.find((a) => field(a, 'type') === type);
    return hit ? field(hit, 'id') : '';
  };
  const serverId = pickAsset('server');
  const dbId = pickAsset('db');
  const codeId = pickAsset('code');
  /* 没有对应资产时用空串：safe() 会把 404 / 空 id 转成 null，切片保持空态。 */
  const serverKey = serverId || '—';
  const dbKey = dbId || '—';
  const codeKey = codeId || '—';

  /* 文件树要先拿：文件内容的请求路径来自真实文件树，
   * 不能用演示清单里的路径（那是开发期的假仓库文件名）。 */
  const fileTree = await safe(api.getFileTree(codeKey));
  const treeRows = rows<Dict>(fileTree);
  const realFilePaths = treeRows
    .filter((n) => n.isFile === true)
    .map((n) => field(n, 'path'))
    .filter((p) => Boolean(p))
    .slice(0, 6);

  const [
    audit, settings, whitelist, blacklist,
    ctx, execution, artifacts,
    serverAsset, serverActivities, serverCaps,
    dbAsset, dbActivities, dbCaps,
    codeAsset, codeActivities, codeCaps,
    history, sqlSchema, tableRows, tableStructure, sqlResult,
    fileContents, citations,
  ] = await Promise.all([
    safe(api.listAudit({})),
    safe(api.getSettings()),
    safe(api.getCommandWhitelist()),
    safe(api.getCommandBlacklist()),
    safe(api.getContextPanel(conversationId)),
    safe(api.getExecutionPanel(conversationId)),
    safe(api.getArtifactPanel(conversationId)),
    safe(api.getAsset(serverKey)),
    safe(api.getAssetActivities(serverKey)),
    safe(api.listCapabilities(serverKey)),
    safe(api.getAsset(dbKey)),
    safe(api.getAssetActivities(dbKey)),
    safe(api.listCapabilities(dbKey)),
    safe(api.getAsset(codeKey)),
    safe(api.getAssetActivities(codeKey)),
    safe(api.listCapabilities(codeKey)),
    safe(api.getCommandHistory(serverKey, 'sess-1')),
    safe(api.getSqlSchema(dbKey)),
    safe(api.getTableRows(dbKey, 'order', { page: 1, pageSize: 8 })),
    safe(api.getTableStructure(dbKey, 'order')),
    safe(api.runSqlQuery(dbKey, SNAPSHOT_SQL, { maxRows: 1000 })),
    Promise.all(
      realFilePaths.map((p) => safe(api.getFileContent(codeKey, p))),
    ),
    safe(api.listCitations(conversationId)),
  ]);

  /* ---- 审计（来自 REST，不再用静态常量） ---- */
  const auditItems = rows<Dict>(objectOf(audit).items);
  if (auditItems.length > 0) {
    assign(next, 'ORG_AUDIT', auditItems.slice(0, 20).map((a) => {
      const action = field(a, 'action');
      /* 分类以服务端 auditShape.category 为准：前端再写一份正则必然和服务端漂移。 */
      const category = field(a, 'category', '其他');
      return {
        id: field(a, 'id'),
        time: field(a, 'createdAtLabel', '刚刚'),
        actor: field(a, 'actor'),
        action,
        target: field(a, 'target'),
        result: field(a, 'result'),
        resultCls: field(a, 'result') === '拦截' ? 'pending' : '',
        category: category as typeof MOCK_SNAPSHOT.ORG_AUDIT[number]['category'],
      };
    }));
  }

  /* ---- 设置：控件骨架是设计常量，控件值来自 /api/settings ---- */
  const raw = objectOf(objectOf(settings).raw);
  const perm = objectOf(raw.perm);
  assign(next, 'SETTINGS_SECTIONS', MOCK_SNAPSHOT.SETTINGS_SECTIONS.map((section) => ({
    ...section,
    rows: section.rows.map((row) => {
      if (row.control.bindReadOnly && typeof perm.readOnlyMode === 'boolean') {
        return { ...row, control: { ...row.control, on: perm.readOnlyMode } };
      }
      const sectionRaw = objectOf(raw[section.id]);
      const serverValue = sectionRaw[row.id];
      if (serverValue === undefined) return row;
      if (row.control.type === 'toggle' && typeof serverValue === 'boolean') {
        return { ...row, control: { ...row.control, on: serverValue } };
      }
      if (row.control.type !== 'button' && (typeof serverValue === 'string' || typeof serverValue === 'number')) {
        return { ...row, control: { ...row.control, value: String(serverValue) } };
      }
      return row;
    }),
  })));

  /* ---- 命令白名单 / 黑名单 ---- */
  const whiteRows = rows<Dict>(whitelist);
  if (whiteRows.length > 0) {
    assign(next, 'COMMAND_WHITELIST', whiteRows.map((w) => ({
      prefix: field(w, 'prefix', field(w, 'command', field(w, 'pattern'))),
      output: [{ text: field(w, 'description', '只读命令') }],
    })));
  }
  const blackRows = rows<Dict>(blacklist);
  if (blackRows.length > 0) {
    assign(next, 'COMMAND_BLACKLIST', blackRows.map((b) => ({
      pattern: field(b, 'pattern', field(b, 'prefix', field(b, 'command'))),
      label: field(b, 'label', field(b, 'description', '危险命令')),
    })));
  }

  /* ---- 右栏 3 Tab ---- */
  applyContextPanel(next, ctx);
  applyExecutionPanel(next, execution);
  applyArtifactPanel(next, artifacts);

  /* ---- 三个资产详情：指标 / KV / 活动 / 能力 ---- */
  if (serverAsset) {
    assign(next, 'SERVER_METRICS', metricCards(serverAsset));
    assign(next, 'SERVER_CONN_KV', kvRows(serverAsset, '连接'));
  }
  if (serverActivities?.length) assign(next, 'SERVER_ACTIVITY_KV', activityKv(serverActivities));
  if (serverCaps?.length) assign(next, 'CAPS_SERVER', capItems(serverCaps));

  if (dbAsset) {
    assign(next, 'DB_METRICS', metricCards(dbAsset));
    assign(next, 'DB_CONN_KV', kvRows(dbAsset, '连接'));
  }
  if (dbActivities?.length) assign(next, 'DB_ACTIVITY_KV', activityKv(dbActivities));
  if (dbCaps?.length) assign(next, 'CAPS_DB', capItems(dbCaps));

  if (codeAsset) {
    assign(next, 'CODE_METRICS', metricCards(codeAsset));
    assign(next, 'CODE_REPO_KV', kvRows(codeAsset, '仓库'));
  }
  if (codeActivities?.length) assign(next, 'CODE_ACTIVITY_KV', activityKv(codeActivities));
  if (codeCaps?.length) assign(next, 'CAPS_CODE', capItems(codeCaps));

  /* ---- 终端历史 ---- */
  const historyRows = rows<Dict>(history);
  if (historyRows.length > 0) {
    assign(next, 'TERMINAL_HISTORY', historyRows.map((h) => field(h, 'command')).filter(Boolean));
  }

  /* ---- SQL：表树 / 数据浏览 / 结构 / 结果集 ---- */
  const tables = rows<Dict>(objectOf(sqlSchema).tables);
  if (tables.length > 0) {
    const mapped = tables.map((t) => ({
      name: field(t, 'name'), group: field(t, 'schema', 'public'), rows: field(t, 'rowsLabel', '—'),
    }));
    assign(next, 'DB_TABLES_SQL', mapped);
    assign(next, 'DB_TABLES_BROWSE', mapped);
  }
  if (tableRows) {
    const tr = objectOf(tableRows);
    assign(next, 'BROWSE_COLUMNS', rows(tr.columns).map((c) => String(c)));
    assign(next, 'BROWSE_ROWS', rows<unknown[]>(tr.rows).map((row) => row.map((cell) => (cell === null ? 'NULL' : String(cell)))));
  }
  if (tableStructure) {
    const ts = objectOf(tableStructure);
    assign(next, 'BROWSE_STRUCTURE', rows<Dict>(ts.columns).map((c) => [
      field(c, 'name'), field(c, 'type'), c.nullable === false ? 'NOT NULL' : 'NULL', field(c, 'note'),
    ]));
    assign(next, 'BROWSE_INDEXES', rows<unknown[]>(ts.indexes).map((r) => r.map((v) => String(v))));
    assign(next, 'BROWSE_FKS', rows<unknown[]>(ts.foreignKeys).map((r) => r.map((v) => String(v))));
  }
  /* safe() 仅在 envelope.ok 时返回非 null，故 sqlResult 存在即代表查询成功；
   * SqlResult 契约无 ok 字段，此处不再读取不存在的属性。 */
  if (sqlResult) {
    const columns = sqlColumnNames(sqlResult);
    const resultRows = sqlRows(sqlResult);
    if (columns.length > 0) assign(next, 'SQL_RESULT_COLUMNS', columns);
    if (resultRows.length > 0) assign(next, 'SQL_RESULT_ROWS', resultRows);
  }

  /* ---- 代码库：文件树 / 文件内容 ---- */
  if (treeRows.length > 0) {
    assign(next, 'CODE_TREE', treeRows.map((n) => ({
      label: field(n, 'name'), depth: Number(n.depth ?? 0), caret: field(n, 'caret', '·'),
      /* 保留完整路径：点击跳转与"当前文件"高亮都靠它，按文件名匹配会跳错重名文件。 */
      path: n.isFile === true ? field(n, 'path') : null,
    })));
  }
  if (fileContents.some((c) => c !== null)) {
    /* 以**真实文件路径**为骨架，不用演示清单的路径 ——
     * 打包态用户接入的是自己的仓库，文件名跟原型里的 Java 示例毫无关系。 */
    assign(next, 'CODE_FILES', realFilePaths.map((path, index) => {
      const content = fileContents[index];
      const plain = content ? field(objectOf(content), 'plain') : '';
      const name = path.split('/').pop() ?? path;
      const ext = name.split('.').pop() ?? '';
      return {
        name,
        path,
        lang: LANG_BY_EXT[ext.toLowerCase()] ?? ext.toUpperCase(),
        gutterStart: 1,
        html: plain ? plain.split('\n').map((line) => `<div>${line.replace(/</g, '&lt;')}</div>`).join('') : '<div>&nbsp;</div>',
        symbols: [],
        modified: false,
      };
    }));
  }

  /* ---- 引用 ---- */
  applyCitations(next, citations);

  return next;
}

export function LiveDataProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  /* 右栏三段与引用是「会话级」数据：一律跟随活跃会话，不再写死 c-gmv。 */
  const { state } = useStore();
  const conversationId = state.activeConversationId;
  const convRef = useRef<string>(conversationId);
  convRef.current = conversationId;
  const workspaceRef = useRef<string>(state.workspaceId);
  workspaceRef.current = state.workspaceId;

  const [data, setData] = useState<ViewSnapshot>(baseSnapshot());
  const [version, setVersion] = useState<number>(0);
  const [tick, setTick] = useState<number>(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  /* 全量装配：组织 / 设置 / 资产 / 索引 / 表结构等与会话无关的切片。 */
  useEffect(() => {
    let alive = true;
    void loadSnapshot(convRef.current, workspaceRef.current).then((snapshot) => {
      if (!alive) return;
      setData(snapshot);
      setVersion((value) => value + 1);
    });
    return () => {
      alive = false;
    };
  }, [tick]);

  /* 切会话：只重拉右栏三段 + 引用（4 个请求），避免整页 30 个请求重来。 */
  const loadedConvRef = useRef<string>('');
  useEffect(() => {
    if (!conversationId || loadedConvRef.current === conversationId) return;
    loadedConvRef.current = conversationId;
    let alive = true;
    void loadPanels(conversationId).then((partial) => {
      if (!alive) return;
      setData((prev) => ({ ...prev, ...partial }));
      setVersion((value) => value + 1);
    });
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const value = React.useMemo<LiveContextValue>(
    () => ({ data, refresh, version }),
    [data, refresh, version],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/** 消费 REST 装配出的视图数据快照；字段形状与原型常量一致。 */
export function useLiveData(): ViewSnapshot {
  return useContext(LiveContext).data;
}

/** 写操作后刷新 REST 数据。 */
export function useLiveRefresh(): () => void {
  return useContext(LiveContext).refresh;
}

/** 数据版本号，供需要响应刷新的视图使用。 */
export function useLiveVersion(): number {
  return useContext(LiveContext).version;
}
