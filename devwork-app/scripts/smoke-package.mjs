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
 * 用法：node scripts/smoke-package.mjs
 *      SMOKE_PORT=3021 可改端口（默认 3021，避开开发用的 3001）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyDir, fail, log, ok, removeDir, step, title, waitForHttp, warn } from './lib/common.mjs';
import { STAGE_SUBDIR } from './lib/stage-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, STAGE_SUBDIR);
const SERVER = path.join(STAGE, 'server');
const NODE_BIN = path.join(STAGE, 'runtime', 'node.exe');
const PORT = Number(process.env.SMOKE_PORT ?? 3021);
const BASE = `http://127.0.0.1:${PORT}`;
const RUN_DIR = path.join(ROOT, 'tmp', `smoke-pkg-${Date.now()}`);

title('打包产物冒烟');

const entry = path.join(SERVER, 'src', 'index.ts');
const preflight = path.join(SERVER, 'node_modules', 'tsx', 'dist', 'preflight.cjs');
const loader = path.join(SERVER, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const indexHtml = path.join(ROOT, 'dist', 'index.html');

const missing = [
  [NODE_BIN, '内置 Node 运行时（先跑 npm run prepare:runtime）'],
  [entry, '服务端入口（先跑 npm run prepare:runtime）'],
  [preflight, 'tsx preflight（先跑 npm run prepare:runtime）'],
  [loader, 'tsx loader（先跑 npm run prepare:runtime）'],
  [indexHtml, '前端构建产物（先跑 npm run build）'],
].filter(([file]) => !fs.existsSync(file));

if (missing.length > 0) {
  for (const [file, hint] of missing) fail(`缺少 ${path.relative(ROOT, file)} —— ${hint}`);
  process.exit(1);
}
ok('产物文件齐备（node.exe / server / tsx / dist）');

/* 后端按 config.ts 的 ROOT/dist 找静态资源：打包态是 resources/dist，
 * 暂存态对应 build/pkg/dist。少了这一步，后端会以 dist=dev-only 起来，
 * 前端页面 404 —— 那是「开发态能跑、装完打不开」的典型假通过。 */
const stagedDist = path.join(STAGE, 'dist');
copyDir(path.join(ROOT, 'dist'), stagedDist);

const dataDir = path.join(RUN_DIR, 'data');
const sandboxDir = path.join(RUN_DIR, 'sandbox');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(sandboxDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
Object.assign(env, {
  DEVWORK_PORT: String(PORT),
  DEVWORK_DATA_DIR: dataDir,
  DEVWORK_SANDBOX_DIR: sandboxDir,
  /* 与打包态一致：不播种演示数据，验的是真实空库启动。 */
  DEVWORK_CLEAN: '1',
  /* 空令牌 = 不开壳门禁，smoke 直接用 HTTP 探活。 */
  DEVWORK_SHELL_TOKEN: '',
});

step(`用内置 Node 拉起后端（端口 ${PORT}）…`);
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

async function main() {
  const healthy = await waitForHttp(`${BASE}/api/health`, 60000, 500);
  if (!healthy) {
    fail('60 秒内未探测到 /api/health —— 后端没能起来。');
    dumpTail();
    return false;
  }
  ok('后端健康检查通过（/api/health）');

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
  /* 临时数据目录是自己造的，可以安全清理；真实用户数据不碰。 */
  removeDir(RUN_DIR);
}

if (!passed) {
  warn('冒烟未通过 —— 不要继续打包，先按上面的后端输出定位。');
  process.exit(1);
}
ok('冒烟通过');
