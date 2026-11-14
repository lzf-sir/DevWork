#!/usr/bin/env node
/**
 * 准备内置运行时（prepare:runtime）。
 *
 * 从打包主流程里独立出来，对齐 DeepSeek Harness 桌面端的脚本分层：
 * 运行时准备是幂等的一步，可以单独跑、单独排查，不必每次都走完整打包。
 *
 * 用法：node scripts/prepare-runtime.mjs
 *      node scripts/prepare-runtime.mjs --force   忽略缓存，全量重建（依赖换过/怀疑缓存脏了时用）
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, ok, preflight, title } from './lib/common.mjs';
import { stageRuntime } from './lib/stage-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const force = new Set(process.argv.slice(2)).has('--force');

title('准备内置运行时');

try {
  preflight(ROOT, { requireNode: 22, autoInstall: false });
  const { stageDir, cached } = stageRuntime(ROOT, { force });
  ok(`运行时已暂存 → ${path.relative(ROOT, stageDir)}${cached ? '（缓存）' : ''}`);
  log('  下一步：npm run smoke（用这份运行时验证真实启动页）');
} catch (error) {
  log(`  ${error.message}`);
  process.exitCode = 1;
}
