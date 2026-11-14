/**
 * 「待人」这件事的措辞，只在这里写一次。
 *
 * 为什么值得单独一个文件：同一份 `waiting` 清单现在同时喂给侧栏徽标、
 * 会话 tab 橙点、窗口标题 / 任务栏徽标、协作流。四处各写一遍判断，
 * 迟早会出现「侧栏是红的、任务栏是蓝的」——而人对这种不一致的容忍度是零：
 * 一旦发现两个地方对同一件事说法不同，就再也不信其中任何一个。
 */
import type { WaitingTicket } from '../api/types';

/** 三档紧急度。顺序即优先级，比较大小没有意义，别当枚举用。 */
export type WaitingLevel = 'answer' | 'stuck' | 'review';

/**
 * 清单里最急的那一档。
 *
 * 归到三档而不是原样透出四个 stage：`person/failed` 与 `person/blocked`
 * 对「人现在该做什么」的答案是一样的（去做判断），涂成两种颜色只是噪声。
 */
export function waitingLevel(items: WaitingTicket[]): WaitingLevel {
  if (items.some((item) => item.stage === 'person/answer')) return 'answer';
  if (items.some((item) => item.stage === 'person/blocked' || item.stage === 'person/failed')) {
    return 'stuck';
  }
  return 'review';
}

/** 「等你回答」/「4 张工单等你处理」—— 窗口标题、tab tooltip 都用这一句。 */
export function waitingBrief(items: WaitingTicket[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0].waitingFor;
  return `${items.length} 张工单等你处理`;
}

/**
 * 徽标 tooltip：数量 + 分布。
 *
 * 只给数字不够：点进去之前人想知道「这次是要回答、要验收，还是要救火」。
 * 按 waitingFor 聚合而不是按 stage —— 同一句话在界面上只能有一种说法。
 */
export function waitingTip(items: WaitingTicket[]): string {
  if (items.length === 0) return '';
  const detail = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.waitingFor] = (acc[item.waitingFor] ?? 0) + 1;
    return acc;
  }, {});
  const parts = Object.entries(detail).map(([label, count]) => `${count} 个${label}`);
  return `${items.length} 张工单等你处理\n${parts.join(' · ')}`;
}

/** 9 以上的徽标统一写 "9+"：16px 的圆形装不下两位数。 */
export function waitingBadgeText(items: WaitingTicket[]): string {
  return items.length > 9 ? '9+' : String(items.length);
}
