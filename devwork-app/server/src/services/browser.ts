/**
 * 内置浏览器 —— 会话级状态与地址规范化。
 *
 * 为什么要有服务端这份状态：
 * 「Agent 能控制浏览器」不能只是文案。要真控制，双方得有一份**都认**的当前地址：
 *   - Agent 调 browser_navigate → 写这里（by=agent）；
 *   - 用户在右栏浏览器 Tab 里点链接 → 前端把新地址同步回来（by=user）；
 *   - 前端浏览器 Tab 轮询这里，地址变了就跳。
 *
 * 地址安全：
 *   - 只放行 http/https（file: / javascript: / data: 一律拒绝）；
 *   - Agent 驱动时禁私有网段（localhost / 内网 IP）——Agent 不该借浏览器
 *     探测本机与内网服务，那是 SSRF 的经典入口；用户手动导航不受此限。
 */
import { get, nowIso, run } from '../db/database';

export type BrowserDriver = 'agent' | 'user' | 'none';

export interface BrowserState {
  url: string;
  by: BrowserDriver;
  updatedAt: string;
}

/** 私有 / 回环网段：Agent 导航禁入，用户导航放行。 */
const PRIVATE_HOST = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\]|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|\.local|\.internal)$/i;

export interface NormalizeResult {
  ok: boolean;
  url?: string;
  reason?: string;
}

/**
 * 规范化浏览器地址。
 *
 * @param raw 原始输入（可以不带 scheme，缺省补 https://）
 * @param allowPrivate 是否放行私有网段（用户手动导航为 true，Agent 为 false）
 */
export function normalizeBrowserUrl(raw: unknown, options: { allowPrivate?: boolean } = {}): NormalizeResult {
  const allowPrivate = options.allowPrivate === true;
  if (typeof raw !== 'string') return { ok: false, reason: '地址必须是字符串' };
  const text = raw.trim();
  if (!text) return { ok: false, reason: '地址为空' };
  if (text.length > 2000) return { ok: false, reason: '地址过长（上限 2000 字符）' };

  /* 只放行 http/https：file: 会读本机文件，javascript: 会执行脚本。 */
  if (/^(file|javascript|data|blob|about|chrome|devtools):/i.test(text)) {
    return { ok: false, reason: '只允许 http/https 地址' };
  }
  /* 缺 scheme 时按浏览器的老习惯补：回环地址用 http（本机服务多是 http），
   * 其余用 https（避免明文传输）。 */
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  const loopback = !hasScheme && /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)(:\d+)?([/?#].*)?$/i.test(text);
  const candidate = hasScheme ? text : `${loopback ? 'http' : 'https'}://${text}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, reason: '地址无法解析' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: '只允许 http/https 地址' };
  }
  if (!allowPrivate && PRIVATE_HOST.test(parsed.hostname)) {
    return { ok: false, reason: 'Agent 导航不允许指向本机或内网地址（私有网段已拦截）' };
  }
  return { ok: true, url: parsed.toString() };
}

/** 读会话的浏览器状态（没有记录时如实返回空地址）。 */
export function readBrowserState(conversationId: string): BrowserState {
  const row = get<{ url: string; updated_by: string; updated_at: string }>(
    'SELECT url, updated_by, updated_at FROM browser_state WHERE conversation_id = ?',
    conversationId,
  );
  return {
    url: String(row?.url ?? ''),
    by: (row?.updated_by as BrowserDriver) ?? 'none',
    updatedAt: String(row?.updated_at ?? ''),
  };
}

/** 写会话的浏览器状态（upsert，SQLite 用 ON CONFLICT DO UPDATE）。 */
export function writeBrowserState(conversationId: string, url: string, by: BrowserDriver): BrowserState {
  const updatedAt = nowIso();
  run(
    `INSERT INTO browser_state (conversation_id, url, updated_by, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(conversation_id) DO UPDATE SET url = excluded.url, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    conversationId,
    url,
    by,
    updatedAt,
  );
  return { url, by, updatedAt };
}

/**
 * 页面快照：前端把当前页标题与正文回传，Agent 的 browser_read_page 读它。
 *
 * 上限 8000 字符：够回答"这页在说什么"，又不至于把整站塞进上下文预算。
 */
export interface BrowserPage {
  title: string;
  text: string;
  capturedAt: string;
  url: string;
}

const PAGE_TEXT_LIMIT = 8000;

export function writeBrowserPage(conversationId: string, title: string, text: string): BrowserPage {
  const capturedAt = nowIso();
  const clipped = text.length > PAGE_TEXT_LIMIT ? `${text.slice(0, PAGE_TEXT_LIMIT)}…（已截断）` : text;
  run(
    `INSERT INTO browser_state (conversation_id, url, updated_by, updated_at, page_title, page_text, page_captured_at)
     VALUES (?, '', 'none', '', ?, ?, ?)
     ON CONFLICT(conversation_id) DO UPDATE SET page_title = excluded.page_title,
       page_text = excluded.page_text, page_captured_at = excluded.page_captured_at`,
    conversationId,
    title.slice(0, 300),
    clipped,
    capturedAt,
  );
  const state = readBrowserState(conversationId);
  return { title: title.slice(0, 300), text: clipped, capturedAt, url: state.url };
}

export function readBrowserPage(conversationId: string): BrowserPage {
  const row = get<{ page_title: string; page_text: string; page_captured_at: string }>(
    'SELECT page_title, page_text, page_captured_at FROM browser_state WHERE conversation_id = ?',
    conversationId,
  );
  const state = readBrowserState(conversationId);
  return {
    title: String(row?.page_title ?? ''),
    text: String(row?.page_text ?? ''),
    capturedAt: String(row?.page_captured_at ?? ''),
    url: state.url,
  };
}
