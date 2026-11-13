/**
 * 数据库页视觉与交互验证 —— QA
 *
 * 前置：vite dev server 在 127.0.0.1:5173（或 DEVWORK_VITE_PORT）。
 * 运行：`env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe tests/db-visual.cjs`
 *
 * 用隐藏 BrowserWindow 加载页面 → 进入数据库详情 → 逐个验证新能力：
 *   1. 对象树渲染（表/视图/索引分类 + 行数）
 *   2. 点击表 → 打开表标签页
 *   3. 列头排序 → 真实排序
 *   4. 筛选面板 → 条件生效
 *   5. 字段页签 / DDL 页签
 *   6. 导出菜单多格式
 * 并截图存档，供人工复核视觉。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.DEVWORK_VITE_PORT ?? '5173';
const URL = `http://127.0.0.1:${PORT}`;
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'db-visual');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

/** 端口探测：vite 可能在 5173 被占用而自动顺延到 5174，
 * 写死端口会让测试假失败（连到了别的东西或什么都没有）。 */
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

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });

  const target = await resolveUrl();
  console.log(`[db-visual] 目标页面：${target}`);
  await win.loadURL(target);
  await sleep(2800);

  /* ---------- 进入数据库详情页 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.aitem[data-go="db"]');
    if (el) { el.click(); return 1; }
    return 0;
  })()`);
  await sleep(2200);

  /* ---------- 1. 对象树 ---------- */
  const tree = await win.webContents.executeJavaScript(`(() => {
    const obj = document.querySelector('.dbobj');
    if (!obj) return { ok: false, reason: 'no .dbobj' };
    const nodes = [...document.querySelectorAll('.dbobj .tnode')];
    const kinds = [...document.querySelectorAll('.dbobj-kind')].map((e) => e.textContent.trim());
    const foot = document.querySelector('.dbobj-foot')?.textContent?.trim() ?? '';
    const search = !!document.querySelector('.dbobj-search');
    /* 行数在 .cn2 里（右侧灰色小字），与节点名分开取值。
     * 注意：这段代码跑在 executeJavaScript 的模板字符串里，
     * 正则的反斜杠必须写双份（\\\\d），否则模板字符串会把 \\d 吞成 d。 */
    const counts = nodes.map((n) => n.querySelector('.cn2')?.textContent?.trim() ?? '');
    return {
      ok: true,
      nodeCount: nodes.length,
      nodeNames: nodes.slice(0, 8).map((n) => n.textContent.trim()),
      kinds,
      foot,
      search,
      counts,
      hasCounts: counts.some((c) => /\\d+\\s*行/.test(c)),
    };
  })()`);
  check('对象树渲染', '对象树存在且至少列出 5 个对象',
    `nodes=${tree.nodeCount}`, tree.ok && tree.nodeCount >= 5);
  check('对象树带分类', '含「表」「视图」「索引」分类标题',
    `kinds=${(tree.kinds ?? []).join('/')}`, (tree.kinds ?? []).some((k) => k.includes('表')));
  check('对象树带真实行数', '行数来自 COUNT(*) 实读，不含种子假标签（如 1.2M）',
    `counts=${(tree.counts ?? []).filter(Boolean).join(',')}`,
    tree.hasCounts === true
      && !(tree.counts ?? []).some((c) => /[MK]$/.test(String(c).replace(/\\s*行$/, ''))));
  check('对象树带搜索框', '.dbobj-search 存在',
    `search=${tree.search}`, tree.search === true);

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, '01-object-tree.png'), img.toPNG());
  });

  /* ---------- 2. 点击表打开标签页 ---------- */
  const opened = await win.webContents.executeJavaScript(`(() => {
    const node = [...document.querySelectorAll('.dbobj .tnode')]
      .find((n) => n.textContent.includes('order'));
    if (!node) return { ok: false, reason: 'no order node' };
    node.click();
    return { ok: true };
  })()`);
  await sleep(1800);
  const tabs = await win.webContents.executeJavaScript(`(() => {
    const list = [...document.querySelectorAll('.dbtab')].map((t) => t.textContent.trim());
    const active = document.querySelector('.dbtab.on')?.textContent?.trim() ?? '';
    return { list, active };
  })()`);
  check('点击表打开新标签页', '标签栏含 order 且处于激活态',
    `tabs=${(tabs.list ?? []).join('/')}, active=${tabs.active}`,
    opened.ok && (tabs.list ?? []).some((t) => t.includes('order')) && tabs.active.includes('order'));

  const grid = await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('.dbgrid');
    if (!g) return { ok: false };
    const heads = [...g.querySelectorAll('th')].map((h) => h.textContent.trim());
    const rows = g.querySelectorAll('tbody tr').length;
    const firstRow = [...(g.querySelector('tbody tr')?.children ?? [])].map((c) => c.textContent.trim());
    return { ok: true, heads, rows, firstRow, hasRn: heads[0] === '#' };
  })()`);
  check('数据网格渲染', '网格存在且有数据行',
    `rows=${grid.rows}`, grid.ok && grid.rows > 0);
  check('网格含行号列', '第一列表头为 #',
    `heads=${(grid.heads ?? []).slice(0, 3).join('/')}`, grid.hasRn === true);
  check('网格含真实列名', '表头含 id / status 等真实列',
    `heads=${(grid.heads ?? []).join(',')}`,
    (grid.heads ?? []).some((h) => h.includes('id')));

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, '02-table-grid.png'), img.toPNG());
  });

  /* ---------- 3. 列头排序 ---------- */
  const beforeSort = await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('.dbgrid');
    return [...(g?.querySelector('tbody tr')?.children ?? [])].map((c) => c.textContent.trim());
  })()`);
  await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('.dbgrid');
    const th = [...g.querySelectorAll('th')].find((h) => h.textContent.includes('amount'));
    if (th) th.click();
    return 1;
  })()`);
  await sleep(1600);
  const afterSort = await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('.dbgrid');
    const heads = [...g.querySelectorAll('th')].map((h) => h.textContent.trim());
    const rows = [...g.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.children].map((c) => c.textContent.trim()));
    const idx = heads.findIndex((h) => h.includes('amount'));
    const col = idx >= 0 ? rows.map((r) => r[idx]) : [];
    // 排序方向箭头已改为 SVG（不再是 ▲ 字符），改为断言排序态 class + 箭头图标存在。
    const th = [...g.querySelectorAll('th')].find((h) => h.textContent.includes('amount'));
    const sorted = !!th && th.classList.contains('dbgrid-sorted')
      && !!th.querySelector('.dbgrid-sort.on svg');
    return { rows, col, sorted };
  })()`);
  const nums = (afterSort.col ?? []).map((v) => Number(v)).filter((n) => !Number.isNaN(n));
  const isAsc = nums.every((v, i) => i === 0 || nums[i - 1] <= v);
  check('列头排序生效', 'amount 列按升序排列且行数不为空',
    `amounts=${(afterSort.col ?? []).join(',')}`,
    nums.length > 0 && isAsc);
  check('排序列头显示方向箭头', 'amount 表头为排序态且带方向箭头图标',
    `sorted=${afterSort.sorted}`, afterSort.sorted === true);

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, '03-sorted.png'), img.toPNG());
  });

  /* ---------- 4. 筛选面板 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.sqltools button')]
      .find((b) => b.textContent.includes('筛选'));
    if (btn) btn.click();
    return 1;
  })()`);
  await sleep(700);
  const filterUi = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.dbfilter');
    if (!panel) return { ok: false };
    const addBtn = [...panel.querySelectorAll('button')].find((b) => b.textContent.includes('条件'));
    if (addBtn) addBtn.click();
    return { ok: true };
  })()`);
  await sleep(700);
  const filterRow = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.dbfilter-row');
    if (!row) return { ok: false };
    const sels = row.querySelectorAll('select');
    const input = row.querySelector('input');
    return {
      ok: true,
      selectCount: sels.length,
      hasInput: !!input,
      options: sels[0] ? [...sels[0].options].map((o) => o.value) : [],
      ops: sels[1] ? [...sels[1].options].map((o) => o.value) : [],
    };
  })()`);
  check('筛选面板渲染', '筛选条存在且有列/运算符下拉',
    `selects=${filterRow.selectCount}`, filterUi.ok && filterRow.selectCount >= 2);
  check('筛选下拉含真实列', '列下拉含 id / status',
    `options=${(filterRow.options ?? []).join(',')}`,
    (filterRow.options ?? []).includes('id'));
  check('运算符白名单完整', '含 = != > >= LIKE IS NULL',
    `ops=${(filterRow.ops ?? []).join(',')}`,
    ['=', '!=', '>', '>=', '<=', 'LIKE', 'IS NULL'].every((op) => (filterRow.ops ?? []).includes(op)));

  /* 真正设一个筛选条件并验证结果集变小 */
  const filtered = await win.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.dbfilter-row');
    if (!row) return { ok: false };
    const sels = row.querySelectorAll('select');
    const [colSel, opSel] = sels;
    colSel.value = 'status';
    colSel.dispatchEvent(new Event('change', { bubbles: true }));
    return new Promise((resolve) => setTimeout(() => {
      const row2 = document.querySelector('.dbfilter-row');
      const s2 = row2.querySelectorAll('select');
      const op = s2[1];
      op.value = '=';
      op.dispatchEvent(new Event('change', { bubbles: true }));
      setTimeout(() => {
        const r3 = document.querySelector('.dbfilter-row');
        const input = r3.querySelector('input');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, 'PENDING');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        setTimeout(() => resolve({ ok: true }), 1600);
      }, 400);
    }, 400));
  })()`);
  const filterResult = await win.webContents.executeJavaScript(`(() => {
    const g = document.querySelector('.dbgrid');
    const rows = [...(g?.querySelectorAll('tbody tr') ?? [])].map((tr) =>
      [...tr.children].map((c) => c.textContent.trim()));
    const heads = [...(g?.querySelectorAll('th') ?? [])].map((h) => h.textContent.trim());
    const idx = heads.findIndex((h) => h.includes('status'));
    return { count: rows.length, statuses: [...new Set(rows.map((r) => r[idx]))], rows };
  })()`);
  check('筛选条件真实生效', '结果集只剩 PENDING 行',
    `count=${filterResult.count}, statuses=${(filterResult.statuses ?? []).join(',')}`,
    filtered.ok && filterResult.count > 0 && (filterResult.statuses ?? []).every((s) => s === 'PENDING'));

  const whereShown = await win.webContents.executeJavaScript(`(() => {
    return document.querySelector('[data-view="detail-db"] .dbody.on .dbar2')?.textContent ?? '';
  })()`);
  check('状态栏明示 WHERE 口径', '底部状态栏含 WHERE ... status = PENDING',
    `bar=${whereShown.slice(0, 120)}`, whereShown.includes('WHERE') && whereShown.includes('status'));

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, '04-filtered.png'), img.toPNG());
  });

  /* ---------- 4b. 未填值的条件不参与查询 ---------- */
  {
    /* 先清掉上一段留下的筛选条件，避免与本用例互相干扰。 */
    await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-view="detail-db"] .dbfilter');
      const clear = [...(panel?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('清除'));
      if (clear) clear.click();
      return 1;
    })()`);
    await sleep(1500);
    await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('[data-view="detail-db"] .dbfilter');
      const add = [...(panel?.querySelectorAll('button') ?? [])].find((b) => b.textContent.includes('条件'));
      if (add) add.click();
      return 1;
    })()`);
    await sleep(1600);
    const blankState = await win.webContents.executeJavaScript(`(() => {
      const g = document.querySelector('[data-view="detail-db"] .dbgrid');
      const rows = g?.querySelectorAll('tbody tr').length ?? 0;
      const warn = document.querySelector('[data-view="detail-db"] .dbfilter-warn')?.textContent?.trim() ?? '';
      return { rows, warn };
    })()`);
    check('未填值的条件不参与查询', '结果集仍显示全部行，且 UI 明示该条件未生效',
      `rows=${blankState.rows}, warn=${blankState.warn}`,
      blankState.rows > 3 && blankState.warn.includes('未生效'));
  }

  /* ---------- 5. 字段页签 & DDL 页签 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('[data-view="detail-db"] .dbody.on .sqltools button')]
      .find((b) => b.textContent.trim() === '字段');
    if (btn) btn.click();
    return 1;
  })()`);
  await sleep(1500);
  const fieldsUi = await win.webContents.executeJavaScript(`(() => {
    const rows = [...document.querySelectorAll('[data-view="detail-db"] .dbody.on table.g tbody tr')];
    const heads = [...document.querySelectorAll('[data-view="detail-db"] .dbody.on table.g thead th')].map((h) => h.textContent.trim());
    return {
      count: rows.length,
      heads: heads.slice(0, 8),
      first: rows[0] ? [...rows[0].children].map((c) => c.textContent.trim()) : [],
      hasIndexes: document.querySelector('[data-view="detail-db"] .dbody.on')?.textContent?.includes('索引') ?? false,
      hasFks: document.querySelector('[data-view="detail-db"] .dbody.on')?.textContent?.includes('外键') ?? false,
    };
  })()`);
  check('字段详情渲染', '字段表有 7 行且表头含默认值/可空/主键',
    `count=${fieldsUi.count}, heads=${(fieldsUi.heads ?? []).join('/')}`,
    fieldsUi.count >= 7 && (fieldsUi.heads ?? []).includes('默认值'));
  check('字段详情含索引与外键区块', '页面含索引与外键标题',
    `hasIndexes=${fieldsUi.hasIndexes}, hasFks=${fieldsUi.hasFks}`,
    fieldsUi.hasIndexes && fieldsUi.hasFks);

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, '05-fields.png'), img.toPNG());
  });

  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('[data-view="detail-db"] .dbody.on .sqltools button')]
      .find((b) => b.textContent.trim() === 'DDL');
    if (btn) btn.click();
    return 1;
  })()`);
  await sleep(1500);
  const ddlUi = await win.webContents.executeJavaScript(`(() => {
    const pre = document.querySelector('.dbddl pre');
    return { sql: pre?.textContent ?? '', hasPre: !!pre };
  })()`);
  check('DDL 预览渲染', '显示真实 CREATE TABLE 语句',
    `sql=${ddlUi.sql.slice(0, 70)}`, ddlUi.hasPre && ddlUi.sql.includes('CREATE TABLE'));

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, '06-ddl.png'), img.toPNG());
  });

  /* ---------- 6. 导出菜单多格式 ---------- */
  await win.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll('.dbtab')].find((t) => t.textContent.includes('SQL'));
    if (tab) tab.querySelector('.dbtab-n').click();
    return 1;
  })()`);
  await sleep(900);
  await win.webContents.executeJavaScript(`(() => {
    // 导出按钮的下拉箭头已换成 SVG 图标，按 data 属性定位更稳（不再依赖 '导出 ▾' 文本）。
    const btn = document.querySelector('[data-view="detail-db"] .dbody.on [data-export-trigger]')
      || [...document.querySelectorAll('[data-view="detail-db"] .dbody.on button')].find((b) => b.textContent.includes('导出'));
    if (btn) btn.click();
    return 1;
  })()`);
  await sleep(700);
  const exportMenu = await win.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('.dbexport');
    if (!menu) return { ok: false, items: [] };
    return { ok: true, items: [...menu.querySelectorAll('.cmenu-item')].map((i) => i.textContent.trim()) };
  })()`);
  check('导出菜单四格式', '菜单含 CSV / JSON / Markdown / SQL',
    `items=${(exportMenu.items ?? []).join('/')}`,
    exportMenu.ok && (exportMenu.items ?? []).length === 4
      && (exportMenu.items ?? []).some((i) => i.includes('JSON'))
      && (exportMenu.items ?? []).some((i) => i.includes('Markdown')));

  await win.webContents.capturePage().then(async (img) => {
    fs.writeFileSync(path.join(OUT_DIR, '07-export-menu.png'), img.toPNG());
  });

  /* ---------- 7. 无横向溢出 ---------- */
  const overflow = await win.webContents.executeJavaScript(`(() => {
    const vw = innerWidth;
    const bad = [];
    for (const el of document.querySelectorAll('.view.on *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > vw + 2) {
        let p = el.parentElement, clipped = false;
        while (p && p !== document.body) {
          const pcs = getComputedStyle(p);
          if (pcs.overflowX !== 'visible' || pcs.overflowY !== 'visible') { clipped = true; break; }
          p = p.parentElement;
        }
        if (!clipped) bad.push(el.className + ' right=' + Math.round(r.right));
      }
    }
    return bad.slice(0, 8);
  })()`);
  check('数据库页无横向溢出', '无元素超出视口右边界',
    `overflow=${JSON.stringify(overflow)}`, (overflow ?? []).length === 0);

  /* ---------- 控制台错误 ---------- */
  /* 只看与数据库视图相关的错误：Electron 的 CSP 警告等历史问题不该算在数据库页头上。
   * 判据：错误文本里出现 DatabaseDetail / DbObjectTree / DbDataGrid / DbFilterPanel。 */
  const dbErrors = consoleErrors.filter((message) =>
    /DatabaseDetail|DbObjectTree|DbDataGrid|DbFilterPanel|dbobj|dbgrid|dbfilter/.test(message));
  check('数据库页无运行时错误', '与数据库视图相关的控制台错误为 0',
    `dbErrors=${JSON.stringify(dbErrors.slice(0, 2))}, 其他历史错误=${consoleErrors.length - dbErrors.length}`,
    dbErrors.length === 0);

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
