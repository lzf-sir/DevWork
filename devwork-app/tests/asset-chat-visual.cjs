/**
 * 资产会话坞（Asset Chat Dock）视觉与交互验证 —— QA
 *
 * 前置：一个隔离实例在 DEVWORK_PORT（默认 3012）上跑着，且前端已构建（dist 存在）。
 * 运行：`env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tests/asset-chat-visual.cjs`
 *
 * 覆盖需求 1「代码库 / 数据 / 终端的操作页面需要有 AI 会话的快捷入口」：
 *   1. 三个详情页都有「AI 会话」入口；
 *   2. 点击后**当前页面**出现会话区域（不跳走）；
 *   3. 每次点击都新增一条会话，且在左侧会话列表里看得见；
 *   4. 会话默认绑定当前资产（气泡 chip / 输入框 chip 都带着它）；
 *   5. 快捷操作点一下就真的发一轮提问。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.DEVWORK_PORT ?? '3012';
const URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'asset-chat-visual');

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
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  /* 隐藏窗口不会主动重绘：截图前先 invalidate 强制刷一帧，
   * 否则截到的是上一帧画面（折叠态就拍不到折叠）。 */
  const shot = async (name) => {
    await sleep(400);
    await win.webContents.invalidate();
    await sleep(400);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, name), img.toPNG());
  };

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  console.log(`[asset-chat-visual] 目标页面：${URL}`);
  await win.loadURL(URL);
  await sleep(3000);

  /* ---------- 1. 三个详情页都有「AI 会话」入口 ---------- */
  for (const [go, label] of [['code', '代码库'], ['db', '数据'], ['server', '终端']]) {
    await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('.aitem[data-go="${go}"]');
      if (el) el.click();
      return !!el;
    })()`);
    await sleep(1600);
    const entry = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.view.on .dacts button')]
        .find((b) => b.textContent.includes('AI 会话'));
      return { found: !!btn, text: btn?.textContent?.trim() ?? '', view: document.querySelector('.view.on')?.dataset?.view ?? '' };
    })()`);
    check(`${label}详情页有 AI 会话快捷入口`, '按钮文案含「AI 会话」',
      `view=${entry.view}, text=${entry.text}`, entry.found === true);
  }

  /* ---------- 2. 代码库页点击入口 → 当前页面出现会话区域 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.aitem[data-go="code"]');
    if (el) el.click();
    return !!el;
  })()`);
  await sleep(1800);
  const before = await win.webContents.executeJavaScript(`(() => ({
    view: document.querySelector('.view.on')?.dataset?.view ?? '',
    convs: document.querySelectorAll('.sitem').length,
  }))()`);

  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')]
      .find((b) => b.textContent.includes('AI 会话'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(2200);

  const dock = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.adock');
    if (!el) return { ok: false };
    const title = el.querySelector('.adock-title')?.textContent?.trim() ?? '';
    const sub = el.querySelector('.adock-sub')?.textContent?.trim() ?? '';
    const quick = [...el.querySelectorAll('.qbtn')].map((b) => b.textContent.trim());
    return {
      ok: true,
      title,
      sub,
      quick,
      hasComposer: !!el.querySelector('.composer .cinput'),
      hasThread: !!el.querySelector('.thread'),
      notice: el.querySelector('.notice .nt')?.textContent?.trim() ?? '',
      view: document.querySelector('.view.on')?.dataset?.view ?? '',
      convs: document.querySelectorAll('.sitem').length,
      boundBadges: document.querySelectorAll('.sitem .abind').length,
    };
  })()`);

  check('点击后当前页面出现会话区域（不跳走）', '仍在代码库详情页，且会话坞存在',
    `view=${dock.view}, dock=${dock.ok}`, dock.ok === true && dock.view === 'detail-code');
  check('会话坞含标题 / 绑定资产 / 输入框', '标题、绑定说明、输入框都在',
    `title=${dock.title}, sub=${dock.sub}, composer=${dock.hasComposer}, thread=${dock.hasThread}`,
    dock.title.length > 0 && /已绑定/.test(dock.sub) && dock.hasComposer === true && dock.hasThread === true);
  check('会话默认绑定当前资产', '会话坞提示写明绑定资产',
    `notice=${dock.notice}, sub=${dock.sub}`, /已绑定资产/.test(dock.notice) && /已绑定/.test(dock.sub));
  check('提供资产快捷操作', '至少 4 个快捷操作按钮',
    `quick=${(dock.quick ?? []).join('/')}`, (dock.quick ?? []).length >= 4);

  await shot('01-dock-open.png');

  /* ---------- 2b. 形态要求：折叠 / 展开的一列，不是弹出式抽屉 ---------- */
  const layout = await win.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector('.adock');
    const page = document.querySelector('.main-page');
    const dr = dock?.getBoundingClientRect();
    const pr = page?.getBoundingClientRect();
    return {
      position: dock ? getComputedStyle(dock).position : '',
      dockW: dr ? Math.round(dr.width) : 0,
      pageW: pr ? Math.round(pr.width) : 0,
      overlap: dr && pr ? Math.round(dr.left - pr.right) : 0,
    };
  })()`);
  check('会话区是页面内的一列（不是浮在页面上的抽屉）', '不用 absolute/fixed 定位，且不与页面内容重叠',
    `position=${layout.position}, dockW=${layout.dockW}, pageW=${layout.pageW}, overlap=${layout.overlap}`,
    !['absolute', 'fixed'].includes(layout.position) && layout.overlap <= 1 && layout.pageW > 0);

  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('.adock-hd button[aria-label="折叠会话区"]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(700);
  const folded = await win.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector('.adock');
    const page = document.querySelector('.main-page');
    const dr = dock?.getBoundingClientRect();
    const pr = page?.getBoundingClientRect();
    return {
      collapsed: dock?.classList.contains('collapsed') ?? false,
      dockW: dr ? Math.round(dr.width) : 0,
      pageW: pr ? Math.round(pr.width) : 0,
      hasExpand: !!document.querySelector('.adock-fold button[aria-label="展开会话区"]'),
      label: document.querySelector('.adock-foldlbl')?.textContent?.trim() ?? '',
    };
  })()`);
  check('折叠后收成窄边条，宽度还给页面', `dockW<=44（实际 ${folded.dockW}），pageW 变大`,
    `collapsed=${folded.collapsed}, dockW=${folded.dockW}, pageW=${folded.pageW}, label=${folded.label}`,
    folded.collapsed === true && folded.dockW <= 44 && folded.pageW > layout.pageW);
  check('折叠态保留会话标识并给出展开入口', '有展开按钮 + 竖排会话标题',
    `hasExpand=${folded.hasExpand}, label=${folded.label}`, folded.hasExpand === true && folded.label.length > 0);

  await shot('01b-dock-collapsed.png');

  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('.adock-fold button[aria-label="展开会话区"]');
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(700);
  const unfolded = await win.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector('.adock');
    const dr = dock?.getBoundingClientRect();
    return {
      collapsed: dock?.classList.contains('collapsed') ?? false,
      dockW: dr ? Math.round(dr.width) : 0,
      notices: document.querySelectorAll('.adock .notice').length,
      title: document.querySelector('.adock-title')?.textContent?.trim() ?? '',
    };
  })()`);
  check('展开后恢复成完整会话列且会话内容还在', '宽度恢复、内容保留',
    `collapsed=${unfolded.collapsed}, dockW=${unfolded.dockW}, notices=${unfolded.notices}`,
    unfolded.collapsed === false && unfolded.dockW > 200 && unfolded.notices >= 1);

  /* ---------- 3. 会话出现在左侧会话列表里（且有绑定徽标） ---------- */
  check('新会话出现在左侧会话列表', `会话数 ${before.convs} → ${dock.convs}`,
    `before=${before.convs}, after=${dock.convs}`, dock.convs > before.convs);
  check('会话列表里该条带资产绑定徽标', '至少 1 个 .abind 徽标',
    `badges=${dock.boundBadges}`, dock.boundBadges >= 1);

  /* ---------- 4. 快捷操作点一下就真的发一轮 ---------- */
  const sent = await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('.adock .qbtn');
    if (!btn) return { ok: false };
    const label = btn.textContent.trim();
    btn.click();
    return { ok: true, label };
  })()`);
  await sleep(2600);
  const afterQuick = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.adock');
    return {
      bubbles: el?.querySelectorAll('.bub').length ?? 0,
      lastBubble: el?.querySelectorAll('.bub')[0]?.textContent?.trim() ?? '',
      chips: [...(el?.querySelectorAll('.bub .atchip') ?? [])].map((c) => c.textContent.trim()),
      composerChips: [...(el?.querySelectorAll('.cchiprow .atchip') ?? [])].map((c) => c.textContent.trim()),
    };
  })()`);
  check('快捷操作点一下就发出提问', '会话里出现用户气泡',
    `label=${sent.label}, bubbles=${afterQuick.bubbles}`,
    sent.ok === true && afterQuick.bubbles >= 1);
  check('提问自动带上绑定资产', '气泡 chip 含绑定资产名',
    `chips=${(afterQuick.chips ?? []).join('/')}, composerChips=${(afterQuick.composerChips ?? []).join('/')}`,
    (afterQuick.chips ?? []).length >= 1);
  check('发送后输入框仍显示绑定资产 chip', 'composer chip 仍在（绑定是会话属性）',
    `composerChips=${(afterQuick.composerChips ?? []).join('/')}`,
    (afterQuick.composerChips ?? []).length >= 1);

  await shot('02-quick-action.png');

  /* ---------- 5. 再点一次入口 → 又一条新会话 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')]
      .find((b) => b.textContent.includes('AI 会话'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(2000);
  const second = await win.webContents.executeJavaScript(`(() => ({
    convs: document.querySelectorAll('.sitem').length,
    title: document.querySelector('.adock-title')?.textContent?.trim() ?? '',
    bubbles: document.querySelectorAll('.adock .bub').length,
  }))()`);
  check('每次点击都新增一条会话', `会话数 ${dock.convs} → ${second.convs}`,
    `after=${second.convs}`, second.convs > dock.convs);
  check('新会话是干净的（不带上一条会话的消息）', '新会话消息数为 0',
    `bubbles=${second.bubbles}, title=${second.title}`, second.bubbles === 0);

  await shot('03-second-session.png');

  /* ---------- 6. 终端页也能唤起会话坞 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.aitem[data-go="server"]');
    if (el) el.click();
    return !!el;
  })()`);
  await sleep(1600);
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.view.on button')]
      .find((b) => b.textContent.includes('AI 会话'));
    if (btn) btn.click();
    return !!btn;
  })()`);
  await sleep(2000);
  const serverDock = await win.webContents.executeJavaScript(`(() => ({
    ok: !!document.querySelector('.adock'),
    sub: document.querySelector('.adock-sub')?.textContent?.trim() ?? '',
    quick: [...document.querySelectorAll('.adock .qbtn')].map((b) => b.textContent.trim()),
  }))()`);
  check('终端页唤起的会话坞绑定的是服务器资产', '会话坞存在且绑定服务器',
    `ok=${serverDock.ok}, sub=${serverDock.sub}`, serverDock.ok === true && /服务器/.test(serverDock.sub));
  check('终端资产有专属快捷操作', '快捷操作含服务状态 / 日志等',
    `quick=${(serverDock.quick ?? []).join('/')}`, (serverDock.quick ?? []).some((q) => /服务状态|日志/.test(q)));

  await shot('04-terminal-dock.png');

  /* Electron 开发模式的 CSP 提示不是页面报错（打包态不会出现），过滤掉。 */
  const realErrors = consoleErrors.filter((m) => !/favicon|Autofill|DevTools|Electron Security Warning/i.test(m));
  check('页面无 JS 报错', 'console 无 error 级输出',
    realErrors.slice(0, 3).join(' | ') || '（无）', realErrors.length === 0);

  console.log('\n========== 汇总 ==========');
  if (failures.length > 0) {
    console.log(`失败 ${failures.length} 项：`);
    failures.forEach((f) => console.log(`- ${f}`));
    process.exitCode = 1;
  } else {
    console.log('全部通过');
  }
  app.quit();
});
