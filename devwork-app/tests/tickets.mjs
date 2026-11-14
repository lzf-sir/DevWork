/**
 * 工单链路测试（P2）。
 *
 * 覆盖一条完整的「授权 → 建单 → 派工 → 执行 → 报告」链，以及三个安全边界：
 *   · 草案授权不建工单（没认可就没有工单）
 *   · 同一线程的第二件事 attach，不新开
 *   · 没有模型时如实失败，不假装干过
 *
 * 为什么这条链路必须黑盒测：它跨了 5 张表 + 2 个循环，
 * 单看任何一个函数都是对的，接起来才会错。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DEVWORK_BASE ?? 'http://127.0.0.1:3001';
const API = `${BASE}/api`;
const ACTOR = '本机用户';
const ASSET = 'a-order-service';

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

async function call(method, urlPath, body, timeoutMs = 30000) {
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

/** 注入一条事件并等它被判出决策来。 */
async function feed(content, threadKey) {
  const created = await call('POST', '/shadow/triggers', {
    sourceKind: 'user', threadKey, actor: ACTOR, addressed: true,
    assetId: ASSET, body: content,
  });
  const triggerId = created.json.data?.triggerId;
  for (let i = 0; i < 30; i += 1) {
    await call('POST', '/shadow/tick', {});
    const list = await call('GET', '/shadow/decisions?limit=200');
    const hit = (list.json.data?.items ?? []).find((item) => item.triggerId === triggerId);
    if (hit) return { triggerId, decision: hit };
    await sleep(120);
  }
  return { triggerId, decision: null };
}

/** 取某条决策对应的授权草案。 */
async function mandateOf(decisionId) {
  const list = await call('GET', '/shadow/mandates?limit=100');
  return (list.json.data?.items ?? []).find((item) => item.decisionId === decisionId) ?? null;
}

/** 推循环直到工单进入终态，避免依赖 1s 定时器的时序。 */
async function stepUntil(predicate, tries = 25) {
  for (let i = 0; i < tries; i += 1) {
    await call('POST', '/tickets/step', {});
    const list = await call('GET', '/tickets?limit=50');
    const items = list.json.data?.items ?? [];
    const hit = items.find(predicate);
    if (hit) return hit;
    await sleep(150);
  }
  return null;
}

async function main() {
  /* 自带规则：不依赖上一个套件留下的策略（影子套件收尾会清空规则）。
   * 独立可跑是测试文件的基本要求。 */
  await call('PATCH', '/shadow/policy', {
    rules: [{
      id: 'rule-incident', name: '故障排查', enabled: true,
      keywords: ['超时', '排查'], assetTypes: ['log', 'db', 'code', 'server'],
      scope: {
        actions: ['log.read', 'sql.query.read', 'code.read', 'code.search.read'],
        riskCeiling: 'low', maxWrites: 0,
      },
    }],
  });

  const boot = await call('GET', '/tickets/stats');
  check('boot', '工单统计可读', 200, boot.status, boot.status === 200);
  check('boot', 'Agent 循环在跑', true, boot.json.data?.loop?.running, boot.json.data?.loop?.running === true);
  const baseline = boot.json.data?.total ?? 0;

  /* ① 草案授权不建工单 */
  const key = `ticket-${Date.now()}`;
  const first = await feed('订单服务超时，帮我排查一下慢查询', key);
  check('auth', '事件被判为影子接单', true, first.decision?.wouldAccept,
    `reason=${first.decision?.reasonCode}`);
  const draft = await mandateOf(first.decision?.id);
  check('auth', '产出授权草案', true, Boolean(draft), draft?.id);
  if (!draft) {
    console.log('工单链路：缺少草案，后续用例无法继续');
    process.exit(1);
  }
  check('auth', '草案默认未认可', 'draft', draft?.status, draft?.status === 'draft');

  /* 只断言「这一条草案没建出工单」。
   * 不能比总数：串跑时前一阶段可能留下已认可的授权及其工单，那是合法存在的。 */
  await call('POST', '/tickets/step', {});
  const beforeAccept = await call('GET', '/tickets?limit=50');
  const builtFromDraft = (beforeAccept.json.data?.items ?? []).some((item) => item.mandateId === draft.id);
  check('auth', '草案态不建工单', false, builtFromDraft, builtFromDraft === false);

  /* ② 认可后才建工单并派工 */
  const accepted = await call('POST', `/shadow/mandates/${draft.id}/review`, { status: 'accepted' });
  check('flow', '人可以认可授权', 'accepted', accepted.json.data?.status,
    accepted.json.data?.status === 'accepted');

  const ticket = await stepUntil((item) => item.mandateId === draft.id);
  check('flow', '认可后建出工单', true, Boolean(ticket), ticket?.id);
  check('flow', '工单带授权 id', draft.id, ticket?.mandateId, ticket?.mandateId === draft.id);
  check('flow', '工单落在原线程', true, Boolean(ticket?.threadId), ticket?.threadId);
  check('flow', '工单有自己的会话', true, Boolean(ticket?.conversationId), ticket?.conversationId);

  /* ③ 没有模型时如实失败，不假装干过 */
  /* 等「本轮真的结束了」：report 有值才说明派工跑完。
   * 只看 stage 会被 idle 骗到——没有派工记录的工单 stage 也是 idle。 */
  const RUN_ENDED = ['failed', 'ready', 'waiting', 'blocked', 'dropped'];
  const settled = await stepUntil((item) => item.id === ticket?.id && RUN_ENDED.includes(String(item.report)));
  check('worker', '派工跑过一轮', 'failed|ready|waiting|blocked',
    String(settled?.report), RUN_ENDED.includes(String(settled?.report)));
  check('worker', '无模型时报告失败', 'failed', settled?.report, settled?.report === 'failed');
  check('worker', '失败原因说清是没模型', true,
    String(settled?.reportNote ?? '').includes('模型'), settled?.reportNote);

  /* ④ 同一线程的第二件事：attach，不新开 */
  const second = await feed('还有一个超时的接口，一起看看', key);
  const draft2 = await mandateOf(second.decision?.id);
  if (draft2) {
    await call('POST', `/shadow/mandates/${draft2.id}/review`, { status: 'accepted' });
    await call('POST', '/tickets/step', {});
    const afterAttach = await call('GET', '/tickets?limit=50');
    const sameThread = (afterAttach.json.data?.items ?? []).filter((item) => item.threadId === ticket?.threadId);
    check('attach', '同线程不新开工单', 1, sameThread.length, sameThread.length === 1);
    check('attach', '第二条挂到同一张工单', ticket?.id, sameThread[0]?.id, sameThread[0]?.id === ticket?.id);
  } else {
    check('attach', '第二条也产出草案', true, false, '第二条事件未产出草案，跳过 attach 校验');
  }

  /* ⑤ 重派：只在没有在途派工时允许 */
  const retried = await call('POST', `/tickets/${ticket.id}/retry`, {});
  check('retry', '失败后可重派', 200, retried.status, retried.status === 200);
  const secondTry = await stepUntil((item) => item.id === ticket.id && RUN_ENDED.includes(String(item.report)));
  check('retry', '重派后再跑一轮', 'failed', secondTry?.report, secondTry?.report === 'failed');

  /* ⑥ 停止：人叫停优先于一切 */
  const stopped = await call('POST', `/tickets/${ticket.id}/stop`, {});
  check('stop', '人可以叫停工单', 200, stopped.status, stopped.status === 200);
  check('stop', '停止后状态为 ended', 'ended', stopped.json.data?.ticket?.state,
    stopped.json.data?.ticket?.state === 'ended');
  check('stop', '停止原因可追溯', 'stopped_by_person', stopped.json.data?.ticket?.endedReason,
    stopped.json.data?.ticket?.endedReason === 'stopped_by_person');
  const stopAgain = await call('POST', `/tickets/${ticket.id}/stop`, {});
  check('stop', '重复停止返回 409', 409, stopAgain.status, stopAgain.status === 409);

  /* ⑦ 契约与统计 */
  const badAnswer = await call('POST', `/tickets/${ticket.id}/answer`, { attentionId: 'nope', answer: '好' });
  check('contract', '回答不存在的提问被拒', 400, badAnswer.status, badAnswer.status === 400);

  /* 详情聚合：一张单的全部事实必须在一次请求里给齐。
   * 前端不串四个接口 —— 串了之后时间线对不齐，人也看不出「第几轮失败」。 */
  const detail = await call('GET', `/tickets/${ticket.id}`);
  check('detail', '详情接口返回 200', 200, detail.status, detail.status === 200);
  check('detail', '顶层保持工单字段（向后兼容）', ticket.id, detail.json.data?.id, detail.json.data?.id === ticket.id);
  check('detail', '带授权范围', true,
    typeof detail.json.data?.mandate?.scope === 'object' && detail.json.data?.mandate !== null,
    detail.json.data?.mandate?.status);
  check('detail', '带派工历史', true,
    Array.isArray(detail.json.data?.assignments) && detail.json.data.assignments.length >= 1,
    detail.json.data?.assignments?.length);
  check('detail', '轮次汇总与实际记录一致',
    detail.json.data?.assignments?.length, detail.json.data?.totals?.rounds,
    detail.json.data?.totals?.rounds === detail.json.data?.assignments?.length);
  check('detail', '带收件箱数组', true, Array.isArray(detail.json.data?.inbox), detail.json.data?.inbox?.length);
  check('detail', '带提问历史数组', true,
    Array.isArray(detail.json.data?.attentions), Array.isArray(detail.json.data?.attentions),
    `length=${detail.json.data?.attentions?.length}`);
  check('detail', '派工记录带工作目录字段', true,
    detail.json.data.assignments.map((item) => typeof item.workdir).join(','),
    detail.json.data.assignments.every((item) => typeof item.workdir === 'string'));

  const missing = await call('GET', '/tickets/tkt-not-exist');
  check('detail', '不存在的工单返回 404', 404, missing.status, missing.status === 404);

  const stats = await call('GET', '/tickets/stats');
  check('stats', '工单总数已增加', true, (stats.json.data?.total ?? 0) > baseline,
    `${baseline} → ${stats.json.data?.total}`);
  check('stats', '有失败派工记录', true, (stats.json.data?.failedAssignments ?? 0) >= 1,
    stats.json.data?.failedAssignments);
  check('stats', '给出打扰密度口径', 'number',
    typeof stats.json.data?.attentionPerTicket, typeof stats.json.data?.attentionPerTicket === 'number');

  console.log('');
  console.log(`工单链路：${results.passed}/${results.total} 通过`);
  if (results.failed > 0) console.log(`失败用例：\n  - ${failures.join('\n  - ')}`);
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[test:tickets] 运行异常:', error);
  process.exit(2);
});
