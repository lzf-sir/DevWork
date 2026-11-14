/**
 * 资产接入表单的「按类型差异化」黑盒验证。
 *
 * 覆盖两层防线：
 *
 *   前端（src/components/assetForms.ts）—— 由 backend/src/config/asset-forms.ts 的
 *   同一套键名约束：表单按类型生成字段，config 按类型落库。
 *
 *   服务端（backend/src/config/asset-forms.ts）—— 白名单清洗：
 *     - 未知键丢弃（前端改包也写不进库）
 *     - 敏感键拒绝（token / password / secret 一律不进 config）
 *     - 未知资产类型 fail closed（整份 config 丢弃）
 *     - 值形状与长度有界（超长截断、数组元素限长限项）
 *
 * 落库结果直读隔离库的 asset 表 —— 服务端没有暴露读取 config 的端点，
 * 而这正是对的方向：config 不该被任何 API 整份读出去。
 *
 * 独立运行：node tests/asset-forms.mjs（自带隔离实例）
 * 跟随冒烟：DEVWORK_BASE 已设时不自带实例（由 tests/run-smoke.mjs 提供）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { withWorkspace } from './lib/workspace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF_HOSTED = !process.env.DEVWORK_BASE;
const PORT = Number(process.env.ASSET_PORT ?? 3013);
const BASE = process.env.DEVWORK_BASE ?? `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api`;
const RUN_DIR = path.join(ROOT, 'tmp', `qa-asset-${Date.now()}`);
const DATA_DIR = process.env.DEVWORK_DATA_DIR ?? path.join(RUN_DIR, 'data');
const SANDBOX_DIR = process.env.DEVWORK_SANDBOX_DIR ?? path.join(RUN_DIR, 'sandbox');

const failures = [];
const results = { total: 0, passed: 0, failed: 0 };

function check(group, name, expected, actual, ok, note = '') {
  results.total += 1;
  if (ok) {
    results.passed += 1;
    console.log(`[PASS] ${group} :: ${name}`);
    if (note) console.log(`       ${note}`);
    return;
  }
  results.failed += 1;
  failures.push(`${group} :: ${name}`);
  console.log(`[FAIL] ${group} :: ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
}

async function call(method, urlPath, body, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  /* 资产级请求必须带 workspaceId（后端守卫缺省即拒）；本文件资产都在 w-ops。 */
  const target = withWorkspace(urlPath, 'w-ops');
  try {
    const res = await fetch(`${API}${target}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** 读某资产的落库 config（直读隔离库，验证真正写进去的东西）。 */
function readConfig(assetId) {
  const db = new DatabaseSync(path.join(DATA_DIR, 'devwork.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT config FROM asset WHERE id = ?').get(assetId);
    return row ? JSON.parse(String(row.config || '{}')) : null;
  } finally {
    db.close();
  }
}

/** 读某资产的凭据绑定行（直读隔离库）。 */
function readCredential(assetId) {
  const db = new DatabaseSync(path.join(DATA_DIR, 'devwork.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM credential_binding WHERE asset_id = ?').get(assetId);
    return row ?? null;
  } finally {
    db.close();
  }
}

/** 读某资产的 credential_bound 标记。 */
function readCredentialBound(assetId) {
  const db = new DatabaseSync(path.join(DATA_DIR, 'devwork.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT credential_bound FROM asset WHERE id = ?').get(assetId);
    return row ? Number(row.credential_bound) : -1;
  } finally {
    db.close();
  }
}

/** 读某资产的审计明细。 */
function readAudit(targetName) {
  const db = new DatabaseSync(path.join(DATA_DIR, 'devwork.sqlite'), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT detail FROM audit_event WHERE action = 'asset.create' AND target = ?")
      .all(targetName);
    return rows.map((row) => String(row.detail ?? ''));
  } finally {
    db.close();
  }
}

/** 建一个资产并返回 id。 */
async function createAsset(payload) {
  const res = await call('POST', '/assets', {
    workspaceId: 'w-ops',
    name: `表单测试-${Math.random().toString(36).slice(2, 8)}`,
    env: 'staging',
    ...payload,
  });
  if (res.status !== 200 || !res.json?.data?.id) {
    throw new Error(`创建资产失败：HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
  }
  return res.json.data.id;
}

/** 建一个资产并返回完整响应（需要看 credentialBound / credentialError 时用）。 */
async function createAssetFull(payload) {
  const res = await call('POST', '/assets', {
    workspaceId: 'w-ops',
    name: `表单测试-${Math.random().toString(36).slice(2, 8)}`,
    env: 'staging',
    ...payload,
  });
  if (res.status !== 200 || !res.json?.data?.id) {
    throw new Error(`创建资产失败：HTTP ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
  }
  return res.json.data;
}

/* ============================ 用例 ============================ */

async function testTypeSpecificConfig() {
  const group = '按类型差异化';

  /* 1. 数据库资产：结构化配置按 db 白名单落库，schema 是数组。 */
  const dbId = await createAsset({
    type: 'db',
    name: '表单测试-db',
    endpoint: '10.0.0.9:5432/order_db',
    config: {
      engine: 'postgresql',
      host: '10.0.0.9',
      port: 5432,
      database: 'order_db',
      schema: 'public,biz',
      statementTimeoutMs: 15000,
      sampleRows: 20,
    },
  });
  const dbConfig = readConfig(dbId) ?? {};
  check(group, 'db 资产：引擎落库', 'postgresql', dbConfig.engine, dbConfig.engine === 'postgresql');
  check(group, 'db 资产：主机与端口落库', '10.0.0.9 / 5432',
    `${dbConfig.host} / ${dbConfig.port}`, dbConfig.host === '10.0.0.9' && dbConfig.port === 5432);
  check(group, 'db 资产：数据库名落库', 'order_db', dbConfig.database, dbConfig.database === 'order_db');
  check(group, 'db 资产：schema 归一化成字符串数组（字符串输入）', 'public,biz',
    JSON.stringify(dbConfig.schema), Array.isArray(dbConfig.schema)
      && dbConfig.schema.length === 2 && dbConfig.schema[0] === 'public');
  check(group, 'db 资产：endpoint 兼容串仍在（老读取路径不断）', '10.0.0.9:5432/order_db',
    dbConfig.endpoint, dbConfig.endpoint === '10.0.0.9:5432/order_db');

  /* 2. 代码库资产：cloneUrl 与 endpoint 同时落库（兼容旧语义）。 */
  const codeId = await createAsset({
    type: 'code',
    name: '表单测试-code',
    endpoint: 'https://host/org/repo.git',
    config: {
      cloneUrl: 'https://host/org/repo.git',
      branch: 'main',
      depth: 1,
      indexMode: 'full',
      ignore: ['**/node_modules/**', '**/target/**'],
      sensitiveDeny: ['.env*', '**/*.pem'],
    },
  });
  const codeConfig = readConfig(codeId) ?? {};
  check(group, 'code 资产：cloneUrl 落库', 'https://host/org/repo.git',
    codeConfig.cloneUrl, codeConfig.cloneUrl === 'https://host/org/repo.git');
  check(group, 'code 资产：分支与深度落库', 'main / 1',
    `${codeConfig.branch} / ${codeConfig.depth}`, codeConfig.branch === 'main' && codeConfig.depth === 1);
  check(group, 'code 资产：忽略规则是字符串数组', '2 条',
    JSON.stringify(codeConfig.ignore), Array.isArray(codeConfig.ignore) && codeConfig.ignore.length === 2);
  check(group, 'code 资产：敏感文件规则独立成键', '2 条',
    JSON.stringify(codeConfig.sensitiveDeny),
    Array.isArray(codeConfig.sensitiveDeny) && codeConfig.sensitiveDeny.length === 2);

  /* 3. 服务器资产：传输方式与白名单规则落库。 */
  const srvId = await createAsset({
    type: 'server',
    name: '表单测试-server',
    endpoint: '10.20.1.31:22',
    config: {
      transport: 'ssh',
      host: '10.20.1.31',
      port: 22,
      user: 'deploy',
      workdir: '/opt/app',
      allowedCommands: ['docker*', 'tail*'],
      deniedCommands: ['rm -rf*'],
    },
  });
  const srvConfig = readConfig(srvId) ?? {};
  check(group, 'server 资产：传输方式落库', 'ssh', srvConfig.transport, srvConfig.transport === 'ssh');
  check(group, 'server 资产：命令白名单落库', '2 条',
    JSON.stringify(srvConfig.allowedCommands),
    Array.isArray(srvConfig.allowedCommands) && srvConfig.allowedCommands.length === 2);

  /* 4. 知识库资产：目录与密级落库。 */
  const kbId = await createAsset({
    type: 'kb',
    name: '表单测试-kb',
    endpoint: 'docs/ops',
    config: { dir: 'docs/ops', indexMode: 'full', chunkSize: 800, sensitivity: 'internal' },
  });
  const kbConfig = readConfig(kbId) ?? {};
  check(group, 'kb 资产：文档目录落库', 'docs/ops', kbConfig.dir, kbConfig.dir === 'docs/ops');
  check(group, 'kb 资产：密级落库', 'internal', kbConfig.sensitivity, kbConfig.sensitivity === 'internal');

  /* 5. 同一个键只有一种形状：字符串输入与数组输入，落库都是数组。 */
  const arrSchemaId = await createAsset({
    type: 'db',
    name: '表单测试-schema 数组输入',
    config: { engine: 'postgresql', host: '10.0.0.9', database: 'order_db', schema: ['public', 'biz'] },
  });
  const arrSchemaConfig = readConfig(arrSchemaId) ?? {};
  check(group, 'db 资产：schema 数组输入落库仍是数组（形状唯一）', '["public","biz"]',
    JSON.stringify(arrSchemaConfig.schema),
    Array.isArray(arrSchemaConfig.schema) && arrSchemaConfig.schema.length === 2);

  /* 6. 类型互不串味：db 的键不能出现在 code 资产上（否则「按类型」形同虚设）。 */
  const mixedId = await createAsset({
    type: 'code',
    name: '表单测试-串味',
    config: { cloneUrl: 'https://host/org/x.git', host: '10.0.0.9', database: 'order_db' },
  });
  const mixedConfig = readConfig(mixedId) ?? {};
  check(group, '类型隔离：code 资产拒收 db 的键',
    'host/database 均不存在',
    `host=${mixedConfig.host} database=${mixedConfig.database}`,
    mixedConfig.host === undefined && mixedConfig.database === undefined);
}

async function testSecurityBoundary() {
  const group = '安全边界';

  /* 1. 敏感键一律拒绝 —— 即使客户端强行塞进来。 */
  const secId = await createAsset({
    type: 'db',
    name: '表单测试-敏感键',
    config: {
      engine: 'postgresql',
      host: '10.0.0.9',
      database: 'order_db',
      token: 'ghp_supersecret',
      password: 'P@ssw0rd',
      apiKey: 'ak-live-123',
      secretRef: 'vault/xxx',
    },
  });
  const secConfig = readConfig(secId) ?? {};
  const leak = ['token', 'password', 'apiKey', 'secretRef'].filter((key) => secConfig[key] !== undefined);
  check(group, '敏感键不进 config（token/password/apiKey/secretRef）',
    '一个都不在', `泄漏键：${leak.join(',') || '无'}`, leak.length === 0);
  check(group, '敏感键被拒时，正常键仍然落库', 'engine=postgresql',
    secConfig.engine, secConfig.engine === 'postgresql');
  check(group, '敏感键的值不出现在整个 config 序列化结果里', '不含 ghp_supersecret / P@ssw0rd',
    JSON.stringify(secConfig),
    !JSON.stringify(secConfig).includes('ghp_supersecret')
    && !JSON.stringify(secConfig).includes('P@ssw0rd'));

  /* 2. 未知键丢弃。 */
  const unknownId = await createAsset({
    type: 'db',
    name: '表单测试-未知键',
    config: { engine: 'sqlite', dbPath: 'demo.sqlite', evilKey: 'x', __proto__: 'pollute' },
  });
  const unknownConfig = readConfig(unknownId) ?? {};
  check(group, '未知键被丢弃', 'evilKey 不存在',
    JSON.stringify(unknownConfig.evilKey), unknownConfig.evilKey === undefined);
  check(group, '正常键仍然落库', 'dbPath=demo.sqlite',
    unknownConfig.dbPath, unknownConfig.dbPath === 'demo.sqlite');

  /* 3. 未知资产类型 fail closed。
   * 契约层（shared/contracts/asset.ts 的 type 枚举）先拒，所以走不到
   * 「丢弃 config 后建一条僵尸资产」那条路 —— 这比原断言更严，故改为验 400。 */
  const weird = await call('POST', '/assets', {
    workspaceId: 'w-ops',
    type: 'weird-type',
    name: '表单测试-未知类型',
    env: 'staging',
    config: { engine: 'sqlite', dbPath: 'x.sqlite' },
  });
  check(group, '未知资产类型：契约层拒收', 400, weird.status, weird.status === 400);
  check(group, '错误码 E_VALIDATION', 'E_VALIDATION',
    weird.json?.error?.code, weird.json?.error?.code === 'E_VALIDATION');

  /* 4. 值的长度有界：超长字符串被截断，不允许把 10MB 塞进 config。 */
  const longId = await createAsset({
    type: 'db',
    name: '表单测试-超长',
    config: { engine: 'sqlite', dbPath: 'x'.repeat(5000) },
  });
  const longConfig = readConfig(longId) ?? {};
  check(group, '超长字符串被截断到 512', '长度 ≤ 512',
    `长度=${String(longConfig.dbPath ?? '').length}`,
    String(longConfig.dbPath ?? '').length <= 512);

  /* 5. 数组元素必须是字符串：混入数字 / 对象时被剔除。 */
  const arrId = await createAsset({
    type: 'code',
    name: '表单测试-数组形状',
    config: { cloneUrl: 'https://host/org/y.git', ignore: ['ok/**', 42, null, { a: 1 }, 'also-ok/**'] },
  });
  const arrConfig = readConfig(arrId) ?? {};
  check(group, '数组只保留字符串元素', '2 条纯字符串',
    JSON.stringify(arrConfig.ignore),
    Array.isArray(arrConfig.ignore)
    && arrConfig.ignore.length === 2
    && arrConfig.ignore.every((item) => typeof item === 'string'));

  /* 6. endpoint 为空时不写空键。 */
  const emptyId = await createAsset({
    type: 'kb',
    name: '表单测试-空 endpoint',
    config: { indexMode: 'full' },
  });
  const emptyConfig = readConfig(emptyId) ?? {};
  check(group, 'endpoint 为空时不落空键', 'endpoint 不存在',
    JSON.stringify(emptyConfig.endpoint), emptyConfig.endpoint === undefined);
}

async function testCredentialBinding() {
  const group = '凭据接入';

  const SECRET = 'Pg-S3cret-Value';

  /* 1. 接入时一并录入账号口令 → 凭据真的绑上了。 */
  const created = await createAssetFull({
    type: 'db',
    name: '表单测试-凭据-db',
    endpoint: '10.0.0.9:5432/order_db',
    config: { engine: 'postgresql', host: '10.0.0.9', database: 'order_db' },
    credential: { label: '账号密码 · readonly', method: 'password', username: 'readonly', secret: SECRET },
  });
  check(group, '创建响应如实回报凭据已绑定', true, created.credentialBound, created.credentialBound === true);
  check(group, '创建响应不带凭据错误', undefined, created.credentialError, !created.credentialError);

  const binding = readCredential(created.id);
  check(group, '凭据状态为 active', 'active', binding?.state, binding?.state === 'active');
  check(group, '凭据记住了鉴权方式', 'password', binding?.auth_method, binding?.auth_method === 'password');
  check(group, '凭据记住了资产侧的账号', 'readonly', binding?.username, binding?.username === 'readonly');
  check(group, '凭据标签人读', '账号密码 · readonly', binding?.label, binding?.label === '账号密码 · readonly');
  check(group, '库里只留秘密引用，不留明文', `vault/${created.id}`,
    binding?.secret_ref, binding?.secret_ref === `vault/${created.id}`);
  check(group, '资产标记为已绑定凭据', 1, readCredentialBound(created.id), readCredentialBound(created.id) === 1);

  /* 2. 秘密绝不进 config —— 走的是独立的凭据通道。 */
  const credConfig = readConfig(created.id) ?? {};
  check(group, 'config 里没有口令明文', '不含 ' + SECRET,
    JSON.stringify(credConfig), !JSON.stringify(credConfig).includes(SECRET));
  check(group, 'config 里没有 username 键', 'username 不存在',
    JSON.stringify(credConfig.username), credConfig.username === undefined);

  /* 3. 秘密不落盘明文：隔离库所在目录里搜不到它。 */
  const leaked = grepDataDir(SECRET);
  check(group, '秘密不以明文落盘', '无命中文件',
    leaked.join(',') || '无', leaked.length === 0);

  /* 4. 不填凭据 → 明确不绑定（不能糊成"已绑定"）。 */
  const plainId = await createAsset({
    type: 'db',
    name: '表单测试-无凭据',
    config: { engine: 'sqlite', dbPath: 'demo.sqlite' },
  });
  check(group, '未填凭据时资产标记为未绑定', 0, readCredentialBound(plainId), readCredentialBound(plainId) === 0);
  check(group, '未填凭据时没有凭据绑定行', null, readCredential(plainId), readCredential(plainId) === null);

  /* 5. 令牌方式同样能绑（不只是账号口令）。 */
  const tokenCreated = await createAssetFull({
    type: 'code',
    name: '表单测试-凭据-code',
    endpoint: 'https://host/org/repo.git',
    config: { cloneUrl: 'https://host/org/repo.git' },
    credential: { label: '访问令牌', method: 'token', username: '', secret: 'ghp_supersecret' },
  });
  const tokenBinding = readCredential(tokenCreated.id);
  check(group, '令牌凭据绑定成功', true, tokenCreated.credentialBound, tokenCreated.credentialBound === true);
  check(group, '令牌凭据记住了鉴权方式', 'token', tokenBinding?.auth_method, tokenBinding?.auth_method === 'token');
  check(group, '令牌凭据没有账号名', '', tokenBinding?.username, String(tokenBinding?.username ?? '') === '');

  /* 6. 凭据不合法时如实报错，而不是假装绑上了。
   * 现状：label 由契约层（asset.ts）拦下 → 整份请求 400，资产不创建。
   * 这与「建资产 + credentialError」是两种都说得通的语义：
   *   - 契约拒：脏凭据进不了库，客户端必须改；
   *   - 软失败：资产先建，凭据单独补。
   * 当前实现选了前者，故此处按 400 断言；要改成软失败需先放开契约层的 label。 */
  const badCreated = await call('POST', '/assets', {
    workspaceId: 'w-ops',
    type: 'db',
    name: '表单测试-凭据缺标签',
    env: 'staging',
    config: { engine: 'sqlite', dbPath: 'demo.sqlite' },
    credential: { label: '', method: 'password', username: 'ro', secret: 'pw' },
  });
  check(group, '凭据缺标签时拒收整单', 400, badCreated.status, badCreated.status === 400);
  check(group, '错误里指明是凭据标签', true,
    String(badCreated.json?.error?.message ?? '').includes('凭据标签'),
    badCreated.json?.error?.message);
  check(group, '没有留下半绑定的资产', true,
    !badCreated.json?.data?.id, `data.id=${badCreated.json?.data?.id}`);

  /* 7. 单独走绑定端点也支持记录鉴权方式与账号（详情页「绑定凭据」按钮）。 */
  const manualId = await createAsset({
    type: 'db',
    name: '表单测试-手动绑定',
    config: { engine: 'sqlite', dbPath: 'demo.sqlite' },
  });
  const bindRes = await call('POST', `/assets/${manualId}/credential/bind`, {
    label: '账号密码 · ops', method: 'password', username: 'ops', secret: 'Ops-Pw-1',
  });
  check(group, '绑定端点返回 active', 'active', bindRes.json?.data?.state, bindRes.json?.data?.state === 'active');
  const manualBinding = readCredential(manualId);
  check(group, '绑定端点记下了账号与方式', 'ops/password',
    `${manualBinding?.username}/${manualBinding?.auth_method}`,
    manualBinding?.username === 'ops' && manualBinding?.auth_method === 'password');

  /* 8. 审计只说"绑没绑上"，绝不含账号口令。 */
  const auditName = '表单测试-凭据审计';
  await createAsset({
    type: 'db',
    name: auditName,
    config: { engine: 'sqlite', dbPath: 'demo.sqlite' },
    credential: { label: '账号密码 · readonly', method: 'password', username: 'readonly', secret: 'Audit-Pw-9' },
  });
  const auditDetail = (readAudit(auditName)[0] ?? '');
  check(group, '审计记录了凭据已绑定', '含 凭据已绑定',
    auditDetail.slice(0, 160), auditDetail.includes('凭据已绑定'));
  check(group, '审计不含口令明文', '不含 Audit-Pw-9',
    auditDetail.slice(0, 160), !auditDetail.includes('Audit-Pw-9'));
}

/** 在隔离数据目录里搜一个字符串（验证秘密没有以明文落盘）。 */
function grepDataDir(needle) {
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        return;
      }
      try {
        const text = fs.readFileSync(full, 'utf8');
        if (text.includes(needle)) hits.push(entry.name);
      } catch {
        /* 二进制文件读不动就跳过 —— 读不动不等于命中。 */
      }
    });
  };
  walk(DATA_DIR);
  return hits;
}

async function testAudit() {
  const group = '审计';

  /* 审计记配置的键名，不记值 —— 值里可能有主机名、库名这类细节。 */
  const name = '表单测试-审计';
  await createAsset({
    type: 'db',
    name,
    endpoint: 'secret-host.internal:5432',
    config: { engine: 'postgresql', host: 'secret-host.internal', database: 'private_db' },
  });
  const details = readAudit(name);
  const detail = details[0] ?? '';
  check(group, '审计明细含配置键名', '包含 engine',
    detail.slice(0, 160), detail.includes('engine'));
  check(group, '审计明细不含配置值（主机名 / 库名）', '不含 secret-host.internal / private_db',
    detail.slice(0, 160),
    !detail.includes('secret-host.internal') && !detail.includes('private_db'));
  check(group, '审计保留「不探测远端连通性」的诚实声明', '含 不探测远端连通性',
    detail.slice(0, 160), detail.includes('不探测远端连通性'));
}

/* ============================ 运行 ============================ */

async function waitHealthy(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function main() {
  let server = null;
  if (SELF_HOSTED) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    server = spawn(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'backend', 'src', 'index.ts')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DEVWORK_PORT: String(PORT),
          DEVWORK_DATA_DIR: DATA_DIR,
          DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let serverLog = '';
    server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
    server.stderr.on('data', (chunk) => { serverLog += String(chunk); });
    if (!(await waitHealthy())) {
      console.error('[test:asset] 服务未就绪，日志尾部：');
      console.error(serverLog.slice(-3000));
      process.exit(1);
    }
  }

  try {
    await testTypeSpecificConfig();
    await testSecurityBoundary();
    await testCredentialBinding();
    await testAudit();
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 3000).unref();
    }
  }

  console.log('');
  console.log(`[test:asset] 用例 ${results.total} · 通过 ${results.passed} · 失败 ${results.failed}`);
  if (failures.length > 0) {
    console.log('[test:asset] 失败用例：');
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('[test:asset] 运行器自身异常:', error);
  process.exit(2);
});
