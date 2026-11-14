/**
 * DevWork 数据层完整性验证 —— QA「严过关」
 *
 * **hermetic**：不再读开发机的 `backend/.runtime/data/devwork.sqlite`，
 * 而是在系统临时目录里用**产品自己的建库入口 `initDatabase()`** 建一份干净库再校验。
 *
 * 为什么要改（旧版三个问题）：
 *   ① 干净 checkout 上 .runtime 不存在 → `fs.statSync(DB)` 直接抛堆栈，不是"某条断言失败"；
 *   ② 开发机上的库可能是旧版本建的 → "库陈旧"和"代码缺表"分不开，红也判不出原因；
 *   ③ 表数量写死「25」，加了 8 张表后永久红 → 一个永远红的闸门等于没有闸门。
 *
 * 为什么表集合断言**不能**自己 `exec(schema.sql)` 再和 `schema.sql` 比：
 * 那是同义反复，永远绿。这里走 `initDatabase()`（真实建库：PRAGMA + schema + seed）
 * 再叠加启动期的 `dropLegacyAccountTables()`，断言的是「产品跑起来之后库里到底有哪些表」。
 *
 * 运行：`npx tsx tests/db-integrity.ts`（要 import 后端的 .ts 模块，所以必须过 tsx；
 * 与 `test:shadow:core` 同一形态）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_FILE = path.join(ROOT, 'backend', 'src', 'db', 'schema.sql');

let passed = 0;
let failed = 0;
function check(name, expected, actual, ok, note = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
  if (note) console.log(`       备注: ${note}`);
  if (ok) passed += 1; else failed += 1;
}

/**
 * 双向差集：把「声明的表」与「库里真实的表」分别算出缺与多。
 *
 * 单独抽成纯函数是为了能**反证它真的会失败**（见文末自检）——
 * 一个从没红过的断言，没人知道它是有效还是恒真。
 *
 * 另注：`dropLegacyAccountTables()` 会 DROP 4 张**不在 schema.sql 里**的表
 * （app_user / role_capability / member / policy）。它们不在期望集合里，
 * 所以"库里多出这 4 张"时本断言会报 `多余:` —— 那不是 schema 写错了，
 * 是遗留表没清掉。看到这条先查 dropLegacyAccountTables 是否被执行过。
 *
 * @param {string[]} expected 来自 schema.sql
 * @param {string[]} actual 来自 sqlite_master（已排除 sqlite_% 与 index_fts*）
 * @returns {{ missing: string[], extra: string[], ok: boolean }}
 */
function diffTableSets(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((name) => !actualSet.has(name)).sort();
  const extra = [...actualSet].filter((name) => !expectedSet.has(name)).sort();
  return { missing, extra, ok: missing.length === 0 && extra.length === 0 };
}

/** 从 schema.sql 抽表名全集（只认 CREATE TABLE IF NOT EXISTS）。 */
function declaredTables() {
  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  return [...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)]
    .map((match) => match[1])
    .sort();
}

/* 临时数据目录必须在 import 后端模块**之前**设好：
 * backend/src/config.ts 在模块加载期就把 DEVWORK_DATA_DIR 读成常量。 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devwork-qa-'));
process.env.DEVWORK_DATA_DIR = path.join(tmp, 'data');
process.env.DEVWORK_SANDBOX_DIR = path.join(tmp, 'sandbox');
/* 用**内置** schema：DEVWORK_SCHEMA_PATH 是产品运行期变量（打包态已剔除），
 * 拿它给测试注入 schema 会把"测试机制"和"产品行为"绑死。 */
delete process.env.DEVWORK_SCHEMA_PATH;

let database = null;
try {
  /* 动态 import：tsx 已注册 TS loader，这里拿到的是产品真实模块（不是复制品）。 */
  const dbModule = await import('../backend/src/db/database.ts');
  const { initDatabase, dropLegacyAccountTables } = dbModule;
  /* FTS5 虚拟表**不在** schema.sql 里，由启动期的 ensureFtsTable() 建（index.ts:103）。
   * 断言要覆盖真实库形态，就必须把这一步也跑一遍 —— 否则"库里有 index_fts"这件事
   * 在测试里从来没被验证过。
   *
   * 注意区分（后来人容易误解）：**表集合断言不需要它** —— `diffTableSets` 的
   * actual 侧已经把 `index_fts*` 过滤掉了，所以即使不建 FTS，集合相等断言也照常成立。
   * 需要它的是下面那条 **FTS 专项断言**（否则必假红）。换句话说：
   * 「FTS 断言要手动建表」不代表「集合比较也有问题」。 */
  const { ensureFtsTable } = await import('../backend/src/services/indexer.ts');

  /* 空 seed：本测试只验结构与约束，不需要演示数据（也就不受 CLEAN 模式影响）。 */
  database = initDatabase(() => {});
  dropLegacyAccountTables();
  ensureFtsTable();

  const dataDir = process.env.DEVWORK_DATA_DIR;
  const dbFile = path.join(dataDir, 'devwork.sqlite');
  check(
    '由 initDatabase() 在临时目录建出真实库文件',
    '文件存在且 > 0 字节',
    `${dbFile}, size=${fs.existsSync(dbFile) ? fs.statSync(dbFile).size : 0}`,
    fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0,
    '不再读取开发机上的 backend/.runtime/data',
  );

  const allTables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => row.name)
    /* FTS5 的影子表（index_fts / _data / _idx / _content / _docsize / _config）
     * 由虚拟表自动创建，不属于业务表；单独一条断言核对它们在场。 */
    .filter((name) => !name.startsWith('index_fts'))
    .sort();

  /* ---- 主断言：schema.sql 声明集 ↔ 真实库集合，双向差集 ---- */
  const expectedTables = declaredTables();
  const diff = diffTableSets(expectedTables, allTables);
  check(
    'schema 表集合与 schema.sql 一致（双向差集）',
    `${expectedTables.length} 张（来自 backend/src/db/schema.sql）`,
    `${allTables.length} 张（来自 sqlite_master，已排除 sqlite_% 与 index_fts*）`,
    diff.ok,
    diff.ok
      ? `差集为空（无缺失、无多余）；库内 ${allTables.length} 张 = schema 声明 ${expectedTables.length} 张`
      : `缺少: ${diff.missing.join(', ') || '(无)'} ｜ 多余: ${diff.extra.join(', ') || '(无)'}`,
  );

  /* ---- FTS5：全文索引与影子表必须在场（知识库检索依赖它） ---- */
  const ftsTables = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'index_fts%'")
    .all()
    .map((row) => row.name)
    .sort();
  check(
    'FTS5 全文索引表与影子表齐备',
    'index_fts + 至少 5 张影子表',
    `${ftsTables.length} 张: ${ftsTables.join(', ') || '(无)'}`,
    ftsTables.includes('index_fts') && ftsTables.length >= 6,
  );

  /* ---- 审计 append-only：触发器在场 + 实测拒绝 UPDATE / DELETE ---- */
  const triggers = database
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
    .all()
    .map((row) => row.name);
  check(
    'audit_event 具备 append-only 触发器',
    '包含 audit_event_no_update 与 audit_event_no_delete',
    triggers.join(', ') || '(无)',
    triggers.includes('audit_event_no_update') && triggers.includes('audit_event_no_delete'),
  );

  const journal = database.prepare('PRAGMA journal_mode').get();
  check(
    '业务库 journal_mode = wal',
    'wal',
    String(journal?.journal_mode),
    String(journal?.journal_mode).toLowerCase() === 'wal',
  );

  /* 空库里先落一行探针（旧版靠"开发机库本来就有 2624 行审计"，那是环境依赖）。 */
  database.exec(
    "INSERT INTO audit_event (id, actor, action, created_at) VALUES ('qa-probe','QA','probe','2026-01-01T00:00:00.000Z')",
  );
  for (const [label, sql] of [
    ['UPDATE', "UPDATE audit_event SET actor = 'HACKED' WHERE id = 'qa-probe'"],
    ['DELETE', "DELETE FROM audit_event WHERE id = 'qa-probe'"],
  ]) {
    let error = '';
    try {
      database.exec(sql);
    } catch (caught) {
      error = String(caught?.message ?? caught);
    }
    check(
      `audit_event ${label} 被 append-only 拒绝`,
      '抛出含 "append-only" 的错误',
      error || '未抛错（数据被修改！）',
      /append-only/i.test(error),
    );
  }
  const probe = database.prepare("SELECT actor FROM audit_event WHERE id = 'qa-probe'").get();
  check('审计探针行内容未被篡改', "actor='QA'", `actor=${probe?.actor}`, probe?.actor === 'QA');

  /* ---- 反证：让断言真的失败一次，否则没人知道它是有效还是恒真 ---- */
  const fakeActual = allTables.filter((name) => name !== 'audit_event');
  const fakeDiff = diffTableSets(expectedTables, [...fakeActual, 'ghost_table']);
  check(
    '反证：库里少一张、多一张时断言必须报红并点名',
    "missing=['audit_event'] ｜ extra=['ghost_table']",
    `missing=[${fakeDiff.missing.join(', ')}] ｜ extra=[${fakeDiff.extra.join(', ')}]`,
    !fakeDiff.ok
      && fakeDiff.missing.length === 1 && fakeDiff.missing[0] === 'audit_event'
      && fakeDiff.extra.length === 1 && fakeDiff.extra[0] === 'ghost_table',
  );
} catch (error) {
  check('测试自身执行完成', '无异常', String(error?.stack ?? error), false);
} finally {
  try {
    if (database) database.close();
  } catch {
    /* 已关闭或从未打开 */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不阻塞结论 */
  }
}

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
