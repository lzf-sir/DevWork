#!/usr/bin/env node
/**
 * 版本一致性门禁（check:version）。
 *
 * 官方桌面端的做法是「一个 Desktop 版本号绑定 Electron 产物与精确依赖版本」。
 * 本仓库没有 upstream 同步，所以这里守住更基本但同样重要的事：
 *   ① package.json 的版本必须是合法 semver（更新器靠它比较新旧）；
 *   ② 版本只能有**一个来源** —— electron-builder.yml 里不得再写死 version；
 *   ③ 若 release/ 已有产物，产物名与渠道元数据里的版本必须和 package.json 一致；
 *   ④ 源码（backend/src、frontend/src）里不得残留旧版本号字面量 ——
 *      历史上一处硬编码就能让 1.0.0 的包对外报 0.4.2。
 *
 * 用法：node scripts/check-version.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, log, ok, title, warn } from './lib/common.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

title('版本一致性检查');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(manifest.version ?? '');

if (!SEMVER.test(version)) {
  fail(`package.json 版本 "${version}" 不是合法 semver —— 自动更新会判不出新旧。`);
  process.exit(1);
}
ok(`当前版本 ${version}`);

/* electron-builder.yml 不允许再写 version：两处版本是更新器出错的头号来源。 */
const ymlPath = path.join(ROOT, 'electron-builder.yml');
if (fs.existsSync(ymlPath)) {
  const yml = fs.readFileSync(ymlPath, 'utf8');
  if (/^\s*version\s*:/m.test(yml)) {
    fail('electron-builder.yml 里出现了 version 字段 —— 版本请只保留 package.json 一处。');
    process.exit(1);
  }
  ok('electron-builder.yml 未硬编码版本');
}

/* ---------------------------------------------------------------
 * 源码里不得残留旧版本号字面量。
 *
 * 为什么需要这一段：check-version 原先只校验
 * package.json ↔ electron-builder.yml ↔ release feed，
 * 于是 `routes/system.ts`（/api/health）、`db/seed.ts`（setting.about）、
 * `api/mock.ts` 三处硬编码的 0.4.2 一路发进了 1.0.0 的包 —— 对外报旧版本，
 * 门禁却全绿。「一个数字出现在三个地方，就等于它出现在零个地方。」
 *
 * 判据：先**剥掉注释**再扫。注释里写「历史上这里是 0.4.2」是有效的历史说明，
 * 不算硬编码；不然为了过门禁就得删掉有价值的上下文。
 * 剥注释时用等长空白替换（保留换行），行号才对得上原文。
 * --------------------------------------------------------------- */
const LEGACY_VERSION = '0.4.2';
const SCAN_DIRS = [path.join(ROOT, 'backend', 'src'), path.join(ROOT, 'frontend', 'src')];

/** 去掉块注释与行注释，保持字符数与换行位置不变（行号可原样报出）。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    /* 行注释：前面不是 ':' 才算（避免把 http:// 当成注释开头）。 */
    .replace(/(^|[^:])\/\/[^\n]*/g, (line, prefix) => prefix + ' '.repeat(line.length - prefix.length));
}

function collectSources(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSources(full, out);
    else if (/\.(ts|tsx)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const legacyHits = [];
for (const file of SCAN_DIRS.flatMap((dir) => collectSources(dir))) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.includes(LEGACY_VERSION)) continue;
  const stripped = stripComments(raw);
  const index = stripped.indexOf(LEGACY_VERSION);
  if (index < 0) continue;
  const line = stripped.slice(0, index).split('\n').length;
  legacyHits.push(`${path.relative(ROOT, file)}:${line}`);
}

if (legacyHits.length > 0) {
  fail(`源码里仍有旧版本号 ${LEGACY_VERSION}（版本必须只有一个来源）：`);
  for (const hit of legacyHits) log(`  · ${hit}`);
  log('  处理办法：改成从 config/version.ts 的 APP_VERSION 派生（前端用 __APP_VERSION__）。');
  process.exit(1);
}
ok(`源码无旧版本号残留（${LEGACY_VERSION}）`);

/* 已有产物时做一次交叉校验：这是发布前最后一道人工遗漏的兜底。 */
const releaseDir = path.join(ROOT, 'release');if (fs.existsSync(releaseDir)) {
  const exes = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.exe')) exes.push(entry.name);
    }
  };
  walk(releaseDir);

  const stale = exes.filter((name) => {
    const match = name.match(/DevWork(?:-Setup)?-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win-/);
    return match && match[1] !== version;
  });
  if (stale.length > 0) {
    warn(`release/ 下存在其他版本的产物（不影响本次打包，但别误发）：`);
    for (const name of stale) log(`  · ${name}`);
  }

  const feed = ['stable.yml', 'latest.yml']
    .map((name) => path.join(releaseDir, name))
    .find((file) => fs.existsSync(file));
  if (feed) {
    const text = fs.readFileSync(feed, 'utf8');
    const match = text.match(/^version:\s*(\S+)/m);
    if (match && match[1] !== version) {
      fail(`渠道元数据 ${path.basename(feed)} 里的版本是 ${match[1]}，与 package.json 的 ${version} 不一致。`);
      process.exit(1);
    }
    ok(`渠道元数据版本一致（${path.basename(feed)}）`);
  }
}

ok('版本检查通过');
