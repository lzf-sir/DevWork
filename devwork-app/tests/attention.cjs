/**
 * 待人徽标的纯逻辑回归 —— 不需要 Electron 就能跑：`node tests/attention.cjs`
 *
 * 为什么值得单独一条测试：任务栏图标画错了不会报错，只会安静地显示成
 * 一个蓝色的「红点」、或者一个糊成一团的方块。像素断言是唯一能提前发现它的地方。
 */
const assert = require('node:assert');
const attention = require('../desktop/attention.cjs');

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failures.push(name);
    console.log(`[FAIL] ${name}\n       ${error.message}`);
  }
}

/* 取某个像素的 BGRA 分量。顺序写反是这段代码最容易犯的错，所以断言按通道来。 */
function pixel(buf, x, y) {
  const offset = (y * attention.SIZE + x) * 4;
  return { b: buf[offset], g: buf[offset + 1], r: buf[offset + 2], a: buf[offset + 3] };
}

check('标题：无事不带前缀，有事数字在最前', () => {
  assert.strictEqual(attention.windowTitle(0), 'DevWork');
  assert.strictEqual(attention.windowTitle(4), '(4) DevWork');
  /* 数字必须在前：任务栏按右截断，`DevWork (4)` 先丢的正好是那个数字。 */
  assert.ok(attention.windowTitle(12).startsWith('(12)'));
});

check('等级归一：未知值降到 review，不虚报急', () => {
  assert.strictEqual(attention.normalizeLevel('garbage'), 'review');
  assert.strictEqual(attention.normalizeLevel(undefined), 'review');
  assert.strictEqual(attention.normalizeLevel('answer'), 'answer');
});

check('徽标底色按通道正确（B/G/R，不是 R/G/B）', () => {
  const buf = attention.buildBadgeBitmap('answer');
  const [r, g, b] = attention.LEVEL_COLOR.answer;
  /* 圆心与圆周之间随便取一点，验的是填充色而不是边。 */
  const inside = pixel(buf, attention.SIZE / 2, attention.SIZE - 5);
  assert.ok(inside.a > 200, `圆内应不透明，实际 a=${inside.a}`);
  assert.strictEqual(inside.r, r, `R 通道应为 ${r}，实际 ${inside.r}`);
  assert.strictEqual(inside.g, g, `G 通道应为 ${g}，实际 ${inside.g}`);
  assert.strictEqual(inside.b, b, `B 通道应为 ${b}，实际 ${inside.b}`);
});

check('三档颜色互不相同', () => {
  const levels = ['answer', 'stuck', 'review'];
  const colors = levels.map((level) => attention.LEVEL_COLOR[level].join(','));
  assert.strictEqual(new Set(colors).size, 3);
});

check('三档都画成实心点：没有白色像素（不写字）', () => {
  for (const level of ['answer', 'stuck', 'review']) {
    const buf = attention.buildBadgeBitmap(level);
    let white = 0;
    let opaque = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 3] > 200) opaque += 1;
      if (buf[i] === 255 && buf[i + 1] === 255 && buf[i + 2] === 255) white += 1;
    }
    assert.strictEqual(white, 0, `${level} 不该有白色字形`);
    /* 圆面积 ≈ πr² ≈ 707（32px 画布、半径 15），占画布 1/2 以上。 */
    assert.ok(opaque > 500 && opaque < 900, `${level} 圆面积异常：${opaque}`);
  }
});

check('圆外是透明的（不留方块底）', () => {
  const buf = attention.buildBadgeBitmap('review');
  [pixel(buf, 0, 0), pixel(buf, attention.SIZE - 1, 0), pixel(buf, 0, attention.SIZE - 1)].forEach(
    (p) => assert.strictEqual(p.a, 0, '四角应完全透明'),
  );
});

check('边缘有抗锯齿过渡（不是硬切）', () => {
  const buf = attention.buildBadgeBitmap('answer');
  let partial = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] > 8 && buf[i + 3] < 200) partial += 1;
  }
  assert.ok(partial > 20, `半透明过渡像素太少：${partial}`);
});

check('台账文案说清「几张、做什么」', () => {
  assert.strictEqual(attention.overlayDescription(0, 'answer'), '');
  assert.strictEqual(attention.overlayDescription(1, 'answer'), '1 张工单等你回答');
  assert.strictEqual(attention.overlayDescription(3, 'stuck'), '3 张工单受阻待决');
  assert.ok(attention.trayTooltip(0, 'review').includes('后台任务继续运行'));
  assert.ok(attention.trayTooltip(2, 'review').includes('2 张工单待你验收'));
});

/* ── 控制器：喂假窗口，断言「该调的调了、不该调的没调」 ── */
function makeHarness(platform = 'win32') {
  const calls = { titles: [], overlays: [], flashes: [], trayTips: [], dockBadges: [], badgeCounts: [] };
  const win = {
    focused: false,
    visible: true,
    setTitle: (title) => calls.titles.push(title),
    setOverlayIcon: (image, description) => calls.overlays.push({ image, description }),
    flashFrame: (value) => calls.flashes.push(value),
    isFocused: () => win.focused,
    isVisible: () => win.visible,
    isDestroyed: () => false,
  };
  const tray = { setToolTip: (text) => calls.trayTips.push(text) };
  const app = {
    dock: { setBadge: (text) => calls.dockBadges.push(text) },
    setBadgeCount: (n) => calls.badgeCounts.push(n),
  };
  const nativeImage = {
    createFromBitmap: (buf, options) => ({ bytes: buf.length, options }),
  };
  const controller = attention.createAttentionController({
    app,
    nativeImage,
    getWindow: () => win,
    getTray: () => tray,
    platform,
    baseTitle: 'DevWork',
  });
  return { controller, calls, win };
}

check('控制器：标题与覆盖图标同时更新', () => {
  const { controller, calls } = makeHarness('win32');
  controller.apply({ count: 4, level: 'answer' });
  assert.deepStrictEqual(calls.titles, ['(4) DevWork']);
  assert.strictEqual(calls.overlays.length, 1);
  assert.strictEqual(calls.overlays[0].description, '4 张工单等你回答');
  assert.strictEqual(calls.overlays[0].image.bytes, attention.SIZE * attention.SIZE * 4);
  assert.strictEqual(calls.overlays[0].image.options.scaleFactor, 2);
});

check('控制器：清零时清掉覆盖图标，标题回到基准', () => {
  const { controller, calls } = makeHarness('win32');
  controller.apply({ count: 3, level: 'stuck' });
  controller.apply({ count: 0, level: 'stuck' });
  assert.strictEqual(calls.titles.at(-1), 'DevWork');
  assert.strictEqual(calls.overlays.at(-1).image, null);
  assert.strictEqual(calls.overlays.at(-1).description, '');
});

check('控制器：后台且数量上升才闪任务栏', () => {
  const { controller, calls, win } = makeHarness('win32');
  controller.apply({ count: 1, level: 'answer' });
  assert.deepStrictEqual(calls.flashes, [true], '首次出现应闪一次');
  controller.apply({ count: 1, level: 'answer' });
  assert.deepStrictEqual(calls.flashes, [true], '数量没变不该重复闪');
  controller.apply({ count: 2, level: 'answer' });
  assert.deepStrictEqual(calls.flashes, [true, true], '又多了该再闪');
  win.focused = true;
  controller.apply({ count: 3, level: 'answer' });
  assert.deepStrictEqual(calls.flashes, [true, true], '人在前台就不闪');
  win.focused = false;
  win.visible = false;
  controller.apply({ count: 4, level: 'answer' });
  assert.deepStrictEqual(calls.flashes, [true, true], '窗口不可见（收进托盘）不闪');
});

check('控制器：macOS 走 Dock 角标，不走覆盖图标', () => {
  const { controller, calls } = makeHarness('darwin');
  controller.apply({ count: 2, level: 'review' });
  assert.deepStrictEqual(calls.overlays, [], 'mac 没有 setOverlayIcon');
  assert.deepStrictEqual(calls.dockBadges, ['2']);
  controller.apply({ count: 0, level: 'review' });
  assert.strictEqual(calls.dockBadges.at(-1), '', '清零要清角标');
});

check('控制器：Linux 走启动器计数', () => {
  const { controller, calls } = makeHarness('linux');
  controller.apply({ count: 5, level: 'answer' });
  assert.deepStrictEqual(calls.badgeCounts, [5]);
});

check('控制器：托盘提示随状态更新，trayTip 可复原', () => {
  const { controller, calls } = makeHarness('win32');
  controller.apply({ count: 2, level: 'answer' });
  assert.ok(calls.trayTips.at(-1).includes('2 张工单等你回答'));
  /* 托盘被销毁后重建：新托盘要能取回当前状态，不能从「没有待办」开始说。 */
  assert.ok(controller.trayTip().includes('2 张工单等你回答'));
  controller.apply({ count: 0, level: 'review' });
  assert.ok(controller.trayTip().includes('后台任务继续运行'));
});

const failed = failures.length;
console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
