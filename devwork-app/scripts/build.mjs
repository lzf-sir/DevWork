#!/usr/bin/env node
/**
 * 构建入口：前后端 typecheck **并行**，再串行 vite build。
 *
 * 为什么不用 `tsc && tsc && vite build`：两个 tsc 互不依赖，串行纯属浪费
 * （各自约 8–12 秒，并行后只付最慢那个的时间）。
 *
 * 直接调 node_modules 里的 tsc / vite 入口，不经过 .cmd 外壳：
 * Windows 上 spawn .cmd 需要 shell、多一层进程，还容易被路径里的空格坑。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`退出码 ${code}`))));
});

const started = Date.now();

try {
  await Promise.all([
    run([tsc, '--noEmit', '-p', 'tsconfig.json']),
    run([tsc, '--noEmit', '-p', 'backend/tsconfig.json']),
  ]);
  const typecheckMs = Date.now() - started;
  console.log(`typecheck 并行完成 · ${(typecheckMs / 1000).toFixed(1)}s`);

  await run([vite, 'build']);
  console.log(`构建完成 · 总计 ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (error) {
  console.error(`构建失败：${error.message}`);
  process.exit(1);
}
