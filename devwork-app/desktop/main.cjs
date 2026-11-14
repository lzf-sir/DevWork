/**
 * DevWork 桌面外壳主进程（纯 CJS JS，无 TS）。
 * 只负责窗口壳 + 后端子进程生命周期；业务逻辑全在系统 Node 22 + Express 独立进程中。
 * dev：concurrently 已起好 3001/5173 → 不重复 spawn；prod：自动 spawn 后端再同源加载。
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawn } = require('node:child_process');
const electronModule = require('electron');

/**
 * 后端端口**写死 3001**，打包态不受任何环境变量控制。
 *
 * 这不是疏忽，而是发布口径：壳与后端必须共享同一份端口假设，否则就是
 * 「壳探 3001、后端听 3031」的静默分叉（见 buildBackendEnv 里钉死 DEVWORK_PORT 的说明）。
 * 因此 A15 里「端口被占用」的验证必须由外部实例占住 **3001 本身**，
 * 不存在"换个端口验"的路子；也不存在 DEVWORK_SERVER_PORT 这种变量。
 */
const API_PORT = 3001;
const VITE_PORT = 5173;

/**
 * 运行期路径 —— 开发态与打包态的目录结构完全不同，这里一次性算清楚。
 *
 * 开发态：<repo>/electron/main.cjs            → APP_ROOT = <repo>
 * 打包态：resources/app.asar/electron/main.cjs → RES_ROOT = resources/
 *
 * 关键点：**后端是独立的 Node 进程，它读不了 asar 里的文件**。
 * 所以打包态的后端源码与依赖必须以真实目录形式落在 resources/server 下，
 * 由 scripts/package.mjs 暂存、electron-builder 拷进 extraResources。
 *
 * 打包态判定用 process.defaultApp：`electron .` 跑源码时它是 true，
 * 跑安装后的 exe 时是 false。这个判断不依赖 app 对象，
 * 因为 ELECTRON_RUN_AS_NODE 的重启分支里 app 根本不存在。
 */
/**
 * 打包态判定 —— 用 app.isPackaged，不用 process.defaultApp。
 *
 * process.defaultApp 只在 `electron .` 这种场景可靠；在某些打包产物上它判不出打包态，
 * 一旦判错，应用会以为自己还在开发：去连 5173 的开发服务器、不 spawn 后端、也不写日志，
 * 外部表现就是「窗口开着，但数据全空、后端端口没监听」。
 * app.isPackaged 是 Electron 官方给打包态用的判定，打包后恒为 true。
 *
 * electronModule 在 ELECTRON_RUN_AS_NODE 下是字符串（只有路径），此时 app 不存在，
 * 退回原判断 —— 那个分支紧接着就会重启自身进入 GUI 模式，不影响后续流程。
 */
const IS_PACKAGED = typeof electronModule === 'string'
  ? process.defaultApp !== true
  : electronModule.app.isPackaged;
const APP_ROOT = path.resolve(__dirname, '..');
/** 打包态的资源根目录（resources/），开发态等于仓库根。 */
const RES_ROOT = IS_PACKAGED ? process.resourcesPath : APP_ROOT;
/** 服务端根目录：打包态在 resources/server（暂存产物），开发态在 <repo>/backend。 */
const SERVER_ROOT = IS_PACKAGED ? path.join(RES_ROOT, 'server') : path.join(APP_ROOT, 'backend');
/** 后端运行时数据目录：开发态收在 backend/.runtime，打包态由 DEVWORK_DATA_DIR 指向用户数据目录。 */
const SERVER_DATA_DIR = IS_PACKAGED ? path.join(SERVER_ROOT, 'data') : path.join(SERVER_ROOT, '.runtime', 'data');
/** 后端入口：服务端是 TypeScript，靠 tsx 现场跑。 */
const SERVER_ENTRY = path.join(SERVER_ROOT, 'src', 'index.ts');
/**
 * tsx 运行时的两个挂载点：必须落在真实目录（普通 Node 读不到 app.asar 内部）。
 *
 * 不经 tsx cli.mjs 中转、直接 node --require preflight --import loader 拉起入口
 * （与 tsx cli 内部的 spawn 形态一致）：cli 外壳是一层多余的中间进程，
 * 它会把「Electron 横死」的断线事件截留在外壳层，真正的服务进程收不到
 * disconnect，就成了抱着端口的孤儿。直接 spawn 后，backendChild 就是
 * 服务本尊 —— 强杀树杀直接命中，父亡 → IPC 断 → 后端自清理的链路全程可达。
 */
const TSX_PREFLIGHT = path.join(SERVER_ROOT, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
const TSX_LOADER = path.join(SERVER_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
/**
 * 内置 Node 运行时（打包态）。
 *
 * 后端用 node:sqlite（Node 22.5+ 才有），而 Electron 33 自带的是 Node 20.x，
 * **不带 node:sqlite**。所以「免安装、复制即用」的前提是：包里自带一份 Node 22。
 * 由 scripts/package.mjs 把 node.exe 暂存到 resources/runtime/node.exe。
 */
const BUNDLED_NODE = path.join(RES_ROOT, 'runtime', 'node.exe');

/**
 * 用户数据目录（打包态）——**必须放在程序目录之外**。
 *
 * portable target 的工作方式：把整个 app 解压到 %TEMP%\...\app，退出时 RMDir /r 删掉。
 * 也就是说 resources/server/data 这类路径在运行期是**临时目录**，
 * 数据写在里面 = 每次启动都从零开始，用户配置当场蒸发。
 *
 * 落点优先级：
 *   ① exe 同级的 DevWorkData\ —— 绿色软件习惯：拷走 exe 就拷走数据；
 *   ② %LOCALAPPDATA%\DevWork —— exe 所在目录不可写时（Program Files）退回这里。
 */
function resolveUserDataDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;

  /* portable：绿色软件习惯，数据跟 exe 同目录，拷走 exe 就拷走数据。 */
  if (portableDir && fs.existsSync(portableDir)) {
    const preferred = path.join(portableDir, 'DevWorkData');
    try {
      fs.mkdirSync(preferred, { recursive: true });
      /* 真正写一个探针文件：mkdir 成功不代表有写权限。 */
      const probe = path.join(preferred, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return preferred;
    } catch {
      /* portable 目录不可写 → 落到下面的系统用户目录 */
    }
  }

  /* 安装版（NSIS）：走 Electron 标准 userData（%APPDATA%\DevWork）。
   * 这里**不能**再退回 exe 所在目录 —— 安装版 exe 在 Program Files，
   * 把库和沙箱写进安装目录既没写权限，卸载时还会留下删不掉的用户数据。 */
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  return userData;
}

/**
 * 某些宿主（如 IDE 集成终端）会注入 ELECTRON_RUN_AS_NODE=1，
 * 此时 require('electron') 只返回可执行文件路径，app 为 undefined。
 * 清除该变量后以 GUI 模式重启自身，桌面窗口才能正常创建。
 */
if (typeof electronModule === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const relaunch = spawn(electronModule, IS_PACKAGED ? [] : [APP_ROOT], {
    cwd: IS_PACKAGED ? RES_ROOT : APP_ROOT,
    env,
    windowsHide: false,
    stdio: 'inherit',
    detached: true,
  });
  relaunch.unref();
  process.exit(0);
}

const { app, BrowserWindow, Menu, Tray, nativeImage, dialog, ipcMain, shell, session } = electronModule;
/* 待人徽标的纯计算部分（画点阵、算标题）单独成模块：能直接跑断言，不用起整个壳。 */
const attention = require('./attention.cjs');

/** 窗口基准标题。任务栏显示的 `(4) DevWork` 由 attention.windowTitle 拼。 */
const BASE_TITLE = 'DevWork';

/**
 * 打包态把主进程输出落到 <userData>/logs/desktop.log。
 *
 * GUI 程序没有控制台，console 输出直接进黑洞 —— 出问题时「双击没反应」
 * 就只剩猜。官方桌面端同样把启动日志存到 user-data/logs/desktop.log，
 * 这里对齐这个约定。开发态保持原样，不制造额外文件。
 */
function initFileLogging() {
  if (!IS_PACKAGED) return;

  /* 落点优先级：userData/logs（官方约定）→ %TEMP%（一定可写，兜底）。
   * 只留一个落点的话，恰恰在「userData 取不到」这种最需要日志的时候没日志。 */
  const candidates = [];
  try {
    candidates.push(path.join(resolveUserDataDir(), 'logs', 'desktop.log'));
  } catch { /* userData 不可用，走 TEMP */ }
  const temp = process.env.TEMP || process.env.TMP;
  if (temp) candidates.push(path.join(temp, 'devwork-desktop.log'));

  const format = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    try { return JSON.stringify(value); } catch { return String(value); }
  };

  for (const file of candidates) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const stream = fs.createWriteStream(file, { flags: 'a' });
      const tee = (level, original) => (...args) => {
        try {
          stream.write(`[${new Date().toISOString()}] ${level} ${args.map(format).join(' ')}\n`);
        } catch { /* 日志写入失败不能影响主流程 */ }
        original(...args);
      };
      console.log = tee('INFO', console.log.bind(console));
      console.warn = tee('WARN', console.warn.bind(console));
      console.error = tee('ERROR', console.error.bind(console));
      console.log(`[DevWork] 日志已落盘：${file}`);
      return;
    } catch {
      /* 换下一个落点 */
    }
  }
  /* 两处都写不了：退回纯控制台，不阻塞启动。 */
  console.warn('[DevWork] 无法写入日志文件（userData 与 TEMP 均失败）');
}

initFileLogging();

let mainWindow = null;
let backendChild = null;
let shuttingDown = false;
let isDev = false;
let tray = null;
/** 自动重启预算：只自动重启一次，避免「崩 → 重启 → 崩」的无限循环刷日志。 */
let restartCount = 0;
/** 退避定时器句柄：关停时要清掉，否则关窗后还会冒出一个后端进程。 */
let restartTimer = null;
/**
 * 主窗口当前是不是停在错误页。
 *
 * 错误页上没有可用后端，托盘里也没有可操作的东西：这时点关闭必须**直接退出**，
 * 不能像正常状态那样「最小化到托盘」—— 否则用户点了 X 什么都没有发生，会以为卡死。
 */
let errorShown = false;

/** 3001 被别的后端占着时的统一话术（不得接管别人的后端，见 bootstrap）。 */
const PORT_BUSY_MESSAGE =
  '3001 已被占用，可能是上一次残留进程或正在运行的开发服务器（npm run dev）。请结束后重试。';
/* 桌面壳握手令牌：非开发模式下唯一能打开 3001 的凭证（浏览器没有）。
 * 空串 = 开发模式（vite 在跑），不做门禁。 */
let shellToken = '';
/* 令牌文件路径：与后端 shell-gate.ts 的 SHELL_TOKEN_FILE 保持一致（DATA_DIR/shell-token）。
 * 打包态在用户数据目录，开发态在 <repo>/backend/.runtime/data —— 两个进程认同一枚令牌。 */
const SHELL_TOKEN_FILE = IS_PACKAGED
  ? path.join(resolveUserDataDir(), 'data', 'shell-token')
  : path.join(SERVER_DATA_DIR, 'shell-token');

/**
 * 令牌解析（与后端 ensureShellToken 同优先级）：文件 > 新生成。
 * 先写者赢，后来者读文件（flag 'wx' 防并发双写），保证壳与后端、
 * 以及复用同一后端的多个壳实例认同一枚令牌。
 */
function ensureShellToken() {
  try {
    const fromFile = fs.readFileSync(SHELL_TOKEN_FILE, 'utf8').trim();
    if (fromFile !== '') return fromFile;
  } catch { /* 文件不存在 → 认领 */ }
  const token = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SHELL_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(SHELL_TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch {
    /* 并发认领失败：读对方写好的 */
    try {
      const winner = fs.readFileSync(SHELL_TOKEN_FILE, 'utf8').trim();
      if (winner !== '') return winner;
    } catch { /* 两个都没写成：用内存值兜底 */ }
  }
  return token;
}
/* forceClose：设置选择「退出应用」时二次 close 的放行标记（g3 真实消费）。 */
let forceClose = false;

/* g3 托盘图标：16x16 内嵌 PNG（蓝底白 D），不依赖外部资源文件。 */
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPElEQVR4nGNgQAJezR/+E4MZ0AGxGnEaRJEB2CSQAUFDaG4AIYOINgCXISPJgIGLRrJTI9FJmSoGUJKdAW85vu+aZIeNAAAAAElFTkSuQmCC';

/**
 * g3「关闭窗口时」真实生效：从后端 GET /api/desktop/close-action 读设置。
 *
 * 为什么不再直接读 /api/settings：登录体系落地后 /api/settings 属于业务数据，
 * 未登录必须 401 —— 桌面壳在登录前就要知道关闭行为，不能为了这个把设置接口放开。
 * 所以后端单独给了一个只返回一个动作串的公开端点。
 * 后端不可达时按设置默认值「最小化到托盘」处理。
 */
function fetchCloseAction() {
  return new Promise((resolve) => {
    /* 软件模式下接口有壳门禁，主进程 http.get 不走 session 网络栈，必须手动带令牌。 */
    const headers = shellToken ? { 'X-DevWork-Token': shellToken } : {};
    const req = http.get({ host: '127.0.0.1', port: API_PORT, path: '/api/desktop/close-action', timeout: 1500, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          resolve(String(json && json.data && json.data.action) === 'exit' ? 'exit' : 'tray');
        } catch {
          resolve('tray');
        }
      });
    });
    req.on('error', () => resolve('tray'));
    req.on('timeout', () => { req.destroy(); resolve('tray'); });
  });
}

function ensureTray() {
  if (tray) return;
  const trayMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => focusAnyWindow(),
    },
    { type: 'separator' },
    { label: '退出 DevWork', click: () => shutdown() },
  ]);
  tray = new Tray(nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64')));
  /* 托盘提示带上待人数量：窗口收起来之后，这是唯一还看得见的一行字。 */
  tray.setToolTip(attentionCtl.trayTip());
  tray.setContextMenu(trayMenu);
  tray.on('double-click', () => focusAnyWindow());
  tray.on('click', () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (win && win.isVisible()) win.focus();
    else focusAnyWindow();
  });
}

function destroyTray() {
  if (!tray) return;
  try { tray.destroy(); } catch { /* already gone */ }
  tray = null;
}

/**
 * 待人状态落到「窗口之外」：标题、任务栏、Dock、托盘提示。
 *
 * 具体怎么画、该调哪几个原生接口，都在 desktop/attention.cjs ——
 * 那边不依赖 Electron 生命周期，喂个假窗口就能断言。
 * 这里只负责把「当前窗口」「当前托盘」接进去：两者都会被关掉重建，
 * 所以必须是取的时候才拿，不能缓存句柄。
 */
const attentionCtl = attention.createAttentionController({
  app,
  nativeImage,
  getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  getTray: () => tray,
  platform: process.platform,
  baseTitle: BASE_TITLE,
});

/** 渲染进程推来的待人状态 → 交给控制器落地。 */
function applyAttention(payload) {
  return attentionCtl.apply(payload);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 端口探测（不受系统 http_proxy 影响）。 */
function probe(port, urlPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', timeout: 800 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(API_PORT, '/api/health')) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Node 运行时解析。
 *
 * 后端用 node:sqlite（Node 22.5+ 才有），所以必须找到**Node 22+**。
 * Electron 自带的 Node（20.x）没有 node:sqlite，拿它兜底只会得到一句看不懂的
 * "Cannot find module 'node:sqlite'" —— 所以这里只接受 22+ 的 Node，
 * 找不到就如实报告，而不是假装能跑。
 *
 * 优先级：
 *   ① DEVWORK_NODE_BIN 显式指定；
 *   ② **包内自带**的 resources/runtime/node.exe（打包态默认走这条）；
 *   ③ 系统 PATH 里的 node。
 * ② 是「免安装一键可用」的关键：目标机器不需要预装 Node。
 */
function nodeMajorOf(bin) {
  try {
    const output = execFileSync(bin, ['-p', 'process.versions.node.split(".")[0]'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    return Number(String(output).trim());
  } catch {
    return 0;
  }
}

function resolveNodeBin() {
  const override = process.env.DEVWORK_NODE_BIN;
  if (override && fs.existsSync(override)) {
    const major = nodeMajorOf(override);
    if (major >= 22) return { bin: override, electronRunAsNode: false, tier: 1, source: 'env' };
    return { bin: '', electronRunAsNode: false, tier: 0, reason: `DEVWORK_NODE_BIN 指向的 Node 版本是 ${major}，需要 22+` };
  }

  /* 包内自带运行时：免安装场景的主力路径。 */
  if (fs.existsSync(BUNDLED_NODE)) {
    const major = nodeMajorOf(BUNDLED_NODE);
    if (major >= 22) return { bin: BUNDLED_NODE, electronRunAsNode: false, tier: 2, source: 'bundled' };
    console.log(`[DevWork] 包内 Node 版本是 ${major}，低于 22+，改用系统 Node。`);
  }

  try {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    const output = execFileSync(finder, ['node'], { encoding: 'utf8', timeout: 5000 });
    const candidates = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const major = nodeMajorOf(candidate);
      if (major >= 22) return { bin: candidate, electronRunAsNode: false, tier: 1, source: 'system' };
      return {
        bin: '', electronRunAsNode: false, tier: 0,
        reason: `系统 Node 版本是 ${major}，后端需要 22+（node:sqlite）`,
      };
    }
  } catch {
    /* 找不到系统 Node */
  }
  return {
    bin: '', electronRunAsNode: false, tier: 0,
    reason: '未找到可用的 Node 22（后端依赖 node:sqlite）',
  };
}

/**
 * 启动序结构化日志（A15 的判定证据）。
 *
 * 为什么单独一种格式：错误页截图与「静默接管了别人的后端」截图长得一模一样，
 * 唯一硬证据是**日志里的次序**。所以这里每条只写「做之前/做之后的客观事实」，
 * 不写「启动正常」这类结论词 —— 判据是顺序，不是措辞。
 *
 * 时间戳由 initFileLogging() 的 tee 统一加（`[ISO] INFO ...`），这里不重复。
 */
function logBoot(message) {
  console.log(`[boot] ${message}`);
}

/** 后端 stderr 尾部：用来判断退出原因（EADDRINUSE 重试也抢不到端口，不该白等 2 秒）。 */
let backendStderrTail = '';
const STDERR_TAIL_LIMIT = 4000;

/**
 * 构造后端子进程的 env。
 *
 * **命名空间黑名单**而不是白名单 —— 白名单（只透传列出来的键）会丢掉
 * `PATH` / `USERPROFILE` / `TEMP` / `SystemRoot` / `NODE_EXTRA_CA_CERTS`，
 * 而后端有 8 处按裸名调 `git`、`command-executor` 还要起 `tasklist/docker/kubectl`：
 * 丢了 `PATH` → `probeTools()` 判 git 不可用 → 克隆/大纲/diff/工单 worktree 全废。
 * 丢掉企业 TLS 证书变量则是**静默**失败（表现是 fetch failed，不是证书错误）。
 *
 * 剔除哪些键：**「声明即剔除」** —— `shellOwned` 既是"本次要写入的集合"，
 * 也是"要从外部环境里剔除的集合"，同一个对象，结构上不可能漂移。
 * 不另维护一份键名清单：那是我们踩过三次的失效模式
 * （版本号三处硬编码 / stage-runtime 依赖清单漏 zod / 两份依赖清单），
 * 将来加第六个壳拥有的键只需在 `shellOwned` 里写一处。
 *
 * 为什么只剔这几个：其余 `DEVWORK_*` 是明文支持的运维开关
 * （SUPERAGENT / LLM_* / API_KEY / PRICE_PER_*），全剔等于把"用户配了 Key
 * 却看到未接入模型"这种静默失败换个方向重演一遍。
 *
 * @returns {Record<string, string | undefined>}
 */
function buildBackendEnv() {
  /* 壳拥有并钉死的值。注意 DEVWORK_SHELL_TOKEN 是**无条件写入**（可为空串）：
   * `if (shellToken) ...` 这种条件写入在条件不成立时会放过外部同名变量，
   * 而空串在 backend（http/shell-gate.ts:32）的语义就是"不开门禁"，写空串是安全的。 */
  const shellOwned = {
    DEVWORK_PORT: String(API_PORT),
    DEVWORK_SHELL_TOKEN: shellToken || '',
  };
  /* 打包态：数据目录必须落在程序目录之外（portable 运行期在临时目录，退出即删）。 */
  if (IS_PACKAGED) {
    const dataDir = resolveUserDataDir();
    shellOwned.DEVWORK_DATA_DIR = path.join(dataDir, 'data');
    shellOwned.DEVWORK_SANDBOX_DIR = path.join(dataDir, 'sandbox');
    /* 打包态不播种演示数据：库里只有真实接入的资源，没有预置的假资产/假会话。 */
    shellOwned.DEVWORK_CLEAN = '1';
    console.log(`[DevWork] 用户数据目录：${dataDir}`);
  }
  /* 被外部设置过、又被壳接管的键（只记键名）。 */
  const dropped = Object.keys(shellOwned).filter((key) => process.env[key] !== undefined);

  /**
   * 打包态额外**剔除但不代填**的键。
   *
   * 为什么不代填：后端会回落到内置默认值（`SCHEMA_PATH` 指向包内 schema.sql），
   * 这正是我们要的行为。
   *
   * 为什么必须剔 `DEVWORK_SCHEMA_PATH`：`database.ts:22` 是
   * `exec(readFileSync(SCHEMA_PATH))` —— 让环境变量指向任意文件，等于
   * 「外部文件 → 向用户库执行任意 DDL」。而这个"定制能力"本身并不成立：
   * 启动期的 `ensureColumn`（表不存在直接 return）/`dropLegacyAccountTables`（DROP 表）/
   * `ensureFtsTable`/审计 append-only 触发器**全都假设内置 schema 的结构**，
   * 换一份 schema 得到的不是定制，是**静默残缺的库** + 一堆远离原因的运行时错误。
   * 企业真要定制 schema，正确做法是出定制包，不是让用户塞环境变量。
   * 开发态保留（本地调试与迁移实验要用）。
   */
  const ignoredInPackaged = IS_PACKAGED ? ['DEVWORK_SCHEMA_PATH'] : [];

  const env = { ...process.env };
  for (const key of Object.keys(shellOwned)) delete env[key];
  Object.assign(env, shellOwned);
  for (const key of ignoredInPackaged) {
    if (process.env[key] === undefined) continue;
    delete env[key];
    /* WARN 级、中性措辞：这是"你的设置被忽略了"，不是错误。 */
    console.warn(`[boot] env ${key} ignored (打包态固定使用内置 schema，已忽略环境变量)`);
  }

  /* Electron 专用：子进程是普通 Node，带上这两个变量会改变它的行为
   * （ELECTRON_RUN_AS_NODE 会让 electron 变成 node；NODE_OPTIONS 里的
   * --require 钩子是宿主注入的，不应进后端）。 */
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  /* 日志：只记键名，**绝不记值**（DEVWORK_API_KEY 之类可能是真的密钥）。
   * 「forced」是给验收看的（证明钉死生效），「dropped」把**全部**被壳接管的键
   * 一次性列出来（逗号分隔），否则"到底哪几个被忽略了"只能靠读代码。 */
  logBoot(`env DEVWORK_PORT=${API_PORT} forced dropped=${dropped.join(',') || 'none'}`);

  /* 反向也要能自查：透传了哪些 DEVWORK_* 运维开关（同样只记键名）。
   * 用户说"我设了 Key 却提示未接入模型"时，要能一眼看出这个变量到底有没有到后端。 */
  const retained = Object.keys(process.env)
    .filter((key) => key.startsWith('DEVWORK_') && !(key in shellOwned) && !ignoredInPackaged.includes(key))
    .map((key) => key.slice('DEVWORK_'.length));
  if (retained.length > 0) {
    logBoot(`env retained_DEVWORK=${retained.join(',')}`);
  }

  /* 安全姿态相关的透传键必须留痕：这些"由用户环境决定行为"的开关一旦生效，
   * 出问题时必须能从日志反推出来。原则：只记键名/是否设置，绝不记值。 */
  if (env.DEVWORK_BROWSER_ALLOW_PRIVATE === '1') {
    /* WARN 级，不是 INFO：它改的是**安全姿态**。
     * 而且"能读到日志的人"与"需要被告知的人"不是同一批 —— 所以除了日志，
     * 前端设置页还会显示当前状态（数据来自 /api/health 的 browserAllowPrivate 字段）。 */
    console.warn(
      '[boot] env DEVWORK_BROWSER_ALLOW_PRIVATE=1 '
      + '(内网访问已开启：Agent 内置浏览器可访问 127/10/172.16/192.168 与本机无鉴权服务)',
    );
  }
  if (env.DEVWORK_LLM_PROVIDER) {
    /* provider 名（openai / deepseek 之类）不是秘密，可以直记。 */
    logBoot(`env DEVWORK_LLM_PROVIDER=${env.DEVWORK_LLM_PROVIDER}`);
  }
  if (env.DEVWORK_SCHEMA_PATH) {
    /* 走到这里只可能是**开发态**（打包态上面已剔除）。
     * 这个键决定启动时执行哪份 DDL（database.ts 直接 exec 该文件的 SQL），
     * 只记"被替换了"，不记路径内容（路径可能带用户名，没必要落盘）。 */
    logBoot('env DEVWORK_SCHEMA_PATH=set (启动期 DDL 使用外部文件)');
  }
  /* 密钥只记 set / unset —— 值一旦进日志，是比功能故障更严重的事故。 */
  logBoot(`env DEVWORK_API_KEY=${process.env.DEVWORK_API_KEY ? 'set' : 'unset'}`);

  /* 运维开关不静默吞：开发者有意关掉影子链路时必须生效，但要在日志里留一句，
   * 否则「工单永不出现」会被当成 bug 排查半天。 */
  if (env.DEVWORK_SUPERAGENT === 'off') {
    logBoot('env DEVWORK_SUPERAGENT=off (影子链路已由环境变量关闭)');
  }
  return env;
}

function spawnBackend() {
  const resolved = resolveNodeBin();
  if (!resolved.bin) {
    console.error(`[DevWork] 无法启动后端：${resolved.reason}`);
    return { ok: false, reason: resolved.reason };
  }
  if (!fs.existsSync(TSX_PREFLIGHT) || !fs.existsSync(TSX_LOADER)) {
    console.error('[DevWork] 未找到 tsx 运行时，无法启动后端');
    return { ok: false, reason: '打包产物里缺少 tsx 运行时（resources/server/node_modules/tsx）' };
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    console.error('[DevWork] 未找到服务端入口，无法启动后端');
    return { ok: false, reason: `打包产物里缺少服务端入口（${SERVER_ENTRY}）` };
  }
  const env = buildBackendEnv();
  backendStderrTail = '';
  // 后端凭据前端永不可见；此处只传运行时路径，不注入任何模型 Key。
  backendChild = spawn(resolved.bin, [
    '--require', TSX_PREFLIGHT,
    '--import', pathToFileURL(TSX_LOADER).href,
    SERVER_ENTRY,
  ], {
    cwd: SERVER_ROOT,
    env,
    windowsHide: true,
    // 第 4 个 ipc 通道用于 Windows 下的优雅收尾：Node 把 SIGTERM 映射为
    // TerminateProcess，后端 handler 不会触发，故优先用 IPC 消息通知 checkpoint。
    // 通道直达服务本尊：Electron 横死时后端能立即收到 disconnect 自清理。
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  logBoot(`spawn pid=${backendChild.pid} port=${API_PORT}`);
  backendChild.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk.toString('utf8')}`);
  });
  backendChild.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    process.stderr.write(`[backend] ${text}`);
    /* 留尾部用于判退出原因：EADDRINUSE 时重启一次也抢不到端口，
     * 白等 2 秒只会让用户多盯 2 秒空窗。 */
    backendStderrTail = (backendStderrTail + text).slice(-STDERR_TAIL_LIMIT);
  });
  /* 后端异常退出必须有人管（A-P1-02）。
   *
   * 后端的异常策略是 `uncaughtException → process.exit(1)`（不再吞掉继续跑），
   * 所以这里**是唯一的恢复点**，必须区分三种退出：
   *   normal       正常关停（shuttingDown）→ 什么都不做
   *   eaddrinuse   端口被抢 → 重试也抢不到，直接错误页（不从"自动重启一次"白等）
   *   crash        其他异常 → 退避 2s 自动重启**一次**，再失败切错误页
   * 重启成功由 retryBackend() 负责把窗口重新 loadURL(appUrl())，否则用户看到的
   * 还是上一张错误页。 */
  backendChild.on('exit', (code, signal) => {
    const pid = backendChild ? backendChild.pid : -1;
    backendChild = null;
    const eaddrinuse = /EADDRINUSE/i.test(backendStderrTail);
    if (shuttingDown) {
      logBoot(`backend-exit pid=${pid} code=${code} signal=${signal} restart=0 reason=normal`);
      return;
    }
    const reason = eaddrinuse ? 'eaddrinuse' : 'crash';
    const willRestart = !eaddrinuse && restartCount < 1;
    logBoot(`backend-exit pid=${pid} code=${code} signal=${signal} restart=${willRestart ? 1 : 0} reason=${reason}`);
    if (eaddrinuse) {
      showErrorPage(PORT_BUSY_MESSAGE, { reason: 'port-occupied' });
      return;
    }
    if (!willRestart) {
      showErrorPage(
        '后端进程异常退出，已自动重启一次仍未恢复。'
        + '请点「重试」，或查看日志目录中的后端输出定位原因。',
        { reason: 'backend-down' },
      );
      return;
    }
    restartCount += 1;
    console.log('[DevWork] 后端异常退出，2 秒后自动重启（只有一次自动重启机会）');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void retryBackend();
    }, 2000);
  });
  console.log(`[DevWork] 后端已 spawn · nodeTier=${resolved.tier} · source=${resolved.source} · bin=${resolved.bin}`);
  attachSecretIpc(backendChild);
  return { ok: true, reason: '' };
}

/* 密文文件跟着服务端走：打包态在用户数据目录，开发态在 <repo>/backend/.runtime/data。 */
const SECRETS_FILE = IS_PACKAGED
  ? path.join(resolveUserDataDir(), 'data', 'secrets.enc.json')
  : path.join(SERVER_DATA_DIR, 'secrets.enc.json');

function readSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { return {}; }
}

function writeSecrets(map) {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(map, null, 2));
}

/**
 * B17：凭据加解密 IPC —— 后端进程无法直接调 safeStorage，经 child 通道请求主进程。
 * 密文存 server/data/secrets.enc.json（safeStorage 加密，仅本机可解）；明文永不落盘。
 */
function attachSecretIpc(child) {
  const { safeStorage } = electronModule;
  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    const reply = (ok, value, error) => {
      try { child.send({ type: 'secret:result', reqId: message.reqId, ok, value, error }); } catch { /* 通道已关 */ }
    };
    if (message.type === 'secret:encrypt') {
      try {
        if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
          reply(false, null, 'safeStorage unavailable');
          return;
        }
        const secrets = readSecrets();
        secrets[String(message.ref)] = safeStorage.encryptString(String(message.value ?? '')).toString('base64');
        writeSecrets(secrets);
        reply(true, String(message.ref));
      } catch (error) {
        reply(false, null, String((error && error.message) || error));
      }
      return;
    }
    if (message.type === 'secret:decrypt') {
      try {
        const blob = readSecrets()[String(message.ref)];
        if (!blob) {
          reply(false, null, 'secret not found');
          return;
        }
        reply(true, safeStorage.decryptString(Buffer.from(String(blob), 'base64')));
      } catch (error) {
        reply(false, null, String((error && error.message) || error));
      }
      return;
    }
    /* 删除某条秘密：删掉模型档案后，它那把钥匙必须一起消失 ——
       否则用户以为已经清理干净，钥匙串里却还留着。 */
    if (message.type === 'secret:delete') {
      try {
        const secrets = readSecrets();
        const ref = String(message.ref);
        if (!(ref in secrets)) {
          reply(true, 'absent');
          return;
        }
        delete secrets[ref];
        writeSecrets(secrets);
        reply(true, ref);
      } catch (error) {
        reply(false, null, String((error && error.message) || error));
      }
    }
  });
}

/**
 * 优雅收尾：Windows 下 SIGTERM 会被映射为 TerminateProcess，后端 IPC handler
 * 根本来不及跑 WAL checkpoint，所以只发 devwork:shutdown，然后等待后端 ack /
 * 自然退出，最多 3s 兜底再强杀。POSIX 保留 SIGTERM 作为额外通知。
 */
/**
 * 强杀整棵子进程树（不是只杀直接子进程！）。
 *
 * 进程结构：backendChild 是 tsx 外壳，真正的 Express 跑在它 spawn 的子进程里。
 * Windows 下 child.kill('SIGKILL') 映射为 TerminateProcess，只终止直接子进程，
 * 抱着 3001 端口的孙进程会活成孤儿 —— 端口关不掉、下次启动报"被占用"。
 * 所以 Windows 用 taskkill /T 连树一起收；POSIX 的 SIGKILL 语义同理只杀单进程，
 * 也统一走 taskkill 的等价物（kill 负 pid 即进程组）不可得时退回单杀兕底。
 */
function forceKillTree(child) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      return;
    } catch {
      /* taskkill 失败（进程已退出/权限不足）→ 落回单进程兜底 */
    }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

function killBackend(done) {
  if (!backendChild || backendChild.exitCode !== null) {
    done();
    return;
  }
  const child = backendChild;
  let finished = false;
  let acked = false;
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      console.log('[DevWork] 后端优雅收尾超时，强制终止整棵进程树');
      forceKillTree(child);
    }
    finish();
  }, 3000);
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done();
  };
  child.once('exit', (code) => {
    console.log(`[DevWork] 后端已退出 code=${code} · ipcAck=${acked}`);
    finish();
  });
  child.on('message', (message) => {
    if (message && typeof message === 'object' && message.type === 'devwork:shutdown-ack') {
      acked = true;
      console.log('[DevWork] 收到 devwork:shutdown-ack（WAL checkpoint 已完成）');
    }
  });
  try {
    child.send({ type: 'devwork:shutdown' });
  } catch {
    // 无 ipc 通道（例如复用了外部起的服务）时直接走信号兜底。
    try { child.kill('SIGTERM'); } catch { finish(); }
    return;
  }
  if (process.platform !== 'win32') {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  /* 关停时把退避重启的定时器踢掉：否则关窗 2 秒后还会冒出一个后端进程，
   * 抱着 3001 变成孤儿（下次启动就报"端口被占用"）。 */
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  killBackend(() => app.exit(0));
}

/**
 * 启动失败页。
 *
 * @param {string} message 给用户看的一句话（不允许出现堆栈，堆栈进日志）
 * @param {{ retry?: boolean }} [options] retry=true 时带「重试」按钮
 *
 * 为什么按钮要兜两层：
 * ① 正常情况走 preload 暴露的 `desktop.restartBackend()`（IPC → 主进程）；
 * ② 万一 preload 桥没跑到（sandbox / 加载时序），退回一次导航到 `devwork://retry`，
 *    由主进程的 will-navigate 拦住处理 —— 否则错误页就成了一块点不动的石头。
 */
function errorPage(message, options = {}) {
  const withRetry = options.retry === true;
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DevWork 启动失败</title>',
    '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#FAFAF9;color:#232320;',
    'display:grid;place-items:center;height:100vh;margin:0}h2{font-weight:500}p{color:#6B6B66;',
    'font-size:13px;line-height:1.8;max-width:520px}button{margin-top:18px;padding:7px 18px;',
    'font-size:13px;border:1px solid #D8D8D2;border-radius:6px;background:#fff;color:#232320;',
    'cursor:pointer}button:disabled{color:#9A9A94;cursor:default}</style></head><body><div>',
    '<h2>DevWork 启动失败</h2><p>',
    String(message).replace(/[<>&]/g, ''),
    '</p><p>本程序已内置 Node 运行时，正常情况下无需任何额外环境。',
    '若仍无法启动，请查看日志目录中的后端输出，或在开发态执行 <code>npm run dev</code> 查看完整日志。</p>',
    withRetry
      ? '<button id="retry" type="button">重试</button><script>'
        + 'document.getElementById("retry").addEventListener("click",function(){'
        + 'this.disabled=true;this.textContent="正在重试…";'
        + 'if(window.desktop&&typeof window.desktop.restartBackend==="function"){'
        + 'window.desktop.restartBackend();}else{location.href="devwork://retry";}});'
        + '</script>'
      : '',
    '</div></body></html>',
  ].join('');
}

/**
 * 把主窗口切到错误页（窗口不在就建一个，不加载真实页面）。
 *
 * 注意 loadURL 用 data: 协议：此刻后端不可用，任何 127.0.0.1 的地址都只会得到
 * ERR_CONNECTION_REFUSED 的白屏。
 *
 * @param {string} message 给用户看的一句话
 * @param {{ retry?: boolean, reason?: string }} [options]
 *        reason 只进日志（port-occupied / backend-down / timeout），用来让 A15
 *        能凭日志判定「停在错误页」这件事，而不是靠人看截图。
 */
function showErrorPage(message, options = { retry: true }) {
  errorShown = true;
  logBoot(`error-page reason=${options.reason ?? 'unknown'}`);
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow({ skipLoad: true });
  const html = errorPage(message, options);
  void win.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  return win;
}

/** 后端就绪后把窗口切回真实页面（错误页 → 首屏）。 */
function reloadMainWindow() {
  errorShown = false;
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow({ skipLoad: true });
  void win.loadURL(appUrl());
}

/**
 * 等后端就绪并记两行日志（开始 / 结果）。
 *
 * 拆成「attach 开始」与「attach 结果」两条，而不是一条结论行：
 * A15 要判的是「probe → spawn → attach」的**顺序**，合并成一行就判不出来了。
 *
 * @param {number} attempt 第几次尝试（1 起）
 * @param {number} timeoutMs 等待上限
 */
async function attachBackend(attempt, timeoutMs) {
  logBoot(`attach url=http://127.0.0.1:${API_PORT} attempt=${attempt}`);
  const healthy = await waitForBackend(timeoutMs);
  logBoot(`attach attempt=${attempt} result=${healthy ? 'ok' : 'timeout'}`);
  return healthy;
}

/**
 * 重试启动后端（错误页「重试」按钮与自动重启共用这一条路径）。
 *
 * 三条分支都必须有明确出口，不允许"什么都不做"：
 *   ① 我们自己还有后端进程在跑 → 只等它（首启慢的机器上 waitForBackend 会先超时）；
 *   ② 我们没有后端进程，但 3001 已被别人占着 → 报占用，**不接管**（会读到别人的数据目录）；
 *   ③ 端口空闲 → spawn 一个新后端并等待。
 *
 * @returns {Promise<boolean>} 是否恢复到可用状态
 */
async function retryBackend() {
  logBoot('retry requested');
  if (shuttingDown) return false;
  /* 用真探活而不是问 backendChild：进程可能还活着但已经不会响应了。 */
  const owned = backendChild !== null && backendChild.exitCode === null;

  if (!owned) {
    if (await probe(API_PORT, '/api/health')) {
      logBoot(`probe port=${API_PORT} result=occupied`);
      console.log('[DevWork] 重试失败：3001 已被占用（不接管他人后端）');
      showErrorPage(PORT_BUSY_MESSAGE, { reason: 'port-occupied' });
      return false;
    }
    logBoot(`probe port=${API_PORT} result=free`);
    const spawned = spawnBackend();
    if (!spawned.ok) {
      showErrorPage(spawned.reason, { reason: 'backend-down' });
      return false;
    }
  }

  const healthy = await attachBackend(restartCount + 1, 20000);
  if (!healthy) {
    showErrorPage(
      '20 秒内仍未探测到 127.0.0.1:3001/api/health。'
      + '后端可能仍在初始化（大库首次迁移较慢），可以再点一次「重试」。',
      { reason: 'timeout' },
    );
    return false;
  }
  /* 恢复成功：把自动重启预算还回来，下次再崩还能自动救一次。 */
  restartCount = 0;
  reloadMainWindow();
  console.log('[DevWork] 后端已恢复，主窗口已重新加载');
  return true;
}

/**
 * 单窗口：应用启动即打开工作台。
 *
 * 纯本地工具没有登录窗口，也不存在「登录成功 → 换窗口」的交接；
 * 启动时直接创建主窗口，渲染层挂载即拉取本机数据。
 */
const MAIN_SIZE = { width: 1440, height: 900, minWidth: 1180, minHeight: 720 };

function appUrl() {
  return isDev ? `http://127.0.0.1:${VITE_PORT}` : `http://127.0.0.1:${API_PORT}`;
}

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    webSecurity: true,
    /* 内置浏览器用 <webview>：它是独立的 Chromium 实例，跨域页面能正常渲染，
     * 还能在自身上下文里执行脚本取页面正文（Agent 的 browser_read_page 要用）。
     * webview 用独立 partition（浏览器 Tab 里指定 devwork-browser），
     * 与主应用会话的 cookie / 存储隔离。 */
    webviewTag: true,
  };
}

/** 两个窗口都要的外链策略与 DevTools 状态回传。 */
function wireCommon(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  /* 错误页的重试兜底：preload 桥不可用时，页面退化成导航到 devwork://retry。
   * 这个协议没有注册处理器，不拦住会变成 ERR_UNKNOWN_URL_SCHEME 的白屏。 */
  win.webContents.on('will-navigate', (event, url) => {
    if (typeof url === 'string' && url.startsWith('devwork://retry')) {
      event.preventDefault();
      void retryBackend();
    }
  });
  win.webContents.on('devtools-opened', () => {
    if (!win.isDestroyed()) win.webContents.send('dev:devtools-changed', true);
  });
  win.webContents.on('devtools-closed', () => {
    if (!win.isDestroyed()) win.webContents.send('dev:devtools-changed', false);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.log(`[DevWork] 渲染进程退出：${details && details.reason}`);
  });
}

/** 创建主窗口（已存在则前置）。 */
function createMainWindow(options = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: MAIN_SIZE.width,
    height: MAIN_SIZE.height,
    minWidth: MAIN_SIZE.minWidth,
    minHeight: MAIN_SIZE.minHeight,
    backgroundColor: '#FAFAF9',
    show: false,
    frame: false,
    title: 'DevWork',
    webPreferences: webPreferences(),
  });
  const win = mainWindow;
  /* 标题由主进程掌握（待人数量前缀），不让页面 document.title 覆盖。
   * 这条应用是自绘标题栏，页面标题对用户不可见，唯一用途就是任务栏/Alt+Tab 文案。 */
  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => {
    win.show();
    /* 窗口可能晚于待人数据创建（重开窗口）：把最近一次状态补上。 */
    applyAttention(attentionCtl.current());
  });
  /* 窗口拿到焦点 = 人已经看到了：停止闪烁，别继续催。 */
  win.on('focus', () => {
    if (!win.isDestroyed()) win.flashFrame(false);
  });
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('win:maximize-changed', true);
  });
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('win:maximize-changed', false);
  });
  /* g3：拦截关闭 → 现查设置决定「最小化到托盘」还是「退出应用」。
   * 错误页例外：那时后端不可用，最小化到托盘等于让用户以为程序卡死。 */
  win.on('close', (event) => {
    if (shuttingDown || forceClose) return;
    if (errorShown) {
      event.preventDefault();
      shutdown();
      return;
    }
    event.preventDefault();
    void fetchCloseAction().then((action) => {
      if (action === 'exit') {
        forceClose = true;
        if (!win.isDestroyed()) win.close();
      } else {
        ensureTray();
        if (!win.isDestroyed()) win.hide();
      }
    });
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    destroyTray();
  });
  wireCommon(win);
  if (!options.skipLoad) void win.loadURL(appUrl());
  return win;
}

/** 托盘 / 全局找人：主窗口不在就重新创建。 */
function focusAnyWindow() {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (!win) {
    createMainWindow();
    return;
  }
  win.show();
  win.focus();
}

function registerIpc() {
  /* 窗口控制按"发起请求的那个窗口"来：登录窗口和主窗口共用同一套按钮，
   * 谁点的就对谁生效 —— 写死 mainWindow 会让登录窗口的关闭按钮失灵。 */
  const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);
  ipcMain.handle('win:close', (event) => { const win = senderWindow(event); if (win) win.close(); });
  ipcMain.handle('win:minimize', (event) => { const win = senderWindow(event); if (win) win.minimize(); });
  ipcMain.handle('win:maximize', (event) => {
    const win = senderWindow(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('win:is-maximized', (event) => {
    const win = senderWindow(event);
    return win ? win.isMaximized() : false;
  });
  ipcMain.handle('app:platform', () => process.platform);
  /* 渲染进程每次待人清单变化推一次：{ count, level }。
   * 主进程不再自己拉接口 —— 它拿不到登录态，也不该有两套口径。 */
  ipcMain.handle('win:attention', (_event, payload) => {
    return applyAttention(payload);
  });
  ipcMain.handle('app:versions', () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }));
  ipcMain.handle('app:api-base', () => '/api');
  /* 错误页「重试」：重新探活 / 必要时重启后端，就绪后把窗口切回真实页面。
   * 返回 true 表示已恢复，渲染进程据此决定要不要再亮着按钮（错误页是静态页，
   * 这里主要是给 preload 一个可 await 的语义）。 */
  ipcMain.handle('app:restart-backend', () => retryBackend());
  /* 系统日志目录的真实路径：设置页要如实显示，不能写死平台路径。 */
  ipcMain.handle('app:logs-path', () => app.getPath('logs'));
  /* 打包态标志：前端据此关闭 mock 降级（打包产物不应展示演示数据）。 */
  ipcMain.handle('app:is-packaged', () => IS_PACKAGED);
  /* 开发者模式：切换 DevTools，强制停靠窗口右侧（对应顶栏按钮的「右侧显示」）。 */
  ipcMain.handle('dev:toggle-devtools', () => {
    if (!mainWindow) return false;
    const wc = mainWindow.webContents;
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
      return false;
    }
    wc.openDevTools({ mode: 'right' });
    return true;
  });
  ipcMain.handle('dev:devtools-open', () => (mainWindow ? mainWindow.webContents.isDevToolsOpened() : false));
  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
  ipcMain.handle('shell:open-logs', async () => {
    const dir = app.getPath('logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* already exists */ }
    const result = await shell.openPath(dir);
    return !result;
  });
  ipcMain.handle('dialog:pick-directory', async (_event, options) => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: options && typeof options.defaultPath === 'string' ? options.defaultPath : undefined,
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
}

/**
 * 自动更新（electron-updater · generic provider）。
 *
 * 只在**安装版**启用。portable 是单文件自解压到临时目录运行的，没有稳定安装位置，
 * 更新器无处落盘 —— electron-updater 在 portable 下会直接报错。
 * 官方桌面端同样不把 portable 当发布产物，这里保持一致。
 *
 * 流程对齐官方：后台检查 → 用户显式确认 → 下载 → 提示重启。
 * 不做静默安装：这个应用常驻托盘、后台可能正在跑 Agent 任务，
 * 静默重启会把用户手上的活儿直接打断。
 */
function initAutoUpdater() {
  if (!IS_PACKAGED) return;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    console.log('[DevWork] portable 模式，跳过自动更新');
    return;
  }

  /* zip 分发没有安装器，electron-builder 不会生成 resources/app-update.yml。
   * 缺这份配置时 autoUpdater 直接抛 ENOENT，每次启动都刷一条错误日志 ——
   * 先确认配置存在，再决定要不要挂更新器。 */
  if (!fs.existsSync(path.join(RES_ROOT, 'app-update.yml'))) {
    console.log('[DevWork] 未生成更新配置（zip 分发），跳过自动更新');
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (error) {
    console.warn('[DevWork] 更新器不可用：', error.message);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  try { autoUpdater.channel = 'stable'; } catch { /* 旧版本无此属性 */ }

  autoUpdater.on('error', (error) => {
    /* 更新检查失败不该打扰用户：离线、更新源未部署都是正常情况。 */
    console.warn('[DevWork] 更新检查失败：', error && error.message);
  });

  autoUpdater.on('update-available', (info) => {
    void dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `DevWork ${info.version} 已发布`,
      detail: '是否现在下载？下载完成后会提示重启。',
      buttons: ['下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) {
        void autoUpdater.downloadUpdate().catch((error) => {
          console.warn('[DevWork] 更新下载失败：', error && error.message);
        });
      }
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    void dialog.showMessageBox({
      type: 'info',
      title: '更新已就绪',
      message: `DevWork ${info.version} 已下载完成`,
      detail: '重启后生效。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response !== 0) return;
      /* 重启安装前先收掉后端子进程，否则会留下抱 3001 端口的孤儿进程。 */
      shuttingDown = true;
      killBackend(() => autoUpdater.quitAndInstall(false, true));
    });
  });

  /* 延迟检查：别和首屏加载、后端启动抢 IO。 */
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => { /* 已在 error 事件里记录 */ });
  }, 8000);
}

async function bootstrap() {
  registerIpc();
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }

  /* 打包态**不探测**开发服务器。
   *
   * 5173 / 3001 上很可能正跑着 `npm run dev`：一旦探测到，打包版会加载开发页面、
   * 复用开发后端与开发库 —— 看起来"能跑"，实际跑的是另一份代码、另一份数据，
   * 而且开发进程一退出，窗口就成了连不上后端的空壳。
   * 单实例锁已经保证只有一个打包实例，所以打包态总是自己起后端。 */
  let healthy = false;
  if (IS_PACKAGED) {
    isDev = false;
  } else {
    isDev = await probe(VITE_PORT, '/');
    logBoot(`probe dev-port=${VITE_PORT} result=${isDev ? 'occupied' : 'free'}`);
  }

  /* 非开发模式：认领桌面壳令牌，网络层自动给 3001 请求注入 X-DevWork-Token。
   * 渲染进程 fetch 走 session 网络栈，用户无感；开发模式不做门禁也无需令牌。
   *
   * 这一步必须在**任何 spawn 之前**：端口被占用的分支会直接 return，
   * 之后用户点「重试」时由 retryBackend() 再起后端 —— 那时令牌必须已经认领好，
   * 否则重试起来的后端不带 DEVWORK_SHELL_TOKEN，等于把浏览器直连门禁关掉了。 */
  if (!isDev) {
    shellToken = ensureShellToken();
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (shellToken && details.url.startsWith(`http://127.0.0.1:${API_PORT}`)) {
        details.requestHeaders['X-DevWork-Token'] = shellToken;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  }

  if (IS_PACKAGED) {
    /* A-P1-01：spawn **之前**先探活。
     *
     * 若 3001 上已经有别人的后端（上一次崩溃的残留 / 正在跑的 npm run dev），
     * 我们 spawn 的后端会 EADDRINUSE 立刻退出，而 waitForBackend 探到的却是
     * **别人**的 /api/health → 200 → 窗口正常打开、读的是别人的数据目录
     * （很可能就是 backend/.runtime 里的开发库）。
     * 所以这里的处置是：如实报占用，**不 spawn、不接管**。
     * 判「端口上是否有人」用 /api/health 而不是 TCP connect：3001 上空进程
     * 与真后端对用户的含义完全不同，只有真后端才值得报"被占用"。
     *
     * 注意这条**不会挡死正常启动**：判定发生在「自己 spawn 之前」，
     * 端口空闲就照常 spawn；只有"我们还没起后端、端口上却已经有人应答"才报错。
     * 日志里 probe → spawn → attach 三行分离，就是为了让 A15 能证明这个次序。 */
    const occupied = await probe(API_PORT, '/api/health');
    logBoot(`probe port=${API_PORT} result=${occupied ? 'occupied' : 'free'}`);
    if (occupied) {
      console.log('[DevWork] 3001 被占用，拒绝启动后端（不接管他人服务）');
      showErrorPage(PORT_BUSY_MESSAGE, { reason: 'port-occupied' });
      return;
    }
  } else {
    healthy = await probe(API_PORT, '/api/health');
    logBoot(`probe port=${API_PORT} result=${healthy ? 'occupied' : 'free'}`);
  }

  if (!healthy && !isDev) {
    const spawned = spawnBackend();
    if (!spawned.ok) {
      /* 后端起不来时给一个"大窗"报错页：这不是登录窗口，读起来需要空间。
       * 带「重试」：spawn 失败常见于杀软临时拦截 / 包被拷到只读目录，
       * 换个条件再点一次就可能成功，没必要强制重启程序。 */
      showErrorPage(spawned.reason, { reason: 'backend-down' });
      return;
    }
    healthy = await attachBackend(1, 15000);
  }

  /* 启动即创建主窗口（纯本地工具，无登录门禁）。 */
  createMainWindow();
  console.log(`[DevWork] mainPid=${process.pid} · dev=${isDev} · window=main ${MAIN_SIZE.width}x${MAIN_SIZE.height} frameless`);
  if (!healthy) {
    /* A-P1-10：超时不再是一次性死页面。
     * 首启要建库、建种子、跑索引（全是同步 IO），慢机器上 15s 确实不够；
     * 原来超时后即使后端 3 秒后就绪，窗口也永远停在错误页，只能重启程序。
     * 现在给「重试」，主进程收到后重新探活（后端其实已经在跑就直接进首屏）。 */
    showErrorPage(
      '15 秒内未探测到 127.0.0.1:3001/api/health。'
      + '首次启动要建库、建索引，机器较慢时可能超过 15 秒 —— 稍等一下点「重试」即可。'
      + '若本机正在运行 npm run dev，请先关闭：开发服务器会占用 3001，打包版的后端就起不来。',
      { reason: 'timeout' },
    );
  }

  /* 窗口起来之后再挂更新器：安装版才生效，portable 自动跳过。 */
  initAutoUpdater();
}

/**
 * 单实例锁 —— 与官方桌面端一致，必须在窗口、后端、数据目录之前拿到。
 *
 * 为什么必要：这个应用常驻托盘、后台可能正在跑 Agent 任务，用户很容易再点一次图标。
 * 没有锁就会出现第二个壳去抢 3001、抢同一份 SQLite、抢同一枚 shell-token。
 * 抢不到锁的实例只把焦点请求交给第一个实例，然后自己退出。
 */
process.on('uncaughtException', (error) => {
  console.error('[DevWork] 未捕获异常：', error);
});

if (!app.requestSingleInstanceLock()) {
  console.log('[DevWork] 已有实例在运行（单实例锁未获取），本实例退出');
  app.quit();
} else {
  app.on('before-quit', () => {
    console.log('[DevWork] before-quit');
  });

  app.on('second-instance', () => {
    /* 第二个实例被拉起：聚焦已有窗口（不在就重建），不碰后端与数据目录。 */
    if (app.isReady()) focusAnyWindow();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[DevWork] 启动异常：', error);
  });
}

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shutdown();
});

app.on('window-all-closed', () => {
  if (!shuttingDown) shutdown();
});
