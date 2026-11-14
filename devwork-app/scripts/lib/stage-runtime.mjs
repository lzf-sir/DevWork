/**
 * 内置运行时暂存（prepare:runtime 的核心）。
 *
 * 打包态的后端是**独立 Node 进程**（不是 Electron 内嵌），它读不了 asar 里的文件，
 * 所以运行时必须以真实目录形式落在 resources/server 与 resources/runtime 下。
 *
 * 产出：
 *   build/pkg/server            服务端源码 + 它在运行时真正需要的依赖
 *   build/pkg/runtime/node.exe  内置 Node 22（后端依赖 node:sqlite）
 *
 * 性能约定（打包速度的关键）：
 *   - 依赖闭包按 package-lock 指纹缓存，未变化时**跳过复制**（原来每次 72 个包全量拷）；
 *   - node.exe 落在 build/cache 里，之后用**同卷硬链接**接进产物（83MB 的复制降到毫秒级）；
 *   - 缓存命中时只刷新 backend/src 与 shared（改代码必须立即生效）。
 *   需要彻底重建时用 `node scripts/prepare-runtime.mjs --force`。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyDependencyClosure, copyDir, fail, listDirs, log, ok, removeDir } from './common.mjs';

/** 暂存目录（相对仓库根）。 */
export const STAGE_SUBDIR = path.join('build', 'pkg');
/** 缓存目录（跨次打包复用，不进产物）。 */
const CACHE_SUBDIR = path.join('build', 'cache');
/** 指纹格式变了就换版本号，旧缓存自动失效。 */
const STAMP_VERSION = 'v2';

/** 对大文件做内容指纹：package-lock 这种几百 KB 的文件秒级完成。 */
function hashFile(file) {
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'missing';
  }
}

/**
 * 暂存整个运行时。
 *
 * **不打进产物**：开发数据库（backend/.runtime）与沙箱仓库
 * —— 首次启动会自己播种重建，带上开发库等于把测试数据发给用户。
 *
 * @param {string} ROOT 仓库根
 * @param {{ force?: boolean }} options force=true 时忽略缓存全量重建
 * @returns {{ stageDir: string, serverDir: string, runtimeDir: string, cached: boolean }}
 */
export function stageRuntime(ROOT, { force = false } = {}) {
  const stageDir = path.join(ROOT, STAGE_SUBDIR);
  const serverDir = path.join(stageDir, 'server');
  const runtimeDir = path.join(stageDir, 'runtime');
  const stampFile = path.join(stageDir, '.stamp');

  /* 指纹只覆盖「影响依赖闭包与运行时」的输入：lockfile + Node 版本。
   * 源码不在指纹里 —— 源码变了由 refreshSources 增量刷新，不必重建依赖。 */
  const fingerprint = [
    STAMP_VERSION,
    hashFile(path.join(ROOT, 'package-lock.json')),
    process.versions.node,
  ].join(':');

  const cached = !force
    && fs.existsSync(stampFile)
    && fs.readFileSync(stampFile, 'utf8').trim() === fingerprint
    && fs.existsSync(path.join(serverDir, 'node_modules', 'tsx'))
    && fs.existsSync(path.join(serverDir, 'src', 'index.ts'))
    && fs.existsSync(path.join(runtimeDir, 'node.exe'));

  if (cached) {
    refreshSources(ROOT, stageDir, serverDir);
    ok('运行时命中缓存（依赖与 Node 未变，只刷新源码）');
    return { stageDir, serverDir, runtimeDir, cached: true };
  }

  removeDir(stageDir);
  fs.mkdirSync(serverDir, { recursive: true });

  refreshSources(ROOT, stageDir, serverDir);

  /* 运行时依赖：express / cors 是服务端直接 import 的；tsx+esbuild 用来跑 TS。 */
  const modulesDir = path.join(serverDir, 'node_modules');
  fs.mkdirSync(modulesDir, { recursive: true });
  const copied = copyDependencyClosure(['express', 'cors', 'tsx'], modulesDir, ROOT);

  /* esbuild 的本平台二进制是 optionalDependency，copyDependencyClosure 会带上；
   * 缺了它 tsx 起不来，所以这里显式核对一次。 */
  const esbuildBin = listDirs(path.join(modulesDir, '@esbuild'));
  if (esbuildBin.length === 0) {
    fail('暂存区缺少 @esbuild/*（esbuild 的本平台二进制）—— 打包出来的程序跑不了 TS 后端。');
    log('  处理办法：删掉 node_modules 后重新 npm install，再打包。');
    throw new Error('missing @esbuild platform binary');
  }
  log(`  依赖 ${copied.length} 个 · esbuild 平台包 ${esbuildBin.join(', ')}`);

  stageBundledNode(ROOT, runtimeDir);

  fs.writeFileSync(stampFile, fingerprint, 'utf8');
  return { stageDir, serverDir, runtimeDir, cached: false };
}

/**
 * 刷新源码（缓存命中时唯一需要重做的部分）。
 *
 * 服务端源码：src（含 schema.sql 等非 TS 资源）。
 * 契约层：后端 routes 以 `../../../shared/contracts` 引用**仓库根**的 shared/。
 * 暂存后 server/src/routes 往上三级是 <stage>/，所以 shared 必须落在 <stage>/shared，
 * 否则打包态后端一启动就 ERR_MODULE_NOT_FOUND（这个坑只有真起一次后端才看得见）。
 */
function refreshSources(ROOT, stageDir, serverDir) {
  const srcTarget = path.join(serverDir, 'src');
  const sharedTarget = path.join(stageDir, 'shared');

  removeDir(srcTarget);
  copyDir(path.join(ROOT, 'backend', 'src'), srcTarget);

  removeDir(sharedTarget);
  copyDir(path.join(ROOT, 'shared'), sharedTarget);

  /* 模块类型声明：服务端是 ESM，打包后这个目录没有上层 package.json 兜底。 */
  fs.writeFileSync(
    path.join(serverDir, 'package.json'),
    `${JSON.stringify({ name: 'devwork-server-runtime', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * 把当前构建用的 Node 22 放进产物，做成「自带运行时」。
 *
 * 为什么必须内置：后端依赖 node:sqlite（Node 22.5+ 才有），而 Electron 33
 * 自带的 Node 是 20.x，没有 node:sqlite —— 用它兜底只会得到一句
 * 用户看不懂的 "Cannot find module 'node:sqlite'"。
 *
 * 为什么走缓存 + 硬链接：node.exe 有 80+ MB，而构建用的 Node 通常在 C 盘、
 * 产物在 D 盘，跨卷无法硬链接。先把一份放到 build/cache，再从缓存硬链接进产物，
 * 就在同一卷内，第 2 次打包起是毫秒级，而不是每次重写 83 MB。
 */
function stageBundledNode(ROOT, runtimeDir) {
  if (process.platform !== 'win32') {
    throw new Error(
      `内置运行时目前只支持 Windows 打包（当前平台 ${process.platform}）；`
      + 'electron-builder.yml 的 extraResources 与壳进程都按 node.exe 约定。',
    );
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    throw new Error(`当前 Node 是 v${process.versions.node}，打包需要 Node 22+（后端依赖 node:sqlite）。`);
  }

  const target = path.join(runtimeDir, 'node.exe');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const cacheDir = path.join(ROOT, CACHE_SUBDIR);
  const cacheFile = path.join(cacheDir, `node-v${process.versions.node}.exe`);
  fs.mkdirSync(cacheDir, { recursive: true });

  const sourceSize = fs.statSync(process.execPath).size;
  const cacheReady = fs.existsSync(cacheFile) && fs.statSync(cacheFile).size === sourceSize;
  if (!cacheReady) {
    fs.copyFileSync(process.execPath, cacheFile);
  }

  try { fs.rmSync(target, { force: true }); } catch { /* 不存在 */ }
  let mode = 'copy';
  try {
    fs.linkSync(cacheFile, target);
    mode = 'link';
  } catch {
    fs.copyFileSync(cacheFile, target);
  }

  const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);

  /* 验证接进来的运行时真的带 node:sqlite —— 硬链接写错是静默的，
   * 少了这步就是一个「双击后才发现后端起不来」的包。 */
  const probe = spawnSync(
    target,
    ['-e', "require('node:sqlite'); console.log('ok')"],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (probe.status !== 0 || !String(probe.stdout).includes('ok')) {
    fail('内置 Node 运行时自检失败：包内 node.exe 无法加载 node:sqlite。');
    log(`  stdout: ${probe.stdout}`);
    log(`  stderr: ${probe.stderr}`);
    throw new Error('bundled node runtime failed node:sqlite probe');
  }

  ok(`已内置 Node v${process.versions.node} 运行时（${sizeMb} MB，${mode === 'link' ? '硬链接' : '复制'}，含 node:sqlite）`);
}
