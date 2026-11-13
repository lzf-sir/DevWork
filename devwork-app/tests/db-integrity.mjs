/**
 * DevWork 数据层完整性验证 —— QA「严过关」
 *
 * 零新增依赖（node:sqlite / fs / os / path）。
 * 为避免污染真实数据，所有写操作都在「业务库副本」上进行；只读校验直接查副本。
 * 运行：`node tests/db-integrity.mjs`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'backend', '.runtime', 'data');
const DB = path.join(DATA, 'devwork.sqlite');
const DEMO = path.join(DATA, 'demo.sqlite');

let passed = 0;
let failed = 0;
function check(name, expected, actual, ok, note = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
  if (note) console.log(`       备注: ${note}`);
  if (ok) passed += 1; else failed += 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devwork-qa-'));
const copies = [];
for (const suffix of ['', '-wal', '-shm']) {
  const src = DB + suffix;
  if (fs.existsSync(src)) {
    const dst = path.join(tmp, `copy.sqlite${suffix}`);
    fs.copyFileSync(src, dst);
    copies.push(dst);
  }
}

try {
  check('业务库是真实文件（非内存 mock）', 'devwork.sqlite 存在且 > 0 字节',
    `${DB}, size=${fs.statSync(DB).size}`, fs.existsSync(DB) && fs.statSync(DB).size > 0);
  const wal = DB + '-wal';
  check('WAL 生效', '-wal 文件存在且 > 0 字节',
    `size=${fs.existsSync(wal) ? fs.statSync(wal).size : 0}`, fs.existsSync(wal) && fs.statSync(wal).size > 0);
  const demoMagic = fs.readFileSync(DEMO).subarray(0, 16).toString('utf8');
  check('demo.sqlite 是真实 SQLite 文件', 'magic = "SQLite format 3\\u0000"',
    JSON.stringify(demoMagic), demoMagic.startsWith('SQLite format 3'));

  const db = new DatabaseSync(path.join(tmp, 'copy.sqlite'));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const names = tables.map((r) => r.name);
  /* B18：FTS5 虚拟表（index_fts + 5 张影子表）不算业务表，排除后仍应恰好 25 张。 */
  const businessNames = names.filter((n) => !n.startsWith('index_fts'));
  check('schema 表数量为 25（不含 FTS 影子表）', '25 张业务表',
    `${businessNames.length} 张: ${names.join(', ')}`, businessNames.length === 25);

  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name").all().map((r) => r.name);
  check('audit_event 具备 append-only 触发器', '包含 audit_event_no_update 与 audit_event_no_delete',
    triggers.join(', '), triggers.includes('audit_event_no_update') && triggers.includes('audit_event_no_delete'));

  const journal = db.prepare('PRAGMA journal_mode').get();
  check('业务库 journal_mode = wal', 'wal', String(journal?.journal_mode), String(journal?.journal_mode).toLowerCase() === 'wal');

  const auditCount = db.prepare('SELECT COUNT(*) AS n FROM audit_event').get().n;
  check('审计表已有真实数据', '> 0 行', `${auditCount} 行`, Number(auditCount) > 0);

  // 在副本上实测 UPDATE / DELETE 被触发器拒绝
  db.exec("INSERT INTO audit_event (id, actor, action, created_at) VALUES ('qa-probe','QA','probe','2026-01-01T00:00:00.000Z')");
  for (const [label, sql] of [
    ['UPDATE', "UPDATE audit_event SET actor = 'HACKED' WHERE id = 'qa-probe'"],
    ['DELETE', "DELETE FROM audit_event WHERE id = 'qa-probe'"],
  ]) {
    let err = '';
    try { db.exec(sql); } catch (error) { err = String(error?.message ?? error); }
    check(`audit_event ${label} 被 append-only 拒绝`, '抛出含 "append-only" 的错误',
      err || '未抛错（数据被修改！）', /append-only/i.test(err));
  }
  const stillQa = db.prepare("SELECT actor FROM audit_event WHERE id = 'qa-probe'").get();
  check('副本中审计行内容未被篡改', "actor='QA'", `actor=${stillQa?.actor}`, stillQa?.actor === 'QA');
  db.close();
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
