/**
 * 任务清单 + 上下文压缩链路测试。
 *
 * 覆盖两件在长任务里最容易出错的事：
 *  ① 清单卡是否**同一张原位更新**（不是每推进一步就多一张，把时间线刷满）；
 *      以及进度是否由状态数推导（模型自报的完成数不算数）。
 *  ② 压缩是否**只折叠进提示的内容**：原始消息一条不动，摘要卡落进时间线，
 *      上下文用量跟着回退；不值得压缩时如实返回 skipped 而不是硬塞一张空摘要。
 *
 * 为什么必须黑盒测：这两条链路都跨了「服务端会话编排 → 数据库 → API 形状」，
 * 单看任何一个函数都对，接起来才会出现"卡在库里有两张""压缩完用量没回退"。
 */
const BASE = process.env.DEVWORK_BASE ?? 'http://127.0.0.1:3001';
const API = `${BASE}/api`;

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

async function call(method, urlPath, body, timeoutMs = 60000) {
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

/** 造一段足够长的用户输入：压缩要"折叠后确实更小"，内容太短会触发"不值得压缩"。 */
function longAsk(index) {
  const tail = `第 ${index} 轮：请核对订单库 status 分布，并说明慢查询与超时配置之间的关系。`.repeat(4);
  return `${tail} 这一段是刻意写长的，用来验证上下文折叠确实减少了发给模型的体量。`;
}

async function main() {
  /* ---------- 建会话 ---------- */
  const created = await call('POST', '/conversations', { workspaceId: 'w-ops', title: 'QA · 清单与压缩' });
  const conversationId = created.json.data?.id;
  check('setup', '会话已创建', true, Boolean(conversationId), Boolean(conversationId), JSON.stringify(created.json).slice(0, 200));
  if (!conversationId) process.exit(1);

  /* ---------- 1. 空会话的上下文用量 ---------- */
  const fresh = await call('GET', `/conversations/${conversationId}/context-usage`);
  const usage = fresh.json.data ?? {};
  check('usage', '返回 200', 200, fresh.status, fresh.status === 200);
  check('usage', '有预算值', true, usage.budget, Number(usage.budget) > 0);
  check('usage', '预算来自模型或默认口径', true, usage.windowSource,
    ['setting', 'model', 'default'].includes(String(usage.windowSource)));
  check('usage', '占用含系统与工具开销（不是 0）', true, usage.used,
    Number(usage.used) > 0, `used=${usage.used}`);
  check('usage', '构成是数组', true, Array.isArray(usage.breakdown), Array.isArray(usage.breakdown));
  check('usage', '空会话没有消息进提示', 0, usage.messages?.total, usage.messages?.total === 0);
  check('usage', '空会话不触发压缩', false, usage.shouldCompact, usage.shouldCompact === false);

  /* ---------- 2. 空会话压缩：应如实 skipped ---------- */
  const emptyCompact = await call('POST', `/conversations/${conversationId}/compact`, {});
  check('compact', '空会话压缩不报错', 200, emptyCompact.status, emptyCompact.status === 200);
  check('compact', '空会话压缩返回 skipped', true, emptyCompact.json.data?.skipped,
    emptyCompact.json.data?.skipped === true);
  check('compact', 'skipped 必须带原因（不能静默）', true,
    String(emptyCompact.json.data?.reason ?? '').length, String(emptyCompact.json.data?.reason ?? '').length > 0);

  /* ---------- 3. 第 1 轮：清单卡建立 ---------- */
  const first = await call('POST', `/conversations/${conversationId}/messages`, { content: longAsk(1) });
  const firstCards = first.json.data?.messages ?? [];
  const todoCards = firstCards.filter((card) => card.kind === 'todo');
  check('todo', '第 1 轮返回清单卡', 1, todoCards.length, todoCards.length === 1);
  const todoPayload = todoCards[0]?.payload ?? {};
  const items = Array.isArray(todoPayload.items) ? todoPayload.items : [];
  check('todo', '清单至少 3 步', true, items.length, items.length >= 3);
  check('todo', '清单项都带状态', true, items.map((item) => item.status).join(','),
    items.every((item) => ['pending', 'doing', 'done', 'blocked'].includes(String(item.status))));
  check('todo', '演示轨迹不假装完成', 0, todoPayload.progress?.done, todoPayload.progress?.done === 0,
    '未接入模型时清单全部 pending');
  check('todo', '进度总数等于清单项数', items.length, todoPayload.progress?.total,
    todoPayload.progress?.total === items.length);

  /* ---------- 4. 第 2 轮：同一张卡更新，不是新增 ---------- */
  await call('POST', `/conversations/${conversationId}/messages`, { content: longAsk(2) });
  const listAfterSecond = await call('GET', `/conversations/${conversationId}/messages`);
  const todoAfterSecond = (listAfterSecond.json.data ?? []).filter((card) => card.kind === 'todo');
  check('todo', '两轮之后清单卡仍只有 1 张', 1, todoAfterSecond.length, todoAfterSecond.length === 1,
    '清单是"原位更新"的状态卡，不是历史消息');
  check('todo', '清单版本号在推进', true, todoAfterSecond[0]?.payload?.revision,
    Number(todoAfterSecond[0]?.payload?.revision ?? 0) >= 2);

  /* ---------- 5. 再发几轮，制造可压缩的历史 ---------- */
  for (const round of [3, 4, 5, 6]) {
    await call('POST', `/conversations/${conversationId}/messages`, { content: longAsk(round) });
  }
  const beforeUsage = (await call('GET', `/conversations/${conversationId}/context-usage`)).json.data ?? {};
  check('usage', '多轮之后有消息进入提示', true, beforeUsage.messages?.total,
    Number(beforeUsage.messages?.total ?? 0) >= 4, `total=${beforeUsage.messages?.total}`);

  /* ---------- 6. 手动压缩 ---------- */
  const compact = await call('POST', `/conversations/${conversationId}/compact`, {});
  const compacted = compact.json.data ?? {};
  check('compact', '手动压缩返回 200', 200, compact.status, compact.status === 200);
  check('compact', '多轮之后压缩真的做了事', false, compacted.skipped, compacted.skipped === false,
    `reason=${compacted.reason ?? ''}`);
  check('compact', '折叠条数 >= 2', true, compacted.covered, Number(compacted.covered) >= 2);
  check('compact', '压缩后占用下降', true, `${compacted.before} → ${compacted.after}`,
    Number(compacted.after) < Number(compacted.before));
  check('compact', '摘要来源可追溯', true, compacted.summary?.source,
    ['model', 'rule'].includes(String(compacted.summary?.source)));
  check('compact', '摘要卡随结果返回', true, Boolean(compacted.card?.id), Boolean(compacted.card?.id));

  /* ---------- 7. 压缩后：原始消息还在，摘要卡进时间线 ---------- */
  const listAfterCompact = await call('GET', `/conversations/${conversationId}/messages`);
  const cardsAfterCompact = listAfterCompact.json.data ?? [];
  check('compact', '摘要卡已落库', true, cardsAfterCompact.filter((card) => card.kind === 'summary').length,
    cardsAfterCompact.some((card) => card.kind === 'summary'));
  check('compact', '原始用户气泡未被删除', true,
    cardsAfterCompact.filter((card) => card.kind === 'bubble').length,
    cardsAfterCompact.filter((card) => card.kind === 'bubble').length >= 6,
    '压缩只影响发给模型的内容，时间线必须完整');

  const afterUsage = (await call('GET', `/conversations/${conversationId}/context-usage`)).json.data ?? {};
  check('compact', '用量接口反映压缩结果', true, afterUsage.summary?.messages,
    Number(afterUsage.summary?.messages ?? 0) >= 2);
  check('compact', '压缩后仍能继续多轮', true, afterUsage.messages?.total,
    Number(afterUsage.messages?.total ?? 0) >= 2);

  /* ---------- 8. 压缩之后再发一轮：不能报错（摘要要能进提示） ---------- */
  const afterSend = await call('POST', `/conversations/${conversationId}/messages`, { content: longAsk(7) });
  check('post-compact', '压缩后继续发送成功', 200, afterSend.status, afterSend.status === 200);
  check('post-compact', '仍返回助手卡片', true, (afterSend.json.data?.messages ?? []).length,
    (afterSend.json.data?.messages ?? []).length > 0);

  /* ---------- 9. 边界：不存在的会话 ---------- */
  const missingUsage = await call('GET', '/conversations/c-not-exist/context-usage');
  check('boundary', '不存在的会话查用量返回 404', 404, missingUsage.status, missingUsage.status === 404);
  const missingCompact = await call('POST', '/conversations/c-not-exist/compact', {});
  check('boundary', '不存在的会话压缩返回 404', 404, missingCompact.status, missingCompact.status === 404);
  const badKeep = await call('POST', `/conversations/${conversationId}/compact`, { keepShare: 0.9 });
  check('boundary', '越界 keepShare 被契约挡下', 400, badKeep.status, badKeep.status === 400);

  console.log('');
  console.log(`清单与压缩链路：${results.passed}/${results.total} 通过`);
  if (results.failed > 0) console.log(`失败用例：\n  - ${failures.join('\n  - ')}`);
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('[test:context] 运行异常:', error);
  process.exit(2);
});
