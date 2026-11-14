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
import { APP_VERSION } from '../config/version';
import { all, get, markMigrationDone, migrationDone, run } from './database';

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

const POSITION_MIGRATION = 'migrateSourceReadPosition@1';
const CITATION_MIGRATION = 'migrateCitations@1';
const PERM_SCOPE_MIGRATION = 'migratePermScopeMemory@1';

/**
 * 审批档位（`setting.perm.p2`）的取值是**中文文案**，不是稳定 ID。
 *
 * 这是既有实现的事实：`kernel/permission.ts` 里 `String(perm.p2 ?? '按风险分级')`
 * 直接与「每次询问」比较，设置页 `select` 的 options 也是这两句中文。
 * 所以下面的字面量必须与前端选项、内核判定三处完全一致；任何一处改文案都要同步。
 */
const PERM_SCOPE_BY_RISK = '按风险分级';
/** 早期版本的第三个档位：本会话内记住。内核从未实现过记忆存储，选它等于选按风险分级。 */
const PERM_SCOPE_LEGACY_MEMORY = '本会话内记住';

/**
 * 把历史档位「本会话内记住」一次性归一为「按风险分级」（幂等）。
 *
 * 为什么必须迁移而不是留着兼容：内核只判 `=== '每次询问'`，其余值一律当
 * 「按风险分级」处理 —— 也就是说「本会话内记住」**从来没有过记忆行为**。
 * 设置页若还展示这个选项，用户会以为自己选了一个有记忆的档位，实际没有；
 * 迁移成真实生效的文案，是把「界面承诺」与「内核行为」对齐。
 */
export function migratePermScopeMemory(): { changed: boolean; skipped: boolean } {
  if (migrationDone(PERM_SCOPE_MIGRATION)) {
    // eslint-disable-next-line no-console
    console.log('[DevWork] 审批档位整理：迁移已完成，跳过');
    return { changed: false, skipped: true };
  }
  const row = get<{ raw: string }>(`SELECT raw FROM setting WHERE section = 'perm'`);
  /* perm 段不存在（首启 seed 尚未写入 / 用户删过）：不标记完成，下次启动再判一次。
   * 标记过早会让真正的老库永远得不到迁移 —— 宁可多跑一次空转。 */
  if (!row) return { changed: false, skipped: true };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(row.raw)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { changed: false, skipped: true };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    /* 坏 JSON 不动它：这里只负责档位归一，重建整段设置是 seed 的职责。 */
    return { changed: false, skipped: true };
  }
  if (String(raw.p2 ?? '') !== PERM_SCOPE_LEGACY_MEMORY) {
    markMigrationDone(PERM_SCOPE_MIGRATION);
    return { changed: false, skipped: false };
  }
  run(
    'UPDATE setting SET raw = ? WHERE section = ?',
    JSON.stringify({ ...raw, p2: PERM_SCOPE_BY_RISK }), 'perm',
  );
  markMigrationDone(PERM_SCOPE_MIGRATION);
  return { changed: true, skipped: false };
}

export function migrateSourceReadPosition(): { fixed: number; skipped: boolean } {
  if (migrationDone(POSITION_MIGRATION)) {
    // eslint-disable-next-line no-console
    console.log('[DevWork] 采集器位点整理：迁移已完成，跳过');
    return { fixed: 0, skipped: true };
  }
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
  markMigrationDone(POSITION_MIGRATION);
  return { fixed, skipped: false };
}

export function migrateCitations(): { fixed: number; removed: number; skipped: boolean } {
  if (migrationDone(CITATION_MIGRATION)) {
    // eslint-disable-next-line no-console
    console.log('[DevWork] 引用整理：迁移已完成，跳过');
    return { fixed: 0, removed: 0, skipped: true };
  }
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

  markMigrationDone(CITATION_MIGRATION);
  return { fixed, removed, skipped: false };
}

/**
 * 把 `setting.about.version` 覆盖成当前版本（启动时执行，幂等）。
 *
 * 为什么必须有这一步：`about` 段只在**首启** seed 时写入，`seedIfEmpty` 对已有库
 * 直接返回。于是老库升级到 1.0.0 后，「关于 / 检查更新」永远显示旧版本号 ——
 * 用户看到的是一个问不出出处的数字。这里只改 version 字段，
 * channel / build 等用户可见配置原样保留。
 */
export function migrateAboutVersion(): { changed: boolean; version: string } {
  const row = get<{ raw: string }>(`SELECT raw FROM setting WHERE section = 'about'`);
  /* about 不存在（干净模式首启前 / 用户删过设置）就跳过：seed 会写正确的版本。 */
  if (!row) return { changed: false, version: APP_VERSION };
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(row.raw)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { changed: false, version: APP_VERSION };
    }
    raw = parsed as Record<string, unknown>;
  } catch {
    /* 坏 JSON 不当成迁移失败：直接重写成最小集合，比留一段读不出的设置更诚实。 */
    raw = {};
  }
  if (String(raw.version ?? '') === APP_VERSION) return { changed: false, version: APP_VERSION };
  run(
    'UPDATE setting SET raw = ? WHERE section = ?',
    JSON.stringify({ ...raw, version: APP_VERSION }), 'about',
  );
  return { changed: true, version: APP_VERSION };
}
