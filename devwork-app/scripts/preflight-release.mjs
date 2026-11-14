#!/usr/bin/env node
/**
 * 发布前静态门禁（preflight:release）。
 *
 * 为什么要有这一步：打包链路（`npm run dist`）会真的构建、真的跑冒烟、真的写 release/，
 * 十几分钟才出结论。而「版本号没改齐」「依赖漏了 zod」「前端把 zod 引进了包」
 * 这类问题**看静态文件就能判定**，不该等打包跑到一半才发现。
 * 所以这里是一条 5 秒级的红线：过不了就不要开始打包。
 *
 * 五项检查（任何一项失败 → 退出码非 0，不可发布）：
 *   ① `npm run typecheck`（前后端 tsc 双份）；
 *   ② 版本单源：package.json 的 version 必须等于 backend/src/config/version.ts 的 APP_VERSION；
 *   ③ package.json 的 dependencies 必须含 zod（后端经 shared/contracts 运行期依赖它）；
 *   ④ 若已有暂存区 build/pkg/server/node_modules，核对五个运行时包齐备，缺谁点名谁；
 *   ⑤ 扫描 frontend/src：禁止从 `shared/contracts` 根引运行时值（会把 zod 打进前端包）。
 *
 * 用法：node scripts/preflight-release.mjs
 *      node scripts/preflight-release.mjs --no-typecheck   只跳过 ①（其余照跑）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail, listDirs, log, npmBin, ok, step, title, warn } from './lib/common.mjs';
import { RUNTIME_MODULES, SHARED_RUNTIME_MODULES, STAGE_SUBDIR } from './lib/stage-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const skipTypecheck = args.has('--no-typecheck');

/** 后端运行时依赖：暂存区里必须齐备（esbuild 是 tsx 的本平台二进制依赖，单独点名）。 */
const REQUIRED_MODULES = [...RUNTIME_MODULES, 'esbuild'];

/** 检查结果收集：一次把所有问题都报出来，而不是修一个跑一次。 */
const problems = [];
const report = (passed, text, detail) => {
  if (passed) {
    ok(text);
    return true;
  }
  fail(text);
  if (detail) log(`  ${detail}`);
  problems.push(text);
  return false;
};

title('发布前静态门禁');

/* ---------- ① 类型检查：前后端 tsc 两份 ---------- */
step('① 类型检查（npm run typecheck）…');
if (skipTypecheck) {
  warn('已跳过类型检查（--no-typecheck）—— 发布前请至少完整跑一次。');
} else {
  const result = spawnSync(npmBin(), ['run', 'typecheck'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  report(result.status === 0, '类型检查通过（0 error）', '先修掉类型错误，再谈打包。');
}

/* ---------- ② 版本单源 ---------- */
step('② 版本单源（package.json ↔ config/version.ts）…');
const manifestPath = path.join(ROOT, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pkgVersion = String(manifest.version ?? '');
const versionTsPath = path.join(ROOT, 'backend', 'src', 'config', 'version.ts');

if (!fs.existsSync(versionTsPath)) {
  report(false, '找不到 backend/src/config/version.ts', '版本号必须有一个后端侧的单一字面量。');
} else {
  /* 用正则读，不 import TS：这个脚本跑在 node 下，没有 tsx 加载器。
   * 只认 `APP_VERSION = '...'` 这一种写法 —— 写别的写法说明约定被绕开了。 */
  const source = fs.readFileSync(versionTsPath, 'utf8');
  const match = source.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!match) {
    report(false, 'config/version.ts 里读不到 APP_VERSION 字面量', '期望形式：export const APP_VERSION = \'1.0.0\';');
  } else if (match[1] !== pkgVersion) {
    report(
      false,
      `版本不一致：package.json=${pkgVersion} · config/version.ts=${match[1]}`,
      '/api/health 与「关于」页取的是 version.ts，两处不一致就会对外报旧版本。',
    );
  } else {
    report(true, `版本一致（${pkgVersion}）`);
  }
}

/* ---------- ③ 依赖声明含 zod ---------- */
step('③ 后端运行期依赖声明（package.json dependencies）…');
const deps = manifest.dependencies ?? {};
report(
  typeof deps.zod === 'string',
  `dependencies 含 zod（${deps.zod ?? '缺失'}）`,
  '后端经 shared/contracts 在运行期 import zod；不进 dependencies 就不会被暂存进产物。',
);

/* ---------- ④ 暂存区运行时依赖完整性 ---------- */
step('④ 暂存区运行时依赖（build/pkg/{server,node_modules,shared}）…');
const stagedServerModules = path.join(ROOT, STAGE_SUBDIR, 'server', 'node_modules');
const stagedSharedModules = path.join(ROOT, STAGE_SUBDIR, 'node_modules');
const stagedSharedPkg = path.join(ROOT, STAGE_SUBDIR, 'shared', 'package.json');
if (!fs.existsSync(stagedServerModules)) {
  /* **不通过 ≠ 跳过**：这里如果只 warn，结尾那句「门禁全部通过」就成了假绿 ——
   * 而这正是本仓库反复治的病（"验过但没真验"）。发布前必须先有暂存区：
   * `prepare-runtime` 是 `dist` 的必经步骤，暂存区不存在说明这次是从未打包过的状态，
   * 此时放行等于把「运行时依赖完整性」这一项悄悄删掉。 */
  report(
    false,
    '暂存区不存在：本次**无法校验**运行时依赖完整性（不是"通过"）',
    '先跑 node scripts/prepare-runtime.mjs --force（或 npm run dist，它会自动暂存），再重跑本门禁。',
  );
} else {
  const absent = REQUIRED_MODULES.filter(
    (name) => !fs.existsSync(path.join(stagedServerModules, name, 'package.json')),
  );
  /* 光有 `esbuild/` 主包不够：真正让 tsx 起不来的是 @esbuild/<platform> 那个
   * optionalDependency（作用域包）。主包在、平台包缺时，"五个包齐备"依然成立，
   * 于是这条门禁对**最典型的一类打包失败**是盲的 —— 而 stage-runtime.mjs 自己
   * 就有这条检查（listDirs(@esbuild) 非空），预检不该比它更宽。 */
  const esbuildBins = listDirs(path.join(stagedServerModules, '@esbuild'));
  /* 内层变量**不能**叫 problems：顶层已有一个同名收集数组（report() 与结尾统计都用它），
   * 同名遮蔽会让"在 ④ 里 push 一条问题"写进内层数组、静默丢失（门禁不红）。
   * 这是 review 里最难看出来的那类 bug 的温床。 */
  const stagedIssues = [];
  if (absent.length > 0) stagedIssues.push(`缺包：${absent.join(' / ')}`);
  /* 与上一条**并列**判定，不加 `absent.length === 0 &&`：
   * 缺 zod 时也要同时告诉你缺平台包 —— 否则这条新检查恰好在最需要它的那次运行里失效，
   * 也违背本脚本「一次把所有问题都报出来」的自我要求。 */
  if (esbuildBins.length === 0) {
    stagedIssues.push('缺 @esbuild/* 平台二进制（esbuild 主包在也起不来，tsx 加载不了 TS）');
  }

  /* shared 的两条（P0-1，QA 在仓库外启动时抓到）：
   * ① resources/shared 及其祖先没有 package.json → contracts 被当 CJS → 具名导出探测不到；
   * ② zod 只落在 server/node_modules，而解析起点是 shared/contracts → 找不到。 */
  if (!fs.existsSync(stagedSharedPkg)) {
    stagedIssues.push('缺 shared/package.json（产物里 contracts 会被当 CommonJS）');
  } else {
    let sharedType = '';
    try {
      sharedType = String(JSON.parse(fs.readFileSync(stagedSharedPkg, 'utf8')).type ?? '');
    } catch {
      stagedIssues.push('shared/package.json 不是合法 JSON');
    }
    if (sharedType !== 'module') {
      stagedIssues.push(`shared/package.json 的 type=${sharedType || '(空)'}，必须是 module`);
    }
  }
  const absentShared = SHARED_RUNTIME_MODULES.filter(
    (name) => !fs.existsSync(path.join(stagedSharedModules, name, 'package.json')),
  );
  if (absentShared.length > 0) {
    stagedIssues.push(
      `缺 build/pkg/node_modules/${absentShared.join(',')}（shared 的解析链看不到 server/node_modules）`,
    );
  }

  report(
    stagedIssues.length === 0,
    stagedIssues.length === 0
      ? `运行时依赖齐备：server（${REQUIRED_MODULES.join(' / ')} + @esbuild ${esbuildBins.join(', ')}）`
        + ` · shared 根（${SHARED_RUNTIME_MODULES.join(' / ')}）+ type=module`
      : stagedIssues.join('；'),
    stagedIssues.length === 0
      ? '静态通过 ≠ 能启动：最终判据是「在仓库外目录启动产物」。'
      : `完整清单：server=[${REQUIRED_MODULES.join(' / ')} + @esbuild/<platform>]`
        + ` · <stage>/node_modules=[${SHARED_RUNTIME_MODULES.join(' / ')}]`
        + ' · <stage>/shared/package.json{type:module}；'
        + '先跑 node scripts/prepare-runtime.mjs --force（缺平台包时 npm ci 重装依赖）。',
  );
}

/* ---------- ⑤ 前端不得从 contracts 根引运行时值 ---------- */
step('⑤ 前端契约层导入体检（frontend/src）…');
const frontendSrc = path.join(ROOT, 'frontend', 'src');
const contractsDir = path.join(ROOT, 'shared', 'contracts');

/** 递归收集 ts / tsx。 */
function collectSources(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (/\.(ts|tsx)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 判断一个 import 说明符是否指向「contracts 根」（index.ts）。
 *
 * 规则（架构文档 §4.3 / 陷阱 4）：
 *   `import type { X } from '.../shared/contracts'`        ✅ 编译期擦除
 *   `import { isAssetType } from '.../shared/contracts/vocab'` ✅ 零依赖词表
 *   `import { z } from '.../shared/contracts'`             ❌ 会把 zod 打进前端包（实测 +56KB）
 */
function isContractsRoot(filePath, spec) {
  const resolved = path.resolve(path.dirname(filePath), spec);
  const rel = path.relative(contractsDir, resolved).replace(/\\/g, '/');
  return rel === '' || rel === 'index' || rel === 'index.ts';
}

/**
 * 把「纯类型导入」原地涂成等长空白，**保留换行**。
 *
 * 为什么不能"删掉再算行号"：一条跨行 `import type { ... } from '…'` 如果被折叠成
 * 一个 `'\n'`，它后面的所有行号都会前移 N-1 行，报出来的位置指错地方 ——
 * 而这条检查的全部价值就是「报错能直接点过去」。
 * 等长空白替换让字符下标与换行位置都与原文严格一致，行号天然准确。
 *
 * @param {string} source 文件原文
 * @returns {string} 与原文等长的文本，纯类型导入区间被替换为空白
 */
function blankTypeOnlyImports(source) {
  return source.replace(
    /(?:^|[\n;])\s*(?:import|export)\s+type\s+[\s\S]*?from\s*(['"])[^'"]+\1\s*;?/g,
    (statement) => statement.replace(/[^\n]/g, ' '),
  );
}

const violations = [];
for (const file of collectSources(frontendSrc)) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes('shared/contracts')) continue;
  const blanked = blankTypeOnlyImports(raw);
  const pattern = /(?:import|export)[\s\S]{0,600}?from\s*(['"])([^'"]*shared\/contracts[^'"]*)\1/g;
  let match;
  while ((match = pattern.exec(blanked)) !== null) {
    const spec = match[2];
    if (!isContractsRoot(file, spec)) continue;
    /* 行号按原文算：blanked 与 raw 等长且换行位置一致，直接数换行即可。 */
    const line = blanked.slice(0, match.index).split('\n').length;
    violations.push(`${path.relative(ROOT, file)}:${line} → from '${spec}'`);
  }
}

if (violations.length > 0) {
  for (const item of violations) log(`  · ${item}`);
  report(
    false,
    `前端有 ${violations.length} 处从 shared/contracts 根引运行时值`,
    '改用 `import type`，或从 shared/contracts/vocab 取运行时值（否则 zod 进前端包）。',
  );
} else {
  report(true, '前端无 contracts 根的运行时导入（zod 不会进前端包）');
}

/* ---------- 结论 ---------- */
log('');
if (problems.length > 0) {
  fail(`门禁未通过（${problems.length} 项）—— 现在不要打包 / 不要发布。`);
  for (const item of problems) log(`  · ${item}`);
  /* 这句话必须出现在**失败**尾部，不只是成功提示里：失败时才是最需要看到它的时候，
   * 防止有人修完这几条静态项就当成"可以发版了"。 */
  log('  注意：修完这些静态项 ≠ 就能装 —— 最终判据是「在仓库外目录启动产物」。');
  process.exit(1);
}
ok('发布前门禁全部通过。');
log('  提醒：静态通过 ≠ 能启动，最终判据仍是「在仓库外目录启动产物」（npm run smoke / dist:dir 后拷到仓库外双击）。');
