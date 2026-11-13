/**
 * 内置浏览器链路测试 —— Agent 能真的开网页（导航 + 读页面）。
 *
 * 覆盖：
 *   A. 地址规范化：只放行 http/https；Agent 侧禁私有网段，用户侧放行；
 *   B. browser_navigate 工具：真写会话浏览器状态（by=agent）；
 *   C. browser_read_page：读前端回传的页面快照；
 *   D. HTTP 集成：/api/conversations/:id/browser 与 /api/artifacts/:id/preview。
 *
 * 用法：npm run test:browser（独立端口 3013，隔离数据目录，不碰 3001 实例）。
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installAuthFetch } from './lib/session.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUN_DIR = mkdtempSync(path.join(tmpdir(), 'devwork-browser-'));
const DATA_DIR = path.join(RUN_DIR, 'data');
const SANDBOX_DIR = path.join(RUN_DIR, 'sandbox');
const PORT = Number(process.env.BROWSER_TEST_PORT ?? 3013);
const BASE = `http://127.0.0.1:${PORT}`;

/* 登录体系：这个用例直接裸 fetch 十几个端点，统一包一层补会话 Cookie，
 * 用的是配置文件里默认管理员的真实登录会话（不是后门）。 */
installAuthFetch(BASE);

/* 必须在 import 被测模块之前设置：config.ts 在模块加载时读 env。 */
process.env.DEVWORK_DATA_DIR = DATA_DIR;
process.env.DEVWORK_SANDBOX_DIR = SANDBOX_DIR;
process.env.DEVWORK_PORT = String(PORT);
process.env.DEVWORK_SCHEMA_PATH = path.join(ROOT, 'backend', 'src', 'db', 'schema.sql');

function bundle(entry, outfile) {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(ROOT, entry),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--outfile=${outfile}`,
      '--log-level=warning',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  return import(pathToFileURL(outfile).href);
}

let failed = 0;
let passed = 0;
const check = (name, ok, detail) => {
  if (ok) passed += 1; else failed += 1;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  if (!ok && detail !== undefined) console.log('   detail =', detail);
};

const identity = { name: '测试员', role: 'admin', org: 'DevWork', actor: 'user', source: 'user' };
const mod = await bundle('tests/browser-tool-entry.ts', path.join(RUN_DIR, 'bundle.mjs'));

mod.initDatabase(mod.seedIfEmpty);
mod.ensureAgentV9Assets();
mod.initDemoDatabase();
mod.bootstrapRepo();
mod.bootstrapArtifacts();

const convId = 'c-gmv';

/* ================= A. 地址规范化 ================= */
console.log('\n--- A. 地址规范化 ---');
{
  check('A1 缺省补 https://', mod.normalizeBrowserUrl('example.com').url === 'https://example.com/',
    mod.normalizeBrowserUrl('example.com').url);
  check('A2 file:// 被拒', mod.normalizeBrowserUrl('file:///C:/Windows/system.ini').ok === false);
  check('A3 javascript: 被拒', mod.normalizeBrowserUrl('javascript:alert(1)').ok === false);
  check('A4 data: 被拒', mod.normalizeBrowserUrl('data:text/html,<h1>x</h1>').ok === false);
  check('A5 Agent 侧禁本机（SSRF 入口）',
    mod.normalizeBrowserUrl('http://127.0.0.1:3001/api/health', { allowPrivate: false }).ok === false);
  check('A6 Agent 侧禁内网',
    mod.normalizeBrowserUrl('http://10.0.0.8/admin', { allowPrivate: false }).ok === false);
  check('A7 用户侧放行本机（用户自己的自由度）',
    mod.normalizeBrowserUrl('http://127.0.0.1:3001/api/health', { allowPrivate: true }).ok === true);
  check('A8 空地址被拒', mod.normalizeBrowserUrl('   ').ok === false);
}

/* ================= B. browser_navigate 工具 ================= */
console.log('\n--- B. browser_navigate 工具 ---');
{
  const face = mod.deriveToolFace('w-ops');
  const tool = face.all.find((t) => t.name === 'browser_navigate');
  check('B0 browser_navigate 在派生工具面内（跨资产通用，不依赖具体资产）', !!tool, face.all.map((t) => t.name).join(','));

  const ctx = { assetId: 'w-ops', workspaceId: 'w-ops', conversationId: convId, identity };
  const ok = await mod.executeAgentTool('browser_navigate', { url: 'https://example.com/docs' }, tool, ctx);
  check('B1 导航成功（工具返回 ok）', ok.ok === true, ok.result?.slice(0, 120));

  const state = mod.readBrowserState(convId);
  check('B2 会话浏览器状态被真写入（url + by=agent）',
    state.url === 'https://example.com/docs' && state.by === 'agent',
    JSON.stringify(state));

  const denied = await mod.executeAgentTool('browser_navigate', { url: 'http://192.168.1.10/' }, tool, ctx);
  check('B3 私有网段被工具层拒绝（ok=false 且状态未变）',
    denied.ok === false && mod.readBrowserState(convId).url === 'https://example.com/docs',
    denied.result?.slice(0, 120));
}

/* ================= C. browser_read_page ================= */
console.log('\n--- C. browser_read_page ---');
{
  const tool = mod.deriveToolFace('w-ops').all.find((t) => t.name === 'browser_read_page');
  const ctx = { assetId: 'w-ops', workspaceId: 'w-ops', conversationId: convId, identity };

  const empty = await mod.executeAgentTool('browser_read_page', {}, tool, ctx);
  check('C1 没有页面快照时如实报错（不编造内容）', empty.ok === false, empty.result?.slice(0, 120));

  mod.writeBrowserPage(convId, '示例文档', '这是页面正文的第一段。');
  const read = await mod.executeAgentTool('browser_read_page', {}, tool, ctx);
  check('C2 读到前端回传的标题与正文',
    read.ok === true && read.result.includes('示例文档') && read.result.includes('页面正文的第一段'),
    read.result?.slice(0, 160));

  const page = mod.readBrowserPage(convId);
  check('C3 页面快照带抓取时间', page.capturedAt.length > 0 && page.url === 'https://example.com/docs', JSON.stringify(page));
}

/* ================= D. HTTP 集成 ================= */
console.log('\n--- D. HTTP 集成 ---');
{
  const server = spawn(process.execPath, [
    path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(ROOT, 'backend', 'src', 'index.ts'),
  ], {
    cwd: ROOT,
    env: { ...process.env, DEVWORK_DATA_DIR: DATA_DIR, DEVWORK_SANDBOX_DIR: SANDBOX_DIR, DEVWORK_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverLog = '';
  server.stdout.on('data', (c) => { serverLog += c.toString(); });
  server.stderr.on('data', (c) => { serverLog += c.toString(); });

  const waitReady = async () => {
    for (let i = 0; i < 40; i += 1) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) return true;
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  };

  const ready = await waitReady();
  check('D0 后端启动', ready, serverLog.slice(-400));

  if (ready) {
    const browserRes = await fetch(`${BASE}/api/conversations/${convId}/browser`);
    const browserJson = await browserRes.json();
    check('D1 GET /browser 返回会话地址', browserJson.ok === true && browserJson.data.url === 'https://example.com/docs',
      JSON.stringify(browserJson).slice(0, 200));

    const setRes = await fetch(`${BASE}/api/conversations/${convId}/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '127.0.0.1:3001' }),
    });
    const setJson = await setRes.json();
    check('D2 POST /browser 规范化地址（补 scheme）并标记 by=user',
      setJson.ok === true && setJson.data.url === 'http://127.0.0.1:3001/' && setJson.data.by === 'user',
      JSON.stringify(setJson).slice(0, 200));

    const badRes = await fetch(`${BASE}/api/conversations/${convId}/browser`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });
    check('D3 POST /browser 拒绝 file://（422）', badRes.status === 422, `status=${badRes.status}`);

    const pageRes = await fetch(`${BASE}/api/conversations/${convId}/browser/page`);
    const pageJson = await pageRes.json();
    check('D4 GET /browser/page 返回页面快照',
      pageJson.ok === true && pageJson.data.text.includes('页面正文的第一段'),
      JSON.stringify(pageJson).slice(0, 200));

    const prevRes = await fetch(`${BASE}/api/artifacts/gmv_trend.png/preview`);
    const prevJson = await prevRes.json();
    check('D5 产物预览：PNG 判为 image 并给可直连 URL',
      prevJson.ok === true && prevJson.data.kind === 'image' && typeof prevJson.data.url === 'string',
      JSON.stringify(prevJson).slice(0, 200));

    const missingRes = await fetch(`${BASE}/api/artifacts/does-not-exist/preview`);
    check('D6 产物不存在如实 404', missingRes.status === 404, `status=${missingRes.status}`);
  }

  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 600));
  server.kill('SIGKILL');
}

console.log(`\n浏览器链路测试：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
