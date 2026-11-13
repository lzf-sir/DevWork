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
const IS_PACKAGED = process.defaultApp !== true;
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
  /* portable 模式下这个变量指向 exe 真实所在目录；非 portable（目录态）用 exe 自身目录。 */
  const baseDir = portableDir && fs.existsSync(portableDir)
    ? portableDir
    : path.dirname(process.execPath);
  const preferred = path.join(baseDir, 'DevWorkData');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    /* 真正写一个探针文件：mkdir 成功不代表有写权限（Program Files 会失败在写文件上）。 */
    const probe = path.join(preferred, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return preferred;
  } catch {
    const fallback = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || baseDir, 'DevWork');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
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

let mainWindow = null;
let backendChild = null;
let shuttingDown = false;
let isDev = false;
let tray = null;
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
  tray.setToolTip('DevWork · 已最小化到托盘，后台任务继续运行');
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
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  /* 打包态：数据目录必须落在程序目录之外（portable 运行期在临时目录，退出即删）。
   * 开发态保持默认（<repo>/server/data），不干扰本地开发与测试。 */
  if (IS_PACKAGED) {
    const dataDir = resolveUserDataDir();
    env.DEVWORK_DATA_DIR = path.join(dataDir, 'data');
    env.DEVWORK_SANDBOX_DIR = path.join(dataDir, 'sandbox');
    console.log(`[DevWork] 用户数据目录：${dataDir}`);
  }
  /* 打包态不播种演示数据：库里只有真实接入的资源，没有预置的假资产/假会话。 */
  if (IS_PACKAGED) env.DEVWORK_CLEAN = '1';
  /* 桌面壳握手令牌：让后端启用浏览器直连门禁（非开发模式才设）。 */
  if (shellToken) env.DEVWORK_SHELL_TOKEN = shellToken;
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
  backendChild.stdout.on('data', (chunk) => {
    process.stdout.write(`[backend] ${chunk.toString('utf8')}`);
  });  backendChild.stderr.on('data', (chunk) => {
    process.stderr.write(`[backend] ${chunk.toString('utf8')}`);
  });
  backendChild.on('exit', (code) => {
    console.log(`[DevWork] 后端进程退出 code=${code}`);
    backendChild = null;
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
  killBackend(() => app.exit(0));
}

function errorPage(message) {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DevWork 启动失败</title>',
    '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#FAFAF9;color:#232320;',
    'display:grid;place-items:center;height:100vh;margin:0}h2{font-weight:500}p{color:#6B6B66;',
    'font-size:13px;line-height:1.8;max-width:520px}</style></head><body><div>',
    '<h2>后端服务未就绪</h2><p>',
    String(message).replace(/[<>&]/g, ''),
    '</p><p>本程序已内置 Node 运行时，正常情况下无需任何额外环境。',
    '若仍无法启动，请查看日志目录中的后端输出，或在开发态执行 <code>npm run dev</code> 查看完整日志。</p>',
    '</div></body></html>',
  ].join('');
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
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('win:maximize-changed', true);
  });
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('win:maximize-changed', false);
  });
  /* g3：拦截关闭 → 现查设置决定「最小化到托盘」还是「退出应用」。 */
  win.on('close', (event) => {
    if (shuttingDown || forceClose) return;
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
  ipcMain.handle('app:versions', () => ({
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  }));
  ipcMain.handle('app:api-base', () => '/api');
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

async function bootstrap() {
  registerIpc();
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]));
  } else {
    Menu.setApplicationMenu(null);
  }

  isDev = await probe(VITE_PORT, '/');

  let healthy = await probe(API_PORT, '/api/health');

  /* 非开发模式：认领桌面壳令牌，网络层自动给 3001 请求注入 X-DevWork-Token。
   * 渲染进程 fetch 走 session 网络栈，用户无感；开发模式不做门禁也无需令牌。 */
  if (!isDev) {
    shellToken = ensureShellToken();
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      if (shellToken && details.url.startsWith(`http://127.0.0.1:${API_PORT}`)) {
        details.requestHeaders['X-DevWork-Token'] = shellToken;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
  }

  if (!healthy && !isDev) {
    const spawned = spawnBackend();
    if (!spawned.ok) {
      /* 后端起不来时给一个"大窗"报错页：这不是登录窗口，读起来需要空间。 */
      const win = createMainWindow({ skipLoad: true });
      void win.webContents.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(errorPage(spawned.reason))}`,
      );
      return;
    }
    healthy = await waitForBackend(15000);
  }

  /* 启动即创建主窗口（纯本地工具，无登录门禁）。 */
  createMainWindow();
  console.log(`[DevWork] mainPid=${process.pid} · dev=${isDev} · window=main ${MAIN_SIZE.width}x${MAIN_SIZE.height} frameless`);
  if (!healthy) {
    void mainWindow.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(errorPage('15 秒内未探测到 127.0.0.1:3001/api/health。'))}`,
    );
  }
}

app.whenReady().then(bootstrap).catch((error) => {
  console.error('[DevWork] 启动异常：', error);
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shutdown();
});

app.on('window-all-closed', () => {
  if (!shuttingDown) shutdown();
});
