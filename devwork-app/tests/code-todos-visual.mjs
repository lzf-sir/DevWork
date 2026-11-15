/**
 * 遗留标记面板视觉验收（Chrome headless + CDP）。
 *
 * 目的：把「三个扫描缺口必须分开说」这条纪律钉在**渲染结果**上，而不是只钉在类型上。
 * 具体要证明：
 *   1. 右栏有入口，且不自动扫描（整仓遍历是同步的，进详情就扫会拖住首屏）；
 *   2. 扫完右栏先给**覆盖率 + 条数**，不能只给条数；
 *   3. 底部面板抬头是「遗留标记」，每条命中带行号 + 标记 + 说明；
 *   4. 归属按 codeFile 分叉：方法内 / 类内 / 模块级三种措辞都要能出现，
 *      非代码文件不该印归属；
 *   5. 扫描完整时**不许出现**「已列」——那是缺口专用措辞，没有缺口还说就是撒谎；
 *   6. 点一行能跳到那个文件（跨文件走 openSource）。
 *
 * 用法：node tests/code-todos-visual.mjs [输出目录]
 * 前置：后端 3001 与 vite 5173 已启动；或用 DEVWORK_UI 指向另一套实例。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/code-todos-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = process.env.DEVWORK_UI ?? 'http://127.0.0.1:5173/';
const PORT = 9339;

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

  /* ---------- 1. 进入代码库详情 ---------- */
  await sleep(3200);
  const opened = await evaluate(OPEN_ASSET);
  for (let i = 0; i < 20; i += 1) {
    const onCode = await evaluate(`(() => !!document.querySelector('.view.on[data-view="detail-code"]'))()`);
    if (onCode) break;
    await sleep(300);
  }
  await sleep(2600);
  check('进入代码库详情', opened === 'ok', `open=${opened}`);

  /* 入口存在、且此时**还没有**摘要（不自动扫描）。 */
  const entry = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.view.on .rinfo .sym')];
    const btn = rows.find((r) => /扫描.*TODO/i.test(r.textContent));
    return {
      found: !!btn,
      text: btn?.textContent.trim() ?? '',
      /* 未扫描时不该出现「条 · 个文件」这组数字。 */
      hasSummary: rows.some((r) => /\\d+ 条 · \\d+ 个文件/.test(r.textContent)),
    };
  })()`);
  check('右栏有「扫描遗留标记」入口', entry.found, entry.text || '未找到入口');
  check('进详情不自动扫描（未点之前没有数字）', entry.found && !entry.hasSummary,
    `hasSummary=${entry.hasSummary}`);
  await shot('01-before-scan');

  /* ---------- 2. 点扫描 ---------- */
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.view.on .rinfo .sym')];
    const btn = rows.find((r) => /扫描.*TODO/i.test(r.textContent));
    btn?.click();
    return true;
  })()`);
  await sleep(3000);
  await shot('02-after-scan');

  const rail = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.view.on .rinfo .sym')].map((r) => r.textContent.trim());
    return {
      summary: rows.find((t) => /\\d+ 条 · \\d+ 个文件|没有遗留标记|没扫到/.test(t)) ?? '',
      short: rows.filter((t) => /^(TODO|FIXME|HACK) /.test(t)).length,
    };
  })()`);
  check('右栏给出条数 + 文件数', /\d+ 条 · \d+ 个文件/.test(rail.summary), rail.summary || '未找到摘要');
  check('右栏另列前几条命中（可直接跳）', rail.short > 0 && rail.short <= 3, `short rows=${rail.short}`);

  /* ---------- 3. 底部面板 ---------- */
  const panel = await evaluate(`(() => {
    const p = document.querySelector('.view.on .rp');
    if (!p) return null;
    const body = p.querySelector('.rp-body');
    const rows = [...p.querySelectorAll('.rp-row')];
    return {
      head: p.querySelector('.rp-head')?.textContent.trim() ?? '',
      text: body?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      rows: rows.length,
      /* 每行必须同时有行号、标记、说明——缺一样这条列表就没法直接拿去改代码。 */
      complete: rows.filter((r) => r.querySelector('.n') && r.querySelector('.rp-tag') && r.querySelector('.why')).length,
      who: rows.map((r) => r.querySelector('.rp-who')?.textContent.trim() ?? ''),
      sections: [...p.querySelectorAll('.rp-sec')].map((s) => s.textContent.trim()),
      hasUndefined: /undefined|NaN|\\[object/.test(body?.textContent ?? ''),
    };
  })()`);
  check('点扫描后出现底部面板', !!panel, panel ? `抬头=${panel.head}` : '未渲染 .rp');
  check('面板抬头是「遗留标记」', !!panel && panel.head.includes('遗留标记'), panel?.head ?? '—');
  check('每行带行号 + 标记 + 说明', !!panel && panel.rows > 0 && panel.complete === panel.rows,
    panel ? `rows=${panel.rows} 完整行=${panel.complete}` : '—');
  check('面板按文件分组（分组标题带条数）', !!panel && panel.sections.length > 0
    && panel.sections.every((s) => /（\d+ 条）$/.test(s)), panel ? panel.sections.join(' | ') : '—');
  check('面板无 undefined / NaN 泄漏', !!panel && !panel.hasUndefined, panel ? `rows=${panel.rows}` : '—');

  /* 归属三种措辞：方法内（带点）、类内（等于类名）、模块级。 */
  const who = panel?.who ?? [];
  check('方法内命中给出 `在 类.方法 里`', who.some((w) => /^在 [\w$]+\.[\w$]+ 里$/.test(w)),
    who.filter((w) => w.includes('.')).join(' | ') || '—');
  check('类内命中给出 `在 类名 里`', who.some((w) => /^在 [\w$]+ 里$/.test(w)),
    who.filter((w) => /^在 [\w$]+ 里$/.test(w)).join(' | ') || '—');
  check('文件头命中给出「模块级」而不是编一个符号', who.some((w) => w.includes('模块级')),
    who.filter((w) => w.includes('模块级')).join(' | ') || '—');

  /* 扫描完整时不能说「已列」——那是缺口分支的措辞。 */
  check('扫描完整时不出现「已列 / 未覆盖」', !!panel
    && !panel.head.includes('已列') && !panel.text.includes('未覆盖全部'), panel?.head ?? '—');

  /* ---------- 4. 没改内容就点保存：不该标过期 ---------- */
  /* 假警多了，真警就没人信。这条同时盯一个隐藏风险：保存走的是 contentEditable 的
   * innerText，如果它和磁盘字节不一致（空白被规范化），那么"只是点一下保存"也会
   * 真的改盘——那才是比标过期更严重的问题，这里会直接红。 */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')]
      .find((b) => b.textContent.includes('保存'));
    btn?.click();
    return true;
  })()`);
  await sleep(2600);
  const noopSave = await evaluate(`(() => {
    const p = document.querySelector('.view.on .rp');
    const warn = p?.querySelector('.rp-warn');
    return {
      stale: !!warn,
      warn: warn?.textContent.trim().slice(0, 40) ?? '',
      head: p?.querySelector('.rp-head')?.textContent.trim() ?? '',
    };
  })()`);
  check('没改内容点保存 → 不标过期（不做假警）', noopSave.stale === false,
    `stale=${noopSave.stale} warn=${noopSave.warn || '—'} head=${noopSave.head}`);

  /* ---------- 5. 保存后必须立刻失效（过期数字比没有数字更危险） ---------- */
  /* 两段编辑：第一次 input 会把 edited 从 false 翻到 true，React 会用新的
   * `file.html` 重写 innerHTML（我们的文字被抹掉）；第二次 input 时 edited 已是 true，
   * memo 命中同一个 html 字符串、React 不再重写，追加的内容才留得住。 */
  await evaluate(`(() => {
    const el = document.querySelector('.view.on .codebody');
    el.textContent = (el.innerText || el.textContent) + ' ';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);

  const edited = await evaluate(`(() => {
    const el = document.querySelector('.view.on .codebody');
    if (!el) return null;
    /* 追加一行真的 TODO：不是为了"改点东西"，而是为了让重扫结果**可验证地变了**。 */
    el.textContent = (el.innerText || el.textContent) + '\\n  // TODO: 视觉验收临时插入的标记';
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('.view.on button')]
      .find((b) => b.textContent.includes('保存'));
    if (!btn) return { save: 'no-button' };
    btn.click();
    return { hasMarker: el.textContent.includes('视觉验收临时插入的标记'), save: 'ok' };
  })()`);
  const hitBefore = panel?.rows ?? 0;
  await sleep(3200);
  await shot('04-stale');

  const staleView = await evaluate(`(() => {
    const p = document.querySelector('.view.on .rp');
    const rail = [...document.querySelectorAll('.view.on .rinfo .sym')].map((r) => r.textContent.trim());
    return {
      warn: p?.querySelector('.rp-warn')?.textContent.trim() ?? '',
      hasRescan: !!p?.querySelector('.rp-re'),
      railStale: rail.find((t) => t.includes('已修改')) ?? '',
      railNumber: rail.find((t) => /\\d+ 条 · \\d+ 个文件/.test(t)) ?? '',
    };
  })()`);
  check('保存能触发（按钮点得动、内容真改了）', edited?.hasMarker === true && edited?.save === 'ok',
    `edit=${JSON.stringify(edited)}`);
  check('保存后打开着的面板立刻标过期', staleView.warn.includes('保存前'),
    staleView.warn.slice(0, 60) || '未出现 .rp-warn');
  check('过期面板给出「重新扫描」按钮', staleView.hasRescan, `hasRescan=${staleView.hasRescan}`);
  /* 右栏必须**撤掉旧数字**：加个角标继续显示，旧数字仍然会被读走。 */
  check('过期时右栏撤掉旧数字、只留动作',
    staleView.railStale !== '' && staleView.railNumber === '',
    `stale=${staleView.railStale} number=${staleView.railNumber || '（已撤）'}`);

  await evaluate(`(() => { document.querySelector('.view.on .rp-re')?.click(); return true; })()`);
  await sleep(3200);
  const rescanned = await evaluate(`(() => {
    const p = document.querySelector('.view.on .rp');
    const rail = [...document.querySelectorAll('.view.on .rinfo .sym')].map((r) => r.textContent.trim());
    return {
      warn: p?.querySelector('.rp-warn')?.textContent.trim() ?? '',
      rows: p ? [...p.querySelectorAll('.rp-row')].length : 0,
      railNumber: rail.find((t) => /\\d+ 条 · \\d+ 个文件/.test(t)) ?? '',
    };
  })()`);
  check('重扫后过期提示消失、数字回来', rescanned.warn === '' && rescanned.railNumber !== '',
    `warn=${rescanned.warn || '（已清）'} rail=${rescanned.railNumber}`);
  /* 这一条才是「重扫真的重读了磁盘」的证据：追加的 TODO 必须出现在新结果里。 */
  check('重扫读到了刚保存的改动（行数增加）', rescanned.rows > hitBefore,
    `${hitBefore} → ${rescanned.rows} 行`);
  await shot('05-rescanned');

  /* ---------- 6. 点一行跳到那个文件 ---------- */
  const before = await evaluate(`(() => document.querySelector('.view.on .fn')?.textContent.trim() ?? '')()`);
  const jumped = await evaluate(`(() => {
    /* 面板按文件分组：先找 OrderService.java 那个小标题，再取它后面的第一行。 */
    const sec = [...document.querySelectorAll('.view.on .rp .rp-sec')]
      .find((s) => s.textContent.includes('OrderService.java'));
    if (!sec) return 'no-section';
    let row = sec.nextElementSibling;
    while (row && !row.classList.contains('rp-row')) row = row.nextElementSibling;
    if (!row) return 'no-row';
    row.click();
    return 'ok';
  })()`);
  await sleep(2500);
  const after = await evaluate(`(() => document.querySelector('.view.on .fn')?.textContent.trim() ?? '')()`);
  check('点面板一行能跳到对应文件', jumped === 'ok' && after !== '' && after !== before,
    `jump=${jumped}, ${before} → ${after}`);
  await shot('03-jumped');

  /* ---------- 7. 关闭 ---------- */
  await evaluate(`(() => { document.querySelector('.view.on .rp-head .x')?.click(); return true; })()`);
  await sleep(400);
  const closed = await evaluate(`(() => !document.querySelector('.view.on .rp'))()`);
  check('关闭按钮能关掉面板', closed === true, `closed=${closed}`);
  await shot('04-closed');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n遗留标记面板：${results.length - failed.length}/${results.length} 通过`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error('[code-todos-visual] 失败:', error);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* 已关闭 */ }
  chrome.kill();
}
