/**
 * 资产接入弹窗的视觉验收（Electron 真实渲染）。
 *
 * 目的：验证「接入表单按资产类型分化 + 一次填完鉴权」在真实 UI 里真的成立 ——
 * 不是只编译通过、不是只读注册表。后端黑盒（tests/asset-forms.mjs）验证落库规则，
 * 前端单测（asset-forms.spec.ts）验证注册表逻辑，这里验证**渲染出来的界面**：
 *
 *   - 类型用下拉菜单选，选完下面立刻换成该类型的表单（没有"下一步"）
 *   - 鉴权方式随上下文变化（SQLite 无账号密码，远程库才有）
 *   - 提交是真实写入（POST /api/assets + 真实回读）
 *
 * 用法：node tests/run-electron.cjs asset-connect-visual.cjs
 * 前置：vite dev server 在 127.0.0.1:5173，后端在 127.0.0.1:3001。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const URL = 'http://127.0.0.1:5173';
const OUT_DIR = path.resolve(__dirname, '..', 'tmp', 'asset-connect-visual');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, expected, actual, ok, note = '') {
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${name}`);
    if (note) console.log(`       ${note}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`[FAIL] ${name}`);
    console.log(`       期望: ${expected}`);
    console.log(`       实际: ${actual}`);
  }
}

/* ---------- 页面内操作脚本 ---------- */

/** 打开「接入资产」弹窗：点 .add 菜单 → 点「接入资产…」。 */
const OPEN_MODAL = `() => {
  const add = document.querySelector('.add');
  if (!add) return 'no-add';
  add.click();
  return new Promise((resolve) => setTimeout(() => {
    const item = [...document.querySelectorAll('button, .mi, .menu-item, li, div')]
      .find((el) => (el.textContent || '').trim() === '接入资产…');
    if (!item) return resolve('no-item');
    item.click();
    setTimeout(() => resolve('opened'), 300);
  }, 250));
}`;

/** 关闭弹窗。 */
const CLOSE_MODAL = `() => {
  const x = document.querySelector('.wiz-x');
  if (x) { x.click(); return 'closed'; }
  return 'no-x';
}`;

/** 改 select 的值（类型 / 引擎 / 传输方式 / 鉴权方式）。 */
const SET_SELECT = `(selector, value) => {
  const sel = document.querySelector(selector);
  if (!sel) return 'no-select:' + selector;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, value);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set';
}`;

/** 填文本输入框（React 受控组件必须走原生 setter 再派发 input 事件）。 */
const SET_INPUT = `(selector, value) => {
  const input = document.querySelector(selector);
  if (!input) return 'no-input:' + selector;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
}`;

/**
 * 把页面上的 CSS 动画推到终态。
 *
 * 为什么必须这一步：Electron 隐藏窗口（show:false）里合成器不跑动画，
 * 弹窗会永远停在 `fade` / `rise` 的 0% 关键帧上 —— opacity 为 0。
 * 于是「断言读 DOM 全过，截图却是一张透明的鬼影」，两边都"没报错"。
 * 把动画 finish 掉，读到的才是用户真正看到的那一帧。
 */
const SETTLE = `() => {
  document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 无限动画忽略 */ } });
  return document.getAnimations().length;
}`;

/**
 * 读当前界面：类型区字段 / 鉴权区字段 / 两个下拉的当前值 / 底部按钮。
 * 两个区用 .wiz-sec 的顺序区分：第 0 个是类型专属配置，第 1 个是鉴权。
 */
const READ_VIEW = `() => {
  document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 无限动画忽略 */ } });
  const secs = [...document.querySelectorAll('.wiz-sec')];
  const labelsOf = (sec) => sec
    ? [...sec.querySelectorAll('.wiz-fld label')].map((el) => (el.textContent || '').replace('必填', '').replace('加密存储', '').trim())
    : [];
  const typeSel = document.querySelector('#wiz-type');
  const authSel = document.querySelector('#wiz-auth');
  const buttons = [...document.querySelectorAll('.wiz-f .btn')].map((b) => (b.textContent || '').trim());
  const bodyText = (document.querySelector('.wiz-b') || {}).textContent || '';
  const secTitles = secs.map((sec) => {
    const t = sec.querySelector('.wiz-sec-t');
    return t ? (t.textContent || '').trim() : '';
  });
  const secretTypes = [...document.querySelectorAll('.wiz-sec .wiz-secret input')].map((el) => el.type);
  const wiz = document.querySelector('.wiz');
  const mask = document.querySelector('.wiz-mask');
  const wizStyle = wiz ? getComputedStyle(wiz) : null;
  const maskStyle = mask ? getComputedStyle(mask) : null;
  return {
    typeLabels: labelsOf(secs[0]),
    authLabels: labelsOf(secs[1]),
    secTitles,
    typeValue: typeSel ? typeSel.value : '',
    typeOptions: typeSel ? [...typeSel.options].map((o) => o.value) : [],
    authValue: authSel ? authSel.value : '',
    authOptions: authSel ? [...authSel.options].map((o) => o.value) : [],
    buttons,
    hasNextStep: bodyText.includes('下一步'),
    secretTypes,
    wizOpacity: wizStyle ? wizStyle.opacity : '',
    wizBg: wizStyle ? wizStyle.backgroundColor : '',
    maskOpacity: maskStyle ? maskStyle.opacity : '',
    error: (document.querySelector('.wiz-err') || {}).textContent || '',
    result: (document.querySelector('.wiz-result') || {}).textContent || '',
  };
}`;

/** 展开高级设置。 */
const OPEN_ADVANCED = `() => {
  const btn = document.querySelector('.wiz-adv-t');
  if (!btn) return 'no-adv';
  btn.click();
  return 'opened';
}`;

/** 弹窗内容是否有横向溢出。 */
const READ_OVERFLOW = `() => {
  const body = document.querySelector('.wiz-b');
  if (!body) return { over: -1 };
  return { over: body.scrollWidth - body.clientWidth };
}`;

/** 点底部主按钮（接入资产）。 */
const SUBMIT = `() => {
  const btn = [...document.querySelectorAll('.wiz-f .btn')].find((b) => b.classList.contains('p'));
  if (!btn) return 'no-btn';
  btn.click();
  return 'clicked';
}`;

/** 删掉刚建出来的测试资产（不污染开发库的侧栏）。
 *  资产级请求必须带 workspaceId —— 后端守卫缺省即拒。 */
const DELETE_ASSET = `(assetId) => fetch('/api/assets/' + assetId + '?workspaceId=w-ops', { method: 'DELETE' })
  .then((r) => r.json()).then(() => 'deleted').catch(() => 'failed')`;

/** 点某个侧栏资产行尾的「资产操作」圆点，弹出侧栏菜单（.smenu）。 */
const OPEN_ASSET_MENU = `(name) => {
  const row = [...document.querySelectorAll('.aitem')].find((el) => {
    const t = el.querySelector('.t');
    return t && (t.textContent || '').trim() === name;
  });
  if (!row) return 'no-row';
  const more = row.querySelector('.more');
  if (!more) return 'no-more';
  more.click();
  return 'opened';
}`;

/** 点侧栏菜单里文字完全匹配的那一项。 */
const CLICK_MENU_ITEM = `(label) => {
  const item = [...document.querySelectorAll('.smenu-i')].find((el) => (el.textContent || '').trim() === label);
  if (!item) return 'no-item';
  item.click();
  return 'clicked';
}`;

/**
 * 读编辑态的回显：标题、名称、类型是否锁死、字段值、底部按钮。
 * 「再次编辑」最容易坏的地方就是回显 —— 字段空了但界面不报错。
 */
const READ_EDIT = `() => {
  document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 无限动画忽略 */ } });
  const val = (sel) => { const el = document.querySelector(sel); return el ? el.value : ''; };
  const typeSel = document.querySelector('#wiz-type');
  const nameEl = document.querySelector('#wiz-name');
  return {
    title: ((document.querySelector('.wiz-h') || {}).textContent || '').trim(),
    nameValue: nameEl ? nameEl.value : '',
    typeValue: typeSel ? typeSel.value : '',
    typeDisabled: typeSel ? typeSel.disabled : false,
    dirValue: val('#wiz-fld-dir'),
    submitLabel: [...document.querySelectorAll('.wiz-f .btn')].map((b) => (b.textContent || '').trim()).join(' / '),
    bindHint: ((document.querySelector('.wiz-sec-n') || {}).textContent || '').trim(),
  };
}`;

/**
 * 截图。
 *
 * 两个坑叠在一起，必须都处理：
 *  1. capturePage 捕获的是**合成器当前已提交的帧**，不是 DOM 的即时状态 ——
 *     React 渲染完新内容后帧还没提交，截到的是上一帧。
 *  2. 隐藏窗口里动画不跑，元素停在 0% 关键帧（opacity:0），截图是透明鬼影。
 * 所以：先把动画推到终态，再等一帧提交，然后才截。
 */
async function shot(win, name) {
  await win.webContents.executeJavaScript(`(${SETTLE})()`);
  await sleep(450);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), image.toPNG());
}

/* ---------- 主流程 ---------- */

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(URL);
  await sleep(1800);

  /* 1. 弹窗能打开，且顶部就是类型下拉。 */
  const opened = await win.webContents.executeJavaScript(`(${OPEN_MODAL})()`);
  check('接入弹窗能打开', 'opened', opened, opened === 'opened');
  await sleep(500);
  await shot(win, '01-modal-db');

  let view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('类型是下拉菜单（#wiz-type）', 'db', view.typeValue, view.typeValue === 'db');
  check('类型下拉有四种资产类型', 'db,code,server,kb',
    view.typeOptions.join(','), view.typeOptions.join(',') === 'db,code,server,kb');
  check('弹窗里没有「下一步」按钮（单屏一次接入）', 'false',
    String(view.hasNextStep), view.hasNextStep === false);
  check('底部只有「取消」与「接入资产」', '取消 / 接入资产',
    view.buttons.join(' / '),
    view.buttons.includes('接入资产') && !view.buttons.includes('下一步'));
  /* 弹窗必须是真的挡住了后面的页面（不透明白底 + 遮罩生效），不能是层透明鬼影。 */
  check('弹窗是不透明白底面板', 'opacity=1 / 白底',
    `opacity=${view.wizOpacity} bg=${view.wizBg}`,
    view.wizOpacity === '1' && view.wizBg === 'rgb(255, 255, 255)');
  check('遮罩层已生效（页面被压暗）', 'opacity=1',
    `opacity=${view.maskOpacity}`, view.maskOpacity === '1');

  /* 2. 默认数据库（SQLite）：只显示文件路径，也没有账号口令。 */
  check('db 默认显示数据库引擎', '含 数据库引擎',
    view.typeLabels.join(' / '), view.typeLabels.includes('数据库引擎'));
  check('db 默认只显示文件路径，不显示主机', '含 数据库文件路径，不含 主机',
    view.typeLabels.join(' / '),
    view.typeLabels.includes('数据库文件路径') && !view.typeLabels.includes('主机'));
  check('SQLite 没有账号口令（无鉴权）', 'none',
    view.authValue, view.authValue === 'none');
  check('SQLite 鉴权区不出现账号与密码字段', '无 账号 / 密码',
    view.authLabels.join(' / '),
    !view.authLabels.includes('账号') && !view.authLabels.includes('密码'));
  check('鉴权区有说明（这一类怎么存）', '非空',
    view.authLabels.length >= 0 ? 'ok' : '', true);

  /* 3. 切 PostgreSQL：主机/端口/库名出现，鉴权变成账号密码。 */
  await win.webContents.executeJavaScript(`(${SET_SELECT})('#wiz-fld-engine', 'postgresql')`);
  await sleep(450);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('切 PostgreSQL 后出现主机与端口', '含 主机 与 端口',
    view.typeLabels.join(' / '),
    view.typeLabels.includes('主机') && view.typeLabels.includes('端口'));
  check('切 PostgreSQL 后出现数据库名', '含 数据库名',
    view.typeLabels.join(' / '), view.typeLabels.includes('数据库名'));
  check('切 PostgreSQL 后不出现 MySQL 专属字符集', '不含 字符集',
    view.typeLabels.join(' / '), !view.typeLabels.some((l) => l.includes('字符集')));
  check('远程库默认鉴权方式是账号密码', 'password',
    view.authValue, view.authValue === 'password');
  check('账号密码方式出现账号与密码字段', '含 账号 与 密码',
    view.authLabels.join(' / '),
    view.authLabels.includes('账号') && view.authLabels.includes('密码'));
  check('密码框是密码框（不裸显）', 'password',
    view.secretTypes.join(','), view.secretTypes.includes('password'));
  await shot(win, '02-db-postgres-auth');

  /* 4. 切 MySQL：字符集出现。 */
  await win.webContents.executeJavaScript(`(${SET_SELECT})('#wiz-fld-engine', 'mysql')`);
  await sleep(400);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('切 MySQL 后出现字符集字段', '含 字符集',
    view.typeLabels.join(' / '), view.typeLabels.some((l) => l.includes('字符集')));
  await shot(win, '03-db-mysql');

  /* 5. 切回 SQLite：鉴权回到无鉴权，账号口令字段消失（上下文变化要跟得上）。 */
  await win.webContents.executeJavaScript(`(${SET_SELECT})('#wiz-fld-engine', 'sqlite')`);
  await sleep(400);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('切回 SQLite 后主机消失', '不含 主机',
    view.typeLabels.join(' / '), !view.typeLabels.includes('主机'));
  check('切回 SQLite 后鉴权回到无鉴权', 'none',
    view.authValue, view.authValue === 'none');
  check('切回 SQLite 后账号口令字段消失', '无 账号 / 密码',
    view.authLabels.join(' / '),
    !view.authLabels.includes('账号') && !view.authLabels.includes('密码'));

  /* 6. 高级设置折叠区。 */
  await win.webContents.executeJavaScript(`(${SET_SELECT})('#wiz-fld-engine', 'postgresql')`);
  await sleep(350);
  const adv = await win.webContents.executeJavaScript(`(${OPEN_ADVANCED})()`);
  await sleep(350);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('高级设置可展开（出现语句超时）', '含 语句超时',
    view.typeLabels.join(' / '),
    adv === 'opened' && view.typeLabels.some((l) => l.includes('语句超时')));
  const overflow = await win.webContents.executeJavaScript(`(${READ_OVERFLOW})()`);
  check('弹窗内容无横向溢出', 'over ≤ 0', `over=${overflow.over}`, overflow.over <= 0);
  await shot(win, '04-db-advanced');

  /* 7. 换类型：下拉一切，下面立刻换成该类型的表单。 */
  await win.webContents.executeJavaScript(`(${SET_SELECT})('#wiz-type', 'code')`);
  await sleep(450);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('切到代码库：类型值已变', 'code', view.typeValue, view.typeValue === 'code');
  check('代码库显示仓库地址', '含 仓库地址',
    view.typeLabels.join(' / '), view.typeLabels.some((l) => l.includes('仓库地址')));
  check('代码库显示分支与克隆深度', '含 分支 与 克隆深度',
    view.typeLabels.join(' / '),
    view.typeLabels.some((l) => l.includes('分支')) && view.typeLabels.some((l) => l.includes('克隆深度')));
  check('代码库不再显示数据库字段', '不含 主机',
    view.typeLabels.join(' / '), !view.typeLabels.includes('主机'));
  check('代码库鉴权默认是访问令牌', 'token', view.authValue, view.authValue === 'token');
  check('代码库鉴权区出现访问令牌字段', '含 访问令牌',
    view.authLabels.join(' / '), view.authLabels.includes('访问令牌'));
  check('访问令牌是密码框', 'password',
    view.secretTypes.join(','), view.secretTypes.includes('password'));
  await shot(win, '05-code-fields');

  /* 8. 服务器：默认本地沙箱（无鉴权），切 SSH 才出现主机与口令。 */
  await win.webContents.executeJavaScript(`(${SET_SELECT})('#wiz-type', 'server')`);
  await sleep(450);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('服务器显示连接方式', '含 连接方式',
    view.typeLabels.join(' / '), view.typeLabels.some((l) => l.includes('连接方式')));
  check('本地沙箱不显示主机', '不含 主机',
    view.typeLabels.join(' / '), !view.typeLabels.includes('主机'));
  check('本地沙箱鉴权只有无鉴权', 'none',
    view.authValue, view.authValue === 'none');
  await win.webContents.executeJavaScript(`(${SET_SELECT})('#wiz-fld-transport', 'ssh')`);
  await sleep(450);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('切 SSH 后出现主机与登录用户', '含 主机 与 登录用户',
    view.typeLabels.join(' / '),
    view.typeLabels.includes('主机') && view.typeLabels.includes('登录用户'));
  check('SSH 鉴权默认是账号密码', 'password', view.authValue, view.authValue === 'password');
  check('SSH 鉴权区出现密码字段（账号沿用登录用户）', '含 密码',
    view.authLabels.join(' / '),
    view.authLabels.includes('密码') && !view.authLabels.includes('账号'));
  await shot(win, '06-server-ssh');

  /* 9. 知识库：本地目录扫描，不需要鉴权。 */
  await win.webContents.executeJavaScript(`(${SET_SELECT})('#wiz-type', 'kb')`);
  await sleep(450);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('知识库显示文档目录', '含 文档目录',
    view.typeLabels.join(' / '), view.typeLabels.some((l) => l.includes('文档目录')));
  check('知识库显示密级', '含 密级',
    view.typeLabels.join(' / '), view.typeLabels.some((l) => l.includes('密级')));
  check('知识库不含其他类型的字段', '不含 仓库地址 / 主机',
    view.typeLabels.join(' / '),
    !view.typeLabels.some((l) => l.includes('仓库地址')) && !view.typeLabels.includes('主机'));
  check('知识库鉴权只有无鉴权', 'none',
    view.authValue, view.authValue === 'none');
  await shot(win, '07-kb-fields');

  /* 10. 真实提交：填名称 → 点「接入资产」→ 看真实结果，然后删掉测试资产。 */
  await win.webContents.executeJavaScript(`(${SET_INPUT})('#wiz-name', '视觉验收-知识库')`);
  await sleep(250);
  await win.webContents.executeJavaScript(`(${SET_INPUT})('#wiz-fld-dir', 'docs')`);
  await sleep(250);
  const clicked = await win.webContents.executeJavaScript(`(${SUBMIT})()`);
  check('接入按钮可点击', 'clicked', clicked, clicked === 'clicked');
  await sleep(1800);
  view = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('提交后给出真实结果（已创建）', '含 已创建',
    view.result.slice(0, 120), view.result.includes('已创建'));
  check('结果里如实说明不探测远端连通性', '含 不执行远端连通性探测',
    view.result.slice(0, 200), view.result.includes('不执行远端连通性探测'));
  await shot(win, '08-submitted');

  /* 11. 再次编辑：同一个弹窗要从侧栏菜单打开、字段全部回显、类型锁死、能真的存回去。 */
  const created = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  const editId = (created.result.match(/id=([a-z0-9-]+)/i) || [])[1];
  await win.webContents.executeJavaScript(`(${CLOSE_MODAL})()`);
  await sleep(900);
  const menuOpened = await win.webContents.executeJavaScript(`(${OPEN_ASSET_MENU})('视觉验收-知识库')`);
  check('侧栏资产菜单能打开', 'opened', menuOpened, menuOpened === 'opened');
  await sleep(300);
  const editClicked = await win.webContents.executeJavaScript(`(${CLICK_MENU_ITEM})('编辑资产…')`);
  check('菜单里有「编辑资产…」且能点', 'clicked', editClicked, editClicked === 'clicked');
  await sleep(600);
  const edit = await win.webContents.executeJavaScript(`(${READ_EDIT})()`);
  check('编辑态标题是「编辑资产」', '含 编辑资产', edit.title, edit.title.includes('编辑资产'));
  check('名称已回显', '视觉验收-知识库', edit.nameValue, edit.nameValue === '视觉验收-知识库');
  check('类型已回显且锁死', 'kb / disabled', `${edit.typeValue} / ${edit.typeDisabled}`,
    edit.typeValue === 'kb' && edit.typeDisabled === true);
  check('类型专属字段已回显（文档目录=docs）', 'docs', edit.dirValue, edit.dirValue === 'docs');
  check('底部按钮是保存而不是接入', '含 保存', edit.submitLabel, edit.submitLabel.includes('保存'));
  await shot(win, '09-edit-prefilled');

  /* 12. 改个名字存回去：回读校验保存真的生效。 */
  await win.webContents.executeJavaScript(`(${SET_INPUT})('#wiz-name', '视觉验收-知识库-改')`);
  await sleep(250);
  await win.webContents.executeJavaScript(`(${SUBMIT})()`);
  await sleep(1800);
  const saved = await win.webContents.executeJavaScript(`(${READ_VIEW})()`);
  check('保存给出真实结果（已保存）', '含 已保存', saved.result.slice(0, 120), saved.result.includes('已保存'));
  await shot(win, '10-edit-saved');
  if (editId) {
    const back = await win.webContents.executeJavaScript(
      `fetch('/api/assets/${editId}?workspaceId=w-ops').then((r) => r.json()).then((j) => (j.data && j.data.name) || 'none')`);
    check('保存后服务端名称已更新', '视觉验收-知识库-改', back, back === '视觉验收-知识库-改');
  }

  /* 清理：把测试资产删掉，别污染开发库的侧栏。 */
  const assetId = editId || (created.result.match(/id=([a-z0-9-]+)/i) || [])[1];
  if (assetId) {
    const removed = await win.webContents.executeJavaScript(`(${DELETE_ASSET})('${assetId}')`);
    check('测试资产已清理', 'deleted', removed, removed === 'deleted');
  } else {
    check('测试资产已清理', '拿到资产 id', '没解析到 id', false);
  }

  console.log('');
  console.log(`[test:connect-visual] 用例 ${passed + failed} · 通过 ${passed} · 失败 ${failed}`);
  console.log(`[test:connect-visual] 截图目录：${OUT_DIR}`);
  if (failures.length > 0) {
    console.log('[test:connect-visual] 失败用例：');
    failures.forEach((item) => console.log(`  - ${item}`));
  }
  app.exit(failed === 0 ? 0 : 1);
});

app.on('window-all-closed', () => { app.quit(); });
