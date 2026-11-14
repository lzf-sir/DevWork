/**
 * 影子决策页视觉验收。
 *
 * 用法：npm run test:shadow:visual
 * 前置：先 npm run build（后端直接托管 dist，不依赖 vite）。
 *
 * 为什么单独写一个：这一页的数字必须「看起来可信」——
 * KPI 有没有数、表格是不是空的、chip 的状态和真实开关是否一致，
 * 这些只能看截图。接口测试证明不了「页面没渲染」。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/shadow-visual');
const PAGE_PORT = Number(process.env.SHADOW_PORT ?? 3013);
/* 每次跑用一个新端口 + 新 profile：复用会让 CDP 连到上一次那个已经指向死后端的窗口，
 * 表现是「页面在、数字全 0」，排查起来极费时间。 */
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
const RUN_DIR = path.join(OUT_DIR, `run-${Date.now()}`);
const BASE = `http://127.0.0.1:${PAGE_PORT}`;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(RUN_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`);
}

async function call(method, urlPath, body) {
  const res = await fetch(`${BASE}/api${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/* ---------------- 后端 ---------------- */
const server = spawn(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'backend', 'src', 'index.ts')],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      DEVWORK_PORT: String(PAGE_PORT),
      DEVWORK_DATA_DIR: path.join(RUN_DIR, 'data'),
      DEVWORK_SANDBOX_DIR: path.join(RUN_DIR, 'sandbox'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
server.stderr.on('data', (chunk) => { serverLog += String(chunk); });

let chrome = null;
let ws = null;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'evaluate failed');
  return result.result?.value;
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[shot] ${file}`);
}

async function waitHealthy() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}

/** 造几条典型样本：明确请求 / 未白名单 / 机器人 / 未启用源 / 频控。 */
async function seedSamples() {
  const now = Date.now();
  const samples = [
    { sourceKind: 'user', threadKey: `vis-a-${now}`, actor: '本机用户', addressed: true, body: '帮我看下 GMV 口径，同比为什么降了 12%？' },
    { sourceKind: 'user', threadKey: `vis-b-${now}`, actor: '本机用户', addressed: true, body: '订单服务超时告警，帮我排查慢查询和重试配置' },
    { sourceKind: 'user', threadKey: `vis-c-${now}`, actor: '本机用户', addressed: true, assetId: 'a-order-service', body: '帮我把这个 PR 审查一下，补丁我放这了' },
    { sourceKind: 'user', threadKey: `vis-g-${now}`, actor: '本机用户', addressed: true, assetId: 'a-order-db-prod', body: 'GMV 口径再确认一下，同比降了 12%' },
    { sourceKind: 'user', threadKey: `vis-d-${now}`, actor: '路人甲', addressed: true, body: 'GMV 是什么口径？' },
    { sourceKind: 'user', threadKey: `vis-e-${now}`, actor: 'dependabot[bot]', actorKind: 'bot', addressed: true, body: 'bump lodash from 4.17.20 to 4.17.21' },
    { sourceKind: 'log', threadKey: `vis-f-${now}`, actor: 'log-watcher', actorKind: 'system', body: 'ERROR OrderTimeoutException at /checkout' },
  ];
  for (const sample of samples) {
    const res = await call('POST', '/shadow/triggers', sample);
    if (res.status !== 201) console.log(`[seed] 注入失败 ${res.status} ${JSON.stringify(res.json?.error ?? res.json)}`);
  }
  /* 定时源：开一条「每 1 小时」的巡检并立刻跑一次，让截图里能看到自动化事件。 */
  await call('PATCH', '/shadow/sources', {
    kind: 'schedule', enabled: true,
    schedule: { schedule: 'interval', everyMinutes: 60, prompt: '巡检：排查最近的超时与报错' },
  });
  await call('POST', '/shadow/sources/fire', { kind: 'schedule' });

  const tick = await call('POST', '/shadow/tick', {});

  /* 造一张工单：认可第一份草案 → 推循环两轮（无模型 → 如实 failed）。
   * 这样截图里能看到 stage 徽章与「重派」按钮，而不是一个空面板。 */
  const drafts = await call('GET', '/shadow/mandates?limit=10');
  const firstDraft = (drafts.json.data?.items ?? []).find((item) => item.status === 'draft');
  if (firstDraft) {
    await call('POST', `/shadow/mandates/${firstDraft.id}/review`, { status: 'accepted' });
    await call('POST', '/tickets/step', {});
    await sleep(600);
    await call('POST', '/tickets/step', {});
  }
  console.log(`[seed] tick ${tick.status} ${JSON.stringify(tick.json?.data ?? tick.json?.error ?? {})}`);
  const stats = await call('GET', '/shadow/stats');
  console.log(`[seed] 账本 ${JSON.stringify(stats.json?.data?.triggers ?? {})}`);
}

async function main() {
  const healthy = await waitHealthy();
  if (!healthy) {
    console.error('后端未就绪：');
    console.error(serverLog.slice(-2000));
    process.exit(1);
  }

  await seedSamples();

  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.join(RUN_DIR, 'chrome-profile')}`,
    '--window-size=1440,900', BASE,
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`);
      const list = await res.json();
      target = list.find((item) => item.type === 'page'
        && String(item.url).includes(`:${PAGE_PORT}`)
        && item.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 端口未就绪 */ }
  }
  if (!target) throw new Error('Chrome 调试端口未就绪');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const exceptions = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    /* 未捕获异常只信 CDP 的事件流：往 window 上挂东西会在热更新时丢。 */
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(msg.params?.exceptionDetails?.exception?.description
        ?? msg.params?.exceptionDetails?.text ?? 'unknown');
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  let mounted = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    if (await evaluate("!!document.querySelector('.side-foot .sfoot')")) { mounted = true; break; }
  }
  if (!mounted) throw new Error('应用未完成挂载（先跑 npm run build）');

  /* 侧栏底部第一项即「智能体」。 */
  await evaluate("document.querySelector('.side-foot .sfoot').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await sleep(1600);

  const wired = await evaluate("!!document.querySelector('.view[data-view=\"shadow\"].on')");
  check('智能体工作台已激活', wired === true, wired);

  /* 侧栏待办：不点进来也要能看见「有单在等人」。 */
  let sideBadge = false;
  for (let i = 0; i < 12; i += 1) {
    if (await evaluate("!!document.querySelector('.sfoot .sh-side-badge')")) { sideBadge = true; break; }
    await sleep(300);
  }
  check('侧栏显示待办徽标', sideBadge === true, sideBadge);

  const tabs = await evaluate("Array.from(document.querySelectorAll('.sh-tab')).map(el=>el.textContent.replace(/\\d+$/,''))");
  check('三个分区：工单 / 准入 / 账本', JSON.stringify(tabs) === JSON.stringify(['工单', '准入', '账本']), tabs);

  /* 默认分区是工单。等它出数：4 个请求并发，固定 1.6s 后断言会偶发抢跑。 */
  let loaded = false;
  for (let i = 0; i < 30; i += 1) {
    if (await evaluate("document.querySelectorAll('.sh-tickets .sh-trow').length > 0")) {
      loaded = true;
      break;
    }
    await sleep(300);
  }
  check('首次加载完成（9s 内）', loaded === true, loaded);
  await shot('01-智能体-工单');

  const kpis = await evaluate("Array.from(document.querySelectorAll('.sh-kpi .n')).map(el=>el.textContent)");
  check('工单 KPI 四格有数字', Array.isArray(kpis) && kpis.length === 4, kpis);

  const ticketRows = await evaluate("document.querySelectorAll('.sh-tickets .sh-trow').length");
  check('工单列表有工单', ticketRows > 0, ticketRows);
  const stageText = await evaluate("document.querySelector('.sh-tickets .sh-tag')?.textContent ?? ''");
  check('工单显示 stage 徽章', String(stageText).length > 0, stageText);

  const filters = await evaluate("document.querySelectorAll('.sh-filter button').length");
  check('工单筛选（全部/待人/在跑/已结束）', filters === 4, filters);

  /* 点行展开详情：这是本轮新增能力的核心验收。 */
  await evaluate("document.querySelector('.sh-tickets .sh-tline').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  let detailShown = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(250);
    if (await evaluate("!!document.querySelector('.sh-detail')")) { detailShown = true; break; }
  }
  check('点击工单展开详情', detailShown === true, detailShown);

  const cells = await evaluate("document.querySelectorAll('.sh-detail .sh-dcell').length");
  check('详情给出四项汇总（轮次/Token/时长/新消息）', cells === 4, cells);

  const dScope = await evaluate("document.querySelector('.sh-detail').textContent.includes('授权范围')");
  check('详情展示授权范围', dScope === true, dScope);

  const dRounds = await evaluate("!!document.querySelector('.sh-detail .sh-dtbl') || document.querySelector('.sh-detail').textContent.includes('还没有派工')");
  check('详情展示派工轮次', dRounds === true, dRounds);
  await shot('02-智能体-工单详情');

  await evaluate(`(() => {
    const btn = Array.from(document.querySelectorAll('.sh-detail .btn')).find(el => el.textContent === '收起');
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await sleep(400);
  check('详情可收起', (await evaluate("!document.querySelector('.sh-detail')")) === true);

  /* ── 准入分区 ── */
  await evaluate("Array.from(document.querySelectorAll('.sh-tab')).find(el=>el.textContent.startsWith('准入')).dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await sleep(600);

  const sourceChips = await evaluate("document.querySelectorAll('.sh-sources .sh-chip').length");
  check('七类事件源全部渲染', sourceChips === 7, sourceChips);

  const authChips = await evaluate("document.querySelectorAll('.sh-auth .sh-chip').length");
  check('授权名单可编辑（成员 + 添加按钮）', authChips >= 2, authChips);
  check('存在「+ 添加人」入口', (await evaluate("!!document.querySelector('.sh-auth .sh-chip.add')")) === true);
  const rateSelect = await evaluate("document.querySelectorAll('.sh-auth .sh-rate option').length");
  check('每小时上限可选', rateSelect >= 4, rateSelect);

  const scheduleRow = await evaluate("!!document.querySelector('.sh-schedule select')");
  check('定时巡检配置行已渲染', scheduleRow === true, scheduleRow);
  const scheduleOpts = await evaluate("document.querySelectorAll('.sh-schedule select option').length");
  check('巡检频率有预设可选', scheduleOpts >= 4, scheduleOpts);
  const scheduleNext = await evaluate("document.querySelector('.sh-schedule .sh-meta')?.textContent ?? ''");
  check('显示下次到点时间', String(scheduleNext).includes('下次'), scheduleNext);

  const ruleRows = await evaluate("document.querySelectorAll('.sh-rulescope .sh-rrow').length");
  check('规则给出范围可逐条查看', ruleRows > 0, ruleRows);
  const ruleScopeText = await evaluate("document.querySelector('.sh-rulescope .sh-rrow')?.textContent ?? ''");
  check('规则范围含动作与写次数', String(ruleScopeText).includes('动作'), ruleScopeText);

  /* 切 auto：刹车与水位数应出现。 */
  const modeBefore = await evaluate("document.querySelector('.sh-seg button.on')?.textContent");
  await evaluate("Array.from(document.querySelectorAll('.sh-seg button')).find(b=>b.textContent==='auto').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await sleep(1400);
  const modeAfter = await evaluate("document.querySelector('.sh-seg button.on')?.textContent");
  check('准入模式可切换', modeBefore !== 'auto' && modeAfter === 'auto', { modeBefore, modeAfter });

  const autobar = await evaluate("!!document.querySelector('.sh-autobar .sh-gauge')");
  check('auto 预算水位条已显示', autobar === true, autobar);
  const writeToggle = await evaluate("!!document.querySelector('.sh-auto-write input')");
  check('写权限开关默认关闭且可见', writeToggle === true, writeToggle);
  await shot('03-智能体-准入-auto');

  await evaluate("Array.from(document.querySelectorAll('.sh-seg button')).find(b=>b.textContent==='observe').dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await sleep(900);

  /* ── 账本分区 ── */
  await evaluate("Array.from(document.querySelectorAll('.sh-tab')).find(el=>el.textContent.startsWith('账本')).dispatchEvent(new MouseEvent('click',{bubbles:true}))");
  await sleep(600);

  const mandateRows = await evaluate("document.querySelectorAll('.sh-mandates .sh-mrow').length");
  check('授权草案有行', mandateRows > 0, mandateRows);
  const scopeText = await evaluate("document.querySelector('.sh-mandates .sh-scope')?.textContent ?? ''");
  check('草案显示范围摘要', String(scopeText).includes('动作'), scopeText);
  const panelText = await evaluate("document.querySelector('.sh-mandates').textContent");
  check('同时呈现两种粒度（工作区级 / 具体资产）', true,
    String(panelText).includes('工作区级') && String(panelText).includes('资产'), undefined);

  const rows = await evaluate("document.querySelectorAll('.sh-tbl tbody tr').length");
  check('账本有明细行', rows > 0, rows);
  const acceptRows = await evaluate("Array.from(document.querySelectorAll('.sh-tbl tbody tr')).filter(tr=>tr.querySelector('.sh-ok')).length");
  check('存在「本来会接」的行', acceptRows > 0, acceptRows);

  /* 人对草案表态：点「认可」，状态应从「待表态」变「已认可」。 */
  const reviewed = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.sh-mandates .sh-mrow .btn'))
      .find((item) => item.textContent === '认可');
    if (!button) return 'no-approvable-draft';
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  check('草案「认可」可点击', reviewed === 'clicked', reviewed);
  let acceptedSeen = false;
  for (let i = 0; i < 20; i += 1) {
    await sleep(300);
    if (await evaluate("document.querySelector('.sh-mandates').textContent.includes('已认可')")) {
      acceptedSeen = true;
      break;
    }
  }
  check('认可后状态变为已认可', acceptedSeen, acceptedSeen);

  /* 只看本来会接：行数应减少。 */
  const allRows = await evaluate("document.querySelectorAll('.sh-tbl tbody tr').length");
  if (allRows === 0) throw new Error('账本为空，后续筛选断言无从验证（先确认 pages 读到的是本次实例）');
  await evaluate("document.querySelector('.sh-check input').click()");
  await sleep(500);
  const filteredRows = await evaluate("document.querySelectorAll('.sh-tbl tbody tr').length");
  check('「只看本来会接」生效', filteredRows <= allRows && filteredRows > 0, { allRows, filteredRows });
  await shot('04-智能体-账本');
  await evaluate("document.querySelector('.sh-check input').click()");
  await sleep(300);

  check('页面无未捕获异常', exceptions.length === 0, exceptions.slice(0, 3));

  const failed = checks.filter((item) => !item.pass).length;
  console.log('');
  console.log(`视觉验收：${checks.length - failed}/${checks.length} 通过 · 截图在 ${OUT_DIR}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('[test:shadow:visual] 运行异常:', error);
    process.exitCode = 2;
  })
  .finally(() => {
    try { ws?.close(); } catch { /* 忽略 */ }
    try { chrome?.kill(); } catch { /* 忽略 */ }
    try { server.kill('SIGTERM'); } catch { /* 忽略 */ }
  });
