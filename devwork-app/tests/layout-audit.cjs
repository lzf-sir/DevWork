/**
 * DevWork 布局溢出探测 —— QA
 *
 * 前置：vite dev server 已在 127.0.0.1:5173。
 * 运行：`env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tests/layout-audit.cjs`
 *
 * 用隐藏 BrowserWindow 加载页面，逐视图 / 逐 Tab 切换，
 * 报告所有 getBoundingClientRect 超出视口的可见元素，以及需要横向滚动的容器。
 */
const { app, BrowserWindow } = require('electron');

const URL = process.env.DEVWORK_VITE_PORT ? `http://127.0.0.1:${process.env.DEVWORK_VITE_PORT}` : "http://127.0.0.1:5173";
const SIZES = [
  [1180, 720], // Electron minWidth/minHeight
  [1440, 900],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面内执行的导航：source 形如 "(arg) => {...}"，eval 后调用。 */
const NAV = {
  chat: `() => {
    const b = document.querySelector('.back');
    if (b) { b.click(); return 'back'; }
    const s = document.querySelector('.sitem');
    if (s) { s.click(); return 'sitem'; }
    return 'already';
  }`,
  'detail-code': `() => { const e = document.querySelector('.aitem[data-go="code"]'); if (e) { e.click(); return 1; } return 0; }`,
  'detail-db': `() => { const e = document.querySelector('.aitem[data-go="db"]'); if (e) { e.click(); return 1; } return 0; }`,
  'detail-server': `() => { const e = document.querySelector('.aitem[data-go="server"]'); if (e) { e.click(); return 1; } return 0; }`,
  'detail-kb': `() => { const e = document.querySelector('.aitem[data-go="kb"]'); if (e) { e.click(); return 1; } return 0; }`,
  'drawer': `() => {
    const a = document.querySelector('.aitem[data-go="server"]');
    if (a) a.click();
    return new Promise((resolve) => setTimeout(() => {
      const b = document.querySelector('.view.on .dcfg');
      if (b) { b.click(); resolve('drawer'); } else resolve('no-btn');
    }, 300));
  }`,
  projects: `() => { const e = document.querySelector('.wsdrop'); if (e) { e.click(); return 1; } return 0; }`,
  settings: `() => { const e = document.querySelector('.sfoot'); if (e) { e.click(); return 1; } return 0; }`,
  user: `() => { const e = document.querySelector('.ufoot'); if (e) { e.click(); return 1; } return 0; }`,
  org: `() => {
    const u = document.querySelector('.ufoot');
    if (u) u.click();
    return new Promise((resolve) => setTimeout(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('管理成员'));
      if (btn) { btn.click(); resolve('clicked'); } else resolve('no-btn');
    }, 200));
  }`,
};

const AUDIT = `() => {
  const vw = innerWidth, vh = innerHeight;
  // 元素是否已被某个滚动/裁剪祖先容纳（可滚动内容 rect 超界是正常的，不算溢出）
  const clippedByScroller = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return true;
      p = p.parentElement;
    }
    return false;
  };
  const bad = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const fixed = cs.position === 'fixed' || cs.position === 'absolute';
    if (!fixed && !el.offsetParent) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if ((r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) && !clippedByScroller(el)) {
      bad.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className : '',
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 36),
      });
    }
  }
  // 需要横向滚动的容器（内容比窗口宽的另一种表现）
  const hscroll = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    if (el.scrollWidth > el.clientWidth + 2 && cs.overflowX !== 'visible' && el.clientWidth > 0) {
      hscroll.push({
        tag: el.tagName.toLowerCase(),
        cls: typeof el.className === 'string' ? el.className : '',
        over: el.scrollWidth - el.clientWidth,
      });
    }
  }
  return {
    vw, vh,
    pageW: document.documentElement.scrollWidth,
    pageH: document.documentElement.scrollHeight,
    bad: bad.slice(0, 15), badCount: bad.length, hscroll: hscroll.slice(0, 8),
  };
}`;

/** 视图内再遍历的子 Tab（点击后不离开当前视图）。 */
const TAB_SEL = '.dtab, .si, .ptab, .setnav .si';

async function auditView(win, name) {
  const navFn = NAV[name];
  if (!navFn) return;
  await win.webContents.executeJavaScript(`(${navFn})()`).catch(() => {});
  await sleep(450);
  const res = await win.webContents.executeJavaScript(`(${AUDIT})()`);
  report(name + '（默认页签）', res);
  if (res.badCount > 60) return; // 已经严重溢出，子页签结果意义不大，但仍跑一遍

  // 逐个子 Tab
  const tabs = await win.webContents.executeJavaScript(
    `(() => { const els = [...document.querySelectorAll('${TAB_SEL}')];
       return els.map((el, i) => ({ i, text: el.textContent.trim().slice(0, 12) })); })()`,
  );
  for (const t of tabs) {
    await win.webContents.executeJavaScript(
      `(() => { const els = document.querySelectorAll('${TAB_SEL}'); els[${t.i}] && els[${t.i}].click(); })()`,
    );
    await sleep(280);
    const r2 = await win.webContents.executeJavaScript(`(${AUDIT})()`);
    report(`${name} · Tab[${t.text}]`, r2);
  }
}

function report(label, res) {
  const pageBad = res.pageW > res.vw + 1 || res.pageH > res.vh + 1;
  const flag = res.badCount > 0 || pageBad ? 'OVERFLOW' : 'ok';
  console.log(`\n== [${flag}] ${label}  视口 ${res.vw}x${res.vh}  页面 ${res.pageW}x${res.pageH}  越界元素 ${res.badCount}`);
  for (const b of res.bad) {
    console.log(`   <${b.tag} class="${b.cls}"> rect=[${b.rect.join(',')}] "${b.text}"`);
  }
  if (res.hscroll.length) {
    console.log(`   -- 横向滚动容器: ${res.hscroll.map((h) => `${h.tag}.${h.cls}(+${h.over}px)`).join(', ')}`);
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: SIZES[0][0], height: SIZES[0][1] });
  await win.loadURL(URL);
  await sleep(1800); // 等 bootstrap / mock 装配完成

  for (const [w, h] of SIZES) {
    console.log(`\n######## 窗口 ${w}x${h} ########`);
    win.setSize(w, h);
    await sleep(250);
    for (const name of Object.keys(NAV)) {
      await auditView(win, name);
      // 每个视图结束后回到会话，避免状态残留
      // （先按 Esc 关掉可能打开的配置抽屉，否则遮罩会挡住后面的点击）
      await win.webContents.executeJavaScript(
        `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));`,
      ).catch(() => {});
      await sleep(150);
      await win.webContents.executeJavaScript(`(${NAV.chat})()`).catch(() => {});
      await sleep(250);
    }
  }
  console.log('\nDONE');
  app.exit(0);
}).catch((err) => {
  console.error('PROBE FAILED:', err);
  app.exit(1);
});
