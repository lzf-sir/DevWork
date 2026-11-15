/**
 * 改动片段：写操作落盘之后的**证据**，不是给用户看的装饰。
 *
 * 为什么需要它：写入工具原来只回一句「已精确替换 X 第 120 行起的 1 处」。
 * 这句话说的是"我动了几处"，不是"改完长什么样"。于是"给出改了什么"这条要求
 * 实际上只能由模型凭记忆复述——而记忆是最容易编的东西。
 *
 * 只回答三件事：
 *   ① 改了哪几行（旧/新两侧的行区间）；
 *   ② 增删了多少行；
 *   ③ 改完那一段长什么样（带上下文的片段）。
 *
 * 行号口径照 git：`@@ -旧起点,旧行数 +新起点,新行数 @@`，正文不带行号。
 * 两侧行号系统不同（删除行属于旧文件，新增行属于新文件），在同一列里混排
 * 两种编号，比不给行号更容易被读错。
 *
 * 无 fs、无异步：纯函数，可单测。
 */

export interface DiffRegionOptions {
  /** 改动前后各带多少行上下文，默认 3。 */
  context?: number;
  /**
   * 最多展示多少行**改动**（增+删），默认 40。
   *
   * 只约束改动行、不把上下文算进去：上下文是固定的常数（两侧各 3 行），
   * 把它计入总预算是"改动 25 行因为多了 6 行上下文就变成不给"——上限成了随机数。
   */
  maxChangeLines?: number;
  /** 单行最多展示多少字符（超长行截断，默认 300）。 */
  maxLineChars?: number;
}

export interface DiffRegion {
  /** 前后完全相同。 */
  unchanged: boolean;
  /** 可直接拼进工具返回的片段；unchanged 或超限时为空串。 */
  block: string;
  /** 新增行数。 */
  added: number;
  /** 删除行数。 */
  removed: number;
  /** 改动前的行区间（1 起、含端点）；纯插入时长度为 0，起点是"插在哪两行之间"的后一行。 */
  oldRange: [number, number];
  /** 改动后的行区间（1 起、含端点）。 */
  newRange: [number, number];
  /**
   * 改动行数超过展示上限，**没有给正文**。
   *
   * 这里刻意不给"只看前 N 行"的窗口：写入后的证据一旦只给一半，
   * 读者会把它当成全部改动（§17 的行窗口是为了避免"换 path 重查也拿不到"的死路，
   * 而这里下一步随时可以 code_view 按区间读，不存在死路）。
   */
  clipped: boolean;
  /** 调用方应提示的下一步（clipped 时非空）。 */
  hint: string;
}

/** 把单行压到上限内，避免一行业务 JSON 把整段片段撑爆。 */
function clipLine(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（该行共 ${text.length} 字符）`;
}

/**
 * 围栏长度：必须比正文里最长的连续反引号还长。
 *
 * 片段会以 markdown 正文的形式进入对话（卡片与后续上下文都是），
 * 而 `-foo` 这种行在 markdown 里是列表项、`+bar` 是普通段落——不加围栏会被渲染成一坨。
 * 而如果改的正好是 markdown 文件，正文里自带 ``` 就会把围栏提前闭合，
 * 所以围栏长度是算出来的，不是写死的三个。
 */
function fenceFor(body: string): string {
  let longest = 0;
  let current = 0;
  for (const ch of body) {
    if (ch === '`') {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * 计算 before → after 的改动片段。
 *
 * 用公共前缀/后缀裁剪，不做完整 LCS：写操作的改动是一段连续区域，
 * 前缀/后缀裁剪给出的结果与 LCS 一致，成本却是线性的。
 * 返回的是"一段"而不是"全部改动"——这正是它的语义，字段名也照此取。
 */
export function diffRegion(before: string, after: string, options: DiffRegionOptions = {}): DiffRegion {
  const context = Math.max(0, Math.floor(options.context ?? 3));
  const maxChangeLines = Math.max(8, Math.floor(options.maxChangeLines ?? 40));
  const maxLineChars = Math.max(40, Math.floor(options.maxLineChars ?? 300));

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  let prefix = 0;
  while (
    prefix < beforeLines.length
    && prefix < afterLines.length
    && beforeLines[prefix] === afterLines[prefix]
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix
    && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;

  const removedLines = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedLines = afterLines.slice(prefix, afterLines.length - suffix);
  const unchanged = removedLines.length === 0 && addedLines.length === 0;

  /* 区间用"起点 + 行数"描述。纯插入时旧侧行数为 0，起点取 prefix+1
   * （即"插在第 prefix+1 行之前"）；这比给一个空区间更接近读者要找的位置。 */
  const oldRange: [number, number] = [prefix + 1, prefix + removedLines.length];
  const newRange: [number, number] = [prefix + 1, prefix + addedLines.length];

  if (unchanged) {
    return {
      unchanged, block: '', added: 0, removed: 0,
      oldRange, newRange, clipped: false, hint: '',
    };
  }

  const headRange = `-${oldRange[0]},${removedLines.length} +${newRange[0]},${addedLines.length}`;
  const counts = `${addedLines.length > 0 ? `+${addedLines.length}` : ''}${addedLines.length > 0 && removedLines.length > 0 ? ' ' : ''}${removedLines.length > 0 ? `-${removedLines.length}` : ''}`;

  /* 改动行过多：不给片段，只给区间与统计。理由见 DiffRegion.clipped 的注释。 */
  if (removedLines.length + addedLines.length > maxChangeLines) {
    return {
      unchanged: false, block: '', added: addedLines.length, removed: removedLines.length,
      oldRange, newRange, clipped: true,
      hint: `本次改动 ${removedLines.length + addedLines.length} 行（${counts}），超过片段上限 ${maxChangeLines} 行，`
        + '所以这里不给片段。改动后的内容请用 code_view(mode=content, offset=' + newRange[0]
        + `, limit=${Math.max(20, Math.min(200, addedLines.length + context * 2))}) 直接读。`,
    };
  }

  const bodyLines: string[] = [];
  for (const line of beforeLines.slice(Math.max(0, prefix - context), prefix)) {
    bodyLines.push(` ${clipLine(line, maxLineChars)}`);
  }
  for (const line of removedLines) bodyLines.push(`-${clipLine(line, maxLineChars)}`);
  for (const line of addedLines) bodyLines.push(`+${clipLine(line, maxLineChars)}`);
  const tailStart = afterLines.length - suffix;
  for (const line of afterLines.slice(tailStart, tailStart + context)) {
    bodyLines.push(` ${clipLine(line, maxLineChars)}`);
  }

  const body = bodyLines.join('\n');
  const fence = fenceFor(body);

  return {
    unchanged: false,
    block: [`改动片段 @@ ${headRange} @@（${counts}）`, `${fence}diff`, body, fence].join('\n'),
    added: addedLines.length,
    removed: removedLines.length,
    oldRange,
    newRange,
    clipped: false,
    hint: '',
  };
}
