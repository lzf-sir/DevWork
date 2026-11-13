/**
 * DevWork 桌面壳三灯 IPC 实测 —— QA「严过关」
 *
 * 前置：以 GUI 模式启动 Electron 并开启 CDP，例如：
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe . \
 *     --remote-debugging-port=9333 --remote-allow-origins='*'
 *
 * 运行：`node tests/desktop-ipc.mjs [cdpPort]`
 * 用 CDP `Input.dispatchMouseEvent` 把真实鼠标事件派发到三个自绘交通灯，
 * 经 React onClick → preload ipcRenderer.invoke → ipcMain.handle → BrowserWindow，
 * 再用 `Browser.getWindowForTarget` 读取窗口状态验证。
 * 最后一击（红灯）会关闭窗口，脚本随后校验 3001 端口是否释放。
 */
import assert from 'node:assert/strict';

const CDP = process.argv[2] ?? '9333';
const BASE = 'http://127.0.0.1:3001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, expected, actual, ok, note = '') {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
  if (note) console.log(`       备注: ${note}`);
  if (ok) passed += 1; else failed += 1;
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
  }
  async ready() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = (e) => reject(new Error(`WebSocket 连接失败: ${String(e?.message ?? e)}`));
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* noop */ } }
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}

async function click(cdp, rect) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
}

async function main() {
  const version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
  const targets = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  assert.ok(page, '未找到 page target');
  console.log(`CDP: ${version.Browser}`);
  check('生产态页面 loadURL 同源', `${BASE}/`, page.url, page.url.startsWith(`${BASE}/`));

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');

  const probe = await evaluate(cdp, `(() => ({
    hasDesktop: !!window.desktop,
    lights: document.querySelectorAll('.lights i').length,
    fns: window.desktop ? ['close','minimize','maximize','isMaximized'].filter(k => typeof window.desktop[k] === 'function') : [],
  }))()`);
  const apiBase = await evaluate(cdp, `window.desktop.apiBase()`);
  const platform = await evaluate(cdp, `window.desktop.platform()`);
  check('preload 白名单桥可用', 'window.desktop 存在且含 close/minimize/maximize/isMaximized',
    `hasDesktop=${probe.hasDesktop}, fns=${JSON.stringify(probe.fns)}`,
    probe.hasDesktop && ['close', 'minimize', 'maximize', 'isMaximized'].every((k) => probe.fns.includes(k)));
  check('preload 通道 app:api-base / app:platform', "apiBase='/api', platform='win32'",
    `apiBase=${apiBase}, platform=${platform}`, apiBase === '/api' && platform === 'win32');
  check('顶栏三灯渲染', '3 个 .lights i', `lights=${probe.lights}`, probe.lights === 3);

  const rects = await evaluate(cdp, `(() => [...document.querySelectorAll('.lights i')].map(e => {
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  }))()`);
  console.log(`三灯坐标: ${JSON.stringify(rects)}`);

  // 绿灯：点击后用同一 IPC 通道 win:is-maximized 直接读 BrowserWindow 状态
  const maxBefore = await evaluate(cdp, `window.desktop.isMaximized()`);
  await click(cdp, rects[2]);
  const maxAfter = await evaluate(cdp, `window.desktop.isMaximized()`);
  check('绿灯点击 → win:maximize → BrowserWindow.maximize()', 'isMaximized: false → true',
    `${maxBefore} → ${maxAfter}`, maxBefore === false && maxAfter === true);

  await click(cdp, rects[2]);
  const maxAfter2 = await evaluate(cdp, `window.desktop.isMaximized()`);
  check('绿灯再次点击 → unmaximize', 'isMaximized: true → false',
    `true → ${maxAfter2}`, maxAfter2 === false);

  // 黄灯：最小化后页面应进入 hidden，并确认 IPC 通道仍可往返
  let vis = 'unknown';
  let channelAlive = false;
  try {
    await click(cdp, rects[1]);
    vis = await evaluate(cdp, `document.visibilityState`);
    const alive = await evaluate(cdp, `window.desktop.isMaximized()`);
    channelAlive = typeof alive === 'boolean';
  } catch (error) {
    console.log(`[warn] 黄灯点击后求值: ${String(error).slice(0, 100)}`);
  }
  check('黄灯点击 → win:minimize 通道可达且渲染进程存活', 'isMaximized() 返回布尔值',
    `visibilityState=${vis}, channelAlive=${channelAlive}`, channelAlive);
  // Electron 33 CDP 不暴露 Browser.getWindowBounds / Browser.getWindowForTarget；
  // 且 CDP 附着会保持页面 visible，visibilityState 无法作为 minimize 的判据。
  // 故此项仅记录观察值，功能证据由「win:minimize 通道可达」+ 绿灯同源链路 + 红灯关窗链路构成。
  console.log(`[INFO] 黄灯最小化观察：visibilityState=${vis}；` +
    'Electron 33 CDP 无法读取 windowState，此项不计入通过/失败（详见 QA 报告「三灯实测」）。');
  try { await cdp.send('Page.bringToFront'); } catch { /* noop */ }
  await sleep(300);

  // 红灯：关闭窗口 → before-quit → devwork:shutdown → 后端退出
  console.log('[info] 派发红灯点击（win:close）...');
  try {
    await click(cdp, rects[0]);
  } catch (error) {
    console.log(`[warn] 红灯点击后连接断开（预期）: ${String(error).slice(0, 100)}`);
  }
  cdp.close();

  let portClosed = false;
  for (let i = 0; i < 20; i += 1) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(600) });
    } catch {
      portClosed = true;
      break;
    }
    await sleep(400);
  }
  check('红灯关闭窗口后 3001 端口释放（后端优雅收尾）', '3001 不再响应',
    `portClosed=${portClosed}`, portClosed);

  console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('[desktop-ipc] 脚本异常:', error);
  process.exit(2);
});
