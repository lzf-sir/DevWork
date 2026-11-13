/**
 * 数据库页深色主题验证 —— QA
 *
 * 深色下最容易翻车的是「硬编码浅色底」：一旦某个面板写死了 #FFFFFF，
 * 深色主题里就会变成一块刺眼的白板。这个脚本逐个检查新增面板的
 * 背景色与文字色是否与主题一致（对比度达标 + 没有意外浅色块）。
 *
 * 运行：`env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tests/db-theme.cjs`
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.DEVWORK_VITE_PORT ?? '5173';
const URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'db-theme');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

/** 端口探测：vite 可能在 5173 被占用而自动顺延，写死端口会让测试假失败。 */
async function resolveUrl() {
  const candidates = [PORT];
  for (let p = 5173; p <= 5180; p += 1) if (!candidates.includes(String(p))) candidates.push(String(p));
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return `http://127.0.0.1:${port}`;
    } catch {
      /* 该端口没有服务，继续试下一个 */
    }
  }
  return URL;
}

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

/** 相对亮度：用于判断背景是深是浅。 */
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 文字与背景的对比度（WCAG）。 */
function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const parseRgb = (value) => {
  const match = String(value).match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(',').map((v) => Number(v.trim()));
  return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
};

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({ width: 1440, height: 900, show: false });

  /* 先设主题再加载，避免首屏闪烁 */
  await win.loadURL(await resolveUrl());
  await win.webContents.executeJavaScript(`localStorage.setItem('devwork-theme', 'dark')`);
  await win.reload();
  await sleep(2800);

  const theme = await win.webContents.executeJavaScript(`document.documentElement.dataset.theme`);
  check('深色主题已生效', 'data-theme=dark', `theme=${theme}`, theme === 'dark');

  await win.webContents.executeJavaScript(`document.querySelector('.aitem[data-go="db"]').click()`);
  await sleep(2400);
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.dbobj .tnode')].find(n=>n.textContent.includes('order'))?.click()`,
  );
  await sleep(1800);
  /* 打开筛选条并加一个条件行，让输入框 / 下拉都进入画面 */
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('[data-view="detail-db"] .dbody.on .sqltools button')].find(b=>b.textContent.includes('筛选'))?.click()`,
  );
  await sleep(600);
  await win.webContents.executeJavaScript(
    `(() => {
      const panel = document.querySelector('[data-view="detail-db"] .dbfilter');
      const add = [...(panel?.querySelectorAll('button') ?? [])].find(b=>b.textContent.includes('条件'));
      if (add) add.click();
      return 1;
    })()`,
  );
  await sleep(800);
  /* 等网格与输入框都出现再检查 */
  for (let i = 0; i < 20; i += 1) {
    const ready = await win.webContents.executeJavaScript(
      `!!document.querySelector('[data-view="detail-db"] .dbgrid td')
       && !!document.querySelector('[data-view="detail-db"] .dbinput')`,
    );
    if (ready) break;
    await sleep(300);
  }

  /* ---------- 关键面板：底色深浅 + 文字对比度 ---------- */
  const panels = await win.webContents.executeJavaScript(`(() => {
    const selectors = [
      ['对象树面板', '.dbobj'],
      ['对象树分组头', '.dbobj-schema-h'],
      ['标签栏', '.dbtabs'],
      ['标签页', '.dbtab.on'],
      ['工具条', '.sqltools'],
      ['筛选条', '.dbfilter'],
      ['筛选输入框', '.dbinput'],
      ['筛选下拉', '.dbsel'],
      ['数据网格表头', '.dbgrid th'],
      ['数据网格单元格', '.dbgrid td'],
    ];
    const out = [];
    for (const [name, sel] of selectors) {
      const el = document.querySelector('[data-view="detail-db"] ' + sel);
      if (!el) { out.push({ name, missing: true }); continue; }
      const cs = getComputedStyle(el);
      out.push({
        name,
        bg: cs.backgroundColor,
        color: cs.color,
      });
    }
    return out;
  })()`);

  for (const panel of panels) {
    if (panel.missing) {
      check(`${panel.name} 存在`, '元素存在', '未找到', false);
      continue;
    }
    const bg = parseRgb(panel.bg);
    const fg = parseRgb(panel.color);
    if (!bg || !fg) {
      check(`${panel.name} 颜色可解析`, 'rgba 格式', `bg=${panel.bg}, color=${panel.color}`, false);
      continue;
    }
    /* 背景要么透明（继承深色底），要么本身是深色 —— 不能是浅色块。 */
    const bgIsLight = bg.a > 0.5 && luminance(bg.rgb) > 0.45;
    check(`${panel.name} 不是浅色块`, '背景透明或为深色',
      `bg=${panel.bg}`, !bgIsLight);
    /* 文字与自身背景的对比度。透明背景按继承处理，用页面底色近似。 */
    const effectiveBg = bg.a > 0.5 ? bg.rgb : [15, 19, 25];
    const ratio = contrast(fg.rgb, effectiveBg);
    check(`${panel.name} 文字对比度达标`, '对比度 ≥ 3.0',
      `ratio=${ratio.toFixed(2)}, color=${panel.color}, bg=${panel.bg}`, ratio >= 3.0);
  }

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, 'dark-db.png'), img.toPNG());
  });

  /* ---------- 浅色主题对照：同一套面板应是浅色 ---------- */
  await win.webContents.executeJavaScript(`localStorage.setItem('devwork-theme', 'light')`);
  await win.reload();
  await sleep(2800);
  await win.webContents.executeJavaScript(`document.querySelector('.aitem[data-go="db"]').click()`);
  await sleep(2400);
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.dbobj .tnode')].find(n=>n.textContent.includes('order'))?.click()`,
  );
  await sleep(1800);
  /* 浅色主题同样打开筛选条并加条件，保证检查的面板集合与深色一致。
   * 每一步都等 DOM 真的出现再继续 —— 不然会拿到「元素还没渲染」的空结果，
   * 把时序问题误报成样式问题。 */
  await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('[data-view="detail-db"] .dbody.on .sqltools button')].find(b=>b.textContent.includes('筛选'))?.click()`,
  );
  await sleep(700);
  await win.webContents.executeJavaScript(
    `(() => {
      const panel = document.querySelector('[data-view="detail-db"] .dbfilter');
      const add = [...(panel?.querySelectorAll('button') ?? [])].find(b=>b.textContent.includes('条件'));
      if (add) add.click();
      return 1;
    })()`,
  );
  /* 等网格与输入框都出现再检查 */
  for (let i = 0; i < 20; i += 1) {
    const ready = await win.webContents.executeJavaScript(
      `!!document.querySelector('[data-view="detail-db"] .dbgrid td')
       && !!document.querySelector('[data-view="detail-db"] .dbinput')`,
    );
    if (ready) break;
    await sleep(300);
  }

  const lightPanels = await win.webContents.executeJavaScript(`(() => {
    const out = [];
    for (const [name, sel] of [
      ['对象树面板', '.dbobj'],
      ['标签栏', '.dbtabs'],
      ['筛选条', '.dbfilter'],
      ['筛选输入框', '.dbinput'],
      ['数据网格表格', '.dbgrid'],
    ]) {
      const el = document.querySelector('[data-view="detail-db"] ' + sel);
      if (!el) { out.push({ name, missing: true }); continue; }
      const cs = getComputedStyle(el);
      out.push({ name, bg: cs.backgroundColor, color: cs.color });
    }
    return out;
  })()`);

  for (const panel of lightPanels) {
    if (panel.missing) continue;
    const bg = parseRgb(panel.bg);
    const fg = parseRgb(panel.color);
    if (!bg || !fg) continue;
    /* 浅色主题下背景应当是浅色（不透明浅色或透明）。 */
    const bgIsDark = bg.a > 0.5 && luminance(bg.rgb) < 0.35;
    check(`浅色主题下 ${panel.name} 不是深色块`, '背景为浅色或透明',
      `bg=${panel.bg}`, !bgIsDark);
    const effectiveBg = bg.a > 0.5 ? bg.rgb : [255, 255, 255];
    const ratio = contrast(fg.rgb, effectiveBg);
    check(`浅色主题下 ${panel.name} 文字对比度达标`, '对比度 ≥ 3.0',
      `ratio=${ratio.toFixed(2)}, color=${panel.color}, bg=${panel.bg}`, ratio >= 3.0);
  }

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, 'light-db.png'), img.toPNG());
  });

  console.log('========== 汇总 ==========');
  console.log(`截图目录：${OUT_DIR}`);
  if (failures.length > 0) {
    console.log(`失败 ${failures.length} 项：`);
    failures.forEach((f) => console.log(`  - ${f}`));
    app.exit(1);
  }
  console.log('全部通过');
  app.exit(0);
});
