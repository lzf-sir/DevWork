/**
 * 审计主体名归一化（纯函数，不依赖数据库）。
 *
 * 纯本地工具没有账号体系：审计 actor 由服务端固定写入「本机用户 / Agent」。
 * 这里只处理历史数据的编码问题 —— 早期版本可能把 UTF-8 字节按 latin1
 * 写进 audit_event.actor（显示为 'é»å¿è³' 之类乱码），启动时还原成中文。
 */

/** 无账号体系下的缺省审计主体名。 */
export const DEFAULT_USER_NAME = '本机用户';

/** 判断字符串是否只含可打印 ASCII（PDF/ByteString 安全）。 */
function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]+$/.test(value);
}

/**
 * 把历史 actor 值还原成可读中文：
 * - 纯 ASCII → 原样返回；
 * - latin1 mojibake → 按 UTF-8 还原；
 * - 已经是合法中文 → 原样返回。
 */
export function decodeHeaderName(raw: string): string {
  const value = String(raw ?? '').trim();
  if (value === '') return DEFAULT_USER_NAME;
  if (isPrintableAscii(value)) return value;
  try {
    const restored = Buffer.from(value, 'latin1').toString('utf8');
    if (!restored.includes('\uFFFD') && /[\u3400-\u9fff]/.test(restored)) return restored;
  } catch {
    /* 还原失败时保留原值 */
  }
  return value;
}

/** 任意来源的 actor 名 → 规范显示名（历史 mojibake 一并归一）。 */
export function canonicalActorName(actor: string): string {
  const raw = String(actor ?? '').trim();
  if (raw === '') return DEFAULT_USER_NAME;
  return decodeHeaderName(raw);
}
