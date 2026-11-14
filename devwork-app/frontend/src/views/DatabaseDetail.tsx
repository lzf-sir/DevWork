import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { sqlColumnNames, sqlRows } from '../api/adapters';
import { useLiveData, useLiveRefresh } from '../api/live';
import { useAssetTarget } from '../hooks/useAssetTarget';
import {
  Banner,
  DetailHeader,
  GearSvg,
  MetricGrid,
  Pill,
  TriangleSvg,
  copyToClipboard,
  downloadFile,
} from '../components/ui';
import { CaretIcon, ChatIcon, CloseIcon, DatabaseIcon, DotsIcon, EditIcon, PlayIcon, TableIcon } from '../components/icons';
import AssetConfigDrawer from '../components/AssetConfigDrawer';
import DbObjectTree, { type TreeObject } from '../components/DbObjectTree';
import DbDataGrid, { type GridSortState } from '../components/DbDataGrid';
import DbFilterPanel from '../components/DbFilterPanel';
import type { BrowseFilter, TableDdl, TableFields } from '../api/types';

/**
 * 数据库详情 —— Navicat 式工作区。
 *
 * 布局：左侧对象树（连接 → schema → 表/视图/索引），右侧标签页。
 * 标签页模型是关键决策：Navicat 的心智是「打开一张表 = 开一个标签」，
 * 而不是一个固定的「查询/浏览」二选一。用户可以同时开 order 和 user 两张表对照看，
 * 这才是真实 DBA 的工作方式。
 *
 * 安全边界（不可破）：本页面只读。所有写能力由服务端 SQL Guard 裁决，
 * 前端不自行判定，也不提供任何绕过入口。
 */

type TabId = string;
const QUERY_TAB = '__query__';

type TableTabState = {
  table: string;
  sort: GridSortState;
  filters: BrowseFilter[];
  page: number;
  pageSize: number;
  mode: 'data' | 'fields' | 'ddl';
};

export default function DatabaseDetail(): React.ReactElement {
  const { state, setModal, setSqlPreset, addToast, setConfigOpen, openAssetChat } = useStore();
  const refresh = useLiveRefresh();
  const {
    CAPS_DB,
    DB_ACTIVITY_KV,
    DB_CONN_KV,
    DB_METRICS,
    DEFAULT_SQL_TEXT,
    SQL_HIGHLIGHTED,
    SQL_RESULT_COLUMNS,
    SQL_RESULT_ROWS,
    highlightSql,
  } = useLiveData();

  /* ---- 标签页状态：SQL 查询页 + 若干已打开的表 ---- */
  const [tabs, setTabs] = useState<TabId[]>([QUERY_TAB]);
  const [activeTab, setActiveTab] = useState<TabId>(QUERY_TAB);
  const [tableStates, setTableStates] = useState<Record<TabId, TableTabState>>({});

  /* ---- 对象树数据：来自服务端 schema 端点（表/视图/索引 + 真实行数） ---- */
  const [objects, setObjects] = useState<TreeObject[]>([]);
  /* ---- 数据网格当前页数据 ---- */
  const [gridColumns, setGridColumns] = useState<string[]>([]);
  const [gridRows, setGridRows] = useState<unknown[][]>([]);
  const [gridTotal, setGridTotal] = useState(0);
  const [gridPages, setGridPages] = useState(1);
  const [gridLoading, setGridLoading] = useState(false);
  /* ---- 字段详情与 DDL ---- */
  const [fields, setFields] = useState<TableFields | null>(null);
  const [ddl, setDdl] = useState<TableDdl | null>(null);
  /* ---- SQL 查询页状态 ---- */
  const [sqlStatus, setSqlStatus] = useState<string>('执行成功');
  const [resultMeta, setResultMeta] = useState<{ rowCount: number; durationMs: number } | null>(null);
  const [resultColumns, setResultColumns] = useState<string[]>(SQL_RESULT_COLUMNS);
  const [resultRows, setResultRows] = useState<string[][]>(SQL_RESULT_ROWS);
  const [bound, setBound] = useState<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const [exportOpen, setExportOpen] = useState<boolean>(false);
  const [filterOpen, setFilterOpen] = useState<boolean>(false);

  const sqlRef = useRef<HTMLDivElement>(null);
  const active = tableStates[activeTab];
  const activeIsQuery = activeTab === QUERY_TAB;

  /* 当前工作区里的数据库资产：不再写死 a-order-db-prod（那是 w-ops 的演示资产）。 */
  const dbAsset = useAssetTarget('db');
  const assetId = dbAsset?.id ?? '';

  /* ============ 对象树装载 ============ */
  useEffect(() => {
    if (state.view !== 'detail-db') return;
    if (!assetId) return;
    let alive = true;
    void api.getSqlSchema(assetId).then((envelope) => {
      if (!alive || !envelope.ok) return;
      const data = envelope.data;
      const tableNodes: TreeObject[] = (data.tables ?? []).map((table) => ({
        name: table.name,
        kind: table.kind === 'view' ? 'view' : 'table',
        schema: table.schema || 'public',
        rowsLabel: table.rowsLabel,
        totalRows: table.totalRows ?? 0,
      }));
      const indexNodes: TreeObject[] = (data.indexes ?? []).map((index) => ({
        name: index.name,
        kind: 'index' as const,
        schema: index.schema || 'public',
        rowsLabel: index.rowsLabel,
        totalRows: index.totalRows ?? 0,
      }));
      setObjects([...tableNodes, ...indexNodes]);
    });
    return () => {
      alive = false;
    };
  }, [state.view, refresh, assetId]);

  /* ============ 打开表：新标签页 + 首屏加载 ============ */
  const openTable = (table: string): void => {
    if (!tableStates[table]) {
      setTableStates((prev) => ({
        ...prev,
        [table]: { table, sort: null, filters: [], page: 1, pageSize: 50, mode: 'data' },
      }));
    }
    setTabs((prev) => (prev.includes(table) ? prev : [...prev, table]));
    setActiveTab(table);
  };

  const closeTab = (tabId: TabId): void => {
    setTabs((prev) => {
      if (!prev.includes(tabId)) return prev;
      const next = prev.filter((id) => id !== tabId);
      setActiveTab((current) => {
        if (current !== tabId) return current;
        /* 关闭当前标签 → 落到相邻标签；一个都不剩则回落到 SQL 查询页。 */
        const index = prev.indexOf(tabId);
        return next[Math.min(index, next.length - 1)] ?? QUERY_TAB;
      });
      return next;
    });
    if (tabId !== QUERY_TAB) {
      setTableStates((prev) => {
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
    }
  };

  const patchTableState = (tabId: TabId, part: Partial<TableTabState>): void => {
    setTableStates((prev) => {
      const current = prev[tabId];
      if (!current) return prev;
      return { ...prev, [tabId]: { ...current, ...part } };
    });
  };

  /* ============ 表数据加载：排序 / 筛选 / 分页全部走服务端 ============ */
  useEffect(() => {
    if (state.view !== 'detail-db' || activeIsQuery || !active) return;
    let alive = true;
    setGridLoading(true);
    void api
      .getTableRows(assetId, active.table, {
        page: active.page,
        pageSize: active.pageSize,
        sort: active.sort?.column,
        dir: active.sort?.direction,
        filters: effectiveFilters(active.filters),
      })
      .then((envelope) => {
        if (!alive) return;
        if (!envelope.ok) {
          setGridLoading(false);
          addToast(`✕ ${envelope.error?.message ?? '读取表数据失败'}`);
          return;
        }
        const data = envelope.data;
        setGridColumns(data.columns ?? []);
        setGridRows(data.rows ?? []);
        setGridTotal(data.totalRows ?? 0);
        setGridPages(data.totalPages ?? 1);
        setGridLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setGridLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view, activeTab, active?.table, active?.page, active?.pageSize, active?.sort?.column, active?.sort?.direction, active?.filters, assetId]);

  /* ============ 字段详情 / DDL 按需加载 ============ */
  useEffect(() => {
    if (state.view !== 'detail-db' || activeIsQuery || !active) return;
    if (active.mode === 'data') return;
    let alive = true;
    if (active.mode === 'fields') {
      void api.getTableFields(assetId, active.table).then((envelope) => {
        if (!alive || !envelope.ok) return;
        setFields(envelope.data);
      });
    } else if (active.mode === 'ddl') {
      void api.getTableDdl(assetId, active.table).then((envelope) => {
        if (!alive || !envelope.ok) return;
        setDdl(envelope.data);
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.view, activeTab, active?.table, active?.mode, assetId]);

  /* ============ SQL 查询页 ============ */
  const readSql = (): string => sqlRef.current?.innerText ?? DEFAULT_SQL_TEXT;

  const runSql = (): void => {
    const sql = readSql();
    void api
      .runSqlQuery(assetId, sql, { maxRows: 1000, timeoutMs: 15000 })
      .then((envelope) => {
        if (!envelope.ok) {
          /* 三种失败的用户动作完全不同，必须分开说：
           * 被拦截 → 改写法；语法/执行错误 → 改 SQL；超时 → 缩小范围。 */
          const code = envelope.error?.code ?? 'E_SQL_REJECTED';
          if (code === 'E_SQL_REJECTED') {
            setSqlStatus(`✕ 已拦截：${code} · 未发送到数据库`);
          } else if (code === 'E_SQL_SYNTAX') {
            setSqlStatus(`✕ 执行失败：${code} · 已发送到数据库但被拒绝`);
          } else if (code === 'E_SQL_TIMEOUT') {
            setSqlStatus(`✕ 已超时：${code} · 只读 worker 已中断`);
          } else {
            setSqlStatus(`✕ 失败：${code}`);
          }
          addToast(`✕ ${envelope.error?.message ?? '只读执行失败'}`);
          return;
        }
        const result = envelope.data;
        setSqlStatus(result.statusText || '执行成功');
        setResultMeta({ rowCount: result.rowCount, durationMs: result.durationMs });
        const columns = sqlColumnNames(result);
        const table = sqlRows(result);
        if (columns.length > 0) setResultColumns(columns);
        if (table.length > 0) setResultRows(table);
        addToast(`${result.statusText || '执行成功'} · 校验和 ${result.dbChecksumBefore === result.dbChecksumAfter ? '未变化' : '异常'}`);
      })
      .catch(() => {
        setSqlStatus('✕ 执行失败：网络异常 · 未连接到后端');
        addToast('✕ 执行失败：网络异常');
      });
  };

  useEffect(() => {
    if (!state.hotkey || state.hotkey.kind !== 'sqlRun') return;
    if (state.view !== 'detail-db' || !activeIsQuery) return;
    runSql();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hotkey]);

  /* ============ 格式 / EXPLAIN / 导出 ============ */
  const formatSql = (): void => {
    const clean = readSql()
      .split('\n')
      .map((line) => line.replace(/^\s*\d+\s/, ''))
      .join('\n');
    const formatted = clean.replace(/\b(select|from|where|and|or|order by|group by|limit|desc|asc|datetime|strftime)\b/gi, (match) =>
      match.toUpperCase(),
    );
    if (sqlRef.current) sqlRef.current.innerHTML = highlightSql(formatted);
    setSqlStatus('已格式化');
    addToast('SQL 已格式化（关键字大写）');
  };

  /** 多格式导出：CSV / JSON / Markdown / SQL INSERT。 */
  const exportResults = (format: 'csv' | 'json' | 'md' | 'sql'): void => {
    setExportOpen(false);
    void api.exportSqlCsv(assetId, readSql(), format).then((envelope) => {
      if (envelope.ok) {
        downloadFile(envelope.data.fileName, envelope.data.content, envelope.data.mime);
        addToast(`结果集已导出 · ${format.toUpperCase()} · 审计 ${envelope.data.auditId}`);
        return;
      }
      addToast(`✕ 导出失败：${envelope.error?.message ?? '未知错误'}`);
    });
  };

  /* ============ 凭据 ============ */
  const bindCredential = (): void => {
    setModal({
      kind: 'prompt',
      title: '绑定只读凭据',
      label: '凭据值（将经系统钥匙串 safeStorage 加密存本机，不进数据库、不上云）：',
      placeholder: 'prod-pg-readonly 的密码 / token',
      confirmLabel: '绑定',
      onSubmit: (secret: string) => {
        void api.bindCredential(assetId, { label: 'prod-pg-readonly', secret }).then((envelope) => {
          if (!envelope.ok) {
            addToast(`绑定凭据被拒：${envelope.error?.code ?? 'E_PERMISSION_DENIED'} ${envelope.error?.message ?? ''}`);
            return;
          }
          setBound(true);
          addToast('凭据已绑定：prod-pg-readonly · 秘密已加密存本机 · 已写入服务端审计');
        });
      },
    });
  };

  const renewCredential = (): void => {
    void api.renewCredential(assetId).then((envelope) => {
      if (!envelope.ok) {
        addToast(`凭据轮换失败：${envelope.error?.code ?? ''} ${envelope.error?.message ?? ''}`);
        return;
      }
      addToast('凭据已轮换 · 新版本密文已写入本机钥匙串 · 已记入审计');
      refresh();
    });
  };

  const newQuery = (): void => {
    setActiveTab(QUERY_TAB);
    if (sqlRef.current) sqlRef.current.innerHTML = highlightSql(DEFAULT_SQL_TEXT);
    setSqlStatus('新查询 · 只读凭据生效 · 自动 LIMIT 1000');
  };

  const renameAsset = (): void => {
    setModal({
      kind: 'prompt',
      title: `重命名资产 · ${dbAsset?.name ?? '数据库'}`,
      label: '新的资产名称：',
      placeholder: dbAsset?.name ?? '新资产名',
      confirmLabel: '保存',
      onSubmit: (value: string) => {
        if (!value.trim()) {
          addToast('名称不能为空');
          return;
        }
        void api.updateAsset(assetId, { name: value.trim() }).then((envelope) => {
          addToast(envelope.ok ? '资产已重命名' : `重命名失败：${envelope.error?.message ?? '未知错误'}`);
          refresh();
        });
      },
    });
  };

  const refreshSchema = (): void => {
    void api.getSqlSchema(assetId).then((envelope) => {
      if (!envelope.ok) {
        addToast(`Schema 刷新失败：${envelope.error?.message ?? '网络异常'}`);
        return;
      }
      addToast(`Schema 已刷新 · ${envelope.data.tables.length} 张表`);
      refresh();
    });
  };

  const reindexAsset = (): void => {
    void api.advanceIndex(assetId).then((envelope) => {
      addToast(envelope.ok ? `已推进索引：${envelope.data.indexProgress}% · ${envelope.data.status}` : `索引推进失败：${envelope.error?.message ?? '未知错误'}`);
      refresh();
    });
  };

  /* ============ 浏览页右键 → 生成筛选（真实 WHERE 回填 SQL 页） ============ */
  const applyCellFilter = (column: string, value: unknown): void => {
    if (value === null || value === undefined) {
      setSqlPreset(`SELECT * FROM public.${active?.table ?? 'order'}\nWHERE ${column} IS NULL\nLIMIT 100`);
      return;
    }
    const literal = typeof value === 'number' ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
    setSqlPreset(`SELECT * FROM public.${active?.table ?? 'order'}\nWHERE ${column} = ${literal}\nLIMIT 100`);
  };

  /* ============ 排序切换 ============ */
  const toggleSort = (tableId: TabId, column: string): void => {
    const current = tableStates[tableId];
    if (!current) return;
    const nextSort: GridSortState =
      current.sort?.column === column
        ? current.sort.direction === 'asc'
          ? { column, direction: 'desc' }
          : null
        : { column, direction: 'asc' };
    patchTableState(tableId, { sort: nextSort, page: 1 });
  };

  /* ============ 筛选条件变化 → 回到第 1 页 ============ */
  /* 未填值的条件不提交给服务端：按空值匹配会返回 0 行，
   * 用户会误以为表被清空。条件保留在 UI 上（能看见、能补值），只是不生效。 */
  const setFilters = (tableId: TabId, filters: BrowseFilter[]): void => {
    patchTableState(tableId, { filters, page: 1 });
  };

  /** 实际提交给服务端的筛选条件：剔除未填值的项。 */
  const effectiveFilters = (filters: BrowseFilter[]): BrowseFilter[] =>
    filters.filter(
      (filter) =>
        filter.operator === 'IS NULL' ||
        filter.operator === 'IS NOT NULL' ||
        String(filter.value ?? '').trim() !== '',
    );

  /* ============ 翻译 WHERE 给用户看 ============ */
  const whereText = useMemo(() => {
    if (!active) return '';
    return effectiveFilters(active.filters)
      .map((filter) => `${filter.column} ${filter.operator} ${filter.value === '' ? "''" : filter.value}`)
      .join(' AND ');
  }, [active]);

  const credentialBlock = (
    <div>
      {bound ? (
        <>
          已绑定 prod-pg-readonly · 最后使用 刚刚
          <br />
          <button className="btn" onClick={renewCredential}>
            轮换凭据
          </button>
        </>
      ) : (
        <>
          <span style={{ color: 'var(--warning)' }}>未绑定 · 需要你自己的只读账号</span>
          <br />
          <button className="btn p" onClick={bindCredential}>
            绑定凭据
          </button>
        </>
      )}
    </div>
  );

  const kvRows = [
    { k: '连接串', v: <>{DB_CONN_KV[0]?.v}</> },
    ...DB_CONN_KV.slice(1).map((row) => ({ k: row.k, v: <>{row.v}</> })),
  ];

  /* ============ 渲染 ============ */
  return (
    <div className={`view${state.view === 'detail-db' ? ' on' : ''}`} data-view="detail-db">
      <DetailHeader
        icon={<DatabaseIcon size={15} strokeWidth={1.4} />}
        name={dbAsset?.name ?? '数据库'}
        sub="PostgreSQL 15.4 · order-db.prod:5432/order_db"
        pills={
          <>
            <Pill tone="ok">
              <span className="sdot" />
              已索引
            </Pill>
            <Pill tone="ro">prod · 只读</Pill>
          </>
        }
        actions={
          <>
            <button
              className="btn p"
              onClick={() =>
                openAssetChat({ assetId, assetName: dbAsset?.name ?? '数据库', assetType: 'db' })
              }
              title="在当前页面唤起一条绑定该数据库的 AI 会话"
            >
              <ChatIcon size={13} strokeWidth={1.4} />
              AI 会话
            </button>
            <button className="btn p" onClick={newQuery}>
              新建查询
            </button>
            <button
              className="dcfg"
              type="button"
              title="资产配置（能力授权 / 凭据 / 资产信息）"
              aria-label="资产配置"
              onClick={() => setConfigOpen(true)}
            >
              <GearSvg />
            </button>
            <div className="amore" onClick={() => setMenuOpen((value) => !value)}>
              <DotsIcon size={14} />
            </div>
            {menuOpen ? (
              <div className="cmenu" onMouseLeave={() => setMenuOpen(false)}>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); renameAsset(); }}>重命名资产</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); refreshSchema(); }}>刷新 Schema</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); reindexAsset(); }}>重建索引</div>
              </div>
            ) : null}
          </>
        }
      />

      <div className="dbws">
        {/* ---------- 左侧对象树 ---------- */}
        <DbObjectTree
          objects={objects}
          activeTable={activeIsQuery ? '' : active?.table ?? ''}
          onOpenTable={openTable}
          onOpenQuery={newQuery}
        />

        {/* ---------- 右侧标签页 ---------- */}
        <div className="dbmain">
          <div className="dbtabs">
            {tabs.map((tabId) => {
              const label = tabId === QUERY_TAB ? 'SQL 查询' : tabId;
              return (
                <div className={`dbtab${activeTab === tabId ? ' on' : ''}`} key={tabId}>
                  <span className="dbtab-ic">
                    {tabId === QUERY_TAB ? (
                      <EditIcon size={11} strokeWidth={1.4} />
                    ) : (
                      <TableIcon size={11} strokeWidth={1.4} />
                    )}
                  </span>
                  <span
                    className="dbtab-n"
                    onClick={() => setActiveTab(tabId)}
                    title={tabId === QUERY_TAB ? 'SQL 查询' : `public.${tabId}`}
                  >
                    {label}
                  </span>
                  {tabId === QUERY_TAB ? null : (
                    <span className="dbtab-x" title="关闭标签" aria-label={`关闭标签 ${label}`} onClick={() => closeTab(tabId)}>
                      <CloseIcon size={11} strokeWidth={1.5} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* ---------- SQL 查询页签 ---------- */}
          <div className={`dbody${activeIsQuery ? ' on' : ''}`} data-dt="main">
            <Banner icon={<TriangleSvg />}>
              生产环境 · 只读执行 · 已自动追加 LIMIT 1000 · 沙箱内所有 db 资产共用同一个演示库（表结构来自实际连接）
            </Banner>
            <div className="sqltools">
              <button className="btn p" style={{ padding: '3px 12px' }} onClick={runSql}>
                <PlayIcon size={11} />
                执行
              </button>
              <button className="btn" onClick={formatSql}>
                格式化
              </button>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--gray-400)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                结果集上限 1000 行 · 超时 15s
                <span style={{ position: 'relative' }}>
                  <button className="btn" data-export-trigger="1" onClick={() => setExportOpen((v) => !v)}>
                    导出
                    <CaretIcon dir="down" size={10} strokeWidth={1.6} className="btn-caret" />
                  </button>
                  {exportOpen ? (
                    <div className="cmenu dbexport" onMouseLeave={() => setExportOpen(false)}>
                      <div className="cmenu-item" onClick={() => exportResults('csv')}>CSV（逗号分隔）</div>
                      <div className="cmenu-item" onClick={() => exportResults('json')}>JSON</div>
                      <div className="cmenu-item" onClick={() => exportResults('md')}>Markdown 表格</div>
                      <div className="cmenu-item" onClick={() => exportResults('sql')}>SQL INSERT 脚本</div>
                    </div>
                  ) : null}
                </span>
              </span>
            </div>
            <div
              className="sqlbody"
              ref={sqlRef}
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              dangerouslySetInnerHTML={{ __html: SQL_HIGHLIGHTED }}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                }
              }}
            />
            <div className="grid">
              <table className="g">
                <thead>
                  <tr>
                    {resultColumns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {resultRows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className={cellIndex === 0 || cellIndex === 1 || cellIndex === 3 ? 'n' : ''}>
                          {cellIndex === 2 ? <span className="tagc">{cell}</span> : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dbar2">
              <span>
                <span className="sdot" /> {sqlStatus}
              </span>
              <span>{resultMeta ? `${resultMeta.rowCount.toLocaleString('en-US')} 行` : '— 行'}</span>
              <span>{resultMeta ? `${resultMeta.durationMs}ms` : '— ms'}</span>
              <span className="sr">
                <span style={{ cursor: 'pointer' }} onClick={() => exportResults('csv')}>
                  导出 CSV
                </span>
                <span
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    copyToClipboard([resultColumns.join('\t'), ...resultRows.map((row) => row.join('\t'))].join('\n'));
                    addToast('结果集已复制');
                  }}
                >
                  复制结果
                </span>
              </span>
            </div>
          </div>

          {/* ---------- 表浏览页签 ---------- */}
          {tabs
            .filter((tabId) => tabId !== QUERY_TAB)
            .map((tabId) => {
              const tab = tableStates[tabId];
              if (!tab) return null;
              const isActive = activeTab === tabId;
              return (
                <div className={`dbody${isActive ? ' on' : ''}`} data-dt={tabId} key={tabId}>
                  <div className="sqltools">
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--gray-900)' }}>
                      public.{tab.table}
                    </span>
                    <span className="atag">{gridTotal.toLocaleString('en-US')} 行</span>
                    {(['data', 'fields', 'ddl'] as const).map((mode) => {
                      const label = mode === 'data' ? '数据' : mode === 'fields' ? '字段' : 'DDL';
                      return (
                        <button
                          className={`btn${tab.mode === mode ? ' on' : ''}`}
                          key={mode}
                          onClick={() => patchTableState(tabId, { mode })}
                        >
                          {label}
                        </button>
                      );
                    })}
                    {tab.mode === 'data' ? (
                      <>
                        <button
                          className={`btn${filterOpen && tab.filters.length > 0 ? ' on' : ''}`}
                          style={{ marginLeft: 8 }}
                          onClick={() => setFilterOpen((v) => !v)}
                        >
                          筛选 {tab.filters.length > 0 ? `(${tab.filters.length})` : ''}
                        </button>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--gray-400)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          每页
                          <select
                            className="dbsel dbsel-sm"
                            value={tab.pageSize}
                            onChange={(event) =>
                              patchTableState(tabId, { pageSize: Number(event.target.value), page: 1 })
                            }
                          >
                            {[25, 50, 100, 200, 500].map((size) => (
                              <option key={size} value={size}>
                                {size}
                              </option>
                            ))}
                          </select>
                          行
                          <button
                            className="btn"
                            style={{ padding: '1px 8px' }}
                            disabled={tab.page <= 1}
                            onClick={() => patchTableState(tabId, { page: Math.max(1, tab.page - 1) })}
                          >
                            ‹
                          </button>
                          第 {tab.page} / {gridPages} 页
                          <button
                            className="btn"
                            style={{ padding: '1px 8px' }}
                            disabled={tab.page >= gridPages}
                            onClick={() => patchTableState(tabId, { page: Math.min(gridPages, tab.page + 1) })}
                          >
                            ›
                          </button>
                        </span>
                      </>
                    ) : null}
                  </div>

                  {tab.mode === 'data' ? (
                    <>
                      {filterOpen ? (
                        <DbFilterPanel
                          columns={gridColumns}
                          filters={tab.filters}
                          onChange={(next) => setFilters(tabId, next)}
                          onClear={() => setFilters(tabId, [])}
                        />
                      ) : null}
                      <div className="grid">
                        {gridLoading ? (
                          <div className="dbgrid-empty">加载中…</div>
                        ) : (
                          <DbDataGrid
                            columns={gridColumns}
                            rows={gridRows}
                            sort={tab.sort}
                            onSort={(column) => toggleSort(tabId, column)}
                            onCellAction={(column, value) => applyCellFilter(column, value)}
                            rowOffset={(tab.page - 1) * tab.pageSize}
                            highlightColumns={gridColumns.filter((column) => /status|state|channel|type/i.test(column))}
                          />
                        )}
                      </div>
                      <div className="dbar2">
                        <span>
                          第 {tab.page} 页 · {gridRows.length} 行 · 共 {gridTotal.toLocaleString('en-US')} 行
                          {whereText ? ` · WHERE ${whereText}` : ''}
                        </span>
                        <span className="sr">
                          <span>双击单元格复制</span>
                          <span>右键按此值筛选</span>
                        </span>
                      </div>
                    </>
                  ) : null}

                  {tab.mode === 'fields' ? (
                    <div className="grid">
                      <table className="g">
                        <thead>
                          <tr>
                            <th>字段名</th>
                            <th>类型</th>
                            <th>默认值</th>
                            <th>可空</th>
                            <th>主键</th>
                            <th>说明</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(fields?.columns ?? []).map((column) => (
                            <tr key={column.name}>
                              <td style={{ fontFamily: 'var(--mono)' }}>{column.name}</td>
                              <td>{column.type}</td>
                              <td>{column.defaultValue ?? '—'}</td>
                              <td>{column.nullable ? '是' : '否'}</td>
                              <td>{column.primaryKey ? 'PK' : '—'}</td>
                              <td>{column.note || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="dbfields-sub">
                        <div className="sect-t">索引（{(fields?.indexes ?? []).length}）</div>
                        <table className="g">
                          <thead>
                            <tr>
                              <th>索引名</th>
                              <th>类型</th>
                              <th>列</th>
                              <th>备注</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(fields?.indexes ?? []).map((row) => (
                              <tr key={row[0]}>
                                <td style={{ fontFamily: 'var(--mono)' }}>{row[0]}</td>
                                <td>{row[1]}</td>
                                <td>{row[2]}</td>
                                <td>{row[3]}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="sect-t">外键（{(fields?.foreignKeys ?? []).length}）</div>
                        <table className="g">
                          <thead>
                            <tr>
                              <th>外键名</th>
                              <th>本表列</th>
                              <th>引用</th>
                              <th>删除策略</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(fields?.foreignKeys ?? []).map((row) => (
                              <tr key={row[0]}>
                                <td style={{ fontFamily: 'var(--mono)' }}>{row[0]}</td>
                                <td>{row[1]}</td>
                                <td>{row[2]}</td>
                                <td>{row[3]}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  {tab.mode === 'ddl' ? (
                    <div className="dbddl">
                      <pre>{ddl?.sql || '加载中…'}</pre>
                      {(ddl?.indexes ?? []).length > 0 ? (
                        <>
                          <div className="sect-t">索引定义</div>
                          {ddl?.indexes.map((index) => (
                            <pre key={index.name}>{index.sql}</pre>
                          ))}
                        </>
                      ) : null}
                      <div className="dbar2">
                        <span>
                          <span className="sdot" /> 来自 sqlite_master 原文 · 非模板生成
                        </span>
                        <span className="sr">
                          <span
                            style={{ cursor: 'pointer' }}
                            onClick={() => {
                              if (!ddl?.sql) return;
                              copyToClipboard(ddl.sql);
                              addToast('DDL 已复制');
                            }}
                          >
                            复制 DDL
                          </span>
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
        </div>
      </div>

      <AssetConfigDrawer
        open={state.configOpen && state.view === 'detail-db'}
        title="order_db"
        sub="PostgreSQL 15.4 · order-db.prod:5432/order_db"
        caps={CAPS_DB}
        assetId={assetId}
        readOnly={state.readOnly}
        credential={credentialBlock}
        metrics={DB_METRICS}
        kv={kvRows}
        activity={DB_ACTIVITY_KV.map((row) => ({ k: row.k, v: row.v }))}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  );
}
