/**
 * 引用表一次性整理（启动时执行，幂等）。
 *
 * 背景：早期版本用模板字符串生成 citation（locator 形如 `docs/ops/metrics.md:40-42`），
 * 但磁盘上没有对应文件，引用浮层「打开」只能弹假提示。现在引用由索引器按真实
 * chunk 生成，历史行需要就地整理：
 *   ① 有 path 的：按 locator 补齐行区间；
 *   ② 无 path 但 locator 能解析出「仓库内真实存在的文件」的：补上 path 与行区间；
 *   ③ 两者都不成立的：删除——指向不存在位置的引用，比没有引用更糟。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../sandbox/bootstrap';
import { all, run } from './database';

const LOCATOR = /^(.+?):(\d+)(?:-(\d+))?$/;

/**
 * 清理 source.read_position 里被写坏的位点（启动时执行，幂等）。
 *
 * 背景：ingestTrigger 曾把幂等键（如 `term:src-terminal:xxx`）写进
 * read_position，而那一列本该存**采集器位点**（字节偏移 / git HEAD / 时间戳）。
 * 两者共用一列的后果：
 *   · log 采集器 `Number('log:src-log:12')` → NaN → 位点归零 → 每轮从头重扫；
 *   · terminal / sql 采集器 `created_at > 'term:src-terminal:xxx'` → 恒不成立
 *     → 永远采集不到新行；
 *   · git 采集器拿幂等键和 HEAD 比 → 恒不相等 → 每轮都误报「有新提交」。
 *
 * 现在 ingestTrigger 不再写这一列，但历史库里已经被污染的值要清掉：
 * 位点只可能是「数字」「40 位 hex」「ISO 时间戳」三种形态，其余一律归零。
 * 归零的代价是首轮重扫一次 —— 幂等键保证不会重复建单。
 */
const POSITION_PATTERNS = {
  log: /^\d+$/,                    // 字节偏移
  git: /^[0-9a-f]{7,40}$/i,        // git HEAD
  terminal: /^\d{4}-\d{2}-\d{2}T/, // ISO 时间戳
  sql: /^\d{4}-\d{2}-\d{2}T/,      // ISO 时间戳
};

export function migrateSourceReadPosition(): { fixed: number } {
  const rows = all<{ id: string; kind: string; read_position: string }>(
    'SELECT id, kind, read_position FROM source',
  );
  let fixed = 0;
  for (const row of rows) {
    const position = String(row.read_position ?? '');
    if (position === '') continue;
    const pattern = POSITION_PATTERNS[row.kind as keyof typeof POSITION_PATTERNS];
    /* 没有位点语义的源（user / schedule / ci）本就不该有值。 */
    if (pattern && pattern.test(position)) continue;
    run('UPDATE source SET read_position = ? WHERE id = ?', '', String(row.id));
    fixed += 1;
  }
  return { fixed };
}

export function migrateCitations(): { fixed: number; removed: number } {
  const rows = all<{ id: string; locator: string; path: string | null; start_line: number | null; end_line: number | null }>(
    'SELECT id, locator, path, start_line, end_line FROM citation',
  );
  let fixed = 0;
  let removed = 0;

  /* 原来是 rows.forEach：回调里要 写库，forEach 不等待会变成发射后不管，改 for...of。 */
  for (const row of rows) {
    const match = LOCATOR.exec(String(row.locator ?? ''));
    const rel = match ? match[1] : String(row.path ?? '');
    const start = match ? Number(match[2]) : Number(row.start_line ?? 0);
    const end = match && match[3] ? Number(match[3]) : start;
    const exists = rel !== '' && fs.existsSync(path.join(REPO_ROOT, rel));

    if (exists && (row.path === null || row.start_line === null)) {
      run(
        'UPDATE citation SET path = ?, start_line = ?, end_line = ? WHERE id = ?',
        rel, start, end, row.id,
      );
      fixed += 1;
      continue;
    }
    if (exists) continue;
    run('DELETE FROM citation WHERE id = ?', row.id);
    removed += 1;
  }

  return { fixed, removed };
}
