/**
 * 右栏工作台 + 会话悬浮气泡 —— 视觉与交互验证。
 *
 * 覆盖两条需求：
 *   1. 会话区的「上下文 / 执行 / 产物」改成会话右缘的三个悬浮按钮，点开出气泡；
 *   2. 原来的右栏改成 tabs 工作台：内置浏览器（Agent 可控）/ 文件（产物预览）/ 终端。
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
  /* 兜底：断言链任何一步抛错都不许把 Electron 挂死（曾经挂在 webview.getURL 上）。 */
  const bail = setTimeout(() => {
    console.log('[bench-visual] 兜底超时退出（测试链被中断）');
    app.exit(2);
  }, 120000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    /* 窗口可见：隐藏窗口里 <webview> 客体经常不初始化（getURL 空、不发 dom-ready），
     * Agent 导航断言就没法验。视觉测试本来就要截图，亮窗跑更接近真实。 */
    show: true,
    /* webviewTag 打开内置浏览器用的 <webview>（与桌面外壳同一套配置）。
     * 不挂 preload：前端靠 userAgent 判定桌面端，挂不挂 preload 都走 webview 路径。 */
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
    /* level 3 = error。Electron 自己的安全告警（CSP）不是本应用的错误，排除。 */
    if (level >= 3 && !/Electron Security Warning/.test(message)) consoleErrors.push(message);
  });

  console.log(`[bench-visual] 目标页面：${URL}`);

  /* 纯本地工具没有登录门禁：直接加载页面即可，live 装配会带本机会话数据水合。 */
  await win.loadURL(URL);
  await sleep(3200);
  /* 焦点钉在种子会话「GMV 归因」(c-gmv)：侧栏会把活跃会话切到最近一条真实会话，
   * Agent 导航推送与产物断言都以 c-gmv 为准 —— 不钉住的话两条链路根本对不上号。 */
  const convPinned = await win.webContents.executeJavaScript(`(() => {
    const hit = [...document.querySelectorAll('.sitem')].find((el) => (el.textContent ?? '').includes('GMV 归因'));
    if (hit) hit.click();
    return !!hit;
  })()`);
  check('选中种子会话 GMV 归因', '侧栏找到并点击', `ok=${convPinned}`, convPinned === true);
  await sleep(1200);

  /* ---------- 1. 三个悬浮按钮在会话右缘 ---------- */
  const dock = await win.webContents.executeJavaScript(`(() => {
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
      // 坞应该在会话区右缘（贴着右边界，且落在会话区内）
      nearRight: chatRect.right - dockRect.right,
      insideChat: dockRect.top >= chatRect.top && dockRect.bottom <= chatRect.bottom,
      dockRight: dockRect.right,
      chatRight: chatRect.right,
    };
  })()`);

  check('会话右缘有 3 个悬浮按钮', '3 个（上下文/执行/产物）',
    `count=${dock.count}, labels=${(dock.labels ?? []).join('/')}`,
    dock.ok === true && dock.count === 3);
  check('按钮贴着会话区右缘', '右缘间距 < 40px',
    `gap=${dock.nearRight}`, typeof dock.nearRight === 'number' && dock.nearRight < 40);
  check('悬浮按钮坞在会话区内部（不越界到别的栏）', '完全落在会话区内',
    `insideChat=${dock.insideChat}`, dock.insideChat === true);

  /* ---------- 2. 点按钮出气泡，内容对应 ---------- */
  const bubbles = {};
  for (const [index, key] of [[0, 'ctx'], [1, 'run'], [2, 'out']]) {
    await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelectorAll('.hud-btn')[${index}];
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(500);
    bubbles[key] = await win.webContents.executeJavaScript(`(() => {
      const pop = document.querySelector('.hud-pop');
      if (!pop) return { ok: false };
      return {
        ok: true,
        title: pop.querySelector('.hud-pop-t')?.textContent?.trim() ?? '',
        text: (pop.querySelector('.hud-pop-bd')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        sections: [...pop.querySelectorAll('.hud-pop-bd .pt')].map((n) => n.textContent.trim()),
      };
    })()`);
    if (key === 'ctx') await shot('01-hud-context.png');
  }

  check('点「上下文」出对应气泡', '标题=上下文，含已挂载/检索命中',
    JSON.stringify(bubbles.ctx).slice(0, 200),
    bubbles.ctx.ok === true && bubbles.ctx.title === '上下文' && bubbles.ctx.sections.some((s) => s.includes('已挂载')));
  check('点「执行」出对应气泡', '标题=执行，含本次执行',
    JSON.stringify(bubbles.run).slice(0, 200),
    bubbles.run.ok === true && bubbles.run.title === '执行' && bubbles.run.sections.some((s) => s.includes('本次执行')));
  check('点「产物」出对应气泡', '标题=产物，含本次产物',
    JSON.stringify(bubbles.out).slice(0, 200),
    bubbles.out.ok === true && bubbles.out.title === '产物' && bubbles.out.sections.some((s) => s.includes('本次产物')));

  /* ---------- 3. 点外部收起 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.thread');
    if (el) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return !!el;
  })()`);
  await sleep(400);
  const closed = await win.webContents.executeJavaScript(`(() => !document.querySelector('.hud-pop'))()`);
  check('点会话区收起气泡', '气泡消失', `stillOpen=${!closed}`, closed === true);

  /* ---------- 4. 右栏变成工作台 tabs ---------- */
  const bench = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.bench');
    if (!el) return { ok: false };
    return {
      ok: true,
      tabs: [...el.querySelectorAll('.ptab')].map((t) => t.textContent.trim()),
      panes: [...el.querySelectorAll('.pb')].map((p) => p.dataset.p),
      hasLegacy: !!document.querySelector('.pb[data-p="ctx"]'),
    };
  })()`);

  check('右栏是工作台，三个 Tab', '浏览器 / 文件 / 终端',
    JSON.stringify(bench.tabs), bench.ok === true && bench.tabs.join('/') === '浏览器/文件/终端');
  check('旧的「上下文/执行/产物」Tab 已从右栏移除', '右栏不再有 ctx/run/out 面板',
    `panes=${(bench.panes ?? []).join('/')}`, bench.hasLegacy === false && !(bench.panes ?? []).includes('ctx'));

  /* ---------- 5. 浏览器 Tab ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('.bench .ptab')].find((t) => t.textContent.trim() === '浏览器');
    if (tab) tab.click();
    return !!tab;
  })()`);
  await sleep(600);
  const browser = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.pb.on[data-p="browser"]');
    if (!pane) return { ok: false };
    return {
      ok: true,
      hasUrl: !!pane.querySelector('.brp-url'),
      hasView: !!pane.querySelector('.brp-view'),
      hasFrame: !!pane.querySelector('.brp-frame') || !!pane.querySelector('.brp-host webview'),
      foot: (pane.querySelector('.brp-foot')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  check('浏览器 Tab 有地址栏与视图区', '地址栏 + 视图区都在',
    JSON.stringify(browser).slice(0, 220), browser.ok === true && browser.hasUrl === true && browser.hasView === true);

  /* Agent 驱动：真调 browser_navigate 工具，服务端写状态 → 面板轮询后跳转。
   * 目标取本机 API（Agent 默认禁私有网段，测试脚本显式放开）；
   * 不用外网页面，避免自动化环境的外连限制影响断言。 */
  try {
    execFileSync('node', [
      path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(ROOT, 'tests', 'browser-push.ts'),
      'c-gmv',
      `${URL}/api/health`,
    ], {
      cwd: ROOT,
      stdio: 'pipe',
      windowsHide: true,
      timeout: 60000,
    });
  } catch (error) {
    console.log(`       [提示] browser-push 执行失败：${error.message}`);
  }
  await sleep(4500);
  /* 轮询等导航生效：webview 挂载 + 面板轮询都有延迟，固定 sleep 会偶发空窗。 */
  let afterAgent = { url: '', tag: '' };
  for (let i = 0; i < 20; i += 1) {
    afterAgent = await win.webContents.executeJavaScript(`(() => {
      const pane = document.querySelector('.pb.on[data-p="browser"]');
      const wv = pane?.querySelector('.brp-host webview');
      const frame = pane?.querySelector('.brp-frame');
      /* webview 未 dom-ready 时 getURL() 会抛错 —— 兜住，退回 src 属性，不让整个测试链挂死。 */
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

  /* Agent 能读到页面正文：前端把正文回传服务端，browser_read_page 读得到。 */
  const pageText = await win.webContents.executeJavaScript(`(async () => {
    const res = await fetch('/api/conversations/c-gmv/browser/page');
    const json = await res.json();
    return json?.data?.text ?? '';
  })()`);
  check('页面正文已回传服务端（Agent 可读）', '快照里有页面内容',
    pageText.slice(0, 80), pageText.length > 10);

  await shot('02-bench-browser.png');

  /* ---------- 6. 文件 Tab：点产物在侧边栏打开并预览 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('.bench .ptab')].find((t) => t.textContent.trim() === '文件');
    if (tab) tab.click();
    return !!tab;
  })()`);
  await sleep(600);
  const filePane = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.pb.on[data-p="file"]');
    if (!pane) return { ok: false };
    const rows = [...pane.querySelectorAll('.frow')];
    return { ok: true, rows: rows.length, names: rows.map((r) => r.querySelector('.fn')?.textContent?.trim() ?? '') };
  })()`);
  check('文件 Tab 列出本会话产物', '至少 1 个产物行',
    JSON.stringify(filePane).slice(0, 200), filePane.ok === true && filePane.rows >= 1);

  await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.pb.on[data-p="file"] .frow');
    if (row) row.click();
    return !!row;
  })()`);
  await sleep(1500);
  const preview = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.pb.on[data-p="file"]');
    return {
      name: pane?.querySelector('.filp-name')?.textContent?.trim() ?? '',
      hasImage: !!pane?.querySelector('.filp-img img'),
      hasText: !!pane?.querySelector('.filp-text'),
      tabCount: pane?.querySelectorAll('.filp-tab').length ?? 0,
      note: (pane?.querySelector('.filp-note')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 90),
    };
  })()`);
  check('点产物在侧边栏打开并预览', '预览区真实渲染（图片/文本/二进制说明，而非 401 报错）',
    JSON.stringify(preview).slice(0, 220),
    preview.name.length > 0
      && (preview.hasImage === true || preview.hasText === true || preview.note.includes('二进制'))
      && !preview.note.includes('未登录'));
  check('打开产物同时生成标签页', '出现 1 个产物标签',
    `tabs=${preview.tabCount ?? 0}`, (preview.tabCount ?? 0) === 1);

  /* ---------- 6b. 多标签：再开一个产物 → 两标签并存 / 切换 / 关闭 ---------- */
  /* 点 png 那一行：预览必须真的渲染出 <img>（顺带验图片渲染器不是摆设）。 */
  await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('.pb.on[data-p="file"] .frow')];
    const png = rows.find((r) => (r.querySelector('.fn')?.textContent ?? '').includes('.png')) ?? rows[1];
    if (png) png.click();
    return !!png;
  })()`);
  await sleep(1500);
  const tabsOpen = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.pb.on[data-p="file"]');
    const tabs = [...(pane?.querySelectorAll('.filp-tab') ?? [])];
    return {
      count: tabs.length,
      activeIndex: tabs.findIndex((t) => t.classList.contains('on')),
      activeName: pane?.querySelector('.filp-tab.on .filp-tab-name')?.textContent?.trim() ?? '',
      previewName: pane?.querySelector('.filp-name')?.textContent?.trim() ?? '',
      hasImage: !!pane?.querySelector('.filp-img img'),
    };
  })()`);
  check('两个产物开成两个标签', '标签数=2，激活=第 2 个，预览跟着激活走',
    JSON.stringify(tabsOpen),
    tabsOpen.count === 2 && tabsOpen.activeIndex === 1 && tabsOpen.activeName === tabsOpen.previewName);
  check('png 产物真的渲染出图片', '<img> 在预览区',
    `hasImage=${tabsOpen.hasImage}`, tabsOpen.hasImage === true);

  await win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('.pb.on[data-p="file"] .filp-tab')];
    if (tabs[0]) tabs[0].click();
    return !!tabs[0];
  })()`);
  await sleep(800);
  const switched = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.pb.on[data-p="file"]');
    return {
      activeName: pane?.querySelector('.filp-tab.on .filp-tab-name')?.textContent?.trim() ?? '',
      previewName: pane?.querySelector('.filp-name')?.textContent?.trim() ?? '',
    };
  })()`);
  check('点标签切换预览', '激活标签与预览标题一致',
    JSON.stringify(switched), switched.activeName.length > 0 && switched.activeName === switched.previewName);

  await win.webContents.executeJavaScript(`(() => {
    const x = document.querySelector('.pb.on[data-p="file"] .filp-tab.on .filp-tab-x');
    if (x) x.click();
    return !!x;
  })()`);
  await sleep(500);
  const afterClose = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.pb.on[data-p="file"]');
    return {
      count: pane?.querySelectorAll('.filp-tab').length ?? 0,
      activeName: pane?.querySelector('.filp-tab.on .filp-tab-name')?.textContent?.trim() ?? '',
    };
  })()`);
  check('关闭激活标签后剩 1 个', '标签数=1，激活自动落到邻居',
    JSON.stringify(afterClose), afterClose.count === 1 && afterClose.activeName.length > 0);

  /* ---------- 6c. 右栏宽度可拖到 420px 以上（旧上限太窄） ---------- */
  const wide = await win.webContents.executeJavaScript(`(async () => {
    const resizer = document.querySelector('.bench .resizer');
    const bench = document.querySelector('.bench');
    if (!resizer || !bench) return { ok: false, width: 0 };
    const rect = resizer.getBoundingClientRect();
    const x = rect.left + 2, y = rect.top + 20;
    resizer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: x, clientY: y }));
    /* 指针事件要逐拍发：window 监听挂在 React effect 里，同步连发会全部漏掉。 */
    await new Promise((r) => setTimeout(r, 150));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x - 150, clientY: y }));
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: x - 300, clientY: y }));
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: x - 300, clientY: y }));
    await new Promise((r) => setTimeout(r, 150));
    const width = bench.getBoundingClientRect().width;
    /* 双击复位，别把加宽后的宽度留进 localStorage 影响下次截图。 */
    resizer.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return { ok: true, width };
  })()`);
  check('右栏可拖宽到 420px 以上', '拖拽后宽度 > 420',
    JSON.stringify(wide), wide.ok === true && wide.width > 420);

  await shot('03-bench-file.png');

  /* ---------- 7. 终端 Tab ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('.bench .ptab')].find((t) => t.textContent.trim() === '终端');
    if (tab) tab.click();
    return !!tab;
  })()`);
  await sleep(800);
  const term = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.pb.on[data-p="term"]');
    if (!pane) return { ok: false };
    return {
      ok: true,
      hasInput: !!pane.querySelector('.trmp-input'),
      hasOut: !!pane.querySelector('.trmp-out'),
      sid: pane.querySelector('.trmp-sid')?.textContent?.trim() ?? '',
    };
  })()`);
  check('终端 Tab 有输出区与输入框', '输出区 + 输入框都在',
    JSON.stringify(term), term.ok === true && term.hasInput === true && term.hasOut === true);

  await shot('04-bench-term.png');

  /* ---------- 8. 控制台无报错 ---------- */
  check('控制台无 error 级输出', '空', consoleErrors.slice(0, 3).join(' | '), consoleErrors.length === 0);

  clearTimeout(bail);
  console.log(`\n[bench-visual] 截图目录：${OUT_DIR}`);
  console.log(failures.length === 0 ? '[bench-visual] 全部通过' : `[bench-visual] 失败 ${failures.length} 项：${failures.join(' / ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
