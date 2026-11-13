/**
 * T00 环境门禁。断言本机具备运行后端的最小条件；失败立即退出非 0。
 * 严禁 better-sqlite3 / sqlite3 / node-gyp：只用 Node 内置 node:sqlite。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const results = [];
let failed = false;

function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: String(detail) });
  if (!ok) failed = true;
}

function assertWritable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe);
  return true;
}

let driver = 'none';
let wal = false;
let readOnlyOk = false;
try {
  const { DatabaseSync } = await import('node:sqlite');
  check('node:sqlite DatabaseSync', typeof DatabaseSync === 'function', 'node:sqlite 可用 (Tier1)');
  const tmp = path.join(os.tmpdir(), `devwork-env-${process.pid}.sqlite`);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmp + suffix); } catch { /* 忽略 */ }
  }
  const db = new DatabaseSync(tmp);
  const mode = db.prepare('PRAGMA journal_mode=WAL').get();
  wal = mode && String(mode.journal_mode).toLowerCase() === 'wal';
  db.exec('CREATE TABLE IF NOT EXISTS t(a INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  db.close();
  const ro = new DatabaseSync(tmp, { readOnly: true });
  const row = ro.prepare('SELECT COUNT(*) AS n FROM t').get();
  readOnlyOk = Number(row.n) === 1;
  let enforced = false;
  try { ro.exec('DELETE FROM t'); } catch { enforced = true; }
  ro.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(tmp + suffix); } catch { /* 忽略 */ }
  }
  driver = 'node:sqlite';
  check('PRAGMA journal_mode=WAL', wal, `journal_mode=${mode?.journal_mode ?? 'unknown'}`);
  check('readOnly 连接可打开且拒绝写入', readOnlyOk && enforced, `readOnly=${readOnlyOk}, writeBlocked=${enforced}`);
} catch (error) {
  check('node:sqlite DatabaseSync', false, String(error.message ?? error));
  check('PRAGMA journal_mode=WAL', false, '未能创建数据库');
  check('readOnly 连接可打开且拒绝写入', false, '未能创建数据库');
}

try {
  const out = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  check('git 可用', true, out);
} catch (error) {
  check('git 可用', false, String(error.message ?? error));
}

let dockerAvailable = false;
let dockerDetail = 'docker 未安装（允许，命令执行会降级为 exitCode=127）';
try {
  dockerDetail = execFileSync('docker', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}
check('docker 探测（缺失不算失败）', true, dockerAvailable ? dockerDetail : dockerDetail);

const tasklistCandidates = ['C:/Windows/System32/tasklist.exe', 'C:/Windows/system32/tasklist.exe', '/c/Windows/System32/tasklist.exe'];
const tasklistFound = tasklistCandidates.some((p) => fs.existsSync(p));
check('tasklist.exe 存在（Windows ps 分派）', process.platform !== 'win32' || tasklistFound, process.platform === 'win32' ? `found=${tasklistFound}` : '非 Windows 平台，跳过');

for (const dir of ['data', 'sandbox', 'artifacts']) {
  const full = path.join(serverRoot, dir);
  try {
    assertWritable(full);
    check(`目录可写 server/${dir}`, true, full);
  } catch (error) {
    check(`目录可写 server/${dir}`, false, String(error.message ?? error));
  }
}

check('Node 版本 >= 22', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);

/* T06 新增门禁：electron 二进制下载（缺失不算失败，Web 模式仍可用）。 */
let electronBinary = false;
try {
  const electronDir = path.resolve(serverRoot, '..', 'node_modules', 'electron');
  const binary = process.platform === 'win32' ? 'electron.exe' : 'electron';
  electronBinary =
    fs.existsSync(path.join(electronDir, 'path.txt')) &&
    fs.existsSync(path.join(electronDir, 'dist', binary));
} catch {
  electronBinary = false;
}
check(
  'electron 二进制（缺失不算失败，Web 模式仍可用）',
  true,
  electronBinary ? 'electron 二进制就绪' : 'electron 未就绪，npm run dev:server + dev:client 的 Web 模式仍可用',
);

const summary = {
  driver,
  wal,
  readOnlyOk,
  dockerAvailable,
  electronBinary,
  node: process.versions.node,
  platform: process.platform,
  results,
};
console.log(JSON.stringify(summary, null, 2));
if (failed) {
  console.error('check:env FAILED');
  process.exit(1);
}
console.log('check:env PASS');
