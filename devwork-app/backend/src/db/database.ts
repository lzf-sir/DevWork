import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DEMO_DB_PATH, SCHEMA_PATH, ensureDirs } from '../config';
import { sqliteCtor } from './adapter';
import { canonicalActorName } from './names';

export type SqlValue = string | number | bigint | null | Uint8Array;

let businessDb: DatabaseSync | null = null;
let demoHandle: DatabaseSync | null = null;

/** 打开业务库并应用 WAL / 外键 / busy_timeout / 幂等 seed。 */
export function initDatabase(seed: () => void): DatabaseSync {
  ensureDirs();
  const Sqlite = sqliteCtor();
  const database = new Sqlite(DB_PATH);
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA foreign_keys=ON');
  database.exec('PRAGMA busy_timeout=5000');
  database.exec('PRAGMA synchronous=NORMAL');
  database.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  businessDb = database;
  seed();
  return database;
}

export function db(): DatabaseSync {
  if (!businessDb) throw new Error('数据库尚未初始化');
  return businessDb;
}

export function all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}

/** 执行写语句，返回受影响行数（条件插入需要靠它判断是否真的插入成功）。 */
export function run(sql: string, ...params: SqlValue[]): number {
  const result = db().prepare(sql).run(...params);
  return Number(result.changes ?? 0);
}

export function tx<T>(fn: () => T): T {
  const database = db();
  database.exec('BEGIN');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 幂等补列：老业务库在建表之后新增的字段用这里补上。
 * SQLite 的 CREATE TABLE IF NOT EXISTS 不会改已存在的表，缺列会让 INSERT 直接炸，
 * 所以每次启动都过一遍（PRAGMA table_info 查询成本可忽略）。
 */
export function ensureColumn(table: string, column: string, definition: string): void {
  const columns = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (columns.length === 0) return; // 表不存在时由 schema.sql 负责
  if (columns.some((c) => c.name === column)) return;
  run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

/**
 * 清理旧版本的账号 / 成员 / 角色 / 组织策略表。
 *
 * 账号体系与组织权限已整体移除，这些表不再有任何读写；留在库里就是
 * 「登录态残留」。只删用户体系表，业务数据（工作区 / 资产 / 会话 /
 * 消息 / 审计 / 索引等）一张不动。
 */
export function dropLegacyAccountTables(): void {
  const legacy = ['app_user', 'role_capability', 'member', 'policy'];
  legacy.forEach((table) => {
    const found = get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
      table,
    );
    if (!found || Number(found.n) === 0) return;
    run(`DROP TABLE IF EXISTS ${table}`);
    // eslint-disable-next-line no-console
    console.log(`[DevWork] 已移除旧用户体系表 ${table}`);
  });
}

/** 演示库只读连接（业务 SQL 查询专用）。 */
export function demoDb(): DatabaseSync {  if (!demoHandle) {
    const Sqlite = sqliteCtor();
    demoHandle = new Sqlite(DEMO_DB_PATH, { readOnly: true });
  }
  return demoHandle;
}

export function checksumFile(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 审计只追加；audit_event 上有 BEFORE UPDATE/DELETE 触发器强制 append-only。 */
export function writeAudit(event: {
  workspaceId?: string;
  conversationId?: string;
  actor: string;
  source?: 'user' | 'agent' | 'system';
  action: string;
  target?: string;
  result?: string;
  severity?: 'info' | 'warn' | 'critical';
  detail?: string;
  createdAtLabel?: string;
}): string {
  const id = newId('aud');
  run(
    `INSERT INTO audit_event
      (id,workspace_id,conversation_id,actor,source,action,target,result,severity,detail,created_at,created_at_label)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    event.workspaceId ?? 'w-ops',
    event.conversationId ?? '',
    canonicalActorName(event.actor),
    event.source ?? 'user',
    event.action,
    event.target ?? '',
    event.result ?? '放行',
    event.severity ?? 'info',
    event.detail ?? '',
    nowIso(),
    event.createdAtLabel ?? '刚刚',
  );
  return id;
}

/**
 * 一次性数据修复：早期版本把 UTF-8 字节按 latin1 写进了 audit_event.actor，
 * 显示为 'é»å¿è³' 之类乱码。审计表是 append-only，故在启动时短暂摘掉
 * UPDATE 触发器、原地规范中文显示名、随后立即重建触发器；修复后触发器仍存在，
 * 运行时任何 UPDATE / DELETE 依旧被 RAISE(ABORT,'append-only') 拒绝。
 */
export function normalizeAuditActors(): void {
  const database = db();
  const rows = all<{ id: string; actor: string }>('SELECT id, actor FROM audit_event');
  const fixes: Array<{ id: string; actor: string }> = [];
  rows.forEach((row) => {
    const canonical = canonicalActorName(row.actor);
    if (canonical !== row.actor) fixes.push({ id: row.id, actor: canonical });
  });
  if (fixes.length === 0) return;

  const updateTrigger = 'CREATE TRIGGER IF NOT EXISTS audit_event_no_update '
    + "BEFORE UPDATE ON audit_event BEGIN SELECT RAISE(ABORT, 'append-only'); END;";
  database.exec('DROP TRIGGER IF EXISTS audit_event_no_update');
  try {
    const statement = database.prepare('UPDATE audit_event SET actor = ? WHERE id = ?');
    fixes.forEach((fix) => statement.run(fix.actor, fix.id));
  } finally {
    database.exec(updateTrigger);
  }
  // eslint-disable-next-line no-console
  console.log(`[DevWork] 已规范 ${fixes.length} 条审计 actor 中文显示名（append-only 触发器已重建）`);
}

/** 关库前做 WAL checkpoint，避免 -wal 残留。 */
export function closeDatabase(): void {
  try {
    if (demoHandle) {
      demoHandle.close();
      demoHandle = null;
    }
    if (businessDb) {
      businessDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      // eslint-disable-next-line no-console
      console.log('[DevWork] WAL checkpoint(TRUNCATE) 完成 · -wal 已截断');
      businessDb.close();
      businessDb = null;
    }
  } catch {
    /* 关库失败不阻塞进程退出 */
  }
}
