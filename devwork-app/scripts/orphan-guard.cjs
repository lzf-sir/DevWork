/**
 * 孤儿守卫（orphan-guard）：包住一个常驻子进程，保证「父亡即收拾」。
 *
 * 为什么需要它：Windows 上父进程被硬杀（任务管理器、终端窗口被叉、崩溃）时，
 * 子进程不会陪葬，会活成孤儿继续占端口。信号链上每多一层，
 * 「父亲死了」的消息就多一个被截留的机会 —— 所以每个常驻进程都配一个守卫：
 *
 *   supervisor ──ipc── guard ──spawn── 真进程（tsx watch / vite / electron）
 *
 * 守卫只做三件事：
 *   ① supervisor 断线（disconnect）→ 收拾真进程再退出；
 *   ② 收到 guard:cleanup 消息 / SIGINT / SIGTERM → 同上（幂等）；
 *   ③ 真进程自己退出 → 原样透传退出码，让 supervisor 联动拆掉整棵 dev 树。
 *
 * 收拾的顺序有讲究：先杀直接子进程（tsx watch 死了，它 spawn 的真服务会因
 * IPC disconnect 走 WAL checkpoint 优雅自毁 —— server/src/index.ts 里的
 * disconnect handler）；随后 taskkill /T /F 兜底，防止子进程杀不掉时连树带走。
 *
 * 用法：node orphan-guard.cjs -- <command> [args...]
 */
'use strict';

const { spawn, execFileSync } = require('node:child_process');

const sep = process.argv.indexOf('--');
if (sep === -1 || sep === process.argv.length - 1) {
  console.error('[guard] 用法: node orphan-guard.cjs -- <command> [args...]');
  process.exit(2);
}
const [cmd, ...args] = process.argv.slice(sep + 1);

const child = spawn(cmd, args, {
  stdio: 'inherit', // 输出直通 guard 的 stdio（supervisor 负责打标签）
  windowsHide: false,
});

let cleaning = false;
function cleanupAndExit() {
  if (cleaning) return;
  cleaning = true;
  const pid = child.pid;
  /* 树杀兜底：子进程若没死透或拖着孙进程（esbuild 服务等），一并带走。
   * 子进程已死时这行是无害的空操作。 */
  const sweep = () => {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    } catch { /* 进程已不在，或非 Windows 环境 */ }
    if (process.platform !== 'win32') {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已死 */ }
    }
    process.exit(0);
  };
  if (child.exitCode !== null) {
    sweep();
    return;
  }
  try { child.kill('SIGKILL'); } catch { /* 已死 */ }
  /* 给「真服务经 disconnect 优雅自毁」留一个短窗口（server/src/index.ts 的
   * disconnect handler 做 WAL checkpoint），超时才树杀强收。 */
  const timer = setTimeout(sweep, 1500);
  child.once('exit', () => {
    clearTimeout(timer);
    sweep();
  });
}

/* ① supervisor 横死 → IPC 断线 → 自己收尾（这就是把 IPC 布满全链路的原因）。 */
process.on('disconnect', cleanupAndExit);
/* ② supervisor 的优雅拆栈指令 / 终端 Ctrl+C（Windows 控制台信号会广播到同组进程）。 */
process.on('message', (message) => {
  if (message && typeof message === 'object' && message.type === 'guard:cleanup') cleanupAndExit();
});
process.on('SIGINT', cleanupAndExit);
process.on('SIGTERM', cleanupAndExit);
/* ③ 真进程自己退出 → 透传退出码，supervisor 据此联动拆栈（concurrently -k 语义）。 */
child.on('exit', (code, signal) => {
  if (cleaning) return;
  process.exit(code ?? (signal ? 0 : 1));
});
child.on('error', (error) => {
  console.error(`[guard] 无法启动 ${cmd}: ${error.message}`);
  process.exit(1);
});
