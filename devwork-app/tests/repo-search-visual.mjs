/**
 * 全库检索（⌘⇧F）验收（Chrome headless + CDP）。
 *
 * 它要证明的不是"能搜到"，而是**它和文件内 ⌘F 不是同一个东西**：
 *   - 查的是落盘内容的全文索引，所以「搜不到」有专门的解释（没索引 / 被隐私规则排除），
 *     并且给一条重建索引的出路；
 *   - 结果必须自带「文件 + 命中行号 + 该行原文」，否则用户还得逐个点进去确认；
 *   - 行号要落在**命中那一行**，不是 40 行窗口的块首行 —— 落块首等于让人自己再找一遍。
 *
 * 输入走 CDP 真输入（Input.insertText）：合成的 InputEvent 进不了 React 的受控输入，
 * 测出来的"通过"什么都没证明（保存完整性测试里踩过这个坑）。
 *
 * 用法：node tests/repo-search-visual.mjs [输出目录]
 * 前置：后端与 vite 已启动；用 DEVWORK_UI / DEVWORK_API 指向实例。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/repo-search-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = process.env.DEVWORK_UI ?? 'http://127.0.0.1:5173/';
const API = process.env.DEVWORK_API ?? 'http://127.0.0.1:3001/api';
const WS = process.env.DEVWORK_WS ?? 'w-ops';
const ASSET = process.env.DEVWORK_ASSET ?? 'a-order-service';
const QUERY = process.env.DEVWORK_QUERY ?? 'OrderService';
const PORT = 9347;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 基准来自接口而不是猜：界面上该显示哪几行，以服务端认为的命中行为准。 */
const baseline = await fetch(`${API}/assets/${ASSET}/search?q=${encodeURIComponent(QUERY)}&workspaceId=${WS}`)
  .then((res) => res.json())
  .then((json) => (json?.ok ? json.data : null))
  .catch(() => null);
if (!baseline || baseline.length === 0) {
  console.error('接口没有返回命中，检查后端与夹具');
  process.exit(1);
}
console.log(`基准：${QUERY} → ${baseline.length} 处 · 首个 ${baseline[0].path}:${baseline[0].snippetLine}`);

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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? '页面脚本执行失败');
  }
  return result.result.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[shot] ${file}`);
}

async function waitFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* 页面还在切换 */
    }
    await sleep(200);
  }
  return false;
}

/** 真输入：先在页面里把焦点放到目标输入框，再走 CDP 插入文本。 */
async function typeInto(selector, text) {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
  await send('Input.insertText', { text });
}

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`);
}

let exitCode = 0;
try {
  let target = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const items = await list.json();
      target = items.find((t) => t.type === 'page');
      if (target) break;
    } catch {
      /* 调试端口还没起来 */
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
  await sleep(2400);

  /* ---------- 1. 进代码库详情 ---------- */
  const assetReady = await waitFor(`(() => document.querySelectorAll('.aitem[data-go="code"]').length > 0)()`);
  if (assetReady) {
    await evaluate(`(() => { document.querySelector('.aitem[data-go="code"]').click(); return true; })()`);
  }
  await waitFor(`(() => !!document.querySelector('.view.on[data-view="detail-code"]'))()`);
  await waitFor(`(() => document.querySelectorAll('.view.on .fnode').length > 0)()`);
  await sleep(900);

  const entry = await evaluate(`(() => {
    const btn = document.querySelector('.view.on .fsearch');
    if (!btn) return null;
    return { text: btn.textContent.trim() };
  })()`);
  check('文件树顶部有全库检索入口', entry !== null && entry.text.includes('搜全库'),
    entry ? `入口文案=${entry.text}` : '未找到 .fsearch');

  /* ---------- 2. 打开面板：抬头要能和文件内查找区分开 ---------- */
  await evaluate(`(() => { document.querySelector('.view.on .fsearch').click(); return true; })()`);
  const opened = await waitFor(`(() => !!document.querySelector('.view.on .rp.rs .rs-input'))()`);
  /* 聚焦是挂载后再 setTimeout 落地的，不能在同一拍里读一次就判——
   * 单次采样读到 false 只说明"还没轮到那一拍"，不说明功能坏了。 */
  const focused = await waitFor(`(() => document.activeElement === document.querySelector('.view.on .rs-input'))()`, 3000);
  const head = await evaluate(`(() => {
    const el = document.querySelector('.view.on .rp.rs');
    return {
      head: el ? el.querySelector('.rp-head')?.innerText ?? '' : '',
      findbar: !!document.querySelector('.view.on input[placeholder^="输入关键词"]'),
    };
  })()`);
  check('点开后是索引检索面板，且与文件内查找明确区分',
    opened && head.head.includes('全库检索') && head.head.includes('不同'),
    `抬头=${JSON.stringify(head.head.replace(/\n/g, ' | '))}`);
  check('打开即聚焦输入框，且没有把 ⌘F 的查找条一起打开',
    focused === true && head.findbar === false,
    `聚焦=${focused} · 查找条=${head.findbar}`);
  await shot('01-opened');

  /* ---------- 3. 空输入：先把口径说清，别让人以为"没搜就是没有" ---------- */
  const emptyState = await evaluate(`(() => document.querySelector('.view.on .rp.rs .rp-body')?.innerText ?? '')()`);
  check('未输入时说明「索引是快照」而不是空列表',
    emptyState.includes('索引是磁盘内容的快照'),
    `空态文案长度=${emptyState.length}`);

  /* ---------- 4. 真输入检索 → 结果三件套 ---------- */
  await typeInto('.view.on .rs-input', QUERY);
  const landed = await waitFor(`(() => document.querySelectorAll('.view.on .rs-row').length > 0)()`, 8000);
  await sleep(300);
  const rows = await evaluate(`(() => [...document.querySelectorAll('.view.on .rs-row')].map((row) => ({
    file: row.querySelector('.rs-loc .p')?.textContent ?? '',
    line: row.querySelector('.rs-loc .n')?.textContent ?? '',
    snip: row.querySelector('.rs-snip')?.textContent ?? '',
    marks: row.querySelectorAll('.rs-snip mark').length,
    title: row.getAttribute('title') ?? '',
  })))()`);
  const allThree = rows.length > 0 && rows.every((row) => row.file !== '' && /^:\d+$/.test(row.line) && row.snip.trim() !== '');
  check('命中结果是「文件 + 行号 + 该行原文」三件套', landed && allThree && rows.length === baseline.length,
    `行数 ${rows.length}（接口 ${baseline.length}）· 首行 ${rows[0]?.file}${rows[0]?.line} · 片段 ${JSON.stringify((rows[0]?.snip ?? '').slice(0, 40))}`);
  check('片段里命中词被标出', rows.some((row) => row.marks > 0),
    `带标记的行 ${rows.filter((row) => row.marks > 0).length}/${rows.length}`);

  /* 行号必须是「命中那一行」，不是块首行：块是 40 行窗口，落块首等于让人自己再找。 */
  const firstApi = baseline[0];
  const firstLineShown = Number((rows[0]?.line ?? '').replace(':', ''));
  check('行号落在命中行而不是块首行',
    firstLineShown === firstApi.snippetLine && rows[0]?.file === firstApi.path.split('/').pop(),
    `界面 ${rows[0]?.file}:${firstLineShown} · 接口命中 ${firstApi.path}:${firstApi.snippetLine} · 块首行 ${firstApi.startLine}`);
  await shot('02-hits');

  /* ---------- 5. 点另一文件的命中 → 编辑器跟着换文件 ---------- */
  const crossIndex = rows.findIndex((row) => row.file !== rows[0].file);
  const beforeFile = await evaluate(`(() => document.querySelector('.view.on .ebar .fn')?.textContent ?? '')()`);
  if (crossIndex >= 0) {
    await evaluate(`(() => { document.querySelectorAll('.view.on .rs-row')[${crossIndex}].click(); return true; })()`);
    await sleep(1600);
  }
  const afterFile = await evaluate(`(() => document.querySelector('.view.on .ebar .fn')?.textContent ?? '')()`);
  check('点跨文件命中会切换编辑器里的文件',
    crossIndex >= 0 && afterFile === rows[crossIndex].file && afterFile !== beforeFile,
    `之前=${beforeFile} · 之后=${afterFile} · 目标=${crossIndex >= 0 ? rows[crossIndex].file : '(无跨文件命中)'}`);
  const stillOpen = await evaluate(`(() => !!document.querySelector('.view.on .rp.rs'))()`);
  check('跳转后检索面板不被顶掉', stillOpen === true, `面板在=${stillOpen}`);

  /* ---------- 6. 关闭 → ⌘⇧F 重新打开 ---------- */
  await evaluate(`(() => { document.querySelector('.view.on .rp.rs .rp-head .x').click(); return true; })()`);
  const closed = await waitFor(`(() => !document.querySelector('.view.on .rp.rs'))()`, 4000);
  check('× 能关掉面板', closed === true, `关闭后还在=${!closed}`);

  /* 快捷键在 App 的 window 监听上，直接派发到 window 就是它真实的入口。 */
  await evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true, bubbles: true }));
    return true;
  })()`);
  const reopened = await waitFor(`(() => !!document.querySelector('.view.on .rp.rs .rs-input'))()`, 4000);
  const fresh = await evaluate(`(() => document.querySelector('.view.on .rs-input')?.value ?? '(无输入框)')()`);
  check('⌘⇧F 能重新打开，且回到干净状态',
    reopened && fresh === '',
    `重开=${reopened} · 输入框值=${JSON.stringify(fresh)}`);

  /* ---------- 7. 无命中：给原因，也给一条出路 ---------- */
  const ghost = `zzz-nothing-${Date.now()}`;
  await typeInto('.view.on .rs-input', ghost);
  const noHit = await waitFor(`(() => (document.querySelector('.view.on .rp.rs .rp-body')?.innerText ?? '').includes('没有命中'))()`, 8000);
  const guide = await evaluate(`(() => {
    const body = document.querySelector('.view.on .rp.rs .rp-body');
    return {
      text: body?.innerText ?? '',
      rebuild: !!body?.querySelector('.rp-re-inline'),
      rows: document.querySelectorAll('.view.on .rs-row').length,
    };
  })()`);
  check('无命中时说明原因并给出「重建索引」出路',
    noHit && guide.rebuild && guide.text.includes('还没进索引') && guide.rows === 0,
    `命中行=${guide.rows} · 重建入口=${guide.rebuild} · 提示含索引说明=${guide.text.includes('索引')}`);
  await shot('03-no-hit');
} catch (error) {
  console.error('[ERROR]', String(error?.message ?? error));
  exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* 已关闭 */ }
  try { chrome.kill(); } catch { /* 已退出 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n全库检索：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  for (const item of failed) console.log(`  ✗ ${item.label} — ${item.detail}`);
  exitCode = 1;
}
process.exit(exitCode);
