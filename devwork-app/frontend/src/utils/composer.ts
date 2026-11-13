/**
 * 输入框触发符解析 —— @ 引用与 / 技能命令的纯函数层。
 *
 * 为什么单独抽出来：触发符识别（光标往前找 @ / ）、候选过滤、文本替换这几件事
 * 在浏览器里很难靠肉眼验证，而它们一旦错就是「输入框完全不能用」。
 * 这里保持零 DOM 依赖，tests/composer.mjs 直接打包本文件跑单测。
 *
 * 触发规则（与主流输入框一致）：
 *  - 触发符必须位于行首，或紧跟在空白 / 开括号之后 —— 否则 email、URL 路径里的
 *    @ 与 / 不会误触发；
 *  - 触发符与光标之间不允许出现空白 —— 用户一按空格就收起候选；
 *  - @ 与 / 同时存在时，取离光标更近的那个。
 */

export type TriggerKind = 'asset' | 'command';

export interface TriggerMatch {
  kind: TriggerKind;
  /** 触发符在整段文本中的起始下标。 */
  start: number;
  /** 光标下标（查询词的结束位置）。 */
  end: number;
  /** 已经输入的查询词（不含触发符本身）。 */
  query: string;
}

/** 候选条目：至少要有可展示的名字与可回填的 id。 */
export interface Candidate {
  id: string;
  label: string;
  /** 副标题（类型、路径、风险等级等），用于列表右侧的灰字。 */
  hint?: string;
}

/** 触发符前必须是行首或空白 / 开括号，否则 a@b.com 里的 @ 也会触发。 */
function isTriggerBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  return /[\s(（【「《]/.test(text[index - 1]);
}

/**
 * 从光标位置往前找触发符。
 * 找不到（或查询词里出现了空白）时返回 null，调用方据此收起候选浮层。
 */
export function detectTrigger(text: string, caret: number): TriggerMatch | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = text[i];
    /* 查询词里不允许空白：一按空格就收起候选（与 Slack / Notion 一致）。 */
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return null;
    if (ch !== '@' && ch !== '/') continue;
    /* 触发符不合规（比如邮箱里的 @）→ 继续往前找更早的触发符。 */
    if (!isTriggerBoundary(text, i)) continue;
    return {
      kind: ch === '@' ? 'asset' : 'command',
      start: i,
      end: pos,
      query: text.slice(i + 1, pos),
    };
  }
  return null;
}

/** 用候选内容替换 [start, end) 这段文本，返回新文本与新的光标位置。 */
export function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): { text: string; caret: number } {
  const next = text.slice(0, start) + replacement + text.slice(end);
  return { text: next, caret: start + replacement.length };
}

/** 候选过滤：按名称 / id / 副标题做不区分大小写的包含匹配。 */
export function filterCandidates<T extends Candidate>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.id.toLowerCase().includes(q) ||
      (item.hint ?? '').toLowerCase().includes(q),
  );
}

/**
 * 找出正文里 @名称 的出现位置。
 *
 * 为什么要看边界：资产名可能互为前缀（order 与 order-service），
 * 不看边界的话 "@order-service" 会同时命中 "order"，引用就串了。
 */
export function findMention(text: string, label: string): number {
  if (!label) return -1;
  const needle = `@${label}`;
  let index = text.indexOf(needle);
  while (index >= 0) {
    const next = text[index + needle.length] ?? '';
    if (!/[\w\-.]/.test(next)) return index;
    index = text.indexOf(needle, index + 1);
  }
  return -1;
}

/**
 * 从输入框文本里移除某个 @ 引用。
 * 点 chip 上的 × 时必须同步清掉正文，否则「chip 没了、文字还在」是最容易出现的假象。
 */
export function removeMention(text: string, label: string): string {
  const index = findMention(text, label);
  if (index < 0) return text;
  let end = index + label.length + 1;
  /* 顺带吃掉紧随其后的一个空格，避免留下多余空白。 */
  if (text[end] === ' ') end += 1;
  return text.slice(0, index) + text.slice(end);
}

/**
 * 解析正文里手写的 @ 引用 —— 不通过候选浮层、用户自己敲的 @生产库 也算数。
 * 返回命中的候选（顺序与候选表一致，避免同一资产重复）。
 */
export function collectMentions<T extends Candidate>(text: string, items: T[]): T[] {
  return items.filter((item) => findMention(text, item.label) >= 0);
}

/**
 * 保留仍然出现在正文里的引用 chip（用户手动删掉文字 → chip 也该消失）。
 */
export function syncMentions<T extends Candidate>(text: string, picked: T[]): T[] {
  return picked.filter((item) => findMention(text, item.label) >= 0);
}

/**
 * 解析本次发送真正要引用的资产 id。
 *
 * 两条来源：
 *  - 明确点选的 chip 一定算数（它带着真实 id，是用户的显式选择）；
 *  - 手写的 @名称 只在「名称唯一」时才自动解析 —— 库里可能存在两个同名资产
 *    （order_db 的 prod / dev 两套），光看名字根本判断不了指的是哪一个，
 *    与其猜一个不如不猜，最终以 chip 上的 id 为准。
 */
export function resolveAssetIds<T extends Candidate>(text: string, assets: T[], picked: T[]): string[] {
  const counts = new Map<string, number>();
  assets.forEach((asset) => counts.set(asset.label, (counts.get(asset.label) ?? 0) + 1));
  const ids = new Set<string>();
  picked.forEach((asset) => ids.add(asset.id));
  assets.forEach((asset) => {
    if ((counts.get(asset.label) ?? 0) === 1 && findMention(text, asset.label) >= 0) ids.add(asset.id);
  });
  return [...ids];
}
