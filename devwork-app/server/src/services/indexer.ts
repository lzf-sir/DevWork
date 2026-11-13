/**
 * 索引管线（B15）：真实扫描本地仓库 → 分块 → 写 index_chunk + FTS5 全文索引。
 * - 代码资产（type='code'）索引**该资产自己的本地克隆目录**下的文本文件，跳过 docs/ 前缀。
 * - 知识库资产（type='kb'）只索引其仓库根下的 docs/ 目录，kind='doc'。
 * - 仓库根由 assetId 解析（workspace-repos），不同工作区的仓库互不串味。
 * - 敏感文件（12 条 SENSITIVE_RULES + .git）一律跳过：不进索引也不进上下文。
 * - 检索走 SQLite FTS5 全文索引（BM25 rank），fts5 不可用时自动降级 LIKE。
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveRepoRoot } from './workspace-repos';
import { SENSITIVE_RULES } from '../config/rules';
import { all, get, run, newId } from '../db/database';

const CHUNK_MAX_LINES = 40;
/** 文档块更小：引用定位（locator）精确到行区间，块越大定位越糊。 */
const DOC_CHUNK_MAX_LINES = 16;
/** 知识库资产的文档根（相对仓库根）。 */
const DOC_PREFIX = 'docs/';
const TEXT_EXT = new Set(['.java', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.md', '.yml', '.yaml', '.xml', '.json', '.sql', '.css', '.html', '.txt']);

interface IndexedChunk {
  path: string;
  symbol: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
}

/**
 * 全文检索镜像表（FTS5 虚表）；已存在的业务库启动时补建（幂等）。
 * 旧版 SQLite 未编入 fts5 时这里会抛错，检索自动降级为 LIKE。
 */
export function ensureFtsTable(): void {
  try {
    run('CREATE VIRTUAL TABLE IF NOT EXISTS index_fts USING fts5(chunk_id UNINDEXED, content)');
  } catch {
    /* fts5 不可用：检索降级 LIKE */
  }
}

function ftsAvailable(): boolean {
  try {
    get<{ n: number }>('SELECT COUNT(*) AS n FROM index_fts');
    return true;
  } catch {
    return false;
  }
}

/** 命中 12 条敏感文件规则或 .git 目录的文件不进索引。 */
function isSensitive(rel: string): boolean {
  const normalized = rel.replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('.git/') || normalized === '.git') return true;
  return SENSITIVE_RULES.some((rule) => {
    const pattern = rule.pattern.toLowerCase();
    if (pattern.endsWith('/')) return normalized.startsWith(pattern) || normalized.includes(`/${pattern}`);
    if (pattern.startsWith('*')) return normalized.endsWith(pattern.slice(1));
    if (pattern.startsWith('.env')) return path.basename(normalized) === pattern || path.basename(normalized).startsWith(pattern);
    return normalized === pattern || normalized.endsWith(`/${pattern}`) || path.basename(normalized) === pattern;
  });
}

/** 从文件内容里提取主声明符号（class / interface / function / 顶层标题）。 */
function extractSymbol(content: string, fileName: string): string {
  const classMatch = content.match(/\b(?:class|interface|enum)\s+([A-Za-z_]\w*)/);
  if (classMatch) return classMatch[1];
  const fnMatch = content.match(/(?:function|def)\s+([A-Za-z_]\w*)/);
  if (fnMatch) return fnMatch[1];
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  return path.basename(fileName, path.extname(fileName));
}

/** 把文本按最大行数切块；块边界尽量落在空行/右花括号上。 */
function chunkLines(lines: string[], maxLines: number): Array<{ start: number; end: number; content: string }> {
  const chunks: Array<{ start: number; end: number; content: string }> = [];
  let start = 0;
  while (start < lines.length) {
    let end = Math.min(lines.length, start + maxLines);
    if (end < lines.length) {
      for (let i = end - 1; i > start + Math.floor(maxLines / 2); i -= 1) {
        const text = lines[i].trim();
        if (text === '' || text === '}' || text.endsWith('{')) {
          end = i + 1;
          break;
        }
      }
    }
    chunks.push({ start, end, content: lines.slice(start, end).join('\n') });
    start = end;
  }
  return chunks;
}

function walkFiles(dir: string, base: string, out: string[] = [], accept?: (rel: string) => boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.forEach((entry) => {
    const absolute = path.join(dir, entry.name);
    const rel = path.relative(base, absolute).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      walkFiles(absolute, base, out, accept);
      return;
    }
    if (!entry.isFile()) return;
    if (isSensitive(rel)) return;
    if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase())) return;
    if (accept && !accept(rel)) return;
    out.push(rel);
  });
  return out;
}

/** 清掉某资产的全部旧块（含 FTS 行），返回删除条数。 */
function clearAsset(assetId: string): number {
  const oldIds = (all<{ id: string }>('SELECT id FROM index_chunk WHERE asset_id = ?', assetId)).map((r) => r.id);
  run('DELETE FROM index_chunk WHERE asset_id = ?', assetId);
  for (const id of oldIds) {
    run('DELETE FROM index_fts WHERE chunk_id = ?', id);
  }
  return oldIds.length;
}

/** 单文件写块；返回写入的块数。 */
function indexFile(
  root: string,
  assetId: string,
  workspaceId: string,
  rel: string,
  kind: 'code' | 'doc',
  maxLines: number,
): number {
  const absolute = path.join(root, rel);
  let content: string;
  try {
    content = fs.readFileSync(absolute, 'utf8');
  } catch {
    return 0;
  }
  if (content.length > 512 * 1024) return 0; // 超大文件不索引
  const lines = content.split('\n');
  const symbol = extractSymbol(content, rel);
  let written = 0;
  const chunks = chunkLines(lines, maxLines);
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (!chunk.content.trim()) continue;
    const id = newId('ic');
    run(
      `INSERT INTO index_chunk (id,asset_id,workspace_id,kind,path,symbol,start_line,end_line,content,score)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, assetId, workspaceId, kind, rel, symbol,
      chunk.start + 1, chunk.end,
      chunk.content, Number((0.9 - index * 0.02).toFixed(2)),
    );
    try {
      run('INSERT INTO index_fts (chunk_id, content) VALUES (?,?)', id, chunk.content);
    } catch {
      /* FTS 建行失败不影响业务表 */
    }
    written += 1;
  }
  return written;
}

/** 重建代码资产索引：跳过 docs/（文档归知识库资产，避免同一片段被两个资产重复命中）。 */
export function runIndex(assetId: string, workspaceId = 'w-ops'): { chunks: number; files: number } {
  ensureFtsTable();
  let root: string;
  try {
    root = path.resolve(resolveRepoRoot(assetId));
  } catch {
    return { chunks: 0, files: 0 };
  }
  if (!fs.existsSync(root)) return { chunks: 0, files: 0 };

  clearAsset(assetId);
  const files = walkFiles(root, root, [], (rel) => !rel.startsWith(DOC_PREFIX));
  let chunkCount = 0;
  for (const rel of files) {
    chunkCount += indexFile(root, assetId, workspaceId, rel, 'code', CHUNK_MAX_LINES);
  }
  return { chunks: chunkCount, files: files.length };
}

/** 重建知识库资产索引：只扫 docs/，kind='doc'，块更小以便引用定位更精确。
 *  这是 P0「引用落点必须真实存在」的落地点：索引内容全部来自磁盘文件。 */
export function runDocIndex(assetId = 'a-kb', workspaceId = 'w-ops'): { chunks: number; files: number } {
  ensureFtsTable();
  let root: string;
  try {
    root = path.resolve(resolveRepoRoot(assetId));
  } catch {
    return { chunks: 0, files: 0 };
  }
  if (!fs.existsSync(root)) return { chunks: 0, files: 0 };

  clearAsset(assetId);
  const files = walkFiles(root, root, [], (rel) => rel.startsWith(DOC_PREFIX));
  let chunkCount = 0;
  for (const rel of files) {
    chunkCount += indexFile(root, assetId, workspaceId, rel, 'doc', DOC_CHUNK_MAX_LINES);
  }
  return { chunks: chunkCount, files: files.length };
}

/** 全文查询串：把用户输入切成词元，每个词元加引号防注入语法。
 *  FTS5 接受 `"词" OR "词"` 这种写法。 */
function ftsQuery(input: string): string {
  return input
    .split(/[\s,;.:()"'`]+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

export interface SearchHit {
  id: string;
  title: string;
  /** 可被前端"打开"直接消费的定位串：doc 为 path:起-止，code 为 path:行。 */
  locator: string;
  path: string;
  startLine: number;
  endLine: number;
  kind: 'code' | 'doc';
  score: number;
}

/** 统一生成 locator：文档给出行区间（与设计 §2.4 的 `docs/ops/metrics.md:40-42` 一致），
 *  代码给起始行（编辑器跳转到函数首行即可）。 */
function locatorOf(path: string, startLine: number, endLine: number, kind: string): string {
  return kind === 'doc' ? `${path}:${startLine}-${endLine}` : `${path}:${startLine}`;
}

function hitOf(row: Row): SearchHit {
  const kind = str(row.kind) === 'doc' ? 'doc' : 'code';
  const startLine = Number(row.start_line);
  const endLine = Number(row.end_line);
  const filePath = str(row.path);
  return {
    id: str(row.id),
    title: str(row.symbol) || filePath,
    locator: locatorOf(filePath, startLine, endLine, kind),
    path: filePath,
    startLine,
    endLine,
    kind,
    score: Number(row.score),
  };
}

/** 检索：全文 MATCH 与 LIKE 双路合并（全文命中排前），兼顾驼峰子串与分词命中。 */
export function searchAsset(assetId: string, query: string): SearchHit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  /* LIKE 也要按词元拆开：整句「OrderService 在哪个文件实现」作为一个子串必然不命中，
   * 但其中 OrderService 是能命中的关键词。词元级 OR 才不会让用户觉得"检索坏了"。 */
  const tokens = trimmed
    .split(/[\s,;.:()"'`，。？！、/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 4);
  const terms = tokens.length > 0 ? tokens : [trimmed];
  const likeClause = terms.map(() => '(content LIKE ? OR symbol LIKE ?)').join(' OR ');
  const likeParams = terms.flatMap((term) => [`%${term}%`, `%${term}%`]);
  const likeHits: SearchHit[] = (all<Row>(
    `SELECT id, symbol, path, start_line, end_line, kind, score FROM index_chunk
     WHERE asset_id = ? AND (${likeClause})
     ORDER BY score DESC LIMIT 10`,
    assetId, ...likeParams,
  )).map(hitOf);

  if (!ftsAvailable()) return likeHits;

  let ftsHits: SearchHit[] = [];
  try {
    const rows = all<Row>(
      `SELECT c.id, c.symbol, c.path, c.start_line, c.end_line, c.kind, f.rank AS rank
       FROM index_fts f JOIN index_chunk c ON c.id = f.chunk_id
       WHERE index_fts MATCH ? AND c.asset_id = ?
       ORDER BY rank LIMIT 10`,
      ftsQuery(trimmed), assetId,
    );
    /* FTS5 rank ≤ 0 且越小越相关；归一成 0~0.98 的分数。 */
    ftsHits = rows.map((row) => ({
      ...hitOf(row),
      score: Number((1 / (1 + Math.abs(Number(row.rank ?? 1)))).toFixed(2)),
    }));
  } catch {
    /* MATCH 语法异常（如纯符号输入）忽略，走 LIKE */
  }

  const merged: SearchHit[] = [];
  const seen = new Set<string>();
  for (const hit of [...ftsHits, ...likeHits]) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    merged.push(hit);
  }
  return merged.slice(0, 10);
}

/** 按 chunk id 取源片段（引用浮层展示原文用）。 */
export function chunkById(id: string): { content: string; path: string; kind: string; startLine: number; endLine: number } | null {
  const row = get<Row>('SELECT content, path, kind, start_line, end_line FROM index_chunk WHERE id = ?', id);
  if (!row) return null;
  return {
    content: str(row.content),
    path: str(row.path),
    kind: str(row.kind),
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
  };
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

type Row = Record<string, unknown>;
