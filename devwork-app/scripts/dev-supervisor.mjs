#!/usr/bin/env node
/**
 * 开发态一键编排（替代 concurrently）：supervisor + orphan-guard 三层看护。
 *
 * 为什么不用 concurrently：关掉终端窗口（尤其是 Git Bash/mintty）时，
 * concurrently 连同它的子进程整条链会变成孤儿，vite/tsx watch 抱着 5173/3001
 * 不放，下次启动撞端口。这里把进程树拍扁成两层，每层都有「父亡即拆」的通路：
 *
 *   terminal → supervisor ──ipc── guard ── 真进程（tsx watch / vite / electron）
 *                   │                  └─ tsx watch 的真服务另有 disconnect 自清理
 *                   ├─ 任一 guard 退出 → 全拆（concurrently -k 语义：退出 Electron
 *                   │  或某服务崩了，整个 dev 树一起停，端口全放）
 *                   ├─ Ctrl+C / SIGTERM → 优雅全拆
 *                   └─ 轮询发现父进程（npm/bash）已死 → 全拆（终端被叉的场景）
 *
 * 用法：
 *   node scripts/dev-supervisor.mjs                 完整 dev（server + vite + electron）
 *   node scripts/dev-supervisor.mjs --skip-electron 只起两个服务（测试/无头环境）
 *
 * 端口沿用 dev 惯例：后端 3001、vite 5173；
 * 测试可用 DEVWORK_PORT / DEVWORK_VITE_PORT 覆盖（后端本身也认 DEVWORK_PORT）。
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  fail, log, ok, preflight, probeHttp, step, title, warn, waitForHttp,
} from './lib/common.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPTS_DIR, '..');
const GUARD = path.join(SCRIPTS_DIR, 'orphan-guard.cjs');

const API_PORT = Number(process.env.DEVWORK_PORT ?? 3001);
const VITE_PORT = Number(process.env.DEVWORK_VITE_PORT ?? 5173);
const API_HEALTH = `http://127.0.0.1:${API_PORT}/api/health`;
const VITE_ROOT = `http://127.0.0.1:${VITE_PORT}/`;

const skipElectron = process.argv.includes('--skip-electron');

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);

/** 给子进程输出打彩色标签（对应老 concurrently 的 -c cyan,green,magenta）。 */
function attachLabel(stream, label, color) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) log(`${paint(color, label)} ${line}`);
  });
  stream.on('end', () => {
    if (buffer) log(`${paint(color, label)} ${buffer}`);
  });
}

/** 单进程树杀（兜底用；guard 自己还有一层收拾）。 */
function forceKillTree(pid) {
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
  } catch { /* 已退出或非 Windows */ }
}

title('DevWork 开发态（supervisor 看护模式）');
preflight(ROOT);

/* 端口门禁：占着就明说，不让「重复启动 → vite 挤去 5175」的剧本再演一遍。 */
const apiUp = await probeHttp(API_HEALTH);
const viteUp = await probeHttp(VITE_ROOT);
if (apiUp || viteUp) {
  fail(`端口已被占用：3001(${apiUp ? '占用' : '空闲'}) / 5173(${viteUp ? '占用' : '空闲'})`);
  log('  多半是上次没退干净的残留进程，或另一份 dev 在跑。');
  log('  netstat -ano | findstr "3001 5173" 查占用，taskkill /PID <pid> /T /F 清理后重试。');
  process.exit(1);
}

/* ---------------- 装配 dev 树 ---------------- */
const guards = [];

function spawnGuard(name, color, command, args, env = {}) {
  const proc = spawn(process.execPath, [GUARD, '--', command, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], // ipc = guard 的保命线（disconnect 自清理）
  });
  attachLabel(proc.stdout, name, color);
  attachLabel(proc.stderr, name, color);
  const guard = { name, proc };
  proc.on('exit', (code) => {
    log(`${paint(color, name)} 已退出（code=${code}）`);
    if (!stopping) shutdownAll(`因 ${name} 退出，联动停止整棵 dev 树`, code ?? 0);
  });
  guards.push(guard);
  return guard;
}

const tsx = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const electronBin = path.join(
  ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
);

step('启动后端（tsx watch server/src/index.ts）…');
spawnGuard('[server]', '36', process.execPath, [tsx, 'watch', 'server/src/index.ts'], { DEVWORK_PORT: String(API_PORT) });

step('启动前端（vite）…');
spawnGuard('[vite]', '32', process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(VITE_PORT)]);

step(`等待服务就绪（3001→${API_PORT} / 5173→${VITE_PORT}）…`);
const [serverReady, viteReady] = await Promise.all([
  waitForHttp(API_HEALTH, 60000),
  waitForHttp(VITE_ROOT, 60000),
]);
if (!serverReady || !viteReady) {
  shutdownAll(`服务未就绪（server=${serverReady} vite=${viteReady}）`, 1);
  await new Promise((resolve) => { setTimeout(resolve, 4000); });
  process.exit(1);
}
ok(`服务已就绪 · API ${API_HEALTH} · VITE ${VITE_ROOT}`);

if (!skipElectron) {
  if (!fs.existsSync(electronBin)) {
    warn('未找到 electron 可执行文件，跳过桌面窗口（服务继续跑）');
  } else {
    step('启动桌面窗口…');
    spawnGuard('[electron]', '35', electronBin, ['.']);
  }
} else {
  log('  （--skip-electron：不启动桌面窗口）');
}
log('');
log('  Ctrl+C 一次即可全部停止；关掉终端窗口也会自动清场。');

/* ---------------- 全拆 ---------------- */
let stopping = false;
function shutdownAll(reason, code = 0) {
  if (stopping) return;
  stopping = true;
  warn(`\n${reason} → 正在停止全部 dev 进程…`);
  for (const guard of guards) {
    if (guard.proc.exitCode === null) {
      try { guard.proc.send({ type: 'guard:cleanup' }); } catch { /* 通道已断 */ }
    }
  }
  const deadline = Date.now() + 3500;
  const timer = setInterval(() => {
    const alive = guards.filter((guard) => guard.proc.exitCode === null);
    if (alive.length === 0 || Date.now() > deadline) {
      clearInterval(timer);
      for (const guard of alive) {
        warn(`  ${guard.name} 未在时限内退出，树杀兜底`);
        forceKillTree(guard.proc.pid);
      }
      setTimeout(() => {
        ok('dev 树已停止，端口已释放。');
        process.exit(code);
      }, 200);
    }
  }, 100);
}

/* Ctrl+C / kill 信号 → 优雅全拆。 */
process.on('SIGINT', () => shutdownAll('收到 Ctrl+C', 0));
process.on('SIGTERM', () => shutdownAll('收到终止信号', 0));
process.on('SIGHUP', () => shutdownAll('终端已挂断', 0));

/* 父亡看门狗：npm/bash 被叉掉时 supervisor 自己还活着，靠轮询发现并全拆。
 * （Windows 上进程被硬杀时子进程不陪葬，这是 Git Bash 关窗场景的关键兜底。） */
const parentPid = process.ppid;
setInterval(() => {
  if (stopping) return;
  try {
    process.kill(parentPid, 0);
  } catch {
    shutdownAll('父进程已退出（终端窗口已关闭）', 0);
  }
}, 2000).unref();

/* 最后一道：无论以何种方式退出，都尝试树杀还没走的 guard。 */
process.on('exit', () => {
  for (const guard of guards) {
    if (guard.proc.exitCode === null) forceKillTree(guard.proc.pid);
  }
});
