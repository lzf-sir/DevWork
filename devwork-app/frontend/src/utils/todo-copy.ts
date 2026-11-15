/**
 * 遗留标记的**措辞层**（纯函数，不碰 React）。
 *
 * 单独拆出来的理由：这一层的每个分支都是一句可能撒谎的话，而它埋在 1200 行的视图里
 * 就只能靠肉眼看截图验证。抽成纯函数后可以逐分支断言——和工具侧 `code_todos` 的
 * 输出文案是同一套规矩，只是渲染位置不同。
 */
import type { FileTodosResult, TodoHitShape } from '../api/types';

/**
 * 归属措辞。
 *
 * `owner === undefined` 有两种完全不同的原因，`codeFile` 是唯一能分开它们的字段：
 *   · 代码文件 → 这一行确实不在任何符号里（模块级、文件头注释），是结论；
 *   · 非代码文件 → 这个格式没有符号这个概念，压根不该有归属，说了就是编。
 */
export function todoOwner(hit: TodoHitShape): string {
  if (!hit.codeFile) return '';
  return hit.owner ? `在 ${hit.owner} 里` : '模块级（不在任何符号内）';
}

/**
 * 「为什么可能没扫全」——三条通道互不替代，各占一句。
 *
 * 压成一个 `truncated` 就是撒谎：命中触顶说明「后面的文件没读」，遍历截断说明
 * 「仓库还有文件没进范围」，大文件跳过说明「读到的那些里有整份没看」。三者叠加时
 * 覆盖率损失完全不同，用户据此决定要不要换路径重扫。
 */
export function todoGaps(data: FileTodosResult): string[] {
  const gaps: string[] = [];
  if (data.stoppedAtCap) {
    gaps.push(`命中达到上限（${data.hits.length} 条）后停止：后面的文件没有读，这不是"就这些"。`);
  }
  if (data.walkTruncated) {
    gaps.push('遍历达到文件数上限：仓库里还有文件没进入扫描范围。');
  }
  if (data.skippedLarge > 0) {
    gaps.push(`${data.skippedLarge} 个文件超过 200KB 未读取（多为产物或打包文件，但不排除真代码）。`);
  }
  return gaps;
}

/**
 * 右栏那一行的摘要。
 *
 * 212px 放不下明细，但**覆盖率**不能因为窄就不说：有缺口时这里也必须带
 * 「已列 / 未覆盖全部」，否则用户会把「右栏写 100 条」当成仓库总共 100 条。
 */
export function todoRailSummary(data: FileTodosResult): string {
  const files = new Set(data.hits.map((hit) => hit.path)).size;
  const incomplete = todoGaps(data).length > 0;
  if (data.hits.length === 0) {
    return incomplete ? '没扫到（未覆盖全部文件）' : '没有遗留标记';
  }
  return `${incomplete ? '已列 ' : ''}${data.hits.length} 条 · ${files} 个文件`;
}
