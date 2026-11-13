/**
 * look 设置（l2 界面字号 / l3 代码字体 / l4 左栏密度）的真实生效层。
 *
 * 此前这三项保存到 setting.look 后无任何消费 —— "保存了却没作用"比没有这个设置更伤信任。
 * 生效方式：
 * - 字号：根节点 zoom（Chromium/Electron 全局缩放，三档 0.92 / 1 / 1.08）；
 * - 代码字体：写 CSS 变量 --mono（编辑器 / 终端 / 代码块统一走该变量）；
 * - 密度：html[data-density]，styles.css 据此压缩左栏行高。
 */

export interface LookSettings {
  fontSize?: string;
  monoFont?: string;
  density?: string;
}

const ZOOM_BY_LABEL: Record<string, number> = {
  '较小 13px': 0.92,
  '标准 14px': 1,
  '较大 15px': 1.08,
};

const MONO_BY_LABEL: Record<string, string> = {
  'JetBrains Mono': '"JetBrains Mono", "Cascadia Code", ui-monospace, Consolas, monospace',
  'SF Mono': '"SF Mono", "Cascadia Code", ui-monospace, Menlo, monospace',
  Consolas: 'Consolas, "Courier New", ui-monospace, monospace',
};

/** 从设置页 select 的显示值解析 zoom；未知值不改动。 */
export function applyLookSettings(look: LookSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (look.fontSize && ZOOM_BY_LABEL[look.fontSize] !== undefined) {
    root.style.zoom = String(ZOOM_BY_LABEL[look.fontSize]);
  }
  if (look.monoFont && MONO_BY_LABEL[look.monoFont] !== undefined) {
    root.style.setProperty('--mono', MONO_BY_LABEL[look.monoFont]);
  }
  if (look.density === '紧凑' || look.density === '标准') {
    root.dataset.density = look.density === '紧凑' ? 'compact' : 'standard';
  }
}

/** 供「外观」分区保存后立即调用：把三行 select 的当前值应用到 DOM。 */
export function applyLookRows(values: { l2?: string; l3?: string; l4?: string }): void {
  applyLookSettings({
    fontSize: values.l2,
    monoFont: values.l3,
    density: values.l4,
  });
}
