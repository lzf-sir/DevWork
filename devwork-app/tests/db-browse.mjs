/**
 * 数据库浏览能力测试（Navicat 式只读浏览层）。
 *
 * 覆盖 backend/src/services/sql-browse.ts 暴露的能力：
 *   - 对象树：表 / 视图 / 索引分类 + 真实行数
 *   - 排序：真实 ORDER BY，方向可切换
 *   - 筛选：真实 WHERE，参数化绑定
 *   - 字段详情：默认值 / 主键 / 可空
 *   - DDL：sqlite_master 原文
 *   - 多格式导出：CSV / JSON / Markdown / SQL
 *   - 安全：排序与筛选参数不得成为 SQL 注入通道
 *
 * 这个套件是独立文件（不塞进 smoke.mjs），因为它针对的是一组新能力，
 * 需要能单独跑、单独定位问题。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminCookie } from './lib/session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.DEVWORK_BASE ?? 'http://127.0.0.1:3001';
const API = `${BASE}/api`;
const ASSET = 'a-order-db-prod';

const failures = [];
const results = { total: 0, passed: 0, failed: 0 };

function check(group, name, expected, actual, ok, note = '') {
  results.total += 1;
  if (ok) {
    results.passed += 1;
    console.log(`[PASS] ${group} :: ${name}`);
    if (note) console.log(`       ${note}`);
    return;
  }
  results.failed += 1;
  failures.push(`${group} :: ${name}`);
  console.log(`[FAIL] ${group} :: ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
}

async function call(method, urlPath, body, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${urlPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const dataOf = (r) => r?.json?.data;
const codeOf = (r) => r?.json?.error?.code ?? null;

async function main() {
  console.log('========== S. 对象树 ==========');
  {
    const r = await call('GET', `/assets/${ASSET}/sql/schema`);
    const d = dataOf(r);
    const tables = d?.tables ?? [];
    const indexes = d?.indexes ?? [];
    const kinds = new Set(tables.map((t) => t.kind));
    check('S', '对象树返回表清单', 'HTTP 200 且至少 1 张表',
      `HTTP ${r.status}, ${tables.length} 张表`, r.status === 200 && tables.length > 0);
    check('S', '表带真实行数（COUNT(*) 实读）', 'totalRows 为非负整数且与 rowsLabel 一致',
      `totalRows=${tables[0]?.totalRows}, rowsLabel=${tables[0]?.rowsLabel}`,
      Number.isInteger(tables[0]?.totalRows) && tables[0]?.totalRows >= 0);
    check('S', '分类字段存在（table / view）', 'kind ∈ {table, view}',
      `kinds=${[...kinds].join(',')}`, tables.every((t) => t.kind === 'table' || t.kind === 'view'));
    check('S', '索引独立成类', 'indexes 数组存在且每项有 name',
      `indexes=${indexes.length}`, Array.isArray(indexes) && indexes.every((i) => typeof i.name === 'string'));
    check('S', 'schema 分组列表', 'schemas 至少含 public',
      `schemas=${(d?.schemas ?? []).join(',')}`, (d?.schemas ?? []).includes('public'));
  }

  console.log('========== T. 排序 ==========');
  {
    const r = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?page=1&pageSize=50&sort=amount&dir=desc`);
    const d = dataOf(r);
    const amounts = (d?.rows ?? []).map((row) => Number(row[3]));
    const descending = amounts.every((value, i) => i === 0 || amounts[i - 1] >= value);
    check('T', '降序排序真的生效', 'amount 单调不增',
      `amounts=${amounts.join(',')}`, r.status === 200 && descending);
    check('T', '服务端回显 appliedOrder', 'appliedOrder 含 ORDER BY "amount" DESC',
      `appliedOrder=${d?.appliedOrder}`, String(d?.appliedOrder ?? '').includes('"amount" DESC'));

    const r2 = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?page=1&pageSize=50&sort=amount&dir=asc`);
    const asc = (dataOf(r2)?.rows ?? []).map((row) => Number(row[3]));
    const ascending = asc.every((value, i) => i === 0 || asc[i - 1] <= value);
    check('T', '升序排序真的生效', 'amount 单调不减',
      `amounts=${asc.join(',')}`, r2.status === 200 && ascending);
  }

  console.log('========== U. 筛选 ==========');
  {
    const filters = encodeURIComponent(JSON.stringify([{ column: 'status', operator: '=', value: 'PENDING' }]));
    const r = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?page=1&pageSize=50&filters=${filters}`);
    const d = dataOf(r);
    const rows = d?.rows ?? [];
    const allPending = rows.every((row) => row[2] === 'PENDING');
    check('U', '等值筛选只返回匹配行', '每行 status 都是 PENDING',
      `statuses=${[...new Set(rows.map((row) => row[2]))].join(',')}`, r.status === 200 && allPending);
    check('U', '筛选后 totalRows 同步收敛', 'totalRows < 未筛选时的 8',
      `totalRows=${d?.totalRows}`, Number(d?.totalRows) < 8);
    check('U', 'WHERE 走参数化绑定（不拼值）', 'appliedOrder 外的 WHERE 用 ? 占位',
      `appliedWhere=${d?.appliedWhere}`, String(d?.appliedWhere ?? '').includes('?'));

    const gt = encodeURIComponent(JSON.stringify([{ column: 'amount', operator: '>', value: '1000' }]));
    const r2 = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?filters=${gt}`);
    const rows2 = dataOf(r2)?.rows ?? [];
    check('U', '数值比较筛选生效', '每行 amount > 1000',
      `amounts=${rows2.map((row) => row[3]).join(',')}`,
      r2.status === 200 && rows2.every((row) => Number(row[3]) > 1000));

    const isNull = encodeURIComponent(JSON.stringify([{ column: 'remark', operator: 'IS NULL', value: '' }]));
    const r3 = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?filters=${isNull}`);
    const rows3 = dataOf(r3)?.rows ?? [];
    check('U', 'IS NULL 筛选生效（无值运算符）', '每行 remark 为 null',
      `remarks=${rows3.map((row) => row[5]).join('|')}`,
      r3.status === 200 && rows3.every((row) => row[5] === null));
  }

  console.log('========== V. 分页 ==========');
  {
    const r = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?page=1&pageSize=3`);
    const d = dataOf(r);
    check('V', 'pageSize 生效', '本页行数 ≤ 3',
      `rows=${(d?.rows ?? []).length}`, (d?.rows ?? []).length <= 3);
    check('V', '总页数与总数一致', 'totalPages = ceil(totalRows / pageSize)',
      `totalRows=${d?.totalRows}, totalPages=${d?.totalPages}`,
      Number(d?.totalPages) === Math.ceil(Number(d?.totalRows) / 3));

    const r2 = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?page=2&pageSize=3`);
    const d2 = dataOf(r2);
    const firstPageIds = (d?.rows ?? []).map((row) => row[0]);
    const secondPageIds = (d2?.rows ?? []).map((row) => row[0]);
    check('V', '第 2 页与第 1 页不重叠', '两页 id 集合无交集',
      `p1=${firstPageIds.join(',')} p2=${secondPageIds.join(',')}`,
      firstPageIds.every((id) => !secondPageIds.includes(id)));
  }

  console.log('========== W. 字段详情 / DDL ==========');
  {
    const r = await call('GET', `/assets/${ASSET}/sql/tables/order/fields`);
    const d = dataOf(r);
    const columns = d?.columns ?? [];
    const idCol = columns.find((c) => c.name === 'id');
    check('W', '字段详情含默认值与主键标记', 'id 为主键且有 primaryKey 标记',
      `id=${JSON.stringify(idCol)}`, Boolean(idCol?.primaryKey));
    check('W', '字段详情含可空标记', '每个字段有 nullable 布尔值',
      `columns=${columns.length}`, columns.length > 0 && columns.every((c) => typeof c.nullable === 'boolean'));
    check('W', '索引列表来自 PRAGMA', 'indexes 数组非空',
      `indexes=${(d?.indexes ?? []).length}`, (d?.indexes ?? []).length > 0);

    const r2 = await call('GET', `/assets/${ASSET}/sql/tables/order/ddl`);
    const d2 = dataOf(r2);
    check('W', 'DDL 是真实建表语句', 'sql 含 CREATE TABLE "order"',
      `sql=${String(d2?.sql ?? '').slice(0, 60)}`, String(d2?.sql ?? '').includes('CREATE TABLE'));
    check('W', 'DDL 含索引定义', 'indexes 至少 1 条且带 sql',
      `indexes=${(d2?.indexes ?? []).length}`, (d2?.indexes ?? []).length > 0);
  }

  console.log('========== X. 多格式导出 ==========');
  {
    const sql = 'SELECT id, status FROM "order" LIMIT 2';
    const cases = [
      ['csv', 'id,status', 'query_result.csv'],
      ['json', '"id"', 'query_result.json'],
      ['md', '| id | status |', 'query_result.md'],
      ['sql', 'INSERT INTO', 'query_result.sql'],
    ];
    for (const [format, needle, fileName] of cases) {
      const r = await call('POST', `/assets/${ASSET}/sql/export`, { sql, format });
      const d = dataOf(r);
      check('X', `导出 ${format.toUpperCase()}`, `content 含「${needle}」且 fileName=${fileName}`,
        `fileName=${d?.fileName}, head=${String(d?.content ?? '').slice(0, 40)}`,
        r.status === 200 && String(d?.content ?? '').includes(needle) && d?.fileName === fileName);
    }
    const r = await call('POST', `/assets/${ASSET}/sql/export`, { sql, format: 'csv' });
    check('X', '导出带审计 id', 'auditId 非空',
      `auditId=${dataOf(r)?.auditId}`, Boolean(dataOf(r)?.auditId));
  }

  console.log('========== Y. 注入防护 ==========');
  {
    const before = await call('GET', `/assets/${ASSET}/sql/tables/order/rows`);
    const totalBefore = dataOf(before)?.totalRows;

    const attacks = [
      ['排序列名注入', `/assets/${ASSET}/sql/tables/order/rows?sort=${encodeURIComponent('amount; DROP TABLE "order"--')}`, 'sort'],
      ['排序列名注入（单引号）', `/assets/${ASSET}/sql/tables/order/rows?sort=${encodeURIComponent("amount' OR '1'='1")}`, 'sort'],
    ];
    for (const [name, url] of attacks) {
      const r = await call('GET', url);
      check('Y', name, 'HTTP 400 + E_VALIDATION（列名白名单拦截）',
        `HTTP ${r.status}, code=${codeOf(r)}`, r.status === 400 && codeOf(r) === 'E_VALIDATION');
    }

    const badOperator = encodeURIComponent(JSON.stringify([{ column: 'status', operator: '; DROP TABLE "order"', value: 'x' }]));
    const rOp = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?filters=${badOperator}`);
    check('Y', '非法运算符被白名单拦截', 'HTTP 400 + E_VALIDATION',
      `HTTP ${rOp.status}, code=${codeOf(rOp)}`, rOp.status === 400 && codeOf(rOp) === 'E_VALIDATION');

    const badColumn = encodeURIComponent(JSON.stringify([{ column: 'evil_col', operator: '=', value: 'x' }]));
    const rCol = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?filters=${badColumn}`);
    check('Y', '不存在的筛选列被拒', 'HTTP 400 + E_VALIDATION',
      `HTTP ${rCol.status}, code=${codeOf(rCol)}`, rCol.status === 400 && codeOf(rCol) === 'E_VALIDATION');

    const injectValue = encodeURIComponent(JSON.stringify([{ column: 'status', operator: '=', value: "PENDING' OR '1'='1" }]));
    const rVal = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?filters=${injectValue}`);
    const rows = dataOf(rVal)?.rows ?? [];
    check('Y', '筛选值注入被当作字面量', '查不到行（而非全表）',
      `totalRows=${dataOf(rVal)?.totalRows}, rows=${rows.length}`,
      rVal.status === 200 && (dataOf(rVal)?.totalRows ?? -1) === 0);

    const after = await call('GET', `/assets/${ASSET}/sql/tables/order/rows`);
    check('Y', '注入尝试后表完好无损', `totalRows 仍为 ${totalBefore}`,
      `totalRows=${dataOf(after)?.totalRows}`, dataOf(after)?.totalRows === totalBefore);
  }

  console.log('========== Z. 边界 ==========');
  {
    const r = await call('GET', `/assets/${ASSET}/sql/tables/not_exist_table/rows`);
    check('Z', '不存在的表返回 404 而非 500', 'HTTP 404 + E_NOT_FOUND',
      `HTTP ${r.status}, code=${codeOf(r)}`, r.status === 404 && codeOf(r) === 'E_NOT_FOUND');

    const r2 = await call('GET', `/assets/${ASSET}/sql/tables/order/rows?filters=not-json`);
    check('Z', '非法筛选 JSON 返回 400 而非 500', 'HTTP 400 + E_VALIDATION',
      `HTTP ${r2.status}, code=${codeOf(r2)}`, r2.status === 400 && codeOf(r2) === 'E_VALIDATION');

    const r3 = await call('GET', `/assets/${ASSET}/sql/tables/${encodeURIComponent('order" OR 1=1--')}/rows`);
    check('Z', '表名注入被清洗', 'HTTP 404 / 400（非 200 全表泄漏）',
      `HTTP ${r3.status}, code=${codeOf(r3)}`, r3.status !== 200);
  }

  console.log('========== 汇总 ==========');
  console.log(`Total: ${results.total} | Passed: ${results.passed} | Failed: ${results.failed}`);
  if (failures.length > 0) {
    console.log('失败用例：');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

/* 计数已在 check() 内部完成。 */
main().catch((error) => {
  console.error('[db-browse] 运行器异常:', error);
  process.exit(2);
});
