#!/usr/bin/env node
/**
 * 版本一致性门禁（check:version）。
 *
 * 官方桌面端的做法是「一个 Desktop 版本号绑定 Electron 产物与精确依赖版本」。
 * 本仓库没有 upstream 同步，所以这里守住更基本但同样重要的事：
 *   ① package.json 的版本必须是合法 semver（更新器靠它比较新旧）；
 *   ② 版本只能有**一个来源** —— electron-builder.yml 里不得再写死 version；
 *   ③ 若 release/ 已有产物，产物名与渠道元数据里的版本必须和 package.json 一致。
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

/* 已有产物时做一次交叉校验：这是发布前最后一道人工遗漏的兜底。 */
const releaseDir = path.join(ROOT, 'release');
if (fs.existsSync(releaseDir)) {
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
