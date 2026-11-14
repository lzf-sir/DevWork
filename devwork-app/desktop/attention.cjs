/**
 * 待人状态 → 窗口标题 / 任务栏徽标 / 托盘提示。
 *
 * 为什么要有这个模块：`main.cjs` 里混着 Electron 生命周期，放进去就只能靠
 * 「起整个壳、人眼看一眼」来验证。徽标长什么样、标题怎么写，全是纯函数，
 * 抽出来可以直接喂参数、取像素、跑断言。
 *
 * 三档颜色不是装饰，是三种不同的急：
 *   answer 红 —— Agent 张着嘴等一句话，整条任务停着；
 *   stuck  橙 —— 它撞墙了，等的是人的判断；
 *   review 蓝 —— 做完了等验收，不阻塞任何东西。
 *
 * 数字只画 1~9，"9+" 之后的信息量交给标题与 tooltip：
 * 16px 的图标上，两位数已经糊成一团了。
 */

'use strict';

/** 图标画布 32×32（按 scaleFactor=2 报给系统 → 16 逻辑像素，高分屏不糊）。 */
const SIZE = 32;
/** 圆半径：留 1px 边，16px 缩放下边缘不会被裁。 */
const RADIUS = 15;

/** 三档颜色的 RGB。与 styles.css 的 --danger / --warning / --accent 取值一致。 */
const LEVEL_COLOR = {
  answer: [220, 38, 38],
  stuck: [217, 119, 6],
  review: [47, 108, 229],
};

/** 等级归一：只认三档，其余一律按 review（宁可少喊急，也不要虚报急）。 */
function normalizeLevel(level) {
  return Object.prototype.hasOwnProperty.call(LEVEL_COLOR, level) ? level : 'review';
}

/**
 * 生成 32×32 的 BGRA 位图（Electron `nativeImage.createFromBitmap` 在 Windows 上要的格式）。
 *
 * 只画点、不画数字 —— 这是量出来的结论，不是省事：
 * 任务栏覆盖图标实际只有 16×16，3×5 点阵再缩一半，"4" 会糊成一个既不像 4
 * 也不像别的什么的白色色块。**看着像错字，比不写字更糟。**
 * 精确数量交给窗口标题（`(4) DevWork`，系统矢量字）和悬浮说明（读屏也能读到），
 * 图标只负责一件事：用颜色说"现在有事，而且有多急"。
 *
 * 顺序是 B、G、R、A —— 写反了会得到一个蓝色的"红点"，而且不会报错，
 * 所以像素断言必须按通道分别校验。
 */
function buildBadgeBitmap(level) {
  const [r, g, b] = LEVEL_COLOR[normalizeLevel(level)];
  const buf = Buffer.alloc(SIZE * SIZE * 4, 0);
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      /* 边缘 1px 做覆盖率过渡：硬切边在圆上会看到锯齿，尤其在 150% 缩放下。 */
      const coverage = Math.max(0, Math.min(1, RADIUS - dist + 0.5));
      if (coverage <= 0) continue;
      const offset = (y * SIZE + x) * 4;
      buf[offset] = b;
      buf[offset + 1] = g;
      buf[offset + 2] = r;
      buf[offset + 3] = Math.round(coverage * 255);
    }
  }

  return buf;
}

/**
 * 窗口标题：`(4) DevWork`。
 *
 * 数字放最前是因为任务栏与 Alt+Tab 会把标题从右边截断 ——
 * 写成 `DevWork (4)` 时，窗口一窄，先消失的正好是要紧的那个数字。
 */
function windowTitle(count, base = 'DevWork') {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  return n > 0 ? `(${n}) ${base}` : base;
}

/** 任务栏悬浮 / 读屏用的说明文案。空串表示"没有事"。 */
function overlayDescription(count, level) {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (n <= 0) return '';
  const label = { answer: '等你回答', stuck: '受阻待决', review: '待你验收' }[normalizeLevel(level)];
  return n > 1 ? `${n} 张工单${label}` : `1 张工单${label}`;
}

/** 托盘提示：窗口收进托盘之后，这是唯一还看得见的一行字。 */
function trayTooltip(count, level, base = 'DevWork') {
  const n = Math.max(0, Math.trunc(Number(count) || 0));
  if (n <= 0) return `${base} · 已最小化到托盘，后台任务继续运行`;
  return `${base} · ${overlayDescription(n, level)}`;
}

/**
 * 把待人状态落到「窗口之外」的控制器。
 *
 * 抽成控制器（而不是散在 main.cjs 里）的理由很实际：这段代码的每一行都是
 * 副作用调用（setTitle / setOverlayIcon / setBadge / flashFrame），
 * 塞在生命周期代码里就只能靠「起整个壳、人眼看一眼」来验证。
 * 这里只依赖注入进来的几个句柄，喂假窗口就能断言「该调的调了、不该调的没调」。
 *
 * 三端各用各的原生能力，不强求统一：
 *   Windows —— 任务栏覆盖图标（带数字的点）+ 标题前缀；
 *   macOS   —— Dock 角标（原生数字）；
 *   Linux   —— Unity 启动器计数（不支持的桌面环境会静默忽略）。
 * 托盘提示三端都有，是窗口收起来之后唯一还看得见的一行字。
 */
function createAttentionController(deps) {
  const {
    app,
    nativeImage,
    getWindow = () => null,
    getTray = () => null,
    platform = process.platform,
    baseTitle = 'DevWork',
  } = deps;
  let state = { count: 0, level: 'review' };

  /** 当前状态（窗口重建 / 托盘重建时用来复原）。 */
  function current() {
    return { ...state };
  }

  function apply(payload) {
    const count = Math.max(0, Math.min(999, Math.trunc(Number(payload && payload.count) || 0)));
    const level = normalizeLevel(payload && payload.level);
    const previous = state.count;
    state = { count, level };

    const win = getWindow();
    if (win) {
      /* 数字放最前：任务栏与 Alt+Tab 从右边截断，`DevWork (4)` 先丢的正好是要紧的数字。 */
      win.setTitle(windowTitle(count, baseTitle));
      if (platform === 'win32') {
        const image = count > 0
          ? nativeImage.createFromBitmap(buildBadgeBitmap(level), {
              width: SIZE,
              height: SIZE,
              /* 32px 画布按 2 倍上报 → 16 逻辑像素：高分屏不糊、100% 下不超框。 */
              scaleFactor: 2,
            })
          : null;
        win.setOverlayIcon(image, overlayDescription(count, level));
      }

      /* 只在「变多」时闪：每次轮询都闪等于没闪，人会把它当噪音而不是信号。
       * 窗口已经在前台就没有必要闪，人正看着呢。 */
      if (platform === 'win32' && count > previous) {
        const focused = typeof win.isFocused === 'function' ? win.isFocused() : false;
        const visible = typeof win.isVisible === 'function' ? win.isVisible() : true;
        if (!focused && visible) win.flashFrame(true);
      }
    }

    if (platform === 'darwin' && app && app.dock) {
      try { app.dock.setBadge(count > 0 ? String(count) : ''); } catch { /* 非 mac 环境 */ }
    }
    if (platform === 'linux' && app && typeof app.setBadgeCount === 'function') {
      try { app.setBadgeCount(count); } catch { /* 桌面环境不支持 */ }
    }

    const tray = getTray();
    if (tray && typeof tray.setToolTip === 'function') {
      tray.setToolTip(trayTooltip(count, level, baseTitle));
    }

    return current();
  }

  /** 托盘创建时取当前提示文案（新托盘不该从「没有待办」开始说）。 */
  function trayTip() {
    return trayTooltip(state.count, state.level, baseTitle);
  }

  return { apply, current, trayTip };
}

module.exports = {
  SIZE,
  LEVEL_COLOR,
  normalizeLevel,
  buildBadgeBitmap,
  windowTitle,
  overlayDescription,
  trayTooltip,
  createAttentionController,
};
