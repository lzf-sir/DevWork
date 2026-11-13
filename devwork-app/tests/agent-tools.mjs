/**
 * Agent 工具派生管线 + V2 写能力层 测试（V9）。
 *
 * 覆盖三块（对应 devwork-asset-capability-design.md）：
 *   A. 派生管线：按工作区资产×能力×信任级别派生工具面（prod 写工具不存在而非 ask）；
 *   B. 七组只读工具真实执行 + V2 写工具三层防线（precheck→执行→校验→回滚）；
 *   C. 命令模板库（参数白名单化 / 无模板拒绝）+ 会话级审批记忆 + 连拒熔断；
 *   D. HTTP 集成：/api/tools、/api/skills、/api/cmd-templates 与审批卡真执行闭环。
 *
 * 用法：npm run test:agent-tools（独立端口 3012，隔离数据目录，不碰 3001 实例）。
 */
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installAuthFetch } from './lib/session.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUN_DIR = mkdtempSync(path.join(tmpdir(), 'devwork-agent-tools-'));
const DATA_DIR = path.join(RUN_DIR, 'data');
const SANDBOX_DIR = path.join(RUN_DIR, 'sandbox');
const PORT = Number(process.env.AGENT_TOOLS_PORT ?? 3012);
const BASE = `http://127.0.0.1:${PORT}`;

/* 登录体系：这个用例直接裸 fetch 十几个端点，统一包一层补会话 Cookie，
 * 用的是配置文件里默认管理员的真实登录会话（不是后门）。 */
installAuthFetch(BASE);

/* 必须在 import 被测模块之前设置：config.ts 在模块加载时读 env。 */
process.env.DEVWORK_DATA_DIR = DATA_DIR;
process.env.DEVWORK_SANDBOX_DIR = SANDBOX_DIR;
process.env.DEVWORK_PORT = String(PORT);
/* esbuild 打包后 import.meta.url 指向临时 bundle，config.ts 的相对锚点会漂移；
 * schema 路径显式指回源码（与 DATA_DIR 覆盖同一模式）。 */
process.env.DEVWORK_SCHEMA_PATH = path.join(ROOT, 'backend', 'src', 'db', 'schema.sql');

function bundle(entry, outfile) {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(ROOT, entry),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${outfile}`,
      '--log-level=warning',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  return import(pathToFileURL(outfile).href);
}

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  if (!ok && detail !== undefined) console.log('   detail =', detail);
};

const identity = { name: '测试员', role: 'admin', org: 'DevWork', actor: 'user', source: 'user' };
const mod = await bundle('tests/agent-tools-entry.ts', path.join(RUN_DIR, 'bundle.mjs'));

/* ================= 初始化（与 backend/src/index.ts 非 clean 模式一致） ================= */
mod.initDatabase(mod.seedIfEmpty);
mod.ensureAgentV9Assets();
mod.initDemoDatabase();
mod.initLogSink();
mod.bootstrapRepo();
mod.ensureFtsTable();
mod.runIndex('a-order-service');
mod.appendLog('INFO', 'agent-tools 测试日志行 A');
mod.appendLog('WARN', 'agent-tools 测试日志行 B');

/* ================= A. 派生管线 ================= */
console.log('\n--- A. 派生管线 ---');
{
  const face = mod.deriveToolFace('w-ops');
  const activeNames = face.active.map((tool) => tool.name);
  const allNames = face.all.map((tool) => tool.name);

  check('A1 七组只读工具全部派生（V9 资产补齐 log/api）',
    ['ws_list_assets', 'code_search', 'code_read', 'db_query', 'db_schema', 'kb_search', 'srv_status', 'srv_log_tail', 'log_query', 'api_spec_read', 'api_call_read']
      .every((name) => activeNames.includes(name)),
    activeNames.join(','));

  check('A2 V2 写工具按信任级别派生（code_edit/db_query_write/fs_write_file 在面内）',
    ['code_edit', 'db_query_write', 'fs_write_file'].every((name) => activeNames.includes(name)),
    activeNames.join(','));

  const srvExec = face.all.find((tool) => tool.name === 'srv_exec');
  check('A3 prod 资产的 srv_exec 被剪枝（gatedBy=prod-env，不存在而非 ask）',
    !!srvExec && srvExec.gatedBy === 'prod-env' && !activeNames.includes('srv_exec'),
    srvExec ? `gatedBy=${srvExec.gatedBy}` : 'missing');

  const dbQuery = face.active.find((tool) => tool.name === 'db_query');
  check('A4 db_query 绑定主实例 a-order-db-dev（在线且已绑凭据优先）',
    !!dbQuery && dbQuery.assetId === 'a-order-db-dev',
    dbQuery ? dbQuery.assetId : 'missing');

  check('A5 派生规则自描述（R1-R4）', face.derivationRules.length === 4);

  /* prod 工作区：写工具整组不派生（R3）。 */
  const prodFace = mod.deriveToolFace('w-data');
  check('A6 其他工作区派生不串味（w-data 无 log/api 资产 → 无 log_query/api 工具）',
    !prodFace.active.some((tool) => ['log_query', 'api_spec_read', 'srv_status'].includes(tool.name)),
    prodFace.active.map((tool) => tool.name).join(','));
}

/* ================= B. 七组只读工具真实执行 ================= */
console.log('\n--- B. 只读工具真实执行 ---');
{
  const face = mod.deriveToolFace('w-ops');
  const run = async (name, args) => {
    const tool = face.all.find((t) => t.name === name);
    const ctx = { assetId: tool?.assetId ?? '', workspaceId: 'w-ops', conversationId: 'c-test', identity };
    return mod.executeAgentTool(name, args, tool, ctx);
  };

  const assets = await run('ws_list_assets', {});
  check('B1 ws_list_assets 列出真实资产（含 V9 补插的 a-order-log）',
    assets.ok && assets.result.includes('a-order-log') && assets.result.includes('a-devwork-api'));

  const sql = await run('db_query', { sql: 'SELECT status, count(*) AS n FROM "order" GROUP BY status' });
  check('B2 db_query 真实查询（ok 且返回行数与采样）',
    sql.ok && /查询成功 · \d+ 行/.test(sql.result), sql.result.slice(0, 120));

  const schema = await run('db_schema', {});
  check('B3 db_schema 列出真实表清单', schema.ok && schema.result.includes('order'), schema.result.slice(0, 120));
  const schemaOne = await run('db_schema', { table: 'inventory' });
  check('B4 db_schema 单表结构含列与索引', schemaOne.ok && schemaOne.result.includes('stock'), schemaOne.result.slice(0, 150));

  const tables = await run('db_tables', {});
  check('B4b db_tables 行数画像（真实 COUNT，含 order 表）',
    tables.ok && /order：\d+ 行/.test(tables.result), tables.result.slice(0, 160));
  const tablesOne = await run('db_tables', { tables: 'inventory' });
  check('B4c db_tables 指定表计数', tablesOne.ok && /inventory：\d+ 行/.test(tablesOne.result), tablesOne.result.slice(0, 120));

  const todos = await run('code_todos', {});
  check('B6b code_todos 真实扫描（ok，结果可空但格式正确）',
    todos.ok && /扫到 \d+ 个标记|未扫到/.test(todos.result), todos.result.slice(0, 120));
  const todosCapped = await run('code_todos', { max: 3 });
  check('B6c code_todos max 参数生效（≤3 条）',
    todosCapped.ok && (() => { const m = /扫到 (\d+) 个/.exec(todosCapped.result); return !m || Number(m[1]) <= 3; })(),
    todosCapped.result.slice(0, 120));

  const kb = await run('kb_search', { query: 'GMV 口径' });
  check('B5 kb_search 真实索引检索', kb.ok && /命中 \d+ 个片段|未命中/.test(kb.result));

  const code = await run('code_search', { query: 'setConnectTimeout' });
  check('B6 code_search 真实索引检索', code.ok && /命中 \d+ 个片段/.test(code.result), code.result.slice(0, 120));

  const status = await run('srv_status', {});
  check('B7 srv_status 真实采集（CPU 核数 / 进程数）', status.ok && /CPU \d+ 核/.test(status.result));

  const tail = await run('srv_log_tail', { lines: 5 });
  check('B8 srv_log_tail 真实读日志文件', tail.ok && tail.result.includes('测试日志行'));

  const logQuery = await run('log_query', { query: '测试日志行', limit: 10 });
  check('B9 log_query 关键词检索命中 2 行', logQuery.ok && /命中 2 行/.test(logQuery.result), logQuery.result.slice(0, 150));

  const spec = await run('api_spec_read', {});
  check('B10 api_spec_read 返回真实端点规范', spec.ok && spec.result.includes('/api/health'));
  const apiDeny = await run('api_call_read', { path: '/api/audit' });
  check('B11 api_call_read 白名单外路径被拒（防副作用调用）',
    !apiDeny.ok && apiDeny.result.includes('不在只读规范清单内'), apiDeny.result.slice(0, 120));
  const apiHealth = await run('api_call_read', { path: '/api/health' });
  check('B12 api_call_read 白名单内端点真实 HTTP 调用（无服务时如实失败）',
    apiHealth.result.includes('HTTP') || apiHealth.result.includes('失败'), apiHealth.result.slice(0, 120));
}

/* ================= C1. 命令模板库 ================= */
console.log('\n--- C1. 命令模板库 ---');
{
  const match1 = mod.matchTemplate('restart_service');
  check('C1-1 意图精确匹配 restart_service', !!match1 && match1.id === 'restart-service');
  const match2 = mod.matchTemplate('帮我清理一下日志');
  check('C1-2 关键词模糊匹配（清理日志）', !!match2 && match2.id === 'rotate-log');
  const match3 = mod.matchTemplate('rm -rf /');
  check('C1-3 模板外意图返回 null（无模板 = 拒绝执行）', match3 === null);

  const bad = mod.validateParams(mod.CMD_TEMPLATES.find((t) => t.id === 'restart-service'), { service: 'payment-api' });
  check('C1-4 参数白名单外取值被拒（模型只能选不能造）', !bad.ok && bad.error.includes('白名单'), bad.error);

  /* 真实执行：日志轮转（builtin handler，真实落盘 + 真实回滚）。 */
  for (let index = 0; index < 15; index += 1) mod.appendLog('INFO', `轮转前日志行 ${index}`);
  const beforeLines = mod.readLogLines().length;
  const outcome = await mod.executeSrvTemplate('a-order-api', 'rotate_log', { keepLines: 10 }, identity, 'w-ops');
  const afterLines = mod.readLogLines().length;
  check('C1-5 rotate_log 真实执行（行数收缩到 keepLines）',
    outcome.ok && afterLines === 10 && beforeLines > 10,
    `before=${beforeLines} after=${afterLines} msg=${outcome.message.slice(0, 100)}`);
  const rolledBack = await mod.rollbackWritePlan(outcome.rollbackRef, identity, 'w-ops');
  check('C1-6 rotate_log 回滚恢复全部日志行',
    rolledBack.ok && mod.readLogLines().length === beforeLines,
    `after rollback=${mod.readLogLines().length}, expect=${beforeLines}`);

  const noTemplate = await mod.executeSrvTemplate('a-order-api', 'rm -rf /', {}, identity, 'w-ops');
  check('C1-7 模板外操作拒绝且不落盘', !noTemplate.ok && noTemplate.message.includes('模板') && !noTemplate.diskChanged);

  /* native 模板：systemctl 在沙箱多半不可用 → 如实降级（不伪造成功）。 */
  const restart = await mod.executeSrvTemplate('a-order-api', 'restart_service', { service: 'order-api' }, identity, 'w-ops');
  check('C1-8 restart_service 如实上报（不可用即降级，不伪造成功）',
    (restart.ok === false && restart.diskChanged === false) || restart.ok === true,
    `ok=${restart.ok}, msg=${restart.message.slice(0, 100)}`);
}

/* ================= C2. 文件写 + 回滚 ================= */
console.log('\n--- C2. 文件写三层防线 ---');
{
  const first = mod.executeFileWrite('a-order-service', 'v9-test/agent-write.md', '第一版内容', identity, 'w-ops');
  check('C2-1 新文件写入成功（precheck 通过 → 落盘 → 校验）',
    first.ok && first.diskChanged, first.message);

  const second = mod.executeFileWrite('a-order-service', 'v9-test/agent-write.md', '第二版内容', identity, 'w-ops');
  check('C2-2 覆盖写入成功且带回滚引用', second.ok && typeof second.rollbackRef === 'string', second.message);

  const restored = await mod.rollbackWritePlan(second.rollbackRef, identity, 'w-ops');
  check('C2-3 回滚恢复到第一版', restored.ok, restored.message);

  const sensitive = mod.executeFileWrite('a-order-service', '.env', 'SECRET=1', identity, 'w-ops');
  check('C2-4 敏感文件写入被 precheck 拦截（审批不豁免现实检查）',
    !sensitive.ok && sensitive.message.includes('precheck') && !sensitive.diskChanged, sensitive.message.slice(0, 120));

  const escape = mod.executeFileWrite('a-order-service', '../../outside.md', 'x', identity, 'w-ops');
  check('C2-5 路径越界被拦截', !escape.ok && !escape.diskChanged, escape.message.slice(0, 120));
}

/* ================= C3. 数据库写 + 回滚 ================= */
console.log('\n--- C3. 数据库写三层防线 ---');
{
  const ddl = await mod.executeDbWrite('DROP TABLE inventory', identity, 'w-ops');
  check('C3-1 DDL 一律拒绝（写通道仅限 DML）', !ddl.ok && ddl.message.includes('DDL') && !ddl.diskChanged, ddl.message.slice(0, 100));

  const multi = await mod.executeDbWrite("UPDATE inventory SET stock=1 WHERE sku='SKU-1001'; DELETE FROM inventory;", identity, 'w-ops');
  check('C3-2 多语句拒绝（单条 DML）', !multi.ok && !multi.diskChanged);

  const readBefore = await mod.runSqlQuery("SELECT stock FROM inventory WHERE sku='SKU-1001'", {}, identity, 'a-order-db-dev');
  const originalStock = Number(readBefore.rows[0]?.[0]);

  const write = await mod.executeDbWrite("UPDATE inventory SET stock = 999 WHERE sku = 'SKU-1001'", identity, 'w-ops');
  check('C3-3 DML 事务执行成功（影响 1 行 + 备份就绪）',
    write.ok && write.affectedRows === 1 && typeof write.rollbackRef === 'string', write.message.slice(0, 150));

  const after = await mod.runSqlQuery("SELECT stock FROM inventory WHERE sku='SKU-1001'", {}, identity, 'a-order-db-dev');
  check('C3-4 写后真实可见（999）', Number(after.rows[0]?.[0]) === 999, String(after.rows[0]?.[0]));

  const rolled = await mod.rollbackWritePlan(write.rollbackRef, identity, 'w-ops');
  const restored = await mod.runSqlQuery("SELECT stock FROM inventory WHERE sku='SKU-1001'", {}, identity, 'a-order-db-dev');
  check('C3-5 回滚恢复原值', rolled.ok && Number(restored.rows[0]?.[0]) === originalStock,
    `restored=${restored.rows[0]?.[0]}, expect=${originalStock}`);
}

/* ================= C4. 会话级审批记忆 + 连拒熔断 ================= */
console.log('\n--- C4. 审批记忆与熔断 ---');
{
  const key = mod.approvalKeyOf('patch.apply', 'code-file', 'high');
  mod.grantSessionApproval('c-mem-test', key);
  check('C4-1 会话记忆命中（同 intent+targetType+risk）', mod.hasSessionApproval('c-mem-test', key));
  check('C4-2 记忆不跨会话', !mod.hasSessionApproval('c-other', key));
  mod.clearSessionApprovals('c-mem-test');
  check('C4-3 清除后失效', !mod.hasSessionApproval('c-mem-test', key));

  for (let index = 0; index < 3; index += 1) mod.recordWriteDeny('c-break');
  check('C4-4 连续 3 次拒绝触发熔断', mod.breakerTripped('c-break'));
  check('C4-5 熔断阈值 = 3', mod.DENY_BREAKER_THRESHOLD === 3);
  mod.recordWriteSuccess('c-break');
  check('C4-6 成功执行后熔断解除', !mod.breakerTripped('c-break'));
}

/* ================= D. HTTP 集成（独立端口 3012） ================= */
console.log('\n--- D. HTTP 集成 ---');
{
  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'backend', 'src', 'index.ts')],
    {
      cwd: ROOT,
      env: { ...process.env, DEVWORK_PORT: String(PORT), DEVWORK_DATA_DIR: DATA_DIR, DEVWORK_SANDBOX_DIR: SANDBOX_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
  server.stderr.on('data', (chunk) => { serverLog += String(chunk); });

  /* 纯本地工具无账号体系：直接裸 fetch，不需要身份头。 */
  const call = async (method, url, bodyObj) => {
    const response = await fetch(`${BASE}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(30000),
    });
    let data = null;
    try { data = (await response.json())?.data ?? null; } catch { /* 非 JSON */ }
    return { status: response.status, data };
  };

  try {
    let healthy = false;
    for (let i = 0; i < 50; i += 1) {
      try {
        const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) { healthy = true; break; }
      } catch { await new Promise((resolve) => setTimeout(resolve, 400)); }
    }
    check('D0 服务在 20s 内就绪', healthy);
    if (!healthy) {
      process.stderr.write(serverLog.slice(-3000));
    } else {
      const tools = await call('GET', '/api/tools?workspaceId=w-ops');
      const toolData = tools.data ?? {};
      check('D1 GET /api/tools 返回派生工具面（active 含只读全组 + V2 写工具）',
        Array.isArray(toolData.active)
        && ['code_search', 'db_query', 'log_query', 'api_spec_read', 'code_edit', 'db_query_write'].every((name) =>
          toolData.active.some((t) => t.name === name)),
        (toolData.active ?? []).map((t) => t.name).join(','));
      check('D2 srv_exec 在诊断列表中标注 prod-env 剪枝',
        (toolData.all ?? []).some((t) => t.name === 'srv_exec' && t.gatedBy === 'prod-env'));

      const skills = await call('GET', '/api/skills?workspaceId=w-ops');
      /* 6 设计技能 + 3 补充技能 + 5 原有技能 = 14。新增技能时这里同步 +1。 */
      check('D3 GET /api/skills 返回 14 个技能且全部可用（w-ops 资产类型齐全）',
        Array.isArray(skills.data) && skills.data.length === 14 && skills.data.every((s) => s.availability?.available === true),
        `count=${skills.data?.length}, unavailable=${(skills.data ?? []).filter((s) => !s.availability?.available).map((s) => s.id).join(',')}`);

      const templates = await call('GET', '/api/cmd-templates');
      check('D4 GET /api/cmd-templates 返回 3 个模板', Array.isArray(templates.data) && templates.data.length === 3);

      /* 审批闭环：Mock 轨迹的高风险写 → 审批卡（含 plan）→ 批准（scope=session）→ 记忆登记。 */
      const conv = await call('POST', '/api/conversations', { workspaceId: 'w-ops', title: 'QA-工具派生' });
      const convId = String(conv.data?.id ?? '');
      const said = await call('POST', `/api/conversations/${convId}/messages`, { content: '帮我清理 order-api 的错误日志', assetIds: [] });
      const appr = (said.data?.messages ?? []).find((m) => m.kind === 'approval_card');
      check('D5 高风险写生成审批卡且带可执行 plan',
        !!appr && !!appr.payload?.plan?.toolName && appr.payload?.status === '待审批',
        JSON.stringify(appr?.payload?.plan ?? {}).slice(0, 150));

      const decided = await call('POST', `/api/approvals/${encodeURIComponent(String(appr?.id ?? ''))}`, {
        conversationId: convId, decision: 'approve', scope: 'session',
      });
      check('D6 批准裁决返回（演示轨迹遗留名如实不执行）',
        decided.data?.decision === 'approve' && decided.data?.executed === false && decided.data?.diskChanged === false,
        `executed=${decided.data?.executed}`);

      const secondWrite = await call('POST', `/api/conversations/${convId}/messages`, { content: '再清理一次日志', assetIds: [] });
      const rows = (secondWrite.data?.messages ?? []).filter((m) => ['tool_row', 'approval_card', 'suggestion'].includes(m.kind));
      const memoryHit = rows.some((m) => String(m.payload?.result ?? '').includes('会话级审批记忆'));
      check('D7 同类写操作命中会话级审批记忆（记忆键不含参数）', memoryHit,
        rows.map((m) => `${m.kind}:${short(String(m.payload?.result ?? ''), 60)}`).join(' | '));

      await call('DELETE', `/api/conversations/${convId}`);
    }
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 3000).unref();
    }
  }
}

function short(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
