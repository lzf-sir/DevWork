/**
 * 工单工作区 —— 每张工单一个目录，代码资产用 git worktree 隔离。
 *
 * 为什么必须做这一步：没有它，两张工单会在同一个仓库里改同一个文件，
 * 而且双方都以为自己改的是「当前代码」。这类冲突不会报错，只会静默覆盖。
 *
 * 一条刻意的取舍：**只读工单不需要隔离**。
 * 只读不产生冲突，为它建工作树只是浪费磁盘和时间；而一旦授权里允许写
 * （maxWrites > 0），就必须为每个代码资产建出独立工作树，建不出来就 blocked。
 * 宁可停下来让人看见，也不要两个人抢同一个工作区。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOX_DIR } from '../config';
import { get } from '../db/database';
import { resolveRepoRoot, slugify } from './workspace-repos';
import type { ToolFace } from '../config/tool-catalog';

export const TICKETS_DIR = path.join(SANDBOX_DIR, 'tickets');

/** 一张工单的隔离目标：必须建立哪些工作树。 */
export interface IsolationTargets {
  /** 必须建立隔离工作树的代码资产。 */
  codeAssets: string[];
  /** 工作区级写工具（fs_write_file）需要工作区别名时，指向的代码资产。 */
  aliasTarget: string;
  /** 是否必须建立隔离：true 时建不出隔离就是 blocked，不许降级。 */
  requireIsolation: boolean;
  /** 有值表示无法建立隔离：调用方必须 blocked，不许降级。 */
  error?: string;
}

export interface WorkdirPlan {
  /** 这张工单的工作根目录。 */
  root: string;
  /** assetId → 该工单内该资产的真实工作树。 */
  assetRoots: Record<string, string>;
  /** 有值表示没能建立隔离：调用方必须停手，不许降级成共享目录。 */
  error?: string;
  /** 供清理时使用：记录建过哪些工作树。 */
  createdWorktrees: { repoRoot: string; worktree: string }[];
}

function assetTypeOf(assetId: string): string {
  return String(get<{ type: string }>('SELECT type FROM asset WHERE id = ?', assetId)?.type ?? '');
}

function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'));
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * 算出这张工单「必须隔离」的写目标。
 *
 * 为什么不能只看授权里的 assets：写工具真正落到哪个资产，是派生管线按
 * 「每类资产一个主实例」决定的（tool-catalog R4）。授权里没写这个资产，
 * 不代表写操作不会碰它；反过来也一样 —— 授权里写了某个 code 资产，
 * 就必须给它建工作树，否则那张票的写会落到共享仓库。
 *
 * 建不出隔离就直接给 error，调用方必须 blocked，不许降级。
 */
export function isolationTargetsOf(options: {
  /** 已按授权裁剪过的派生工具面（active 里才是这一单真能调到的工具）。 */
  face: ToolFace;
  /** 授权里的资产范围。 */
  scopeAssets: string[];
  /** 授权允许的写次数。 */
  maxWrites: number;
}): IsolationTargets {
  const { face, scopeAssets, maxWrites } = options;
  const codeAssets: string[] = [];
  let workspaceWrite = false;
  let fileWrite = false;

  for (const tool of face.active) {
    if (!tool.entry.writeAction) continue;
    if (tool.entry.assetType === 'workspace') {
      /* 工作区级写工具（fs_write_file）：不落任何代码资产，要靠别名指到工作树。 */
      workspaceWrite = true;
      fileWrite = true;
      continue;
    }
    if (assetTypeOf(tool.assetId) === 'code') {
      codeAssets.push(tool.assetId);
      fileWrite = true;
    }
  }
  /* 授权点名的 code 资产同样要隔离：哪怕这一单没有工具直接绑它，
   * 它也在授权范围内，写进去就是两张票抢同一份代码。 */
  for (const assetId of scopeAssets) {
    if (assetTypeOf(assetId) === 'code') codeAssets.push(assetId);
  }

  const unique = [...new Set(codeAssets)];
  const aliasTarget = workspaceWrite ? (unique[0] ?? '') : '';
  const requireIsolation = maxWrites > 0;

  let error: string | undefined;
  if (requireIsolation && fileWrite && unique.length === 0) {
    error = '授权允许写，但这一单没有任何可隔离的代码资产：写操作无处落地，'
      + '会落到共享仓库。已阻断 —— 请把工单绑定到代码资产，或把授权改成只读。';
  }
  return { codeAssets: unique, aliasTarget, requireIsolation, error };
}

/**
 * 准备工单工作区。
 *
 * targets.requireIsolation = 这份授权允许写。允许写就必须隔离，且失败即阻塞。
 */
export function prepareWorkdir(
  ticketId: string,
  shortName: string,
  targets: IsolationTargets,
): WorkdirPlan {
  const root = path.join(TICKETS_DIR, shortName || `t-${ticketId.slice(-6)}`);
  const assetRoots: Record<string, string> = {};
  const createdWorktrees: WorkdirPlan['createdWorktrees'] = [];

  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    return {
      root, assetRoots, createdWorktrees,
      error: `无法创建工作目录：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  /* 上游已经判定「建不出隔离」：原样交给调用方，不降级。 */
  if (targets.error) {
    return { root, assetRoots, createdWorktrees, error: targets.error };
  }

  if (!targets.requireIsolation) {
    /* 只读工单：直接读共享仓库，不建工作树。 */
    return { root, assetRoots, createdWorktrees };
  }

  if (targets.codeAssets.length === 0) {
    return {
      root, assetRoots, createdWorktrees,
      error: '授权允许写，但没有任何可隔离的代码资产：拒绝降级写共享仓库。'
        + '请把工单绑定到代码资产，或把授权改成只读。',
    };
  }

  for (const assetId of targets.codeAssets) {
    if (assetTypeOf(assetId) !== 'code') {
      return {
        root, assetRoots, createdWorktrees,
        error: `资产 ${assetId} 已不是代码资产，无法为写操作建立隔离工作区。`
          + '请修正工单绑定的资产，或把授权改成只读。',
      };
    }
    let repoRoot = '';
    try {
      repoRoot = resolveRepoRoot(assetId);
    } catch (error) {
      return {
        root, assetRoots, createdWorktrees,
        error: `无法定位资产 ${assetId} 的仓库：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isGitRepo(repoRoot)) {
      return {
        root, assetRoots, createdWorktrees,
        error: `资产 ${assetId} 不是 git 仓库，无法为写操作建立隔离工作区。请改成只读授权，或先把它初始化为仓库。`,
      };
    }

    const worktree = path.join(root, slugify(assetId));
    if (fs.existsSync(worktree)) {
      /* 重派时复用上一轮的工作树：里面可能还有未提交的改动，删了就是丢工作。 */
      assetRoots[assetId] = worktree;
      continue;
    }
    const branch = `agent/${shortName || ticketId.slice(-6)}`;
    try {
      git(['worktree', 'add', worktree, '-b', branch], repoRoot);
    } catch {
      /* 分支已存在（上一轮建过）：挂到已有分支上继续。 */
      try {
        git(['worktree', 'add', worktree, branch], repoRoot);
      } catch (error) {
        return {
          root, assetRoots, createdWorktrees,
          error: `无法为资产 ${assetId} 建立工作树：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    assetRoots[assetId] = worktree;
    createdWorktrees.push({ repoRoot, worktree });
  }

  /* 每个目标都必须有工作树：一个都没建出来 = 没隔离 = 降级。 */
  const missing = targets.codeAssets.filter((assetId) => !assetRoots[assetId]);
  if (missing.length > 0) {
    return {
      root, assetRoots, createdWorktrees,
      error: `以下代码资产没有隔离工作树：${missing.join('、')}。拒绝降级写共享仓库。`,
    };
  }

  return { root, assetRoots, createdWorktrees };
}

/**
 * 清理工作区。
 *
 * 只删我们自己建的目录（前缀校验），并且绝不删含未提交改动的分支 ——
 * `worktree remove --force` 会连改动一起删，所以先看 dirty 状态：
 * 有改动就留着，让人自己决定。丢工作比留垃圾严重得多。
 */
export function releaseWorkdir(plan: WorkdirPlan): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  plan.createdWorktrees.forEach(({ repoRoot, worktree }) => {
    try {
      const dirty = git(['status', '--porcelain'], worktree).trim();
      if (dirty) {
        kept += 1;
        return;
      }
      git(['worktree', 'remove', worktree], repoRoot);
      removed += 1;
    } catch {
      kept += 1;
    }
  });
  const absoluteRoot = path.resolve(plan.root);
  if (absoluteRoot.startsWith(path.resolve(TICKETS_DIR)) && absoluteRoot !== path.resolve(TICKETS_DIR)) {
    try {
      if (fs.existsSync(absoluteRoot) && fs.readdirSync(absoluteRoot).length === 0) {
        fs.rmdirSync(absoluteRoot);
      }
    } catch {
      /* 删不掉就留着：空目录不构成问题。 */
    }
  }
  return { removed, kept };
}
