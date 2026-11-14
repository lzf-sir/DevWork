/**
 * 执行上下文 —— 让「这张工单在哪个目录里干活」成为一次执行内的隐式事实。
 *
 * 为什么需要它：文件工具（读 / 写 / 补丁）都按 `assetId → 仓库根` 解析路径，
 * 而仓库根是**资产级**的、全局共享的。不覆盖它，「独立工作目录」就只是个空目录：
 * 工单 A 和工单 B 照样会在同一个仓库里改同一个文件。
 *
 * 为什么用 AsyncLocalStorage 而不是传参：工具执行链路有 5 层
 * （worker → gateway → executeTool → write-executor → file-service），
 * 一路加参数会把「隔离」这件事漏在某个忘记传的地方 —— 而漏一次就等于没隔离。
 * AsyncLocalStorage 跟着异步调用链走，工具函数不需要知道工单存在。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ExecContext {
  ticketId: string;
  /** 这张工单的工作根目录（每个工单一个）。 */
  workdir: string;
  /** assetId → 该工单内该资产的真实根（git worktree 路径）。 */
  assetRoots: Record<string, string>;
  /**
   * 本工单要求隔离的写目标资产。
   *
   * 这些资产**不许**回落到共享仓库：回落 = 静默写进演示仓库，
   * 两张工单互相覆盖且不报错。列出它们是为了让越界在解析层就被拒。
   */
  isolatedAssets: string[];
  /** 工作区级写工具（fs_write_file）指向的代码资产；工作区 id 经它映射到工作树。 */
  aliasTarget?: string;
  /** 工作区 id：workspace 型写工具派生出来的资产就是它。 */
  workspaceId?: string;
}

const storage = new AsyncLocalStorage<ExecContext>();

export function runInExecContext<T>(context: ExecContext, run: () => Promise<T>): Promise<T> {
  return storage.run(context, run);
}

export function currentExecContext(): ExecContext | undefined {
  return storage.getStore();
}

/**
 * 工单级的仓库根覆盖。
 *
 * 只覆盖**这张工单实际声明过的资产**：别让一次执行顺手改到范围外的仓库，
 * 那是比「没有隔离」更难查的越权。
 */
export function repoRootOverride(assetId: string): string | null {
  const context = storage.getStore();
  if (!context) return null;
  const direct = context.assetRoots[assetId];
  if (direct) return direct;
  /* workspace 型写工具（fs_write_file）派生出来的资产就是工作区本身，
   * 它没有自己的仓库 —— 必须经别名落到本单的工作树上，
   * 否则它会一路回落到共享演示仓库，变成往公共目录里写代码。 */
  if (context.aliasTarget && assetId === context.workspaceId) {
    return context.assetRoots[context.aliasTarget] ?? null;
  }
  return null;
}

/**
 * 该资产在本工单内是否**必须**落在隔离工作树上。
 *
 * 为真而拿不到隔离根时，调用方必须报错停手，不许回落共享仓库。
 */
export function isolationRequired(assetId: string): boolean {
  const context = storage.getStore();
  if (!context) return false;
  if (context.aliasTarget && assetId === context.workspaceId) return true;
  return context.isolatedAssets.includes(assetId);
}
