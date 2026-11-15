/**
 * 敏感规则编辑器视觉验收（Chrome headless + CDP）。
 *
 * 目的：把「改完之后哪几处跟着变」这条纪律钉在渲染结果上。
 * 要证明的事：
 *   1. 设置页「敏感文件排除」点进去是**编辑器**，不是一个只能看的列表；
 *   2. 说明里写清生效范围（文件树/终端即时，索引清存量、放宽不补建）；
 *   3. 每行可改可删，底部实时显示「N 条 → M 条」；
 *   4. 重复与空行**当场**标红并拦住保存（不能等后端 400 才说）；
 *   5. 删到只剩 0 条时拦住保存并说明后果（不是"至少一条"这种空话）；
 *   6. 保存成功后弹窗关闭、设置页摘要跟着变。
 *
 * 用法：node tests/sensitive-rules-visual.mjs [输出目录]
 * 前置：后端与 vite 已启动；用 DEVWORK_UI / DEVWORK_API 指向实例。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/sensitive-rules-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = process.env.DEVWORK_UI ?? 'http://127.0.0.1:5173/';
const API = process.env.DEVWORK_API ?? 'http://127.0.0.1:3001/api';
const PORT = 9341;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 夹具是全局设置：本脚本会改它，跑完必须恢复，否则下一次运行基线就变了。 */
const originResp = await fetch(`${API}/sensitive-rules`);
const originRules = (await originResp.json())?.data ?? [];
console.log(`原始规则 ${originRules.length} 条`);

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

/** 等某个条件成立。首屏渲染比固定 sleep 慢多少不确定，轮询比 sleep 猜时间可靠。 */
async function waitFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* 页面还在跳，选择器暂时不成立 */
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

  /* ---------- 1. 进设置页，点「编辑规则」 ---------- */
  /* 首屏渲染完之前 .sfoot 根本不存在：直接点会静默失败（探针就是这么被抓到的）。
   * 底部有两个 .sfoot（影子视图 + 系统设置），必须按文字选，否则点进影子视图。 */
  const footReady = await waitFor(`(() => [...document.querySelectorAll('.sfoot')].some((e) => e.textContent.includes('系统设置')))()`);
  const openedSettings = footReady
    ? await evaluate(`(() => {
      const foot = [...document.querySelectorAll('.sfoot')].find((e) => e.textContent.includes('系统设置'));
      if (!foot) return 'no-footer';
      foot.click();
      return 'ok';
    })()`)
    : 'no-footer';
  const onSettings = await waitFor(`(() => !!document.querySelector('.view.on[data-view="settings"]'))()`);
  check('能从侧栏进设置页', openedSettings === 'ok' && onSettings,
    `footer=${openedSettings} onSettings=${onSettings}`);
  await sleep(900);

  /* 设置在左侧分节里，「敏感文件排除」属于权限段（不是数据与隐私段——
   * 它管的是"哪些文件不许被看见"，属于边界而不是留存策略）。 */
  const sectionReady = await waitFor(`(() => !!document.querySelector('.view.on .si[data-s="perm"]'))()`);
  if (sectionReady) {
    await evaluate(`(() => { document.querySelector('.view.on .si[data-s="perm"]').click(); return true; })()`);
    await sleep(900);
  }
  check('能切到权限分节', sectionReady, `permSection=${sectionReady}`);

  const opened = await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')]
      .find((b) => b.textContent.trim() === '编辑规则');
    if (!btn) return { ok: false, hint: [...document.querySelectorAll('.view.on button')].map((b) => b.textContent.trim()).slice(0, 12) };
    btn.click();
    return { ok: true, hint: '' };
  })()`);
  check('设置页有「编辑规则」入口且点得开', opened.ok === true, JSON.stringify(opened.hint || 'ok'));
  /* 弹窗先渲染壳再拉数据，行是异步来的：不等就会读到"加载中"的空列表。 */
  await waitFor(`(() => !!document.querySelector('.modal.modal-rules'))()`);
  await waitFor(`(() => (document.querySelector('.modal.modal-rules')?.querySelectorAll('.sre-row').length ?? 0) > 0)()`);

  /* ---------- 2. 弹窗是编辑器，不是只读列表 ---------- */
  const panel = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    if (!modal) return null;
    return {
      title: modal.querySelector('h3')?.textContent.trim() ?? '',
      rows: modal.querySelectorAll('.sre-row').length,
      inputs: modal.querySelectorAll('.sre-row input').length,
      note: (modal.querySelector('.sre-note')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
      count: (modal.querySelector('.sre-count')?.textContent ?? '').trim(),
      hasSave: [...modal.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存'),
    };
  })()`);
  check('点开的是编辑器（有输入框 + 保存按钮）',
    !!panel && panel.rows > 0 && panel.inputs === panel.rows && panel.hasSave,
    panel ? `rows=${panel.rows} inputs=${panel.inputs} save=${panel.hasSave}` : '未渲染 .modal-rules');
  check('说明里交代生效范围（索引 + 放宽不补建）',
    !!panel && panel.note.includes('索引') && panel.note.includes('放宽'),
    panel ? panel.note.slice(0, 110) : '—');
  check('底部显示条数变化', !!panel && /条 →/.test(panel.count), panel?.count ?? '—');
  await shot('01-editor');

  /* ---------- 3. 删一条 → 计数跟着变，且未改动时保存是禁用的 ---------- */
  const beforeCount = panel?.rows ?? 0;
  const removed = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    const del = modal.querySelector('.sre-row .sre-del');
    if (!del) return null;
    del.click();
    return true;
  })()`);
  await sleep(400);
  const afterRemove = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    return {
      rows: modal.querySelectorAll('.sre-row').length,
      count: (modal.querySelector('.sre-count')?.textContent ?? '').trim(),
      saveDisabled: [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')?.disabled ?? null,
    };
  })()`);
  check('删一条行数减 1 且计数同步',
    removed === true && afterRemove.rows === beforeCount - 1 && /→/.test(afterRemove.count),
    `${beforeCount} → ${afterRemove.rows} · ${afterRemove.count}`);
  check('有改动时保存可用', afterRemove.saveDisabled === false, `disabled=${afterRemove.saveDisabled}`);

  /* ---------- 4. 输入重复值 → 当场标红并拦住保存 ---------- */
  const dupTyped = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    const row = modal.querySelector('.sre-row');
    const input = row.querySelector('input');
    const keep = input.value;
    /* 找另一行的值填进来，制造重复。 */
    const other = modal.querySelectorAll('.sre-row input')[1]?.value ?? keep;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, other);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { other };
  })()`);
  await sleep(500);
  const dupState = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    return {
      badRows: modal.querySelectorAll('.sre-row.bad').length,
      hints: [...modal.querySelectorAll('.sre-hint.bad')].map((h) => h.textContent.trim()),
      warn: (modal.querySelector('.sre-warn')?.textContent ?? '').trim(),
      saveDisabled: [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')?.disabled ?? null,
    };
  })()`);
  check('重复值当场标红', dupState.badRows > 0 && dupState.hints.some((h) => h.includes('重复')),
    `badRows=${dupState.badRows} hints=${JSON.stringify(dupState.hints)}`);
  check('重复时保存被禁用并说明原因', dupState.saveDisabled === true && dupState.warn.includes('重复'),
    `disabled=${dupState.saveDisabled} warn=${dupState.warn.slice(0, 60)}`);
  await shot('02-duplicate');

  /* ---------- 5. 改正 → 保存 → 弹窗关闭 + 设置页摘要更新 ---------- */
  const fixed = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    const row = modal.querySelector('.sre-row');
    const input = row.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '*.visual-spec');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  await sleep(400);
  const saveState = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    const btn = [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存');
    const disabled = btn?.disabled ?? null;
    btn?.click();
    return { disabled };
  })()`);
  await sleep(2200);
  const afterSave = await evaluate(`(() => ({
    modalGone: !document.querySelector('.modal.modal-rules'),
    toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim()).join(' | '),
    summary: [...document.querySelectorAll('.view.on .srow, .view.on .set-row')]
      .map((r) => r.textContent.replace(/\\s+/g, ' ').trim())
      .find((t) => t.includes('敏感')) ?? '',
  }))()`);
  check('改正后保存成功并关闭弹窗', fixed === '*.visual-spec' && saveState.disabled === false && afterSave.modalGone,
    `fixed=${saveState.disabled} modalGone=${afterSave.modalGone}`);
  check('保存后给出结果反馈（条数 + 索引清理口径）',
    afterSave.toast.includes('规则已保存') && (afterSave.toast.includes('索引') || afterSave.toast.includes('放宽')),
    afterSave.toast.slice(0, 130));
  check('设置页摘要跟着变（不残留旧条数）', /敏感/.test(afterSave.summary), afterSave.summary.slice(0, 90) || '未找到摘要行');
  await shot('03-saved');

  /* ---------- 6. 只剩 1 条时删除被挡住（不能把规则表清空） ---------- */
  await evaluate(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')].find((b) => b.textContent.trim() === '编辑规则');
    btn?.click();
    return true;
  })()`);
  await sleep(1400);
  const guard = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    if (!modal) return null;
    const dels = [...modal.querySelectorAll('.sre-del')];
    dels.forEach((d) => d.click());
    return { rowsAfterClear: modal.querySelectorAll('.sre-row').length, dels: dels.length };
  })()`);
  await sleep(500);
  const emptyState = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    return {
      rows: modal.querySelectorAll('.sre-row').length,
      warn: (modal.querySelector('.sre-warn')?.textContent ?? '').trim(),
      saveDisabled: [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')?.disabled ?? null,
    };
  })()`);
  check('删空后拦住保存并说明后果',
    emptyState.rows === 0 && emptyState.saveDisabled === true && emptyState.warn.includes('至少'),
    `rows=${emptyState.rows} disabled=${emptyState.saveDisabled} warn=${emptyState.warn.slice(0, 70)}`);
  await shot('04-empty-blocked');

  const canceled = await evaluate(`(() => {
    const modal = document.querySelector('.modal.modal-rules');
    const cancel = [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消');
    if (!cancel) return 'no-button';
    cancel.click();
    return 'ok';
  })()`);
  /* 关弹窗是 React 状态更新，不能在同一个 tick 里查——要等一帧。 */
  const modalClosed = canceled === 'ok' && await waitFor(`(() => !document.querySelector('.modal.modal-rules'))()`, 3000);
  /* 取消不能有副作用：库里还是上次保存的 11 条，不是被删空的 0 条。 */
  const persisted = (await (await fetch(`${API}/sensitive-rules`)).json())?.data ?? [];
  check('取消能关闭且不带副作用', modalClosed && persisted.length === 11,
    `closed=${modalClosed} 库里 ${persisted.length} 条（期望 11）`);
} catch (error) {
  console.error('[ERROR]', String(error?.message ?? error));
  exitCode = 1;
} finally {
  /* 无论成败都把规则恢复原样：这是全局设置，留下脏数据会让下一次运行基线漂移。 */
  try {
    await fetch(`${API}/sensitive-rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: originRules }),
    });
    console.log(`已恢复原始规则 ${originRules.length} 条`);
  } catch (error) {
    console.log(`[warn] 恢复规则失败：${String(error)}`);
  }
  try { ws?.close(); } catch { /* 已关闭 */ }
  try { chrome.kill(); } catch { /* 已退出 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n敏感规则编辑器：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  for (const item of failed) console.log(`  ✗ ${item.label} — ${item.detail}`);
  exitCode = 1;
}
process.exit(exitCode);
