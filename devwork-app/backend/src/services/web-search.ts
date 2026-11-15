/**
 * WebSearch —— 外部检索，但**只在真的接了搜索后端时才执行**。
 *
 * 这条工具的存在有一半是为了"能拒绝"：这个仓库的禁止条款里有"不许编造数据"，
 * 而搜索是模型最容易凭空生成的地方（它会"记得"一个看起来很像的 URL）。
 * 所以这里的设计是：**没有配置就明确报错**，报错里直接给出替代路径，
 * 而不是返回一个空列表让它自由发挥。
 *
 * 配置（环境变量）：
 *   DEVWORK_SEARCH_URL  SearXNG 基址，例如 http://127.0.0.1:8888
 *   DEVWORK_SEARCH_KEY  可选；配置了就走 Authorization: Bearer
 *
 * 关于私网：web_fetch / browser 默认禁私网，是因为**模型可以指定目标地址**（SSRF 面）。
 * 这里的基址来自环境变量、模型只能给查询词，所以不过私网检查 —— 自建 SearXNG
 * 本来就在内网，套那层限制会让唯一的合法用法失效。
 */
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOutcome {
  ok: boolean;
  hits: SearchHit[];
  /** 结果来源说明（进了哪家的接口 / 为什么没成）。 */
  note: string;
}

/** 搜索后端是否就绪（`/api/health` 与工具描述都按这个口径说真话）。 */
export function searchBackend(): { configured: boolean; baseUrl: string } {
  const baseUrl = (process.env.DEVWORK_SEARCH_URL ?? '').trim().replace(/\/+$/, '');
  return { configured: /^https?:\/\//.test(baseUrl), baseUrl };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 尽量宽松地解析：SearXNG 用 content，其它常见实现用 snippet/description。 */
function pickHits(payload: unknown, limit: number): SearchHit[] {
  const list = (() => {
    if (Array.isArray((payload as { results?: unknown })?.results)) return (payload as { results: unknown[] }).results;
    if (Array.isArray((payload as { data?: unknown })?.data)) return (payload as { data: unknown[] }).data;
    if (Array.isArray(payload)) return payload as unknown[];
    return [];
  })();
  const hits: SearchHit[] = [];
  for (const item of list) {
    const row = item as Record<string, unknown>;
    const url = text(row.url) || text(row.link);
    if (!url) continue;
    hits.push({
      title: text(row.title) || '(无标题)',
      url,
      snippet: text(row.content) || text(row.snippet) || text(row.description),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export async function searchWeb(query: string, limit: number): Promise<SearchOutcome> {
  const backend = searchBackend();
  if (!backend.configured) {
    return {
      ok: false,
      hits: [],
      note: '外部搜索未接入：没有配置 DEVWORK_SEARCH_URL（SearXNG 兼容接口）。'
        + '不会返回编造的搜索结果。替代做法：已知文档地址时用 web_fetch 直接抓；'
        + '已知大致域名时用 browser(mode=navigate) 打开后 browser(mode=read) 读页。',
    };
  }
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, hits: [], note: 'query 参数为空。' };

  const url = new URL(`${backend.baseUrl}/search`);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'zh-CN');
  url.searchParams.set('safesearch', '1');

  const headers: Record<string, string> = { accept: 'application/json' };
  const key = (process.env.DEVWORK_SEARCH_KEY ?? '').trim();
  if (key) headers.authorization = `Bearer ${key}`;

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false, hits: [],
        note: `搜索后端返回 HTTP ${response.status}（${backend.baseUrl}）：${raw.slice(0, 200)}`,
      };
    }
    if (raw.length > MAX_RESPONSE_BYTES) {
      return { ok: false, hits: [], note: `搜索响应过大（${raw.length} 字节），已放弃解析。` };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return {
        ok: false, hits: [],
        note: `搜索后端返回的不是 JSON（可能未开启 format=json 或基址填错了）：${raw.slice(0, 120)}`,
      };
    }
    const hits = pickHits(payload, Math.min(Math.max(limit, 1), 10));
    if (hits.length === 0) {
      return { ok: true, hits: [], note: `检索「${trimmed}」命中 0 条（后端真实返回空结果，不是失败）。` };
    }
    return { ok: true, hits, note: `检索「${trimmed}」命中 ${hits.length} 条（来源：${backend.baseUrl}）。` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, hits: [], note: `搜索失败（真实错误）：${message}` };
  }
}
