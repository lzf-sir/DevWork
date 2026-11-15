/**
 * 遗留标记文案的纯逻辑验证（前端侧）。
 *
 * 界面上这个面板唯一的价值就是「不撒谎」，而撒谎点全在措辞分支里：
 *   · 有缺口时抬头说「共 N 条」→ 用户会以为仓库总共就这些；
 *   · 非代码文件印归属 → 编出一个不存在的符号；
 *   · 三个缺口压成一句 → 用户分不清该不该换个路径重扫。
 *
 * 截图只能证明「渲染出来了」，证明不了「每一支都说对了」——那是这一层的活。
 *
 * 运行：npx tsx tests/todo-copy.spec.ts
 */
import type { FileTodosResult, TodoHitShape } from '../frontend/src/api/types';
import { todoGaps, todoOwner, todoRailSummary } from '../frontend/src/utils/todo-copy';
import { STALE_PANEL_NOTE, STALE_RAIL_LABEL, shouldInvalidateScans } from '../frontend/src/utils/stale-copy';

let passed = 0;
let failed = 0;

function check(name: string, expected: unknown, actual: unknown, ok: boolean): void {
  if (ok) {
    passed += 1;
    console.log(`[PASS] ${name}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${name}`);
    console.log(`       期望: ${JSON.stringify(expected)}`);
    console.log(`       实际: ${JSON.stringify(actual)}`);
  }
}

const hit = (over: Partial<TodoHitShape> = {}): TodoHitShape => ({
  path: 'src/main/java/order/OrderService.java',
  line: 42,
  marker: 'TODO',
  text: '补补偿逻辑',
  owner: 'OrderService.create',
  codeFile: true,
  ...over,
});

const scan = (over: Partial<FileTodosResult> = {}): FileTodosResult => ({
  hits: [hit()],
  filesRead: 10,
  skippedLarge: 0,
  stoppedAtCap: false,
  walkTruncated: false,
  ...over,
});

/* ---------- 归属：三种取值，三句不同的话 ---------- */
{
  const method = todoOwner(hit());
  check('方法内命中 → 在 类.方法 里', '在 OrderService.create 里', method, method === '在 OrderService.create 里');

  const klass = todoOwner(hit({ owner: 'OrderService' }));
  check('类内命中 → 在 类名 里', '在 OrderService 里', klass, klass === '在 OrderService 里');

  /* 代码文件里没有 owner 是**结论**（模块级）；不解释就等于让用户以为归属丢了。 */
  const moduleLevel = todoOwner(hit({ owner: undefined }));
  check('代码文件无 owner → 模块级（是结论，不是缺失）', '模块级（不在任何符号内）', moduleLevel,
    moduleLevel === '模块级（不在任何符号内）');

  /* 配置文件里的 TODO 谈不上归属：这个格式没有符号概念。 */
  const nonCode = todoOwner(hit({ owner: undefined, codeFile: false, path: 'pom.xml' }));
  check('非代码文件 → 不印归属（没有符号这个概念）', '', nonCode, nonCode === '');
}

/* ---------- 缺口：三条通道各自独立 ---------- */
{
  check('扫描完整 → 一句缺口都不说', '[]', todoGaps(scan()), todoGaps(scan()).length === 0);

  const capped = todoGaps(scan({ stoppedAtCap: true }));
  check('命中触顶 → 只说「后面的文件没读」', 1, capped.length,
    capped.length === 1 && capped[0].includes('后面的文件没有读'));
  /* 刻意不说「后面还有」：最后一条恰好是仓库最后一条时那就是假话。 */
  check('触顶文案不说「后面还有」', '不含「还有」', capped[0] ?? '',
    capped.length === 1 && !capped[0].includes('还有'));

  const walked = todoGaps(scan({ walkTruncated: true }));
  check('遍历截断 → 单独一句', 1, walked.length, walked.length === 1 && walked[0].includes('遍历'));

  const skipped = todoGaps(scan({ skippedLarge: 3 }));
  check('大文件跳过 → 单独一句并给个数', 1, skipped.length,
    skipped.length === 1 && skipped[0].includes('3 个文件'));

  const all = todoGaps(scan({ stoppedAtCap: true, walkTruncated: true, skippedLarge: 1 }));
  check('三种缺口叠加 → 三句，不合并', 3, all.length, all.length === 3);
}

/* ---------- 右栏摘要：窄也不能省覆盖率 ---------- */
{
  check('完整 + 有命中 → 直接给条数', '4 条 · 3 个文件',
    todoRailSummary(scan({
      hits: [hit({ path: 'a/One.java' }), hit({ path: 'a/One.java', line: 7 }), hit({ path: 'a/Two.java' }), hit({ path: 'a/Three.java' })],
    })),
    todoRailSummary(scan({
      hits: [hit({ path: 'a/One.java' }), hit({ path: 'a/One.java', line: 7 }), hit({ path: 'a/Two.java' }), hit({ path: 'a/Three.java' })],
    })) === '4 条 · 3 个文件');

  const partial = todoRailSummary(scan({ stoppedAtCap: true, hits: [hit(), hit({ line: 50 })] }));
  check('有缺口 → 抬头必须带「已列」', '已列 2 条 · 1 个文件', partial,
    partial.startsWith('已列 '));

  check('完整 + 零命中 → 说「没有」', '没有遗留标记', todoRailSummary(scan({ hits: [] })),
    todoRailSummary(scan({ hits: [] })) === '没有遗留标记');

  /* 零命中但有缺口：不能说「没有」，只能说「没扫到」。措辞差一个字，结论差一个量级。 */
  const emptyPartial = todoRailSummary(scan({ hits: [], walkTruncated: true }));
  check('零命中 + 有缺口 → 只能说「没扫到（未覆盖全部文件）」', '没扫到（未覆盖全部文件）',
    emptyPartial, emptyPartial === '没扫到（未覆盖全部文件）' && !emptyPartial.includes('没有'));
}

/* ---------- 过期：只有真写盘才算，且要说出「别再信这个数字」 ---------- */
{
  check('真写盘 → 标过期', true, shouldInvalidateScans(true), shouldInvalidateScans(true) === true);
  /* 只是点了一下保存、内容没变：这时标过期就是假警，假警多了真警没人信。 */
  check('diskChanged=false → 不标过期（不做假警）', false, shouldInvalidateScans(false),
    shouldInvalidateScans(false) === false);

  check('过期提示说明行号会偏移（不只是"数据可能过期"）', '含「行号」与「重新扫描」',
    STALE_PANEL_NOTE, STALE_PANEL_NOTE.includes('行号') && STALE_PANEL_NOTE.includes('重新扫描'));
  check('右栏过期态是动作而不是旧数字', '已修改 · 点此重新扫描', STALE_RAIL_LABEL,
    STALE_RAIL_LABEL === '已修改 · 点此重新扫描' && !/\d/.test(STALE_RAIL_LABEL));
}

console.log(`\n遗留标记文案：${passed}/${passed + failed} 通过`);
process.exitCode = failed === 0 ? 0 : 1;
