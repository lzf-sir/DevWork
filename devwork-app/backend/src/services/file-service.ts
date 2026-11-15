/**
 * FileService —— 用户手动保存是唯一真实落盘路径（V6）。
 * Agent 写恒 deny：bytesWritten=0 / diskChanged=false / 不触碰磁盘。
 *
 * 仓库根按资产解析（assets/<assetId> → 所属工作区的本地克隆目录），
 * 不再是全局单例 REPO_ROOT —— 这是「代码库 = 克隆到本地」的服务端落点。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ApiFailure, type Identity } from '../http/core';
import { isSensitive } from '../db/repositories';
import { newId, writeAudit } from '../db/database';
import { resolveRepoRoot, resolveWorkspaceIdForAsset } from './workspace-repos';
import { check, kernelIdentity } from '../kernel/permission';
import { extractSymbols, lexLangOf, maskNonCode } from './code-lex';

export interface SaveResult {
  path: string;
  bytesWritten: number;
  diskChanged: boolean;
  auditId: string;
}

export interface AgentWriteResult {
  decision: 'deny' | 'suggest';
  bytesWritten: 0;
  diskChanged: false;
  suggestion: string;
  auditId: string;
}

/** 路径解析 + 边界 / 敏感规则双重校验（边界锚在资产自己的仓库根上）。 */
export async function resolve(assetId: string, rel: string): Promise<string> {
  const root = path.resolve(await resolveRepoRoot(assetId));
  const normalized = String(rel ?? '').replace(/\\/g, '/');
  if (normalized === '' || path.isAbsolute(normalized) || normalized.startsWith('//')) {
    throw new ApiFailure('E_PATH_ESCAPE', '路径越界：仅允许仓库内相对路径');
  }
  if (normalized.split('/').includes('..')) {
    throw new ApiFailure('E_PATH_ESCAPE', '路径越界：不允许 .. 回退');
  }
  if (await isSensitive(normalized)) {
    throw new ApiFailure('E_SENSITIVE_FILE', '敏感文件已排除：命中 12 条规则，不进索引也不进上下文');
  }
  const absolute = path.resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new ApiFailure('E_PATH_ESCAPE', '路径越界：解析结果超出仓库根目录');
  }
  if (fs.existsSync(absolute)) {
    try {
      const real = fs.realpathSync(absolute);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
        throw new ApiFailure('E_PATH_ESCAPE', '路径越界：符号链接指向仓库外');
      }
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure('E_PATH_ESCAPE', '路径越界：realpath 校验失败');
    }
  }
  return absolute;
}

/** 用户手动保存：唯一真实写。先过 kernel（actor=user 恒 allow），再落盘，写 1 条审计。 */
export async function save(assetId: string, rel: string, content: string, identity: Identity): Promise<SaveResult> {
  const absolute = await resolve(assetId, rel);
  /* 审计归属用「资产真实归属」，拿不到就记空串 + workspace:unknown。
   * assetWorkspaceId() 是路径解析专用的（查不到给空串），它表达不了「不认识」，
   * 拿它填审计只会把这个判断推给调用点，迟早有人在那里补一个默认值。 */
  const workspaceId = resolveWorkspaceIdForAsset(assetId) ?? '';
  const workspaceNote = workspaceId === '' ? ' · workspace:unknown' : '';
  const verdict = await check({
    actor: 'user', action: 'file.write', risk: 'high', workspaceId, assetId, path: rel,
  }, kernelIdentity(identity));
  if (verdict.effect === 'deny') {
    throw new ApiFailure('E_PERMISSION_DENIED', verdict.reason);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const buffer = Buffer.from(content, 'utf8');
  /* 先读旧内容：`diskChanged` 承诺的是「磁盘上的字节变没变」，
   * 所以必须真的比一次。旧实现无条件返回 true —— 用户只是点了一下保存（内容没动）
   * 也会被记成「改过」，于是所有依赖这个字段的判断（审计、界面标记失效）全都在说谎。 */
  const previous = ((): string | null => {
    try { return fs.readFileSync(absolute, 'utf8'); } catch { return null; }
  })();
  fs.writeFileSync(absolute, buffer);
  const diskChanged = previous !== content;
  const auditId = writeAudit({
    workspaceId, actor: identity.name, source: 'user',
    action: 'file.save · 用户手动保存', target: rel, result: '放行', severity: 'info',
    detail: `真实落盘 ${buffer.length} 字节 · diskChanged=${diskChanged}${workspaceNote}`,
  });
  return { path: rel, bytesWritten: buffer.length, diskChanged, auditId };
}

/** Agent 发起的写：无条件拒绝，磁盘零变更。 */
export async function agentWrite(assetId: string, rel: string, patch: string, identity: Identity): Promise<AgentWriteResult> {
  // 只做路径合法性检查，不触碰磁盘（连 open 都不做）。
  await resolve(assetId, rel);
  const workspaceId = resolveWorkspaceIdForAsset(assetId) ?? '';
  const workspaceNote = workspaceId === '' ? ' · workspace:unknown' : '';
  const verdict = await check({
    actor: 'agent', action: 'file.write', risk: 'high', workspaceId, assetId, path: rel, payload: { patch },
  }, { identityName: 'Agent', source: 'agent' });
  const auditId = writeAudit({
    workspaceId, actor: 'Agent', source: 'agent',
    action: 'file.agent-write · 已拦截', target: rel, result: '拦截', severity: 'warn',
    detail: `Agent 写操作恒拒绝 · bytesWritten=0 · diskChanged=false · auditId=${verdict.auditId} · 操作者=${identity.name}${workspaceNote}`,
  });
  return {
    decision: 'deny',
    bytesWritten: 0,
    diskChanged: false,
    suggestion: `Agent 写操作被拦截，已生成 patch 建议（未落盘）：${rel}。请在编辑器中手动确认保存。`,
    auditId,
  };
}

/** 只生成 patch，绝不应用。 */
export async function generatePatch(assetId: string, rel: string, patch?: string): Promise<{ patch: string; applicable: false }> {
  await resolve(assetId, rel);
  const body = patch && patch.trim() !== ''
    ? patch
    : [
        `--- a/${rel}`,
        `+++ b/${rel}`,
        '@@ -39,8 +39,8 @@',
        '     HttpComponentsClientHttpRequestFactory f =',
        '         new HttpComponentsClientHttpRequestFactory();',
        '-    f.setConnectTimeout(800);',
        '-    f.setReadTimeout(2000);',
        '+    f.setConnectTimeout(1500);',
        '+    f.setReadTimeout(3500);',
        '     restTemplate.setRequestFactory(f);',
        '# 只读模式仅约束 Agent：以上为建议 patch，需你确认后手动落盘。',
      ].join('\n');
  return { patch: body, applicable: false };
}

/** 按扩展名给一个粗粒度语言标签（前端状态栏用）。 */
function languageOf(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  const map: Record<string, string> = {
    '.java': 'Java', '.xml': 'XML', '.yml': 'YAML', '.yaml': 'YAML',
    '.ts': 'TypeScript', '.tsx': 'TSX', '.js': 'JavaScript', '.jsx': 'JSX',
    '.py': 'Python', '.go': 'Go', '.md': 'Markdown', '.json': 'JSON',
    '.sql': 'SQL', '.css': 'CSS', '.html': 'HTML', '.sh': 'Shell',
  };
  return map[ext] ?? 'Text';
}

export async function readContent(assetId: string, rel: string): Promise<{ path: string; plain: string; html: string; gutterStart: number; language: string }> {
  const absolute = await resolve(assetId, rel);
  let plain = '';
  try {
    plain = fs.statSync(absolute).isFile() ? fs.readFileSync(absolute, 'utf8') : '';
  } catch {
    plain = '';
  }
  const escapeHtml = (value: string): string => value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = plain
    .split(/\r?\n/)
    .map((line, index) => `<span class="ln">${String(index + 1).padStart(2, ' ')} </span>${escapeHtml(line)}`)
    .join('\n');
  return {
    path: rel,
    plain,
    html,
    gutterStart: 1,
    language: languageOf(rel),
  };
}

export interface OutlineSymbol {
  sg: string;
  label: string;
  /** 符号所在行（1 起）。点击大纲项跳转到该行。 */
  line: number;
  /**
   * 符号结束行（1 起）。前端不用，但 Agent 的 `code_view(mode=outline)` 用它
   * 精确定位区间——没有它，模型只能"从头读"或靠猜。
   */
  endLine?: number;
  /** 所属容器（类名）。用来表达"这是哪个类的方法"，比扁平列表省一轮提问。 */
  container?: string;
}

export interface FileOutlineResult {
  symbols: OutlineSymbol[];
  references: string[];
  git: string[];
  /**
   * 引用扫描是否被截断（文件数 / 目录深度 / 单文件读取上限）。
   * 必须如实上报：不标 `truncated` 的「被 N 个文件引用」会被当成全仓事实。
   */
  truncated: boolean;
}

/** 仓库遍历上限：与 fileTree 同一口径，防「接了个万级文件仓库就卡死」。 */
const TREE_MAX_DEPTH = 8;
const TREE_MAX_ENTRIES = 2000;
/** 引用扫描只要「有没有出现符号名」，读前 256KB 足够，不必整个文件进内存。 */
const REFERENCE_SCAN_BYTES = 256 * 1024;

interface RepoFilesResult {
  files: string[];
  truncated: boolean;
}

/** 递归收集仓库内非敏感文件（跳过 .git / node_modules），带上限。 */
/**
 * 递归列出仓库内文件（仓库相对路径，`/` 分隔）。
 *
 * `base` 必须显式往下传：早期版本每次递归都拿**当前目录**当根算 `path.relative`，
 * 于是深层文件全变成纯文件名（`OrderController.java` 而不是
 * `src/main/java/order/OrderController.java`）。调用方再 `path.join(root, 文件名)`
 * 就指向一个不存在的路径，读取失败被 `catch { continue }` 吞掉——引用粗扫因此
 * 对**所有非根目录文件**静默返回 0，界面上看起来像"这个类没人用"。
 * 这种"错得很安静"的 bug 只能靠参数语义本身堵住，不能靠调用方小心。
 */
function repoFiles(
  root: string,
  out: string[] = [],
  depth = 0,
  state = { truncated: false },
  base = root,
): RepoFilesResult {
  if (depth > TREE_MAX_DEPTH) {
    state.truncated = true;
    return { files: out, truncated: state.truncated };
  }
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return { files: out, truncated: state.truncated }; }
  for (const name of names) {
    if (out.length >= TREE_MAX_ENTRIES) {
      state.truncated = true;
      break;
    }
    if (name === '.git' || name === 'node_modules') continue;
    const absolute = path.join(root, name);
    const rel = path.relative(base, absolute).replace(/\\/g, '/');
    let stat: fs.Stats;
    try { stat = fs.statSync(absolute); } catch { continue; }
    if (stat.isDirectory()) repoFiles(absolute, out, depth + 1, state, base);
    else if (!isSensitive(rel)) out.push(rel);
  }
  return { files: out, truncated: state.truncated };
}

export async function fileOutline(assetId: string, rel: string): Promise<FileOutlineResult> {
  const root = path.resolve(await resolveRepoRoot(assetId));
  const absolute = await resolve(assetId, rel);
  let plain = '';
  try { plain = fs.readFileSync(absolute, 'utf8'); } catch { plain = ''; }

  /**
   * 符号提取走词法层（code-lex）：先抹掉注释与字符串再判声明。
   *
   * 上一版是逐行正则直接扫原文，后果很具体：`// class FakeController` 这样一行注释
   * 会在侧边栏里多出一个可点击的符号，点了跳到一行注释。这类"看起来对、其实没有"
   * 的条目比缺失更消耗信任。
   *
   * 上限 40：侧栏是导航用的，再多也翻不过来；截断不可怕，**不说明截断**才可怕。
   */
  const lang = lexLangOf(rel);
  const mask = maskNonCode(plain, lang);
  const extracted = extractSymbols(mask.masked, plain, lang);
  const symbols: OutlineSymbol[] = extracted.slice(0, 40).map((item) => ({
    sg: item.kind === 'class' || item.kind === 'interface' || item.kind === 'enum' || item.kind === 'struct'
      ? 'C'
      : item.kind === 'function' || item.kind === 'method'
        ? 'M'
        : 'V',
    label: item.kind === 'function' || item.kind === 'method' ? `${item.name}(...)` : item.name,
    line: item.line,
    endLine: item.endLine,
    container: item.container,
  }));
  if (symbols.length === 0) symbols.push({ sg: 'X', label: path.basename(rel), line: 1 });

  /* 粗扫：除本文件外，其他仓库文件中出现符号名（子串）即计入一个文件。
   * 这一段的代价是「同步遍历 + 逐文件读」，请求期间会占住 Node 主线程 ——
   * 所以必须**有界**：文件数上限 + 每文件只读前 256KB + 命中够多就停。
   * 超限时如实返回 truncated=true，前端据此显示「扫描已截断」。 */
  const names = symbols.map((s) => s.label.replace(/\(\.\.\.\)$/, '')).filter((n) => n.length > 3);
  const referencingFiles = new Set<string>();
  const tree = repoFiles(root);
  let truncated = tree.truncated;
  for (const other of tree.files) {
    if (other === rel) continue;
    let content = '';
    try {
      const absoluteOther = path.join(root, other);
      const size = fs.statSync(absoluteOther).size;
      if (size > REFERENCE_SCAN_BYTES) truncated = true;
      const fd = fs.openSync(absoluteOther, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(size, REFERENCE_SCAN_BYTES));
        fs.readSync(fd, buffer, 0, buffer.length, 0);
        content = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch { continue; }
    if (names.some((name) => content.includes(name))) referencingFiles.add(other);
    /* 只要给出前几个例子，再往下扫只是浪费主线程时间。 */
    if (referencingFiles.size >= 50) {
      truncated = truncated || tree.files.length > referencingFiles.size + 1;
      break;
    }
  }
  /**
   * 这里的「引用」是**文件级粗扫**，措辞必须自己交代这件事。
   *
   * 判定只有三条弱证据叠起来：符号名长度 > 3、在本文件里是符号、在别的文件里
   * **作为子串**出现过。于是 `User` 会命中 `UserService`，注释里提一句也算，
   * `user.save()` 与 `order.save()` 更是分不开。
   *
   * 为什么不能改用精确扫描：精确扫描要逐符号抹注释再匹配，40 个符号就是 40 遍整仓，
   * 侧栏打开一次卡死几十秒。所以分工是——这一栏回答「大概去哪些文件找」，
   * 精确计数和跨文件归属由 `/files/refs`（点符号的「引」）按需给出。
   * 两处数字不一致是设计结果，不是 bug；但**不能都叫「引用」**，否则用户会
   * 以为其中一个算错了。
   */
  const references = [
    truncated
      ? `被至少 ${referencingFiles.size} 个文件提到（文件级粗扫已截断：仅前 ${TREE_MAX_ENTRIES} 个文件、每文件前 ${Math.round(REFERENCE_SCAN_BYTES / 1024)}KB）`
      : `被 ${referencingFiles.size} 个文件提到（文件级粗扫：子串命中、含注释与字符串、不区分同名符号）`,
    ...(referencingFiles.size > 0 ? Array.from(referencingFiles).slice(0, 3).map((f) => `· ${f}`) : []),
  ];

  /* per-file git 真查：git 不可用时如实标注。 */
  const gitArgs = ['log', '-1', '--pretty=format:%h|%ar|%an', '--', rel];
  let git: string[] = [];
  try {
    const raw = execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    if (raw) {
      const [hash, when, author] = raw.split('|');
      git = [`最后修改 ${hash}`, `${when} · ${author}`];
    }
  } catch {
    git = [];
  }
  if (git.length === 0) {
    let mtime = '';
    try { mtime = fs.statSync(absolute).mtime.toISOString().slice(0, 10); } catch { mtime = ''; }
    git = [mtime ? `最后落盘 ${mtime}` : '无 git 历史', 'git 不可用 · 本机文件时间'];
  }
  return { symbols, references, git, truncated };
}

export interface FileDiff {
  diff: string;
  /** diff 为空 **且** 文件已被 git 追踪。 */
  clean: boolean;
  /**
   * 文件未被 git 追踪（新增）。
   *
   * 为什么必须单独一档：`git diff HEAD` 永远不包含未追踪文件，于是"没有 diff"
   * 会被读成"没有改动"。但这两句话指向相反的动作——前者是"不用看"，
   * 后者是"必须看"。空 diff + 未追踪 ≠ clean。
   */
  untracked: boolean;
}

/**
 * 真实 git diff（B19）：对 HEAD 的工作区变更；git 不可用时如实报错。
 *
 * `maxBuffer` 必须显式给：execFileSync 默认 1MB，超过就抛 ENOBUFS。
 * 原来所有异常都被归成「git 不可用」——于是"这个文件改了 6MB"会被说成"git 没装"，
 * 而这两句话指向完全不同的下一步。现在把溢出单独成一个错，并给出绕行方式。
 */
export async function fileDiff(assetId: string, rel: string): Promise<FileDiff> {
  const root = path.resolve(await resolveRepoRoot(assetId));
  await resolve(assetId, rel);
  let out = '';
  let status = '';
  try {
    out = execFileSync('git', ['diff', 'HEAD', '--', rel], {
      cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }).trim();
    /* 只在 diff 为空时才问状态：有 diff 就说明已追踪且已改动，多跑一条 git 是浪费。 */
    if (out === '') {
      status = execFileSync('git', ['status', '--porcelain', '--', rel], {
        cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true,
      }).trim();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOBUFS') {
      throw new ApiFailure('E_DIFF_TOO_LARGE',
        `${rel} 的 diff 超过 8MB，无法一次装下。改用 code_view(mode=content) 读原文，`
        + '或缩小 path 范围（按目录/具体文件分开看）');
    }
    throw new ApiFailure('E_GIT_UNAVAILABLE', 'git 不可用，无法生成 diff');
  }
  const untracked = status.startsWith('??');
  return { diff: out, clean: out === '' && !untracked, untracked };
}

export interface RepoStatusEntry {
  /** porcelain 的两字符状态码（`M ` / ` M` / `??` / `R ` …）。 */
  code: string;
  path: string;
}

export interface RepoStatus {
  entries: RepoStatusEntry[];
  /** 命中敏感规则的条目数：只报数量，不回显路径。 */
  hiddenSensitive: number;
  truncated: boolean;
}

/**
 * 工作区状态（供 code_view mode=status）。
 *
 * 与 fileDiff 的分工：diff 回答"这个文件改了什么"，status 回答"这批活改到了哪些文件"。
 * 后者以前只能靠模型自己猜文件名一个个 diff，猜就是幻觉的入口。
 */
export async function repoStatus(assetId: string, relFilter?: string): Promise<RepoStatus> {
  const root = path.resolve(await resolveRepoRoot(assetId));
  if (relFilter) await resolve(assetId, relFilter);
  let raw = '';
  try {
    /* --untracked-files=all：目录级的 `?? dir/` 会把里面的文件藏起来，
     * 而"新增了哪些文件"正是要看的。 */
    raw = execFileSync('git', [
      'status', '--porcelain=v1', '--untracked-files=all', ...(relFilter ? ['--', relFilter] : []),
    ], { cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
  } catch {
    throw new ApiFailure('E_GIT_UNAVAILABLE', 'git 不可用，无法读取工作区状态');
  }

  const MAX = 40;
  const entries: RepoStatusEntry[] = [];
  let hiddenSensitive = 0;
  let truncated = false;
  for (const line of raw ? raw.split('\n') : []) {
    const code = line.slice(0, 2);
    /* 重命名是 `R  old -> new`：这里原样保留，拆开反而丢掉"从哪来"。 */
    const filePath = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!filePath) continue;
    if (isSensitive(filePath)) { hiddenSensitive += 1; continue; }
    if (entries.length >= MAX) { truncated = true; break; }
    entries.push({ code, path: filePath });
  }
  return { entries, hiddenSensitive, truncated };
}

export function patchId(): string {
  return newId('patch');
}
