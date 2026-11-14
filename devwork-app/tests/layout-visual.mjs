/**
 * 布局验收：菜单折叠按钮固定左上角 / 会话折叠按钮归位右上角。
 *
 * 用法：node tests/layout-visual.mjs [输出目录]
 * 前置：vite 5173 已启动（后端不通会自动回落 mock，不影响布局验证）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/layout-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'http://127.0.0.1:5173/';
const PORT = 9344;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  '--user-data-dir=' + path.join(OUT_DIR, 'chrome-profile'),
  '--window-size=1440,900', PAGE,
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
/** 局部放大截图：看清按钮图标细节。 */
async function shotClip(name, clip) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 3 } });
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`[shot] ${file}`);
}
/** 取元素的视口坐标，用于断言「固定位置」。 */
const BOX = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
}`;
const CLICK = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return 'missing:' + sel;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return 'clicked';
}`;

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name} ${JSON.stringify(detail)}`);
};

try {
  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 端口未就绪 */ }
  }
  if (!target) throw new Error('Chrome 调试端口未就绪');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
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
  await sleep(1500);

  /* 等 React 真正挂载：顶栏菜单按钮出现即视为就绪（Vite 首次转换模块会慢）。 */
  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    const hit = await evaluate(`!!document.querySelector('.menu-toggle') && !!document.querySelector('.side')`);
    if (hit) { ready = true; break; }
  }
  if (!ready) throw new Error('应用未在预期时间内完成挂载');
  await sleep(800);

  /* ① 默认态：菜单展开 + 工作区收起（不固定任何 tab） */
  const menuBox0 = await evaluate(`(${BOX})('.menu-toggle')`);
  const sideBox0 = await evaluate(`(${BOX})('.side')`);
  const benchDefault = await evaluate(`(${BOX})('.bench')`);
  const restoreDefault = await evaluate(`(${BOX})('.bench-restore')`);
  await shot('01-默认-菜单展开-工作区收起');
  await shotClip('01a-放大-左上角菜单按钮', { x: 0, y: 0, width: 140, height: 44 });
  await shotClip('01b-放大-右上角工作区展开按钮', { x: 1120, y: 0, width: 320, height: 100 });

  check('默认态：左上角存在常驻菜单折叠按钮', !!menuBox0?.visible, menuBox0);
  check('默认态：菜单按钮在窗口左上角（x<40, y<44）', menuBox0 && menuBox0.x < 40 && menuBox0.y < 44, menuBox0);
  check('默认态：侧边工作区收起（不占版面）', !benchDefault?.visible, benchDefault);
  check('默认态：右上角有工作区展开按钮', !!restoreDefault?.visible, restoreDefault);

  /* ①b 展开工作区：后续关于收起/展开位置的断言以展开态为基准 */
  await evaluate(`(${CLICK})('.bench-restore')`);
  await sleep(700);
  const ctxBox0 = await evaluate(`(${BOX})('.bench')`);
  const ptabX0 = await evaluate(`(${BOX})('.ptab-x')`);
  const restore0 = await evaluate(`(${BOX})('.bench-restore')`);
  check('展开工作区后右上角出现收起按钮', !!ptabX0?.visible, ptabX0);
  check('展开后不再显示「展开」按钮', !restore0, restore0);

  /* ② 收起菜单：按钮位置必须纹丝不动 */
  await evaluate(`(${CLICK})('.menu-toggle')`);
  await sleep(700);
  const menuBox1 = await evaluate(`(${BOX})('.menu-toggle')`);
  const sideBox1 = await evaluate(`(${BOX})('.side')`);
  await shot('02-菜单收起');

  check('菜单收起后按钮仍在同一位置', !!menuBox0 && !!menuBox1 && menuBox0.x === menuBox1.x && menuBox0.y === menuBox1.y, { before: menuBox0, after: menuBox1 });
  check('默认态：菜单按钮存在', !!menuBox0?.visible, menuBox0);
  check('菜单收起后侧栏不可见', !sideBox1?.visible, sideBox1);

  /* ③ 展开菜单 */
  await evaluate(`(${CLICK})('.menu-toggle')`);
  await sleep(700);
  const menuBox2 = await evaluate(`(${BOX})('.menu-toggle')`);
  const sideBox2 = await evaluate(`(${BOX})('.side')`);
  check('菜单可重新展开', !!sideBox2?.visible, sideBox2);
  check('菜单按钮位置始终不变', !!menuBox2 && !!menuBox0 && menuBox2.x === menuBox0.x && menuBox2.y === menuBox0.y, { base: menuBox0, again: menuBox2 });

  /* ④ 收起会话面板：展开按钮必须停在会话面板原来的右上角 */
  await evaluate(`(${CLICK})('.ptab-x')`);
  await sleep(700);
  const ctxBox1 = await evaluate(`(${BOX})('.bench')`);
  const restore1 = await evaluate(`(${BOX})('.bench-restore')`);
  const topbarRight = await evaluate(`(${BOX})('.win-controls')`);
  await shot('03-会话收起-右上角展开按钮');
  await shotClip('03a-放大-右上角会话展开按钮', { x: 1120, y: 0, width: 320, height: 100 });

  check('会话面板收起后不可见', !ctxBox1?.visible, ctxBox1);
  check('会话收起后出现右上角展开按钮', !!restore1?.visible, restore1);
  check('展开按钮落在会话面板原右上角附近', !!restore1 && !!ptabX0 && Math.abs(restore1.x - ptabX0.x) < 8 && Math.abs(restore1.y - ptabX0.y) < 8, { restore: restore1, ptabX: ptabX0 });
  check('展开按钮不与 Windows 窗口控制按钮重叠', !!restore1 && !!topbarRight && restore1.y > topbarRight.y + 20, { restore: restore1, winControls: topbarRight });

  /* ⑤ 顶栏里不应再残留右栏展开按钮 */
  const topbarToggles = await evaluate(`document.querySelectorAll('.topbar .chrome-toggle').length`);
  check('顶栏只保留菜单折叠按钮（右栏入口已迁走）', topbarToggles === 1, { topbarToggles });

  /* ⑥ 再点右上角展开会话 */
  await evaluate(`(${CLICK})('.bench-restore')`);
  await sleep(700);
  const ctxBox2 = await evaluate(`(${BOX})('.bench')`);
  await shot('04-会话重新展开');
  check('会话面板可重新展开', !!ctxBox2?.visible, ctxBox2);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n[summary] ${checks.length - failed.length}/${checks.length} 通过`);
process.exit(failed.length ? 1 : 0);
