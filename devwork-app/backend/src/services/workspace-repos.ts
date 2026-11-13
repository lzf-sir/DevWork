/**
 * 本地工作区仓库层 —— 「代码库 = 克隆到本地的仓库」的唯一落点。
 *
 * 目录布局（按项目隔离，索引 / 上下文 / 凭据都不跨工作区）：
 *   <SANDBOX_DIR>/workspaces/<workspaceId>/<repoSlug>/
 *
 * 资产与本地目录的映射存在 asset.config：
 *   { cloneUrl, localPath, branch, clonedAt, remote, depth }
 * localPath 是相对 WORKSPACES_ROOT 的相对路径；解析时强制校验结果不越出
 * 所属工作区目录 —— 这是「工作区是信任边界」在文件系统上的落点。
 *
 * 回落策略：没有克隆记录的历史资产（演示种子）继续指向沙箱演示仓库，
 * 既有演示不受影响；新克隆的仓库按工作区严格隔离。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SANDBOX_DIR } from '../config';
import { get, run, nowIso } from '../db/database';
import { REPO_ROOT } from '../sandbox/bootstrap';
import { ApiFailure } from '../http/core';

/** 所有工作区的本地根。 */
export const WORKSPACES_ROOT = path.join(SANDBOX_DIR, 'workspaces');

/** clone 超时：大仓库首次拉取慢，但也不能无限挂住请求线程。 */
const CLONE_TIMEOUT_MS = 300000;

export interface RepoConfig {
  cloneUrl?: string;
  /** 相对 WORKSPACES_ROOT 的相对路径，形如 `w-ops/order-service`。 */
  localPath?: string;
  branch?: string;
  clonedAt?: string;
  remote?: string;
  depth?: number;
}

/** 目录名安全化：只保留字母数字与 `-_.`，杜绝 `..` / 分隔符 / 盘符。 */
export function slugify(name: string): string {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\.+/g, '.')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 80) : 'repo';
}

/** 断言 child 位于 parent 之内（含 parent 自身）。 */
function assertInside(parent: string, child: string): void {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (c !== p && !c.startsWith(`${p}${path.sep}`)) {
    throw new ApiFailure('E_PATH_ESCAPE', `路径越界：${c} 不在 ${p} 之内`);
  }
}

/** 某工作区的本地目录（不存在则创建）。 */
export function workspaceRoot(workspaceId: string): string {
  const root = path.join(WORKSPACES_ROOT, slugify(workspaceId));
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 显式建立本地工作区目录：项目一创建就有本地根，资产可以往里放仓库。 */
export function ensureWorkspaceDir(workspaceId: string): { workspaceId: string; localRoot: string } {
  return { workspaceId, localRoot: workspaceRoot(workspaceId) };
}

/** 读资产的仓库配置。 */
export function repoConfigOf(assetId: string): RepoConfig {
  const row = get<{ config: string }>('SELECT config FROM asset WHERE id = ?', assetId);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.config || '{}') as RepoConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 写回资产的仓库配置（保留 config 里其他字段，如 endpoint）。 */
export function saveRepoConfig(assetId: string, patch: RepoConfig): RepoConfig {
  const current = repoConfigOf(assetId);
  const next: RepoConfig = { ...current, ...patch };
  run('UPDATE asset SET config = ? WHERE id = ?', JSON.stringify(next), assetId);
  return next;
}

/** 资产所属工作区。 */
export function assetWorkspaceId(assetId: string): string {
  const row = get<{ workspace_id: string }>('SELECT workspace_id FROM asset WHERE id = ?', assetId);
  return String(row?.workspace_id ?? 'w-ops');
}

/**
 * 解析资产的真实仓库根。
 * 1. 有克隆记录 → <WORKSPACES_ROOT>/<localPath>，并校验不越出所属工作区目录；
 * 2. 记录存在但目录被删 → 如实报错（不假装还有仓库）；
 * 3. 没有克隆记录 → 回落沙箱演示仓库（历史种子资产的兼容路径）。
 */
export function resolveRepoRoot(assetId: string): string {
  const config = repoConfigOf(assetId);
  const workspaceId = assetWorkspaceId(assetId);
  if (!config.localPath) return REPO_ROOT;

  const absolute = path.resolve(WORKSPACES_ROOT, config.localPath);
  const wsRoot = path.join(WORKSPACES_ROOT, slugify(workspaceId));
  assertInside(wsRoot, absolute);
  if (!fs.existsSync(absolute)) {
    throw new ApiFailure(
      'E_REPO_MISSING',
      `本地仓库目录不存在：${config.localPath}（可重新克隆或先拉取最新代码）`,
    );
  }
  return absolute;
}

/** 解析失败时给前端一个安全兜底：用于「目录不存在」类只读展示。 */
export function tryResolveRepoRoot(assetId: string): string {
  try {
    return resolveRepoRoot(assetId);
  } catch {
    return REPO_ROOT;
  }
}

/** 把 https URL 里的 token 注入进去（私有仓库），返回带凭据的 URL。
 *  凭据只在内存里拼一次，不落 config、不进审计明细。 */
function withToken(rawUrl: string, token?: string): string {
  if (!token) return rawUrl;
  if (!/^https?:\/\//i.test(rawUrl)) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    parsed.username = token;
    parsed.password = '';
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/** 脱敏后的远端地址：写配置 / 审计用，绝不含 token。 */
export function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return String(rawUrl).replace(/\/\/[^@/]+@/, '//***@');
  }
}

/** 从远端地址推断仓库名（https://host/org/repo.git → repo）。 */
export function repoNameFromUrl(rawUrl: string): string {
  const cleaned = String(rawUrl).replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return slugify(parts[parts.length - 1] ?? 'repo');
}

export interface CloneInput {
  assetId: string;
  url: string;
  branch?: string;
  depth?: number;
  token?: string;
  /** 已有克隆时是否重新拉取（fetch + reset）。 */
  pull?: boolean;
}

export interface CloneResult {
  localPath: string;
  absolutePath: string;
  branch: string;
  commit: string;
  files: number;
  action: 'cloned' | 'pulled';
  remote: string;
}

/** 在指定目录执行 git 命令，返回标准输出；失败时抛出带 stderr 的错误。 */
function git(cwd: string, args: string[], timeout = 20000): string {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const stderr = String(err?.stderr ?? '').trim();
    const hint = stderr || String(err?.message ?? 'git 执行失败');
    throw new ApiFailure('E_GIT_FAILED', `git ${args[0]} 失败：${hint.slice(0, 400)}`);
  }
}

/** 统计仓库内文件数（跳过 .git 与 node_modules）。 */
function countFiles(root: string): number {
  let count = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || count > 20000) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.forEach((entry) => {
      if (entry.name === '.git' || entry.name === 'node_modules') return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.isFile()) count += 1;
    });
  };
  walk(root, 0);
  return count;
}

/**
 * 真实克隆仓库到该工作区的本地目录。
 * - 目标目录：workspaces/<workspaceId>/<repoSlug>
 * - 已存在则按 pull 语义处理（fetch + reset --hard origin/<branch>），不重复克隆。
 */
export async function cloneRepository(input: CloneInput): Promise<CloneResult> {
  const url = String(input.url ?? '').trim();
  if (!url) throw new ApiFailure('E_VALIDATION', '克隆地址不能为空');
  if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/i.test(url)) {
    throw new ApiFailure('E_VALIDATION', '克隆地址需为 http(s) / ssh / git / file 协议');
  }

  const workspaceId = await assetWorkspaceId(input.assetId);
  const wsRoot = workspaceRoot(workspaceId);
  const config = await repoConfigOf(input.assetId);

  const slug = repoNameFromUrl(url);
  const sameRemote = Boolean(config.cloneUrl)
    && redactUrl(config.cloneUrl ?? '') === redactUrl(url);

  /* 只有「同一个远端 + 已有本地克隆」才走 pull；换了地址就是换仓库，
   * 必须落到新目录，不能把新仓库拉进旧仓库的目录里。 */
  const existingTarget = config.localPath
    ? path.join(wsRoot, path.basename(config.localPath))
    : '';
  const canPull = sameRemote
    && existingTarget !== ''
    && fs.existsSync(path.join(existingTarget, '.git'));

  const target = canPull
    ? existingTarget
    : path.join(wsRoot, slug);
  assertInside(wsRoot, target);
  const relativePath = path.relative(WORKSPACES_ROOT, target).replace(/\\/g, '/');

  const depth = Number(input.depth ?? 1);
  const authUrl = withToken(url, input.token);

  if (canPull) {
    /* 已有克隆 → 拉最新。--depth 浅克隆下 fetch 需要显式指定 depth。 */
    git(target, ['remote', 'set-url', 'origin', authUrl]);
    git(target, ['fetch', '--depth', String(Math.max(1, depth)), 'origin']);
    const branch = input.branch || config.branch || git(target, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    /* 分支可能只有远端有（本地还没建）：checkout 失败就新建并对齐。 */
    try {
      git(target, ['checkout', branch]);
    } catch {
      git(target, ['checkout', '-B', branch, `origin/${branch}`]);
    }
    git(target, ['reset', '--hard', `origin/${branch}`]);
    const commit = git(target, ['rev-parse', '--short', 'HEAD']);
    await saveRepoConfig(input.assetId, {
      cloneUrl: redactUrl(url), localPath: relativePath, branch,
      clonedAt: nowIso(), remote: 'origin', depth,
    });
    return {
      localPath: relativePath, absolutePath: target, branch, commit,
      files: countFiles(target), action: 'pulled', remote: 'origin',
    };
  }

  /* 目标已存在 → 不覆盖用户数据，如实报错（换名字或先清理）。 */
  if (fs.existsSync(target)) {
    throw new ApiFailure(
      'E_REPO_EXISTS',
      `目标目录已存在：${relativePath}。请先改名或清理该目录，或换一个仓库地址。`,
    );
  }

  const args = ['clone'];
  if (depth > 0) args.push('--depth', String(depth));
  if (input.branch) args.push('--branch', input.branch);
  args.push(authUrl, target);
  git(wsRoot, args, CLONE_TIMEOUT_MS);

  const branch = input.branch || git(target, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
  const commit = git(target, ['rev-parse', '--short', 'HEAD']);
  await saveRepoConfig(input.assetId, {
    cloneUrl: redactUrl(url), localPath: relativePath, branch,
    clonedAt: nowIso(), remote: 'origin', depth,
  });
  return {
    localPath: relativePath, absolutePath: target, branch, commit,
    files: countFiles(target), action: 'cloned', remote: 'origin',
  };
}

/** 仓库状态：本地路径、远端、分支、最近提交、文件数。 */
export function repoStatus(assetId: string): {
  cloned: boolean;
  localPath: string;
  absolutePath: string;
  cloneUrl: string;
  branch: string;
  commit: string;
  lastCommit: string;
  files: number;
  dirty: boolean;
  error: string;
} {
  const config = repoConfigOf(assetId);
  if (!config.localPath) {
    return {
      cloned: false, localPath: '', absolutePath: REPO_ROOT, cloneUrl: '',
      branch: '', commit: '', lastCommit: '', files: 0, dirty: false, error: '',
    };
  }
  const absolute = path.resolve(WORKSPACES_ROOT, config.localPath);
  if (!fs.existsSync(absolute)) {
    return {
      cloned: false, localPath: config.localPath, absolutePath: absolute,
      cloneUrl: config.cloneUrl ?? '', branch: config.branch ?? '', commit: '',
      lastCommit: '', files: 0, dirty: false,
      error: '本地目录不存在，需要重新克隆',
    };
  }
  let branch = '';
  let commit = '';
  let lastCommit = '';
  let dirty = false;
  try {
    branch = git(absolute, ['rev-parse', '--abbrev-ref', 'HEAD'], 8000);
    commit = git(absolute, ['rev-parse', '--short', 'HEAD'], 8000);
    lastCommit = git(absolute, ['log', '-1', '--pretty=format:%h · %ar · %an · %s'], 8000);
    dirty = git(absolute, ['status', '--porcelain'], 8000).length > 0;
  } catch {
    /* 非 git 目录：如实留空，不编造分支 */
  }
  return {
    cloned: true,
    localPath: config.localPath,
    absolutePath: absolute,
    cloneUrl: config.cloneUrl ?? '',
    branch,
    commit,
    lastCommit,
    files: countFiles(absolute),
    dirty,
    error: '',
  };
}
