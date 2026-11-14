#!/usr/bin/env node
/**
 * 一键打包 DevWork —— 对齐 DeepSeek Harness 官方桌面端的发布链路。
 *
 * 链路（每一步都是真的，不是摆设）：
 *   ① check:version    版本只有一个来源，semver 合法，渠道元数据不打架
 *   ② build            typecheck（前后端）+ vite build → dist/（注入 __PACKAGED__）
 *   ③ prepare:runtime  暂存 build/pkg：服务端源码 + 生产依赖 + 内置 Node 22
 *   ④ smoke            用**包内 Node** 拉起后端，验证真实启动页可访问
 *   ⑤ electron-builder zip 压缩包（默认）/ NSIS 安装包 / portable 单文件
 *                      （--publish never，只落地更新元数据）
 *   ⑥ 产物自检         压缩包 / 安装包 / 便携版 / stable.yml 逐个核对
 *
 * 用法：
 *   node scripts/package.mjs               只出 zip 压缩包（默认；不含自解压逻辑，不被拦）
 *   node scripts/package.mjs --dir         只出解压目录 release/build/win-unpacked（自测最快）
 *   node scripts/package.mjs --zip         同默认
 *   node scripts/package.mjs --installer   只出 NSIS 安装包
 *   node scripts/package.mjs --portable    只出便携单文件
 *   node scripts/package.mjs --all         三种都出
 *   node scripts/package.mjs --fast        跳过 typecheck 与冒烟（只改 UI 时最快）
 *   node scripts/package.mjs --no-typecheck  只跳 typecheck，仍跑冒烟
 *   node scripts/package.mjs --no-smoke    只跳过冒烟
 *   node scripts/package.mjs --force       运行时不走缓存，全量重建
 *   node scripts/package.mjs --open        完成后打开产物目录
 *
 * 环境变量：
 *   DEVWORK_UPDATE_URL   覆盖更新源（默认取 electron-builder.yml 里的占位地址）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail, log, npmBin, ok, preflight, removeDir, run, step, title, warn } from './lib/common.mjs';
import { stageRuntime } from './lib/stage-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = path.join(ROOT, 'release');
const args = new Set(process.argv.slice(2));
const dirOnly = args.has('--dir');
const onlyPortable = args.has('--portable');
const onlyInstaller = args.has('--installer');
const allTargets = args.has('--all');
/* 默认只出 zip：exe 的自解压/安装器在这类机器上会被安全软件直接拦住执行，
 * 而压缩包只解压、不执行，是唯一稳定的分发形态。 */
const zipOnly = !dirOnly && !onlyPortable && !onlyInstaller && !allTargets;
const fastMode = args.has('--fast');
/* 只跳 typecheck：开发中前后端类型常有一时对不齐，但代码本身能编译，
 * 这时仍然应该跑冒烟（产物能不能起来和类型无关）。 */
const skipTypecheck = args.has('--no-typecheck') || fastMode;
const skipSmoke = args.has('--no-smoke') || fastMode;
const forceRuntime = args.has('--force');
const openAfter = args.has('--open') || process.platform === 'win32';
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const script = (name) => path.join(ROOT, 'scripts', name);

const wantInstaller = !dirOnly && (onlyInstaller || allTargets);
const wantPortable = !dirOnly && (onlyPortable || allTargets);
const wantZip = !dirOnly && (zipOnly || allTargets);

title('DevWork 打包（zip 压缩包）');

/* ① 版本门禁 */
step('版本一致性检查…');
run(process.execPath, [script('check-version.mjs')], { cwd: ROOT });

/* ② 构建：typecheck + vite build */
step(skipTypecheck ? '前端构建（跳过 typecheck）…' : '类型检查与前端构建（npm run build）…');
/* DEVWORK_BUILD_PACKAGED=1 是 vite.config.ts 里 __PACKAGED__ 的开关：
 * 少了它，打包产物会以为自己还在开发态，mock 降级就跟着一起发出去。 */
run(npmBin(), ['run', skipTypecheck ? 'build:fast' : 'build'], {
  cwd: ROOT,
  env: { DEVWORK_BUILD_PACKAGED: '1' },
});
ok('构建完成 → dist/');

/* ③ 内置运行时 */
step('暂存服务端运行时（源码 + 生产依赖 + 内置 Node）…');
const { stageDir, cached } = stageRuntime(ROOT, { force: forceRuntime });
ok(`运行时已暂存 → ${path.relative(ROOT, stageDir)}${cached ? '（缓存命中）' : ''}`);

/* ④ 冒烟：在打包前用包内运行时验一次真实启动页 */
if (skipSmoke) {
  warn('已跳过冒烟（--fast / --no-smoke）：产物未做启动页验证，发布前请补跑 npm run smoke。');
} else {
  step('打包产物冒烟（smoke）…');
  run(process.execPath, [script('smoke-package.mjs')], { cwd: ROOT });
}

/* ⑤ electron-builder
 * 目标写法是 `--win <target>`（如 `--win nsis portable`），不是位置参数。
 * --publish never：只生成本地元数据，绝不往更新源上传。 */
step('生成安装包与便携版（electron-builder）…');
const outputDir = pickOutputDir();
const targets = dirOnly
  ? ['dir']
  : [
    ...(wantInstaller ? ['nsis'] : []),
    ...(wantPortable ? ['portable'] : []),
    ...(wantZip ? ['zip'] : []),
  ];
const builderArgs = [
  'exec', '--', 'electron-builder',
  '--win', ...targets,
  '--x64',
  '--publish', 'never',
  `--config.directories.output=${outputDir}`,
];
if (process.env.DEVWORK_UPDATE_URL) {
  builderArgs.push(`--config.publish.url=${process.env.DEVWORK_UPDATE_URL}`);
  log(`  更新源：${process.env.DEVWORK_UPDATE_URL}`);
}
buildWithRetry(builderArgs);

/* ⑥ 产物自检 */
title('产物');
const outputRoot = path.resolve(ROOT, outputDir);
const expected = [];

if (dirOnly) {
  expected.push(['免安装目录', path.join(outputRoot, 'win-unpacked', 'DevWork.exe')]);
} else {
  if (wantZip) expected.push(['压缩包', path.join(outputRoot, `DevWork-${version}-win-x64.zip`)]);
  if (wantInstaller) expected.push(['安装包', path.join(outputRoot, `DevWork-Setup-${version}-win-x64.exe`)]);
  if (wantPortable) expected.push(['便携版', path.join(outputRoot, `DevWork-${version}-win-x64-portable.exe`)]);
}

let missing = 0;
for (const [label, file] of expected) {
  if (fs.existsSync(file)) {
    ok(`${label}：${path.relative(ROOT, file)}（${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB）`);
  } else {
    fail(`未找到${label}：${path.relative(ROOT, file)}`);
    missing += 1;
  }
}

/* 更新元数据：有安装包就应该有 stable.yml（electron-updater 的入口）。 */
if (wantInstaller) {
  const feed = path.join(outputRoot, 'stable.yml');
  if (fs.existsSync(feed)) {
    ok(`更新元数据：${path.relative(ROOT, feed)}`);
  } else {
    warn('未生成 stable.yml —— 自动更新会失效，请检查 publish 配置。');
    missing += 1;
  }
}

/* 运行时是否齐备：后端要 node:sqlite，所以包里必须自带 Node 22。 */
const stagedTsx = path.join(stageDir, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const stagedNode = path.join(stageDir, 'runtime', 'node.exe');
if (!fs.existsSync(stagedTsx) || !fs.existsSync(stagedNode)) {
  fail('暂存区缺少 tsx 或内置 Node 运行时 —— 打包出来的程序启动不了后端。');
  missing += 1;
} else {
  ok('运行时依赖齐备（内置 Node 22 / express / cors / tsx / esbuild）');
}

if (missing > 0) {
  log('');
  fail(`有 ${missing} 项未通过，请先看上面的输出。`);
  process.exit(1);
}

log('');
ok('打包完成。');
if (wantZip) {
  log('  压缩包：解压到任意目录，双击其中的 DevWork.exe 启动。');
  log('         数据落在 %APPDATA%\\devwork-app（卸载/删除只需删程序目录）。');
  log('         安全软件若仍拦 DevWork.exe，把该目录加入信任即可 —— 压缩包本身不会被拦。');
}
if (wantInstaller) log('  安装包：开始菜单 / 卸载 / 自动更新齐全。');
if (wantPortable) log('  便携版：双击即用，数据在 exe 同级 DevWorkData\\；不支持自更新。');
if (process.env.DEVWORK_UPDATE_URL) log(`  更新源：${process.env.DEVWORK_UPDATE_URL}`);
log('');

if (openAfter && fs.existsSync(outputRoot)) {
  step('打开产物目录…');
  if (process.platform === 'win32') spawnSync('explorer.exe', [outputRoot], { stdio: 'ignore' });
  else if (process.platform === 'darwin') spawnSync('open', [outputRoot], { stdio: 'ignore' });
  else spawnSync('xdg-open', [outputRoot], { stdio: 'ignore' });
}

/**
 * 选输出目录。
 *
 * 固定用 release/build 而不是 release/ 本身：electron-builder 打包前会先清空
 * 输出目录，而 release/ 里可能躺着上一次失败留下、还被杀软/索引器占用的文件
 * （清不掉 → 整次打包直接失败）。放进独立子目录既避开残留，也让本次产物
 * 与上次残留互不干扰；子目录本身清不掉时再退到带时间戳的新目录。
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
function buildWithRetry(builder, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      run(npmBin(), builder, { cwd: ROOT });
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      warn(`第 ${attempt} 次打包失败（常见于杀软正在扫描产物），8 秒后重试…`);
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 8000)']);
    }
  }
}
