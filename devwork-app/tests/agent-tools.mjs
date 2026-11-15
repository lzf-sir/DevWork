/**
 * Agent 工具派生管线 + V2 写能力层 测试（V9）。
 *
 * 覆盖三块（对应 devwork-asset-capability-design.md）：
 *   A. 派生管线：按工作区资产×能力×信任级别派生工具面（prod 写工具不存在而非 ask）；
 *   B. 七组只读工具真实执行 + V2 写工具三层防线（precheck→执行→校验→回滚）；
 *   C. 命令模板库（参数白名单化 / 无模板拒绝）+ 会话级审批记忆 + 连拒熔断；
 *   D. HTTP 集成：/api/tools、/api/skills、/api/cmd-templates 与审批卡真执行闭环。
 *
 * 用法：npm run test:agent-tools（独立端口 3012，隔离数据目录，不碰 3001 实例）。
 */
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installAuthFetch } from './lib/session.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUN_DIR = mkdtempSync(path.join(tmpdir(), 'devwork-agent-tools-'));
const DATA_DIR = path.join(RUN_DIR, 'data');
const SANDBOX_DIR = path.join(RUN_DIR, 'sandbox');
const PORT = Number(process.env.AGENT_TOOLS_PORT ?? 3012);
const BASE = `http://127.0.0.1:${PORT}`;

/* 登录体系：这个用例直接裸 fetch 十几个端点，统一包一层补会话 Cookie，
 * 用的是配置文件里默认管理员的真实登录会话（不是后门）。 */
installAuthFetch(BASE);

/* 必须在 import 被测模块之前设置：config.ts 在模块加载时读 env。 */
process.env.DEVWORK_DATA_DIR = DATA_DIR;
process.env.DEVWORK_SANDBOX_DIR = SANDBOX_DIR;
process.env.DEVWORK_PORT = String(PORT);
/* esbuild 打包后 import.meta.url 指向临时 bundle，config.ts 的相对锚点会漂移；
 * schema 路径显式指回源码（与 DATA_DIR 覆盖同一模式）。 */
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
const mod = await bundle('tests/agent-tools-entry.ts', path.join(RUN_DIR, 'bundle.mjs'));

/* ================= 初始化（与 backend/src/index.ts 非 clean 模式一致） ================= */
mod.initDatabase(mod.seedIfEmpty);
mod.ensureAgentV9Assets();
mod.initDemoDatabase();
mod.initLogSink();
mod.bootstrapRepo();
mod.ensureFtsTable();
mod.runIndex('a-order-service');
mod.appendLog('INFO', 'agent-tools 测试日志行 A');
mod.appendLog('WARN', 'agent-tools 测试日志行 B');

/* ================= A. 派生管线 ================= */
console.log('\n--- A. 派生管线 ---');
{
  const face = mod.deriveToolFace('w-ops');
  const activeNames = face.active.map((tool) => tool.name);
  const allNames = face.all.map((tool) => tool.name);

  check('A1 七组只读工具全部派生（合并后的正式名 + V9 补齐 log/api）',
    ['ws_list_assets', 'code_find', 'code_view', 'db_query', 'db_inspect', 'kb_search', 'srv_status', 'srv_log_tail', 'log_query', 'api_spec_read', 'api_call_read']
      .every((name) => activeNames.includes(name)),
    activeNames.join(','));

  check('A2 V2 写工具按信任级别派生（code_edit/db_query_write/fs_write_file 在面内）',
    ['code_edit', 'db_query_write', 'fs_write_file'].every((name) => activeNames.includes(name)),
    activeNames.join(','));

  const srvExec = face.all.find((tool) => tool.name === 'srv_exec');
  check('A3 prod 资产的 srv_exec 被剪枝（gatedBy=prod-env，不存在而非 ask）',
    !!srvExec && srvExec.gatedBy === 'prod-env' && !activeNames.includes('srv_exec'),
    srvExec ? `gatedBy=${srvExec.gatedBy}` : 'missing');

  const dbQuery = face.active.find((tool) => tool.name === 'db_query');
  check('A4 db_query 绑定主实例 a-order-db-dev（在线且已绑凭据优先）',
    !!dbQuery && dbQuery.assetId === 'a-order-db-dev',
    dbQuery ? dbQuery.assetId : 'missing');

  check('A5 派生规则自描述（R1-R4）', face.derivationRules.length === 4);

  /* prod 工作区：写工具整组不派生（R3）。 */
  const prodFace = mod.deriveToolFace('w-data');
  check('A6 其他工作区派生不串味（w-data 无 log/api 资产 → 无 log_query/api 工具）',
    !prodFace.active.some((tool) => ['log_query', 'api_spec_read', 'srv_status'].includes(tool.name)),
    prodFace.active.map((tool) => tool.name).join(','));
}

/* ================= B. 七组只读工具真实执行 ================= */
console.log('\n--- B. 只读工具真实执行 ---');
{
  const face = mod.deriveToolFace('w-ops');
  /* 旧名调用必须继续可用（V10 兼容层），但资产绑定按正式名对应的派生工具取 ——
   * 这正是执行器入口归一要解决的问题：旧名不该绑到静态默认资产上。 */
  const run = async (name, args) => {
    const call = mod.normalizeToolCall(name, args);
    const tool = face.all.find((t) => t.name === call.name);
    const ctx = { assetId: tool?.assetId ?? '', workspaceId: 'w-ops', conversationId: 'c-test', identity };
    return mod.executeAgentTool(name, call.args, tool, ctx);
  };

  const assets = await run('ws_list_assets', {});
  check('B1 ws_list_assets 列出真实资产（含 V9 补插的 a-order-log）',
    assets.ok && assets.result.includes('a-order-log') && assets.result.includes('a-devwork-api'));

  const sql = await run('db_query', { sql: 'SELECT status, count(*) AS n FROM "order" GROUP BY status' });
  check('B2 db_query 真实查询（ok 且返回行数与采样）',
    sql.ok && /查询成功 · \d+ 行/.test(sql.result), sql.result.slice(0, 120));

  const schema = await run('db_schema', {});
  check('B3 db_schema 列出真实表清单', schema.ok && schema.result.includes('order'), schema.result.slice(0, 120));
  const schemaOne = await run('db_schema', { table: 'inventory' });
  check('B4 db_schema 单表结构含列与索引', schemaOne.ok && schemaOne.result.includes('stock'), schemaOne.result.slice(0, 150));

  const tables = await run('db_tables', {});
  check('B4b db_tables 行数画像（真实 COUNT，含 order 表）',
    tables.ok && /order：\d+ 行/.test(tables.result), tables.result.slice(0, 160));
  const tablesOne = await run('db_tables', { tables: 'inventory' });
  check('B4c db_tables 指定表计数', tablesOne.ok && /inventory：\d+ 行/.test(tablesOne.result), tablesOne.result.slice(0, 120));

  const todos = await run('code_todos', {});
  check('B6b code_todos 真实扫描（ok，结果可空但格式正确）',
    todos.ok && /扫到 \d+ 个标记|未扫到/.test(todos.result), todos.result.slice(0, 120));
  const todosCapped = await run('code_todos', { max: 3 });
  check('B6c code_todos max 参数生效（≤3 条）',
    todosCapped.ok && (() => { const m = /扫到 (\d+) 个/.exec(todosCapped.result); return !m || Number(m[1]) <= 3; })(),
    todosCapped.result.slice(0, 120));

  /* ---- code_todos 的归属：L42 在哪个方法里，决定改它之前要读哪一段 ---- */
  const javaTodo = [
    'package probe;',
    '',
    'public class Probe {',
    '  // TODO: 重试次数是拍脑袋定的',
    '  private int retries = 3;',
    '',
    '  public void saveOrder(long id) {',
    '    // FIXME: 并发下会互相覆盖',
    '    retries -= 1;',
    '  }',
    '',
    '  public void close(long id) {',
    '    System.out.println(id);',
    '  }',
    '}',
    '',
  ].join('\n');
  const tsTodo = [
    '// TODO: 这个文件的名字先这样',
    'export function loadConfig() {',
    '  // HACK: 用环境变量默认值兜底',
    '  return {};',
    '}',
    '',
  ].join('\n');
  const mdTodo = '- TODO: 补文档\n';
  const seed1 = await mod.executeFileWrite('a-order-service', 'v9-test/todos/Probe.java', javaTodo, identity, 'w-ops', 'c-test');
  const seed2 = await mod.executeFileWrite('a-order-service', 'v9-test/todos/probe.ts', tsTodo, identity, 'w-ops', 'c-test');
  const seed3 = await mod.executeFileWrite('a-order-service', 'v9-test/todos/notes.md', mdTodo, identity, 'w-ops', 'c-test');

  const scoped = await run('code_todos', { path: 'v9-test/todos' });
  check('B6d 准备 TODO 夹具（类内 / 方法内 / 模块级 / 非代码文件各一）',
    seed1.ok && seed2.ok && seed3.ok && scoped.ok, `${seed1.message}|${seed2.message}|${seed3.message}`);
  check('B6e 方法内的标记标出所属方法（FIXME 在 Probe.saveOrder 里，不用自己找行）',
    /- v9-test\/todos\/Probe\.java:L8 · FIXME · .* @ Probe\.saveOrder$/m.test(scoped.result),
    scoped.result.slice(0, 400));
  check('B6f 类内但不在方法里的标记标到类（不冒充方法）',
    /- v9-test\/todos\/Probe\.java:L4 · TODO · .* @ Probe$/m.test(scoped.result),
    scoped.result.slice(0, 400));
  check('B6g 代码文件里查不到归属时明说"模块级"（不说成某个方法）',
    /- v9-test\/todos\/probe\.ts:L1 · TODO · .* @ \(模块级/.test(scoped.result), scoped.result.slice(0, 400));
  check('B6h 非代码文件不编造结构（markdown 里的 TODO 没有任何 @ 归属）',
    /- v9-test\/todos\/notes\.md:L1 · TODO · 补文档$/m.test(scoped.result), scoped.result.slice(0, 400));
  check('B6i path 限定子树（只看 v9-test/todos，不串到 src/main/java）',
    scoped.ok && !scoped.result.includes('src/main/java'), scoped.result.slice(0, 200));

  const todoCapped = await run('code_todos', { path: 'v9-test/todos', max: 2 });
  check('B6j 命中触顶时说"结果不保证完整"，不说"后面还有"（后者可能撒谎）',
    todoCapped.ok && todoCapped.result.includes('结果不保证完整')
    && !todoCapped.result.includes('后面还有'), todoCapped.result.slice(0, 200));

  const todoFileAsPath = await run('code_todos', { path: 'v9-test/todos/Probe.java' });
  check('B6k path 指向文件时报错并指出这是目录参数（不静默返回空列表）',
    !todoFileAsPath.ok && todoFileAsPath.result.includes('目录'), todoFileAsPath.result.slice(0, 160));

  const kb = await run('kb_search', { query: 'GMV 口径' });
  check('B5 kb_search 真实索引检索', kb.ok && /命中 \d+ 个片段|未命中/.test(kb.result));

  const code = await run('code_search', { query: 'setConnectTimeout' });
  check('B6 code_search 真实索引检索', code.ok && /命中 \d+ 个片段/.test(code.result), code.result.slice(0, 120));

  const status = await run('srv_status', {});
  check('B7 srv_status 真实采集（CPU 核数 / 进程数）', status.ok && /CPU \d+ 核/.test(status.result));

  const tail = await run('srv_log_tail', { lines: 5 });
  check('B8 srv_log_tail 真实读日志文件', tail.ok && tail.result.includes('测试日志行'));

  const logQuery = await run('log_query', { query: '测试日志行', limit: 10 });
  check('B9 log_query 关键词检索命中 2 行', logQuery.ok && /命中 2 行/.test(logQuery.result), logQuery.result.slice(0, 150));

  const spec = await run('api_spec_read', {});
  check('B10 api_spec_read 返回真实端点规范', spec.ok && spec.result.includes('/api/health'));
  const apiDeny = await run('api_call_read', { path: '/api/audit' });
  check('B11 api_call_read 白名单外路径被拒（防副作用调用）',
    !apiDeny.ok && apiDeny.result.includes('不在只读规范清单内'), apiDeny.result.slice(0, 120));
  const apiHealth = await run('api_call_read', { path: '/api/health' });
  check('B12 api_call_read 白名单内端点真实 HTTP 调用（无服务时如实失败）',
    apiHealth.result.includes('HTTP') || apiHealth.result.includes('失败'), apiHealth.result.slice(0, 120));
}

/* ================= B2. 代码导航 / 网页抓取 / 技能 ================= */
console.log('\n--- B2. 代码导航 / 抓取 / 技能 ---');
{
  const face = mod.deriveToolFace('w-ops');
  const run = async (name, args) => {
    const call = mod.normalizeToolCall(name, args);
    const tool = face.all.find((t) => t.name === call.name);
    const ctx = { assetId: tool?.assetId ?? '', workspaceId: 'w-ops', conversationId: 'c-test', identity };
    return mod.executeAgentTool(name, call.args, tool, ctx);
  };

  check('B2-0 合并后的工具与新工具全部进入派生工具面',
    ['code_find', 'code_view', 'db_inspect', 'browser', 'skill', 'web_fetch', 'memo', 'git_history']
      .every((name) => face.active.some((t) => t.name === name)),
    face.active.map((t) => t.name).join(','));

  /* --- code_glob --- */
  const glob = await run('code_glob', { pattern: '**/*.java' });
  check('B2-1 code_glob 按模式列出真实文件（含体积与修改时间）',
    glob.ok && /匹配 \*\*\/\*\.java：\d+ 个/.test(glob.result) && /\d+B · \d{4}-\d{2}-\d{2}/.test(glob.result),
    glob.result.slice(0, 160));

  const globNone = await run('code_glob', { pattern: '**/*.zzz-none' });
  check('B2-2 code_glob 无命中如实说没有（不编造路径）',
    globNone.ok && globNone.result.includes('没有文件匹配'), globNone.result.slice(0, 140));

  const globBad = await run('code_glob', { pattern: '' });
  check('B2-3 code_glob 空模式直接拒绝', !globBad.ok && globBad.result.includes('pattern 参数为空'));

  /* --- code_grep --- */
  const grep = await run('code_grep', { pattern: 'setConnectTimeout', contextLines: 1, max: 3 });
  check('B2-4 code_grep 命中带行号与上下文行',
    grep.ok && /命中 \d+ 处/.test(grep.result) && /:\d+: /.test(grep.result) && /-\d+- /.test(grep.result),
    grep.result.slice(0, 200));

  const grepMiss = await run('code_grep', { pattern: 'zzz_ensure_absent_zzz' });
  check('B2-5 code_grep 无命中如实上报（不编造文件内容）',
    grepMiss.ok && grepMiss.result.includes('未命中'), grepMiss.result.slice(0, 140));

  const grepBadRe = await run('code_grep', { pattern: '([unclosed' });
  check('B2-6 非法正则如实报错而不是 500', !grepBadRe.ok && grepBadRe.result.includes('正则无法编译'), grepBadRe.result.slice(0, 120));

  const grepGlobFilter = await run('code_grep', { pattern: 'class', glob: '**/*.java', max: 2 });
  check('B2-7 code_grep 的 glob 过滤生效（只搜 .java）',
    grepGlobFilter.ok && (grepGlobFilter.result.includes('未命中') || /\.java:\d+/.test(grepGlobFilter.result)),
    grepGlobFilter.result.slice(0, 160));

  /* --- code_read 分页 --- */
  const firstFile = /- ([\w./-]+\.java)/.exec(glob.result)?.[1];
  const page1 = await run('code_read', { path: firstFile, offset: 1, limit: 5 });
  check('B2-8 code_read 返回总行数 + 本次区间 + 未读提示',
    page1.ok && /共 \d+ 行 · 本次 L1-L5/.test(page1.result) && (page1.result.includes('还有') || page1.result.includes('已读到文件末尾')),
    page1.result.slice(0, 160));
  const page2 = await run('code_read', { path: firstFile, offset: 6, limit: 5 });
  check('B2-9 code_read 的 offset 生效（第二次从 L6 起）',
    page2.ok && page2.result.includes('本次 L6-L10'), page2.result.slice(0, 120));

  const escape = await run('code_read', { path: '../../../etc/passwd' });
  check('B2-10 code_read 路径越界被拦截', !escape.ok && escape.result.includes('越界'), escape.result.slice(0, 100));
  const sensitive = await run('code_read', { path: '.env' });
  check('B2-11 code_read 敏感文件被拦截', !sensitive.ok && sensitive.result.includes('敏感文件'), sensitive.result.slice(0, 100));
  const dirRead = await run('code_read', { path: 'src' });
  check('B2-12 code_read 读到目录时给出替代做法（指向 code_find mode=glob）',
    !dirRead.ok && dirRead.result.includes('code_find') && dirRead.result.includes('glob'), dirRead.result.slice(0, 120));

  /* --- web_fetch：只测安全闸门，不出网（测试环境不依赖外网） --- */
  const ssrf = await run('web_fetch', { url: 'http://127.0.0.1:3001/api/health' });
  check('B2-13 web_fetch 拦截本机地址（SSRF 防护）',
    !ssrf.ok && /私有网段|内网/.test(ssrf.result), ssrf.result.slice(0, 120));
  const fileScheme = await run('web_fetch', { url: 'file:///C:/Windows/win.ini' });
  check('B2-14 web_fetch 只允许 http/https（file: 被拒）',
    !fileScheme.ok && fileScheme.result.includes('http/https'), fileScheme.result.slice(0, 120));
  const emptyUrl = await run('web_fetch', { url: '' });
  check('B2-15 web_fetch 空地址被拒', !emptyUrl.ok && emptyUrl.result.includes('url 参数为空'));

  /* --- skill_list / skill_load --- */
  const list = await run('skill_list', {});
  check('B2-16 skill_list 同时列出内置与文件技能（带适用场景）',
    list.ok && list.result.includes('bug-locator') && list.result.includes('code-navigator') && list.result.includes('适用：'),
    list.result.slice(0, 200));
  const listByCategory = await run('skill_list', { category: '代码' });
  check('B2-17 skill_list 按分类过滤', listByCategory.ok && !listByCategory.result.includes('bug-locator'));

  const loaded = await run('skill_load', { id: 'code-navigator' });
  check('B2-18 skill_load 返回完整方法论 + 推荐工具 + 预算',
    loaded.ok && loaded.result.includes('工具调用预算') && loaded.result.includes('## ') && loaded.result.length > 600,
    `${loaded.result.length} chars`);
  const unknownSkill = await run('skill_load', { id: 'no-such-skill' });
  check('B2-19 skill_load 未知 id 如实报错并列出可用项',
    !unknownSkill.ok && unknownSkill.result.includes('未知技能'), unknownSkill.result.slice(0, 120));
  const noId = await run('skill_load', {});
  check('B2-20 skill_load 缺 id 时提示先看清单', !noId.ok && noId.result.includes('mode=list'));

  /* 可用性判据：w-data 没有 server 资产 → cmd-advisor（依赖 server）必须判为不可用，
   * 而不是照样加载然后跑一堆不存在的工具。 */
  const dataCtx = { assetId: '', workspaceId: 'w-data', conversationId: 'c-test', identity };
  const unavailable = await mod.executeAgentTool('skill_load', { id: 'cmd-advisor' }, undefined, dataCtx);
  check('B2-21 缺少资产时 skill_load 拒绝加载并说明缺什么（不硬跑）',
    !unavailable.ok && unavailable.result.includes('不可用') && unavailable.result.includes('server'),
    unavailable.result.slice(0, 160));
  const dataList = await mod.executeAgentTool('skill_list', {}, undefined, dataCtx);
  check('B2-22 skill_list 对缺资产的工作区标注不可用（不隐藏、不假装可用）',
    dataList.ok
    && dataList.result.includes('cmd-advisor')
    && dataList.result.includes('不可用（缺少 server 资产）'),
    dataList.result.slice(0, 220));
}

/* ================= B3. 工具面收敛（合并 / 别名 / 新工具） ================= */
console.log('\n--- B3. 工具面收敛与新工具 ---');
{
  const face = mod.deriveToolFace('w-ops');
  const activeNames = face.active.map((t) => t.name);
  const run = async (name, args) => {
    const call = mod.normalizeToolCall(name, args);
    const tool = face.all.find((t) => t.name === call.name);
    const ctx = { assetId: tool?.assetId ?? '', workspaceId: 'w-ops', conversationId: 'c-test', identity };
    return mod.executeAgentTool(name, args, tool, ctx);
  };

  /* 22 条目录、srv_exec 因 prod 被剪枝 → active 21。这个数字是预算约束的体检项：
   * 加工具时它会变，改了它就该问一句"是不是该合并了"。 */
  check('B3-1 工具面收敛到预算内（目录 25 条 / active 24 / 上限 30）',
    face.all.length === 25 && activeNames.length === 24 && face.all.length <= mod.TOOL_FACE_BUDGET,
    `all=${face.all.length} active=${activeNames.length} budget=${mod.TOOL_FACE_BUDGET}`);

  const mergedAway = ['code_search', 'code_grep', 'code_glob', 'code_read', 'code_symbols',
    'code_diff', 'db_schema', 'db_tables', 'browser_navigate', 'browser_read_page',
    'skill_list', 'skill_load', 'code_edit_str'];
  check('B3-2 被合并的 13 个旧名不再进模型工具面',
    mergedAway.every((name) => !activeNames.includes(name)),
    activeNames.filter((name) => mergedAway.includes(name)).join(','));

  const problems = mod.validateToolCatalog();
  check('B3-3 目录自检零问题（目录 ↔ 权限表 ↔ 别名三方一致）', problems.length === 0, problems.join('；'));

  const alias = mod.normalizeToolCall('code_search', { query: 'timeout' });
  check('B3-4 别名归一：旧名 → 正式名 + 固定 mode + 参数改名',
    alias.name === 'code_find' && alias.args.mode === 'index'
    && alias.args.pattern === 'timeout' && alias.args.query === undefined,
    JSON.stringify(alias));
  check('B3-5 别名自带的 mode 优先于调用方传的 mode（旧名不能被指东打西）',
    mod.normalizeToolCall('code_grep', { pattern: 'x', mode: 'glob' }).args.mode === 'regex');

  const noMode = await run('code_find', { pattern: '**/*.java' });
  check('B3-6 正式名缺 mode 直接报错并列出四种判据',
    !noMode.ok && noMode.result.includes('glob') && noMode.result.includes('refs'), noMode.result.slice(0, 140));

  const badMode = await run('code_find', { mode: 'magic', pattern: 'x' });
  check('B3-7 未知 mode 被拒绝（不静默退化成 regex）',
    !badMode.ok && badMode.result.includes('未知 mode'), badMode.result.slice(0, 120));

  const glob = await run('code_find', { mode: 'glob', pattern: '**/*.java' });
  check('B3-8 code_find(mode=glob) 与旧名同源（同一份实现）',
    glob.ok && /匹配 \*\*\/\*\.java：\d+ 个/.test(glob.result), glob.result.slice(0, 120));

  const refs = await run('code_find', { mode: 'refs', pattern: 'setConnectTimeout' });
  /* setConnectTimeout 在本仓库只有调用没有定义（来自 Spring 客户端）——
   * 这正是 refs 该如实表达的：定义 0 处不等于符号不存在。 */
  check('B3-9 code_find(mode=refs) 给出定义/引用分类，并声明判定口径',
    refs.ok && /代码里出现 \d+ 处（定义 \d+ \/ 引用 \d+）/.test(refs.result) && refs.result.includes('词法级'),
    refs.result.slice(0, 160));

  const badRefs = await run('code_find', { mode: 'refs', pattern: 'a b(' });
  check('B3-10 refs 只接受单个标识符（不把正则当符号名）',
    !badRefs.ok && badRefs.result.includes('单个标识符'), badRefs.result.slice(0, 120));

  /* ---- refs 的同名分组：同名不同符号必须"被看见"，而不是只留一句免责声明 ---- */
  const fixture = [
    'package demo;',
    '',
    'class User {',
    '  void save() { }',
    '}',
    '',
    'class Order {',
    '  void save() { }',
    '}',
    '',
    'class Caller {',
    '  void run(User user, Order order) {',
    '    user.save();',
    '    order.save();',
    '    // save 在注释里，不该被算成引用',
    '  }',
    '}',
  ].join('\n');
  const seeded = await mod.executeFileWrite('a-order-service', 'v9-test/refs/Save.java', fixture, identity, 'w-ops', 'c-test');
  check('B3-10a 准备同名定义夹具（两个类各一个 save）', seeded.ok, seeded.message);

  const sameName = await run('code_find', { mode: 'refs', pattern: 'save' });
  check('B3-10b 同名定义散在两个容器时，分组表把歧义摆出来（不合并成"3 处引用"）',
    sameName.ok
    && sameName.result.includes('同名候选分组')
    && /定义落在 2 个容器：.*User\.save 1/.test(sameName.result)
    && /引用按接收者：order 1、user 1/.test(sameName.result),
    sameName.result.slice(0, 400));
  check('B3-10c 分组口径写明"不做类型推断"（只有拼写，没有类型）',
    sameName.result.includes('不做类型推断'), sameName.result.slice(0, 200));
  check('B3-10d 注释里的同名文本仍被排除并单独报数',
    /另有 1 处出现在注释或字符串里，已排除/.test(sameName.result), sameName.result.slice(0, 200));

  const capped = mod.summarizeRefs(
    Array.from({ length: 9 }, (_, i) => ({ line: i + 1, kind: 'reference', receiver: `r${i}` })),
    6,
  );
  check('B3-10e 分组表格上限 6 组，超出部分如实计数（不静默丢）',
    capped.byReceiver.length === 6 && capped.hiddenGroups === 3 && capped.covered === 9,
    `groups=${capped.byReceiver.length} hidden=${capped.hiddenGroups} covered=${capped.covered}`);
  check('B3-10f 定义都在同一个文件时不做跨文件收敛（没有"文件间歧义"这回事）',
    !sameName.result.includes('跨文件收敛'), sameName.result.slice(0, 160));

  /* ---- 跨文件同名：按 import 关系收敛（同名符号在不同文件里，接收者分组看不出来） ---- */
  const seed = async (rel, text) => mod.executeFileWrite('a-order-service', rel, text, identity, 'w-ops', 'c-test');
  const dir = 'v9-test/refsx';
  await seed(`${dir}/defs/user.ts`, 'export class User {\n  save() { return 1; }\n  run() { this.save(); }\n}\n');
  await seed(`${dir}/defs/order.ts`, 'export class Order {\n  save() { return 2; }\n}\n');
  await seed(`${dir}/defs/util.ts`, 'export function save() {\n  return 3;\n}\n');
  await seed(`${dir}/calls/api.ts`, "import { User } from '../defs/user';\n\nexport function run(u: User) {\n  u.save();\n  u.save();\n}\n");
  await seed(`${dir}/calls/web.ts`, "import { Order } from '../defs/order';\n\nexport function go(o: Order) {\n  o.save();\n}\n");
  await seed(`${dir}/calls/direct.ts`, "import { save } from '../defs/util';\n\nexport function direct() {\n  save();\n}\n");
  await seed(`${dir}/calls/mixed.ts`, "import { User } from '../defs/user';\nimport { Order } from '../defs/order';\n\nexport function mix(u: User, o: Order) {\n  u.save();\n  o.save();\n}\n");
  /* 注释里那句 import 必须不算：收敛表的证据只能来自真实导入。 */
  await seed(`${dir}/calls/legacy.ts`, "// import { save } from '../defs/util';\nexport function legacy(anyService: any) {\n  anyService.save();\n}\n");

  const conv = await run('code_find', { mode: 'refs', pattern: 'save', path: dir });
  const text = conv.result ?? '';
  check('B3-20a 定义散在多个文件时给出跨文件收敛表（并声明不做类型推断）',
    conv.ok && text.includes('跨文件收敛') && text.includes('不做类型推断'), text.slice(0, 200));
  check('B3-20b 定义文件带行号与所属符号（能直接跳过去）',
    text.includes(`${dir}/defs/user.ts:L2（User.save）`) && text.includes(`${dir}/defs/util.ts:L1（save）`),
    text.slice(0, 400));
  check('B3-20c 相对 import 解析到定义文件（../defs/user → defs/user.ts）',
    /calls\/api\.ts（引用 2）：导入 \.\.\/defs\/user → v9-test\/refsx\/defs\/user\.ts/.test(text), text.slice(0, 600));
  check('B3-20d 证据强度分开写：名单里有这个符号 ≠ 只是导入了模块',
    text.includes('（import 名单里就有这个符号）') && text.includes('（只导入了模块，名单里没有这个符号）'),
    text.slice(0, 600));
  check('B3-20e 同时导入两个定义的文件不硬猜，标"无法拆分"并列出候选',
    /calls\/mixed\.ts（引用 2）：导入了 2 个定义文件，无法拆分/.test(text)
    && text.includes('defs/order.ts（../defs/order）'),
    text.slice(0, 800));
  check('B3-20f 没有 import 证据的文件标"无法归属"（注释里的 import 不算证据）',
    /calls\/legacy\.ts（引用 1）：没有 import 证据，无法归属/.test(text), text.slice(0, 800));
  check('B3-20g 定义文件自己的引用与定义同文件（不并进跨文件歧义）',
    /defs\/user\.ts（引用 1 \/ 定义 1）：引用与定义同文件/.test(text), text.slice(0, 800));
  check('B3-20h 汇总四类计数齐全，且口径写明"只是导入了模块"',
    /汇总：引用 \d+ 处——按 import 归入唯一定义 \d+、导入多个定义分不开 \d+、无法归属 \d+、与定义同文件 \d+/.test(text)
    && text.includes('不表示每一处调用都解析到它'),
    text.slice(0, 900));

  /* Java 用绝对包名导入：两处同名定义只差包名，靠路径尾部匹配——但短尾部会把歧义带回来 */
  await seed(`${dir}/java/a/Repo.java`, 'package a;\n\npublic class Repo {\n  public void flush() { }\n}\n');
  await seed(`${dir}/java/b/Repo.java`, 'package b;\n\npublic class Repo {\n  public void flush() { }\n}\n');
  await seed(`${dir}/java/c/User.java`, 'package c;\n\nimport a.Repo;\n\npublic class User {\n  void go(Repo repo) {\n    repo.flush();\n  }\n}\n');
  const javaConv = await run('code_find', { mode: 'refs', pattern: 'flush', path: `${dir}/java` });
  check('B3-20i Java 绝对包名导入能收敛（a.Repo 不被短尾部 b/Repo 拉成"无法归属"）',
    javaConv.ok && /c\/User\.java（引用 1）：导入 a\.Repo → v9-test\/refsx\/java\/a\/Repo\.java/.test(javaConv.result),
    javaConv.result.slice(0, 600));

  /* ---- extractImports 单元：三方言 + 抹过的注释不算 ---- */
  const impTs = mod.extractImports(
    mod.maskNonCode("import { a, b as c } from './m';\nimport './side';\nconst x = require('./r');\nimport('name').then(f);", 'ts').masked,
    "import { a, b as c } from './m';\nimport './side';\nconst x = require('./r');\nimport('name').then(f);",
    'ts',
  );
  check('B3-21a ts：具名导入取名、侧效导入、require、动态 import 都识别',
    impTs.length === 4 && impTs[0].specifier === './m' && impTs[0].names.includes('a') && impTs[0].names.includes('b')
    && impTs[0].relative && impTs[1].specifier === './side' && impTs[2].specifier === './r'
    && impTs[3].specifier === 'name',
    JSON.stringify(impTs));
  const impJava = mod.extractImports('import a.b.User;\nimport static a.b.C.save;', 'import a.b.User;\nimport static a.b.C.save;', 'java');
  check('B3-21b java：普通导入取类名、static 导入取成员名',
    impJava.length === 2 && impJava[0].specifier === 'a.b.User' && impJava[0].names[0] === 'User'
    && impJava[1].names[0] === 'save',
    JSON.stringify(impJava));
  const impPy = mod.extractImports('from a.b import c, d\nimport x.y', 'from a.b import c, d\nimport x.y', 'python');
  check('B3-21c python：from-import 与 import 都识别，且不带相对路径标记',
    impPy.length === 2 && impPy[0].specifier === 'a.b' && impPy[0].names.join() === 'c,d' && !impPy[0].relative,
    JSON.stringify(impPy));
  const commented = "// import { save } from '../defs/util';\nconst s = 'import x from \"./fake\"';";
  check('B3-21d 注释与字符串里的 import 不被解析（先抹再取）',
    mod.extractImports(mod.maskNonCode(commented, 'ts').masked, commented, 'ts').length === 0,
    JSON.stringify(mod.extractImports(mod.maskNonCode(commented, 'ts').masked, commented, 'ts')));

  /* ---- 无返回类型的声明（TS 类方法 / 构造器）必须进大纲 ---- */
  const noRet = [
    'class Repo {',
    '  save() {',
    '    return 1;',
    '  }',
    '  empty() { }',
    '  constructor() { }',
    '  typed(x: number): void {',
    '    this.helper(x);',
    '  }',
    '  @Deprecated composed() { }',
    '}',
    'function outer() {',
    '  doSomething(1);',
    '  list.map((x) => {',
    '    return x;',
    '  });',
    '}',
  ].join('\n');
  const noRetMask = mod.maskNonCode(noRet, 'ts').masked;
  const noRetSyms = mod.extractSymbols(noRetMask, noRet, 'ts').map((item) => item.name);
  check('B3-21e 无返回类型的类方法/构造器/带注解的方法被识别为定义（refs 才不会说"定义 0 处"）',
    ['Repo', 'save', 'empty', 'constructor', 'typed', 'composed', 'outer'].every((name) => noRetSyms.includes(name)),
    noRetSyms.join(','));
  check('B3-21f 调用语句与箭头回调不会被当成方法声明',
    !noRetSyms.includes('doSomething') && !noRetSyms.includes('map') && !noRetSyms.includes('x'),
    noRetSyms.join(','));

  const outline = await run('code_view', { mode: 'outline', path: 'src/main/java/order/InventoryClient.java' });
  check('B3-11 code_view(mode=outline) 返回符号大纲',
    outline.ok && outline.result.includes('符号大纲'), outline.result.slice(0, 120));

  const diff = await run('code_view', { mode: 'diff', path: 'src/main/java/order/InventoryClient.java' });
  check('B3-12 code_view(mode=diff) 返回真实工作区状态（clean 或无变更都如实说）',
    diff.ok && (diff.result.includes('无变更') || diff.result.includes('未提交变更')), diff.result.slice(0, 120));

  /* ---- diff 的未追踪分支：空 diff ≠ 没改动 ---- */
  const ghostRel = 'v9-test/refs/Untracked.txt';
  const ghostSeed = await mod.executeFileWrite('a-order-service', ghostRel, 'hello\n', identity, 'w-ops', 'c-test');
  const ghostDiff = await run('code_view', { mode: 'diff', path: ghostRel });
  check('B3-12a 未追踪文件不冒充 clean（git diff HEAD 看不见新文件）',
    ghostSeed.ok && ghostDiff.ok && ghostDiff.result.includes('未追踪') && !ghostDiff.result.includes('无变更'),
    ghostDiff.result.slice(0, 200));

  /* ---- mode=status：整仓"这批活改到了哪些文件" ---- */
  const statusAll = await run('code_view', { mode: 'status' });
  check('B3-12b mode=status 不带 path 也能列整仓变更（含未追踪条目）',
    statusAll.ok && /共 \d+ 项变更/.test(statusAll.result) && statusAll.result.includes(`?? ${ghostRel}`),
    statusAll.result.slice(0, 240));

  const statusScoped = await run('code_view', { mode: 'status', path: 'v9-test' });
  check('B3-12c mode=status 带 path 时只看该路径（不串到别的文件）',
    statusScoped.ok && statusScoped.result.includes('v9-test 范围内') && !statusScoped.result.includes('README.md'),
    statusScoped.result.slice(0, 200));

  const statusClean = await run('code_view', { mode: 'status', path: 'pom.xml' });
  check('B3-12d 干净路径如实说干净（并说明这是 git 的当前事实）',
    statusClean.ok && statusClean.result.includes('工作区干净') && statusClean.result.includes('当前事实'),
    statusClean.result.slice(0, 160));

  /* 敏感文件只报数量不回显路径：status 是新开的一条"能看见文件名"的通道。 */
  const secrets = path.join(mod.REPO_ROOT, 'v9-test', 'refs', '.env');
  writeFileSync(secrets, 'DB_PASSWORD=demo\n', 'utf8');
  const statusHidden = await run('code_view', { mode: 'status', path: 'v9-test' });
  check('B3-12e status 不回显敏感文件路径（只报隐藏了几项）',
    statusHidden.ok && statusHidden.result.includes('敏感规则') && !statusHidden.result.includes('.env'),
    statusHidden.result.slice(0, 240));

  const noPath = await run('code_view', { mode: 'content' });
  check('B3-12f path 从 required 移走后，content 缺 path 仍报错并指出 status 这条替代',
    !noPath.ok && noPath.result.includes('需要 path') && noPath.result.includes('mode=status'), noPath.result.slice(0, 160));

  /* ---- 单文件 diff 也走同一套边界装配（以前是 slice(0, 3000)，裁在 hunk 中间） ---- */
  const probeRel = 'src/main/java/order/OrderService.java';
  const probeAbs = path.join(mod.REPO_ROOT, probeRel);
  const probeOriginal = readFileSync(probeAbs, 'utf8');
  let probeDiff;
  try {
    const probeLines = probeOriginal.split('\n');
    /* 头尾各插一行：两处改动相隔整个文件，必然切成两个独立 hunk。 */
    writeFileSync(probeAbs, ['// v9-diff-probe-A', ...probeLines, '// v9-diff-probe-B', ''].join('\n'), 'utf8');
    probeDiff = await run('code_view', { mode: 'diff', path: probeRel });
  } finally {
    writeFileSync(probeAbs, probeOriginal, 'utf8');
  }
  check('B3-12g 单文件 diff 报 hunk 总数，两个改动点各占一个完整 hunk（不做字符截断）',
    probeDiff.ok && /共 2 个 hunk/.test(probeDiff.result)
    && (probeDiff.result.match(/^@@ /gm) ?? []).length === 2
    && probeDiff.result.includes('v9-diff-probe-A') && probeDiff.result.includes('v9-diff-probe-B'),
    probeDiff.result.slice(0, 240));

  /* 单文件视图里"单文件最多吃 40% 预算"必须失效：没有别人的份额可抢。
   * 夹具刻意做成 预算 3000 → 能整段展开第 1 个 hunk、装不下第 2 个；
   * 若 40% 上限还在（1200），一个 hunk 都装不下，会错误地退成行窗口。 */
  const mkHunk = (start, half) => [`@@ -${start},2 +${start},2 @@`, `-${'a'.repeat(half)}`, `+${'b'.repeat(half)}`, ''].join('\n');
  const soloChunks = mod.splitDiffByFile(
    ['diff --git a/one.ts b/one.ts', '--- a/one.ts', '+++ b/one.ts', mkHunk(1, 600), mkHunk(40, 1200)].join('\n'),
  );
  const solo = mod.assembleDiff(soloChunks, 3000, { header: false });
  check('B3-12h 单文件不吃 40% 上限（预算 3000 能展开 1 个整 hunk，而不是退成行窗口）',
    solo.partial.length === 1 && solo.partial[0].shown === 1 && solo.clipped.length === 0
    && !solo.blocks[0].startsWith('---'),
    JSON.stringify({ partial: solo.partial, clipped: solo.clipped, used: solo.used }));

  const giantChunks = mod.splitDiffByFile([
    'diff --git a/giant.ts b/giant.ts', '--- a/giant.ts', '+++ b/giant.ts',
    '@@ -1,200 +1,200 @@', ...Array.from({ length: 200 }, (_, i) => `-line-${i}-${'z'.repeat(60)}`),
  ].join('\n'));
  const windowed = mod.assembleDiff(giantChunks, 3000, { header: false });
  check('B3-12i 关掉抬头后，行窗口仍保留「共 N 行 / 只给前 K 行」的准确数字',
    windowed.clipped.length === 1
    && /（第 1 个 hunk 共 \d+ 行，本次只给前 \d+ 行）/.test(windowed.blocks[0])
    && windowed.blocks[0].includes('未显示'),
    windowed.blocks[0].slice(0, 160));

  const inspect = await run('db_inspect', { mode: 'counts', tables: 'inventory' });
  check('B3-13 db_inspect(mode=counts) 真实 COUNT',
    inspect.ok && /inventory：\d+ 行/.test(inspect.result), inspect.result.slice(0, 120));

  /* ---- git_history：真实 git CLI ---- */
  const gitLog = await run('git_history', { mode: 'log', limit: 5 });
  check('B3-14 git_history(mode=log) 读到真实提交',
    gitLog.ok && /[0-9a-f]{7}\|\d{4}-\d{2}-\d{2}\|/.test(gitLog.result), gitLog.result.slice(0, 200));

  /* ---- git show：按文件整段展开，绝不裁半个 hunk ---- */
  const show = await run('git_history', { mode: 'show' });
  check('B3-14a git_history(mode=show) 给 stat 概览 + 按文件展开的完整 diff（不再说"截断到 4000 字符"）',
    show.ok && /共 \d+ 个文件/.test(show.result) && show.result.includes('diff --git')
    && !show.result.includes('截断到 4000 字符'), show.result.slice(0, 220));

  const showScoped = await run('git_history', { mode: 'show', path: 'src/main/java/order/OrderService.java' });
  check('B3-14b show 带 path 只展开该文件（不串到同提交的其他文件）',
    showScoped.ok && showScoped.result.includes('OrderService.java') && !showScoped.result.includes('OrderController'),
    showScoped.result.slice(0, 200));

  /* 合成 diff：每个 hunk ~320 字符，两个 hunk + 抬头 ≈ 760 字符，
   * 这样"预算 500"能装下抬头 + 第一个 hunk，装不下第二个。 */
  const pad = (n) => ` ${'x'.repeat(n)}`;
  const synthetic = [
    'diff --git a/a.ts b/a.ts',
    'index 111..222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    pad(100),
    pad(100),
    pad(100),
    ' // end1',
    '@@ -10,2 +10,2 @@',
    '-old2',
    '+new2',
    pad(100),
    pad(100),
    pad(100),
    ' // end2',
    'diff --git a/b.ts b/b.ts',
    'index 333..444 100644',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -1 +1 @@',
    '-x',
    '+y',
  ].join('\n');
  const chunks = mod.splitDiffByFile(synthetic);
  check('B3-14c diff 按文件切分（路径取新名、hunk 计数正确）',
    chunks.length === 2 && chunks[0].path === 'a.ts' && chunks[0].hunks === 2 && chunks[1].path === 'b.ts',
    JSON.stringify(chunks.map((c) => ({ path: c.path, hunks: c.hunks }))));

  /* 单个两-hunk 文件，预算 500：整段装不下 → 展开一个完整 hunk，第二个 hunk 一个字都不出现 */
  const tight = mod.assembleDiff(chunks.slice(0, 1), 500);
  check('B3-14d 预算不足时按整 hunk 展开（不是按字符截断）',
    tight.partial.length === 1 && tight.partial[0].shown === 1 && tight.partial[0].total === 2
    && tight.blocks[0].trimEnd().endsWith('// end1') && !tight.blocks[0].includes('+new2'),
    JSON.stringify({ partial: tight.partial, tail: tight.blocks[0].trimEnd().slice(-24) }));

  /* 分配先小后大、输出仍按原序：小文件必须整体进来，大文件退到窗口 */
  const greedy = mod.assembleDiff(chunks, 500);
  check('B3-14g 预算紧张时优先给小的（大文件不能把 2 行的小文件挤掉），输出仍按文件原序',
    greedy.included === 1 && greedy.clipped.length === 1 && greedy.clipped[0].path === 'a.ts'
    && greedy.blocks[0].startsWith('--- a.ts') && greedy.blocks[1].startsWith('--- b.ts')
    && greedy.blocks[1].includes('+y'),
    JSON.stringify({ included: greedy.included, clipped: greedy.clipped, order: greedy.blocks.map((b) => b.slice(0, 12)) }));

  const roomy = mod.assembleDiff(chunks, 10000);
  check('B3-14e 预算充足时两个文件都完整展开，且不报"未展开"',
    roomy.included === 2 && roomy.skipped.length === 0 && roomy.partial.length === 0 && roomy.blocks.length === 2,
    JSON.stringify({ included: roomy.included, skipped: roomy.skipped }));

  /* 一个 4.8KB 的巨型文件 + 两个 140 字符的小文件：预算 5000 ——
   * 谁都不许被静默挤掉（小文件先分配，大文件吃剩下的，且单文件有比例上限） */
  const bigChunk = {
    path: 'huge.ts',
    text: `diff --git a/huge.ts b/huge.ts\n@@ -1 +1 @@\n${`+${'q'.repeat(60)}\n`.repeat(78)}`,
    hunks: 1,
    binary: false,
  };
  const cover = mod.assembleDiff([bigChunk, chunks[1], chunks[1]], 5000);
  check('B3-14h 巨型文件不能把同提交的小文件挤掉（小文件整体进、大文件退到窗口）',
    cover.blocks.length === 3 && cover.skipped.length === 0
    && cover.included === 2 && cover.clipped.length === 1 && cover.clipped[0].path === 'huge.ts',
    JSON.stringify({ blocks: cover.blocks.length, skipped: cover.skipped, included: cover.included, clipped: cover.clipped }));

  /* 一个超长 hunk（400 行）一个都装不下 → 给行窗口，并且把"缺多少行"写在窗口末尾 */
  const hugeHunk = [
    'diff --git a/big.ts b/big.ts',
    '--- a/big.ts',
    '+++ b/big.ts',
    '@@ -1,400 +1,400 @@',
    ...Array.from({ length: 400 }, (_, i) => `+line ${i} ${'y'.repeat(20)}`),
  ].join('\n');
  const clipped = mod.assembleDiff(mod.splitDiffByFile(hugeHunk), 400);
  check('B3-14f hunk 装不下时给带标注的行窗口（不返回空块，也不假装完整）',
    clipped.clipped.length === 1 && clipped.blocks.length === 1
    && clipped.clipped[0].shownLines < clipped.clipped[0].totalLines
    && clipped.blocks[0].includes('未显示') && clipped.blocks[0].includes('还有'),
    JSON.stringify({ clipped: clipped.clipped, tail: clipped.blocks[0].slice(-60) }));

  const gitBlame = await run('git_history', { mode: 'blame', path: 'src/main/java/order/InventoryClient.java', limit: 3 });
  check('B3-15 git_history(mode=blame) 逐行溯源（带提交号）',
    gitBlame.ok && /git blame/.test(gitBlame.result), gitBlame.result.slice(0, 160));

  const gitNoPath = await run('git_history', { mode: 'blame' });
  check('B3-16 blame 缺 path 时明确要 path（不猜文件）',
    !gitNoPath.ok && gitNoPath.result.includes('path'), gitNoPath.result.slice(0, 120));

  const gitBadRev = await run('git_history', { mode: 'show', rev: '--output=/tmp/x' });
  check('B3-17 rev 只接受引用字符集（-- 开头的选项注入被拒）',
    !gitBadRev.ok && gitBadRev.result.includes('rev'), gitBadRev.result.slice(0, 140));

  const gitEsc = await run('git_history', { mode: 'log', path: '../../etc/passwd' });
  check('B3-18 path 不能跳出仓库', !gitEsc.ok && gitEsc.result.includes('跳出仓库'), gitEsc.result.slice(0, 120));

  /* ---- memo：跨上下文压缩的事实载体 ---- */
  const emptyMemo = await run('memo', { mode: 'read' });
  check('B3-19 空笔记如实说"是空的"（不是读取失败）',
    emptyMemo.ok && emptyMemo.result.includes('空的'), emptyMemo.result.slice(0, 120));

  const wrote = await run('memo', { mode: 'write', content: '超时根因：索引缺失（EXPLAIN 已证实）' });
  check('B3-20 memo(mode=write) 追加成功并回报版本',
    wrote.ok && /第 1 版/.test(wrote.result), wrote.result.slice(0, 140));

  await run('memo', { mode: 'write', content: 'InventoryClient 默认超时 800ms' });
  const readMemo = await run('memo', { mode: 'read' });
  check('B3-21 memo(mode=read) 取回两条历史条目',
    readMemo.ok && readMemo.result.includes('索引缺失') && readMemo.result.includes('800ms') && /第 2 版/.test(readMemo.result),
    readMemo.result.slice(0, 200));

  const emptyWrite = await run('memo', { mode: 'write', content: '   ' });
  check('B3-22 空内容不写入（空笔记会让下一次 read 永远拿不到东西）',
    !emptyWrite.ok && emptyWrite.result.includes('content'), emptyWrite.result.slice(0, 120));

  /* ---- 写工具在只读执行器里只表达意图 ---- */
  const editIntent = await run('code_edit', { mode: 'replace', path: 'README.md', oldString: 'a', newString: 'b' });
  check('B3-23 写工具经只读执行器时只表达意图（不落盘、不假装成功）',
    !editIntent.ok && editIntent.result.includes('需要人工审批'), editIntent.result.slice(0, 140));
}

/* ================= B4. 广度补齐（执行计划 / 外部检索 / 子代理 / 文件组织） ================= */
console.log('\n--- B4. 广度补齐 ---');
{
  const face = mod.deriveToolFace('w-ops');
  const run = async (name, args) => {
    const call = mod.normalizeToolCall(name, args);
    const tool = face.all.find((t) => t.name === call.name);
    const ctx = { assetId: tool?.assetId ?? '', workspaceId: 'w-ops', conversationId: 'c-test', identity };
    return mod.executeAgentTool(name, args, tool, ctx);
  };

  /* ---- db_inspect(mode=explain)：给计划，不给"慢不慢"的结论 ---- */
  const plan = await run('db_inspect', { mode: 'explain', sql: "SELECT * FROM inventory WHERE sku = 'A-1'" });
  check('B4-1 explain 返回真实执行计划，并明确声明「计划≠耗时」',
    plan.ok && plan.result.includes('执行计划') && plan.result.includes('不是耗时'), plan.result.slice(0, 160));

  const planWrite = await run('db_inspect', { mode: 'explain', sql: 'DELETE FROM inventory' });
  check('B4-2 explain 拒绝写语句（只解释 SELECT / WITH）',
    !planWrite.ok && planWrite.result.includes('SELECT'), planWrite.result.slice(0, 120));

  const planNoSql = await run('db_inspect', { mode: 'explain' });
  check('B4-3 explain 缺 sql 时明确索要，不猜一条',
    !planNoSql.ok && planNoSql.result.includes('sql'), planNoSql.result.slice(0, 120));

  /* ---- web_search：没接入后端就必须明确拒绝，绝不返回编造结果 ---- */
  const backend = mod.searchBackend();
  const search = await run('web_search', { query: 'DevWork 工具面预算' });
  if (!backend.configured) {
    check('B4-4 搜索未接入时明确报错并给替代路径（禁止编造搜索结果）',
      !search.ok && search.result.includes('未接入') && search.result.includes('web_fetch'),
      search.result.slice(0, 200));
  } else {
    check('B4-4 已配置搜索后端时返回真实结果（空结果也算真实返回）',
      search.ok === true, search.result.slice(0, 160));
  }

  /* ---- subtask：没有注入执行器 / 没有模型，都必须如实拒绝 ---- */
  const noRunner = await run('subtask', { goal: '查一下超时配置在哪设置' });
  check('B4-5 未注入子代理执行器时如实报不可用（不假装跑过）',
    !noRunner.ok && noRunner.result.includes('不可用'), noRunner.result.slice(0, 160));

  const subEmpty = await mod.runSubagent({
    goal: '随便看看', workspaceId: 'w-ops', conversationId: 'c-test',
    tools: [], executeTool: async () => ({ ok: true, result: '' }),
  });
  check('B4-6 子代理在无工具面时拒绝执行并说明原因',
    !subEmpty.ok && subEmpty.note.includes('没有可用于子代理'), subEmpty.note.slice(0, 160));

  const subNoGoal = await mod.runSubagent({
    goal: '   ', workspaceId: 'w-ops', conversationId: 'c-test',
    tools: [], executeTool: async () => ({ ok: true, result: '' }),
  });
  check('B4-7 子代理空 goal 直接拒绝（它看不到主对话，空描述必然跑偏）',
    !subNoGoal.ok && subNoGoal.note.includes('goal'), subNoGoal.note.slice(0, 120));

  /* ---- fs_manage：真实目录/复制/移动/删除 + 回收站回滚 ---- */
  const mkdir = await mod.executeFsManage('a-order-service', 'mkdir', '', 'src/b4-dir', identity, 'w-ops', 'c-test');
  check('B4-8 fs_manage(mkdir) 真实创建目录', mkdir.ok && mkdir.diskChanged === true, mkdir.message.slice(0, 120));

  const mkdirDup = await mod.executeFsManage('a-order-service', 'mkdir', '', 'src/b4-dir', identity, 'w-ops', 'c-test');
  check('B4-9 mkdir 目标已存在时拒绝（不静默成功）',
    !mkdirDup.ok && mkdirDup.message.includes('已存在'), mkdirDup.message.slice(0, 120));

  await mod.executeFileWrite('a-order-service', 'src/b4-dir/a.txt', 'hello b4', identity, 'w-ops', 'c-test');
  const copied = await mod.executeFsManage('a-order-service', 'copy', 'src/b4-dir/a.txt', 'src/b4-dir/b.txt', identity, 'w-ops', 'c-test');
  check('B4-10 copy 成功并给出回滚引用', copied.ok && !!copied.rollbackRef, copied.message.slice(0, 120));

  const copDup = await mod.executeFsManage('a-order-service', 'copy', 'src/b4-dir/a.txt', 'src/b4-dir/b.txt', identity, 'w-ops', 'c-test');
  check('B4-11 copy 目标已存在时拒绝覆盖（覆盖是显式写，不是组织操作的副作用）',
    !copDup.ok && copDup.message.includes('不覆盖'), copDup.message.slice(0, 140));

  const moved = await mod.executeFsManage('a-order-service', 'move', 'src/b4-dir/b.txt', 'src/b4-dir/c.txt', identity, 'w-ops', 'c-test');
  check('B4-12 move 成功（源消失、目标出现）', moved.ok && moved.diskChanged === true, moved.message.slice(0, 120));

  const escaped = await mod.executeFsManage('a-order-service', 'move', 'src/b4-dir/c.txt', '../escape.txt', identity, 'w-ops', 'c-test');
  check('B4-13 目标路径越界被拒（from / to 两条路径都要校验）',
    !escaped.ok && escaped.message.includes('越界'), escaped.message.slice(0, 140));

  const deleted = await mod.executeFsManage('a-order-service', 'delete', 'src/b4-dir/c.txt', '', identity, 'w-ops', 'c-test');
  check('B4-14 delete 移入回收站而非真删（给出可回滚引用）',
    deleted.ok && !!deleted.rollbackRef && deleted.message.includes('可回滚'), deleted.message.slice(0, 140));

  const restored = await mod.rollbackWritePlan(String(deleted.rollbackRef), identity, 'w-ops');
  check('B4-15 删除可回滚：文件回到原路径', restored.ok, restored.message.slice(0, 140));

  /* 清理（整个目录移入回收站，测试不留痕） */
  await mod.executeFsManage('a-order-service', 'delete', 'src/b4-dir', '', identity, 'w-ops', 'c-test');

  /* ---- fs_manage 在只读执行器里只表达意图：不落盘 ---- */
  const fsIntent = await run('fs_manage', { mode: 'delete', from: 'README.md' });
  check('B4-16 fs_manage 经只读执行器时只表达意图（不落盘、不假装成功）',
    !fsIntent.ok && fsIntent.result.includes('审批'), fsIntent.result.slice(0, 140));
}

/* ================= B5. 词法层（注释/字符串感知） ================= */
console.log('\n--- B5. 词法层 ---');
{
  const { maskNonCode, extractSymbols, findOccurrences, lexLangOf } = mod;

  /* ---- ① 抹除：行号必须不变，注释/字符串内容必须消失 ---- */
  const tsSample = [
    'const a = 1; // 调 setConnectTimeout 也没用',
    'const s = "setConnectTimeout";',
    '/* 整块注释',
    '   setConnectTimeout(1000);',
    '   class Fake { }',
    '*/',
    'function setConnectTimeout(ms) {',
    '  return ms;',
    '}',
    'const t = `call ${setConnectTimeout(5)} now`;',
  ].join('\n');
  const tsMask = maskNonCode(tsSample, lexLangOf('a.ts'));
  const tsLines = tsMask.masked.split('\n');

  check('B5-1 抹除后行数不变（行号是引用证据的坐标，不能被改变）',
    tsLines.length === tsSample.split('\n').length,
    `${tsLines.length} vs ${tsSample.split('\n').length}`);
  check('B5-2 行注释被抹掉',
    !tsLines[0].includes('setConnectTimeout') && tsLines[0].startsWith('const a = 1;'),
    tsLines[0]);
  check('B5-3 块注释跨行整体被抹掉（含注释里的 class Fake）',
    !tsMask.masked.includes('Fake') && !tsLines[3].includes('setConnectTimeout'),
    tsLines[3]);
  check('B5-4 双引号字符串内容被抹掉',
    !tsMask.masked.includes('"setConnectTimeout"'),
    tsLines[1]);
  /* 模板字符串里的 ${} 是代码：抹掉它等于丢掉真实调用。
   * 但 `call ` 与 ` now` 这些字面量部分必须被抹掉。 */
  check('B5-5 模板字符串：字面量被抹、${} 插值内仍是代码',
    !tsLines[9].includes('call') && tsLines[9].includes('setConnectTimeout(5)'),
    tsLines[9]);

  /* ---- ② 符号：注释里的"假声明"不能变成符号 ---- */
  const tsSymbols = extractSymbols(tsMask.masked, tsSample, 'ts');
  check('B5-6 注释里的 class Fake 不产生符号',
    !tsSymbols.some((s) => s.name === 'Fake'),
    tsSymbols.map((s) => s.name).join(','));
  const tsFn = tsSymbols.find((s) => s.name === 'setConnectTimeout');
  check('B5-7 函数符号带真实行区间（L7-9）',
    tsFn && tsFn.line === 7 && tsFn.endLine === 9,
    JSON.stringify(tsFn));

  /* ---- ③ Java：方法要能说出属于哪个类，且带区间 ---- */
  const javaSample = [
    'package x;',
    'public class InventoryClient {',
    '  private int timeout = 800;',
    '  // public void fake() {}',
    '  public void setTimeout(int ms) {',
    '    this.timeout = ms;',
    '  }',
    '  @Override',
    '  public String toString() {',
    '    return "InventoryClient";',
    '  }',
    '}',
  ].join('\n');
  const javaMask = maskNonCode(javaSample, 'java');
  const javaSymbols = extractSymbols(javaMask.masked, javaSample, 'java');
  check('B5-8 Java：注释里的方法声明不产生符号',
    !javaSymbols.some((s) => s.name === 'fake'),
    javaSymbols.map((s) => s.name).join(','));
  const javaMethod = javaSymbols.find((s) => s.name === 'setTimeout');
  check('B5-9 Java 方法带所属类与行区间（InventoryClient.setTimeout L5-7）',
    javaMethod && javaMethod.container === 'InventoryClient' && javaMethod.line === 5 && javaMethod.endLine === 7,
    JSON.stringify(javaMethod));
  check('B5-10 Java 字符串里的类名不产生符号（return "InventoryClient"）',
    javaSymbols.filter((s) => s.name === 'InventoryClient').length === 1,
    javaSymbols.map((s) => s.name).join(','));

  /* ---- ④ Python：docstring 与缩进区间 ---- */
  const pySample = [
    'class Repo:',
    '    """docstring',
    '    里面写 setConnectTimeout 也不算引用',
    '    """',
    '    def find(self, name):',
    '        tmp = name',
    '        return tmp',
    '',
    'def main():',
    '    pass',
  ].join('\n');
  const pyMask = maskNonCode(pySample, 'python');
  const pySymbols = extractSymbols(pyMask.masked, pySample, 'python');
  const pyMethod = pySymbols.find((s) => s.name === 'find');
  check('B5-11 Python docstring 被抹掉（三引号跨行）',
    !pyMask.masked.includes('setConnectTimeout'),
    pyMask.masked.split('\n')[2]);
  check('B5-12 Python 方法属于所在类（Repo.find）',
    pyMethod && pyMethod.container === 'Repo' && pyMethod.kind === 'method',
    JSON.stringify(pyMethod));
  check('B5-13 Python 函数内局部赋值不进大纲（tmp 是噪音）',
    !pySymbols.some((s) => s.name === 'tmp'),
    pySymbols.map((s) => s.name).join(','));

  /* ---- ⑤ 出现位置：定义/引用分开，注释与字符串单独计数 ---- */
  const scan = findOccurrences(tsMask.masked, tsSample, 'setConnectTimeout', { symbols: tsSymbols });
  check('B5-14 注释与字符串里的 3 处命中被排除，且数量如实上报',
    scan.excludedInNonCode === 3,
    `excluded=${scan.excludedInNonCode}`);
  check('B5-15 代码里只剩 2 处：1 处定义 + 1 处引用',
    scan.occurrences.length === 2
    && scan.occurrences.filter((o) => o.kind === 'definition').length === 1
    && scan.occurrences.filter((o) => o.kind === 'reference').length === 1,
    JSON.stringify(scan.occurrences));
  check('B5-16 定义命中带确切列号（L7:C10）',
    scan.occurrences[0].line === 7 && scan.occurrences[0].column === 10,
    JSON.stringify(scan.occurrences[0]));
  check('B5-17 非标识符输入直接返回空（不把正则当符号）',
    findOccurrences(tsMask.masked, tsSample, 'a b(').occurrences.length === 0);

  /* ---- ⑥ 端到端：同一个符号，旧口径（grep）与词法口径的结果必须不同 ---- */
  const face = mod.deriveToolFace('w-ops');
  const run = async (name, args) => {
    const call = mod.normalizeToolCall(name, args);
    const tool = face.all.find((t) => t.name === call.name);
    const ctx = { assetId: tool?.assetId ?? '', workspaceId: 'w-ops', conversationId: 'c-test', identity };
    return mod.executeAgentTool(name, args, tool, ctx);
  };
  const refs = await run('code_find', { mode: 'refs', pattern: 'setReadTimeout' });
  check('B5-18 refs 输出说明排除口径（注释/字符串单独计数）',
    refs.ok && (refs.result.includes('已排除') || refs.result.includes('本次排除 0 处')),
    refs.result.slice(0, 200));
  check('B5-19 refs 同时声明局限（词法级、同名合并）',
    refs.ok && refs.result.includes('词法级'),
    refs.result.slice(0, 200));

  const outline = await run('code_view', { mode: 'outline', path: 'src/main/java/order/InventoryClient.java' });
  check('B5-20 大纲输出带行区间与所属类（模型可直接按区间读方法体）',
    outline.ok && /L\d+-\d+/.test(outline.result) && outline.result.includes('InventoryClient.'),
    outline.result.slice(0, 240));
}

/* ================= C1. 命令模板库 ================= */
console.log('\n--- C1. 命令模板库 ---');
{
  const match1 = mod.matchTemplate('restart_service');
  check('C1-1 意图精确匹配 restart_service', !!match1 && match1.id === 'restart-service');
  const match2 = mod.matchTemplate('帮我清理一下日志');
  check('C1-2 关键词模糊匹配（清理日志）', !!match2 && match2.id === 'rotate-log');
  const match3 = mod.matchTemplate('rm -rf /');
  check('C1-3 模板外意图返回 null（无模板 = 拒绝执行）', match3 === null);

  const bad = mod.validateParams(mod.CMD_TEMPLATES.find((t) => t.id === 'restart-service'), { service: 'payment-api' });
  check('C1-4 参数白名单外取值被拒（模型只能选不能造）', !bad.ok && bad.error.includes('白名单'), bad.error);

  /* 真实执行：日志轮转（builtin handler，真实落盘 + 真实回滚）。 */
  for (let index = 0; index < 15; index += 1) mod.appendLog('INFO', `轮转前日志行 ${index}`);
  const beforeLines = mod.readLogLines().length;
  const outcome = await mod.executeSrvTemplate('a-order-api', 'rotate_log', { keepLines: 10 }, identity, 'w-ops');
  const afterLines = mod.readLogLines().length;
  check('C1-5 rotate_log 真实执行（行数收缩到 keepLines）',
    outcome.ok && afterLines === 10 && beforeLines > 10,
    `before=${beforeLines} after=${afterLines} msg=${outcome.message.slice(0, 100)}`);
  const rolledBack = await mod.rollbackWritePlan(outcome.rollbackRef, identity, 'w-ops');
  check('C1-6 rotate_log 回滚恢复全部日志行',
    rolledBack.ok && mod.readLogLines().length === beforeLines,
    `after rollback=${mod.readLogLines().length}, expect=${beforeLines}`);

  const noTemplate = await mod.executeSrvTemplate('a-order-api', 'rm -rf /', {}, identity, 'w-ops');
  check('C1-7 模板外操作拒绝且不落盘', !noTemplate.ok && noTemplate.message.includes('模板') && !noTemplate.diskChanged);

  /* native 模板：systemctl 在沙箱多半不可用 → 如实降级（不伪造成功）。 */
  const restart = await mod.executeSrvTemplate('a-order-api', 'restart_service', { service: 'order-api' }, identity, 'w-ops');
  check('C1-8 restart_service 如实上报（不可用即降级，不伪造成功）',
    (restart.ok === false && restart.diskChanged === false) || restart.ok === true,
    `ok=${restart.ok}, msg=${restart.message.slice(0, 100)}`);
}

/* ================= C2. 文件写 + 回滚 ================= */
console.log('\n--- C2. 文件写三层防线 ---');
{
  const first = await mod.executeFileWrite('a-order-service', 'v9-test/agent-write.md', '第一版内容', identity, 'w-ops');
  check('C2-1 新文件写入成功（precheck 通过 → 落盘 → 校验）',
    first.ok && first.diskChanged, first.message);

  const second = await mod.executeFileWrite('a-order-service', 'v9-test/agent-write.md', '第二版内容', identity, 'w-ops');
  check('C2-2 覆盖写入成功且带回滚引用', second.ok && typeof second.rollbackRef === 'string', second.message);

  const restored = await mod.rollbackWritePlan(second.rollbackRef, identity, 'w-ops');
  check('C2-3 回滚恢复到第一版', restored.ok, restored.message);

  const sensitive = await mod.executeFileWrite('a-order-service', '.env', 'SECRET=1', identity, 'w-ops');
  check('C2-4 敏感文件写入被 precheck 拦截（审批不豁免现实检查）',
    !sensitive.ok && sensitive.message.includes('precheck') && !sensitive.diskChanged, sensitive.message.slice(0, 120));

  const escape = await mod.executeFileWrite('a-order-service', '../../outside.md', 'x', identity, 'w-ops');
  check('C2-5 路径越界被拦截', !escape.ok && !escape.diskChanged, escape.message.slice(0, 120));
}

/* ================= C2b. 精确替换（code_edit mode=replace，旧名 code_edit_str） ================= */
console.log('\n--- C2b. 精确替换三层防线 ---');
{
  const rel = 'v9-test/str-replace.md';
  const original = 'alpha line\nneedle A\nbeta line\nneedle B\nomega line';
  const seed = await mod.executeFileWrite('a-order-service', rel, original, identity, 'w-ops', 'c-test');
  check('C2b-0 准备基线文件', seed.ok, seed.message);

  const readTool = async () => (await mod.executeAgentTool('code_read',
    { path: rel, offset: 1, limit: 200 }, undefined,
    { assetId: 'a-order-service', workspaceId: 'w-ops', conversationId: 'c-test', identity })).result;
  const contentOf = async () => (await readTool()).split('\n')
    .map((line) => /^\s*\d+ \| (.*)$/.exec(line)?.[1] ?? null)
    .filter((line) => line !== null)
    .join('\n');

  /* ① 未命中 → 中止且磁盘零变更（模型对文件的理解错了，不该硬改）。 */
  const miss = await mod.executeFileStrReplace('a-order-service', rel, 'not-in-file', 'X', false, identity, 'w-ops', 'c-test');
  check('C2b-1 oldString 未命中 → precheck 中止且零变更',
    !miss.ok && miss.diskChanged === false && miss.message.includes('未命中'), miss.message.slice(0, 140));
  check('C2b-2 中止后文件内容原样', (await contentOf()) === original);

  /* ② 多命中且未声明 replaceAll → 位置有歧义，中止。 */
  const multi = await mod.executeFileStrReplace('a-order-service', rel, 'needle', 'N', false, identity, 'w-ops', 'c-test');
  check('C2b-3 oldString 多处命中 → 拒绝猜测位置',
    !multi.ok && multi.diskChanged === false && multi.message.includes('命中 2 处'), multi.message.slice(0, 160));

  /* ③ 唯一命中 → 精确落盘。 */
  const one = await mod.executeFileStrReplace('a-order-service', rel, 'needle A', 'needle A!', false, identity, 'w-ops', 'c-test');
  check('C2b-4 唯一命中 → 替换成功并带回滚引用',
    one.ok && one.diskChanged && typeof one.rollbackRef === 'string', one.message.slice(0, 140));
  check('C2b-5 只有目标那一处被改',
    (await contentOf()) === original.replace('needle A', 'needle A!'));

  /* ④ replaceAll → 全部替换。 */
  const all = await mod.executeFileStrReplace('a-order-service', rel, 'line', 'LINE', true, identity, 'w-ops', 'c-test');
  check('C2b-6 replaceAll 生效（三处 line 全替换）',
    all.ok && (await contentOf()) === original.replace('needle A', 'needle A!').replace(/line/g, 'LINE'),
    all.message.slice(0, 140));

  /* ⑤ 回滚链：回滚最后一次替换，内容应回到上一步。 */
  const rolledBack = await mod.rollbackWritePlan(all.rollbackRef, identity, 'w-ops');
  check('C2b-7 回滚恢复替换前内容', rolledBack.ok && (await contentOf()) === original.replace('needle A', 'needle A!'),
    rolledBack.message.slice(0, 140));

  /* ⑥ newString 里的 $ 不能被当成替换模式（split/join 的实现细节，回归防线）。 */
  const dollar = await mod.executeFileStrReplace('a-order-service', rel, 'alpha', '$& $1 $$', false, identity, 'w-ops', 'c-test');
  check('C2b-8 newString 含 $& 时按字面写入（不当替换模式解释）',
    dollar.ok && (await contentOf()).startsWith('$& $1 $$ line'), dollar.message.slice(0, 140));

  /* ⑦ 不存在的文件 → 指向正确工具，不静默创建。 */
  const absent = await mod.executeFileStrReplace('a-order-service', 'v9-test/not-exist.md', 'a', 'b', false, identity, 'w-ops', 'c-test');
  check('C2b-9 目标文件不存在 → 中止并提示改用 fs_write_file',
    !absent.ok && absent.message.includes('fs_write_file'), absent.message.slice(0, 140));

  /* ⑧ 落盘证据：结果自带改动片段。
   * 「已精确替换第 N 行起的 1 处」说的是动了几处，不是改完长什么样；
   * 没有片段的话，「改了什么」只能由模型凭记忆复述——而记忆最容易编。 */
  const evidence = await mod.executeFileStrReplace('a-order-service', rel, 'beta', 'BETA', false, identity, 'w-ops', 'c-test');
  check('C2b-10 写入结果自带改动片段（@@ 区间 + 旧行 + 新行 + 上下文）',
    evidence.ok
    && evidence.message.includes('改动片段 @@')
    && evidence.message.includes('-beta line')
    && evidence.message.includes('+BETA line')
    && evidence.message.includes('needle A!'),
    evidence.message.slice(0, 260));

  /* ⑨ 空操作要明说：替换成同样内容时"已精确替换"读起来像改动生效了。 */
  const noop = await mod.executeFileStrReplace('a-order-service', rel, 'BETA', 'BETA', false, identity, 'w-ops', 'c-test');
  check('C2b-11 oldString 与 newString 相同时明说"空操作"',
    noop.ok && noop.message.includes('空操作'), noop.message.slice(0, 160));

  /* ⑩ 改动过大：不给片段（半个片段会被当成全部改动），改给区间与读法。 */
  const bigBody = Array.from({ length: 60 }, (_, i) => `big-${i + 1}`).join('\n');
  const big = await mod.executeFileStrReplace('a-order-service', rel, 'BETA', bigBody, false, identity, 'w-ops', 'c-test');
  check('C2b-12 改动超过片段上限时不给片段，改给行区间与 code_view 指引',
    big.ok && !big.message.includes('改动片段') && big.message.includes('code_view') && big.message.includes('超过片段上限'),
    big.message.slice(0, 220));

  /* ⑪ 新建文件没有基线：说"快照保留、可通过回滚端点恢复"是假话。 */
  const fresh = await mod.executeFileWrite('a-order-service', 'v9-test/fresh-evidence.md', 'x\ny\n', identity, 'w-ops', 'c-test');
  check('C2b-13 新建文件不说"可通过回滚端点恢复"',
    fresh.ok && fresh.message.includes('新建') && !fresh.message.includes('可通过回滚端点恢复'),
    fresh.message.slice(0, 200));
}

/* ================= C2c. 改动片段的边界（纯函数 diffRegion） ================= */
console.log('\n--- C2c. 改动片段边界 ---');
{
  const one = mod.diffRegion('a\nb\nc\n', 'a\nB\nc\n');
  check('C2c-1 单行改动：行区间与增删计数都准确（不把上下文算成改动）',
    one.oldRange[0] === 2 && one.oldRange[1] === 2 && one.added === 1 && one.removed === 1
    && one.block.includes('-b') && one.block.includes('+B'),
    JSON.stringify({ range: one.oldRange, added: one.added, removed: one.removed }));

  const append = mod.diffRegion('a\nb\n', 'a\nb\nc\n');
  check('C2c-2 纯追加：旧侧 0 行（区间退化为空），不算成"替换了 1 行"',
    append.removed === 0 && append.added === 1
    && append.oldRange[0] === 3 && append.oldRange[1] === 2,
    JSON.stringify({ oldRange: append.oldRange, added: append.added }));

  const same = mod.diffRegion('same\ncontent', 'same\ncontent');
  check('C2c-3 内容不变 → unchanged 且不给片段（不编造一段"改动"）',
    same.unchanged && same.block === '' && same.added === 0 && same.removed === 0);

  const first = mod.diffRegion('a\nb', 'A\nb');
  check('C2c-4 首行改动不被当成整文件重写（后缀裁剪生效）',
    first.removed === 1 && first.added === 1 && first.oldRange[0] === 1 && first.block.includes(' b'),
    first.block);

  const huge = mod.diffRegion('x\ny', ['x', ...Array.from({ length: 50 }, (_, i) => `n${i}`), 'y'].join('\n'));
  check('C2c-5 改动超过上限 → clipped、不给片段、hint 指明下一步怎么读',
    huge.clipped && huge.block === '' && huge.hint.includes('code_view') && huge.added === 50,
    huge.hint.slice(0, 160));

  const longLine = mod.diffRegion('short', `s${'x'.repeat(500)}`, { maxLineChars: 100 });
  check('C2c-6 超长单行被截断，并注明原始长度（不静默砍掉）',
    longLine.block.includes('…（该行共 501 字符）') && longLine.block.length < 400,
    longLine.block.slice(0, 140));

  /* 片段会以 markdown 正文进入对话：`-old` 在 markdown 里是列表项，不加围栏会被渲染成一坨。 */
  check('C2c-7 片段自带代码围栏（- / + 行不会被 markdown 当成列表与段落）',
    one.block.includes('```diff') && one.block.trimEnd().endsWith('```'),
    one.block.split('\n').slice(0, 2).join(' / '));

  /* 改的正好是 markdown 文件时，正文里自带三连反引号，写死 ``` 会被提前闭合。 */
  const mdEdit = mod.diffRegion('```\nold\n```', '```\nnew\n```');
  check('C2c-8 正文含三连反引号时围栏自动加长（不写死三个）',
    mdEdit.block.split('\n')[1] === '````diff' && mdEdit.block.trimEnd().endsWith('````'),
    mdEdit.block.slice(0, 40));
}

/* ================= C3. 数据库写 + 回滚 ================= */
console.log('\n--- C3. 数据库写三层防线 ---');
{
  const ddl = await mod.executeDbWrite('DROP TABLE inventory', identity, 'w-ops');
  check('C3-1 DDL 一律拒绝（写通道仅限 DML）', !ddl.ok && ddl.message.includes('DDL') && !ddl.diskChanged, ddl.message.slice(0, 100));

  const multi = await mod.executeDbWrite("UPDATE inventory SET stock=1 WHERE sku='SKU-1001'; DELETE FROM inventory;", identity, 'w-ops');
  check('C3-2 多语句拒绝（单条 DML）', !multi.ok && !multi.diskChanged);

  const readBefore = await mod.runSqlQuery("SELECT stock FROM inventory WHERE sku='SKU-1001'", {}, identity, 'a-order-db-dev');
  const originalStock = Number(readBefore.rows[0]?.[0]);

  const write = await mod.executeDbWrite("UPDATE inventory SET stock = 999 WHERE sku = 'SKU-1001'", identity, 'w-ops');
  check('C3-3 DML 事务执行成功（影响 1 行 + 备份就绪）',
    write.ok && write.affectedRows === 1 && typeof write.rollbackRef === 'string', write.message.slice(0, 150));

  const after = await mod.runSqlQuery("SELECT stock FROM inventory WHERE sku='SKU-1001'", {}, identity, 'a-order-db-dev');
  check('C3-4 写后真实可见（999）', Number(after.rows[0]?.[0]) === 999, String(after.rows[0]?.[0]));

  const rolled = await mod.rollbackWritePlan(write.rollbackRef, identity, 'w-ops');
  const restored = await mod.runSqlQuery("SELECT stock FROM inventory WHERE sku='SKU-1001'", {}, identity, 'a-order-db-dev');
  check('C3-5 回滚恢复原值', rolled.ok && Number(restored.rows[0]?.[0]) === originalStock,
    `restored=${restored.rows[0]?.[0]}, expect=${originalStock}`);
}

/* ================= C4. 会话级审批记忆 + 连拒熔断 ================= */
console.log('\n--- C4. 审批记忆与熔断 ---');
{
  const key = mod.approvalKeyOf('patch.apply', 'code-file', 'high');
  mod.grantSessionApproval('c-mem-test', key);
  check('C4-1 会话记忆命中（同 intent+targetType+risk）', mod.hasSessionApproval('c-mem-test', key));
  check('C4-2 记忆不跨会话', !mod.hasSessionApproval('c-other', key));
  mod.clearSessionApprovals('c-mem-test');
  check('C4-3 清除后失效', !mod.hasSessionApproval('c-mem-test', key));

  for (let index = 0; index < 3; index += 1) mod.recordWriteDeny('c-break');
  check('C4-4 连续 3 次拒绝触发熔断', mod.breakerTripped('c-break'));
  check('C4-5 熔断阈值 = 3', mod.DENY_BREAKER_THRESHOLD === 3);
  mod.recordWriteSuccess('c-break');
  check('C4-6 成功执行后熔断解除', !mod.breakerTripped('c-break'));
}

/* ================= D. HTTP 集成（独立端口 3012） ================= */
console.log('\n--- D. HTTP 集成 ---');
{
  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'backend', 'src', 'index.ts')],
    {
      cwd: ROOT,
      env: { ...process.env, DEVWORK_PORT: String(PORT), DEVWORK_DATA_DIR: DATA_DIR, DEVWORK_SANDBOX_DIR: SANDBOX_DIR },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
  server.stderr.on('data', (chunk) => { serverLog += String(chunk); });

  /* 纯本地工具无账号体系：直接裸 fetch，不需要身份头。 */
  const call = async (method, url, bodyObj) => {
    const response = await fetch(`${BASE}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(30000),
    });
    let data = null;
    try { data = (await response.json())?.data ?? null; } catch { /* 非 JSON */ }
    return { status: response.status, data };
  };

  try {
    let healthy = false;
    for (let i = 0; i < 50; i += 1) {
      try {
        const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) { healthy = true; break; }
      } catch { await new Promise((resolve) => setTimeout(resolve, 400)); }
    }
    check('D0 服务在 20s 内就绪', healthy);
    if (!healthy) {
      process.stderr.write(serverLog.slice(-3000));
    } else {
      const tools = await call('GET', '/api/tools?workspaceId=w-ops');
      const toolData = tools.data ?? {};
      check('D1 GET /api/tools 返回派生工具面（active 含只读全组 + V2 写工具）',
        Array.isArray(toolData.active)
        && ['code_find', 'db_query', 'log_query', 'api_spec_read', 'code_edit', 'db_query_write'].every((name) =>
          toolData.active.some((t) => t.name === name)),
        (toolData.active ?? []).map((t) => t.name).join(','));
      check('D2 srv_exec 在诊断列表中标注 prod-env 剪枝',
        (toolData.all ?? []).some((t) => t.name === 'srv_exec' && t.gatedBy === 'prod-env'));

      const skills = await call('GET', '/api/skills?workspaceId=w-ops');
      /* 技能清单 = 内置（14）+ 文件驱动（skills/<id>/SKILL.md，数量随仓库变化）。
       * 所以这里断言的是「不少于 14、且内置项一个不少、且全部可用」——
       * 拿总数硬编码会让每加一个 SKILL.md 都要回来改测试，那是反模式。 */
      const BUILTIN_IDS = ['bug-locator', 'cmd-advisor', 'log-investigator', 'sql-analyst', 'doc-generator',
        'code-reviewer', 'release-check', 'api-explorer', 'perf-triage', 'slow-query',
        'gmv-attribution', 'code-review', 'incident-review', 'kb-digest'];
      const skillIds = (skills.data ?? []).map((s) => s.id);
      check('D3 GET /api/skills 返回内置技能 + 文件技能且全部可用（w-ops 资产类型齐全）',
        Array.isArray(skills.data)
        && skills.data.length >= BUILTIN_IDS.length
        && BUILTIN_IDS.every((id) => skillIds.includes(id))
        && skills.data.every((s) => s.availability?.available === true),
        `count=${skills.data?.length}, unavailable=${(skills.data ?? []).filter((s) => !s.availability?.available).map((s) => s.id).join(',')}`);
      check('D3b 文件技能带来源标注与正文长度（前端菜单要能区分内置/扩展）',
        (skills.data ?? []).filter((s) => s.source === 'file').length > 0
        && (skills.data ?? []).filter((s) => s.source === 'file').every((s) => Number(s.methodologyChars) > 40),
        (skills.data ?? []).map((s) => `${s.id}:${s.source}`).join(','));

      const templates = await call('GET', '/api/cmd-templates');
      check('D4 GET /api/cmd-templates 返回 3 个模板', Array.isArray(templates.data) && templates.data.length === 3);

      /* 审批闭环：Mock 轨迹的高风险写 → 审批卡（含 plan）→ 批准（scope=session）→ 记忆登记。 */
      const conv = await call('POST', '/api/conversations', { workspaceId: 'w-ops', title: 'QA-工具派生' });
      const convId = String(conv.data?.id ?? '');
      const said = await call('POST', `/api/conversations/${convId}/messages`, { content: '帮我清理 order-api 的错误日志', assetIds: [] });
      const appr = (said.data?.messages ?? []).find((m) => m.kind === 'approval_card');
      check('D5 高风险写生成审批卡且带可执行 plan',
        !!appr && !!appr.payload?.plan?.toolName && appr.payload?.status === '待审批',
        JSON.stringify(appr?.payload?.plan ?? {}).slice(0, 150));

      const decided = await call('POST', `/api/approvals/${encodeURIComponent(String(appr?.id ?? ''))}`, {
        conversationId: convId, decision: 'approve', scope: 'session',
      });
      check('D6 批准裁决返回（演示轨迹遗留名如实不执行）',
        decided.data?.decision === 'approve' && decided.data?.executed === false && decided.data?.diskChanged === false,
        `executed=${decided.data?.executed}`);

      const secondWrite = await call('POST', `/api/conversations/${convId}/messages`, { content: '再清理一次日志', assetIds: [] });
      const rows = (secondWrite.data?.messages ?? []).filter((m) => ['tool_row', 'approval_card', 'suggestion'].includes(m.kind));
      const memoryHit = rows.some((m) => String(m.payload?.result ?? '').includes('会话级审批记忆'));
      /* 1.0 口径（审计 A-P1-09 方案 A）：会话级免审下线 —— 上一张卡带 scope:'session'
       * 批准，也不得为后续同类写操作留免审记忆。判定反过来断言：
       * 「没有记忆命中」且「仍然产生了审批/建议卡（逐次批准）」，
       * 并且裁决返回的生效口径必须是 once。 */
      const reApproval = rows.some((m) => m.kind === 'approval_card' || m.kind === 'suggestion' || m.kind === 'tool_row');
      check('D7 会话级免审已下线：同类写操作仍逐次审批（且回报 scope=once）',
        !memoryHit && reApproval && decided.data?.scope === 'once',
        `memoryHit=${memoryHit} reApproval=${reApproval} scope=${decided.data?.scope} | `
          + rows.map((m) => `${m.kind}:${short(String(m.payload?.result ?? ''), 40)}`).join(' | '));

      await call('DELETE', `/api/conversations/${convId}`);
    }
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 3000).unref();
    }
  }
}

function short(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

console.log(`\nTotal: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
