/**
 * WebFetch —— 服务端抓取网页并转成可读正文。
 *
 * 为什么不能只靠内置浏览器：browser_read_page 的正文由**前端回传**，
 * 而前端只在一屏里的 Tab 打开且渲染完成后才回传。写代码/查文档这类
 * "顺手看一眼"的场景，模型等不来快照就只能靠猜——那是编造。
 *
 * SSRF 是本模块的第一风险：
 *   · 只放行 http/https（file:/data:/javascript: 直接拒）；
 *   · 默认拦私有网段（与内置浏览器同一套 normalizeBrowserUrl 规则）；
 *   · **重定向自己跟**，每一跳都重新校验——否则一个公网域名 302 到 127.0.0.1
 *     就能绕过第一跳的检查；fetch 自动 follow 恰恰会把这个洞埋起来。
 */
import { browserAllowPrivate } from '../config';
import { normalizeBrowserUrl } from './browser';

export interface WebFetchResult {
  url: string;
  title: string;
  text: string;
  contentType: string;
  bytes: number;
  truncated: boolean;
  /** 跟随过的重定向链（含起点），便于用户核对"我读的是哪一页"。 */
  redirects: string[];
}

const MAX_REDIRECTS = 3;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12000;

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'li', 'tr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol', 'br', 'hr', 'dd', 'dt',
]);

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', middot: '·', copy: '©', reg: '®', trade: '™',
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', divide: '÷',
  };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16) || 32))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10) || 32))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

/** HTML → 纯文本。不追求完美还原，只追求「正文能读、噪声不多」。 */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  let body = html
    /* script/style/noscript/svg/iframe 的内容不是正文，留着只会污染上下文。 */
    .replace(/<(script|style|noscript|svg|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/i, ' ');

  body = body.replace(/<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g, (_match, closing: string, tagName: string) => {
    const tag = tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'td' || tag === 'th') return '\t';
    if (BLOCK_TAGS.has(tag)) return '\n';
    if (closing === '') return '';
    return '';
  });

  const text = decodeEntities(body)
    .replace(/\r/g, '')
    /* 行内空白压成一个空格，行首缩进去掉；连续空行压成一行。 */
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

/** 带重定向校验的 GET：每一跳都要过 normalizeBrowserUrl。 */
async function fetchWithGuardedRedirects(startUrl: string): Promise<{ response: Response; finalUrl: string; chain: string[] }> {
  const chain: string[] = [];
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    chain.push(current);
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        /* 带 UA：不少站点对空 UA 直接返回 403，模型会因此得出"页面不可访问"的错误结论。 */
        'User-Agent': 'DevWork-Agent/1.0 (+local workspace assistant)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const next = normalizeBrowserUrl(new URL(location, current).toString(), { allowPrivate: browserAllowPrivate() });
      if (!next.ok || !next.url) {
        throw new Error(`重定向被拒（第 ${hop + 1} 跳）：${next.ok ? '地址无效' : next.reason}`);
      }
      current = next.url;
      continue;
    }
    return { response, finalUrl: current, chain };
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳，已中止（可能是重定向环）`);
}

/** 逐块读流并累计字节数：Content-Length 不可信，真正的上限要在读的时候守。 */
async function readCapped(response: Response): Promise<{ buffer: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const fallback = Buffer.from(await response.arrayBuffer());
    return { buffer: fallback, truncated: false };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > MAX_BYTES) {
      chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (total - MAX_BYTES))));
      await reader.cancel().catch(() => undefined);
      return { buffer: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), truncated: false };
}

export async function webFetch(rawUrl: string, options: { maxChars?: number } = {}): Promise<WebFetchResult> {
  const normalized = normalizeBrowserUrl(rawUrl, { allowPrivate: browserAllowPrivate() });
  if (!normalized.ok || !normalized.url) {
    throw new Error(normalized.ok ? '地址无法解析' : normalized.reason);
  }

  const { response, finalUrl, chain } = await fetchWithGuardedRedirects(normalized.url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim() + `（${finalUrl}）`);
  }

  const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
  const { buffer, truncated } = await readCapped(response);
  const raw = buffer.toString('utf8');

  const maxChars = Math.min(Math.max(Number(options.maxChars) || 20000, 500), 60000);
  let title = '';
  let text = '';

  const isHtml = contentType.includes('html') || (!contentType && /^\s*<(!doctype|html)/i.test(raw));
  if (isHtml) {
    const parsed = htmlToText(raw);
    title = parsed.title;
    text = parsed.text;
  } else if (contentType.includes('json') || contentType.startsWith('text/') || contentType === '') {
    /* JSON 原样给：格式化交给模型，不要在这里重排（重排会改掉它引用的原文）。 */
    text = raw;
  } else {
    throw new Error(`不支持的内容类型：${contentType || '未知'}（只处理 html / json / 纯文本）`);
  }

  const clipped = text.length > maxChars;
  return {
    url: finalUrl,
    title,
    text: clipped ? text.slice(0, maxChars) : text,
    contentType: contentType || '未知',
    bytes: buffer.length,
    truncated: truncated || clipped,
    redirects: chain,
  };
}
