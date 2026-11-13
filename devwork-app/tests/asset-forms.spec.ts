/**
 * 资产类型注册表的纯逻辑验证（前端侧）。
 *
 * 后端黑盒（tests/asset-forms.mjs）验证「落库是否符合白名单」，
 * 这里验证「表单本身是否真的按类型分化」—— 后者才是这次改造的核心：
 * 类型只影响文案不算分化，类型影响字段结构、鉴权方式、校验与提交映射才算。
 *
 * 运行：npx tsx tests/asset-forms.spec.ts
 */
import {
  ASSET_TYPES,
  activeKeys,
  authFieldKeys,
  buildAuth,
  defaultValues,
  endpointOf,
  isSensitiveKeyName,
  needsClone,
  specOf,
  visibleFields,
  type FormValues,
} from '../src/components/assetForms';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, expected: unknown, actual: unknown, ok: boolean, note = ''): void {
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${name}`);
    if (note) console.log(`       ${note}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`[FAIL] ${name}`);
    console.log(`       期望: ${JSON.stringify(expected)}`);
    console.log(`       实际: ${JSON.stringify(actual)}`);
  }
}

/** 表单值 → config（带上当前可见键白名单）。 */
function build(specId: string, values: FormValues): Record<string, unknown> {
  const spec = specOf(specId);
  return spec.buildConfig(values, activeKeys(spec, values));
}

/* ============================ 1. 结构确实按类型分化 ============================ */

const dbSpec = specOf('db');
const codeSpec = specOf('code');
const serverSpec = specOf('server');
const kbSpec = specOf('kb');

check('四种资产类型的字段集合互不相同（不是同一套表单换文案）',
  '四组两两不同',
  `${dbSpec.fields.length}/${codeSpec.fields.length}/${serverSpec.fields.length}/${kbSpec.fields.length}`,
  new Set([
    dbSpec.fields.map((f) => f.key).join(','),
    codeSpec.fields.map((f) => f.key).join(','),
    serverSpec.fields.map((f) => f.key).join(','),
    kbSpec.fields.map((f) => f.key).join(','),
  ]).size === 4);

check('注册表覆盖四种资产类型', 4, ASSET_TYPES.length, ASSET_TYPES.length === 4);
check('数据库资产有引擎/主机/端口等专属字段', '含 engine/host/port/database',
  dbSpec.fields.map((f) => f.key).join(','),
  ['engine', 'host', 'port', 'database'].every((key) => dbSpec.fields.some((f) => f.key === key)));
check('代码库资产有仓库地址/分支/深度/忽略规则', '含 cloneUrl/branch/depth/ignore',
  codeSpec.fields.map((f) => f.key).join(','),
  ['cloneUrl', 'branch', 'depth', 'ignore'].every((key) => codeSpec.fields.some((f) => f.key === key)));
check('服务器资产有传输方式/用户/命令白名单', '含 transport/user/allowedCommands',
  serverSpec.fields.map((f) => f.key).join(','),
  ['transport', 'user', 'allowedCommands'].every((key) => serverSpec.fields.some((f) => f.key === key)));
check('知识库资产有目录/分块/密级', '含 dir/chunkSize/sensitivity',
  kbSpec.fields.map((f) => f.key).join(','),
  ['dir', 'chunkSize', 'sensitivity'].every((key) => kbSpec.fields.some((f) => f.key === key)));

/* ============================ 2. 条件显隐 ============================ */

const pgValues: FormValues = { ...defaultValues(dbSpec), engine: 'postgresql' };
const mysqlValues: FormValues = { ...defaultValues(dbSpec), engine: 'mysql' };
const sqliteValues: FormValues = { ...defaultValues(dbSpec), engine: 'sqlite' };

const pgKeys = visibleFields(dbSpec, pgValues).map((f) => f.key);
const mysqlKeys = visibleFields(dbSpec, mysqlValues).map((f) => f.key);
const sqliteKeys = visibleFields(dbSpec, sqliteValues).map((f) => f.key);

check('PostgreSQL 下显示主机与端口', '含 host/port', pgKeys.join(','),
  pgKeys.includes('host') && pgKeys.includes('port'));
check('PostgreSQL 下不显示 MySQL 专属的字符集', '不含 charset', pgKeys.join(','),
  !pgKeys.includes('charset'));
check('MySQL 下显示字符集', '含 charset', mysqlKeys.join(','), mysqlKeys.includes('charset'));
check('SQLite 下只显示文件路径，不显示主机端口', '含 dbPath，不含 host/port',
  sqliteKeys.join(','),
  sqliteKeys.includes('dbPath') && !sqliteKeys.includes('host') && !sqliteKeys.includes('port'));

const sshValues: FormValues = { ...defaultValues(serverSpec), transport: 'ssh' };
const localKeys = visibleFields(serverSpec, defaultValues(serverSpec)).map((f) => f.key);
const sshKeys = visibleFields(serverSpec, sshValues).map((f) => f.key);
check('服务器：local 模式不显示主机用户，ssh 模式显示', 'local 无 host，ssh 有 host',
  `local=${localKeys.join(',')} ssh=${sshKeys.join(',')}`,
  !localKeys.includes('host') && sshKeys.includes('host') && sshKeys.includes('user'));

/* ============================ 3. 提交映射 ============================ */

const dbConfig = build('db', { ...pgValues, host: '10.0.0.9', port: '5432', database: 'order_db', schema: 'public,biz' });
check('db 提交：结构化键落库', 'engine=postgresql host=10.0.0.9 port=5432',
  JSON.stringify(dbConfig),
  dbConfig.engine === 'postgresql'
  && dbConfig.host === '10.0.0.9'
  && dbConfig.port === 5432
  && dbConfig.database === 'order_db');
check('db 提交：schema 按逗号拆成数组', '["public","biz"]',
  JSON.stringify(dbConfig.schema),
  Array.isArray(dbConfig.schema) && dbConfig.schema.length === 2);

/* 残留值防护：用户在 MySQL 模式下填了 charset，切到 PostgreSQL 后该字段已隐藏，
 * 残留值不该再进库（否则用户会得到一个自己从没填过的配置项）。 */
const staleCharset = build('db', { ...pgValues, host: '10.0.0.9', charset: 'utf8' });
check('切引擎后隐藏字段的残留值不进 config', '无 charset',
  JSON.stringify(staleCharset), staleCharset.charset === undefined);
check('残留被挡掉时，可见字段照常落库', 'host=10.0.0.9',
  JSON.stringify(staleCharset), staleCharset.host === '10.0.0.9');

const codeConfig = build('code', {
  ...defaultValues(codeSpec),
  cloneUrl: 'https://host/org/repo.git',
  branch: 'main',
  depth: '1',
  ignore: '**/node_modules/**\n**/target/**',
  sensitiveDeny: '.env*',
  token: 'ghp_supersecret',
});
check('code 提交：仓库信息落库', 'cloneUrl/branch/depth',
  JSON.stringify(codeConfig),
  codeConfig.cloneUrl === 'https://host/org/repo.git'
  && codeConfig.branch === 'main'
  && codeConfig.depth === 1);
check('code 提交：忽略规则是数组', '["**/node_modules/**","**/target/**"]',
  JSON.stringify(codeConfig.ignore),
  Array.isArray(codeConfig.ignore) && codeConfig.ignore.length === 2);
check('code 提交：访问令牌绝不进 config（敏感字段不落库）', '无 token',
  JSON.stringify(codeConfig),
  codeConfig.token === undefined && !JSON.stringify(codeConfig).includes('ghp_supersecret'));

/* 敏感键名自检：与服务端 SENSITIVE_KEY_PATTERNS 同一套规则。 */
check('敏感键名识别：token/password/authMethod 都算敏感', 'true × 3',
  [isSensitiveKeyName('token'), isSensitiveKeyName('password'), isSensitiveKeyName('authMethod')].join(','),
  isSensitiveKeyName('token') && isSensitiveKeyName('password') && isSensitiveKeyName('authMethod'));
check('敏感键名识别：cloneUrl/dir 不算敏感', 'false × 2',
  [isSensitiveKeyName('cloneUrl'), isSensitiveKeyName('dir')].join(','),
  !isSensitiveKeyName('cloneUrl') && !isSensitiveKeyName('dir'));

/* ============================ 4. 鉴权方式按类型与上下文分化 ============================ */

const dbAuthSqlite = dbSpec.auth(sqliteValues).map((o) => o.value);
const dbAuthPg = dbSpec.auth(pgValues).map((o) => o.value);
const dbAuthMy = dbSpec.auth(mysqlValues).map((o) => o.value);
check('db：SQLite 只有「无鉴权」', 'none', dbAuthSqlite.join(','), dbAuthSqlite.join(',') === 'none');
check('db：远程引擎有账号密码 / 令牌 / 无鉴权', 'password,token,none',
  dbAuthPg.join(','), dbAuthPg.join(',') === 'password,token,none');
check('db：MySQL 与 PostgreSQL 的鉴权方式一致', 'password,token,none',
  dbAuthMy.join(','), dbAuthMy.join(',') === 'password,token,none');

const codeAuth = codeSpec.auth(defaultValues(codeSpec)).map((o) => o.value);
check('code：令牌 / SSH 私钥 / 无鉴权', 'token,sshkey,none',
  codeAuth.join(','), codeAuth.join(',') === 'token,sshkey,none');

const srvAuthLocal = serverSpec.auth(defaultValues(serverSpec)).map((o) => o.value);
const srvAuthSsh = serverSpec.auth(sshValues).map((o) => o.value);
const srvAuthDocker = serverSpec.auth({ ...defaultValues(serverSpec), transport: 'docker' }).map((o) => o.value);
check('server：本地沙箱只要无鉴权', 'none', srvAuthLocal.join(','), srvAuthLocal.join(',') === 'none');
check('server：SSH 有账号密码 / 私钥 / 无鉴权', 'password,sshkey,none',
  srvAuthSsh.join(','), srvAuthSsh.join(',') === 'password,sshkey,none');
check('server：Docker 只有令牌 / 无鉴权', 'token,none',
  srvAuthDocker.join(','), srvAuthDocker.join(',') === 'token,none');

const kbAuth = kbSpec.auth(defaultValues(kbSpec)).map((o) => o.value);
check('kb：本地目录扫描不需要鉴权', 'none', kbAuth.join(','), kbAuth.join(',') === 'none');

/* 账号密码方式带「账号 + 密码」两个字段；令牌方式只带令牌。 */
const dbPasswordOption = dbSpec.auth(pgValues).find((o) => o.value === 'password');
const dbTokenOption = dbSpec.auth(pgValues).find((o) => o.value === 'token');
check('db 账号密码方式要填账号与密码', 'username,password',
  (dbPasswordOption?.fields ?? []).map((f) => f.key).join(','),
  (dbPasswordOption?.fields ?? []).map((f) => f.key).join(',') === 'username,password');
check('db 令牌方式只填令牌，不重复要账号', 'token',
  (dbTokenOption?.fields ?? []).map((f) => f.key).join(','),
  (dbTokenOption?.fields ?? []).map((f) => f.key).join(',') === 'token');

/* ============================ 5. 凭据抽取：只取当前方式的秘密 ============================ */

const authPassword = buildAuth(dbSpec, {
  ...pgValues, authMethod: 'password', username: 'readonly', password: 'pg-secret',
});
check('buildAuth：取出账号与口令', 'password/readonly/pg-secret',
  `${authPassword.method}/${authPassword.username}/${authPassword.secret}`,
  authPassword.method === 'password'
  && authPassword.username === 'readonly'
  && authPassword.secret === 'pg-secret'
  && authPassword.hasSecret === true);
check('buildAuth：凭据标签人读', '账号密码 · readonly',
  authPassword.label, authPassword.label === '账号密码 · readonly');

/* 关键防线：切到「令牌」后，上一种方式残留的口令值不能被带走。 */
const authToken = buildAuth(dbSpec, {
  ...pgValues, authMethod: 'token', username: 'readonly', password: 'pg-secret', token: 'tok-1',
});
check('buildAuth：切方式后不带走上一种方式的秘密', 'tok-1（不含 pg-secret）',
  authToken.secret,
  authToken.secret === 'tok-1' && !JSON.stringify(authToken).includes('pg-secret'));

/* SQLite 没有账号密码概念：即使表单里残留着 authMethod=password，也只能是无鉴权。 */
const authSqlite = buildAuth(dbSpec, {
  ...sqliteValues, authMethod: 'password', username: 'ro', password: 'pw',
});
check('buildAuth：SQLite 强制无鉴权', 'none/无秘密',
  `${authSqlite.method}/${authSqlite.secret}`,
  authSqlite.method === 'none' && authSqlite.secret === '' && authSqlite.hasSecret === false);

/* 服务器 SSH 的账号就是「登录用户」字段，不该让人填两遍。 */
const authServer = buildAuth(serverSpec, {
  ...sshValues, authMethod: 'password', user: 'deploy', password: 'ssh-pw',
});
check('buildAuth：服务器账号沿用登录用户字段', 'deploy/ssh-pw',
  `${authServer.username}/${authServer.secret}`,
  authServer.username === 'deploy' && authServer.secret === 'ssh-pw');

/* 凭据字段绝不能出现在 config 里。 */
const dbConfigWithCreds = build('db', {
  ...pgValues, host: '10.0.0.9', database: 'order_db',
  authMethod: 'password', username: 'readonly', password: 'pg-secret',
});
check('config 里没有账号与口令', '无 username/password',
  JSON.stringify(dbConfigWithCreds),
  dbConfigWithCreds.username === undefined
  && dbConfigWithCreds.password === undefined
  && !JSON.stringify(dbConfigWithCreds).includes('pg-secret'));

/* 鉴权字段清单：切换方式时要清干净这些键。 */
const authKeys = authFieldKeys(dbSpec, pgValues);
check('鉴权字段清单包含账号与口令', '含 username/password',
  authKeys.join(','), authKeys.includes('username') && authKeys.includes('password'));

/* 口令不做 trim：首尾空格是有意义的字符，悄悄去掉等于改写用户的凭据。 */
const authSpaced = buildAuth(dbSpec, {
  ...pgValues, authMethod: 'password', username: 'ro', password: ' pw ',
});
check('buildAuth：口令不做 trim（首尾空格有意义）', '" pw "',
  JSON.stringify(authSpaced.secret), authSpaced.secret === ' pw ');
check('buildAuth：全空白的口令视为没填', false,
  authSpaced.hasSecret, authSpaced.hasSecret === true);

/* ============================ 6. 校验规则按类型分化 ============================ */

check('db 校验：SQLite 缺文件路径要报错', '非空错误',
  dbSpec.validate({ ...defaultValues(dbSpec), engine: 'sqlite' }),
  typeof dbSpec.validate({ ...defaultValues(dbSpec), engine: 'sqlite' }) === 'string');
check('db 校验：远程引擎缺主机要报错', '非空错误',
  dbSpec.validate({ ...defaultValues(dbSpec), engine: 'postgresql' }),
  typeof dbSpec.validate({ ...defaultValues(dbSpec), engine: 'postgresql' }) === 'string');
check('db 校验：填全则通过', null,
  dbSpec.validate({ ...defaultValues(dbSpec), engine: 'sqlite', dbPath: 'demo.sqlite' }),
  dbSpec.validate({ ...defaultValues(dbSpec), engine: 'sqlite', dbPath: 'demo.sqlite' }) === null);
check('server 校验：ssh 缺用户要报错', '非空错误',
  serverSpec.validate({ ...defaultValues(serverSpec), transport: 'ssh', host: '10.0.0.9' }),
  typeof serverSpec.validate({ ...defaultValues(serverSpec), transport: 'ssh', host: '10.0.0.9' }) === 'string');
check('server 校验：工作目录必须是绝对路径', '非空错误',
  serverSpec.validate({ ...defaultValues(serverSpec), transport: 'local', workdir: 'opt/app' }),
  typeof serverSpec.validate({ ...defaultValues(serverSpec), transport: 'local', workdir: 'opt/app' }) === 'string');
check('kb 校验：文档目录不允许 ..', '非空错误',
  kbSpec.validate({ ...defaultValues(kbSpec), dir: '../secrets' }),
  typeof kbSpec.validate({ ...defaultValues(kbSpec), dir: '../secrets' }) === 'string');
check('kb 校验：正常目录通过', null,
  kbSpec.validate({ ...defaultValues(kbSpec), dir: 'docs/ops' }),
  kbSpec.validate({ ...defaultValues(kbSpec), dir: 'docs/ops' }) === null);
check('code 校验：非法仓库协议要报错', '非空错误',
  codeSpec.validate({ ...defaultValues(codeSpec), cloneUrl: 'ftp://host/repo' }),
  typeof codeSpec.validate({ ...defaultValues(codeSpec), cloneUrl: 'ftp://host/repo' }) === 'string');

/* 鉴权校验：选了账号密码却没填内容，必须拦下来（不然等于"绑了个空凭据"）。 */
check('鉴权校验：选了账号密码但没填账号要报错', '非空错误',
  dbSpec.validateAuth({ ...pgValues, authMethod: 'password', password: 'pw' }),
  typeof dbSpec.validateAuth({ ...pgValues, authMethod: 'password', password: 'pw' }) === 'string');
check('鉴权校验：选了账号密码但没填口令要报错', '非空错误',
  dbSpec.validateAuth({ ...pgValues, authMethod: 'password', username: 'ro' }),
  typeof dbSpec.validateAuth({ ...pgValues, authMethod: 'password', username: 'ro' }) === 'string');
check('鉴权校验：填全则通过', null,
  dbSpec.validateAuth({ ...pgValues, authMethod: 'password', username: 'ro', password: 'pw' }),
  dbSpec.validateAuth({ ...pgValues, authMethod: 'password', username: 'ro', password: 'pw' }) === null);
check('鉴权校验：选了令牌但没填令牌要报错', '非空错误',
  codeSpec.validateAuth({ ...defaultValues(codeSpec), authMethod: 'token' }),
  typeof codeSpec.validateAuth({ ...defaultValues(codeSpec), authMethod: 'token' }) === 'string');
check('鉴权校验：无鉴权时无需任何内容', null,
  dbSpec.validateAuth({ ...pgValues, authMethod: 'none' }),
  dbSpec.validateAuth({ ...pgValues, authMethod: 'none' }) === null);

/* ============================ 7. 兼容串与克隆判定 ============================ */

check('endpoint 兼容串：code 取仓库地址', 'https://host/org/repo.git',
  endpointOf(codeSpec, { ...defaultValues(codeSpec), cloneUrl: 'https://host/org/repo.git' }),
  endpointOf(codeSpec, { ...defaultValues(codeSpec), cloneUrl: 'https://host/org/repo.git' }) === 'https://host/org/repo.git');
check('endpoint 兼容串：db 远程拼 host:port/db', '10.0.0.9:5432/order_db',
  endpointOf(dbSpec, { ...pgValues, host: '10.0.0.9', port: '5432', database: 'order_db' }),
  endpointOf(dbSpec, { ...pgValues, host: '10.0.0.9', port: '5432', database: 'order_db' }) === '10.0.0.9:5432/order_db');
check('endpoint 兼容串：kb 取文档目录', 'docs/ops',
  endpointOf(kbSpec, { ...defaultValues(kbSpec), dir: 'docs/ops' }),
  endpointOf(kbSpec, { ...defaultValues(kbSpec), dir: 'docs/ops' }) === 'docs/ops');
check('填写仓库地址时才触发克隆', true,
  needsClone(codeSpec, { ...defaultValues(codeSpec), cloneUrl: 'https://host/org/repo.git' }),
  needsClone(codeSpec, { ...defaultValues(codeSpec), cloneUrl: 'https://host/org/repo.git' }));
check('没填仓库地址不触发克隆', false,
  needsClone(codeSpec, defaultValues(codeSpec)),
  !needsClone(codeSpec, defaultValues(codeSpec)));

console.log('');
console.log(`[test:asset-spec] 用例 ${passed + failed} · 通过 ${passed} · 失败 ${failed}`);
if (failures.length > 0) {
  console.log('[test:asset-spec] 失败用例：');
  failures.forEach((item) => console.log(`  - ${item}`));
  process.exit(1);
}
process.exit(0);
