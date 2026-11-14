/**
 * SqlWrite —— V2 写能力层的数据库 DML 通道（设计 §6.2 db_query_write）。
 *
 * 三层防线在数据层面的落点：
 * 1. 预检：单语句、首关键字 INSERT/UPDATE/DELETE、DDL 关键字一律拒绝、
 *    执行前把 demo.sqlite 整文件备份（回滚 = 恢复备份）；
 * 2. 执行：worker 内 BEGIN IMMEDIATE → 执行 → SELECT changes() → COMMIT；
 *    任一步失败 ROLLBACK；
 * 3. 校验：checksum 前后对比 + 备份文件留存。
 *
 * 与只读 runSqlQuery 的差异：读走 readOnly 连接 + 只读 guard；写必须显式走本模块，
 * 绝不允许把 DML 塞进只读通道。
 */
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_DB_PATH, DATA_DIR } from '../config';
import { checksumFile } from '../db/database';
import { ApiFailure } from '../http/core';
import { firstWordOf, hasTopLevelSemicolon, scanSql } from './sql-scan';

const DDL_KEYWORDS = [
  'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'ATTACH', 'DETACH', 'PRAGMA',
  'VACUUM', 'REINDEX', 'GRANT', 'REVOKE', 'MERGE',
];
const DML_FIRST_KEYWORDS = ['INSERT', 'UPDATE', 'DELETE'];

export interface SqlWriteResult {
  sql: string;
  affectedRows: number;
  backupPath: string;
  checksumBefore: string;
  checksumAfter: string;
  durationMs: number;
}

interface WriteWorkerReply {
  ok: boolean;
  changes?: number;
  message?: string;
}

const WRITE_WORKER_SOURCE = [
  "const { parentPort, workerData } = require('node:worker_threads');",
  "const { DatabaseSync } = require('node:sqlite');",
  'try {',
  "  const db = new DatabaseSync(workerData.dbPath);",
  "  db.exec('BEGIN IMMEDIATE');",
  '  try {',
  "    db.exec(workerData.sql);",
  "    const row = db.prepare('SELECT changes() AS n').get();",
  "    db.exec('COMMIT');",
  '    db.close();',
  '    parentPort.postMessage({ ok: true, changes: Number(row.n) });',
  '  } catch (e) {',
  "    try { db.exec('ROLLBACK'); } catch (e2) { /* 回滚失败也要上报原错误 */ }",
  '    try { db.close(); } catch (e3) { /* ignore */ }',
  "    parentPort.postMessage({ ok: false, message: String(e && e.message ? e.message : e) });",
  '  }',
  '} catch (error) {',
  "  parentPort.postMessage({ ok: false, message: String(error && error.message ? error.message : error) });",
  '}',
].join('\n');

function runWriteWorker(sql: string, timeoutMs: number): Promise<WriteWorkerReply> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WRITE_WORKER_SOURCE, { eval: true, workerData: { dbPath: DEMO_DB_PATH, sql } });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new ApiFailure('E_SQL_TIMEOUT', '写入超过超时上限，worker 已中断（事务由 worker 内 ROLLBACK 兜底）'));
    }, timeoutMs);
    worker.once('message', (reply: WriteWorkerReply) => {
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
  });
}

/** 写预检：单条 DML。首关键字判定顺序：DDL → 精确报 DDL 拒绝；非 DML → 拒绝。
 *
 * 判定只看代码区（字面量与注释里的内容是数据），执行用原文 ——
 * 早期版本用正则剥注释，把 `VALUES('<注释符>x<注释符>')` 里的内容吃掉了，
 * 且把剥完的结果直接当 SQL 执行，写进去的数据被静默篡改。
 */
export function precheckDml(raw: string): string {
  const statement = raw.trim();
  if (statement === '') throw new ApiFailure('E_SQL_REJECTED', 'SQL 不能为空');
  const scan = scanSql(statement);
  if (hasTopLevelSemicolon(scan.codeMask.replace(/;+\s*$/, ''))) {
    throw new ApiFailure('E_SQL_REJECTED', '写通道禁止多语句（单条 DML）');
  }
  const firstWord = firstWordOf(scan.codeMask);
  if (DDL_KEYWORDS.includes(firstWord)) {
    throw new ApiFailure('E_SQL_REJECTED', `写通道禁止 DDL：检测到 ${firstWord}`);
  }
  if (!DML_FIRST_KEYWORDS.includes(firstWord)) {
    throw new ApiFailure('E_SQL_REJECTED', `写通道仅允许 INSERT / UPDATE / DELETE（收到 ${firstWord || '空'}）`);
  }
  /* 语句体内出现 DDL 关键字（如列名/字符串里带 create）不再误杀——首关键字已判定为 DML。 */
  return scan.execStatement;
}

/** 备份保留份数：够回滚最近若干次即可，不保留全历史。 */
const BACKUP_KEEP = 20;

/**
 * 只保留最近 N 份备份（按 mtime 从新到旧）。
 *
 * 每次 DML 都整库拷贝一份，却从来没有清理 —— 用户连续改 500 次，磁盘上就是
 * 500 个 demo.sqlite。1.0 只需要「有界」：留 20 份足够覆盖「改错了要退回去」的实际窗口。
 */
function pruneBackups(backupDir: string, keep: number): void {
  try {
    const files = fs.readdirSync(backupDir)
      .filter((name) => name.startsWith('demo-') && name.endsWith('.sqlite'))
      .map((name) => {
        const absolute = path.join(backupDir, name);
        try {
          return { absolute, mtime: fs.statSync(absolute).mtimeMs };
        } catch {
          return { absolute, mtime: 0 };
        }
      })
      /* 新的排前面；mtime 相同（同一毫秒）时按文件名倒序，保证顺序稳定。 */
      .sort((left, right) => right.mtime - left.mtime || right.absolute.localeCompare(left.absolute));
    files.slice(Math.max(1, keep)).forEach((file) => {
      try { fs.unlinkSync(file.absolute); } catch { /* 删不掉不阻断写入 */ }
    });
  } catch {
    /* 清理失败不影响本次备份 / 写入 */
  }
}

/** 备份 demo 库（整文件拷贝）+ 有界保留。 */
function backupDemoDb(): string {
  const backupDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `demo-${Date.now()}.sqlite`);
  fs.copyFileSync(DEMO_DB_PATH, backupPath);
  pruneBackups(backupDir, BACKUP_KEEP);
  return backupPath;
}

/** 恢复备份（回滚路径：respondApproval rollback 端点调用）。 */
export function restoreDbBackup(backupPath: string): { restored: boolean } {
  if (!fs.existsSync(backupPath)) return { restored: false };
  fs.copyFileSync(backupPath, DEMO_DB_PATH);
  return { restored: true };
}

/** 执行单条 DML：precheck → 备份 → 事务执行 → checksum 校验。 */
export async function runSqlWrite(raw: string, timeoutMs = 10000): Promise<SqlWriteResult> {
  const sql = precheckDml(raw);
  const checksumBefore = checksumFile(DEMO_DB_PATH);
  const backupPath = backupDemoDb();
  const start = Date.now();
  const reply = await runWriteWorker(sql, timeoutMs);
  if (!reply.ok) {
    throw new ApiFailure('E_SQL_SYNTAX', `DML 执行失败（事务已回滚）：${reply.message ?? '未知错误'}`);
  }
  return {
    sql,
    affectedRows: reply.changes ?? 0,
    backupPath,
    checksumBefore,
    checksumAfter: checksumFile(DEMO_DB_PATH),
    durationMs: Date.now() - start,
  };
}
