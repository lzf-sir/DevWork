/**
 * 保存路径完整性验收（Chrome headless + CDP）。
 *
 * 这是对「编辑器里的文本 == 磁盘上的文本」的一次实测。
 * 上一轮的一个真 bug 就藏在这条链上：`highlight()` 为了撑住空行渲染 `&nbsp;`，
 * 而那块 div 同时是 contentEditable 编辑区，保存读的是它的 `innerText`——
 * **打开文件什么都不改、点一次保存**，每条空行就变成一个 U+00A0（916→922 字节）。
 * 它自己会擦掉现场（第二次保存就"一致"了），所以必须每次拿原始夹具跑。
 *
 * 要证明的事：
 *   1. 渲染出来的纯文本与接口原文逐行一致（空行必须真空，不能是 U+00A0）；
 *   2. 不做任何编辑点保存，磁盘字节一个不差（含末尾换行）；
 *   3. 第二次保存 diskChanged=false（没改就是没改）；
 *   4. 真改了内容再保存，改动只有那一处（不牵连空行）。
 *
 * 用法：node tests/save-integrity-visual.mjs [输出目录]
 * 前置：后端与 vite 已启动；用 DEVWORK_UI / DEVWORK_API 指向实例。
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/save-integrity-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = process.env.DEVWORK_UI ?? 'http://127.0.0.1:5173/';
const API = process.env.DEVWORK_API ?? 'http://127.0.0.1:3001/api';
const WS = process.env.DEVWORK_WS ?? 'w-ops';
const ASSET = process.env.DEVWORK_ASSET ?? 'a-order-service';
const REL = process.env.DEVWORK_FILE ?? 'src/main/java/order/OrderService.java';
const PORT = 9345;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readPlain = async () => {
  const res = await fetch(`${API}/assets/${ASSET}/files/content?workspaceId=${WS}&path=${encodeURIComponent(REL)}`);
  const json = await res.json();
  return String(json?.data?.plain ?? '');
};
const digest = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const blankLines = (text) => text.split('\n').filter((line) => line.trim() === '').length;

const origin = await readPlain();
if (origin === '') {
  console.error('读不到夹具原文，检查后端与路径');
  process.exit(1);
}
const originHash = digest(origin);
console.log(`夹具 ${REL} · ${Buffer.byteLength(origin, 'utf8')} 字节 · ${origin.split('\n').length} 行 · 空行 ${blankLines(origin)}`);

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

  /* ---------- 1. 进代码库详情并打开目标文件 ---------- */
  const assetReady = await waitFor(`(() => document.querySelectorAll('.aitem[data-go="code"]').length > 0)()`);
  if (assetReady) {
    await evaluate(`(() => { document.querySelector('.aitem[data-go="code"]').click(); return true; })()`);
  }
  await waitFor(`(() => !!document.querySelector('.view.on[data-view="detail-code"]'))()`);
  await sleep(1500);

  const fileName = REL.split('/').pop();
  const picked = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.view.on .fnode')];
    const hit = nodes.find((n) => (n.getAttribute('title') ?? n.textContent).includes(${JSON.stringify(fileName)}));
    if (!hit) return { ok: false, nodes: nodes.map((n) => n.textContent.trim()).slice(0, 12) };
    hit.click();
    return { ok: true, text: hit.textContent.trim() };
  })()`);
  check('能打开目标文件', picked.ok === true, picked.ok ? picked.text : `未找到，树里前几项=${JSON.stringify(picked.nodes)}`);
  await waitFor(`(() => (document.querySelector('.view.on .codebody')?.innerText ?? '').includes('package'))`);
  await sleep(800);

  /* ---------- 2. 渲染结构 vs 接口原文 ----------
   * 逐行比对的是**顶层子元素**，不是 innerText：
   * innerText 会把空行占位 `<br>` 也算一次断行（19 行文件给 25 行），
   * 拿它当基准会把正确实现判成错的。产品侧的序列化同样是按顶层子元素取的。 */
  const rendered = await evaluate(`(() => {
    const el = document.querySelector('.view.on .codebody');
    if (!el) return null;
    const lines = [...el.children].map((d) => d.textContent ?? '');
    return {
      lines,
      count: lines.length,
      nbsp: (lines.join('').match(/\\u00a0/g) ?? []).length,
    };
  })()`);
  const originLines = origin.split('\n');
  /* 比的是「渲染 → 再拼回去」能不能还原原文，而不是各减一个末尾空行去凑长度：
   * 文件以换行结尾时 `split('\n')` 会多一个空串，编辑器同样会为它留一行空行 ——
   * 两边都是 N+1 行，硬砍一刀反而会把正确实现判成错的。
   * 真正的守恒式是 `lines.join('\n') === origin`：行数一致且逐行内容一致。 */
  const roundTrip = (rendered?.lines ?? []).join('\n');
  const sameLineCount = rendered?.count === originLines.length;
  const sameContent = sameLineCount && roundTrip === origin;
  check('渲染结构一层一行，与原文逐行一致', sameLineCount && sameContent,
    `renderLines=${rendered?.count} originLines=${originLines.length} roundTrip=${roundTrip === origin}`);
  check('空行没有变成不可见字符（U+00A0）', (rendered?.nbsp ?? 1) === 0,
    `nbsp=${rendered?.nbsp} 处 · 原文空行 ${blankLines(origin)} 行`);
  await shot('01-opened');

  /* ---------- 3. 不做任何编辑，点保存 ---------- */
  const saved = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')].find((b) => /^保存/.test(b.textContent.trim()));
    if (!btn) return 'no-button';
    btn.click();
    return 'ok';
  })()`);
  await sleep(2600);
  const afterNoop = await readPlain();
  check('原样保存后磁盘字节不变', digest(afterNoop) === originHash,
    `saved=${saved} · ${Buffer.byteLength(origin, 'utf8')} → ${Buffer.byteLength(afterNoop, 'utf8')} 字节 · 空行 ${blankLines(origin)} → ${blankLines(afterNoop)}`);
  check('原样保存保留末尾换行', origin.endsWith('\n') === afterNoop.endsWith('\n'),
    `origin=${origin.endsWith('\n')} after=${afterNoop.endsWith('\n')}`);
  await shot('02-after-noop-save');

  /* ---------- 4. 再存一次：没改就是没改 ---------- */
  const secondSave = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')].find((b) => /^保存/.test(b.textContent.trim()));
    btn?.click();
    return true;
  })()`);
  await sleep(2400);
  const afterSecond = await readPlain();
  check('第二次原样保存仍然不变', secondSave === true && digest(afterSecond) === originHash,
    `字节 ${Buffer.byteLength(afterSecond, 'utf8')} · 空行 ${blankLines(afterSecond)}`);

  /* ---------- 5. 真改一行：改动只落在那一行 ----------
   * 用 CDP 的真输入（`Input.insertText`）而不是合成 InputEvent：
   * 合成事件不算真实输入路径，进不了编辑态，测出来的"通过"什么都没证明。
   *
   * 分两次输入是为了测「连续打字」：React 一旦在第一次输入后重设 `__html`
   * （早先的 `edited ? base : 高亮`，base 的 html 与高亮结果不是同一个字符串），
   * 光标所在的 DOM 节点会被整块换掉 —— 第二段字就落不到原来那一行了。 */
  const marker = `// visual-spec-${Date.now()}`;
  const probe = `domprobe-${Date.now()}`;
  const focused = await evaluate(`(() => {
    const el = document.querySelector('.view.on .codebody');
    if (!el) return 'no-editor';
    const line = [...el.children].find((d) => (d.textContent ?? '').includes('public class'));
    if (!line) return 'no-line';
    /* 给这一行盖个戳：输入的 DOM 节点若被 React 换掉，这个戳就跟着消失。 */
    line.setAttribute('data-probe', ${JSON.stringify(probe)});
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return 'ok';
  })()`);
  if (focused === 'ok') {
    await send('Input.insertText', { text: ' ' });
    await sleep(350); /* 留一拍给 React 重渲染：真 bug 就是在这个窗口里换掉 DOM 的 */
    await send('Input.insertText', { text: marker });
  }
  const enteredEdit = await waitFor(`(() => (document.querySelector('.view.on')?.innerText ?? '').includes('编辑态'))()`, 6000);
  const afterType = await evaluate(`(() => {
    const el = document.querySelector('.view.on .codebody');
    if (!el) return { gone: true };
    const lines = [...el.children].map((d) => d.textContent ?? '');
    const joined = lines.join('\\n');
    return {
      count: lines.length,
      joined,
      marker: joined.includes(${JSON.stringify(marker)}),
      probe: !!el.querySelector('[data-probe=${JSON.stringify(probe)}]'),
      /* 两段字必须落在**同一行**、且顺序正确：中间被换过 DOM 的话会散落或错位。 */
      sameLine: lines.some((l) => l.includes('public class') && l.trimEnd().endsWith(${JSON.stringify(marker)})),
    };
  })()`);
  check('输入第一个字符后编辑区不被清空',
    enteredEdit && afterType.gone !== true && afterType.marker === true
    && afterType.count === originLines.length && afterType.joined.includes('package'),
    `焦点=${focused} · 编辑态=${enteredEdit} · 打完字 ${afterType.count} 行（应 ${originLines.length}）· 标记在=${afterType.marker} · 仍含 package=${afterType.joined?.includes('package')}`);
  check('连续输入不被重设 DOM（光标节点存活）',
    afterType.probe === true && afterType.sameLine === true,
    `盖戳节点存活=${afterType.probe} · 两段字落在同一行=${afterType.sameLine}`);

  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')].find((b) => /^保存/.test(b.textContent.trim()));
    btn?.click();
    return true;
  })()`);
  await sleep(2600);
  const afterEdit = await readPlain();
  check('真编辑后保存：改动落盘且空行未被牵连',
    afterEdit.includes(marker)
    && blankLines(afterEdit) === blankLines(origin)
    && afterEdit.split('\n').length === origin.split('\n').length,
    `含标记=${afterEdit.includes(marker)} · 行数 ${origin.split('\n').length} → ${afterEdit.split('\n').length}`
      + ` · 空行 ${blankLines(origin)} → ${blankLines(afterEdit)} · 字节 ${Buffer.byteLength(origin, 'utf8')} → ${Buffer.byteLength(afterEdit, 'utf8')}`);
} catch (error) {
  console.error('[ERROR]', String(error?.message ?? error));
  exitCode = 1;
} finally {
  /* 夹具是仓库里的真实文件：无论成败都写回原文（这条路径不经过编辑器，直接走接口）。 */
  try {
    await fetch(`${API}/assets/${ASSET}/files/save?workspaceId=${WS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: REL, content: origin }),
    });
    const restored = await readPlain();
    console.log(digest(restored) === originHash ? '已恢复原文（字节一致）' : '⚠ 恢复后字节不一致，请检查夹具');
  } catch (error) {
    console.log(`[warn] 恢复原文失败：${String(error)}`);
  }
  try { ws?.close(); } catch { /* 已关闭 */ }
  try { chrome.kill(); } catch { /* 已退出 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n保存路径完整性：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  for (const item of failed) console.log(`  ✗ ${item.label} — ${item.detail}`);
  exitCode = 1;
}
process.exit(exitCode);
