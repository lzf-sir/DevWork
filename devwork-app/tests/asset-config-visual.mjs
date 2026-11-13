/**
 * 资产改造视觉验收（Chrome headless + CDP）。
 *
 * 目的：自动截图验证三件事真的渲染出来了，而不是只编译通过：
 *   1. 侧栏资产列表不再显示索引进度百分比；
 *   2. 资产详情默认落在主功能区（无「概览」Tab）；
 *   3. 详情条上的小齿轮按钮能打开右侧配置抽屉（能力授权在里面）。
 *
 * 用法：node tests/asset-config-visual.mjs [输出目录]
 * 前置：后端 3001 与 vite 5173 已启动。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/asset-config-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'http://127.0.0.1:5173/';
const PORT = 9337;

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + path.join(OUT_DIR, 'chrome-profile'),
  '--window-size=1440,900',
  PAGE,
], { stdio: 'ignore' });

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

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`);
}

/** 进入某个资产详情（点侧栏对应条目）。 */
const OPEN_ASSET = (go) => `(() => {
  const e = document.querySelector('.aitem[data-go="${go}"]');
  if (!e) return 'no-asset';
  e.click();
  return 'ok';
})()`;

/** 打开配置抽屉（点详情条上的小齿轮按钮）。 */
const OPEN_DRAWER = `(() => {
  const b = document.querySelector('.view.on .dcfg');
  if (!b) return 'no-btn';
  b.click();
  return 'ok';
})()`;

try {
  let target = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const items = await list.json();
      target = items.find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* 端口还没起来 */
    }
    await sleep(250);
  }
  if (!target) throw new Error('Chrome 调试端口未就绪');

  const { default: WebSocket } = await import('ws').catch(() => ({ default: globalThis.WebSocket }));
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(2200); // 等 bootstrap / 装配完成

  /* ---------- 1. 侧栏：不得出现任何百分比 ---------- */
  await shot('01-chat-sidebar');
  const sidebarPct = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.aitem')];
    const hits = items.map((el) => el.textContent.match(/\\d+%/) || null).filter(Boolean);
    return { count: items.length, hits, texts: items.slice(0, 8).map((el) => el.textContent.trim()) };
  })()`);
  check('侧栏资产列表无百分比', sidebarPct.hits.length === 0,
    `资产 ${sidebarPct.count} 个，含百分比 ${sidebarPct.hits.length} 处`);

  const indexingDot = await evaluate(`(() => {
    const el = document.querySelector('.aitem .sd.idx');
    return el ? el.getAttribute('title') : null;
  })()`);
  check('索引中资产改为状态点', indexingDot === '索引中', `title=${indexingDot ?? '未找到'}`);

  /* 展开全部资产文件夹：让状态点真正出现在屏幕上（不展开就只能看到文件夹名）。 */
  await evaluate(`(() => {
    [...document.querySelectorAll('.folder')].forEach((f) => {
      if (!f.classList.contains('open')) f.click();
    });
    return true;
  })()`);
  await sleep(700);
  const expanded = await evaluate(`(() => {
    const items = [...document.querySelectorAll('.aitem')];
    return {
      count: items.length,
      rows: items.map((el) => ({
        name: el.querySelector('.t')?.textContent.trim() ?? '',
        pct: (el.textContent.match(/\\d+%/) || [])[0] ?? null,
        dot: el.querySelector('.sd')?.className.replace('sd', '').trim() || null,
      })),
    };
  })()`);
  check('展开后资产行仍无百分比', expanded.rows.every((r) => !r.pct),
    `${expanded.count} 个资产行，状态点=${expanded.rows.map((r) => `${r.name}:${r.dot ?? '-'}`).join(' ')}`);
  await shot('01b-sidebar-expanded');

  /* ---------- 2. 各资产详情：默认落在主功能区，无「概览」Tab ---------- */
  const expectations = [
    { go: 'server', view: 'detail-server', main: '终端' },
    { go: 'db', view: 'detail-db', main: 'SQL 查询' },
    { go: 'code', view: 'detail-code', main: '编辑器' },
  ];
  for (const item of expectations) {
    const opened = await evaluate(OPEN_ASSET(item.go));
    await sleep(700);
    const state = await evaluate(`(() => {
      const view = document.querySelector('.view.on');
      const dbody = view ? view.querySelector('.dbody.on') : null;
      const tabs = [...document.querySelectorAll('.view.on .dtab')].map((t) => t.textContent.trim());
      return {
        view: view ? view.getAttribute('data-view') : null,
        dt: dbody ? dbody.getAttribute('data-dt') : null,
        tabs,
        hasOverviewTab: tabs.includes('概览'),
        hasCapTab: tabs.includes('能力授权'),
        hasConfigBtn: !!view.querySelector('.dcfg'),
      };
    })()`);
    check(`${item.view} 默认落在 ${item.main}`, state.view === item.view && state.dt === 'main',
      `view=${state.view} dt=${state.dt} tabs=[${state.tabs.join(',')}]`);
    check(`${item.view} 无「概览 / 能力授权」Tab`, !state.hasOverviewTab && !state.hasCapTab,
      `tabs=[${state.tabs.join(',')}]`);
    check(`${item.view} 有配置小按钮`, state.hasConfigBtn, `dcfg=${state.hasConfigBtn}`);
    await shot(`02-${item.go}-default`);
  }

  /* ---------- 3. 抽屉：能力授权在里面 ---------- */
  await evaluate(OPEN_ASSET('server'));
  await sleep(700);
  await evaluate(OPEN_DRAWER);
  await sleep(600);
  const drawer = await evaluate(`(() => {
    const d = document.querySelector('.dwr');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return {
      title: d.querySelector('.dwr-t')?.textContent ?? '',
      caps: [...d.querySelectorAll('.cap .cn')].map((el) => el.textContent.trim()),
      switches: d.querySelectorAll('.cap .sw').length,
      right: Math.round(r.right),
      width: Math.round(r.width),
      vw: innerWidth,
    };
  })()`);
  check('配置抽屉可打开且靠右', !!drawer && drawer.right <= drawer.vw + 1 && drawer.width > 300,
    drawer ? `width=${drawer.width} right=${drawer.right}/${drawer.vw}` : '抽屉未出现');
  check('抽屉含能力授权开关', !!drawer && drawer.switches > 0,
    drawer ? `能力项 ${drawer.caps.length} 个：${drawer.caps.join(' / ')}` : '—');
  await shot('03-drawer-server');

  /* ---------- 4. 数据库抽屉：凭据绑定入口必须还在 ---------- */
  await evaluate(`(() => { document.querySelector('.dwrmask')?.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); })()`);
  await sleep(400);
  await evaluate(OPEN_ASSET('db'));
  await sleep(700);
  await evaluate(OPEN_DRAWER);
  await sleep(600);
  const dbDrawer = await evaluate(`(() => {
    const d = document.querySelector('.dwr');
    if (!d) return null;
    return {
      cred: d.querySelector('.dwr-cred')?.textContent ?? '',
      btnTexts: [...d.querySelectorAll('.dwr-cred .btn')].map((b) => b.textContent.trim()),
      caps: d.querySelectorAll('.cap').length,
    };
  })()`);
  check('数据库抽屉保留凭据绑定入口', !!dbDrawer && dbDrawer.btnTexts.some((t) => t.includes('绑定') || t.includes('轮换')),
    dbDrawer ? `凭据区按钮=[${dbDrawer.btnTexts.join(',')}]` : '抽屉未出现');
  await shot('04-drawer-db');

  /* ---------- 5. Esc 关闭抽屉 ---------- */
  await evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await sleep(400);
  const closed = await evaluate(`!document.querySelector('.dwr')`);
  check('Esc 关闭抽屉', closed, closed ? '抽屉已关闭' : '抽屉仍在');

  /* ---------- 6. 知识库详情：默认落在文档页 ---------- */
  await evaluate(OPEN_ASSET('kb')).catch(() => undefined);
  await sleep(700);
  const kb = await evaluate(`(() => {
    const view = document.querySelector('.view.on');
    const dbody = view ? view.querySelector('.dbody.on') : null;
    return { view: view?.getAttribute('data-view') ?? null, dt: dbody?.getAttribute('data-dt') ?? null };
  })()`);
  check('知识库详情默认落在文档页', kb.view === 'detail-kb' && kb.dt === 'main',
    `view=${kb.view} dt=${kb.dt}`);
  await shot('05-kb-default');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n========== 汇总 ==========`);
  console.log(`Total: ${results.length} | Passed: ${results.length - failed.length} | Failed: ${failed.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  FAIL: ${f.label} — ${f.detail}`));
  }
  chrome.kill();
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.error('VISUAL FAILED:', err);
  chrome.kill();
  process.exit(1);
}
