/**
 * SqlBrowse —— 只读浏览能力层（Navicat 式浏览，但只读）。
 *
 * 边界：这个模块只做「读」——列行、排序、筛选、字段详情、DDL 预览。
 * 任何写操作（INSERT/UPDATE/DELETE/DDL）都不在这里，也不允许通过
 * orderBy / filter 的参数缝隙绕进来。排序字段名必须命中该表真实列，
 * 筛选值一律走参数化绑定，运算符走白名单。
 *
 * 设计对应 docs/devwork-design.md §9.12：查询与浏览分开，但共用左侧对象树。
 */
import { demoDb } from '../db/database';
import { ApiFailure } from '../http/core';

export interface BrowseColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  note: string;
}

export interface BrowseFilter {
  column: string;
  operator: string;
  /** 绑定值必须是 SQLite 可接受的标量（string/number/bigint/null）。 */
  value: string | number | bigint | null;
}

export interface BrowseSort {
  column: string;
  direction: 'asc' | 'desc';
}

/** 筛选运算符白名单：只读语义，全部是行子集条件。 */
const OPERATORS = new Set(['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE', 'IS NULL', 'IS NOT NULL']);
/** 无值运算符：用户不该再填值，填了也忽略。 */
const VALUELESS = new Set(['IS NULL', 'IS NOT NULL']);

/** 标识符双引号转义 —— 表名/列名只能来自 PRAGMA 实读结果，不来自用户输入。 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 表名合法性：与既有路由一致，仅允许字母数字下划线。 */
export function safeTableName(raw: string): string {
  const name = String(raw).replace(/[^a-zA-Z0-9_]/g, '');
  if (name === '') throw new ApiFailure('E_VALIDATION', '表名不合法');
  return name;
}

/** 读该表真实列（PRAGMA）。返回空数组表示表不存在。 */
export function tableColumns(table: string): BrowseColumn[] {
  const rows = demoDb().prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Record<string, unknown>[];
  return rows.map((row) => ({
    name: String(row.name),
    type: String(row.type ?? ''),
    nullable: Number(row.notnull) === 0,
    defaultValue: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
    primaryKey: Number(row.pk) === 1,
    note: Number(row.pk) === 1 ? '主键' : '',
  }));
}

/**
 * 构造 WHERE 片段 + 绑定参数。
 * 列名必须命中真实列（白名单），运算符必须命中白名单，值一律参数化。
 */
export function buildWhere(
  filters: BrowseFilter[],
  columns: BrowseColumn[],
): { sql: string; params: (string | number | bigint | null)[] } {
  const columnNames = new Set(columns.map((c) => c.name));
  const clauses: string[] = [];
  const params: (string | number | bigint | null)[] = [];
  for (const filter of filters) {
    if (!filter || typeof filter.column !== 'string') continue;
    if (!columnNames.has(filter.column)) {
      /* 列不存在 → 明确报错，而不是静默忽略后返回全表（那会误导用户以为过滤生效了）。 */
      throw new ApiFailure('E_VALIDATION', `筛选列不存在：${filter.column}`);
    }
    const operator = String(filter.operator ?? '').trim().toUpperCase();
    if (!OPERATORS.has(operator)) {
      throw new ApiFailure('E_VALIDATION', `不支持的筛选运算符：${filter.operator}`);
    }
    const column = quoteIdent(filter.column);
    if (VALUELESS.has(operator)) {
      clauses.push(`${column} ${operator}`);
      continue;
    }
    clauses.push(`${column} ${operator} ?`);
    params.push(filter.value ?? '');
  }
  return { sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

/** 排序：列名必须命中真实列，方向只能是 asc/desc。 */
export function buildOrder(sort: BrowseSort | null, columns: BrowseColumn[]): string {
  if (!sort || !sort.column) return '';
  const columnNames = new Set(columns.map((c) => c.name));
  if (!columnNames.has(sort.column)) {
    throw new ApiFailure('E_VALIDATION', `排序列不存在：${sort.column}`);
  }
  const direction = sort.direction === 'desc' ? 'DESC' : 'ASC';
  return ` ORDER BY ${quoteIdent(sort.column)} ${direction}`;
}

export interface BrowseRowsResult {
  columns: string[];
  rows: unknown[][];
  page: number;
  pageSize: number;
  totalPages: number;
  totalRows: number;
  appliedWhere: string;
  appliedOrder: string;
}

/**
 * 分页读取表数据，支持筛选 + 排序。
 * COUNT(*) 与 SELECT 共用同一 WHERE，保证页数与过滤口径一致。
 */
export function browseRows(
  table: string,
  options: { page: number; pageSize: number; filters: BrowseFilter[]; sort: BrowseSort | null },
): BrowseRowsResult {
  const columns = tableColumns(table);
  if (columns.length === 0) throw new ApiFailure('E_NOT_FOUND', `数据表不存在：${table}`);
  const page = Math.max(1, Math.floor(options.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Math.floor(options.pageSize) || 50));
  const where = buildWhere(options.filters, columns);
  const order = buildOrder(options.sort, columns);

  const countRow = demoDb()
    .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${where.sql}`)
    .get(...where.params) as Record<string, unknown>;
  const totalRows = Number(countRow?.n ?? 0);

  const statement = demoDb().prepare(
    `SELECT * FROM ${quoteIdent(table)}${where.sql}${order} LIMIT ? OFFSET ?`,
  );
  const raw = statement.all(...where.params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
  const names = columns.map((c) => c.name);

  return {
    columns: names,
    rows: raw.map((row) => names.map((name) => (row[name] === undefined ? null : row[name]))),
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
    totalRows,
    appliedWhere: where.sql.trim(),
    appliedOrder: order.trim(),
  };
}

/**
 * 对象树：把 sqlite_master 里的表 / 视图 / 索引分类，附真实行数。
 * 这是 Navicat 左侧树的骨架——分类让用户知道自己在点什么，
 * 行数让用户知道点开值不值。
 */
export interface ObjectNode {
  name: string;
  kind: 'table' | 'view' | 'index';
  schema: string;
  rowsLabel: string;
  totalRows: number;
}

export function listObjects(): { nodes: ObjectNode[]; schemas: string[] } {
  const db = demoDb();
  const master = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all() as Record<string, unknown>[];

  const nodes: ObjectNode[] = [];
  for (const row of master) {
    const type = String(row.type);
    const name = String(row.name);
    if (type !== 'table' && type !== 'view' && type !== 'index') continue;
    const owner = String(row.tbl_name ?? name);
    let totalRows = 0;
    if (type === 'table' || type === 'view') {
      const count = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as Record<string, unknown>;
      totalRows = Number(count?.n ?? 0);
    }
    nodes.push({
      name,
      kind: type,
      schema: 'public',
      rowsLabel: type === 'index' ? '—' : `${totalRows} 行`,
      totalRows,
      /* 索引挂在所属表下面，schema 分组按表归属推导。 */
      ...(type === 'index' ? { owner } : {}),
    } as ObjectNode);
  }
  const schemas = Array.from(new Set(nodes.map((n) => n.schema))).sort();
  return { nodes, schemas };
}

/** DDL 原文：sqlite_master.sql 是真实建表语句，不是模板文本。 */
export function tableDdl(table: string): { name: string; sql: string; indexes: { name: string; sql: string }[] } {
  const db = demoDb();
  const row = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as Record<string, unknown> | undefined;
  if (!row) throw new ApiFailure('E_NOT_FOUND', `数据表不存在：${table}`);
  const indexes = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL")
    .all(table) as Record<string, unknown>[];
  return {
    name: String(row.name),
    sql: String(row.sql ?? ''),
    indexes: indexes.map((idx) => ({ name: String(idx.name), sql: String(idx.sql ?? '') })),
  };
}

/** 字段详情：含默认值与完整类型（PRAGMA table_info 实读）。 */
export function tableFields(table: string): { columns: BrowseColumn[]; indexes: string[][]; foreignKeys: string[][] } {
  const db = demoDb();
  const columns = tableColumns(table);
  if (columns.length === 0) throw new ApiFailure('E_NOT_FOUND', `数据表不存在：${table}`);
  const indexList = db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as Record<string, unknown>[];
  const indexes = indexList.map((idx) => {
    const infos = db.prepare(`PRAGMA index_info(${quoteIdent(String(idx.name))})`).all() as Record<string, unknown>[];
    const cols = infos.map((info) => String(info.name)).filter(Boolean).join(', ') || '—';
    const unique = Number(idx.unique) === 1;
    const origin = String(idx.origin ?? 'c');
    const originLabel = origin === 'pk' ? 'PRIMARY' : origin === 'u' ? 'UNIQUE' : 'INDEX';
    return [String(idx.name), originLabel, cols, `${unique ? '唯一' : '非唯一'}${origin === 'pk' ? ' · 主键约束' : ''}`];
  });
  const foreignKeys = (db.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all() as Record<string, unknown>[]).map(
    (fk) => [
      `fk_${String(fk.table)}_${String(fk.from)}`,
      String(fk.from),
      `${String(fk.table)}(${String(fk.to)})`,
      `ON ${String(fk.on_update ?? 'NO ACTION')} / ${String(fk.on_delete ?? 'NO ACTION')}`,
    ],
  );
  return { columns, indexes, foreignKeys };
}

/** 单元格值 → SQL 字面量（导出 INSERT 脚本用）。 */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 导出为 Markdown 表格（Navicat 的「导出为文档」）。 */
export function toMarkdown(columns: string[], rows: unknown[][]): string {
  const escape = (v: unknown): string => {
    const text = v === null || v === undefined ? 'NULL' : String(v);
    return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  };
  const header = `| ${columns.map(escape).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(escape).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}

/** 导出为 JSON（Navicat 的「导出为 JSON」）。 */
export function toJson(columns: string[], rows: unknown[][]): string {
  const items = rows.map((row) => {
    const item: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      item[column] = row[index];
    });
    return item;
  });
  return JSON.stringify(items, null, 2);
}

/** 导出为 SQL INSERT 脚本。 */
export function toInsertScript(table: string, columns: string[], rows: unknown[][]): string {
  const columnList = columns.map(quoteIdent).join(', ');
  const values = rows.map((row) => `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${row.map(sqlLiteral).join(', ')});`);
  return [`-- 表：${table}`, `-- 行数：${rows.length}`, ...values].join('\n');
}
