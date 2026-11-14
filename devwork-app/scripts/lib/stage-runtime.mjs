/**
 * 内置运行时暂存（prepare:runtime 的核心）。
 *
 * 打包态的后端是**独立 Node 进程**（不是 Electron 内嵌），它读不了 asar 里的文件，
 * 所以运行时必须以真实目录形式落进 resources/。
 *
 * 产出（**四件，缺一件装机就起不来**；与 electron-builder.yml 的 extraResources 一一对应）：
 *   build/pkg/server            服务端源码 + 它在运行时真正需要的依赖（express/cors/tsx/zod + @esbuild/*）
 *                               —— 缺任一个：tsx 起不来或后端 import 失败（ERR_MODULE_NOT_FOUND）。
 *   build/pkg/shared            契约层 + package.json{type:module}
 *                               —— 缺 package.json 的 type:module → contracts 被按 CJS 解释，
 *                                  具名导出探测失败（`does not provide an export named …`）。
 *   build/pkg/node_modules      shared 侧的解析链落点（当前只有 zod，见 SHARED_RUNTIME_MODULES）
 *                               —— 缺了 → `shared/contracts` 解析不到 zod；**不能并到
 *                                  server/node_modules**：ESM 裸包解析从 shared/contracts 向上找，
 *                                  走不到 server 下。
 *   build/pkg/runtime/node.exe  内置 Node 22（后端依赖 node:sqlite；Electron 自带的 Node 20 没有）
 *                               —— 缺了 → 目标机没装 Node 时后端直接起不来。
 *
 * 为什么要在这里写清楚：v1.0 的两次 P0（zod 未进暂存清单、shared 丢 ESM 上下文）
 * 都是"清单与实际不一致"的产物，而且**在仓库内启动仍然全绿**（仓库的
 * devwork-app/package.json 与 node_modules 是两层兜底）。照一份过期的清单整理目录，
 * 删掉 shared/ 或 node_modules/ 也发现不了 —— 所以清单必须与实现同一次改。
 *
 * 性能约定（打包速度的关键）：
 *   - 依赖闭包按 package-lock 指纹缓存，未变化时**跳过复制**（原来每次 72 个包全量拷）；
 *   - node.exe 落在 build/cache 里，之后用**同卷硬链接**接进产物（83MB 的复制降到毫秒级）；
 *   - 缓存命中时只刷新 backend/src 与 shared（改代码必须立即生效）。
 *   需要彻底重建时用 `node scripts/prepare-runtime.mjs --force`。
 *
 * 一个已知的**环境**开销（不是脚本缺陷，所以这里不改实现）：
 * 全量重建要先 `removeDir(build/pkg)` 删掉上一轮的 72 个包。在带文件代理 / 杀软实时扫描的
 * 环境里，`fs.rmSync` 可能失败并回落到逐文件 unlink，这一步会从"秒级"退化成"十几分钟"。
 * 若你确认是这种环境：**先手工删掉 `build/pkg` 再跑**（shell 的 `rm -rf` 走原生删除，通常秒级），
 * 比等它逐文件删快得多。不要为此把 `removeDir` 改成"先 rename 再删"或调用 shell ——
 * 那会让脚本在不同机器上行为不一致，而这段耗时随环境变化，不该固化进打包链路。
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
/**
 * 指纹格式变了就换版本号，旧缓存自动失效。
 *
 * v2 → v3：依赖闭包从 `express/cors/tsx` 扩到 `express/cors/tsx/zod`。
 * 必须换版本号 —— 否则历史缓存（含同样 lockfile 指纹）会命中，
 * 拿到的仍是**没有 zod** 的暂存区，于是「改了代码却还是漏包」。
 */
const STAMP_VERSION = 'v3';

/**
 * 后端运行时真正需要的三方依赖（**闭包的种子**）。
 *
 * 注意 zod：它不在 express / cors / tsx 的依赖闭包里，但后端所有写侧路由经
 * `shared/contracts/*.ts` 在**运行期** `import { z } from 'zod'`。
 * 漏了它的表现不是报错，而是「六步全过、装到用户机器上后端起不来」
 * （`ERR_MODULE_NOT_FOUND: Cannot find package 'zod'`）。
 * 新增任何后端运行时依赖都要同时改这里与 package.mjs 的产物自检。
 */
export const RUNTIME_MODULES = ['express', 'cors', 'tsx', 'zod'];

/**
 * `shared/` 自己的运行期依赖 —— **与后端那份语义不同，不要合并**。
 *
 * 后端那份（`RUNTIME_MODULES`）落在 `server/node_modules`，供 tsx 加载后端源码用；
 * 这份落在 **`<stage>/node_modules`（即 resources 根）**，供
 * `shared/contracts/*.ts` 的裸包解析链用。两份都在同一处定义（这里），
 * `preflight-release.mjs` 与 `package.mjs` 都 import，不另设清单。
 *
 * 已穷举：`shared/contracts` 的非相对 import 只有 zod（后端那 3 个里 express/cors
 * 只在 backend/src 出现，shared 不用）。
 */
export const SHARED_RUNTIME_MODULES = ['zod'];

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
    /* 逐个核对种子包：缓存目录缺任何一个都不能算命中（v2 的缓存就缺 zod）。 */
    && RUNTIME_MODULES.every((name) => fs.existsSync(path.join(serverDir, 'node_modules', name)))
    && fs.existsSync(path.join(serverDir, 'src', 'index.ts'))
    && fs.existsSync(path.join(runtimeDir, 'node.exe'));

  /* 缓存未命中（含 `.stamp` 不存在、指纹不符、关键目录残缺）时**一律全量重建**：
   * `removeDir(stageDir)` 之后再 refreshSources + 重新拷依赖。
   * 所以如果看到 `build/pkg` 目录残缺、只剩 server/shared —— 那不是"坏了"，
   * 而是上次重建被打断；下一次运行会从零重建（缺 `.stamp` 就一定走到这里）。 */

  if (cached) {
    refreshSources(ROOT, stageDir, serverDir);
    ok('运行时命中缓存（依赖与 Node 未变，只刷新源码）');
    return { stageDir, serverDir, runtimeDir, cached: true };
  }

  removeDir(stageDir);
  fs.mkdirSync(serverDir, { recursive: true });

  refreshSources(ROOT, stageDir, serverDir);

  /* 运行时依赖：express / cors 是服务端直接 import 的；tsx+esbuild 用来跑 TS；
   * zod 是 shared/contracts 在运行期用的（见 RUNTIME_MODULES 的说明）。 */
  const modulesDir = path.join(serverDir, 'node_modules');
  fs.mkdirSync(modulesDir, { recursive: true });
  const copied = copyDependencyClosure(RUNTIME_MODULES, modulesDir, ROOT);

  /* 种子包必须在场：copyDependencyClosure 对缺失的包只 warn 不抛
   * （它为选修依赖如非本平台 @esbuild/* 设计），漏一个种子包就会被静默放过。 */
  const missingSeeds = RUNTIME_MODULES.filter(
    (name) => !fs.existsSync(path.join(modulesDir, name, 'package.json')),
  );
  if (missingSeeds.length > 0) {
    fail(`暂存区缺少后端运行时依赖：${missingSeeds.join(' / ')}`);
    log(`  完整清单：${RUNTIME_MODULES.join(' / ')}（后端运行期真的会 import 它们）。`);
    log('  处理办法：确认这些包在 devwork-app/node_modules 里存在（npm install）后重新打包。');
    throw new Error(`missing runtime modules: ${missingSeeds.join(',')}`);
  }

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
 *
 * **产物自检必须在「祖先没有 node_modules、没有 package.json」的目录里跑** ——
 * 否则仓库本身就是一层保护，会把缺陷全部变成绿（zod 漏包、shared 丢 ESM 上下文
 * 这两次都是这么来的：仓库内启动时向上命中了 devwork-app/package.json 与 node_modules）。
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

  /* shared 也需要同样的声明，理由不同：
   * `resources/shared` 及其祖先**没有任何** package.json，于是 `shared/contracts/*.ts`
   * 会被当成 CommonJS；`export * from './workspace'` 经 tsx 转 CJS 后具名导出探测不到，
   * 后端启动直接 `SyntaxError: does not provide an export named 'workspaceCreateSchema'`。
   * 只写 module 类型，**不要**把 devwork-app/package.json 整个复制过来
   * （那会把 dependencies / scripts / version 一起带进产物）。 */
  fs.writeFileSync(
    path.join(sharedTarget, 'package.json'),
    `${JSON.stringify({ name: 'devwork-shared-runtime', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );

  stageSharedRuntimeModules(ROOT, stageDir);
}

/**
 * 把 `shared/` 自己的运行期依赖落到 **resources 根**（`build/pkg/node_modules`）。
 *
 * 为什么不能复用 `server/node_modules`：ESM 裸包解析是从 **import 语句所在文件**
 * 逐级向上找 node_modules：
 *   resources/shared/contracts/ → resources/shared/node_modules → resources/node_modules → 解包目录
 * `resources/server/node_modules` **一个都不在这条链上**，所以 `server/node_modules` 里
 * 有 zod 也救不了——这正是"静态扫描只能当第二层"的活样本：
 * 预检 ④ 看到"暂存区含 zod"通过，行为上照样 ERR_MODULE_NOT_FOUND。
 *
 * **为什么落在 resources 根，而不是 `shared/node_modules`**（两个落点都能被解析到，
 * 这是刻意的取舍，不要在某次"简化"里把 zod 挪走）：
 *   · 选根的理由：`resources/node_modules` 是"整个 resources 的依赖层"，
 *     server 侧将来要复用同一份三方包时不需要再拷一遍；
 *   · 代价：`electron-builder.yml` 必须多一条 `extraResources` 映射
 *     （`build/pkg/node_modules → node_modules`），改目录名时要与它一起同步。
 *   · **要改落点必须同时改五处**（少一处就会出问题，这是按实际实现数出来的，不是四处的笔误）：
 *     ① 本文件（真正拷包）② `electron-builder.yml`（`extraResources` 的 from/to）
 *     ③ `preflight-release.mjs` ④（断言校验的路径）④ `package.mjs` 产物自检
 *     （在 `win-unpacked/resources` 下再查一次）⑤ `smoke-package.mjs` 前置检查与复制清单。
 *     漏改 ①② → **静默丢依赖**（包根本没进产物，但闸门是绿的）；
 *     漏改 ③④⑤ → **闸门指向旧路径**（红得没有意义，修的人会去动错误的目录）。
 *   若改成 `shared/node_modules`：builder 配置不用动（`from: build/pkg/shared` 是递归拷贝），
 *   但另外四处同样都要跟着改。
 *
 * 已穷举：`shared/contracts/*.ts` 的非相对 import 只有 zod。
 * 缓存命中时这步也要跑（refreshSources 每次都会调），但只在目标缺失时才复制，
 * 免得每次打包都重拷一遍。
 */
function stageSharedRuntimeModules(ROOT, stageDir) {
  const sharedModulesDir = path.join(stageDir, 'node_modules');
  const absent = SHARED_RUNTIME_MODULES.filter(
    (name) => !fs.existsSync(path.join(sharedModulesDir, name, 'package.json')),
  );
  if (absent.length > 0) {
    fs.mkdirSync(sharedModulesDir, { recursive: true });
    copyDependencyClosure(absent, sharedModulesDir, ROOT);
  }
  const stillMissing = SHARED_RUNTIME_MODULES.filter(
    (name) => !fs.existsSync(path.join(sharedModulesDir, name, 'package.json')),
  );
  if (stillMissing.length > 0) {
    fail(`暂存区缺少 shared 运行期依赖：${stillMissing.join(' / ')}`);
    log(`  清单：${SHARED_RUNTIME_MODULES.join(' / ')}（shared/contracts 运行期真的会 import 它们）。`);
    log('  它们必须落在 <stage>/node_modules（resources 根），不能只放 server/node_modules。');
    throw new Error(`missing shared runtime modules: ${stillMissing.join(',')}`);
  }
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
