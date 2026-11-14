#!/usr/bin/env node
/**
 * 打包产物冒烟（smoke）—— 对齐官方桌面端的 `npm run smoke`。
 *
 * 为什么值得单独做：electron-builder 只保证「包能拼出来」，不保证「装上去能跑」。
 * 这里用**包内自带的 Node 运行时**，以与 desktop/main.cjs 完全一致的命令
 * 拉起 resources/server 里的后端，再访问真实启动页。
 * 「内置 Node 版本不对」「tsx 没带上」「dist 没进包」「node:sqlite 缺失」
 * 这几类问题都会在这里当场暴露，而不是等用户双击之后。
 *
 * 为什么必须在**仓库外**的临时目录里启动（A-P0-01 的根因）：
 * 依赖解析是「从入口文件所在目录逐级向上找 node_modules」。原来直接从
 * `build/pkg` 启动，而它在仓库内 —— Node 一路向上会命中 `devwork-app/node_modules`，
 * 于是「资源区漏暂存 zod」这种致命缺陷照样跑得通，六步全过、装到用户机器上必崩。
 * 现在把 server/ shared/ dist/ 复制到 `os.tmpdir()` 下**模拟 resources/ 布局**再从那里启动，
 * 上层没有任何 node_modules，缺包当场 `ERR_MODULE_NOT_FOUND`。
 *
 * 用法：node scripts/smoke-package.mjs
 *      SMOKE_PORT=3021 可改端口（默认 3021，避开开发用的 3001）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyDir, fail, log, ok, removeDir, step, title, waitForHttp, warn } from './lib/common.mjs';
import { RUNTIME_MODULES, SHARED_RUNTIME_MODULES, STAGE_SUBDIR } from './lib/stage-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, STAGE_SUBDIR);
/**
 * 临时「产物目录」：模拟 resources/ 下的四件套。
 *
 *   <tmp>/devwork-smoke-pkg-<ts>/
 *   ├── pkg/server/        后端源码 + node_modules
 *   ├── pkg/shared/        契约层（server/src/routes → ../../../shared）+ package.json{type:module}
 *   ├── pkg/node_modules/  shared 的运行期依赖（zod）：解析链看不到 server/node_modules
 *   └── pkg/dist/          前端构建产物（后端同源托管）
 *
 * 这四件少任何一件，都会重现「仓库内启动正常、装到外面就崩」的一类缺陷：
 * 缺 shared/package.json → contracts 被当 CommonJS（具名导出探测不到）；
 * 缺 pkg/node_modules → shared/contracts 解析不到 zod。
 *
 * 后端把 `server/src` 的上两级当作 ROOT 去找 dist（backend/src/config.ts 的 DIST_DIR），
 * 所以 dist 必须与 server 同级 —— 这正是打包态 resources/ 的真实布局。
 */
const RUN_DIR = path.join(os.tmpdir(), `devwork-smoke-pkg-${Date.now()}`);
const PKG = path.join(RUN_DIR, 'pkg');
/**
 * **两个目录必须分开**（这里曾经只用一个 `SERVER`，导致「源 = 目标」自拷贝）：
 *   STAGED_SERVER —— 仓库内的暂存区 `build/pkg/server`，是**复制源**，
 *                    前置的存在性检查也只看它（仓库外副本此刻还不存在）。
 *   SERVER        —— 仓库外的副本 `os.tmpdir()/…/pkg/server`，是**启动目录**，
 *                    后端与 tsx 加载器都从这里拉起，上层没有任何 node_modules。
 * 混用的后果很隐蔽：检查会去查一个还没创建的空目录（报「缺少」），
 * 而 copyDir 变成「自己拷自己」（什么都不做）—— 两种情况都不是产物有问题。
 */
const STAGED_SERVER = path.join(STAGE, 'server');
const SERVER = path.join(PKG, 'server');

/* 内置 node.exe **原地使用**：二进制的所在路径不参与模块解析（解析只看被加载的
 * 脚本路径），复制 83MB 的 node.exe 对"能不能解析到 zod"毫无影响，只会让冒烟变慢。 */
const NODE_BIN = path.join(STAGE, 'runtime', 'node.exe');
const PORT = Number(process.env.SMOKE_PORT ?? 3021);
const BASE = `http://127.0.0.1:${PORT}`;

title('打包产物冒烟');

const stagedEntry = path.join(STAGED_SERVER, 'src', 'index.ts');
const stagedPreflight = path.join(STAGED_SERVER, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
const stagedLoader = path.join(STAGED_SERVER, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const stagedShared = path.join(STAGE, 'shared');
const stagedSharedPkg = path.join(stagedShared, 'package.json');
const stagedRootModules = path.join(STAGE, 'node_modules');
const indexHtml = path.join(ROOT, 'dist', 'index.html');

const missing = [
  [NODE_BIN, '内置 Node 运行时（先跑 npm run prepare:runtime）'],
  [stagedEntry, '服务端入口（先跑 npm run prepare:runtime）'],
  [stagedPreflight, 'tsx preflight（先跑 npm run prepare:runtime）'],
  [stagedLoader, 'tsx loader（先跑 npm run prepare:runtime）'],
  [stagedShared, '共享契约层（先跑 npm run prepare:runtime）'],
  [stagedSharedPkg, '契约层的 ESM 声明 shared/package.json（先跑 npm run prepare:runtime）'],
  [indexHtml, '前端构建产物（先跑 npm run build）'],
].filter(([file]) => !fs.existsSync(file));

if (missing.length > 0) {
  for (const [file, hint] of missing) fail(`缺少 ${path.relative(ROOT, file)} —— ${hint}`);
  process.exit(1);
}

/* 后端会 import 的运行时包：漏一个就不是"能不能起来"的问题，而是一定起不来。
 * 在这里逐个点名，比让用户双击 exe 之后看空壳页面强得多。 */
const absentModules = RUNTIME_MODULES.filter(
  (name) => !fs.existsSync(path.join(STAGED_SERVER, 'node_modules', name, 'package.json')),
);
if (absentModules.length > 0) {
  fail(`暂存区缺少后端运行时依赖：${absentModules.join(' / ')}`);
  log(`  后端运行时依赖：${RUNTIME_MODULES.join(' / ')}`);
  log('  处理办法：node scripts/prepare-runtime.mjs --force 后重试。');
  process.exit(1);
}
/* shared 的解析链依赖（zod）必须落在**暂存区根**：ESM 裸包解析从
 * shared/contracts 向上找 node_modules，看不到 server/node_modules。 */
const absentSharedModules = SHARED_RUNTIME_MODULES.filter(
  (name) => !fs.existsSync(path.join(stagedRootModules, name, 'package.json')),
);
if (absentSharedModules.length > 0) {
  fail(`暂存区缺少 shared 运行期依赖：${absentSharedModules.join(' / ')}（应在 ${path.relative(ROOT, stagedRootModules)}）`);
  log(`  shared 运行期依赖：${SHARED_RUNTIME_MODULES.join(' / ')}；server/node_modules 不在它的解析链上。`);
  log('  处理办法：node scripts/prepare-runtime.mjs --force 后重试。');
  process.exit(1);
}
ok(`产物文件齐备（node.exe / server / shared+type:module / node_modules(${SHARED_RUNTIME_MODULES.join(',')}) / dist / ${RUNTIME_MODULES.join(' / ')}）`);

const dataDir = path.join(RUN_DIR, 'data');
const sandboxDir = path.join(RUN_DIR, 'sandbox');

step(`把产物复制到仓库外临时目录（${RUN_DIR}）…`);
/* 复制「后端运行需要的四件」：server（源码+依赖）、shared（契约层+ESM 声明）、
 * 根 node_modules（shared 的 zod 解析链）、dist（前端产物）—— 与 resources/ 的真实布局一一对应。
 * 不带 runtime/node.exe：上面已说明原地使用即可，且它的大小会让每次冒烟多花十几秒。 */
fs.mkdirSync(RUN_DIR, { recursive: true });
copyDir(STAGED_SERVER, SERVER);
copyDir(stagedShared, path.join(PKG, 'shared'));
copyDir(stagedRootModules, path.join(PKG, 'node_modules'));
copyDir(path.join(ROOT, 'dist'), path.join(PKG, 'dist'));
ok('已复制到仓库外（依赖解析不再依赖 devwork-app/node_modules）');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(sandboxDir, { recursive: true });

const entry = path.join(SERVER, 'src', 'index.ts');
const preflight = path.join(SERVER, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
const loader = path.join(SERVER, 'node_modules', 'tsx', 'dist', 'loader.mjs');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
/* NODE_PATH 是"全局兜底解析"的后门：万一它指向仓库 node_modules，
 * 缺包的产物又能跑起来 —— 冒烟就白做了。 */
delete env.NODE_PATH;
Object.assign(env, {
  DEVWORK_PORT: String(PORT),
  DEVWORK_DATA_DIR: dataDir,
  DEVWORK_SANDBOX_DIR: sandboxDir,
  /* 与打包态一致：不播种演示数据，验的是真实空库启动。 */
  DEVWORK_CLEAN: '1',
  /* 空令牌 = 不开壳门禁，smoke 直接用 HTTP 探活。 */
  DEVWORK_SHELL_TOKEN: '',
});

/* 这一行是**唯一能证明"绿是在没有祖先兜底的环境下拿到的"**证据。
 * preflight 与 smoke 都会打绿，但只有把启动目录的绝对路径 + "祖先无 package.json / node_modules"
 * 印出来，事后才能分清是"仓库外跑过"还是"又在仓库内跑过" ——
 * v1.0 的两次 P0（zod 漏包、shared 丢 ESM 上下文）正是这样漏检的：
 * 仓库内的 devwork-app/package.json 与 node_modules 会给产物兜底。 */
step(`从仓库外启动：${SERVER}`);
log('     （该目录祖先无 package.json、无 node_modules —— 解析不到就一定会报错）');
step(`用内置 Node 拉起后端（端口 ${PORT}，工作目录在临时产物内）…`);
const child = spawn(NODE_BIN, ['--require', preflight, '--import', pathToFileURL(loader).href, entry], {
  cwd: SERVER,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});

const output = [];
const collect = (chunk) => {
  const text = chunk.toString('utf8');
  output.push(text);
  if (output.join('').length > 24000) output.shift();
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

let exitInfo = null;
child.on('exit', (code, signal) => { exitInfo = { code, signal }; });

function killTree() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

function dumpTail(lines = 40) {
  const text = output.join('');
  log('');
  log(`── 后端输出（末 ${lines} 行）─────────────────────────`);
  log(text.split(/\r?\n/).slice(-lines).join('\n'));
}

/** 从后端输出里挑出「缺包」那一行，直接点名，省掉人工在堆栈里找。 */
function missingModuleHint() {
  const hit = output.join('').match(/Cannot find (?:package|module) '([^']+)'/);
  return hit ? hit[1] : '';
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`HTTP ${response.status} · ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function main() {
  const healthy = await waitForHttp(`${BASE}/api/health`, 60000, 500);
  if (!healthy) {
    fail('60 秒内未探测到 /api/health —— 后端没能起来。');
    const module = missingModuleHint();
    if (module) {
      fail(`后端进程找不到包 "${module}"：产物 resources/server/node_modules 里没有它。`);
      log(`  后端运行时依赖：${RUNTIME_MODULES.join(' / ')}`);
      log('  处理办法：node scripts/prepare-runtime.mjs --force 后重新打包；');
      log('  并把该包补进 scripts/lib/stage-runtime.mjs 的 RUNTIME_MODULES。');
    }
    dumpTail();
    return false;
  }
  ok('后端健康检查通过（/api/health）');

  /* /api/health 是**纯函数端点**：不查库、不过 zod 校验链，缺包时它依然可能 200。
   * 真正会把 shared/contracts 加载进来的是 /api/bootstrap（要读 workspace / 侧栏 / 面板），
   * 所以拿它当「依赖真的齐备」的判据。 */
  try {
    const bootstrap = await getJson(`${BASE}/api/bootstrap`);
    const data = (bootstrap && bootstrap.data) || {};
    if (!data.workspaceId) {
      fail('/api/bootstrap 返回里没有 workspaceId —— 首屏装配链路不完整。');
      dumpTail();
      return false;
    }
    ok(`首屏装配链路可用（/api/bootstrap · workspace=${data.workspaceId} · apiMode=${data.apiMode}）`);
  } catch (error) {
    fail(`/api/bootstrap 请求失败：${error.message}`);
    const module = missingModuleHint();
    if (module) fail(`后端进程找不到包 "${module}"：产物缺少后端运行时依赖。`);
    dumpTail();
    return false;
  }

  const response = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(8000) });
  const body = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status !== 200) {
    fail(`启动页返回 HTTP ${response.status}`);
    dumpTail();
    return false;
  }
  if (!/text\/html/i.test(contentType)) {
    fail(`启动页 Content-Type 不是 HTML：${contentType}`);
    dumpTail();
    return false;
  }
  if (!body.includes('<div id="root">')) {
    fail('启动页不是前端构建产物（找不到 <div id="root">）—— dist 可能没进包。');
    dumpTail();
    return false;
  }
  ok('真实启动页可访问（200 · text/html · React 挂载点存在）');
  return true;
}

let passed = false;
try {
  passed = await main();
} catch (error) {
  fail(`冒烟过程异常：${error.message}`);
  dumpTail();
} finally {
  killTree();
  await new Promise((resolve) => setTimeout(resolve, 800));
  /* 临时目录是自己造的，可以安全清理；真实用户数据、build/pkg 都不动。
   * 注意这里**不再**往 build/pkg 里复制 dist —— 那个目录不参与 electron-builder
   * （配置里是仓库根 dist/），留在那儿只会让暂存区看起来"内容更全"，掩盖真实布局。 */
  removeDir(RUN_DIR);
}

if (!passed) {
  if (exitInfo) log(`  后端退出信息：code=${exitInfo.code} signal=${exitInfo.signal}`);
  warn('冒烟未通过 —— 不要继续打包，先按上面的后端输出定位。');
  process.exit(1);
}
ok('冒烟通过（在仓库外目录启动，依赖解析未借助 devwork-app/node_modules）');
