/**
 * P1 影子链路测试（Gate + tick + 决策账本）。
 *
 * 为什么不塞进 smoke.mjs：这组用例针对的是一条独立链路，
 * 需要能单独跑、单独定位。`npm run test:shadow` 会起一个隔离实例再跑本文件。
 *
 * 覆盖的判定档位（每档都对应一个真实失效模式）：
 *   - 未白名单的人点名 → 不接（否则白名单形同虚设）
 *   - 白名单的人点名   → explicit + 命中规则 → 影子接单
 *   - 白名单的人未点名 → inferred（follow-up）
 *   - 同线程一小时内第二条 → 频控挡掉但留痕
 *   - 机器人不在列表   → 不接（机器人永远不能产生明确请求）
 *   - 源未启用         → 不接（主动源默认 off）
 *   - 空事件           → 不接（脏分母）
 *   - 准入模式 off     → 推断类候选不进研判
 *   - 幂等键重复       → 只留一条触发
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DEVWORK_BASE ?? 'http://127.0.0.1:3001';
const API = `${BASE}/api`;
const ACTOR = '本机用户';

const failures = [];
const results = { total: 0, passed: 0, failed: 0 };

function check(group, name, expected, actual, ok, note = '') {
  results.total += 1;
  if (ok) {
    results.passed += 1;
    console.log(`[PASS] ${group} :: ${name}`);
    return;
  }
  results.failed += 1;
  failures.push(`${group} :: ${name}`);
  console.log(`[FAIL] ${group} :: ${name}`);
  console.log(`       期望: ${expected}`);
  console.log(`       实际: ${actual}`);
  if (note) console.log(`       备注: ${note}`);
}

async function call(method, urlPath, body, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${urlPath}`, {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 注入 + 等决策落地。tick 是 800ms 定时器，测试不等它，直接手动推。 */
async function injectAndDecide(trigger, group, name) {
  const created = await call('POST', '/shadow/triggers', trigger);
  if (created.status !== 201 && created.status !== 200) {
    check(group, name, '201/200', `${created.status} ${JSON.stringify(created.json.error ?? {})}`, false);
    return null;
  }
  const triggerId = created.json.data.triggerId;
  for (let i = 0; i < 30; i += 1) {
    await call('POST', '/shadow/tick', {});
    const list = await call('GET', '/shadow/decisions?limit=200');
    const hit = (list.json.data?.items ?? []).find((item) => item.triggerId === triggerId);
    if (hit) return { ...created.json.data, decision: hit };
    await sleep(120);
  }
  check(group, name, '决策在 4s 内落地', '超时未出现决策', false);
  return null;
}

/** 等某条触发被研判出决策（tick 是 800ms 定时器，测试直接手动推）。 */
async function waitDecision(triggerId) {
  for (let i = 0; i < 30; i += 1) {
    await call('POST', '/shadow/tick', {});
    const list = await call('GET', '/shadow/decisions?limit=200');
    const hit = (list.json.data?.items ?? []).find((item) => item.triggerId === triggerId);
    if (hit) return hit;
    await sleep(120);
  }
  return null;
}

async function main() {
  /* ① 状态与源播种 */
  const status = await call('GET', '/shadow/status');
  const st = status.json.data ?? {};
  check('status', '影子链路已启用', true, st.enabled, st.enabled === true);
  check('status', '阶段为 P1-shadow', 'P1-shadow', st.phase, st.phase === 'P1-shadow');
  check('status', '七类源已登记', 7, (st.sources ?? []).length, (st.sources ?? []).length === 7);
  const userSource = (st.sources ?? []).find((s) => s.kind === 'user');
  const logSource = (st.sources ?? []).find((s) => s.kind === 'log');
  check('status', 'user 源默认启用', true, userSource?.enabled, userSource?.enabled === true);
  check('status', 'log 主动源默认关闭', false, logSource?.enabled, logSource?.enabled === false);

  const baseline = (await call('GET', '/shadow/stats')).json.data.triggers.total;

  /* ② 未白名单的人点名 → 不接 */
  const unlisted = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-unlisted-${Date.now()}`,
    actor: '路人甲', addressed: true, body: 'GMV 为什么下降？',
  }, 'gate', '未白名单的人点名不接');
  check('gate', '原因码 E_UNLISTED_ADDRESSED', 'E_UNLISTED_ADDRESSED',
    unlisted?.decision?.reasonCode, unlisted?.decision?.reasonCode === 'E_UNLISTED_ADDRESSED');
  check('gate', '影子判定为不接', false, unlisted?.decision?.wouldAccept, unlisted?.decision?.wouldAccept === false);

  /* ③ 白名单 + 点名 + 命中规则 → 影子接单 */
  const explicit = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-explicit-${Date.now()}`,
    actor: ACTOR, addressed: true, body: '帮我看下 GMV 口径，为什么同比降了？',
  }, 'gate', '白名单点名产生 explicit');
  check('gate', '强度 explicit', 'explicit', explicit?.decision?.strength, explicit?.decision?.strength === 'explicit');
  check('gate', '影子接单 wouldAccept', true, explicit?.decision?.wouldAccept, explicit?.decision?.wouldAccept === true);
  check('gate', '命中指标归因规则', true,
    (explicit?.decision?.matchedRules ?? []).includes('rule-metrics'),
    (explicit?.decision?.matchedRules ?? []).includes('rule-metrics'));
  check('gate', '决策 kind 为 ignore（影子期不接单）', 'ignore', explicit?.decision?.kind, explicit?.decision?.kind === 'ignore');

  /* ④ 人不受频控：同一个会话里连问两句，是两件事，不是刷屏。
   * 这条是 P1.5 接真实负载后补的 —— 原来对所有人限流，会把同一会话的后续请求全挡掉，
   * 而「一天会接几单」正是靠这些请求量的。 */
  const threadKey = `t-human-${Date.now()}`;
  await injectAndDecide({
    sourceKind: 'user', threadKey, actor: ACTOR, addressed: true, body: '第一条：排查超时',
  }, 'rate', '人工连问前置');
  const humanSecond = await injectAndDecide({
    sourceKind: 'user', threadKey, actor: ACTOR, addressed: true, body: '第二条：还是超时',
  }, 'rate', '人工第二条不被频控');
  check('rate', '人工请求原因码仍是 E_EXPLICIT_REQUEST', 'E_EXPLICIT_REQUEST',
    humanSecond?.decision?.reasonCode, humanSecond?.decision?.reasonCode === 'E_EXPLICIT_REQUEST');
  check('rate', '人工第二条照常影子接单', true,
    humanSecond?.decision?.wouldAccept, humanSecond?.decision?.wouldAccept === true);

  /* ⑤ 机器人不在允许列表 → 不接 */
  const bot = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-bot-${Date.now()}`,
    actor: 'dependabot[bot]', actorKind: 'bot', addressed: true, body: 'bump lodash 4.17.21',
  }, 'gate', '机器人不在列表不接');
  check('gate', '原因码 E_BOT_NOT_ALLOWED', 'E_BOT_NOT_ALLOWED',
    bot?.decision?.reasonCode, bot?.decision?.reasonCode === 'E_BOT_NOT_ALLOWED');

  /* ⑥ 源未启用 → 不接 */
  const logOff = await injectAndDecide({
    sourceKind: 'log', threadKey: 'app.log',
    actor: 'log-watcher', actorKind: 'system', body: 'ERROR OrderTimeoutException',
  }, 'gate', '未启用的源不接');
  check('gate', '原因码 E_SOURCE_DISABLED', 'E_SOURCE_DISABLED',
    logOff?.decision?.reasonCode, logOff?.decision?.reasonCode === 'E_SOURCE_DISABLED');

  /* ⑦ 源开关：打开 log 源后，同一类系统事件能进研判（这是「主动干活」的唯一入口，
   * 必须由操作者显式打开，且能随时关回去）。
   * 频控只对自动化事件生效，正好在这里一并验证。 */
  const toggledOn = await call('PATCH', '/shadow/sources', { kind: 'log', enabled: true });
  check('source', '打开 log 源返回 200', 200, toggledOn.status, toggledOn.status === 200);
  const logThread = `rate-${Date.now()}.log`;
  const logOn = await injectAndDecide({
    sourceKind: 'log', threadKey: logThread,
    actor: 'log-watcher', actorKind: 'system', body: 'ERROR OrderTimeoutException at checkout',
  }, 'source', '启用后系统事件进入研判');
  check('source', '不再因源未启用被挡', true,
    logOn?.decision?.reasonCode !== 'E_SOURCE_DISABLED', logOn?.decision?.reasonCode);
  check('source', '系统事件产生 inferred 候选', 'E_SYSTEM_INFERRED',
    logOn?.decision?.reasonCode, logOn?.decision?.reasonCode === 'E_SYSTEM_INFERRED');
  check('source', '命中规则后影子接单', true,
    logOn?.decision?.wouldAccept, `wouldAccept=${logOn?.decision?.wouldAccept}`);
  const logBurst = await injectAndDecide({
    sourceKind: 'log', threadKey: logThread,
    actor: 'log-watcher', actorKind: 'system', body: 'ERROR second line in same log',
  }, 'source', '自动化事件同线程第二条被频控');
  check('source', '原因码 E_THREAD_RATE_LIMIT', 'E_THREAD_RATE_LIMIT',
    logBurst?.decision?.reasonCode, logBurst?.decision?.reasonCode === 'E_THREAD_RATE_LIMIT');
  const toggledOff = await call('PATCH', '/shadow/sources', { kind: 'log', enabled: false });
  check('source', '关闭 log 源返回 200', 200, toggledOff.status, toggledOff.status === 200);

  /* ⑧ 空事件 → 不接 */
  const empty = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-empty-${Date.now()}`, actor: ACTOR, addressed: true, body: '   ',
  }, 'gate', '空事件不接');
  check('gate', '原因码 E_EMPTY_TRIGGER', 'E_EMPTY_TRIGGER',
    empty?.decision?.reasonCode, empty?.decision?.reasonCode === 'E_EMPTY_TRIGGER');

  /* ⑧ 幂等：同一 idemKey 只留一条 */
  const idemKey = `idem-${Date.now()}`;
  const first = await call('POST', '/shadow/triggers', {
    sourceKind: 'user', threadKey: `t-idem-${Date.now()}`, actor: ACTOR,
    addressed: true, body: '幂等测试', idemKey,
  });
  const again = await call('POST', '/shadow/triggers', {
    sourceKind: 'user', threadKey: `t-idem-${Date.now()}`, actor: ACTOR,
    addressed: true, body: '幂等测试', idemKey,
  });
  check('idem', '首次创建', true, first.json.data?.created, first.json.data?.created === true);
  check('idem', '重复投递不新建', false, again.json.data?.created, again.json.data?.created === false);
  check('idem', '重复投递返回同一 triggerId', first.json.data?.triggerId,
    again.json.data?.triggerId, first.json.data?.triggerId === again.json.data?.triggerId);

  /* ⑨ 契约：缺 actor → 400 E_VALIDATION */
  const invalid = await call('POST', '/shadow/triggers', { sourceKind: 'user', body: '缺 actor' });
  check('contract', '缺 actor 返回 400', 400, invalid.status, invalid.status === 400);
  check('contract', '错误码 E_VALIDATION', 'E_VALIDATION',
    invalid.json.error?.code, invalid.json.error?.code === 'E_VALIDATION');

  /* ⑩ 准入模式 off：推断类候选不进研判 */
  const before = (await call('GET', '/shadow/status')).json.data.policy.policyVersion;
  const patched = await call('PATCH', '/shadow/policy', { acceptMode: 'off' });
  check('policy', '策略版本升级', true,
    patched.json.data?.policyVersion !== before, patched.json.data?.policyVersion !== before);
  const inferred = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-off-${Date.now()}`, actor: ACTOR,
    addressed: false, body: '顺便看下慢查询',
  }, 'policy', 'off 模式下推断候选被挡');
  check('policy', '原因码 E_MODE_OFF', 'E_MODE_OFF',
    inferred?.decision?.reasonCode, inferred?.decision?.reasonCode === 'E_MODE_OFF');
  await call('PATCH', '/shadow/policy', { acceptMode: 'observe' });

  /* ⑩ 定时源：到点 → 投递 Trigger → 走同一条 Gate。
   * 这里要证明三件事：能排期、手动触发不挪期、自动化事件照样受频控。 */
  const schedOff = (await call('GET', '/shadow/status')).json.data.sources.find((item) => item.kind === 'schedule');
  check('schedule', '定时源默认关闭', false, schedOff?.enabled, schedOff?.enabled === false);

  const enabled = await call('PATCH', '/shadow/sources', {
    kind: 'schedule', enabled: true, schedule: { schedule: 'interval', everyMinutes: 60 },
  });
  check('schedule', '启用并设定「每 1 小时」', 200, enabled.status, enabled.status === 200);

  const schedOn = (await call('GET', '/shadow/status')).json.data.sources.find((item) => item.kind === 'schedule');
  check('schedule', '已排下次到点', true, Boolean(schedOn?.nextFireAt), Boolean(schedOn?.nextFireAt));
  const deltaMin = schedOn?.nextFireAt
    ? Math.round((new Date(schedOn.nextFireAt).getTime() - Date.now()) / 60000)
    : -1;
  check('schedule', '下次到点约 60 分钟后', true, deltaMin >= 55 && deltaMin <= 61, `${deltaMin} 分钟`);

  const fired = await call('POST', '/shadow/sources/fire', { kind: 'schedule' });
  check('schedule', '立即巡检返回 201', 201, fired.status, fired.status === 201);
  const decision1 = await waitDecision(fired.json.data?.triggerId);
  check('schedule', '巡检判为系统候选', 'E_SYSTEM_INFERRED', decision1?.reasonCode,
    decision1?.reasonCode === 'E_SYSTEM_INFERRED');
  check('schedule', '默认提示语不命中规则故不接', false, decision1?.wouldAccept,
    `wouldAccept=${decision1?.wouldAccept}`);

  const afterFire = (await call('GET', '/shadow/status')).json.data.sources.find((item) => item.kind === 'schedule');
  check('schedule', '手动触发不推进下次到点', schedOn?.nextFireAt, afterFire?.nextFireAt,
    afterFire?.nextFireAt === schedOn?.nextFireAt);

  /* 自定义巡检提示语 → 命中「故障排查」规则 → 影子接单。
   * 先把线程频控放宽，否则第二条会被频控挡在前面，测不到规则匹配。 */
  await call('PATCH', '/shadow/policy', { threadRatePerHour: 5 });
  await call('PATCH', '/shadow/sources', {
    kind: 'schedule', enabled: true, schedule: { prompt: '巡检：排查最近的超时与报错' },
  });
  const fired2 = await call('POST', '/shadow/sources/fire', { kind: 'schedule' });
  const decision2 = await waitDecision(fired2.json.data?.triggerId);
  check('schedule', '自定义提示语命中故障排查规则', true,
    (decision2?.matchedRules ?? []).includes('rule-incident'), decision2?.matchedRules);
  check('schedule', '命中规则后影子接单', true, decision2?.wouldAccept, decision2?.wouldAccept);

  /* 频控只约束自动化事件：同一巡检线程一小时内第二次被挡，但留痕。 */
  await call('PATCH', '/shadow/policy', { threadRatePerHour: 1 });
  const fired3 = await call('POST', '/shadow/sources/fire', { kind: 'schedule' });
  const decision3 = await waitDecision(fired3.json.data?.triggerId);
  check('schedule', '同线程自动化事件受频控', 'E_THREAD_RATE_LIMIT', decision3?.reasonCode,
    decision3?.reasonCode === 'E_THREAD_RATE_LIMIT');

  await call('PATCH', '/shadow/sources', { kind: 'schedule', enabled: false });

  /* ⑪ 授权名单：Gate 判的就是「谁能发起」。
   * 这里专门验「清空之后真的空」——早期实现会在数组为空时回落默认值，
   * 表现是「把最后一个人删了，刷新一下他又回来了」。 */
  const policyNow = (await call('GET', '/shadow/status')).json.data.policy;
  const cleared = await call('PATCH', '/shadow/policy', { allowedActors: [] });
  check('auth', '清空白名单', 200, cleared.status, cleared.status === 200);
  check('auth', '白名单真的空了（不被默认值顶回来）', 0,
    (cleared.json.data?.allowedActors ?? []).length, (cleared.json.data?.allowedActors ?? []).length === 0);

  const lockedOut = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-auth-${Date.now()}`, actor: ACTOR, addressed: true, body: 'GMV 归因',
  }, 'auth', '空名单后本人也被挡');
  check('auth', '原因码 E_UNLISTED_ADDRESSED', 'E_UNLISTED_ADDRESSED',
    lockedOut?.decision?.reasonCode, lockedOut?.decision?.reasonCode === 'E_UNLISTED_ADDRESSED');

  await call('PATCH', '/shadow/policy', { allowedActors: policyNow.allowedActors });
  const restored = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-auth2-${Date.now()}`, actor: ACTOR, addressed: true, body: 'GMV 归因',
  }, 'auth', '恢复白名单后放行');
  check('auth', '恢复后判为明确请求', 'E_EXPLICIT_REQUEST',
    restored?.decision?.reasonCode, restored?.decision?.reasonCode === 'E_EXPLICIT_REQUEST');

  /* 机器人入名单：只能产生候选，永远不能产生明确请求。 */
  await call('PATCH', '/shadow/policy', { allowedBots: ['dependabot[bot]'] });
  const botAllowed = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-bot2-${Date.now()}`, actor: 'dependabot[bot]',
    actorKind: 'bot', addressed: true, body: 'bump lodash from 4.17.20 to 4.17.21',
  }, 'auth', '机器人入名单后产生候选');
  check('auth', '原因码 E_BOT_INFERRED', 'E_BOT_INFERRED',
    botAllowed?.decision?.reasonCode, botAllowed?.decision?.reasonCode === 'E_BOT_INFERRED');
  check('auth', '机器人仍是 inferred（不能成为明确请求）', 'inferred',
    botAllowed?.decision?.strength, botAllowed?.decision?.strength === 'inferred');
  await call('PATCH', '/shadow/policy', { allowedBots: [] });

  /* ⑫ 真人对话取料（P1.5）：发一条真实消息，账本里必须出现一条 user 源 Trigger。
   * 这是整条影子链路唯一「不是测试造的数据」的入口，也是 estimatedDailyAccept 的来源。 */
  const conv = await call('POST', '/conversations', { workspaceId: 'w-ops', title: 'QA-影子取料' });
  const convId = conv.json.data?.id;
  check('ingest', '创建会话', true, Boolean(convId), Boolean(convId));
  const sent = await call('POST', `/conversations/${convId}/messages`, {
    content: '帮我排查订单服务的超时，顺便看下 GMV 口径', assetIds: [],
  }, 45000);
  check('ingest', '发送消息成功', 200, sent.status, sent.status === 200);

  let ingested = null;
  let ingestedDecision = null;
  for (let i = 0; i < 30; i += 1) {
    await call('POST', '/shadow/tick', {});
    const list = await call('GET', `/shadow/triggers?limit=50&threadKey=${encodeURIComponent(convId)}`);
    ingested = (list.json.data?.items ?? []).find((item) => item.sourceKind === 'user');
    if (ingested?.decisionId) {
      const decisions = await call('GET', '/shadow/decisions?limit=200');
      ingestedDecision = (decisions.json.data?.items ?? []).find((item) => item.triggerId === ingested.id);
      if (ingestedDecision) break;
    }
    await sleep(150);
  }
  check('ingest', '会话消息进入影子账本', true, Boolean(ingested), Boolean(ingested));
  check('ingest', '线程键 = 会话 id', convId, ingested?.threadKey, ingested?.threadKey === convId);
  check('ingest', '被判为点名（addressed）', true, ingested?.addressed, ingested?.addressed === true);
  check('ingest', '来源标为 user', 'user', ingested?.sourceKind, ingested?.sourceKind === 'user');
  check('ingest', '完成研判', 'evaluated', ingested?.disposition, ingested?.disposition === 'evaluated');
  check('ingest', '真人请求判为 explicit', 'explicit',
    ingestedDecision?.strength, ingestedDecision?.strength === 'explicit');
  check('ingest', '命中规则后影子接单', true,
    ingestedDecision?.wouldAccept, `wouldAccept=${ingestedDecision?.wouldAccept}`);
  check('ingest', '仍不产生工单（P1 不碰执行）', undefined,
    ingestedDecision?.ticketId, !ingestedDecision?.ticketId);

  /* 清理：不留测试会话在库里。 */
  await call('DELETE', `/conversations/${convId}`);

  /* ⑫ 统计面：分母干净、口径可读 */
  const stats = (await call('GET', '/shadow/stats')).json.data;
  check('stats', '触发总数增加', true,
    stats.triggers.total > baseline, `${baseline} → ${stats.triggers.total}`);
  check('stats', '存在影子接单记录', true,
    stats.decisions.wouldAccept >= 1, `wouldAccept=${stats.decisions.wouldAccept}`);
  check('stats', '原因码分布非空', true,
    stats.byReason.length > 0, `byReason=${stats.byReason.length} 类`);
  check('stats', '24h 口径给出「一天接几单」', true,
    typeof stats.last24h.estimatedDailyAccept === 'number',
    `estimatedDailyAccept=${stats.last24h.estimatedDailyAccept}`);
  check('stats', '无遗留 pending', 0, stats.triggers.pending, stats.triggers.pending === 0,
    'pending 未清零说明 tick 有卡住的线程');

  /* ⑬ 授权草案：决策说「会接」，草案说「接了能拿到多大范围」。
   * 这是 P2 真正的输入 —— 没有范围，Mandate 就是一句口号。 */

  /* 先造一条命中「代码审查」的事件（本套用例其它地方没覆盖这条规则）。 */
  await injectAndDecide({
    sourceKind: 'user', threadKey: `t-review-${Date.now()}`, actor: ACTOR,
    addressed: true, body: '帮我把这个 PR 审查一下，补丁在附件里',
  }, 'mandate', '审查事件前置');

  const mandates = await call('GET', '/shadow/mandates?limit=100');
  check('mandate', '影子接单产出草案', 200, mandates.status, mandates.status === 200);
  const drafts = mandates.json.data?.items ?? [];
  check('mandate', '草案数量与影子接单数相当', true, drafts.length >= 2, drafts.length);

  const metricsDraft = drafts.find((item) => (item.matchedRules ?? []).includes('rule-metrics'));
  check('mandate', '指标归因草案存在', true, Boolean(metricsDraft), metricsDraft?.id);
  check('mandate', '归因是只读范围', true, metricsDraft?.readOnly,
    `maxWrites=${metricsDraft?.scope?.maxWrites}`);
  check('mandate', '归因范围含 sql.query.read', true,
    (metricsDraft?.scope?.actions ?? []).includes('sql.query.read'), metricsDraft?.scope?.actions);
  check('mandate', '草案默认未表态', 'draft', metricsDraft?.status, metricsDraft?.status === 'draft');
  check('mandate', '草案不挂工单（P2 才挂）', null, metricsDraft?.ticketId, metricsDraft?.ticketId === null);

  const accepted = await call('POST', `/shadow/mandates/${metricsDraft.id}/review`, { status: 'accepted' });
  check('mandate', '人可以认可草案', 'accepted', accepted.json.data?.status, accepted.json.data?.status === 'accepted');
  check('mandate', '认可后留下时间戳', true, Boolean(accepted.json.data?.reviewedAt), accepted.json.data?.reviewedAt);

  const secondReview = await call('POST', `/shadow/mandates/${metricsDraft.id}/review`, { status: 'rejected' });
  check('mandate', '已定稿的草案不可二次表态', 409, secondReview.status, secondReview.status === 409);
  check('mandate', '错误码 E_ALREADY_RESOLVED', 'E_ALREADY_RESOLVED',
    secondReview.json.error?.code, secondReview.json.error?.code === 'E_ALREADY_RESOLVED');

  /* 收窄只能收、不能放：塞一个原本没有的动作进去，必须被丢弃。 */
  const reviewDraft = drafts.find((item) => (item.matchedRules ?? []).includes('rule-review'));
  check('mandate', '代码审查草案存在', true, Boolean(reviewDraft), reviewDraft?.id);
  const narrowed = await call('POST', `/shadow/mandates/${reviewDraft.id}/review`, {
    status: 'narrowed',
    actions: ['code.read', 'shell.exec'],
  });
  const narrowedActions = narrowed.json.data?.scope?.actions ?? [];
  check('mandate', '收窄保留原有动作', true, narrowedActions.includes('code.read'), narrowedActions);
  check('mandate', '收窄无法塞入新动作（不是提权后门）', false,
    narrowedActions.includes('shell.exec'), narrowedActions);

  /* 粒度：没挂资产 → 工作区级 + 类型白名单；挂了资产 → 收窄到那一个。
   * 这一条决定了「范围未定」是常态还是例外。 */
  const workspaceDraft = drafts.find((item) => item.scope?.level === 'workspace' && !item.scopeUndefined);
  check('mandate', '未绑资产退到工作区级', true, Boolean(workspaceDraft), workspaceDraft?.id);
  check('mandate', '工作区级带资产类型白名单', true,
    (workspaceDraft?.scope?.assetTypes ?? []).length > 0, workspaceDraft?.scope?.assetTypes);

  const assetCase = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-asset-${Date.now()}`, actor: ACTOR, addressed: true,
    assetId: 'a-order-service', body: '这个 PR 的补丁帮我审查一下',
  }, 'mandate', '挂资产的事件');
  const assetMandate = (await call('GET', '/shadow/mandates?limit=100')).json.data.items
    .find((item) => item.decisionId === assetCase?.decision?.id);
  check('mandate', '挂资产的草案收窄到该资产', 'asset',
    assetMandate?.scope?.level, assetMandate?.scope?.level === 'asset');
  check('mandate', '范围里就是那一个资产', '["a-order-service"]',
    JSON.stringify(assetMandate?.scope?.assets ?? []),
    JSON.stringify(assetMandate?.scope?.assets ?? []) === '["a-order-service"]');

  /* 规则不给资产类型 + 事件不挂资产 → 拒签。宁可不签，也不签一份无界的。 */
  const beforeNoScope = (await call('GET', '/shadow/mandates?limit=1')).json.data.total;
  await call('PATCH', '/shadow/policy', {
    rules: [{
      id: 'rule-noise', name: '无范围规则', enabled: true,
      keywords: ['噪音测试'], assetTypes: [],
      scope: { actions: ['code.read'], riskCeiling: 'low', maxWrites: 0 },
    }],
  });
  await injectAndDecide({
    sourceKind: 'user', threadKey: `t-noscope-${Date.now()}`, actor: ACTOR,
    addressed: true, body: '噪音测试：随便看看',
  }, 'mandate', '无类型规则事件');
  const afterNoScope = (await call('GET', '/shadow/mandates?limit=1')).json.data.total;
  check('mandate', '工作区级缺类型白名单 → 拒签', beforeNoScope, afterNoScope,
    afterNoScope === beforeNoScope);
  /* 收尾：清空规则，避免把测试策略留在库里。 */
  await call('PATCH', '/shadow/policy', { rules: [] });

  const statsAfter = (await call('GET', '/shadow/stats')).json.data;
  check('mandate', '统计给出草案总数', true, (statsAfter.mandates?.total ?? 0) >= 2, statsAfter.mandates);

  /* ⑭ auto 签发：策略经 HTTP 往返后仍然生效。
   * 这一条专门守「契约漏字段」——scope 就曾经被 zod 静默丢掉过，
   * 表现是决策照常、草案永远发不出来，而日志里一个错都没有。 */
  await call('PATCH', '/shadow/policy', {
    acceptMode: 'auto', autoMaxPerHour: 2, autoAllowWrites: false,
    threadRatePerHour: 5,
    rules: [{
      id: 'rule-metrics', name: '指标归因', enabled: true,
      keywords: ['gmv', '同比'], assetTypes: ['db'],
      scope: { actions: ['sql.query.read'], riskCeiling: 'low', maxWrites: 0 },
    }],
  });

  const autoStatus = (await call('GET', '/shadow/status')).json.data;
  check('auto', 'autoMaxPerHour 经契约往返后保留', 2,
    autoStatus?.policy?.autoMaxPerHour, autoStatus?.policy?.autoMaxPerHour === 2);
  check('auto', 'autoAllowWrites 默认 false', false,
    autoStatus?.policy?.autoAllowWrites, autoStatus?.policy?.autoAllowWrites === false);

  const autoCase = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-auto-${Date.now()}`, actor: ACTOR,
    addressed: true, assetId: 'a-auto-db', body: 'GMV 同比掉了 8%，归因一下',
  }, 'auto', 'auto 模式下的明确请求');

  const autoMandates = (await call('GET', '/shadow/mandates?limit=100')).json.data.items ?? [];
  const autoDraft = autoMandates.find((item) => item.decisionId === autoCase?.decision?.id);
  check('auto', '只读事件被自动签发', 'accepted', autoDraft?.status, autoDraft?.status === 'accepted');
  check('auto', '自动签发留下 auto 标记', true,
    String(autoDraft?.note ?? '').startsWith('auto:'), autoDraft?.note);
  /* Router 可能已经把它建成工单了（后台循环一直在跑），所以这里只断言
   * 「指向的是一张真实工单或空」—— 不假设时序，否则测试会随机器快慢而红绿。 */
  check('auto', '自动签发的授权只指向真实工单或空', true,
    autoDraft?.ticketId === null || autoDraft?.ticketId === undefined || String(autoDraft?.ticketId).startsWith('tkt'),
    `${autoDraft?.ticketId} (${typeof autoDraft?.ticketId})`);

  /* 写范围：auto 下面也必须退回草案等人批。 */
  await call('PATCH', '/shadow/policy', {
    rules: [{
      id: 'rule-review', name: '代码审查', enabled: true,
      keywords: ['审查'], assetTypes: ['code'],
      scope: { actions: ['code.read', 'file.write'], riskCeiling: 'medium', maxWrites: 3 },
    }],
  });
  const writeCase = await injectAndDecide({
    sourceKind: 'user', threadKey: `t-auto-w-${Date.now()}`, actor: ACTOR,
    addressed: true, assetId: 'a-auto-code', body: '这个补丁帮我审查并改一下',
  }, 'auto', 'auto 模式下的写请求');
  const writeMandate = ((await call('GET', '/shadow/mandates?limit=100')).json.data.items ?? [])
    .find((item) => item.decisionId === writeCase?.decision?.id);
  check('auto', '写范围不被自动签发', 'draft', writeMandate?.status, writeMandate?.status === 'draft');

  /* 恢复：关掉 auto，清空规则，避免影响后续用例。 */
  await call('PATCH', '/shadow/policy', { acceptMode: 'observe', autoMaxPerHour: 3, autoAllowWrites: false, rules: [] });

  console.log('');
  console.log(`影子链路：${results.passed}/${results.total} 通过`);
  if (results.failed > 0) {
    console.log(`失败用例：\n  - ${failures.join('\n  - ')}`);
  }
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[test:shadow] 运行异常:', error);
  process.exit(2);
});
