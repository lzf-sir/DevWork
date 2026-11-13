/**
 * 输入框视觉验收（Chrome headless + CDP）。
 *
 * 目的：自动截图验证「@ 引用 / / 技能 / 模型切换」三块 UI 真的渲染出来了，
 * 而不只是编译通过。之前深色主题与拖拽调宽的自动截图没跑通（Electron 在本环境
 * 拉不起窗口），这次改用系统 Chrome 的 headless 模式 + DevTools 协议，
 * 不依赖 Electron 窗口。
 *
 * 用法：node tests/composer-visual.mjs [输出目录]
 * 前置：后端 3001 与 vite 5173 已启动。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/composer-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = 'http://127.0.0.1:5173/';
const PORT = 9333;

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

/** 用原生 setter 写入受控 textarea，并触发 React 的 input 事件。 */
const TYPE = `(text) => {
  const el = document.querySelector('.cinput');
  if (!el) return 'no-textarea';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.setSelectionRange(text.length, text.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
}`;

try {
  /* 等 Chrome 的调试端口起来 */
  let target = null;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      target = list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
      if (target) break;
    } catch { /* 还没起来 */ }
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
  await sleep(3500);

  await shot('01-默认输入框');

  /* ① @ 引用候选 */
  await evaluate(`(${TYPE})('帮我看 @')`);
  await sleep(700);
  await shot('02-At引用候选');

  /* ② @ + 关键词过滤 */
  await evaluate(`(${TYPE})('帮我看 @运营')`);
  await sleep(700);
  await shot('03-At引用过滤');

  /* ③ 选中资产后的正文与 chip */
  await evaluate(`(() => {
    const item = document.querySelector('.citem');
    if (!item) return 'no-item';
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await sleep(700);
  await shot('04-选中引用');

  /* ④ / 技能菜单 */
  await evaluate(`(${TYPE})('/')`);
  await sleep(700);
  await shot('05-斜杠技能菜单');

  /* ⑤ / + 关键词 */
  await evaluate(`(${TYPE})('/慢')`);
  await sleep(700);
  await shot('06-斜杠技能过滤');

  /* ⑥ 模型下拉 */
  await evaluate(`(() => {
    const chip = document.querySelector('.chip.mchip');
    if (!chip) return 'no-chip';
    chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await sleep(900);
  await shot('07-模型下拉');

  /* ⑦ 同名资产：order_db 有 prod / dev 两套，chip 上必须能分辨 */
  await evaluate(`(() => {
    const chip = document.querySelector('.chip.mchip');
    if (chip) chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'closed';
  })()`);
  await sleep(400);
  await evaluate(`(${TYPE})('看 @order')`);
  await sleep(700);
  await evaluate(`(() => {
    const item = document.querySelector('.citem');
    if (!item) return 'no-item';
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await sleep(700);
  await shot('08-同名资产可分辨');

  const state = await evaluate(`(() => ({
    textarea: document.querySelector('.cinput')?.value ?? '',
    chips: [...document.querySelectorAll('.atchip')].map((n) => n.textContent.trim()),
    popItems: [...document.querySelectorAll('.citem')].map((n) => n.textContent.trim()).slice(0, 8),
    modelItems: [...document.querySelectorAll('.mdi')].map((n) => n.textContent.trim()).slice(0, 6),
  }))()`);
  console.log('[state]', JSON.stringify(state, null, 2));

  /* ⑧ 深色主题：新增的浮层最容易在这里翻车（浅底白块 / 文字对比度）。 */
  await evaluate(`document.documentElement.dataset.theme = 'dark'; 'ok'`);
  await sleep(400);
  await evaluate(`(${TYPE})('看 @')`);
  await sleep(700);
  await shot('09-深色主题-At候选');

  await evaluate(`(() => {
    const chip = document.querySelector('.chip.mchip');
    if (chip) chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(800);
  await shot('10-深色主题-模型下拉');
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}
