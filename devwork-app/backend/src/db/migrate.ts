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
