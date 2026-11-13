/**
 * DevWork 独立黑盒冒烟测试 —— QA「严过关」
 *
 * 仅使用 Node 22 内置模块（fetch / crypto / fs / path），零新增依赖。
 * 前置：`npm run serve` 已运行于 127.0.0.1:3001（或设置 DEVWORK_BASE）。
 * 运行：`node tests/smoke.mjs`
 * 退出码：0 = 全部通过；1 = 存在失败（每个用例都会打印「期望 vs 实际」）。
 *
 * 覆盖：构建产物 / 工作区隔离 / 身份与角色 / SQL 防火墙 / 命令黑白名单 /
 * 路径越界 / 终端会话上限 / 审计导出 / 只读开关 / 畸形请求 / V6 V8 V9 V10。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.DEVWORK_BASE ?? 'http://127.0.0.1:3001';
const API = `${BASE}/api`;

/* 数据 / 沙箱目录必须跟被测实例一致：隔离实例（npm run test:smoke）会把它们
 * 指到临时目录，测试里所有"落盘校验"才能对着同一个沙箱。 */
const DATA_DIR = process.env.DEVWORK_DATA_DIR ?? path.join(ROOT, 'backend', '.runtime', 'data');
const SANDBOX_DIR = process.env.DEVWORK_SANDBOX_DIR ?? path.join(ROOT, 'backend', '.runtime', 'sandbox');
const DEMO_DB = path.join(DATA_DIR, 'demo.sqlite');
const REPO_ROOT = path.join(SANDBOX_DIR, 'repos', 'order-service');
const TERMINAL_DIR = path.join(SANDBOX_DIR, 'terminal');

let passed = 0;
let failed = 0;
const failures = [];
const cleanup = [];

function check(group, name, expected, actual, ok, note = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${group} :: ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
  if (note) console.log(`       备注: ${note}`);
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push({ group, name, expected, actual, note });
  }
}

async function call(method, urlPath, body, headers = {}, timeoutMs = 20000) {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  try {
    const res = await fetch(API + urlPath, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    return { status: res.status, json, text, headers: res.headers };
  } catch (error) {
    return { status: 0, json: null, text: '', headers: null, error: String(error) };
  }
}

const dataOf = (r) => r?.json?.data;
const codeOf = (r) => r?.json?.error?.code ?? null;
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const short = (value, max = 220) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return (s ?? String(value)).slice(0, max);
};
/**
 * 模拟 curl / 非浏览器客户端「按字节」发送中文请求头。
 * fetch 的 header 值必须是 ByteString（码点 <= 255），所以先把 UTF-8 字节
 * 逐个映射成 Latin-1 字符；服务端 Node 会按 latin1 还原这些字节。
 */

function section(title) {
  console.log(`\n========== ${title} ==========`);
}

async function main() {
  /* ------------------------------------------------------------------ */
  section('A. 基础与静态产物');
  {
    const r = await call('GET', '/health');
    const d = dataOf(r);
    check('A', 'health 200 / driver / WAL', 'HTTP 200, ok:true, driver=node:sqlite, wal=true',
      `HTTP ${r.status}, ok=${r.json?.ok}, driver=${d?.driver}, wal=${d?.wal}`,
      r.status === 200 && r.json?.ok === true && d?.driver === 'node:sqlite' && d?.wal === true);
  }
  {
    const r = await call('GET', '/bootstrap?workspaceId=w-ops');
    check('A', 'bootstrap 返回 live', 'HTTP 200 且 data.apiMode=live',
      `HTTP ${r.status}, apiMode=${dataOf(r)?.apiMode}`,
      r.status === 200 && dataOf(r)?.apiMode === 'live');
  }
  {
    const r = await call('GET', '/workspaces');
    check('A', '工作区列表来自数据库', 'HTTP 200 且 >= 3 个工作区',
      `HTTP ${r.status}, count=${Array.isArray(dataOf(r)) ? dataOf(r).length : 'n/a'}`,
      r.status === 200 && Array.isArray(dataOf(r)) && dataOf(r).length >= 3);
  }
  {
    const res = await fetch(`${BASE}/`);
    const html = await res.text();
    const m = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/);
    check('A', '生产态首页由 Express 托管', 'HTTP 200 + text/html',
      `HTTP ${res.status}, type=${res.headers.get('content-type')}`,
      res.status === 200 && /text\/html/.test(res.headers.get('content-type') ?? ''));
    if (m) {
      const js = await fetch(`${BASE}${m[1]}`);
      check('A', '前端 JS 静态资源 200（同源）', `HTTP 200 且 ${m[1]}`,
        `HTTP ${js.status}, type=${js.headers.get('content-type')}`,
        js.status === 200);
    } else {
      check('A', '前端 JS 静态资源 200（同源）', 'index.html 中含 /assets/*.js',
        short(html), false);
    }
  }

  /* ------------------------------------------------------------------ */
  section('B. 工作区隔离与 404 边界');
  const bCases = [
    ['跨工作区访问资产 a-hive-meta?workspaceId=w-ops', 'GET', '/assets/a-hive-meta?workspaceId=w-ops', undefined, 409, 'E_WORKSPACE_MISMATCH'],
    ['同工作区访问资产 a-hive-meta?workspaceId=w-data', 'GET', '/assets/a-hive-meta?workspaceId=w-data', undefined, 200, null],
    ['未知 assetId', 'GET', '/assets/a-qa-not-exist', undefined, 404, 'E_NOT_FOUND'],
    ['未知 workspaceId', 'GET', '/workspaces/w-qa-not-exist', undefined, 404, 'E_NOT_FOUND'],
    ['未知 workspaceId 的侧栏', 'GET', '/sidebar?workspaceId=w-qa-not-exist', undefined, 404, 'E_NOT_FOUND'],
    ['未知 REST 端点', 'GET', '/qa-not-exist', undefined, 404, 'E_NOT_FOUND'],
    ['未知 assetId 的凭据子端点', 'GET', '/assets/a-qa-not-exist/credential', undefined, 404, 'E_NOT_FOUND'],
  ];
  for (const [name, method, p, body, status, code] of bCases) {
    const r = await call(method, p, body);
    const ok = r.status === status && (code === null || codeOf(r) === code);
    check('B', name, `HTTP ${status}${code ? ' + ' + code : ' + ok:true'}`,
      `HTTP ${r.status}, code=${codeOf(r)}, ok=${r.json?.ok}`, ok);
  }

  /* ------------------------------------------------------------------ */
  section('C. 请求头不参与裁决 / Agent 写拦截');
  {
    const r = await call('POST', '/assets/a-order-service/files/agent-write',
      { path: 'pom.xml', patch: 'QA forge' }, { 'X-DevWork-Actor': 'agent' });
    const d = dataOf(r);
    check('C', '伪造 X-DevWork-Actor: agent 不得放行 Agent 写', 'decision=deny, bytesWritten=0, diskChanged=false',
      `decision=${d?.decision}, bytesWritten=${d?.bytesWritten}, diskChanged=${d?.diskChanged}`,
      d?.decision === 'deny' && d?.bytesWritten === 0 && d?.diskChanged === false);
  }
  {
    const r = await call('POST', '/assets/a-order-service/files/save',
      { path: 'qa-actor-probe.txt', content: 'actor-probe' }, { 'X-DevWork-Actor': 'agent' });
    check('C', '伪造 actor 头不影响服务端推导（HTTP 恒 user，保存放行）', 'HTTP 200 且 diskChanged=true',
      `HTTP ${r.status}, diskChanged=${dataOf(r)?.diskChanged}, code=${codeOf(r)}`,
      r.status === 200 && dataOf(r)?.diskChanged === true);
    cleanup.push(() => { try { fs.rmSync(path.join(REPO_ROOT, 'qa-actor-probe.txt')); } catch { /* noop */ } });
  }

  /* ------------------------------------------------------------------ */
  section('D. 只读 SQL 防火墙（V3）');
  const demoBefore = sha(DEMO_DB);
  const sqlOk = [
    ['SELECT 1（自动 LIMIT）', 'SELECT 1', true, 1000],
    ['CTE 查询', 'WITH t AS (SELECT 1) SELECT * FROM t', true, 1000],
    ['LIMIT 5000 被压到 1000', 'SELECT * FROM "order" LIMIT 5000', false, 1000],
  ];
  for (const [name, sql, injected, limit] of sqlOk) {
    const r = await call('POST', '/assets/a-order-db-prod/sql/query', { sql, options: {} });
    const d = dataOf(r);
    const ok = r.status === 200 && d?.guard?.injected === injected && d?.guard?.appliedLimit === limit
      && d?.dbChecksumBefore === d?.dbChecksumAfter;
    check('D', name, `HTTP 200, injected=${injected}, appliedLimit=${limit}, 校验和前后一致`,
      `HTTP ${r.status}, injected=${d?.guard?.injected}, appliedLimit=${d?.guard?.appliedLimit}, checksumEqual=${d?.dbChecksumBefore === d?.dbChecksumAfter}`, ok);
  }
  const sqlReject = [
    ['引号内危险关键字', "SELECT 'DROP TABLE x'"],
    ['注释内危险关键字', 'SELECT 1 /* DROP */'],
    ['行注释内危险关键字', 'SELECT 1 -- DROP'],
    ['多语句 SELECT', 'SELECT 1; SELECT 2'],
    ['多语句 DROP', 'SELECT 1; DROP TABLE "order"'],
    ['UPDATE', 'UPDATE "order" SET amount = 0'],
    ['DELETE', 'DELETE FROM "order"'],
    ['ATTACH', "ATTACH DATABASE 'x' AS y"],
    ['PRAGMA', 'PRAGMA table_info("order")'],
    ['空语句', ''],
  ];
  for (const [name, sql] of sqlReject) {
    const r = await call('POST', '/assets/a-order-db-prod/sql/query', { sql, options: {} });
    check('D', `拒绝：${name}`, 'HTTP 422 + E_SQL_REJECTED，且 demo 库未被写入',
      `HTTP ${r.status}, code=${codeOf(r)}`,
      r.status === 422 && codeOf(r) === 'E_SQL_REJECTED');
  }
  {
    const huge = `SELECT '${'a'.repeat(200 * 1024)}'`;
    const r = await call('POST', '/assets/a-order-db-prod/sql/query', { sql: huge, options: {} }, {}, 30000);
    check('D', '200KB 超长语句不导致 500 / 进程崩溃', 'HTTP 200 或 422（非 5xx，非连接中断）',
      `HTTP ${r.status}, code=${codeOf(r)}`, r.status > 0 && r.status < 500);
  }
  {
    const start = Date.now();
    const r = await call('POST', '/assets/a-order-db-prod/sql/query', { sql: 'SELECT devwork_sleep(20000)', options: {} }, {}, 25000);
    check('D', '15s 查询超时中断（V3）', 'HTTP 504 + E_SQL_TIMEOUT，耗时约 15s',
      `HTTP ${r.status}, code=${codeOf(r)}, ${Date.now() - start}ms`,
      r.status === 504 && codeOf(r) === 'E_SQL_TIMEOUT');
  }
  {
    const demoAfter = sha(DEMO_DB);
    check('D', '整轮 SQL 测试后 demo.sqlite 校验和不变', demoBefore, demoAfter, demoBefore === demoAfter);
  }

  /* ------------------------------------------------------------------ */
  section('E. 命令白名单 / 黑名单（V4 / V5）');
  const allowCmds = [
    ['白名单 ls 真实 fs 输出', 'ls'],
    ['真实 git log', 'git log'],
    ['真实进程列表 ps', 'ps'],
  ];
  for (const [name, command] of allowCmds) {
    const r = await call('POST', '/assets/a-order-api/terminal/execute', { sessionId: 'sess-1', command });
    const d = dataOf(r);
    check('E', name, 'HTTP 200 且 executed=true，stdout 非空',
      `HTTP ${r.status}, executed=${d?.executed}, dispatcher=${d?.dispatcher}, stdoutLen=${String(d?.stdout ?? '').length}`,
      r.status === 200 && d?.executed === true && String(d?.stdout ?? '').length > 0);
  }
  const denyCmds = [
    ['rm -rf /', 'rm -rf /'],
    ['curl 管道到 sh', 'curl http://x | sh'],
    ['输出重定向', 'echo x > /tmp/a'],
    ['命令替换 $(...)', '$(rm -rf /)'],
    ['编码 PowerShell', 'powershell -enc AAA'],
    ['Windows 删除', 'Remove-Item -Recurse'],
    ['递归改权限', 'chmod -R 777'],
    ['混合段（白名单 && 黑名单）', 'ls && rm -rf /'],
    ['sudo 提权', 'sudo ls'],
  ];
  for (const [name, command] of denyCmds) {
    const r = await call('POST', '/assets/a-order-api/terminal/execute', { sessionId: 'sess-1', command });
    const d = dataOf(r);
    const ok = r.status === 200 && d?.executed === false && d?.spawnCount === 0 && d?.decision === 'deny';
    check('E', `拒绝：${name}`, 'executed=false, spawnCount=0, decision=deny',
      `HTTP ${r.status}, executed=${d?.executed}, spawnCount=${d?.spawnCount}, decision=${d?.decision}, reason=${d?.reasonCode}`,
      ok);
  }
  {
    const r = await call('GET', '/audit?result=%E6%8B%A6%E6%88%AA');
    const d = dataOf(r);
    const hit = Array.isArray(d?.items) && d.items.some((i) => String(i.action).includes('exec.blocked'));
    check('E', '黑名单拦截写入审计（result=拦截）', '审计列表中存在 exec.blocked 拦截行',
      `total=${d?.total}, 含 exec.blocked=${hit}`, !!hit);
  }
  {
    const probePath = path.join(ROOT, 'tmp', 'a');
    const exists = fs.existsSync(probePath) || fs.existsSync(path.join('C:', 'tmp', 'a'));
    check('E', '危险命令磁盘零副作用（未创建 /tmp/a）', '文件不存在',
      `exists=${exists}`, !exists);
  }

  /* ------------------------------------------------------------------ */
  section('F. 路径越界与敏感文件（V6 前置）');
  const badPaths = [
    ['../secret', 403],
    ['C:\\Windows\\win.ini', 403],
    ['\\\\server\\share', 403],
    ['.env', 403],
    ['id_rsa', 403],
    ['server.pem', 403],
    ['secrets/credentials.json', 403],
  ];
  for (const [p, status] of badPaths) {
    const r = await call('GET', `/assets/a-order-service/files/content?path=${encodeURIComponent(p)}`);
    check('F', `拒绝路径 ${p}`, `HTTP ${status} + E_PATH_ESCAPE/E_SENSITIVE_FILE`,
      `HTTP ${r.status}, code=${codeOf(r)}`,
      r.status === status && ['E_PATH_ESCAPE', 'E_SENSITIVE_FILE'].includes(codeOf(r)));
  }
  {
    const r = await call('GET', '/assets/a-order-service/files/content?path=pom.xml');
    check('F', '合法仓库内文件可读', 'HTTP 200 且 plain 非空',
      `HTTP ${r.status}, plainLen=${String(dataOf(r)?.plain ?? '').length}`,
      r.status === 200 && String(dataOf(r)?.plain ?? '').length > 0);
  }
  {
    const r = await call('GET', '/assets/a-order-service/files/tree');
    const paths = Array.isArray(dataOf(r)) ? dataOf(r).map((n) => String(n.path)) : [];
    const leaked = paths.filter((p) => /\.(env|pem|key|p12|pfx|jks|keystore)|id_rsa|credentials|secrets\//i.test(p));
    check('F', '文件树不含敏感文件', '敏感路径 0 条',
      `共 ${paths.length} 条，敏感=${JSON.stringify(leaked)}`, leaked.length === 0);
  }

  /* ------------------------------------------------------------------ */
  section('G. 终端会话上限（设计文档 2027 行：最多 5 个）');
  // B7 修复后 terminal/sessions* 已接入 requireAssetId：未知 assetId 一律 404，
  // 不能再用不存在的 assetId 造会话（旧 G 组正是耦合了修复前的未校验行为）。
  // 改用真实资产 a-order-api：先记录既有会话，连续创建至触发上限，
  // 断言「总会话数达 5 后第 6 个被拒」，即恰在第 (6 - 既有数) 次 POST 返回 409。
  const probeAsset = 'a-order-api';
  const beforeSess = await call('GET', `/assets/${probeAsset}/terminal/sessions`);
  const existingIds = (Array.isArray(dataOf(beforeSess)) ? dataOf(beforeSess) : []).map((s) => String(s.id));
  const created = [];
  let first409 = -1;
  for (let i = 1; i <= 6; i += 1) {
    const r = await call('POST', `/assets/${probeAsset}/terminal/sessions`, {});
    created.push({ i, status: r.status, code: codeOf(r), id: dataOf(r)?.id });
    if (r.status === 409 && first409 === -1) first409 = i;
  }
  const expect409At = Math.max(6 - existingIds.length, 1);
  check('G', '第 6 个会话返回 409（按既有会话折算）',
    `恰在第 ${expect409At} 次返回 409 + E_TERMINAL_SESSION_LIMIT，且此前均 200`,
    `已有=${existingIds.length}, 实际第${first409}次 HTTP ${created[first409 - 1]?.status}, code=${created[first409 - 1]?.code}`,
    first409 === expect409At
      && created[first409 - 1]?.status === 409
      && created[first409 - 1]?.code === 'E_TERMINAL_SESSION_LIMIT'
      && created.slice(0, first409 - 1).every((c) => c.status === 200));
  {
    const r = await call('GET', `/assets/${probeAsset}/terminal/sessions`);
    const count = Array.isArray(dataOf(r)) ? dataOf(r).length : -1;
    check('G', '会话数不超过 5', '<= 5', `count=${count}`, count >= 0 && count <= 5);
  }
  cleanup.push(async () => {
    // 只回收本组创建的会话记录；真实资产的 sandbox/terminal 目录与既有会话一律不动。
    for (const c of created) {
      if (c.id) await call('DELETE', `/assets/${probeAsset}/terminal/sessions/${encodeURIComponent(c.id)}`, {});
    }
  });

  /* ------------------------------------------------------------------ */
  section('H. 审计：筛选 / 导出前写审计 / CSV 编码（V10）');
  {
    const r = await call('GET', '/audit');
    check('H', '审计列表可查询', 'HTTP 200 + items 数组 + total',
      `HTTP ${r.status}, total=${dataOf(r)?.total}`, r.status === 200 && Array.isArray(dataOf(r)?.items));
  }
  for (const [key, value] of [['action', 'exec.blocked'], ['result', '%E6%8B%A6%E6%88%AA'], ['actor', 'Agent']]) {
    const r = await call('GET', `/audit?${key}=${value}`);
    const items = Array.isArray(dataOf(r)?.items) ? dataOf(r).items : [];
    const wanted = decodeURIComponent(value).toLowerCase();
    const allMatch = items.length === 0 || items.every((i) => {
      if (key === 'result') return i.result === '拦截';
      return String(i[key] ?? '').toLowerCase().includes(wanted);
    });
    check('H', `4 维筛选：${key}=${decodeURIComponent(value)}`, '返回项全部匹配该维度',
      `total=${dataOf(r)?.total}, returned=${items.length}, allMatch=${allMatch}`, allMatch);
  }
  {
    const before = await call('GET', '/audit?action=audit.export');
    const r = await call('POST', '/audit/export', {});
    const after = await call('GET', '/audit?action=audit.export');
    const d = dataOf(r);
    check('H', '导出前先 INSERT audit.export', '导出后 audit.export 计数 +1，且返回 auditId',
      `before=${dataOf(before)?.total}, after=${dataOf(after)?.total}, auditId=${d?.auditId}`,
      dataOf(after)?.total === dataOf(before)?.total + 1 && !!d?.auditId);
    const content = String(d?.content ?? '');
    check('H', 'CSV 含 UTF-8 BOM', 'content 以 \\uFEFF 开头',
      `firstCode=U+${content.codePointAt(0)?.toString(16).toUpperCase()}`, content.codePointAt(0) === 0xFEFF,
      'Excel 打开中文 CSV 需要 BOM；设计文档未明确规定，按本次验收点核对');
    check('H', 'CSV 使用 CRLF 换行', 'content 含 \\r\\n',
      `hasCRLF=${content.includes('\r\n')}`, content.includes('\r\n'),
      '设计文档未明确规定，按本次验收点核对');
    check('H', 'POST 导出结果包含 audit.export 自身行', 'content 含 "audit.export"',
      `contains=${content.includes('audit.export')}`, content.includes('audit.export'));
  }
  {
    // client.ts: exportAuditCsv(query) 是 POST /audit/export + body=query；服务端 auditRows 只读 req.query
    const all = await call('POST', '/audit/export', {});
    const bodyFiltered = await call('POST', '/audit/export', { action: 'exec.blocked' });
    const queryFiltered = await call('POST', '/audit/export?action=exec.blocked', {});
    const allText = String(dataOf(all)?.content ?? '');
    const bodyText = String(dataOf(bodyFiltered)?.content ?? '');
    const queryText = String(dataOf(queryFiltered)?.content ?? '');
    const bodyApplied = bodyText.length < allText.length && !bodyText.includes('"sql.query');
    check('H', 'POST /audit/export 的 body 筛选参数生效', 'body 筛选后行数减少且不含 sql.query 行（与 query 筛选等价）',
      `全部=${allText.length}字符, body筛选=${bodyText.length}字符, query筛选=${queryText.length}字符, body生效=${bodyApplied}`,
      bodyApplied,
      'client.ts 用 POST + body 传 AuditQuery；若服务端只读 req.query，则导出筛选失效');
  }

  /* ------------------------------------------------------------------ */
  section('I. 只读开关前后 permission-probe（V7）');
  const settings0 = await call('GET', '/settings');
  const perm0 = dataOf(settings0)?.raw?.perm ?? {};
  const probeBody = { actor: 'agent', action: 'exec.read', risk: 'medium' };
  {
    const r1 = await call('PATCH', '/settings/perm', { readOnlyMode: false });
    const eff = await call('GET', '/effective-policy');
    check('I', '仅切换 readOnlyMode=false 即可关闭只读', 'effectivePolicy.readOnlyMode=false',
      `PATCH HTTP ${r1.status}, readOnlyMode=${dataOf(eff)?.readOnlyMode}, orgForceReadOnly=${dataOf(eff)?.orgForceReadOnly}`,
      dataOf(eff)?.readOnlyMode === false,
      'readOnlyMode() = raw.readOnlyMode || raw.orgForceReadOnly；seed 默认 orgForceReadOnly=true');
  }
  {
    await call('PATCH', '/settings/perm', { readOnlyMode: false, orgForceReadOnly: false });
    const off = await call('POST', '/settings/permission-probe', probeBody);
    await call('PATCH', '/settings/perm', { readOnlyMode: true, orgForceReadOnly: true });
    const on = await call('POST', '/settings/permission-probe', probeBody);
    const offD = dataOf(off);
    const onD = dataOf(on);
    check('I', '同参数 probe 在开关前后结果不同', 'OFF=allow, ON=suggest（或相反），且都带 serverLogId',
      `OFF=${offD?.decision}(${offD?.serverLogId ? 'hasLogId' : 'noLogId'}), ON=${onD?.decision}(${onD?.serverLogId ? 'hasLogId' : 'noLogId'})`,
      offD?.decision !== onD?.decision && !!offD?.serverLogId && !!onD?.serverLogId);
  }
  {
    /* 写操作的安全不变式是「永不自动执行」，不是「一律 deny」：
     * 高风险走审批（ask，executable=false），其余拒绝并转建议（deny）。
     * 两条都必须可执行=false，任何一条变成 allow 就是安全缺陷。 */
    const high = await call('POST', '/settings/permission-probe', { actor: 'agent', action: 'file.write', risk: 'high' });
    const highD = dataOf(high);
    check('I', 'Agent 高风险写 → 审批而非执行', 'decision=ask 且 constraints.executable=false',
      `decision=${highD?.decision}, executable=${highD?.constraints?.executable}`,
      highD?.decision === 'ask' && highD?.constraints?.executable === false);

    const mid = await call('POST', '/settings/permission-probe', { actor: 'agent', action: 'file.write', risk: 'medium' });
    const midD = dataOf(mid);
    check('I', 'Agent 中风险写 → 拒绝转建议', 'decision=deny 且带 suggestion',
      `decision=${midD?.decision}, suggestion=${midD?.suggestion ? 'has' : 'none'}`,
      midD?.decision === 'deny' && !!midD?.suggestion);

    const anyAllow = [highD, midD].some((d) => d?.decision === 'allow');
    check('I', 'Agent 写操作永不自动放行', '两个 risk 级别的 decision 均不为 allow',
      `high=${highD?.decision}, medium=${midD?.decision}`, !anyAllow);
  }
  cleanup.push(async () => {
    await call('PATCH', '/settings/perm', {
      readOnlyMode: perm0.readOnlyMode,
      orgForceReadOnly: perm0.orgForceReadOnly,
      workspaceTrust: perm0.workspaceTrust,
      allowManualWrite: perm0.allowManualWrite,
    });
  });

  /* ------------------------------------------------------------------ */
  section('J. 畸形请求健壮性（不应 500 / 不应退出）');
  const malformed = [
    ['缺 body 的 SQL 查询', 'POST', '/assets/a-order-db-prod/sql/query', undefined, {}],
    ['非法 JSON', 'POST', '/assets/a-order-db-prod/sql/query', '{"bad":', {}],
    ['错误 content-type', 'POST', '/assets/a-order-db-prod/sql/query', '{"sql":"SELECT 1"}', { 'Content-Type': 'text/plain' }],
    ['数组作为 body', 'POST', '/assets/a-order-db-prod/sql/query', '[1,2,3]', {}],
    ['path 为对象类型', 'GET', '/assets/a-order-service/files/content?path=x', undefined, {}],
    ['save 缺 path/content', 'POST', '/assets/a-order-service/files/save', {}, {}],
  ];
  for (const [name, method, p, body, headers] of malformed) {
    const r = await call(method, p, body, headers);
    check('J', name, 'HTTP < 500 且后端仍存活（非 5xx / 非连接中断）',
      `HTTP ${r.status}, code=${codeOf(r)}, error=${short(r.error ?? '', 60)}`,
      r.status > 0 && r.status < 500);
  }
  {
    const r = await call('GET', '/health');
    check('J', '畸形请求后后端仍健康', 'HTTP 200',
      `HTTP ${r.status}`, r.status === 200);
  }

  /* ------------------------------------------------------------------ */
  section('K. V6：Agent 写 100% denied / user 保存真实落盘');
  const target = path.join(REPO_ROOT, 'pom.xml');
  const beforeSha = sha(target);
  {
    const r = await call('POST', '/assets/a-order-service/files/agent-write', { path: 'pom.xml', patch: 'QA-MUTATE' });
    const d = dataOf(r);
    check('K', 'Agent 写被拒且磁盘零变更', 'decision=deny, bytesWritten=0, diskChanged=false, 文件 sha256 不变',
      `decision=${d?.decision}, bytesWritten=${d?.bytesWritten}, diskChanged=${d?.diskChanged}, shaEqual=${sha(target) === beforeSha}`,
      d?.decision === 'deny' && d?.bytesWritten === 0 && d?.diskChanged === false && sha(target) === beforeSha);
  }
  {
    const rel = 'qa-smoke-probe.txt';
    const file = path.join(REPO_ROOT, rel);
    const content = 'QA smoke save\n';
    const r = await call('POST', '/assets/a-order-service/files/save', { path: rel, content });
    const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    check('K', 'user 保存真实落盘并写审计', `bytesWritten=${Buffer.byteLength(content)}, diskChanged=true, 读回内容一致, auditId 存在`,
      `HTTP ${r.status}, bytesWritten=${dataOf(r)?.bytesWritten}, diskChanged=${dataOf(r)?.diskChanged}, onDisk=${onDisk === content}, auditId=${!!dataOf(r)?.auditId}`,
      r.status === 200 && dataOf(r)?.bytesWritten === Buffer.byteLength(content)
        && dataOf(r)?.diskChanged === true && onDisk === content && !!dataOf(r)?.auditId);
    cleanup.push(() => { try { fs.rmSync(file); } catch { /* noop */ } });
  }

  /* ------------------------------------------------------------------ */
  section('L. V8：一次提问产出完整轨迹并落库');
  {
    const content = 'QA 独立验证 GMV 归因';
    const r = await call('POST', '/conversations/c-gmv/messages', { content, assetIds: [] }, {}, 30000);
    const d = dataOf(r);
    const kinds = Array.isArray(d?.messages) ? d.messages.map((m) => m.kind) : [];
    const needed = ['bubble', 'plan', 'tool_row', 'notice'];
    const missing = needed.filter((k) => !kinds.includes(k));
    check('L', '返回计划 / 工具行 / 降级说明', `kinds 覆盖 ${needed.join(',')}`,
      `kinds=${JSON.stringify(kinds)}, missing=${JSON.stringify(missing)}, intent=${d?.intent}, gateway=${d?.gateway}`,
      missing.length === 0);
    /* P0-1 反幻觉回归：未接入模型时绝不能产出结论与虚构产物。 */
    const forbidden = ['conclusion', 'artifact'].filter((k) => kinds.includes(k));
    check('L', '未接入模型时不得产出结论 / 产物', 'kinds 不含 conclusion / artifact',
      `forbidden=${JSON.stringify(forbidden)}`, forbidden.length === 0);
    check('L', '引用落库且带真实源文件定位', 'citations>0，且每条都有 path + startLine',
      `citations=${d?.citations?.length}, located=${(d?.citations ?? []).filter((c) => c.path && c.startLine).length}`,
      Array.isArray(d?.citations) && d.citations.length > 0
        && d.citations.every((c) => !!c.path && Number(c.startLine) > 0));
    const after = await call('GET', '/conversations/c-gmv/messages');
    const stored = Array.isArray(dataOf(after)) ? dataOf(after) : [];
    const found = stored.some((m) => m.content === content) && stored.some((m) => m.kind === 'tool_row');
    check('L', '卡片全部落库可回放', 'GET messages 含本次提问与 tool_row',
      `stored=${stored.length}, found=${found}`, found);
  }

  /* ------------------------------------------------------------------ */
  section('M. V9：未绑定凭据返回「需绑定凭据」');
  {
    const r = await call('GET', '/assets/a-order-db-prod/credential');
    check('M', '未绑定资产状态为 unbound', 'state=unbound',
      `state=${dataOf(r)?.state}`, dataOf(r)?.state === 'unbound');
  }
  {
    const r = await call('POST', '/conversations/c-gmv/messages', { content: '查询 GMV 订单状态分布', assetIds: [] }, {}, 30000);
    const cards = Array.isArray(dataOf(r)?.messages) ? dataOf(r).messages : [];
    /* 凭据校验按工具所属资产进行：pg_sql_query 应报「需绑定凭据」，
     * 而 kb_search 不该被数据库凭据挡死（P0-4 回归）。 */
    const sqlRow = cards.find((m) => m.kind === 'tool_row' && m.payload?.toolName === 'pg_sql_query');
    const sqlResult = String(sqlRow?.payload?.result ?? '');
    check('M', 'SQL 工具结果为「需绑定凭据」而非连接异常', 'pg_sql_query 行含「需绑定凭据」且 status=失败',
      `status=${sqlRow?.payload?.status}, result=${short(sqlResult, 120)}`,
      sqlRow?.payload?.status === '失败' && sqlResult.includes('\u9700\u7ed1\u5b9a\u51ed\u636e'));
    const kbRow = cards.find((m) => m.kind === 'tool_row' && m.payload?.toolName === 'kb_search');
    const kbResult = String(kbRow?.payload?.result ?? '');
    check('M', '知识库检索不被数据库凭据挡死', 'kb_search 行不含「需绑定凭据」',
      `status=${kbRow?.payload?.status}, result=${short(kbResult, 120)}`,
      !!kbRow && !kbResult.includes('\u9700\u7ed1\u5b9a\u51ed\u636e'));
  }
  /* ------------------------------------------------------------------ */
  /* ------------------------------------------------------------------ */
  section('O. 文件夹写链路 / 资产接入 / 知识库详情（P1-6 / P1-7 / 知识库页）');
  {
    /* 1) 新建顶层文件夹 */
    const created = await call('POST', '/folders', { workspaceId: 'w-ops', kind: 'asset', name: 'QA-目录' });
    const folderId = String(dataOf(created)?.id ?? '');
    check('O', '新建文件夹返回 depth=1', 'HTTP 200 + depth=1 + parentId=null',
      `HTTP ${created.status}, depth=${dataOf(created)?.depth}, parentId=${dataOf(created)?.parentId}`,
      created.status === 200 && dataOf(created)?.depth === 1 && dataOf(created)?.parentId === null);

    /* 2) 子文件夹（第二层允许） */
    const sub = await call('POST', '/folders', { workspaceId: 'w-ops', kind: 'asset', name: 'QA-子目录', parentId: folderId });
    const subId = String(dataOf(sub)?.id ?? '');
    check('O', '子文件夹允许（depth=2）', 'HTTP 200 + depth=2',
      `HTTP ${sub.status}, depth=${dataOf(sub)?.depth}`,
      sub.status === 200 && dataOf(sub)?.depth === 2);

    /* 3) 第三层必须被服务端挡住 */
    const deep = await call('POST', '/folders', { workspaceId: 'w-ops', kind: 'asset', name: 'QA-孙目录', parentId: subId });
    check('O', '第三层目录被拒（depth ≤ 2）', 'HTTP 400 + E_VALIDATION',
      `HTTP ${deep.status}, code=${codeOf(deep)}`,
      deep.status === 400 && codeOf(deep) === 'E_VALIDATION');

    /* 4) 折叠状态持久化：PATCH 后 sidebar 里 open 必须是 false */
    await call('PATCH', `/folders/${encodeURIComponent(folderId)}`, { collapsed: true });
    const sideCollapsed = await call('GET', '/sidebar?workspaceId=w-ops');
    const folderNow = (dataOf(sideCollapsed)?.assetFolders ?? []).find((f) => f.id === folderId);
    check('O', '折叠状态落库（sidebar open=false）', 'open=false 且 subFolders 含 1 个子文件夹',
      `open=${folderNow?.open}, subs=${(folderNow?.subFolders ?? []).length}`,
      folderNow?.open === false && (folderNow?.subFolders ?? []).length === 1);

    /* 5) 重命名 */
    await call('PATCH', `/folders/${encodeURIComponent(folderId)}`, { name: 'QA-目录-改名' });
    const sideRenamed = await call('GET', '/sidebar?workspaceId=w-ops');
    const renamed = (dataOf(sideRenamed)?.assetFolders ?? []).find((f) => f.id === folderId);
    check('O', '文件夹重命名生效', 'sidebar 中名称变为「QA-目录-改名」',
      `name=${renamed?.name}`, renamed?.name === 'QA-目录-改名');

    /* 6) 删除父级：子文件夹上提到父级（不跟着删） */
    const removed = await call('DELETE', `/folders/${encodeURIComponent(folderId)}`);
    const sideAfter = await call('GET', '/sidebar?workspaceId=w-ops');
    const topLevelIds = (dataOf(sideAfter)?.assetFolders ?? []).map((f) => f.id);
    check('O', '删除父文件夹后子文件夹上提到根', '返回 movedToParentId=null 且子文件夹成为顶层',
      `movedToParentId=${dataOf(removed)?.movedToParentId}, 顶层含子目录=${topLevelIds.includes(subId)}`,
      dataOf(removed)?.movedToParentId === null && topLevelIds.includes(subId));
    cleanup.push(async () => { await call('DELETE', `/folders/${encodeURIComponent(subId)}`); });

    /* 7) 资产接入：新建即 idle + 未绑定凭据，副标题真实落库 */
    const asset = await call('POST', '/assets', {
      workspaceId: 'w-ops', type: 'db', name: 'QA-订单库', env: 'staging',
      subtitle: 'PG 15 · 只读账号', endpoint: '127.0.0.1:5432/order_db',
    });
    const assetId = String(dataOf(asset)?.id ?? '');
    const readback = await call('GET', `/assets/${encodeURIComponent(assetId)}`);
    check('O', '新建资产不谎报 online', 'status=idle 且回读 subtitle 一致',
      `status=${dataOf(readback)?.status}, subtitle=${dataOf(readback)?.subtitle}`,
      dataOf(asset)?.status === 'idle' && dataOf(readback)?.subtitle === 'PG 15 · 只读账号');
    const sideAsset = await call('GET', '/sidebar?workspaceId=w-ops');
    const leaf = (dataOf(sideAsset)?.looseAssets ?? []).find((a) => a.id === assetId);
    check('O', '未绑定凭据的资产显示未绑定状态', 'status=nb（灰点）而不是 ok',
      `status=${leaf?.status}`, leaf?.status === 'nb');
    cleanup.push(async () => { await call('DELETE', `/assets/${encodeURIComponent(assetId)}`); });

    /* 8) 知识库文档清单：文档与行数必须能对上磁盘真实文件 */
    const docs = await call('GET', '/assets/a-kb/documents');
    const files = dataOf(docs)?.files ?? [];
    const onDisk = files.filter((f) => fs.existsSync(path.join(REPO_ROOT, String(f.path))));
    const lineOk = files.every((f) => {
      const abs = path.join(REPO_ROOT, String(f.path));
      if (!fs.existsSync(abs)) return false;
      const total = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
      return Number(f.lines) === total;
    });
    check('O', '知识库文档清单对齐磁盘', '文件均存在且行数与磁盘一致',
      `documents=${dataOf(docs)?.documents}, chunks=${dataOf(docs)?.chunks}, 磁盘命中=${onDisk.length}/${files.length}, 行数一致=${lineOk}`,
      files.length >= 2 && onDisk.length === files.length && lineOk);

    /* 9) 检索命中必须带真实 path / startLine，才能点回原文 */
    const hits = await call('GET', '/assets/a-kb/search?q=GMV');
    const located = (dataOf(hits) ?? []).filter((h) => h.kind === 'doc' && h.path && Number(h.startLine) >= 1);
    const first = located[0];
    const firstAbs = first ? path.join(REPO_ROOT, String(first.path)) : '';
    const lineInRange = !!first && fs.existsSync(firstAbs)
      && Number(first.startLine) <= fs.readFileSync(firstAbs, 'utf8').split(/\r?\n/).length;
    check('O', '知识库命中带可点开的定位', '含 path + startLine 且行号在文件范围内',
      `hits=${(dataOf(hits) ?? []).length}, located=${located.length}, locator=${first?.locator ?? '—'}, 行号有效=${lineInRange}`,
      located.length > 0 && lineInRange);
  }

  /* ------------------------------------------------------------------ */
  section('P. 审批流闭环 / 能力授权生效 / 真实用量（P1-9 / P1-10）');
  {
    const conv = await call('POST', '/conversations', { workspaceId: 'w-ops', title: 'QA-审批链路' });
    const convId = String(dataOf(conv)?.id ?? '');
    cleanup.push(async () => {
      if (convId) await call('DELETE', `/conversations/${encodeURIComponent(convId)}`);
    });

    /* 1) 高风险写工具必须挂起为审批卡，而不是静默 deny 或假装执行 */
    const said = await call('POST', `/conversations/${encodeURIComponent(convId)}/messages`, {
      content: '你好，请介绍一下你能做什么',
    });
    const cards = dataOf(said)?.messages ?? [];
    const appr = cards.find((m) => m.kind === 'approval_card');
    const apprPayload = appr?.payload ?? {};
    check('P', '高风险写操作生成审批卡', 'approval_card 存在且 toolName=fs_truncate_log、executable=false',
      `kind=${appr?.kind}, toolName=${apprPayload.toolName}, status=${apprPayload.status}, executable=${apprPayload.executable}`,
      !!appr && apprPayload.toolName === 'fs_truncate_log'
        && apprPayload.status === '待审批' && apprPayload.executable === false);

    const pending = (dataOf(said)?.panels ?? {})?.execution?.pendingApprovals;
    check('P', '待审批项进入执行面板', 'pendingApprovals 数组非空且含 messageId',
      `pending=${Array.isArray(pending) ? pending.length : 'none'}`,
      Array.isArray(pending) && pending.length > 0 && !!pending[0]?.messageId);

    /* 2) 裁决必须真写审计、标记已裁决、且不执行 */
    const messageId = String(appr?.id ?? '');
    const decided = await call('POST', `/approvals/${encodeURIComponent(messageId)}`, { conversationId: convId, decision: 'approve' });
    const decidedData = dataOf(decided);
    check('P', '批准只记录裁决不执行', 'executed=false 且 diskChanged=false',
      `executed=${decidedData?.executed}, diskChanged=${decidedData?.diskChanged}`,
      decidedData?.executed === false && decidedData?.diskChanged === false);

    const auditId = String(decidedData?.auditId ?? '');
    const auditRow = auditId ? await call('GET', `/audit/${encodeURIComponent(auditId)}`) : null;
    check('P', '裁决写入审计表（auditId 可查）', 'GET /audit/:id 返回 action=approval.decide',
      `auditId=${auditId}, action=${dataOf(auditRow ?? {})?.action}`,
      !!auditRow && dataOf(auditRow)?.action === 'approval.decide');

    check('P', '原审批卡标记已裁决', 'resolvedCard.payload.resolved=true',
      `resolved=${decidedData?.resolvedCard?.payload?.resolved}`,
      decidedData?.resolvedCard?.payload?.resolved === true);

    /* 3) 重复裁决必须被挡（否则审计里会出现两条互相矛盾的记录） */
    const again = await call('POST', `/approvals/${encodeURIComponent(messageId)}`, { conversationId: convId, decision: 'deny' });
    check('P', '重复裁决被拒', 'HTTP 409 + E_ALREADY_RESOLVED',
      `HTTP ${again.status}, code=${codeOf(again)}`,
      again.status === 409 && codeOf(again) === 'E_ALREADY_RESOLVED');

    /* 4) 用量必须可解释：未接入模型时不得谎报型号，未配单价时成本必须为 0 */
    const usage = await call('GET', `/conversations/${encodeURIComponent(convId)}/usage`);
    const usageData = dataOf(usage) ?? {};
    check('P', '用量口径诚实', 'model=未接入模型、contextUsed>0、costCny=0（未配单价）',
      `model=${usageData.model}, contextUsed=${usageData.contextUsed}, costCny=${usageData.costCny}`,
      usageData.model === '\u672a\u63a5\u5165\u6a21\u578b' && Number(usageData.contextUsed) > 0 && Number(usageData.costCny) === 0);

    /* 5) 能力授权页的开关必须真的影响裁决（此前 action 名与能力名对不上，开关是装饰） */
    const before = await call('GET', '/assets/a-order-service/capabilities');
    const readCap = (dataOf(before) ?? []).find((c) => c.name === 'read');
    cleanup.push(async () => {
      if (readCap) {
        await call('PATCH', '/assets/a-order-service/capabilities/cap-a-order-service-0', { granted: readCap.granted });
      }
    });
    await call('PATCH', '/assets/a-order-service/capabilities/cap-a-order-service-0', { granted: false });
    const conv2 = await call('POST', '/conversations', { workspaceId: 'w-ops', title: 'QA-能力撤销' });
    const conv2Id = String(dataOf(conv2)?.id ?? '');
    cleanup.push(async () => {
      if (conv2Id) await call('DELETE', `/conversations/${encodeURIComponent(conv2Id)}`);
    });
    const said2 = await call('POST', `/conversations/${encodeURIComponent(conv2Id)}/messages`, {
      content: '你好，请介绍一下你能做什么',
    });
    const codeRow = (dataOf(said2)?.messages ?? []).find((m) => (m.payload ?? {}).toolName === 'code_search');
    check('P', '撤销能力后工具被拦截', 'code_search 行状态=已拦截 / kind=suggestion',
      `kind=${codeRow?.kind}, status=${codeRow?.payload?.status}, reason=${short(String(codeRow?.payload?.reason ?? ''), 40)}`,
      codeRow?.kind === 'suggestion' && codeRow?.payload?.status === '\u5df2\u62e6\u622a');
    await call('PATCH', '/assets/a-order-service/capabilities/cap-a-order-service-0', { granted: true });
  }

  /* ------------------------------------------------------------------ */
  section('Q. 审计分类/分页/导出 · 策略影响面 · 表结构按资产 · 清除缓存');
  {
    /* Q1 分类判定：permission.check · X 要先剥外壳再归类，否则命令执行桶里看不到被拦的 SQL。 */
    const all = await call('GET', '/audit?page=1&pageSize=1');
    const total = Number(dataOf(all)?.total ?? 0);
    check('Q', '审计总数是真实 COUNT（不是截断后的行数）', 'total > 20 且 page/pageSize 回显',
      `total=${total}, page=${dataOf(all)?.page}, size=${dataOf(all)?.pageSize}`,
      total > 20 && dataOf(all)?.page === 1 && dataOf(all)?.pageSize === 1);

    const cats = ['\u547d\u4ee4\u6267\u884c', '\u51ed\u636e\u8bbf\u95ee', '\u7b56\u7565\u53d8\u66f4', '\u6210\u5458\u53d8\u66f4', '\u5176\u4ed6'];
    let sum = 0;
    let consistent = true;
    const detail = [];
    for (const c of cats) {
      const r = await call('GET', `/audit?category=${encodeURIComponent(c)}&page=1&pageSize=50`);
      const items = dataOf(r)?.items ?? [];
      const n = Number(dataOf(r)?.total ?? 0);
      sum += n;
      const pure = items.every((item) => item.category === c);
      if (!pure) consistent = false;
      detail.push(`${c}=${n}`);
    }
    check('Q', '五个分类互斥且覆盖全量（含「其他」兜底桶非空）',
      '每类返回行 category 与筛选一致，且各类 total 之和 = 全量 total',
      `${detail.join(' ')} · sum=${sum} / total=${total}`,
      consistent && sum === total);

    /* Q2 分页：第 2 页与第 1 页不重叠；越界页返回空但 total 不变。 */
    const p1 = await call('GET', '/audit?page=1&pageSize=3');
    const p2 = await call('GET', '/audit?page=2&pageSize=3');
    const ids1 = (dataOf(p1)?.items ?? []).map((i) => i.id);
    const ids2 = (dataOf(p2)?.items ?? []).map((i) => i.id);
    const overlap = ids1.filter((id) => ids2.includes(id));
    const beyond = await call('GET', '/audit?page=9999&pageSize=3');
    check('Q', '审计分页在 SQL 层生效（无重叠 / 越界为空）',
      '第1页与第2页 id 无交集，page=9999 返回 0 行但 total 不变',
      `overlap=${overlap.length}, beyondRows=${(dataOf(beyond)?.items ?? []).length}, beyondTotal=${dataOf(beyond)?.total}`,
      overlap.length === 0 && (dataOf(beyond)?.items ?? []).length === 0 && Number(dataOf(beyond)?.total ?? 0) === total);

    /* Q3 导出口径：exported 只数命中记录，total 与之一致（除截断）。 */
    const exp = await call('POST', '/audit/export', { category: '\u6210\u5458\u53d8\u66f4' });
    const expData = dataOf(exp);
    check('Q', 'CSV 导出口径与筛选一致（exported=total，且含元信息行）',
      'exported 等于该类 total，content 含 audit.export 自身行',
      `exported=${expData?.exported}, total=${expData?.total}, hasMeta=${String(expData?.content ?? '').includes('audit.export')}`,
      typeof expData?.exported === 'number' && expData.exported === expData.total
        && String(expData.content).includes('audit.export'));

    /* Q5 表结构按资产：非 db 资产 422，未知资产 404，db 资产自带共用库说明。 */
    const notDb = await call('GET', '/assets/a-order-api/sql/schema');
    const unknown = await call('GET', '/assets/nope/sql/schema');
    const dbSchema = await call('GET', '/assets/a-order-db-prod/sql/schema');
    const dbData = dataOf(dbSchema) ?? {};
    check('Q', 'SQL 表结构按资产校验（不再所有资产共用一份）',
      'server 资产 422 E_ASSET_NOT_DB / 未知资产 404 / db 资产 tables 非空且带 dbLabel',
      `notDb=${notDb.status}/${codeOf(notDb)}, unknown=${unknown.status}/${codeOf(unknown)}, tables=${(dbData.tables ?? []).length}, label=${short(String(dbData.dbLabel ?? ''), 24)}`,
      notDb.status === 422 && codeOf(notDb) === 'E_ASSET_NOT_DB'
        && unknown.status === 404
        && (dbData.tables ?? []).length > 0 && String(dbData.dbLabel ?? '').length > 0);

    /* Q6 清除缓存只删派生数据：会话 / 产物 / 索引 / 审计必须保留。 */
    const beforeConvs = (dataOf(await call('GET', '/conversations?workspaceId=w-ops')) ?? []).length;
    const cleared = await call('POST', '/maintenance/clear-cache');
    const clearedData = dataOf(cleared) ?? {};
    const afterConvs = (dataOf(await call('GET', '/conversations?workspaceId=w-ops')) ?? []).length;
    const auditAfter = await call('GET', '/audit?action=maintenance.clear-cache&page=1');
    check('Q', '清除缓存只删派生数据（会话/产物/索引/审计保留）',
      '响应含 clearedSnapshots/clearedUsage/kept，会话数前后一致，且写入 maintenance.clear-cache 审计',
      `snapshots=${clearedData.clearedSnapshots}, usage=${clearedData.clearedUsage}, kept=${(clearedData.kept ?? []).join('/')}, convs ${beforeConvs}->${afterConvs}, auditHits=${dataOf(auditAfter)?.total}`,
      typeof clearedData.clearedSnapshots === 'number'
        && Array.isArray(clearedData.kept)
        && clearedData.kept.includes('\u4f1a\u8bdd')
        && beforeConvs === afterConvs
        && Number(dataOf(auditAfter)?.total ?? 0) >= 1);
  }

  /* ------------------------------------------------------------------ */
  section('R. 输入框能力：技能登记表 / 模型覆盖 / @ 引用真实 chips');
  {
    /* R1 技能登记表：输入框「/ 技能」菜单的数据源。
     * 每项都必须带可插入的模板，且依赖的工具真实存在且为只读。 */
    const skills = await call('GET', '/skills');
    const list = dataOf(skills) ?? [];
    const allValid = list.length > 0 && list.every((skill) =>
      typeof skill.id === 'string' && skill.id
      && typeof skill.label === 'string' && skill.label
      && typeof skill.template === 'string' && skill.template.length > 10
      && Array.isArray(skill.tools) && skill.tools.length > 0
      && skill.tools.every((tool) => tool.readOnly === true));
    check('R', '技能登记表可读且每项模板/工具齐全（工具必须只读）',
      `HTTP 200，技能数 > 0，每项 template 非空且 tools 全部 readOnly`,
      `HTTP ${skills.status}, skills=${list.length}, sample=${short(JSON.stringify(list[0] ?? {}), 120)}`,
      skills.status === 200 && allValid);

    /* R2 @ 引用必须落到真实资产名：用户没挂载的资产不能出现在气泡 chip 上。 */
    const convList = dataOf(await call('GET', '/conversations?workspaceId=w-ops')) ?? [];
    const convId = convList[0]?.id ?? 'c-gmv';
    const assetRows = dataOf(await call('GET', '/assets?workspaceId=w-ops')) ?? [];
    const dbAsset = assetRows.find((asset) => asset.id === 'a-order-db-prod');
    const dbName = String(dbAsset?.name ?? '');
    const withAssets = await call('POST', `/conversations/${convId}/messages`, {
      content: '\u5e2e\u6211\u770b\u4e00\u4e0b @\u751f\u4ea7\u5e93',
      assetIds: ['a-order-db-prod'],
      attachments: [],
    });
    const cards = dataOf(withAssets)?.messages ?? [];
    const bubble = cards.find((card) => card.kind === 'bubble');
    const chips = bubble?.payload?.chips ?? [];
    check('R', '@ 引用 chip 来自真实挂载资产（不再写死生产库/运营知识库）',
      'chip 恰好 1 条且等于该资产在库里的真实名称',
      `HTTP ${withAssets.status}, chips=${short(JSON.stringify(chips), 80)}, assetName=${dbName}`,
      withAssets.status === 200 && chips.length === 1 && dbName.length > 0 && chips[0] === dbName);

    /* R3 模型覆盖：字段被接受、请求正常完成；未接入模型时如实标注，不伪造成生效。 */
    const keyStatus = dataOf(await call('GET', '/settings/llm-key')) ?? {};
    const withModel = await call('POST', `/conversations/${convId}/messages`, {
      content: '\u7528\u6307\u5b9a\u6a21\u578b\u770b\u4e00\u4e0b',
      assetIds: [],
      attachments: [],
      model: 'smoke-model-override',
    });
    const modelCards = dataOf(withModel)?.messages ?? [];
    const routing = modelCards.find((card) => card.kind === 'plan') ?? {};
    const usage = dataOf(await call('GET', `/conversations/${convId}/usage`)) ?? {};
    const keyReady = keyStatus.configured === true;
    check('R', '会话级模型覆盖被接受且如实反映生效模型',
      keyReady
        ? 'HTTP 200 且生效模型 = 覆盖值 smoke-model-override'
        : 'HTTP 200 且未接入模型时如实标注「未接入模型」（不伪造成生效）',
      `HTTP ${withModel.status}, keyConfigured=${keyStatus.configured}, usageModel=${usage.model}`,
      withModel.status === 200
        && (keyReady
          ? usage.model === 'smoke-model-override'
          : usage.model === '\u672a\u63a5\u5165\u6a21\u578b'));
  }

  /* R（续）动态模型列表：模型名写死会过时，列表以端点实拉为准，预设只作兜底。 */
  {
    /* R4 拉取失败 → 回落预设兜底并如实标注，不装作实拉。 */
    const fallbackList = dataOf(await call('POST', '/settings/llm-models', {
      baseUrl: 'http://127.0.0.1:1/v1', provider: 'custom',
    })) ?? {};
    check('R', '模型列表拉取失败 → 回落预设兜底并如实标注',
      'HTTP 200 + source=fallback + message 说明回落/失败',
      `source=${fallbackList.source}, message=${short(String(fallbackList.message ?? ''), 80)}`,
      fallbackList.source === 'fallback' && /回落|失败|未填写/.test(String(fallbackList.message ?? '')));

    /* R5 真打一个 OpenAI 兼容 /models 假端点：实拉、去重、字典序。 */
    const http = await import('node:http');
    const stub = http.createServer((req, res) => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm-zulu' }, { id: 'm-alpha' }, { id: 'm-alpha' }] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => { stub.listen(0, '127.0.0.1', resolve); });
    const liveList = dataOf(await call('POST', '/settings/llm-models', {
      baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, provider: 'custom',
    })) ?? {};
    stub.close();
    check('R', '模型列表端点实拉（GET /models）→ source=live 且去重排序',
      'source=live，models=[m-alpha, m-zulu]（去重 + 字典序）',
      `source=${liveList.source}, models=${JSON.stringify(liveList.models ?? [])}`,
      liveList.source === 'live'
        && Array.isArray(liveList.models)
        && liveList.models.length === 2
        && liveList.models[0] === 'm-alpha' && liveList.models[1] === 'm-zulu');

  }

  /* ------------------------------------------------------------------ */
  section('S. 资产绑定会话（代码库 / 数据 / 终端页唤起的会话）');
  {
    /* S1 建会话时带 assetId：绑定必须落库并回传，不能只停留在界面上。 */
    const created = await call('POST', '/conversations', {
      workspaceId: 'w-ops',
      title: '冒烟 · 资产会话',
      assetId: 'a-order-db-prod',
      assetType: 'db',
    });
    const createdData = dataOf(created) ?? {};
    const boundId = String(createdData.id ?? '');
    check('S', 'POST /conversations 带 assetId → 绑定落库并回传',
      'HTTP 200 + assetId=a-order-db-prod',
      `HTTP ${created.status}, assetId=${createdData.assetId}`,
      created.status === 200 && createdData.assetId === 'a-order-db-prod');

    /* S2 绑定是服务端事实：这一轮**没带** assetIds，绑定资产也必须被并进去。 */
    const boundTurn = await call('POST', `/conversations/${boundId}/messages`, {
      content: '看看这张表最近的数据',
      assetIds: [],
      attachments: [],
    });
    const boundBubble = (dataOf(boundTurn)?.messages ?? []).find((card) => card.kind === 'bubble');
    const boundChips = boundBubble?.payload?.chips ?? [];
    const assetRows = dataOf(await call('GET', '/assets?workspaceId=w-ops')) ?? [];
    const boundName = String(assetRows.find((asset) => asset.id === 'a-order-db-prod')?.name ?? '');
    check('S', '绑定资产在未显式指定 assetIds 时自动并入本轮上下文',
      '气泡 chip 含绑定资产的真实名称',
      `HTTP ${boundTurn.status}, chips=${short(JSON.stringify(boundChips), 80)}`,
      boundTurn.status === 200 && boundName.length > 0 && boundChips.includes(boundName));

    /* S3 会话列表（侧栏）要带绑定信息：前端据此打标、能认出一条资产会话。 */
    const sidebar = dataOf(await call('GET', '/sidebar?workspaceId=w-ops')) ?? {};
    const sidebarItems = [
      ...(sidebar.looseConvs ?? []),
      ...(sidebar.convFolders ?? []).flatMap((folder) => folder.items ?? []),
    ];
    const listed = sidebarItems.find((item) => item.id === boundId);
    check('S', '侧栏会话列表携带资产绑定信息（assetId / assetType）',
      '侧栏里能找到该会话，且 assetId=a-order-db-prod、assetType=db',
      `found=${!!listed}, assetId=${listed?.assetId}, assetType=${listed?.assetType}`,
      !!listed && listed.assetId === 'a-order-db-prod' && listed.assetType === 'db');

    /* 清理：这条会话是测试造的，不能留在用户库里。 */
    cleanup.push(async () => {
      await call('DELETE', `/conversations/${boundId}`);
    });
  }

  /* ------------------------------------------------------------------ */
  section('Z. 收尾：恢复测试数据 + 后端存活');
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch (error) { console.log(`       [cleanup warn] ${String(error)}`); }
  }
  {
    const r = await call('GET', '/health');
    check('Z', '全部测试结束后后端仍健康', 'HTTP 200',
      `HTTP ${r.status}`, r.status === 200);
  }

  console.log('\n========== 汇总 ==========');
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\n---------- 失败清单（期望 vs 实际） ----------');
    for (const f of failures) {
      console.log(`- [${f.group}] ${f.name}\n    期望: ${f.expected}\n    实际: ${f.actual}`);
    }
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error('[smoke] 脚本自身异常:', error);
  process.exitCode = 2;
});
