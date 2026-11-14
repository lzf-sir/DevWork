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
import { get, run, nowIso, writeAudit } from '../db/database';
import { REPO_ROOT } from '../sandbox/bootstrap';
import { ApiFailure } from '../http/core';
import { repoRootOverride, isolationRequired } from './exec-context';

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

/**
 * 资产所属工作区（查不到返回空串，由调用方显式拒绝）。
 *
 * **仅用于路径解析**（当前只有 `resolveRepoRoot()` / `cloneRepository()` 两处调用）。
 * 审计归属一律用 `resolveWorkspaceIdForAsset()`：那个函数查不到返回 null，
 * 让调用点显式降级成 `''` + `workspace:unknown` 或 `AUDIT_GLOBAL_SCOPE`，
 * 不会把审计挂到一个"看起来存在"的默认工作区名下。
 */
export function assetWorkspaceId(assetId: string): string {
  const row = get<{ workspace_id: string }>('SELECT workspace_id FROM asset WHERE id = ?', assetId);
  return String(row?.workspace_id ?? '');
}

/**
 * 资产的真实工作区归属；**查不到就返回 null**（绝不带缺省值）。
 *
 * 为什么单独一个函数：`assetWorkspaceId()` 查不到会给空串，拿它去填审计
 * 等于把硬编码搬个位置 —— 资产被删之后，那条审计仍然会被记到默认工作区名下，
 * 「按工作区筛审计」看到的还是错的。审计要求「不知道就说不认识」，
 * 所以这里宁可返回 null，由调用点显式降级成 `''` + `workspace:unknown`。
 */
export function resolveWorkspaceIdForAsset(assetId: string): string | null {
  if (assetId === '') return null;
  const row = get<{ workspace_id: string }>('SELECT workspace_id FROM asset WHERE id = ?', assetId);
  const value = String(row?.workspace_id ?? '');
  return value === '' ? null : value;
}

/**
 * 解析资产的真实仓库根。
 * 1. 有克隆记录 → <WORKSPACES_ROOT>/<localPath>，并校验不越出所属工作区目录；
 * 2. 记录存在但目录被删 → 如实报错（不假装还有仓库）；
 * 3. 没有克隆记录 → 回落沙箱演示仓库（历史种子资产的兼容路径）。
 *
 * 唯一的例外：**本工单要求隔离的写目标**。它拿不到隔离根时直接报错，
 * 绝不回落演示仓库 —— 回落意味着两张工单在同一个目录里改同一个文件，
 * 而且双方都不会报错。这比停下来严重得多。
 */
export function resolveRepoRoot(assetId: string): string {
  /* 工单执行期内优先用这张工单自己的工作树。
   * 这是「隔离」真正生效的地方 —— 不在这里覆盖，独立目录就只是个空壳。 */
  const override = repoRootOverride(assetId);
  if (override) return override;

  /* 本单声明了「这个资产必须隔离」，却拿不到隔离根：拒绝降级。 */
  if (isolationRequired(assetId)) {
    throw new ApiFailure(
      'E_PERMISSION_DENIED',
      `资产 ${assetId} 在本工单内必须落在隔离工作树上，但没有隔离根：拒绝回落共享仓库`
      + '（降级写会造成工单之间静默覆盖）',
    );
  }

  const config = repoConfigOf(assetId);
  /* assetWorkspaceId 查不到资产会给空串：这里必须显式拒绝，
   * 否则 wsRoot 会退化成 workspaces/ 根目录，越界校验形同虚设。 */
  const workspaceId = assetWorkspaceId(assetId);
  if (workspaceId === '') throw new ApiFailure('E_NOT_FOUND', `资产不存在：${assetId}`);
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

/**
 * 去掉 URL 里的凭据部分（`.git/config` 只存这个）。
 *
 * 用户填的远端地址里可能自带 `user:password@`；不管 token 还是用户自己的密码，
 * 都**不应该**被写进 `.git/config` 长期留在磁盘上。
 */
export function stripCredentials(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return String(rawUrl).replace(/\/\/[^@/]+@/, '//');
  }
}

/**
 * 为一次 git 网络调用生成 Authorization 头（**只在参数里用，不落盘**）。
 *
 * 形状的选择有代价，先说清楚为什么不用「把 token 拼进 URL」：
 * 那样 git 会把它原样写进 `.git/config`；而克隆完再 set-url 成脱敏地址，
 * 下一次 fetch 就没凭据了 —— 私有仓库 pull 直接坏，且本仓库的
 * `test:repo` 走本地/公开仓库**测不出来**，会一路绿到用户手里。
 *
 * 现在：config 存脱敏地址，凭据每次通过 `-c http.extraheader=...` 带在命令行参数上，
 * 用完即弃（不进进程列表之外的任何持久化介质）。
 * token 放 username 位、密码留空 —— GitHub / GitLab / Gitea 三家的 basic 都认这个形状。
 */
function authHeaderOf(rawUrl: string, token?: string): string {
  const encode = (user: string, password: string): string =>
    `Authorization: Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  if (token) return encode(token, '');
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      return encode(decodeURIComponent(parsed.username), decodeURIComponent(parsed.password));
    }
  } catch {
    /* 非标准 URL（git@host:org/repo）：本来就不带 http 凭据 */
  }
  return '';
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

/**
 * 把 origin 写成**不含任何凭据**的地址。
 *
 * 凭据不再经过 `.git/config`：每次需要凭据的 git 调用用 `-c http.extraheader=`
 * 在参数里带（见 authHeaderOf）。所以这里要做的只是「确保 config 里没有凭据」，
 * 而且这一步失败也不能让克隆算失败 —— 由调用方记降级审计。
 */
function writeCleanOrigin(target: string, rawUrl: string): boolean {
  try {
    git(target, ['remote', 'set-url', 'origin', stripCredentials(rawUrl)]);
    return true;
  } catch {
    return false;
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

/**
 * 在指定目录执行 git 命令，返回标准输出；失败时抛出带 stderr 的错误。
 *
 * `authHeader` 非空时以 `-c http.extraheader=...` 的形式作为**参数**传给 git：
 * 这样凭据只存在于本次进程的 argv 里，不会写进 `.git/config`，也不需要 `shell: true`
 * （拼 shell 字符串会把凭据暴露给注入面，得不偿失）。
 */
function git(cwd: string, args: string[], timeout = 20000, authHeader = ''): string {
  const configArgs: string[] = [];
  if (authHeader !== '') {
    /* 显式给了凭据，就不要让 credential helper（Git Credential Manager 等）插手：
     * 它在收到 401 时会**弹一个 GUI 对话框**等用户输入 —— 一个后台进程弹窗，
     * 用户看到的是「点了克隆然后一直转圈」；它还可能把自己缓存的凭据顶上去。
     * 置空 helper 后，凭据要么来自我们传的 header，要么直接 401 失败。 */
    configArgs.push('-c', 'credential.helper=', '-c', `http.extraheader=${authHeader}`);
  }
  const finalArgs = configArgs.length > 0 ? [...configArgs, ...args] : args;
  try {
    return execFileSync('git', finalArgs, {
      cwd, encoding: 'utf8', timeout, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      /* 后端是无终端的子进程：一旦 git 想交互（要账号密码 / 询问口令），
       * 它会一直等一个永远不会出现的输入 —— 表现为「点克隆后转圈到超时」。
       * 禁止交互后，凭据不对就是一条明确的 401 失败，而且立即返回。 */
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }).trim();
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const stderr = String(err?.stderr ?? '').trim();
    const hint = stderr || String(err?.message ?? 'git 执行失败');
    throw new ApiFailure('E_GIT_FAILED', `git ${args[0]} 失败：${hint.slice(0, 400)}`);
  }
}

/** 统计仓库内文件数（跳过 .git 与 node_modules）。 */
function walkCount(root: string): number {
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
 * countFiles 的结果缓存（60 秒，按 repoRoot + 目录 mtime 失效）。
 *
 * 为什么要缓存：`repoStatus` 每被前端问一次就 walk 整仓（上限 20000 个文件），
 * 而前端刷新状态栏的频率是秒级 —— 一个万级文件的仓库会把主线程钉在同步 readdir 上。
 * 只认「仓库根目录的 mtime」是有意的保守近似：新增 / 删除顶层项会失效，
 * 深层文件增删最多晚 60 秒反映到数字上（这个数字只用于展示，不参与任何判定）。
 */
const COUNT_CACHE_TTL_MS = 60_000;
let countCache: { key: string; at: number; count: number } | null = null;

function countFiles(root: string): number {
  let signature = '';
  try {
    signature = `${path.resolve(root)}|${fs.statSync(root).mtimeMs}`;
  } catch {
    signature = `${path.resolve(root)}|?`;
  }
  const now = Date.now();
  if (countCache && countCache.key === signature && now - countCache.at < COUNT_CACHE_TTL_MS) {
    return countCache.count;
  }
  const count = walkCount(root);
  countCache = { key: signature, at: now, count };
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

  /* 同上：查不到归属就拒绝克隆，绝不把仓库 clone 到 workspaces/ 根下。 */
  const workspaceId = await assetWorkspaceId(input.assetId);
  if (workspaceId === '') throw new ApiFailure('E_NOT_FOUND', `资产不存在，无法确定克隆落点：${input.assetId}`);
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
  /* 凭据只在参数里：cleanUrl 会落进 .git/config，authHeader 用完即弃。 */
  const cleanUrl = stripCredentials(url);
  const authHeader = authHeaderOf(url, input.token);

  const sealOrigin = (): void => {
    if (writeCleanOrigin(target, url)) return;
    writeAudit({
      workspaceId, actor: '系统', source: 'system',
      action: 'repo.origin.redact', target: input.assetId,
      result: '降级', severity: 'warn',
      detail: `git remote set-url 失败：${relativePath}/.git/config 里的 origin 可能仍带凭据，请检查并手动改回不含凭据的地址`,
    });
  };

  if (canPull) {
    /* 已有克隆 → 拉最新。
     * ① 先把 origin 归一成无凭据地址（老版本可能已经把 token 写进 config）；
     * ② fetch 时用参数带凭据，不再动 config；
     * ③ 只有浅克隆才需要显式 --depth —— 全量克隆上带 --depth 会把它变成浅仓库。 */
    writeCleanOrigin(target, url);
    const fetchArgs = ['fetch'];
    if (depth > 0) fetchArgs.push('--depth', String(depth));
    fetchArgs.push('origin');
    git(target, fetchArgs, 20000, authHeader);
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
  /* 克隆用**无凭据**地址 + 参数里的 header：git 会把命令行上的 URL 写进 config，
   * 带 token 的 URL 会就地留在磁盘上。 */
  args.push(cleanUrl, target);
  git(wsRoot, args, CLONE_TIMEOUT_MS, authHeader);

  /* 兜底再确认一次 config 里没有凭据（用户填的地址可能自带 user:pass）。 */
  sealOrigin();

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
