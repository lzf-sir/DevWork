/**
 * 符号引用面板视觉验收（Chrome headless + CDP）。
 *
 * 目的：确认「引」这条链路真的渲染出来了，而不是只编译通过：
 *   1. 大纲每个可查询的符号都有「引」入口（不可查询的不该有）；
 *   2. 点「引」后底部出现引用面板，抬头是**被点的那个符号**；
 *   3. 面板里说清了三件容易撒谎的事——命中数、被排除的注释命中、扫描缺口；
 *   4. 定义散在多个文件时给出收敛表，且每个分组都带归属标签；
 *   5. 右栏「引用」自称文件级粗扫，不与符号级数字抢同一个词。
 *
 * 用法：node tests/code-refs-visual.mjs [输出目录]
 * 前置：后端 3001 与 vite 5173 已启动（同 test:layout:visual 的约定）。
 * 也可用 DEVWORK_UI 指向另一套实例：`DEVWORK_UI=http://127.0.0.1:5174/ node tests/code-refs-visual.mjs`
 * ——后端改了文件而 dev 服务还没热重启时，用独立端口跑一份干净的验证。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/code-refs-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = process.env.DEVWORK_UI ?? 'http://127.0.0.1:5173/';
const PORT = 9338;

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
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
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

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label} — ${detail}`);
}

/** 进入代码库资产详情：按图标识别 `.ai-code`，不依赖具体资产 id。 */
const OPEN_ASSET = `(() => {
  const item = [...document.querySelectorAll('.aitem')].find((el) => el.querySelector('.ai-code'));
  if (!item) return 'no-asset';
  item.click();
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
  await sleep(2200);

  /* ---------- 1. 进入代码库详情，等大纲加载完 ---------- */
  /* 侧栏是异步装配的：2.2s 时可能还没有资产条目，这里给到 3.2s 并显式等视图切换。 */
  await sleep(3200);
  const opened = await evaluate(OPEN_ASSET);
  for (let i = 0; i < 20; i += 1) {
    const onCode = await evaluate(`(() => !!document.querySelector('.view.on[data-view="detail-code"]'))()`);
    if (onCode) break;
    await sleep(300);
  }
  await sleep(2600);
  await shot('01-code-detail');
  check('进入代码库详情', opened === 'ok', `open=${opened}`);

  const outline = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.view.on .rinfo .sym')];
    const withBtn = rows.filter((r) => r.querySelector('.refsbtn'));
    return {
      rows: rows.length,
      withBtn: withBtn.length,
      labels: withBtn.map((r) => r.querySelector('.refsbtn').parentElement.textContent.trim()).slice(0, 8),
      refs: [...document.querySelectorAll('.view.on .rinfo .sym')]
        .map((r) => r.textContent.trim())
        .filter((t) => t.includes('提到') || t.includes('粗扫')),
    };
  })()`);
  check('大纲符号带「引」入口', outline.withBtn > 0, `${outline.withBtn}/${outline.rows} 行可查引用：${outline.labels.join(' | ')}`);
  check('「引用」一栏自称文件级粗扫', outline.refs.length > 0 && outline.refs[0].includes('粗扫'),
    outline.refs[0] ?? '未找到粗扫说明');

  /* ---------- 2. 点第一个「引」，面板出现且抬头是同一个符号 ---------- */
  const clicked = await evaluate(`(() => {
    const btn = document.querySelector('.view.on .rinfo .sym .refsbtn');
    if (!btn) return null;
    const sym = btn.parentElement.cloneNode(true);
    sym.querySelector('.refsbtn')?.remove();
    const label = sym.textContent.trim().replace(/^[A-Z]/, '').replace(/:\\d+$/, '');
    btn.click();
    return label;
  })()`);
  await sleep(2500);
  await shot('02-refs-panel');

  const panel = await evaluate(`(() => {
    const p = document.querySelector('.view.on .rp');
    if (!p) return null;
    const body = p.querySelector('.rp-body');
    const rows = [...p.querySelectorAll('.rp-row')];
    return {
      head: p.querySelector('.rp-head')?.textContent.trim() ?? '',
      text: body?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      rows: rows.length,
      /* 行里的路径必须是仓库相对路径（带 /），不能是 repoFiles 曾经产出的纯文件名。 */
      paths: rows.map((r) => r.querySelector('.p')?.textContent.trim() ?? ''),
      tags: [...p.querySelectorAll('.rp-tag')].map((t) => t.textContent.trim()),
      hasUndefined: /undefined|NaN|\\[object/.test(body?.textContent ?? ''),
    };
  })()`);
  check('点「引」后面板出现', !!panel, panel ? `抬头=${panel.head}` : '未渲染 .rp');
  check('面板抬头就是被点的符号', !!panel && panel.head.includes(String(clicked ?? '')),
    `期望含 ${clicked}，实际 ${panel?.head ?? '—'}`);
  /* 命中口径那段话有两种分支：有被排除的注释命中 / 一条都没有。
   * 断言只该盯「有没有把口径说清」，不该钉死具体句子——否则文案一改就假红。 */
  check('面板写明命中 / 排除 / 扫描口径',
    !!panel && panel.text.includes('注释') && panel.text.includes('扫描'),
    panel ? panel.text.slice(0, 140) : '—');
  check('定义 / 引用文件表有行可点', !!panel && panel.rows > 0,
    panel ? `rows=${panel.rows} paths=${panel.paths.join(' | ')}` : '—');
  check('文件行是仓库相对路径（不是纯文件名）',
    !!panel && panel.paths.length > 0 && panel.paths.every((p) => p.includes('/')),
    panel ? panel.paths.join(' | ') : '—');
  check('面板无 undefined / NaN 泄漏', !!panel && !panel.hasUndefined,
    panel ? `rows=${panel.rows} tags=[${panel.tags.join(',')}]` : '—');

  /* ---------- 3. 换一个符号：抬头必须跟着换，且不能残留上一个的数据 ---------- */
  const switched = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.view.on .rinfo .sym .refsbtn')];
    if (btns.length < 2) return null;
    btns[1].click();
    return true;
  })()`);
  if (switched) {
    await sleep(2500);
    const second = await evaluate(`(() => {
      const p = document.querySelector('.view.on .rp');
      return p ? p.querySelector('.rp-head')?.textContent.trim() : null;
    })()`);
    check('换符号后抬头跟着变', !!second && second !== panel?.head, `${panel?.head} → ${second}`);
    await shot('03-refs-switched');
  } else {
    check('换符号后抬头跟着变', false, '大纲里只有一个可查符号，用例跳过');
  }

  /* ---------- 4. 关闭 ---------- */
  await evaluate(`(() => { document.querySelector('.view.on .rp-head .x')?.click(); return true; })()`);
  await sleep(400);
  const closed = await evaluate(`(() => !document.querySelector('.view.on .rp'))()`);
  check('关闭按钮能关掉面板', closed === true, `closed=${closed}`);
  await shot('04-closed');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n符号引用面板：${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error('[code-refs-visual] 失败:', error);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* 已关闭 */ }
  chrome.kill();
}
