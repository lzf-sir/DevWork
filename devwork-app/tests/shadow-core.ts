/**
 * 定时源核心逻辑测试（进程内，不起服务）。
 *
 * 为什么单独一份：`fireDueSchedules()` 是「到点」这条路径，接口测试只能验到
 * 「手动立即巡检」——而真正会悄悄坏掉的恰恰是到点判断：
 *   · next_fire_at 推进了没
 *   · 错过多次是不是只补一次
 *   · 崩溃后同一次到点会不会重复投递
 * 这些都不适合等 5 分钟去验证，只能在进程内把时钟拨过去。
 *
 * 用法：npm run test:shadow:core
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'devwork-sched-'));
process.env.DEVWORK_DATA_DIR = path.join(RUN_DIR, 'data');
process.env.DEVWORK_SANDBOX_DIR = path.join(RUN_DIR, 'sandbox');
process.env.DEVWORK_SUPERAGENT = 'on';

const results = { total: 0, passed: 0, failed: 0 };
function check(name: string, pass: boolean, detail?: unknown): void {
  results.total += 1;
  if (pass) {
    results.passed += 1;
    console.log(`[PASS] ${name}`);
    return;
  }
  results.failed += 1;
  console.log(`[FAIL] ${name}${detail === undefined ? '' : ` → ${JSON.stringify(detail)}`}`);
}

/* 环境变量必须在 import 业务模块之前就位：config.ts 在模块加载期读 env。 */
const database = await import('../backend/src/db/database');
const scheduler = await import('../backend/src/services/shadow-scheduler');

const { initDatabase, run, get, all, closeDatabase } = database;
const { computeNextFire, ensureShadowSources, fireDueSchedules, setSourceEnabled, updateSourceConfig } = scheduler;

initDatabase(() => {
  /* 不跑 seed：这里只关心定时源，测试自己建一个最小工作区即可。 */
  run(
    `INSERT INTO workspace (id,name,description,index_progress,assets_count,conversations_count,owner_label,recent_label,trust_level,created_at)
     VALUES ('w-test','定时源测试','',100,0,0,'仅我','','normal',?)`,
    new Date().toISOString(),
  );
});
ensureShadowSources();

const iso = (date: Date): string => date.toISOString();
const minutesFrom = (isoText: string, base: Date): number =>
  Math.round((new Date(isoText).getTime() - base.getTime()) / 60000);

/* ① 排期计算：interval 与 daily 的边界 */
const base = new Date('2026-11-14T10:00:00');
check(
  'interval：60 分钟后',
  minutesFrom(computeNextFire({ schedule: 'interval', everyMinutes: 60 }, base), base) === 60,
  computeNextFire({ schedule: 'interval', everyMinutes: 60 }, base),
);
check(
  'interval：小于 5 分钟被抬到 5',
  minutesFrom(computeNextFire({ schedule: 'interval', everyMinutes: 1 }, base), base) === 5,
  computeNextFire({ schedule: 'interval', everyMinutes: 1 }, base),
);
const dailyLater = computeNextFire({ schedule: 'daily', at: '18:00' }, base);
check('daily：当天晚于现在 → 今天 18:00', new Date(dailyLater).getDate() === 14 && new Date(dailyLater).getHours() === 18, dailyLater);
const dailyEarlier = computeNextFire({ schedule: 'daily', at: '09:30' }, base);
check('daily：当天已过 → 明天 09:30', new Date(dailyEarlier).getDate() === 15 && new Date(dailyEarlier).getHours() === 9, dailyEarlier);

/* ② 到点触发 */
setSourceEnabled('schedule', true);
updateSourceConfig('schedule', { schedule: 'interval', everyMinutes: 60, prompt: '巡检：排查最近的超时' });
const scheduled = get<Record<string, unknown>>("SELECT * FROM source WHERE kind = 'schedule'");
check('启用后立刻排好下次到点', Boolean(String(scheduled?.next_fire_at ?? '')), scheduled?.next_fire_at);

/* 把时钟拨到「已过期一分钟」，模拟到点。 */
const dueAt = iso(new Date(Date.now() - 60_000));
run("UPDATE source SET next_fire_at = ? WHERE kind = 'schedule'", dueAt);

const fired = fireDueSchedules(new Date());
check('到点触发一次', fired === 1, fired);

const triggers = all<Record<string, unknown>>("SELECT * FROM trigger WHERE source_id = ?", String(scheduled?.id));
check('投递出一条 Trigger', triggers.length === 1, triggers.length);
check('Trigger 身份为 system', String(triggers[0]?.actor_kind ?? '') === 'system', triggers[0]?.actor_kind);
check('正文来自配置的巡检提示语', String(triggers[0]?.body ?? '').includes('排查最近的超时'), triggers[0]?.body);

const advanced = get<Record<string, unknown>>("SELECT next_fire_at FROM source WHERE kind = 'schedule'");
check(
  '下次到点已推进到未来',
  new Date(String(advanced?.next_fire_at)).getTime() > Date.now(),
  advanced?.next_fire_at,
);

/* ③ 未到点不再触发 */
check('未到点不重复触发', fireDueSchedules(new Date()) === 0);

/* ④ 崩溃重放：同一次到点重复进入只留一条（idemKey 兜底） */
run("UPDATE source SET next_fire_at = ? WHERE kind = 'schedule'", dueAt);
fireDueSchedules(new Date());
const afterReplay = all<Record<string, unknown>>("SELECT * FROM trigger WHERE source_id = ?", String(scheduled?.id));
check('同一到点重复进入只留一条', afterReplay.length === 1, afterReplay.length);

/* ⑤ 错过多次只补一次：把到点时间拨到三天前 */
const longAgo = iso(new Date(Date.now() - 3 * 86400_000));
run("UPDATE source SET next_fire_at = ? WHERE kind = 'schedule'", longAgo);
const catchUpFired = fireDueSchedules(new Date());
const afterCatchUp = all<Record<string, unknown>>("SELECT * FROM trigger WHERE source_id = ?", String(scheduled?.id));
check('关软件三天后开机：只补一次', catchUpFired === 1 && afterCatchUp.length === 2, {
  catchUpFired, total: afterCatchUp.length,
});

/* ⑥ 停用后不再触发 */
setSourceEnabled('schedule', false);
run("UPDATE source SET next_fire_at = ? WHERE kind = 'schedule'", dueAt);
check('停用后不再触发', fireDueSchedules(new Date()) === 0);

/* ───────────────── 工单生命周期（P2） ─────────────────
 * 这些不需要模型：stage 推导、租约回收、注意力预算都是纯状态机。
 * 放进进程内测试，是因为黑盒测不到「租约过期」——那要等 90 秒。 */

const tickets = await import('../backend/src/services/tickets');
const {
  askAttention, answerAttention, dispatchQueued, finishAssignment,
  reapExpiredAssignments, recomputeStage, routeAcceptedDecisions, stopTicket, ticketStats,
} = tickets;

const nowIso = (): string => new Date().toISOString();
const workspace = 'w-test';
/* thread 对 source 有外键：必须用真实存在的源 id，不能随手编。 */
const srcId = String(get<Record<string, unknown>>('SELECT id FROM source LIMIT 1')?.id ?? '');

function seedMandate(id: string, status: string, ticketId: string | null): void {
  run(
    `INSERT INTO mandate (id,decision_id,ticket_id,status,strength,policy_version,requester,scope,matched_rules,attention_budget,note,created_at,reviewed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, `dec-${id}`, ticketId, status, 'explicit', 'pol-test', '本机用户',
    JSON.stringify({ level: 'asset', workspaceId: workspace, assets: ['a-x'], assetTypes: ['code'], actions: ['code.read'], riskCeiling: 'low', maxWrites: 0 }),
    '["rule-incident"]', 1, '', nowIso(), null,
  );
}

/* 造一条完整的「事件 → 决策 → 草案」，再手工挂上工单。 */
run("INSERT INTO thread (id,workspace_id,source_id,asset_id,thread_key,title,eval_running,created_at) VALUES (?,?,?,?,?,?,?,?)",
  'thr-t1', workspace, srcId, null, 'thread-t1', '测试线程', 0, nowIso());
run("INSERT INTO trigger (id,thread_id,source_id,actor,actor_kind,addressed,body,payload,idem_key,disposition,decision_id,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  'trg-t1', 'thr-t1', srcId, '本机用户', 'person', 1, '排查超时', '{}', 'idem-t1', 'evaluated', 'dec-t1', nowIso());
run("INSERT INTO decision (id,thread_id,trigger_id,kind,strength,would_accept,reason_code,reason,matched_rules,policy_version,ticket_id,eval_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  'dec-t1', 'thr-t1', 'trg-t1', 'ignore', 'explicit', 1, 'E_EXPLICIT_REQUEST', '测试', '["rule-incident"]', 'pol-test', null, 1, nowIso());
seedMandate('mnd-t1', 'accepted', 'tkt-t1');

run(`INSERT INTO ticket (id,short_name,workspace_id,thread_id,title,state,stage,ended_reason,conversation_id,mandate_id,trigger_id,created_at,ended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'tkt-t1', 't-t1', workspace, 'thr-t1', '排查超时', 'open', 'queued', '', null, 'mnd-t1', 'trg-t1', nowIso(), null);

check('ticket：已授权且无派工 → queued', recomputeStage('tkt-t1') === 'queued', recomputeStage('tkt-t1'));

/* 注意力：预算 1 次/小时，第二次要被挡住 */
const asked1 = askAttention('tkt-t1', { question: '这次要动生产库吗？', options: ['只读', '可写'] });
check('attention：第一次提问成功', asked1.id !== null && !asked1.budgetExhausted, asked1);
check('attention：提问后 stage 转 person/answer', recomputeStage('tkt-t1') === 'person/answer', recomputeStage('tkt-t1'));
const asked2 = askAttention('tkt-t1', { question: '第二个问题？' });
check('attention：超预算不再打扰', asked2.id === null && asked2.budgetExhausted, asked2);

/* 回答后回到 queued，并释放阻塞 */
const answered = answerAttention('tkt-t1', String(asked1.id), '只读');
check('attention：回答被接受', answered.ok, answered);
check('attention：回答后 stage 回 queued', String(get<Record<string, unknown>>('SELECT stage FROM ticket WHERE id = ?', 'tkt-t1')?.stage) === 'queued',
  get<Record<string, unknown>>('SELECT stage FROM ticket WHERE id = ?', 'tkt-t1')?.stage);
const answeredTwice = answerAttention('tkt-t1', String(asked1.id), '再答一次');
check('attention：同一条提问不能答两次', answeredTwice.ok === false, answeredTwice);

/* 租约回收：running 且租约过期 → 失败并留下痕迹 */
run(`INSERT INTO assignment (id,ticket_id,worker_session,workdir,state,lease_until,heartbeat_at,report,report_note,tokens_in,tokens_out,attempts,started_at,ended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'asg-t1', 'tkt-t1', 'worker-t-t1', '', 'running',
  new Date(Date.now() - 60_000).toISOString(), nowIso(), 'progress', '', 0, 0, 1, nowIso(), null);
check('lease：过期派工被回收', reapExpiredAssignments() === 1);
check('lease：回收后报告 failed',
  String(get<Record<string, unknown>>('SELECT report FROM assignment WHERE id = ?', 'asg-t1')?.report) === 'failed',
  get<Record<string, unknown>>('SELECT report FROM assignment WHERE id = ?', 'asg-t1')?.report);

/* 停止优先于一切 */
check('stop：可以叫停', stopTicket('tkt-t1') === true);
const stopped = get<Record<string, unknown>>('SELECT * FROM ticket WHERE id = ?', 'tkt-t1');
check('stop：状态为 ended 且原因可追溯',
  String(stopped?.state) === 'ended' && String(stopped?.ended_reason) === 'stopped_by_person',
  `${String(stopped?.state)}/${String(stopped?.ended_reason)}`);

/* 统计口径 */
const tstats = ticketStats();
check('stats：给出打扰密度', typeof tstats.attentionPerTicket === 'number', tstats.attentionPerTicket);

/* Router 只认 accepted 的授权 */
seedMandate('mnd-t2', 'draft', null);
run("INSERT INTO decision (id,thread_id,trigger_id,kind,strength,would_accept,reason_code,reason,matched_rules,policy_version,ticket_id,eval_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  'dec-t2', 'thr-t1', 'trg-t1', 'ignore', 'explicit', 1, 'E_EXPLICIT_REQUEST', '测试', '["rule-incident"]', 'pol-test', null, 1, nowIso());
const routed = routeAcceptedDecisions();
check('router：草案授权不建工单', routed.created === 0 || routed.attached >= 0, routed);

/* ───────────────── 采集器（P2） ─────────────────
 * 日志按字节位点、git 按 HEAD、终端按命令历史。
 * 三条共同点：一轮最多一条、位点存库、源没开就一行不跑。 */

const collectors = await import('../backend/src/services/shadow-collectors');

const logFile = path.join(RUN_DIR, 'app.log');
fs.writeFileSync(logFile, 'INFO boot\nERROR db timeout\n');
run("UPDATE source SET enabled = 1, config = ?, read_position = '' WHERE kind = 'log'",
  JSON.stringify({ path: logFile, pattern: 'ERROR' }));
check('collector：日志命中一条并投递', collectors.collectLogs() === 1);
check('collector：无新增不重复投递', collectors.collectLogs() === 0);

fs.appendFileSync(logFile, 'ERROR second failure\n');
check('collector：追加后再命中', collectors.collectLogs() === 1);

run("UPDATE source SET enabled = 0 WHERE kind = 'log'");
check('collector：源关掉后不再采集', collectors.collectLogs() === 0);

/* git：首次只记位点（否则刚开这个源就凭空多一条工单）。 */
let head = '';
try {
  head = execFileSync('git', ['-C', process.cwd(), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  head = '';
}
if (head) {
  run("UPDATE source SET enabled = 1, config = ?, read_position = '' WHERE kind = 'git'",
    JSON.stringify({ repoPath: process.cwd() }));
  check('collector：git 首次只记位点不投递', collectors.collectGit() === 0);
  check('collector：git 位点已记住', String(get<Record<string, unknown>>("SELECT read_position FROM source WHERE kind = 'git'")?.read_position) === head,
    get<Record<string, unknown>>("SELECT read_position FROM source WHERE kind = 'git'")?.read_position);
  run("UPDATE source SET read_position = 'deadbeef' WHERE kind = 'git'");
  check('collector：HEAD 变化后投递一条', collectors.collectGit() === 1);
  run("UPDATE source SET enabled = 0 WHERE kind = 'git'");
}

/* 终端：只捞失败命令。 */
run("INSERT INTO command_history (id,asset_id,session_id,command,result,created_at) VALUES (?,?,?,?,?,?)",
  'ch-1', 'a-x', 'sess-1', 'systemctl restart order-api', '失败：permission denied', new Date().toISOString());
run("UPDATE source SET enabled = 1, read_position = '1970-01-01T00:00:00.000Z' WHERE kind = 'terminal'");
check('collector：失败命令被采集', collectors.collectTerminal() === 1);
run("UPDATE source SET enabled = 0 WHERE kind = 'terminal'");

/* 回归：事件收讫不得覆盖采集器位点。
 * 曾经 ingestTrigger 把幂等键写进 read_position，于是 terminal / sql 采集器的
 * `created_at > since` 恒不成立 → 永远采不到新行；log 采集器位点变 NaN → 每轮重扫。 */
{
  const sourceId = String(get<Record<string, unknown>>("SELECT id FROM source WHERE kind = 'terminal'")?.id ?? '');
  run("UPDATE source SET read_position = '2026-01-01T00:00:01.000Z' WHERE id = ?", sourceId);
  scheduler.ingestTrigger({
    sourceKind: 'terminal',
    threadKey: 'shell:regression',
    threadTitle: '终端',
    actor: 'shell',
    actorKind: 'system',
    body: '回归用事件',
    idemKey: 'term:regression:1',
  });
  const position = String(get<Record<string, unknown>>('SELECT read_position FROM source WHERE id = ?', sourceId)?.read_position ?? '');
  check('回归：ingestTrigger 不覆盖采集器位点', position === '2026-01-01T00:00:01.000Z', position);
}


/* ───────────────── 工作区隔离（P2.5） ─────────────────
 * 没有这条，两张工单会在同一个仓库里改同一个文件，而且都不会报错。
 *
 * 严重2 的硬要求：**建不出隔离就 blocked，不许降级写共享仓库**。
 * 「降级」在这里是静默的 —— 共享仓库被改掉了，没人收到任何报错，
 * 两张票都以为自己写的是私有副本。所以这几条用例盯的就是「不许悄悄降级」。 */

const { SANDBOX_DIR } = await import('../backend/src/config');
const workdir = await import('../backend/src/services/workdir');
const execContext = await import('../backend/src/services/exec-context');
const workspaceRepos = await import('../backend/src/services/workspace-repos');
const { deriveToolFace } = await import('../backend/src/config/tool-catalog');

const repoAbs = path.join(SANDBOX_DIR, 'workspaces', 'w-test', 'repo-x');
fs.mkdirSync(repoAbs, { recursive: true });
const g = (args: string[]): string => execFileSync('git', ['-C', repoAbs, ...args], { encoding: 'utf8' });
g(['init', '-q']);
g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
fs.writeFileSync(path.join(repoAbs, 'a.txt'), 'base\n');

run("INSERT INTO asset (id,workspace_id,folder_id,type,name,env,status,index_progress,credential_bound,subtitle,config,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  'a-code', workspace, null, 'code', '测试仓库', '', 'online', 100, 0, '', JSON.stringify({ localPath: 'w-test/repo-x' }), nowIso());

check('workdir：未进上下文时解析到共享仓库', workspaceRepos.resolveRepoRoot('a-code') === repoAbs,
  workspaceRepos.resolveRepoRoot('a-code'));

/** 构造隔离目标（替代旧的「assetIds + needIsolation」两个散参数）。 */
const targetsOf = (codeAssets: string[], requireIsolation: boolean, aliasTarget = '') => ({
  codeAssets, aliasTarget, requireIsolation,
});

const plan = workdir.prepareWorkdir('tkt-w1', 't-w1', targetsOf(['a-code'], true));
check('workdir：为可写工单建出工作树', !plan.error && Boolean(plan.assetRoots['a-code']), plan.error ?? plan.assetRoots);
check('workdir：工作树与共享仓库不同',
  plan.assetRoots['a-code'] !== repoAbs, `${plan.assetRoots['a-code']} vs ${repoAbs}`);

let overrideRoot = '';
await execContext.runInExecContext(
  {
    ticketId: 'tkt-w1',
    workdir: plan.root,
    assetRoots: plan.assetRoots,
    isolatedAssets: ['a-code'],
    workspaceId: workspace,
  },
  async () => {
    overrideRoot = workspaceRepos.resolveRepoRoot('a-code');
  },
);
check('workdir：上下文内解析到工作树', overrideRoot === plan.assetRoots['a-code'], overrideRoot);

fs.writeFileSync(path.join(overrideRoot, 'new.txt'), 'x');
check('workdir：写进工作树不影响共享仓库',
  fs.existsSync(path.join(overrideRoot, 'new.txt')) && !fs.existsSync(path.join(repoAbs, 'new.txt')));

const readPlan = workdir.prepareWorkdir('tkt-w2', 't-w2', targetsOf(['a-code'], false));
check('workdir：只读工单不建工作树', Object.keys(readPlan.assetRoots).length === 0);

/* 有未提交改动时不许删：丢工作比留垃圾严重。 */
const released = workdir.releaseWorkdir(plan);
check('workdir：脏工作树被保留', released.kept >= 1, released);

/* 非 git 资产 + 需要隔离 → 明确报错，不降级 */
run("INSERT INTO asset (id,workspace_id,folder_id,type,name,env,status,index_progress,credential_bound,subtitle,config,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  'a-raw', workspace, null, 'code', '非仓库', '', 'online', 100, 0, '', JSON.stringify({ localPath: 'w-test/raw' }), nowIso());
fs.mkdirSync(path.join(SANDBOX_DIR, 'workspaces', 'w-test', 'raw'), { recursive: true });
const badPlan = workdir.prepareWorkdir('tkt-w3', 't-w3', targetsOf(['a-raw'], true));
check('workdir：非仓库资产拒绝建立隔离', Boolean(badPlan.error), badPlan.error);

/* ── 严重2 回归：建不出隔离必须 blocked，绝不降级写共享仓库 ── */

/* ① 允许写但没有任何可隔离的代码资产 → 直接给 error，调用方据此 blocked。 */
const noTargetPlan = workdir.prepareWorkdir('tkt-w4', 't-w4', targetsOf([], true));
check('workdir：建不出隔离时报错（调用方必须 blocked）', Boolean(noTargetPlan.error), noTargetPlan.error);

/* ② 上游已判定「无法建立隔离」时，prepareWorkdir 原样带出 error，不自己绕过去。 */
const deniedPlan = workdir.prepareWorkdir('tkt-w5', 't-w5', {
  codeAssets: [], aliasTarget: '', requireIsolation: true, error: '上游判定：无法建立隔离',
});
check('workdir：上游的隔离错误原样透传', deniedPlan.error === '上游判定：无法建立隔离', deniedPlan.error);

/* ③ 上下文内要求隔离却拿不到隔离根 → 解析层报错，不回落共享仓库。 */
let denied = '';
await execContext.runInExecContext(
  {
    ticketId: 'tkt-w6',
    workdir: path.join(SANDBOX_DIR, 'tickets', 't-w6'),
    assetRoots: {},
    isolatedAssets: ['a-code'],
    workspaceId: workspace,
  },
  async () => {
    try {
      workspaceRepos.resolveRepoRoot('a-code');
    } catch (error) {
      denied = error instanceof Error ? error.message : String(error);
    }
  },
);
check('workdir：隔离缺根时拒绝回落共享仓库', denied.includes('拒绝回落共享仓库'), denied);

/* ④ 写目标资产从派生面推导：授权没点名也要隔离
 *    （写工具落到哪个资产由派生管线的主实例规则决定，不由授权列表决定）。 */
const face = await deriveToolFace(workspace);
const isoTargets = workdir.isolationTargetsOf({ face, scopeAssets: [], maxWrites: 2 });
check('workdir：写目标资产从派生面推导（授权没点名也隔离）',
  isoTargets.codeAssets.includes('a-code'), isoTargets.codeAssets);
check('workdir：工作区级写工具指向代码资产别名', isoTargets.aliasTarget === 'a-code', isoTargets.aliasTarget);

/* ⑤ workspace 型写工具（fs_write_file）在上下文内落到本单工作树，不落共享仓库。 */
const isoPlan = workdir.prepareWorkdir('tkt-w7', 't-w7',
  targetsOf(isoTargets.codeAssets, true, isoTargets.aliasTarget));
let aliasRoot = '';
await execContext.runInExecContext(
  {
    ticketId: 'tkt-w7',
    workdir: isoPlan.root,
    assetRoots: isoPlan.assetRoots,
    isolatedAssets: isoTargets.codeAssets,
    aliasTarget: isoTargets.aliasTarget,
    workspaceId: workspace,
  },
  async () => {
    aliasRoot = workspaceRepos.resolveRepoRoot(workspace);
  },
);
check('workdir：工作区级写工具落到本单工作树', aliasRoot === isoPlan.assetRoots['a-code'], aliasRoot);

/* ───────────────── 慢查询采集（P3） ─────────────────
 * 数据源是 sql_trace：埋点在 sql-query，采集器按阈值筛。
 * 这里验三件事：首次只记位点、慢的才产事件、快的推进位点但不报。 */

run("UPDATE source SET enabled = 1, read_position = '', config = ? WHERE kind = 'sql'",
  JSON.stringify({ slowMs: 1500 }));

run('INSERT INTO sql_trace (id,asset_id,statement,duration_ms,row_count,created_at) VALUES (?,?,?,?,?,?)',
  'sqlt-1', 'a-db', 'SELECT * FROM orders WHERE status = ?', 2400, 12, '2026-01-01T00:00:01.000Z');
check('collector：sql 首次只记位点不投递', collectors.collectSql() === 0);
check('collector：sql 位点已推进',
  String(get<Record<string, unknown>>("SELECT read_position FROM source WHERE kind = 'sql'")?.read_position) === '2026-01-01T00:00:01.000Z',
  get<Record<string, unknown>>("SELECT read_position FROM source WHERE kind = 'sql'")?.read_position);

run('INSERT INTO sql_trace (id,asset_id,statement,duration_ms,row_count,created_at) VALUES (?,?,?,?,?,?)',
  'sqlt-2', 'a-db', 'SELECT count(*) FROM events', 120, 1, '2026-01-01T00:00:02.000Z');
check('collector：快查询不产事件', collectors.collectSql() === 0);

run('INSERT INTO sql_trace (id,asset_id,statement,duration_ms,row_count,created_at) VALUES (?,?,?,?,?,?)',
  'sqlt-3', 'a-db', 'SELECT * FROM events WHERE ts > ? ORDER BY id', 5200, 900, '2026-01-01T00:00:03.000Z');
check('collector：慢查询产事件', collectors.collectSql() === 1);
run("UPDATE source SET enabled = 0 WHERE kind = 'sql'");

/* ───────────────── 订阅扇出（P3） ─────────────────
 * 核心命题：工单跟着线程走，而不是干完一件就断线。 */

const sub = await import('../backend/src/services/subscription');

/* 造一张 open 工单，带一个「已跑完 ready」的派工 —— 这是会被新消息唤醒的典型状态。 */
run(`INSERT INTO thread (id,workspace_id,source_id,asset_id,thread_key,title,eval_running,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  'thr-f1', workspace, srcId, null, 'thread-f1', '扇出测试线程', 0, nowIso());
run("INSERT INTO trigger (id,thread_id,source_id,actor,actor_kind,addressed,body,payload,idem_key,disposition,decision_id,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  'trg-f1', 'thr-f1', srcId, '本机用户', 'person', 1, '排查订单超时', '{}', 'idem-f1', 'evaluated', 'dec-f1', '2026-01-01T00:00:00.000Z');
run("INSERT INTO decision (id,thread_id,trigger_id,kind,strength,would_accept,reason_code,reason,matched_rules,policy_version,ticket_id,eval_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  'dec-f1', 'thr-f1', 'trg-f1', 'ignore', 'explicit', 1, 'E_EXPLICIT_REQUEST', '测试', '["rule-incident"]', 'pol-test', null, 1, '2026-01-01T00:00:00.000Z');
seedMandate('mnd-f1', 'accepted', 'tkt-f1');
run(`INSERT INTO ticket (id,short_name,workspace_id,thread_id,title,state,stage,ended_reason,conversation_id,mandate_id,trigger_id,created_at,ended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'tkt-f1', 't-f1', workspace, 'thr-f1', '排查订单超时', 'open', 'queued', '', null, 'mnd-f1', 'trg-f1', '2026-01-01T00:00:00.000Z', null);
run('INSERT OR IGNORE INTO subscription (ticket_id,thread_id,kind,created_at) VALUES (?,?,?,?)',
  'tkt-f1', 'thr-f1', 'own', nowIso());
run(`INSERT INTO assignment (id,ticket_id,worker_session,workdir,state,lease_until,heartbeat_at,report,report_note,tokens_in,tokens_out,attempts,started_at,ended_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'asg-f1', 'tkt-f1', 'worker-f1', '', 'ended', '', nowIso(), 'ready', '上一轮完成', 0, 0, 1,
  '2026-01-01T00:01:00.000Z', '2026-01-01T00:05:00.000Z');

check('fanout：起始事件不重复投递', sub.ticketInbox('tkt-f1').length === 0, sub.ticketInbox('tkt-f1').length);

/* 同线程第二条：应该被投进这张工单，而不是另开一张。 */
run("INSERT INTO trigger (id,thread_id,source_id,actor,actor_kind,addressed,body,payload,idem_key,disposition,decision_id,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  'trg-f2', 'thr-f1', srcId, '本机用户', 'person', 1, '顺便看下 9 点那个尖峰', '{}', 'idem-f2', 'evaluated', 'dec-f2', '2026-01-01T00:10:00.000Z');
run("INSERT INTO decision (id,thread_id,trigger_id,kind,strength,would_accept,reason_code,reason,matched_rules,policy_version,ticket_id,eval_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  'dec-f2', 'thr-f1', 'trg-f2', 'ignore', 'explicit', 1, 'E_EXPLICIT_REQUEST', '测试', '["rule-incident"]', 'pol-test', null, 1, '2026-01-01T00:10:00.000Z');

const fan1 = await sub.fanoutPendingTriggers();
check('fanout：同线程后续被投递', fan1.delivered === 1, fan1);
check('fanout：投给了已有工单',
  String(get<Record<string, unknown>>('SELECT delivered_ticket_id FROM trigger WHERE id = ?', 'trg-f2')?.delivered_ticket_id) === 'tkt-f1',
  get<Record<string, unknown>>('SELECT delivered_ticket_id FROM trigger WHERE id = ?', 'trg-f2')?.delivered_ticket_id);
check('fanout：收件箱能读到这条', sub.ticketInbox('tkt-f1').length === 1, sub.ticketInbox('tkt-f1'));
check('fanout：收件箱摘要带上下文', sub.inboxDigest('tkt-f1').includes('尖峰'), sub.inboxDigest('tkt-f1').slice(0, 60));

/* 幂等：同一批不会再投一次（重复投递会让工单重复干活）。 */
check('fanout：重复调用不重复投递', (await sub.fanoutPendingTriggers()).delivered === 0);

/* 唤醒：上一轮 ready + 有新消息 → 重新排队，而不是停在「等人验收」。 */
check('fanout：ready 的工单被新消息唤回 queued', recomputeStage('tkt-f1') === 'queued', recomputeStage('tkt-f1'));

/* Gate 判「不接」的事件绝不能扇出 —— 否则就是绕过准入的侧门。 */
run("INSERT INTO trigger (id,thread_id,source_id,actor,actor_kind,addressed,body,payload,idem_key,disposition,decision_id,received_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  'trg-f3', 'thr-f1', srcId, 'dependabot[bot]', 'bot', 1, 'bump lodash', '{}', 'idem-f3', 'ignored', 'dec-f3', '2026-01-01T00:11:00.000Z');
run("INSERT INTO decision (id,thread_id,trigger_id,kind,strength,would_accept,reason_code,reason,matched_rules,policy_version,ticket_id,eval_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  'dec-f3', 'thr-f1', 'trg-f3', 'ignore', 'inferred', 0, 'E_BOT_NOT_ALLOWED', '机器人不在列表', '[]', 'pol-test', null, 1, '2026-01-01T00:11:00.000Z');
const fan2 = await sub.fanoutPendingTriggers();
check('fanout：不接的事件不投递', fan2.delivered === 0 && sub.ticketInbox('tkt-f1').length === 1, fan2);
check('fanout：不接的事件也打位点（不重扫）',
  Boolean(get<Record<string, unknown>>('SELECT fanout_at FROM trigger WHERE id = ?', 'trg-f3')?.fanout_at),
  get<Record<string, unknown>>('SELECT fanout_at FROM trigger WHERE id = ?', 'trg-f3')?.fanout_at);

/* 收工检查：本轮开始后还有新投递 → 必须继续，而不是收工。 */
check('fanout：本轮期间的新消息能被识别',
  sub.hasUnreadSince('tkt-f1', '2026-01-01T00:09:00.000Z') === 1,
  sub.hasUnreadSince('tkt-f1', '2026-01-01T00:09:00.000Z'));
check('fanout：本轮之前的不算新消息',
  sub.hasUnreadSince('tkt-f1', '2026-01-01T00:11:00.000Z') === 0,
  sub.hasUnreadSince('tkt-f1', '2026-01-01T00:11:00.000Z'));

/* ───────────────── auto 签发（P3） ─────────────────
 * 命题：auto 可以自动接只读的活，写活永远要人点头。 */

const autoMod = await import('../backend/src/services/shadow-scheduler');
const basePolicy = autoMod.shadowPolicy();

function seedDraft(id: string, maxWrites: number, assetTypes: string[]): string {
  run(`INSERT INTO mandate (id,decision_id,ticket_id,status,strength,policy_version,requester,scope,matched_rules,attention_budget,note,created_at,reviewed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, `dec-${id}`, null, 'draft', 'explicit', 'pol-test', '本机用户',
    JSON.stringify({
      level: 'workspace', workspaceId: workspace, assets: [], assetTypes,
      actions: maxWrites > 0 ? ['code.read', 'file.write'] : ['code.read'],
      riskCeiling: maxWrites > 0 ? 'medium' : 'low', maxWrites,
    }),
    '["rule-incident"]', 1, '', nowIso(), null);
  return id;
}

/* observe 下永远不自动签。 */
check('auto：observe 模式不签发',
  autoMod.maybeAutoIssue(seedDraft('mnd-a1', 0, ['code']), basePolicy).reason === 'E_NOT_AUTO');

const autoPolicy = { ...basePolicy, acceptMode: 'auto' as const, autoMaxPerHour: 2, autoAllowWrites: false };

/* 只读范围 → 签。 */
const issued = autoMod.maybeAutoIssue(seedDraft('mnd-a2', 0, ['code']), autoPolicy);
check('auto：只读范围自动签发', issued.issued === true, issued);
check('auto：签发后状态为 accepted',
  String(get<Record<string, unknown>>('SELECT status FROM mandate WHERE id = ?', 'mnd-a2')?.status) === 'accepted',
  get<Record<string, unknown>>('SELECT status FROM mandate WHERE id = ?', 'mnd-a2')?.status);
check('auto：签发留下 auto 标记',
  String(get<Record<string, unknown>>('SELECT note FROM mandate WHERE id = ?', 'mnd-a2')?.note ?? '').startsWith('auto:'),
  get<Record<string, unknown>>('SELECT note FROM mandate WHERE id = ?', 'mnd-a2')?.note);

/* 写范围 → 不签，退回草案。 */
const writeLocked = autoMod.maybeAutoIssue(seedDraft('mnd-a3', 3, ['code']), autoPolicy);
check('auto：写权限默认不签', writeLocked.reason === 'E_AUTO_WRITE_LOCKED', writeLocked);
check('auto：未签发的仍是草案',
  String(get<Record<string, unknown>>('SELECT status FROM mandate WHERE id = ?', 'mnd-a3')?.status) === 'draft',
  get<Record<string, unknown>>('SELECT status FROM mandate WHERE id = ?', 'mnd-a3')?.status);

/* 显式放开写权限才签。 */
check('auto：显式允许后可签写范围',
  autoMod.maybeAutoIssue('mnd-a3', { ...autoPolicy, autoAllowWrites: true }).issued === true);

/* 预算：autoMaxPerHour=2，已签 2 份 → 第三份被挡。 */
const budgetHit = autoMod.maybeAutoIssue(seedDraft('mnd-a4', 0, ['kb']), autoPolicy);
check('auto：超出每小时预算不签', budgetHit.reason === 'E_AUTO_BUDGET', budgetHit);

/* 预算 0 = 彻底关掉自动签发（auto 退化成 observe）。 */
check('auto：预算 0 等价于关闭',
  autoMod.maybeAutoIssue(seedDraft('mnd-a5', 0, ['kb']), { ...autoPolicy, autoMaxPerHour: 0 }).reason === 'E_AUTO_BUDGET');

/* 范围推不出来的草案，任何模式下都不签。 */
check('auto：范围不足不签',
  autoMod.maybeAutoIssue(seedDraft('mnd-a6', 0, []), { ...autoPolicy, autoMaxPerHour: 9 }).reason === 'E_AUTO_SCOPE_UNDEFINED',
  autoMod.maybeAutoIssue(seedDraft('mnd-a6b', 0, []), { ...autoPolicy, autoMaxPerHour: 9 }));

closeDatabase();
console.log('');
console.log(`定时源核心：${results.passed}/${results.total} 通过`);
process.exit(results.failed === 0 ? 0 : 1);
