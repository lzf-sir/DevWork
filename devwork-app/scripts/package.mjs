#!/usr/bin/env node
/**
 * 一键打包 DevWork —— 产出**免安装的可执行文件**（portable 单文件 exe）。
 *
 * 用法：
 *   node scripts/package.mjs            默认：portable 单文件 exe（免安装，双击即用）
 *   node scripts/package.mjs --dir      只出免安装目录（release/win-unpacked），最快，用于自测
 *   node scripts/package.mjs --installer  额外出一个 NSIS 安装包（需要时才用）
 *   node scripts/package.mjs --open     打包完成后打开产物目录
 *
 * 打包链路（每一步都是真的，不是摆设）：
 *   ① 前置门禁：Node 22（node:sqlite 硬门槛）+ 依赖齐备；
 *   ② 构建：typecheck（前后端）+ vite build → dist/；
 *   ③ 运行时暂存 build/pkg/server：服务端源码 + 它在运行时真正需要的依赖
 *      （express / cors / tsx / esbuild / @esbuild 本平台二进制）。
 *      **不打进产物**：开发数据库（server/data）与沙箱仓库（server/sandbox）
 *      —— 首次启动会自己播种重建，带上开发库等于把测试数据发给用户；
 *   ③' 运行时暂存 build/pkg/runtime/node.exe：**内置 Node 22**，
 *      让目标机零依赖（后端依赖 node:sqlite，Electron 内置的 Node 20 不带）；
 *   ④ electron-builder 产出 release/DevWork <版本>.exe（单文件，免安装）；
 *   ⑤ 自检：确认产物存在、运行时齐备。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  copyDependencyClosure, copyDir, fail, listDirs, log, npmBin, ok, preflight, removeDir, run, step, title, warn,
} from './lib/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'build', 'pkg');
const RELEASE = path.join(ROOT, 'release');
const args = new Set(process.argv.slice(2));
const dirOnly = args.has('--dir');
const withInstaller = args.has('--installer');
const openAfter = args.has('--open') || process.platform === 'win32';
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

title('DevWork 打包（免安装可执行文件）');

/* ① 前置门禁 */
preflight(ROOT, { requireNode: 22, autoInstall: false });

/* ② 构建：typecheck + vite build */
step('类型检查与前端构建（npm run build）…');
run(npmBin(), ['run', 'build'], { cwd: ROOT });
ok('构建完成 → dist/');

/* ③ 运行时暂存 */
step('暂存服务端运行时（源码 + 生产依赖）…');
stageRuntime();
ok(`运行时已暂存 → ${path.relative(ROOT, STAGE)}`);

/* ④ electron-builder
 *    目标默认是 portable：**单个 exe，免安装**（用户明确要求"可执行文件就可以，不需要安装"）。
 *    上一次的产物目录若被占用（杀软扫描等），改用带时间戳的新目录，
 *    保证"一键"这件事不会因为一个残留目录就失败。 */
step('生成可执行文件（electron-builder）…');
const outputDir = pickOutputDir();
/* electron-builder 的目标写法是 `--win <target>`（如 `--win portable`），不是位置参数。 */
const targets = dirOnly ? ['dir'] : withInstaller ? ['nsis', 'portable'] : ['portable'];
const builderArgs = [
  'exec', '--', 'electron-builder',
  '--win', ...targets,
  '--x64',
  '--publish', 'never',
  `--config.directories.output=${outputDir}`,
];
buildWithRetry(builderArgs);

/* ⑤ 产物自检 */
title('产物');
/* outputDir 可能是相对路径（release/build），也可能是绝对路径（被占用时的
 * 时间戳兜底目录）—— path.resolve 统一处理，避免拼成 ROOT\ROOT\... 的自检失败。 */
const outputRoot = path.resolve(ROOT, outputDir);
const portable = path.join(outputRoot, `DevWork ${version}.exe`);
const unpacked = path.join(outputRoot, 'win-unpacked', 'DevWork.exe');

if (dirOnly) {
  if (!fs.existsSync(unpacked)) {
    fail(`未找到免安装目录产物：${unpacked}`);
    process.exit(1);
  }
  ok(`免安装目录：${unpacked}`);
} else {
  /* 把单文件 exe 复制到 release/ 根目录，方便用户直接看到。 */
  const source = fs.existsSync(portable)
    ? portable
    : fs.readdirSync(outputRoot).filter((n) => n.endsWith('.exe'))[0];
  if (!source) {
    fail(`未找到可执行文件：${portable}`);
    log('  请检查上面的 electron-builder 输出。');
    process.exit(1);
  }
  const sourcePath = path.isAbsolute(source) ? source : path.join(ROOT, outputDir, source);
  const target = path.join(RELEASE, `DevWork ${version}.exe`);
  try {
    fs.copyFileSync(sourcePath, target);
    ok(`可执行文件：${target}`);
    log(`  大小：${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB`);
    log('  免安装：直接双击即可运行（首次启动会把运行时解到临时目录）。');
  } catch {
    ok(`可执行文件：${sourcePath}`);
    log(`  大小：${(fs.statSync(sourcePath).size / 1024 / 1024).toFixed(1)} MB`);
  }
}
if (withInstaller) {
  const installer = path.join(ROOT, outputDir, `DevWork Setup ${version}.exe`);
  if (fs.existsSync(installer)) ok(`安装包：${installer}`);
}

/* 运行时是否齐备：后端要 node:sqlite，所以包里必须自带 Node 22。 */
const stagedTsx = path.join(STAGE, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!fs.existsSync(stagedTsx)) {
  warn('暂存区缺少 tsx CLI —— 打包出来的程序启动不了后端，请检查依赖是否安装完整。');
  process.exit(1);
}
const stagedNode = path.join(STAGE, 'runtime', 'node.exe');
if (!fs.existsSync(stagedNode)) {
  warn('暂存区缺少内置 Node 运行时 —— 目标机没装 Node 22 时后端起不来。');
  process.exit(1);
}
ok('运行时依赖齐备（内置 Node 22 / express / cors / tsx / esbuild）');

log('');
ok('免安装说明：目标机器**不需要**预装 Node —— 包内已自带 Node 22 运行时。');
log('  数据落在 exe 同级的 DevWorkData\\ 目录（绿色软件习惯），随 exe 一起拷走即可迁移。');
log('');

if (openAfter && fs.existsSync(outputRoot)) {
  step('打开产物目录…');
  if (process.platform === 'win32') {
    spawnSync('explorer.exe', [outputRoot], { stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    spawnSync('open', [path.join(ROOT, outputDir)], { stdio: 'ignore' });
  } else {
    spawnSync('xdg-open', [path.join(ROOT, outputDir)], { stdio: 'ignore' });
  }
}

/**
 * 选输出目录。
 *
 * 固定用 release/build 而不是 release/ 本身：electron-builder 打包前会先把输出目录
 * 清空，而 release/ 里可能躺着上一次失败留下的、还被杀软/索引器占用的文件
 * （清不掉 → 整次打包直接失败）。把产物放进一个**独立子目录**，
 * 既避开那些残留，也让"这次的产物"与"上次的残留"互不干扰。
 * 子目录本身清不掉时（同样被占用），再退到带时间戳的新目录。
 */
function pickOutputDir() {
  const preferred = path.join(RELEASE, 'build');
  removeDir(preferred);
  if (!fs.existsSync(preferred)) return path.join(RELEASE, 'build');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const fallback = path.join(RELEASE, `build-${stamp}`);
  warn(`上一次的产物目录被占用（通常是杀软正在扫描），本次输出到 ${fallback}`);
  return fallback;
}

/** electron-builder 偶尔会撞上杀软扫描而失败，重试一次通常就好了。 */
function buildWithRetry(builderArgs, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(npmBin(), builderArgs, { cwd: ROOT });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      warn(`第 ${attempt} 次打包失败（常见于杀软正在扫描产物），8 秒后重试…`);
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 8000)']);
    }
  }
}

/**
 * 暂存服务端运行时。
 *
 * 打包态的后端是**独立 Node 进程**（不是 Electron 内嵌），它读不了 asar 里的文件，
 * 所以运行时必须以真实目录形式落在 resources/server 下，由 electron/main.cjs 拉起。
 */
function stageRuntime() {
  const serverStage = path.join(STAGE, 'server');
  removeDir(STAGE);
  fs.mkdirSync(serverStage, { recursive: true });

  /* 服务端源码：src（含 schema.sql 等非 TS 资源）。 */
  copyDir(path.join(ROOT, 'server', 'src'), path.join(serverStage, 'src'));

  /* 模块类型声明：服务端是 ESM，打包后这个目录没有上层 package.json 兜底。 */
  fs.writeFileSync(
    path.join(serverStage, 'package.json'),
    `${JSON.stringify({ name: 'devwork-server-runtime', private: true, type: 'module' }, null, 2)}\n`,
    'utf8',
  );

  /* 运行时依赖：express / cors 是服务端直接 import 的；tsx+esbuild 用来跑 TS。 */
  const modulesDir = path.join(serverStage, 'node_modules');
  fs.mkdirSync(modulesDir, { recursive: true });
  const copied = copyDependencyClosure(['express', 'cors', 'tsx'], modulesDir, ROOT);

  /* esbuild 的本平台二进制是 optionalDependency，copyDependencyClosure 会带上；
   * 缺了它 tsx 起不来，所以这里显式核对一次。 */
  const esbuildBin = listDirs(path.join(modulesDir, '@esbuild'));
  if (esbuildBin.length === 0) {
    fail('暂存区缺少 @esbuild/*（esbuild 的本平台二进制）—— 打包出来的程序跑不了 TS 后端。');
    log('  处理办法：删掉 node_modules 后重新 npm install，再打包。');
    process.exit(1);
  }
  log(`  依赖 ${copied.length} 个 · esbuild 平台包 ${esbuildBin.join(', ')}`);

  /* 内置 Node 运行时：目标机零依赖的关键。 */
  stageBundledNode();
}

/**
 * 把当前构建用的 Node 22 复制进产物，做成「自带运行时」。
 *
 * 为什么必须内置：后端是**独立 Node 进程**，依赖 node:sqlite（Node 22.5+ 才有）。
 * Electron 33 自带的 Node 是 20.x，没有 node:sqlite —— 用它兜底只会得到
 * 一句用户看不懂的 "Cannot find module 'node:sqlite'"。
 * 所以「复制即用、不装任何东西」的唯一可靠解法：包里自带一份 Node 22。
 *
 * 复制 node.exe 单文件即可（Windows 版 Node 是自包含的，不依赖旁边的 dll）。
 */
function stageBundledNode() {
  const source = process.execPath;
  const target = path.join(STAGE, 'runtime', 'node.exe');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) {
    fail(`当前 Node 是 v${process.versions.node}，打包需要 Node 22+（后端依赖 node:sqlite）。`);
    process.exit(1);
  }

  fs.copyFileSync(source, target);
  const sizeMb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);

  /* 验证复制出来的运行时真的带 node:sqlite —— 少这一步，
   * 就是一个「双击后才发现后端起不来」的包。 */
  const probe = spawnSync(
    target,
    ['-e', "require('node:sqlite'); console.log('ok')"],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (probe.status !== 0 || !String(probe.stdout).includes('ok')) {
    fail('内置 Node 运行时自检失败：包内 node.exe 无法加载 node:sqlite。');
    log(`  stdout: ${probe.stdout}`);
    log(`  stderr: ${probe.stderr}`);
    process.exit(1);
  }

  ok(`已内置 Node v${process.versions.node} 运行时（${sizeMb} MB，含 node:sqlite）`);
}
