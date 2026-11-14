/**
 * 本地工作区仓库链路黑盒测试 —— 「代码库 = 克隆到本地」端到端验证。
 *
 * 覆盖：
 *   1. 真实 git clone 到**按项目隔离**的本地目录（workspaces/<项目>/<仓库>）
 *   2. 仓库状态、文件树、文件内容、大纲、git 摘要全部来自克隆后的真实文件
 *   3. 克隆后自动重建索引，检索能命中克隆来的内容
 *   4. 两个工作区的仓库互不串味（A 项目看不到 B 项目的文件）
 *   5. 换了远端地址 → 落到新目录，不覆盖旧仓库
 *   6. 敏感文件不进文件树（12 条规则仍生效）
 *   7. 路径越界被拒绝（.. 与绝对路径）
 *
 * 仅使用 Node 内置模块，零新增依赖。
 * 运行：node tests/repo-clone.mjs（需先起好被测实例并给出 DEVWORK_BASE）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adminCookie } from './lib/session.mjs';
import { withWorkspace } from './lib/workspace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.DEVWORK_BASE ?? 'http://127.0.0.1:3001';
const API = `${BASE}/api`;
const SANDBOX_DIR = process.env.DEVWORK_SANDBOX_DIR ?? path.join(ROOT, 'backend', '.runtime', 'sandbox');
const WORKSPACES_DIR = path.join(SANDBOX_DIR, 'workspaces');

let passed = 0;
let failed = 0;
const failures = [];

function check(group, name, expected, actual, ok, note = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${group} :: ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
  if (note) console.log(`       备注: ${note}`);
  if (ok) passed += 1;
  else {
    failed += 1;
    failures.push({ group, name, expected, actual, note });
  }
}

/**
 * 资产 → 所属工作区。
 *
 * 工作区 id 是运行时新建的（不是固定值），资产建出来后登记到这里，
 * call() 据此给资产级请求补上 workspaceId —— 后端守卫缺省即拒。
 */
const ASSET_WORKSPACE = new Map();

async function call(method, urlPath, body, headers = {}, timeoutMs = 120000) {
  const init = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const target = withWorkspace(urlPath, (assetId) => ASSET_WORKSPACE.get(assetId) ?? '');
  const res = await fetch(API + target, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应按原文处理 */ }
  return { status: res.status, json, text };
}

/** 建一个本地 git 仓库作为克隆源（file:// 协议，不依赖网络）。 */
function makeSourceRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  Object.entries(files).forEach(([rel, content]) => {
    const absolute = path.join(dir, rel);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  });
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore', timeout: 20000 });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@localhost']);
  git(['config', 'user.name', 'DevWork Test']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'chore: seed source repo']);
  /* Windows 上 file:// URL 需要正斜杠绝对路径。 */
  const url = `file:///${dir.replace(/\\/g, '/').replace(/^\//, '')}`;
  return { dir, url };
}

async function main() {
  const stamp = Date.now();

  /* ---- 准备：两个项目 + 两个源仓库 ---- */
  const srcA = makeSourceRepo(path.join(SANDBOX_DIR, 'test-src', `repo-a-${stamp}`), {
    'src/main/App.java': 'package demo;\npublic class App {\n  public static void main(String[] args) {\n    System.out.println("alpha-unique-token");\n  }\n}\n',
    'README.md': '# repo-a\n\n这是克隆到本地的第一个仓库。\n',
    'config/app.yml': 'server:\n  port: 8080\n',
    '.env': 'SECRET_TOKEN=should-not-be-indexed\n',
  });
  const srcB = makeSourceRepo(path.join(SANDBOX_DIR, 'test-src', `repo-b-${stamp}`), {
    'src/lib/Beta.java': 'package demo;\npublic class Beta {\n  void run() { System.out.println("beta-unique-token"); }\n}\n',
    'README.md': '# repo-b\n\n第二个仓库，属于另一个项目。\n',
  });

  for (const name of ['克隆测试项目A', '克隆测试项目B']) {
    const created = await call('POST', '/workspaces', { name, description: '仓库克隆链路测试' });
    if (created.status !== 200 || !created.json?.data?.id) {
      check('准备', `创建项目 ${name}`, 'HTTP 200 且返回 id', `${created.status} ${created.text.slice(0, 120)}`, false);
      return;
    }
  }
  /* 工作区 id 由服务端生成：取回刚建的两个项目 id。 */
  const wsList = await call('GET', '/workspaces');
  const workspaces = Array.isArray(wsList.json?.data) ? wsList.json.data : [];
  const wsA = workspaces.find((w) => w.name === '克隆测试项目A')?.id ?? '';
  const wsB = workspaces.find((w) => w.name === '克隆测试项目B')?.id ?? '';
  check('准备', '两个测试项目已创建', '两个不同的项目 id', `A=${wsA} B=${wsB}`, Boolean(wsA && wsB && wsA !== wsB));

  /* ---- 1. 建 code 资产 ---- */
  const assetA = await call('POST', '/assets', { workspaceId: wsA, type: 'code', name: 'repo-a', env: 'dev' });
  const assetB = await call('POST', '/assets', { workspaceId: wsB, type: 'code', name: 'repo-b', env: 'dev' });
  const idA = assetA.json?.data?.id ?? '';
  const idB = assetB.json?.data?.id ?? '';
  check('准备', '创建两个 code 资产', '各返回资产 id', `A=${idA} B=${idB}`, Boolean(idA && idB));
  /* 登记归属：后续资产级请求据此带对 workspaceId（后端守卫缺省即拒）。 */
  if (idA) ASSET_WORKSPACE.set(idA, wsA);
  if (idB) ASSET_WORKSPACE.set(idB, wsB);

  /* ---- 2. 真实 clone ---- */
  const cloneA = await call('POST', `/assets/${idA}/clone`, { url: srcA.url, depth: 1 });
  const cloneData = cloneA.json?.data ?? {};
  check(
    '克隆',
    'A 项目真实 git clone 成功',
    'HTTP 200 · action=cloned · 分支与提交非空',
    `${cloneA.status} action=${cloneData.action} branch=${cloneData.branch} commit=${cloneData.commit}`,
    cloneA.status === 200 && cloneData.action === 'cloned' && Boolean(cloneData.branch) && Boolean(cloneData.commit),
  );
  check(
    '克隆',
    '本地目录按项目隔离',
    `workspaces/${wsA}/<仓库> 下存在`,
    cloneData.localPath ?? '—',
    typeof cloneData.localPath === 'string'
      && cloneData.localPath.startsWith(`${wsA}/`)
      && fs.existsSync(path.join(WORKSPACES_DIR, cloneData.localPath, '.git')),
  );
  check(
    '克隆',
    '克隆后自动重建索引',
    'chunks > 0 且 files > 0',
    `chunks=${cloneData.index?.chunks} files=${cloneData.index?.files}`,
    Number(cloneData.index?.chunks) > 0 && Number(cloneData.index?.files) > 0,
  );

  /* ---- 3. 仓库状态 ---- */
  const status = await call('GET', `/assets/${idA}/repo`);
  const st = status.json?.data ?? {};
  check(
    '仓库状态',
    '返回本地路径 / 远端 / 分支 / 提交 / 文件数',
    'cloned=true · 本地路径存在 · 远端非空 · 文件数 > 0',
    `cloned=${st.cloned} localPath=${st.localPath} cloneUrl=${st.cloneUrl} branch=${st.branch} files=${st.files}`,
    st.cloned === true
      && Boolean(st.localPath)
      && Boolean(st.cloneUrl)
      && Boolean(st.branch)
      && Number(st.files) > 0,
  );
  check(
    '仓库状态',
    '远端地址已脱敏（不含凭据）',
    'cloneUrl 不含 @ 密码段',
    String(st.cloneUrl),
    !String(st.cloneUrl).includes('@') || /\*\*\*/.test(String(st.cloneUrl)),
  );

  /* ---- 4. 文件树 / 内容 / 大纲 / git ---- */
  const tree = await call('GET', `/assets/${idA}/files/tree`);
  const nodes = Array.isArray(tree.json?.data) ? tree.json.data : [];
  const paths = nodes.filter((n) => n.isFile).map((n) => n.path);
  check(
    '文件树',
    '只含克隆来的真实文件',
    '含 README.md 与 config/app.yml',
    `files=${paths.slice(0, 8).join(', ')}`,
    paths.includes('README.md') && paths.includes('config/app.yml'),
  );
  check(
    '文件树',
    '敏感文件不进树',
    '.env 不可见',
    paths.includes('.env') ? '可见（违规）' : '不可见',
    !paths.includes('.env'),
  );

  const content = await call('GET', `/assets/${idA}/files/content?path=${encodeURIComponent('src/main/App.java')}`);
  const plain = String(content.json?.data?.plain ?? '');
  check(
    '文件内容',
    '读到克隆仓库的真实源码',
    '包含 alpha-unique-token',
    plain.replace(/\n/g, '\\n').slice(0, 90),
    plain.includes('alpha-unique-token'),
  );

  const outline = await call('GET', `/assets/${idA}/files/outline?path=${encodeURIComponent('src/main/App.java')}`);
  const symbols = outline.json?.data?.symbols ?? [];
  check(
    '文件大纲',
    '符号来自克隆文件',
    '含 App',
    symbols.map((s) => s.label).join(', '),
    symbols.some((s) => String(s.label).includes('App')),
  );

  const gitSum = await call('GET', `/assets/${idA}/files/git`);
  check(
    'git 摘要',
    '分支与提交来自克隆仓库的 .git',
    'branch 非空 · lastCommit 非空',
    `branch=${gitSum.json?.data?.branch} lastCommit=${gitSum.json?.data?.lastCommit}`,
    Boolean(gitSum.json?.data?.branch) && Boolean(gitSum.json?.data?.lastCommit),
  );

  /* ---- 5. 检索命中克隆内容 ---- */
  const search = await call('GET', `/assets/${idA}/search?q=${encodeURIComponent('alpha-unique-token')}`);
  const hits = search.json?.data?.hits ?? search.json?.data ?? [];
  const hitList = Array.isArray(hits) ? hits : [];
  check(
    '检索',
    '索引能命中克隆来的内容',
    '命中 App.java',
    hitList.map((h) => `${h.path}:${h.startLine ?? ''}`).slice(0, 3).join(', ') || '(无命中)',
    hitList.some((h) => String(h.path ?? '').includes('App.java')),
  );

  /* ---- 6. 工作区隔离 ---- */
  const cloneB = await call('POST', `/assets/${idB}/clone`, { url: srcB.url, depth: 1 });
  const treeB = await call('GET', `/assets/${idB}/files/tree`);
  const pathsB = (Array.isArray(treeB.json?.data) ? treeB.json.data : [])
    .filter((n) => n.isFile).map((n) => n.path);
  check(
    '隔离',
    'B 项目克隆到自己的目录',
    `localPath 以 ${wsB}/ 开头`,
    cloneB.json?.data?.localPath ?? '—',
    String(cloneB.json?.data?.localPath ?? '').startsWith(`${wsB}/`),
  );
  check(
    '隔离',
    'B 项目看不到 A 项目的文件',
    '不含 App.java · 含 Beta.java',
    pathsB.slice(0, 8).join(', '),
    !pathsB.includes('src/main/App.java') && pathsB.includes('src/lib/Beta.java'),
  );
  const treeAAgain = await call('GET', `/assets/${idA}/files/tree`);
  const pathsAAgain = (Array.isArray(treeAAgain.json?.data) ? treeAAgain.json.data : [])
    .filter((n) => n.isFile).map((n) => n.path);
  check(
    '隔离',
    'A 项目仍只看到自己的文件',
    '含 App.java · 不含 Beta.java',
    pathsAAgain.slice(0, 8).join(', '),
    pathsAAgain.includes('src/main/App.java') && !pathsAAgain.includes('src/lib/Beta.java'),
  );

  /* ---- 7. 换远端 → 新目录，不覆盖旧仓库 ---- */
  const srcC = makeSourceRepo(path.join(SANDBOX_DIR, 'test-src', `repo-c-${stamp}`), {
    'src/C.java': 'public class C {}\n',
  });
  const cloneC = await call('POST', `/assets/${idA}/clone`, { url: srcC.url, depth: 1 });
  const localC = String(cloneC.json?.data?.localPath ?? '');
  check(
    '换仓库',
    '换了远端地址落到新目录',
    `localPath != ${cloneData.localPath} · 且目录真实存在`,
    `${localC}`,
    localC !== '' && localC !== cloneData.localPath
      && fs.existsSync(path.join(WORKSPACES_DIR, localC, '.git')),
  );
  check(
    '换仓库',
    '旧仓库目录未被覆盖',
    '旧目录仍在且仍是 git 仓库',
    cloneData.localPath,
    fs.existsSync(path.join(WORKSPACES_DIR, String(cloneData.localPath), '.git')),
  );

  /* ---- 8. 路径越界 ---- */
  const escape = await call('GET', `/assets/${idA}/files/content?path=${encodeURIComponent('../../../etc/passwd')}`);
  check(
    '安全',
    '.. 路径越界被拒绝',
    '非 200 或 E_PATH_ESCAPE',
    `${escape.status} ${escape.json?.error?.code ?? ''}`,
    escape.status !== 200 || escape.json?.error?.code === 'E_PATH_ESCAPE',
  );
  const absolute = await call('GET', `/assets/${idA}/files/content?path=${encodeURIComponent('C:/Windows/win.ini')}`);
  check(
    '安全',
    '绝对路径被拒绝',
    '非 200 或 E_PATH_ESCAPE',
    `${absolute.status} ${absolute.json?.error?.code ?? ''}`,
    absolute.status !== 200 || absolute.json?.error?.code === 'E_PATH_ESCAPE',
  );

  /* ---- 9. 审计留痕 ---- */
  const audit = await call('GET', '/audit?pageSize=100');
  const auditItems = audit.json?.data?.items ?? [];
  const auditText = JSON.stringify(auditItems);
  check(
    '审计',
    '克隆动作写入审计',
    '含 repo.clone',
    auditText.includes('repo.clone')
      ? '含 repo.clone'
      : auditItems.slice(0, 3).map((a) => a.action).join(', ') || '(空)',
    auditText.includes('repo.clone'),
  );

  /* ---- 汇总 ---- */
  console.log('\n========== 汇总 ==========');
  console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
  if (failed > 0) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log(` - [${f.group}] ${f.name} · 期望 ${f.expected} · 实际 ${f.actual}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('测试执行异常：', error);
  process.exit(1);
});
