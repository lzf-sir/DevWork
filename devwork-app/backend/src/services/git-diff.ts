/**
 * 提交 diff 的切分与预算装配（纯函数，无 fs）。
 *
 * 为什么单独成模块：`git show` 的输出以前是 `slice(0, 4000)`。这在**半个 hunk 中间**
 * 裁一刀——模型看到 `-old()` 而没有下面的 `+new()`，读出来的结论就是"删了一个方法"。
 * 一个被裁的 hunk 比没有 hunk 更危险：前者会生成确定的错误结论，后者只会让人再查一次。
 *
 * 所以这里的规则只有一条：**只按边界裁（文件边界 / hunk 边界），永不裁 hunk 内部**。
 * 裁不动的时候给出准确的数量与下一步命令，而不是"已截断"四个字。
 */

export interface DiffFileChunk {
  /** 展示用路径（重命名取新路径）。 */
  path: string;
  /** 完整片段（含 `diff --git` 头）。 */
  text: string;
  /** hunk 数（`@@` 的个数）。 */
  hunks: number;
  /** 是否含 hunk（二进制/纯模式变更没有）。 */
  binary: boolean;
}

/** 切分多文件 diff。`git show` 一个提交的输出里有几个 `diff --git` 就有几个文件。 */
export function splitDiffByFile(diffText: string): DiffFileChunk[] {
  const chunks = String(diffText ?? '')
    .split(/^(?=diff --(?:git|cc) )/m)
    .map((part) => part.trimEnd())
    .filter((part) => part.trim() !== '' && /^diff --(?:git|cc) /.test(part));

  return chunks.map((text) => {
    const header = /^diff --(?:git|cc) (.+)$/m.exec(text)?.[1] ?? '';
    /* 合并提交的 `diff --cc path` 只有一个名字；普通形态是 `a/x b/y`，取后一个（新路径）。 */
    const pathMatch = /^a\/(.*) b\/(.*)$/.exec(header.trim());
    const path = pathMatch ? pathMatch[2] : header.replace(/^[ab]\//, '').trim() || '(未知文件)';
    return {
      path,
      text,
      hunks: (text.match(/^@@/gm) ?? []).length,
      binary: /^Binary files .* differ$/m.test(text) || /^GIT binary patch$/m.test(text),
    };
  });
}

export interface AssembledDiff {
  /** 可直接拼进输出的块（每块自带 `--- path ---` 抬头）。 */
  blocks: string[];
  /** 完整展开的文件数。 */
  included: number;
  /** 只展开了一部分 hunk 的文件。 */
  partial: Array<{ path: string; shown: number; total: number }>;
  /** 连一个完整 hunk 都装不下、只能给行窗口的文件（附准确行数）。 */
  clipped: Array<{ path: string; shownLines: number; totalLines: number }>;
  /** 一个字都没展示的文件。 */
  skipped: string[];
  /** 实际用掉的字符数。 */
  used: number;
}

export interface AssembleOptions {
  /**
   * 是否给每个块加 `--- path（N 个 hunk）---` 抬头。
   *
   * 单文件视图（`code_view(mode=diff)`）的调用方已经在正文第一行印了路径，
   * 再印一遍是噪音——但**降级说明不能跟着一起关掉**，所以只关抬头。
   */
  header?: boolean;
}

/**
 * 按预算装配 diff：整文件优先，装不下再按**完整 hunk** 展开，
 * 连一个 hunk 都装不下时给一个**标好行数**的行窗口。
 *
 * 分配顺序是**先小后大**，输出顺序是**原文件顺序**。这不是细节：
 * 一个 8KB 的巨型文件排在前面，会把后面两个只有 2 行的小文件整段挤掉，
 * 而小文件往往才是这次改动的结论所在。顺序决定取舍，取舍就会由体积决定。
 */
export function assembleDiff(chunks: DiffFileChunk[], budget: number, options: AssembleOptions = {}): AssembledDiff {
  const cap = Math.max(400, Math.floor(budget));
  /* 单文件最多吃掉预算的 40%：只约束"部分展开/行窗口"，不约束整文件
   * （一个 3000 字符的文件该整段给，不该因为比例限制被切成窗口）。
   * 没有这条，一个 8KB 的窗口会把同提交的其余文件全挤成"未展开"。
   *
   * 只有 1 个文件时这条**必须失效**：比例上限的用途是"别让一个文件抢走别人的份额"，
   * 而单文件视图里没有别人。留着它会把 4000 字符的单文件 diff 砍成 1200 字符的窗口，
   * 明明预算够却只给三分之一。 */
  const perFileCap = chunks.length <= 1 ? cap : Math.max(600, Math.floor(cap * 0.4));
  const withHeader = options.header !== false;
  const label = (path: string, suffix: string): string => (withHeader ? `--- ${path}（${suffix}）---\n` : '');
  const order = chunks
    .map((_, index) => index)
    .sort((a, b) => chunks[a].text.length - chunks[b].text.length || a - b);

  interface Decision {
    block?: string;
    full?: boolean;
    partial?: { shown: number; total: number };
    clipped?: { shownLines: number; totalLines: number };
  }
  const decisions = new Map<number, Decision>();
  let used = 0;

  for (const index of order) {
    const chunk = chunks[index];
    const remaining = cap - used;
    const localCap = Math.min(remaining, perFileCap);

    if (chunk.text.length + 40 <= remaining) {
      decisions.set(index, {
        block: `${label(chunk.path, `${chunk.hunks} 个 hunk${chunk.binary ? ' · 二进制' : ''}`)}${chunk.text}`,
        full: true,
      });
      used += chunk.text.length + 40;
      continue;
    }

    /* 整文件装不下：按 hunk 边界展开。第一个 hunk 之前的部分是公共抬头。 */
    const parts = chunk.text.split(/^(?=@@ )/m);
    const head = parts[0];
    const hunkParts = parts.slice(1);
    if (hunkParts.length === 0) {
      /* 没有 hunk（二进制 / 纯模式变更）：行数固定，抬头本身就是全部信息。 */
      if (head.length + 40 <= localCap) {
        decisions.set(index, {
          block: `${label(chunk.path, `无 hunk·${chunk.binary ? '二进制' : '仅模式变更'}`)}${head}`,
          full: true,
        });
        used += head.length + 40;
      }
      continue;
    }

    const picked: string[] = [];
    let local = head.length;
    for (const hunk of hunkParts) {
      if (local + hunk.length > localCap) break;
      picked.push(hunk);
      local += hunk.length;
    }
    if (picked.length > 0) {
      decisions.set(index, {
        block: `${label(chunk.path, `${chunk.hunks} 个 hunk，本次展开前 ${picked.length} 个`)}${head}${picked.join('')}`,
        partial: { shown: picked.length, total: chunk.hunks },
      });
      used += local + 40;
      continue;
    }

    /* 最后一档：连一个完整 hunk 都塞不下。这时候"什么都不给"是死路——
     * 调用方再换 path 重新 show 一次，拿到的还是同一段超长 hunk。
     * 所以给一个**标好行数的行窗口**：内容是半个 hunk，但缺多少行写清楚了，
     * 与"裁完不说"是两件事。 */
    const lines = hunkParts[0].split('\n');
    const kept: string[] = [];
    let local2 = head.length;
    const reserve = 160;
    for (const line of lines) {
      if (local2 + line.length + 1 > localCap - reserve) break;
      kept.push(line);
      local2 += line.length + 1;
    }
    if (kept.length > 1) {
      /* 这一档的行数是**核心信息**，不随 header 开关一起关掉：
       * 关掉抬头只是省掉 `--- path ---` 装饰，`共 121 行、只给前 28 行` 必须留在正文里。
       * 抬头开着时补"这个文件共几个 hunk"，关着时那句调用方已经说过，不再重复。 */
      const counts = `第 1 个 hunk 共 ${lines.length} 行，本次只给前 ${kept.length} 行`
        + (chunk.hunks > 1 ? `，其余 ${chunk.hunks - 1} 个 hunk 未展开` : '');
      decisions.set(index, {
        block: `${withHeader ? `--- ${chunk.path}（${chunk.hunks} 个 hunk，${counts}）---\n` : `（${counts}）\n`}`
          + `${head}${kept.join('\n')}\n`
          + `[… 该 hunk 还有 ${lines.length - kept.length} 行未显示 …]`,
        clipped: { shownLines: kept.length, totalLines: lines.length },
      });
      used += local2 + reserve;
    }
  }

  const blocks: string[] = [];
  const partial: AssembledDiff['partial'] = [];
  const clipped: AssembledDiff['clipped'] = [];
  const skipped: string[] = [];
  let included = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const decided = decisions.get(index);
    if (!decided) { skipped.push(chunks[index].path); continue; }
    if (decided.block) blocks.push(decided.block);
    if (decided.full) included += 1;
    if (decided.partial) partial.push({ path: chunks[index].path, ...decided.partial });
    if (decided.clipped) clipped.push({ path: chunks[index].path, ...decided.clipped });
  }

  return { blocks, included, partial, clipped, skipped, used };
}
