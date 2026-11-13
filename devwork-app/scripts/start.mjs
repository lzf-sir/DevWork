#!/usr/bin/env node
/**
 * 一键启动 DevWork。
 *
 * 用法：
 *   node scripts/start.mjs            开发态（vite + 后端 + 桌面窗口）
 *   node scripts/start.mjs --prod     生产态（用已构建的 dist，跑 electron .）
 *   node scripts/start.mjs --check    只做环境自检，不启动
 *
 * 为什么要有这个脚本：`npm run dev` 需要人自己确认 Node 版本、装依赖、
 * 看端口有没有被占；一键脚本把这些前置条件都变成"有话直说"，
 * 失败时给出能照做的下一步，而不是甩一屏堆栈。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  fail, log, npmBin, ok, preflight, probeHttp, run, spawnForeground, step, title, warn,
} from './lib/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 3001;
const VITE_PORT = 5173;
const API_HEALTH = `http://127.0.0.1:${API_PORT}/api/health`;
const VITE_ROOT = `http://127.0.0.1:${VITE_PORT}/`;

const args = new Set(process.argv.slice(2));
const onlyCheck = args.has('--check');
const prodMode = args.has('--prod');

title('DevWork 启动自检');

/* ① 环境门禁：Node 版本（node:sqlite 硬门槛）+ 依赖是否齐 */
preflight(ROOT, { requireNode: 22 });

/* ② 后端环境门禁：node:sqlite / WAL / 只读连接 —— 这是项目自己的 verify-env */
step('检查后端运行环境…');
const envCheck = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-env.mjs')], {
  cwd: ROOT,
  stdio: 'inherit',
});
if (envCheck.status !== 0) {
  fail('后端运行环境不达标（详见上方输出）');
  process.exit(1);
}
ok('后端运行环境达标');

/* ③ --check：只体检不启动 */
if (onlyCheck) {
  const apiUp = await probeHttp(API_HEALTH);
  const viteUp = await probeHttp(VITE_ROOT);
  title('体检结论');
  log(`  Node        ${process.versions.node}`);
  log(`  依赖        ${fs.existsSync(path.join(ROOT, 'node_modules')) ? '已安装' : '未安装'}`);
  log(`  后端 3001   ${apiUp ? '正在运行' : '空闲'}`);
  log(`  前端 5173   ${viteUp ? '正在运行' : '空闲'}`);
  log(`  构建产物    ${fs.existsSync(path.join(ROOT, 'dist', 'index.html')) ? '已存在' : '未构建'}`);
  log('');
  ok('环境检查完成，可以启动。');
  process.exit(0);
}

/* ④ 端口状态：开发态两个端口都要空；生产态只需要 3001 空着 */
const apiUp = await probeHttp(API_HEALTH);
const viteUp = await probeHttp(VITE_ROOT);

if (prodMode) {
  await startProd({ apiUp });
} else {
  await startDev({ apiUp, viteUp });
}

/* ---------------- 开发态 ---------------- */
async function startDev({ apiUp: api, viteUp: vite }) {
  if (api && vite) {
    ok('检测到 DevWork 开发服务已在运行，直接打开桌面窗口');
    warn('如果窗口里显示异常，请先关掉已运行的实例再重新执行本脚本。');
    run(npmBin(), ['exec', '--', 'electron', '.'], { cwd: ROOT });
    return;
  }
  if (api !== vite) {
    fail('端口只被占用了一半：'
      + `3001(${api ? '占用' : '空闲'}) / 5173(${vite ? '占用' : '空闲'})`);
    log('  多半是上次没退干净的残留进程。占用情况：');
    log(`    API : ${API_HEALTH}`);
    log(`    VITE: ${VITE_ROOT}`);
    log('  处理办法：关掉残留的 DevWork / vite 进程后重试；');
    log('  或先执行「npm run dev」让两个服务一起起来，再运行本脚本复用它们。');
    process.exit(1);
  }

  step('启动开发服务（后端 3001 + 前端 5173 + 桌面窗口）…');
  log('  首次启动会编译前端，稍等十几秒；Ctrl+C 一次即可全部停止。');
  log('');
  spawnForeground(npmBin(), ['run', 'dev'], { cwd: ROOT });
}

/* ---------------- 生产态 ---------------- */
async function startProd({ apiUp }) {
  const dist = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(dist)) {
    step('尚未构建前端，正在执行 npm run build…');
    run(npmBin(), ['run', 'build'], { cwd: ROOT });
    ok('前端构建完成');
  } else {
    ok('已存在构建产物 dist/');
  }
  if (apiUp) {
    ok('检测到 3001 端口已有服务在跑，复用它（不重复起后端）');
  } else {
    log('  桌面端会自动拉起后端子进程（需要系统 Node 22）。');
  }
  step('启动桌面端…');
  run(npmBin(), ['exec', '--', 'electron', '.'], { cwd: ROOT });
}
