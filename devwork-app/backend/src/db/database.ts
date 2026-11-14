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

/**
 * 事务包装。注意这里用的是 `BEGIN`（deferred），**不是** `BEGIN IMMEDIATE`。
 *
 * `node:sqlite` 是同步 API，单进程单线程内不存在语句交错，deferred 已经足够；
 * 改成 IMMEDIATE 只会提前拿写锁，对单进程无收益、对并发读却更苛刻。
 * （此前注释写成 BEGIN IMMEDIATE，与实际执行不符，容易让人误判锁行为。）
 */
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

/**
 * 一次性数据迁移的完成标记（存 `setting.migrations` 段，key 带版本号）。
 *
 * 为什么要它：`normalizeAuditActors` / `migrateCitations` / `migrateSourceReadPosition`
 * 都是**全表扫描**，而审计表 append-only 只增不减。每启动一次就扫一遍，
 * 一年后几十万行的库首启会明显变慢 —— 而这三个迁移早就没有可迁的东西了。
 *
 * key 自带版本号（如 `migrateCitations@1`）而不是布尔量：将来真需要再迁一次，
 * 换成 `@2` 就能重新跑，不用清库、也不用手工删标记。
 */
const MIGRATION_SECTION = 'migrations';

function migrationFlags(): Record<string, string> {
  const row = get<{ raw: string }>('SELECT raw FROM setting WHERE section = ?', MIGRATION_SECTION);
  if (!row) return {};
  try {
    const parsed = JSON.parse(String(row.raw)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    /* 标记本身坏了就当没迁过：重跑一次幂等迁移的代价远小于漏迁。 */
    return {};
  }
}

/** 该迁移是否已完成过。 */
export function migrationDone(key: string): boolean {
  return Boolean(migrationFlags()[key]);
}

/** 记下「这个迁移做完了」。幂等：重复调用只刷新时间戳。 */
export function markMigrationDone(key: string): void {
  const flags = { ...migrationFlags(), [key]: nowIso() };
  run(
    'INSERT INTO setting (section, raw) VALUES (?,?) ON CONFLICT(section) DO UPDATE SET raw = excluded.raw',
    MIGRATION_SECTION, JSON.stringify(flags),
  );
}

/**
 * 不属于任何单个工作区的审计事件（总开关 / 策略 / 运行期自检）的归属。
 *
 * 这类事件以前统一记默认工作区，多工作区下会让「按工作区筛审计」查出别的域的动作。
 * 记成 `global` 是诚实的：它确实是全局动作，不是任何一个工作区的事。
 */
export const AUDIT_GLOBAL_SCOPE = 'global';

/**
 * 审计只追加；audit_event 上有 BEFORE UPDATE/DELETE 触发器强制 append-only。
 *
 * `workspaceId` **必传**：此前缺省填默认工作区，多工作区场景下审计归属全错，
 * 「按工作区筛审计」查不出真实动作是谁的地盘。没有真实归属时传
 * `AUDIT_GLOBAL_SCOPE`（全局动作）或从资产 / 会话推导 —— 宁可标注「全局」，
 * 也不要伪装成某个具体工作区。
 */
export function writeAudit(event: {
  workspaceId: string;
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
  /* 归属为空 = 调用方确实定位不到资源（如资产已被删除）。
   * 在这里统一补一句 `workspace:unknown`：调用点有十几处，逐个补必然漏一个，
   * 而漏掉的那条会被报表读成「某个没写归属的工作区」。单点保证，不依赖自觉。 */
  const rawDetail = event.detail ?? '';
  const detail = event.workspaceId === '' && !rawDetail.includes('workspace:unknown')
    ? `${rawDetail}${rawDetail === '' ? '' : ' · '}workspace:unknown`
    : rawDetail;
  run(
    `INSERT INTO audit_event
      (id,workspace_id,conversation_id,actor,source,action,target,result,severity,detail,created_at,created_at_label)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    event.workspaceId,
    event.conversationId ?? '',
    canonicalActorName(event.actor),
    event.source ?? 'user',
    event.action,
    event.target ?? '',
    event.result ?? '放行',
    event.severity ?? 'info',
    detail,
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
 *
 * 这是一次性迁移：做完就落标记，之后每次启动直接跳过（审计表会一直增长，
 * 每天全表扫一遍换来的只是「确认没有乱码」）。
 */
const NORMALIZE_ACTORS_MIGRATION = 'normalizeAuditActors@1';

export function normalizeAuditActors(): void {
  if (migrationDone(NORMALIZE_ACTORS_MIGRATION)) {
    // eslint-disable-next-line no-console
    console.log('[DevWork] 审计 actor 规范化：迁移已完成，跳过');
    return;
  }
  const database = db();
  const rows = all<{ id: string; actor: string }>('SELECT id, actor FROM audit_event');
  const fixes: Array<{ id: string; actor: string }> = [];
  rows.forEach((row) => {
    const canonical = canonicalActorName(row.actor);
    if (canonical !== row.actor) fixes.push({ id: row.id, actor: canonical });
  });
  if (fixes.length === 0) {
    /* 没有可修的行也要落标记：否则下次启动仍然全表扫一遍。 */
    markMigrationDone(NORMALIZE_ACTORS_MIGRATION);
    return;
  }

  const updateTrigger = 'CREATE TRIGGER IF NOT EXISTS audit_event_no_update '
    + "BEFORE UPDATE ON audit_event BEGIN SELECT RAISE(ABORT, 'append-only'); END;";
  database.exec('DROP TRIGGER IF EXISTS audit_event_no_update');
  try {
    const statement = database.prepare('UPDATE audit_event SET actor = ? WHERE id = ?');
    fixes.forEach((fix) => statement.run(fix.actor, fix.id));
  } finally {
    database.exec(updateTrigger);
  }
  markMigrationDone(NORMALIZE_ACTORS_MIGRATION);
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
