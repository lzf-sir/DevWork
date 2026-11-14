/**
 * 影子中心的公共标签与格式化。
 *
 * 抽出来的理由不是「复用」，而是**口径唯一**：
 * 同一个原因码如果账本里写「机器人不在列表」、详情里写「机器人未授权」，
 * 人就会以为是两件事。
 */
import type { ShadowMandate, ShadowPolicy } from '../../api/client';

export const SOURCE_LABEL: Record<string, string> = {
  user: '人工请求',
  terminal: '终端',
  git: '仓库变更',
  sql: '慢查询',
  log: '日志异常',
  schedule: '定时巡检',
  ci: '流水线',
};

/** 原因码 → 人话。表里没有的原样显示，避免「新加的码在界面上消失」。 */
export const REASON_LABEL: Record<string, string> = {
  E_EXPLICIT_REQUEST: '明确请求',
  E_LISTED_FOLLOWUP: '白名单跟进',
  E_BOT_INFERRED: '机器人候选',
  E_SYSTEM_INFERRED: '系统事件',
  E_UNLISTED_ADDRESSED: '不在白名单·已点名',
  E_UNLISTED_UNADDRESSED: '不在白名单·未点名',
  E_BOT_NOT_ALLOWED: '机器人不在列表',
  E_SOURCE_DISABLED: '源未启用',
  E_EMPTY_TRIGGER: '空事件',
  E_THREAD_RATE_LIMIT: '同线程频控',
  E_MODE_OFF: '准入模式 off',
};

export const STAGE_LABEL: Record<string, string> = {
  grant: '待授权',
  queued: '排队中',
  working: '执行中',
  idle: '等新事件',
  'person/answer': '等你回答',
  'person/review': '待你验收',
  'person/blocked': '受阻',
  'person/failed': '失败',
};

/** 待人 = 红色系；在跑 = 蓝色系；其余中性。一屏之内先看见「要我做什么」。 */
export function stageClass(stage: string): string {
  if (stage.startsWith('person/')) return stage === 'person/review' ? 'ex' : 'bad';
  if (stage === 'working') return 'ex';
  return '';
}

/** 「这张单在等一个人」—— 用于徽标与排序，判定只此一处。 */
export function isWaitingHuman(stage: string): boolean {
  return stage.startsWith('person/');
}

export const MANDATE_STATUS: Record<ShadowMandate['status'], string> = {
  draft: '待表态',
  accepted: '已认可',
  narrowed: '已收窄',
  rejected: '已否决',
};

export const MODES: { value: ShadowPolicy['acceptMode']; label: string; hint: string }[] = [
  { value: 'off', label: 'off', hint: '自动化事件一律不接，只有明确请求进研判' },
  { value: 'observe', label: 'observe', hint: '研判并记录「本来会接」，只产出草案，不动手（默认）' },
  { value: 'auto', label: 'auto', hint: '命中规则即签发授权并建单；只读自动签，写权限仍需人批' },
];

export function timeOf(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 带日期的短时间：跨天的事件只看 HH:MM 会误导。 */
export function dateTimeOf(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour12: false });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/** 时长：秒级给「N 秒」，分钟级给「N 分」，小时级给「N 小时 M 分」。 */
export function durationOf(ms: number): string {
  if (!ms || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

export function tokensOf(value: number): string {
  if (!value) return '0';
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

/** 定时巡检的预设：不给 cron 表达式，因为没人会在一个桌面弹窗里写 cron。 */
export const SCHEDULE_PRESETS = [
  { value: 'daily:09:30', label: '每天 09:30', config: { schedule: 'daily' as const, at: '09:30' } },
  { value: 'daily:18:00', label: '每天 18:00', config: { schedule: 'daily' as const, at: '18:00' } },
  { value: 'interval:60', label: '每 1 小时', config: { schedule: 'interval' as const, everyMinutes: 60 } },
  { value: 'interval:360', label: '每 6 小时', config: { schedule: 'interval' as const, everyMinutes: 360 } },
];

/** 下次到点：说「今天 / 明天 HH:MM」比裸 ISO 好读，且一眼知道距现在多远。 */
export function formatWhen(iso: string): string {
  if (!iso) return '未排期';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = new Date();
  const time = date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `明天 ${time}`;
  return `${date.getMonth() + 1}-${date.getDate()} ${time}`;
}

export function clip(text: string, max = 64): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
