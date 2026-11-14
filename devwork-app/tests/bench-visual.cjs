/**
 * 侧边工作区（多 tab）+ 会话右缘入口坞 —— 视觉与交互验证。
 *
 * 覆盖的需求（第二版，按产品口径收敛）：
 *   1. 入口是会话右缘**四个固定图标**：上下文 / 任务列表 / 产物 / 浏览器；
 *   2. 图标是入口，工作区是**内容展示区**：点图标 → 内容显示在工作区；
 *   3. **产物清单不进工作区** —— 点产物只弹浮层选文件，选中后才在工作区开详情 tab；
 *   4. 工作区 tab 可多开、可关闭；
 *   5. 工作区**默认收起、不固定任何 tab**：用户点第一个图标才展开。
 *
 * 前置：一个实例在 DEVWORK_PORT（默认 3001）上跑着，且前端已构建（dist 存在）。
 * 运行：node tests/run-electron.cjs bench-visual.cjs
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PORT = process.env.DEVWORK_PORT ?? '3001';
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'bench-visual');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function check(name, expected, actual, ok, note = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    if (note) console.log(`       ${note}`);
    return;
  }
  failures.push(name);
  console.log(`[FAIL] ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
}

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const bail = setTimeout(() => {
    console.log('[bench-visual] 兜底超时退出（测试链被中断）');
    app.exit(2);
  }, 180000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    /* 窗口可见：隐藏窗口里 <webview> 客体经常不初始化，Agent 导航断言就没法验。 */
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });

  const shot = async (name) => {
    await sleep(400);
    await win.webContents.invalidate();
    await sleep(400);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, name), img.toPNG());
  };

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3 && !/Electron Security Warning/.test(message)) consoleErrors.push(message);
  });

  const js = (code) => win.webContents.executeJavaScript(code);
  const clickHud = (label) => js(`(() => {
    const btn = [...document.querySelectorAll('.hud-btn')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  const benchState = () => js(`(() => {
    const bench = document.querySelector('.bench');
    if (!bench) return { ok: false };
    const tabs = [...bench.querySelectorAll('.ptab')];
    const active = tabs.find((t) => t.classList.contains('on'));
    const pane = bench.querySelector('.pb.on');
    return {
      ok: true,
      tabs: tabs.map((t) => (t.querySelector('.ptab-name')?.textContent ?? '').trim()),
      active: (active?.querySelector('.ptab-name')?.textContent ?? '').trim(),
      kind: pane?.dataset.p ?? '',
      text: (pane?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 180),
      empty: !!bench.querySelector('.bench-empty'),
      hasList: !!bench.querySelector('.frow'),
    };
  })()`);

  console.log(`[bench-visual] 目标页面：${URL}`);

  await win.loadURL(URL);
  await sleep(3200);
  /* 钉住种子会话「GMV 归因」(c-gmv)：Agent 导航推送与产物断言都以它为准。 */
  const convPinned = await js(`(() => {
    const hit = [...document.querySelectorAll('.sitem')].find((el) => (el.textContent ?? '').includes('GMV 归因'));
    if (hit) hit.click();
    return !!hit;
  })()`);
  check('选中种子会话 GMV 归因', '侧栏找到并点击', `ok=${convPinned}`, convPinned === true);
  await sleep(1200);

  /* ---------- 1. 会话右缘：四个固定入口 ---------- */
  const dock = await js(`(() => {
    const dock = document.querySelector('.hud-dock');
    const chat = document.querySelector('.view.on[data-view="chat"]');
    if (!dock || !chat) return { ok: false };
    const buttons = [...dock.querySelectorAll('.hud-btn')];
    const chatRect = chat.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    return {
      ok: true,
      count: buttons.length,
      labels: buttons.map((b) => b.getAttribute('aria-label')),
      nearRight: chatRect.right - dockRect.right,
      insideChat: dockRect.top >= chatRect.top && dockRect.bottom <= chatRect.bottom,
    };
  })()`);

  const EXPECT = ['上下文', '任务列表', '产物', '浏览器'];
  check('会话右缘有 4 个入口图标', `4 个：${EXPECT.join('/')}`,
    `count=${dock.count}, labels=${(dock.labels ?? []).join('/')}`,
    dock.ok === true && dock.count === 4 && (dock.labels ?? []).join('/') === EXPECT.join('/'));
  check('入口贴着会话区右缘', '右缘间距 < 40px',
    `gap=${dock.nearRight}`, typeof dock.nearRight === 'number' && dock.nearRight < 40);
  check('入口坞落在会话区内部', '完全落在会话区内',
    `insideChat=${dock.insideChat}`, dock.insideChat === true);

  /* ---------- 2. 默认：工作区收起，不固定任何 tab ---------- */
  const initial = await js(`(() => {
    const bench = document.querySelector('.bench');
    return {
      hasBench: !!bench,
      visible: !!bench && getComputedStyle(bench).display !== 'none',
      tabs: bench?.querySelectorAll('.ptab').length ?? -1,
      restore: !!document.querySelector('.bench-restore'),
      chatWidth: document.querySelector('.view.on[data-view="chat"]')?.getBoundingClientRect().width ?? 0,
    };
  })()`);
  check('默认收起工作区，且不固定任何 tab', 'bench 不可见、tab 数=0、右上角有展开按钮',
    JSON.stringify(initial),
    initial.hasBench === true
      && initial.visible === false
      && initial.tabs === 0
      && initial.restore === true);

  /* ---------- 3. 点「上下文」→ 展开工作区并开第一个 tab ---------- */
  await clickHud('上下文');
  await sleep(700);
  const afterCtx = await benchState();
  check('点「上下文」展开工作区并开 tab', 'tabs=[上下文]，激活=上下文，内容含「已挂载」',
    JSON.stringify(afterCtx).slice(0, 240),
    afterCtx.ok === true
      && afterCtx.tabs.join('/') === '上下文'
      && afterCtx.kind === 'ctx'
      && afterCtx.empty === false
      && afterCtx.text.includes('已挂载'));

  /* ---------- 4. 点「任务列表」→ 工作区开第二个 tab ---------- */
  await clickHud('任务列表');
  await sleep(600);
  const afterTodo = await benchState();
  check('点「任务列表」在工作区新开 tab 并激活', 'tabs=[上下文/任务列表]，激活=任务列表',
    JSON.stringify(afterTodo).slice(0, 240),
    afterTodo.tabs.join('/') === '上下文/任务列表'
      && afterTodo.active === '任务列表'
      && afterTodo.kind === 'todo');
  check('任务列表是清单视图（不是产物清单）', '含「清单」/「完成度」/空态说明',
    afterTodo.text.slice(0, 120),
    /清单|完成度|还没有任务清单/.test(afterTodo.text) && afterTodo.hasList === false);

  /* ---------- 5. 点「浏览器」→ 第三个 tab ---------- */
  await clickHud('浏览器');
  await sleep(900);
  const afterBrowser = await js(`(() => {
    const bench = document.querySelector('.bench');
    const pane = bench?.querySelector('.pb.on');
    return {
      tabs: [...(bench?.querySelectorAll('.ptab') ?? [])].map((t) => (t.querySelector('.ptab-name')?.textContent ?? '').trim()),
      kind: pane?.dataset.p ?? '',
      hasUrl: !!pane?.querySelector('.brp-url'),
    };
  })()`);
  check('点「浏览器」在工作区新开 tab', 'tabs 含浏览器，激活 browser，有地址栏',
    JSON.stringify(afterBrowser).slice(0, 200),
    afterBrowser.tabs.includes('浏览器') && afterBrowser.kind === 'browser' && afterBrowser.hasUrl === true);
  const tabsBeforePicker = afterBrowser.tabs.length;
  await shot('01-bench-tabs.png');

  /* ---------- 6. 点「产物」→ 只弹浮层，工作区不新增 tab ---------- */
  await clickHud('产物');
  await sleep(600);
  const picker = await js(`(() => {
    const pop = document.querySelector('.hud-pop');
    const bench = document.querySelector('.bench');
    const rows = [...(pop?.querySelectorAll('.frow') ?? [])];
    return {
      open: !!pop,
      title: pop?.querySelector('.hud-pop-t')?.textContent?.trim() ?? '',
      rows: rows.length,
      names: rows.map((r) => r.querySelector('.fn')?.textContent?.trim() ?? ''),
      benchTabs: [...(bench?.querySelectorAll('.ptab') ?? [])].length,
      benchHasList: !!bench?.querySelector('.frow'),
    };
  })()`);
  check('点「产物」弹出选择浮层', '浮层出现，标题=产物，列出行',
    JSON.stringify({ ...picker, names: picker.names.slice(0, 3) }).slice(0, 220),
    picker.open === true && picker.title === '产物' && picker.rows >= 1);
  check('产物清单不进工作区', '工作区 tab 数不变，工作区内没有 .frow 列表',
    `tabs=${picker.benchTabs}/${tabsBeforePicker}, hasList=${picker.benchHasList}`,
    picker.benchTabs === tabsBeforePicker && picker.benchHasList === false);
  await shot('02-artifact-picker.png');

  /* ---------- 7. 浮层里选一个 → 工作区开详情 tab，浮层收起 ---------- */
  const picked = picker.names[0] ?? '';
  await js(`(() => {
    const row = document.querySelector('.hud-pop .frow');
    if (row) row.click();
    return !!row;
  })()`);
  await sleep(1600);
  const detail = await js(`(() => {
    const bench = document.querySelector('.bench');
    const pane = bench?.querySelector('.pb.on');
    return {
      tabs: [...(bench?.querySelectorAll('.ptab') ?? [])].map((t) => (t.querySelector('.ptab-name')?.textContent ?? '').trim()),
      active: (bench?.querySelector('.ptab.on .ptab-name')?.textContent ?? '').trim(),
      kind: pane?.dataset.p ?? '',
      name: (pane?.querySelector('.filp-name')?.textContent ?? '').trim(),
      hasImage: !!pane?.querySelector('.filp-img img'),
      hasText: !!pane?.querySelector('.filp-text'),
      hasTable: !!pane?.querySelector('.filp-table'),
      hasFrame: !!pane?.querySelector('.filp-frame'),
      note: (pane?.querySelector('.filp-note')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 90),
      popOpen: !!document.querySelector('.hud-pop'),
    };
  })()`);
  check('选中产物后在工作区开详情 tab', `激活 tab = ${picked}，kind=artifact`,
    JSON.stringify(detail).slice(0, 240),
    detail.kind === 'artifact' && detail.active === picked && detail.tabs.length === tabsBeforePicker + 1);
  check('产物详情真的渲染了内容', '图片 / 文本 / 表格 / frame / 二进制说明 至少一种',
    JSON.stringify(detail).slice(0, 240),
    detail.name === picked
      && (detail.hasImage || detail.hasText || detail.hasTable || detail.hasFrame || detail.note.includes('二进制')));
  check('选完浮层自动收起', '页面上没有 .hud-pop', `popOpen=${detail.popOpen}`, detail.popOpen === false);
  await shot('03-artifact-detail.png');

  /* ---------- 8. tab 可关闭：关掉激活页，激活落到邻居 ---------- */
  const closed = await js(`(() => {
    const x = document.querySelector('.bench .ptab.on .ptab-close');
    if (!x) return false;
    x.click();
    return true;
  })()`);
  await sleep(500);
  const afterClose = await js(`(() => {
    const bench = document.querySelector('.bench');
    return {
      count: bench?.querySelectorAll('.ptab').length ?? 0,
      active: (bench?.querySelector('.ptab.on .ptab-name')?.textContent ?? '').trim(),
      hasClose: !!bench?.querySelector('.ptab .ptab-close'),
    };
  })()`);
  check('tab 有关闭按钮，关掉激活页后激活落到邻居', 'tab 数减 1，仍有激活页',
    `closed=${closed} | ${JSON.stringify(afterClose)}`,
    closed === true && afterClose.count === tabsBeforePicker && afterClose.active.length > 0 && afterClose.hasClose === true);

  /* ---------- 9. 重复点同一图标只激活，不新开 ---------- */
  await clickHud('上下文');
  await sleep(500);
  const reactivated = await benchState();
  check('重复点同一图标只激活不新开', 'tab 数不变，激活=上下文',
    JSON.stringify(reactivated).slice(0, 160),
    reactivated.tabs.length === tabsBeforePicker && reactivated.active === '上下文');

  /* ---------- 10. 浏览器 Agent 导航仍然可用 ---------- */
  await clickHud('浏览器');
  await sleep(800);
  try {
    execFileSync('node', [
      path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(ROOT, 'tests', 'browser-push.ts'),
      'c-gmv',
      `${URL}/api/health`,
    ], { cwd: ROOT, stdio: 'pipe', windowsHide: true, timeout: 60000 });
  } catch (error) {
    console.log(`       [提示] browser-push 执行失败：${error.message}`);
  }
  await sleep(4000);
  let afterAgent = { url: '', tag: '' };
  for (let i = 0; i < 20; i += 1) {
    afterAgent = await js(`(() => {
      const pane = document.querySelector('.bench .pb.on');
      const wv = pane?.querySelector('.brp-host webview');
      const frame = pane?.querySelector('.brp-frame');
      let url = frame?.getAttribute('src') ?? '';
      if (wv) {
        try {
          url = typeof wv.getURL === 'function' ? (wv.getURL() || wv.getAttribute('src') || '') : (wv.getAttribute('src') || '');
        } catch {
          url = wv.getAttribute('src') || '';
        }
      }
      const tag = pane?.querySelector('.brp-tag')?.textContent?.trim() ?? '';
      return { url, tag };
    })()`);
    if (String(afterAgent.url).includes('/api/health')) break;
    await sleep(500);
  }
  check('Agent 导航后浏览器真的跳转了', '地址指向目标，标签显示 Agent 驱动',
    JSON.stringify(afterAgent), String(afterAgent.url).includes('/api/health') && afterAgent.tag.includes('Agent'));

  const pageText = await js(`(async () => {
    const res = await fetch('/api/conversations/c-gmv/browser/page');
    const json = await res.json();
    return json?.data?.text ?? '';
  })()`);
  check('页面正文已回传服务端（Agent 可读）', '快照里有页面内容',
    pageText.slice(0, 80), pageText.length > 10);

  /* ---------- 11. 关掉最后一个 tab → 工作区自动收起 ---------- */
  for (let i = 0; i < 14; i += 1) {
    const removed = await js(`(() => {
      const x = document.querySelector('.bench .ptab .ptab-close');
      if (!x) return false;
      x.click();
      return true;
    })()`);
    if (!removed) break;
    await sleep(250);
  }
  await sleep(500);
  const autoCollapsed = await js(`(() => {
    const bench = document.querySelector('.bench');
    return {
      visible: !!bench && getComputedStyle(bench).display !== 'none',
      tabs: bench?.querySelectorAll('.ptab').length ?? -1,
      restore: !!document.querySelector('.bench-restore'),
    };
  })()`);
  check('关掉最后一个 tab 后工作区自动收起', 'bench 不可见、tab 数=0、右上角出现展开按钮',
    JSON.stringify(autoCollapsed),
    autoCollapsed.visible === false && autoCollapsed.tabs === 0 && autoCollapsed.restore === true);
  await shot('04-bench-auto-collapsed.png');

  /* ---------- 11b. 手动展开空工作区 → 空态引导（不偷偷塞默认页） ---------- */
  await js(`(() => {
    const btn = document.querySelector('.bench-restore');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(500);
  const emptyState = await js(`(() => {
    const bench = document.querySelector('.bench');
    return {
      visible: !!bench && getComputedStyle(bench).display !== 'none',
      tabs: bench?.querySelectorAll('.ptab').length ?? -1,
      empty: !!bench?.querySelector('.bench-empty'),
      hint: (bench?.querySelector('.bench-empty-d')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    };
  })()`);
  check('手动展开后是空态引导（不自动塞默认 tab）', '可见、tab 数=0、出现引导文字',
    JSON.stringify(emptyState),
    emptyState.visible === true && emptyState.tabs === 0 && emptyState.empty === true && emptyState.hint.length > 0);
  await shot('05-bench-empty.png');

  /* ---------- 12. 控制台无报错 ---------- */
  check('控制台无 error 级输出', '空', consoleErrors.slice(0, 3).join(' | '), consoleErrors.length === 0);

  clearTimeout(bail);
  console.log(`\n[bench-visual] 截图目录：${OUT_DIR}`);
  console.log(failures.length === 0 ? '[bench-visual] 全部通过' : `[bench-visual] 失败 ${failures.length} 项：${failures.join(' / ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
