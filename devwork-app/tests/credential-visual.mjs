/**
 * 凭据区块视觉验收（Chrome headless + CDP）。
 *
 * 目的：把「吊销是真的吊销」这件事钉在渲染结果上。
 * 要证明的事：
 *   1. 凭据区读的是真实状态（不是写死的「已绑定 prod-pg-readonly · 最后使用 刚刚」）；
 *   2. 五态徽标按状态取色，「已吊销」能和「未绑定」分开——
 *      两者在库里都是 credential_bound=0，但一个是"配过又被收回"；
 *   3. 吊销前必须确认，且确认文案讲清后果（Agent 侧失权 / 本机密文被删 / 不可撤销）；
 *   4. 吊销后按钮变成「重新绑定凭据」，不是继续给「轮换」；
 *   5. 重新绑定能把资产救回来（吊销不是单向死路）。
 *
 * 用法：node tests/credential-visual.mjs [输出目录]
 * 前置：后端与 vite 已启动；用 DEVWORK_UI / DEVWORK_API 指向实例。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'tmp/credential-visual');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PAGE = process.env.DEVWORK_UI ?? 'http://127.0.0.1:5173/';
const API = process.env.DEVWORK_API ?? 'http://127.0.0.1:3001/api';
const ASSET = process.env.DEVWORK_ASSET ?? 'a-order-db-dev';
const PORT = 9343;

fs.mkdirSync(OUT_DIR, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* 夹具是真实凭据状态：跑完必须回到 active，否则下次基线漂移。 */
/* 资产级端点必须带工作区：守卫是「缺省即拒」，不带只会拿到 401 而不是凭据。 */
const WS = process.env.DEVWORK_WS ?? 'w-ops';
const originResp = await fetch(`${API}/assets/${ASSET}/credential?workspaceId=${WS}`);
const origin = (await originResp.json())?.data ?? null;
console.log(`初始凭据 state=${origin?.state} label=${origin?.label}`);

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

async function waitFor(expression, timeoutMs = 8000) {
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

  /* ---------- 1. 进数据库详情（第一个 db 资产 = dev 库） ---------- */
  const assetReady = await waitFor(`(() => document.querySelectorAll('.aitem[data-go="db"]').length > 0)()`);
  const opened = assetReady
    ? await evaluate(`(() => {
      const item = document.querySelector('.aitem[data-go="db"]');
      if (!item) return 'no-asset';
      item.click();
      return item.getAttribute('title') ?? 'ok';
    })()`)
    : 'no-asset';
  const onDb = await waitFor(`(() => !!document.querySelector('.view.on[data-view="detail-db"]'))()`);
  check('进入数据库详情', opened !== 'no-asset' && onDb, `asset=${opened} onDb=${onDb}`);
  await sleep(1500);

  /* ---------- 2. 打开资产配置抽屉，找凭据区 ---------- */
  const gear = await evaluate(`(() => {
    const btn = document.querySelector('.view.on .dcfg');
    if (!btn) return 'no-gear';
    btn.click();
    return 'ok';
  })()`);
  const drawerReady = await waitFor(`(() => {
    const el = [...document.querySelectorAll('.dwr, .dwr-cred')];
    return el.some((node) => node.textContent.includes('我的凭据'));
  })()`);
  check('配置抽屉里有「我的凭据」', gear === 'ok' && drawerReady, `gear=${gear} drawer=${drawerReady}`);
  await sleep(1200);

  const block = await evaluate(`(() => {
    const head = [...document.querySelectorAll('.dwr *')].find((el) => el.textContent.trim() === '我的凭据');
    const scope = head?.parentElement ?? document.querySelector('.dwr-cred')?.parentElement;
    if (!scope) return null;
    const badge = scope.querySelector('.cred-badge');
    return {
      badge: badge?.textContent.trim() ?? '',
      badgeTone: badge?.className ?? '',
      label: scope.querySelector('.cred-label')?.textContent.trim() ?? '',
      keys: [...scope.querySelectorAll('.cred-k')].map((k) => k.textContent.trim()),
      actions: [...scope.querySelectorAll('.cred-actions button')].map((b) => b.textContent.trim()),
      hardcoded: scope.textContent.includes('prod-pg-readonly') && scope.textContent.includes('最后使用 刚刚'),
    };
  })()`);
  check('凭据区显示真实状态（不再是写死的文案）',
    !!block && !block.hardcoded && block.badge !== '',
    block ? `badge=${block.badge} hardcoded=${block.hardcoded}` : '未找到凭据区块');
  /* 种子里 authMethod / username 是空的，所以键值行至少要有「到期」「最近使用」两行。 */
  check('显示真实凭据标签与键值行',
    !!block && block.label !== '' && block.keys.includes('到期') && block.keys.includes('最近使用'),
    block ? `label=${block.label} keys=${JSON.stringify(block.keys)}` : '—');
  check('已绑定时给「轮换」「吊销」两个动作',
    !!block && block.actions.includes('轮换凭据') && block.actions.includes('吊销'),
    block ? JSON.stringify(block.actions) : '—');
  await shot('01-bound');

  /* ---------- 3. 吊销：先确认，文案要讲清后果 ---------- */
  await evaluate(`(() => {
    const head = [...document.querySelectorAll('.dwr *')].find((el) => el.textContent.trim() === '我的凭据');
    const scope = head?.parentElement;
    const btn = [...(scope?.querySelectorAll('.cred-actions button') ?? [])].find((b) => b.textContent.trim() === '吊销');
    btn?.click();
    return true;
  })()`);
  const confirmReady = await waitFor(`(() => !!document.querySelector('.modal h3'))()`);
  const confirmModal = await evaluate(`(() => {
    const modal = document.querySelector('.modal');
    if (!modal) return null;
    return {
      title: modal.querySelector('h3')?.textContent.trim() ?? '',
      body: modal.querySelector('.mbody')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      danger: !!modal.querySelector('.btn.danger'),
    };
  })()`);
  check('吊销前弹确认框', confirmReady && !!confirmModal && confirmModal.title.includes('吊销'),
    confirmModal?.title ?? '未弹窗');
  check('确认文案讲清后果（Agent 侧失权 / 密文被删 / 不可撤销）',
    !!confirmModal
    && confirmModal.body.includes('Agent')
    && confirmModal.body.includes('密文')
    && confirmModal.body.includes('不能撤销'),
    confirmModal?.body.slice(0, 120) ?? '—');
  check('吊销按钮是危险色', !!confirmModal && confirmModal.danger === true, `danger=${confirmModal?.danger}`);
  await shot('02-confirm-revoke');

  /* ---------- 4. 确认吊销 → 徽标变「已吊销」、动作变「重新绑定」 ---------- */
  await evaluate(`(() => {
    const modal = document.querySelector('.modal');
    const btn = [...modal.querySelectorAll('button')].find((b) => /确认吊销/.test(b.textContent));
    btn?.click();
    return true;
  })()`);
  await sleep(2200);
  const afterRevoke = await evaluate(`(() => {
    const head = [...document.querySelectorAll('.dwr *')].find((el) => el.textContent.trim() === '我的凭据');
    const scope = head?.parentElement;
    if (!scope) return null;
    const badge = scope.querySelector('.cred-badge');
    return {
      badge: badge?.textContent.trim() ?? '',
      tone: badge?.className ?? '',
      actions: [...scope.querySelectorAll('.cred-actions button')].map((b) => b.textContent.trim()),
      hint: scope.querySelector('.cred-hint')?.textContent.trim() ?? '',
      toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent.replace(/\\s+/g, ' ').trim()).join(' | '),
      /* 同一屏的指标卡也必须说「已吊销」：它原来读 credential_bound 布尔，
       * 吊销后照样显示「未绑定」，和上面的徽标自相矛盾。 */
      metricCred: [...document.querySelectorAll('.dwr .mcard')]
        .map((card) => ({
          k: card.querySelector('.k')?.textContent.trim() ?? '',
          v: card.querySelector('.v')?.textContent.trim() ?? '',
        }))
        .find((row) => row.k === '凭据')?.v ?? '',
    };
  })()`);
  check('吊销后徽标变「已吊销」', !!afterRevoke && afterRevoke.badge === '已吊销',
    afterRevoke ? `badge=${afterRevoke.badge} tone=${afterRevoke.tone}` : '—');
  check('吊销后动作变成「重新绑定凭据」', !!afterRevoke && afterRevoke.actions.some((a) => a.includes('重新绑定')),
    afterRevoke ? JSON.stringify(afterRevoke.actions) : '—');
  check('指标卡与徽标自洽（不会一处说已吊销、一处说未绑定）',
    !!afterRevoke && afterRevoke.metricCred.startsWith('已吊销'),
    afterRevoke ? `metric=${afterRevoke.metricCred}` : '—');
  check('吊销后给出结果反馈（密文删除）',
    !!afterRevoke && afterRevoke.toast.includes('已吊销') && afterRevoke.toast.includes('密文'),
    afterRevoke?.toast.slice(0, 110) ?? '—');
  await shot('03-revoked');

  /* ---------- 5. 重新绑定能把资产救回来 ---------- */
  await evaluate(`(() => {
    const head = [...document.querySelectorAll('.dwr *')].find((el) => el.textContent.trim() === '我的凭据');
    const scope = head?.parentElement;
    const btn = [...(scope?.querySelectorAll('.cred-actions button') ?? [])].find((b) => b.textContent.includes('重新绑定'));
    btn?.click();
    return true;
  })()`);
  await waitFor(`(() => !!document.querySelector('.modal .minput'))()`);
  await evaluate(`(() => {
    const input = document.querySelector('.modal .minput');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'visual-spec-secret');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  await evaluate(`(() => {
    const modal = document.querySelector('.modal');
    const btn = [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === '绑定');
    btn?.click();
    return true;
  })()`);
  await sleep(2200);
  const rebound = await evaluate(`(() => {
    const head = [...document.querySelectorAll('.dwr *')].find((el) => el.textContent.trim() === '我的凭据');
    const scope = head?.parentElement;
    const badge = scope?.querySelector('.cred-badge');
    return {
      badge: badge?.textContent.trim() ?? '',
      actions: [...(scope?.querySelectorAll('.cred-actions button') ?? [])].map((b) => b.textContent.trim()),
    };
  })()`);
  check('重新绑定后回到「已绑定」且动作恢复',
    !!rebound && rebound.badge === '已绑定' && rebound.actions.includes('轮换凭据'),
    rebound ? `badge=${rebound.badge} actions=${JSON.stringify(rebound.actions)}` : '—');
  await shot('04-rebound');
} catch (error) {
  console.error('[ERROR]', String(error?.message ?? error));
  exitCode = 1;
} finally {
  /* 恢复夹具：不管页面走到哪一步，把资产凭据状态拉回 active。 */
  try {
    await fetch(`${API}/assets/${ASSET}/credential/bind?workspaceId=${WS}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: origin?.label || 'order_db · 只读凭据', secret: 'visual-spec-restore' }),
    });
    console.log('已恢复凭据为 active');
  } catch (error) {
    console.log(`[warn] 恢复凭据失败：${String(error)}`);
  }
  try { ws?.close(); } catch { /* 已关闭 */ }
  try { chrome.kill(); } catch { /* 已退出 */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n凭据区块：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  for (const item of failed) console.log(`  ✗ ${item.label} — ${item.detail}`);
  exitCode = 1;
}
process.exit(exitCode);
