/**
 * SqlQuery —— 在 worker_thread 内用只读连接执行（V3）。
 * 父进程 15s 超时 → worker.terminate() → E_SQL_TIMEOUT；
 * 演示库 sha256 前后必须一致；rows 使用原生 JSON 类型（null = SQL NULL，"" = 空串）。
 */
import { Worker } from 'node:worker_threads';
import { DEMO_DB_PATH, SQL_TIMEOUT_MS } from '../config';
import { checksumFile, newId, nowIso, run, writeAudit } from '../db/database';
import { ApiFailure } from '../http/core';
import { guard, type GuardResult } from './sql-guard';
import type { Identity } from '../http/core';

export interface SqlQueryResult {
  sql: string;
  guard: { injected: boolean; appliedLimit: number; notice: string };
  columns: { name: string; type: string; nullable: boolean }[];
  columnNames: string[];
  columnsSimple: string[];
  rows: unknown[][];
  rowCount: number;
  totalRows: number;
  truncated: boolean;
  durationMs: number;
  enumColumns: string[];
  nullColumns: string[];
  statusText: string;
  dbChecksumBefore: string;
  dbChecksumAfter: string;
  auditId: string;
}

interface WorkerPayload {
  dbPath: string;
  sql: string;
}

interface WorkerReply {
  ok: boolean;
  columns?: { name: string; type: string; nullable: boolean }[];
  names?: string[];
  rows?: unknown[][];
  message?: string;
}

/** eval worker：纯 CJS，不依赖 tsx 转译，避免 Vite externalize / Electron Node 20 问题。 */
const WORKER_SOURCE = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const { DatabaseSync } = require('node:sqlite');",
  'try {',
  "  const db = new DatabaseSync(workerData.dbPath, { readOnly: true });",
  '  try {',
  "    db.function('devwork_sleep', (ms) => { const end = Date.now() + Number(ms); while (Date.now() < end) {} return 0; });",
  '  } catch (e) { /* UDF 已存在则忽略 */ }',
  '  const stmt = db.prepare(workerData.sql);',
  '  const raw = stmt.all();',
  '  let cols = [];',
  '  try {',
  '    cols = stmt.columns().map((c) => ({ name: c.name, type: String(c.type || "TEXT"), nullable: true }));',
  '  } catch (e) { cols = []; }',
  '  const names = cols.length > 0 ? cols.map((c) => c.name) : Object.keys(raw[0] || {});',
  '  if (cols.length === 0) cols = names.map((n) => ({ name: n, type: "TEXT", nullable: true }));',
  '  const rows = raw.map((r) => names.map((n) => {',
  '    const v = r[n];',
  '    if (v === undefined) return null;',
  "    if (typeof v === 'bigint') return Number(v);",
  '    if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");',
  '    return v;',
  '  }));',
  '  db.close();',
  '  parentPort.postMessage({ ok: true, columns: cols, names: names, rows: rows });',
  '} catch (error) {',
  "  parentPort.postMessage({ ok: false, message: String(error && error.message ? error.message : error) });",
  '}',
].join('\n');

function executeInWorker(payload: WorkerPayload, timeoutMs: number): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: payload });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new ApiFailure('E_SQL_TIMEOUT', '查询超过 15s，已中断只读 worker'));
    }, timeoutMs);

    worker.once('message', (reply: WorkerReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(reply);
    });
    worker.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      reject(new ApiFailure('E_INTERNAL', error.message));
    });
    worker.once('exit', (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ApiFailure('E_INTERNAL', `SQL worker 异常退出 (${code})`));
    });
  });
}

function csvSafe(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string' && value.includes(',')) return `"${value.replace(/"/g, '""')}"`;
  return String(value);
}

/** 执行只读 SQL；DDL/DML/多语句抛 E_SQL_REJECTED，超时抛 E_SQL_TIMEOUT。 */
export async function runSqlQuery(
  raw: string,
  options: { maxRows?: number; timeoutMs?: number } | undefined,
  identity: Identity,
  assetId: string,
): Promise<SqlQueryResult> {
  const before = checksumFile(DEMO_DB_PATH);
  const maxRows = Math.min(options?.maxRows ?? 1000, 1000);
  const timeoutMs = Math.min(options?.timeoutMs ?? SQL_TIMEOUT_MS, SQL_TIMEOUT_MS);
  let guarded: GuardResult;
  try {
    guarded = guard(raw, maxRows);
  } catch (error) {
    const after = checksumFile(DEMO_DB_PATH);
    if (error instanceof ApiFailure) {
      const details = (error.details ?? {}) as Record<string, unknown>;
      throw new ApiFailure(error.code, error.message, {
        ...details, dbChecksumBefore: before, dbChecksumAfter: after,
      });
    }
    throw error;
  }

  const start = Date.now();
  const reply = await executeInWorker({ dbPath: DEMO_DB_PATH, sql: guarded.sql }, timeoutMs);
  if (!reply.ok) {
    /* 执行失败 ≠ 被安全策略拦截。两者用户动作完全不同（改 SQL vs 拆掉危险写法），
     * 必须用不同错误码，前端才能给出正确的提示与光标定位。 */
    throw new ApiFailure('E_SQL_SYNTAX', `SQL 执行失败：${reply.message ?? '未知错误'}`, {
      detected: [], statement: guarded.statement, multiStatement: false,
      dbChecksumBefore: before, dbChecksumAfter: checksumFile(DEMO_DB_PATH),
    });
  }

  const columns = reply.columns ?? [];
  const names = reply.names ?? columns.map((c) => c.name);
  const rows = reply.rows ?? [];
  const after = checksumFile(DEMO_DB_PATH);
  const durationMs = Date.now() - start;

  /* 慢查询留痕：只记超过阈值的，供 SQL 采集器产事件。
   *
   * 为什么不记全部：这张表若记录每一次查询，就会变成第二个审计日志，
   * 而巡检只关心「慢的那些」。阈值取 500ms 而采集器再筛 1500ms，
   * 是为了让「慢查询」的判定口径可以事后调整，不用改埋点重发版。 */
  if (durationMs >= 500) {
    try {
      run(
        'INSERT INTO sql_trace (id,asset_id,statement,duration_ms,row_count,created_at) VALUES (?,?,?,?,?,?)',
        newId('sqlt'), assetId, guarded.statement.slice(0, 500), durationMs, rows.length, nowIso(),
      );
    } catch {
      /* 埋点失败不能影响查询本身：观测是旁路，不是主链路。 */
    }
  }
  const nullColumns = names.filter((name, index) => rows.some((row) => row[index] === null));
  const enumColumns = names.filter((name) => /status|state|channel/i.test(name));
  const auditId = writeAudit({
    workspaceId: 'w-ops', actor: identity.name, source: 'user',
    action: `sql.query · ${guarded.statement.slice(0, 120)}`, target: assetId,
    result: '放行', severity: 'info',
    detail: `LIMIT=${guarded.guard.appliedLimit} injected=${guarded.guard.injected} rows=${rows.length} checksum=${before === after ? 'unchanged' : 'CHANGED'}`,
  });

  return {
    sql: guarded.sql,
    guard: guarded.guard,
    columns,
    columnNames: names,
    columnsSimple: names,
    rows,
    rowCount: rows.length,
    totalRows: rows.length,
    truncated: rows.length >= guarded.guard.appliedLimit,
    durationMs,
    enumColumns,
    nullColumns,
    statusText: `执行成功 · ${rows.length} 行 · ${durationMs}ms · 只读执行${guarded.guard.injected ? ' · 已自动追加 LIMIT 1000' : ''}`,
    dbChecksumBefore: before,
    dbChecksumAfter: after,
    auditId,
  };
}

/** SQL 结果导出 CSV（导出前写审计由路由负责，这里只负责序列化）。 */
export function toCsv(result: SqlQueryResult): string {
  return [result.columnNames.join(','), ...result.rows.map((row) => row.map(csvSafe).join(','))].join('\n');
}
