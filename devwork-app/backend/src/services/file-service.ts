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
import { resolveRepoRoot, assetWorkspaceId } from './workspace-repos';
import { check, kernelIdentity } from '../kernel/permission';

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
  const workspaceId = await assetWorkspaceId(assetId);
  const verdict = await check({
    actor: 'user', action: 'file.write', risk: 'high', workspaceId, assetId, path: rel,
  }, kernelIdentity(identity));
  if (verdict.effect === 'deny') {
    throw new ApiFailure('E_PERMISSION_DENIED', verdict.reason);
  }
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const buffer = Buffer.from(content, 'utf8');
  fs.writeFileSync(absolute, buffer);
  const auditId = writeAudit({
    workspaceId, actor: identity.name, source: 'user',
    action: 'file.save · 用户手动保存', target: rel, result: '放行', severity: 'info',
    detail: `真实落盘 ${buffer.length} 字节 · diskChanged=true`,
  });
  return { path: rel, bytesWritten: buffer.length, diskChanged: true, auditId };
}

/** Agent 发起的写：无条件拒绝，磁盘零变更。 */
export async function agentWrite(assetId: string, rel: string, patch: string, identity: Identity): Promise<AgentWriteResult> {
  // 只做路径合法性检查，不触碰磁盘（连 open 都不做）。
  await resolve(assetId, rel);
  const workspaceId = await assetWorkspaceId(assetId);
  const verdict = await check({
    actor: 'agent', action: 'file.write', risk: 'high', workspaceId, assetId, path: rel, payload: { patch },
  }, { identityName: 'Agent', source: 'agent' });
  const auditId = writeAudit({
    workspaceId, actor: 'Agent', source: 'agent',
    action: 'file.agent-write · 已拦截', target: rel, result: '拦截', severity: 'warn',
    detail: `Agent 写操作恒拒绝 · bytesWritten=0 · diskChanged=false · auditId=${verdict.auditId} · 操作者=${identity.name}`,
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
}

export interface FileOutlineResult {
  symbols: OutlineSymbol[];
  references: string[];
  git: string[];
}

/** 递归收集仓库内非敏感文件（跳过 .git）。 */
function repoFiles(root: string, out: string[] = []): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    if (name === '.git' || name === 'node_modules') continue;
    const absolute = path.join(root, name);
    const rel = path.relative(root, absolute).replace(/\\/g, '/');
    let stat: fs.Stats;
    try { stat = fs.statSync(absolute); } catch { continue; }
    if (stat.isDirectory()) repoFiles(absolute, out);
    else if (!isSensitive(rel)) out.push(rel);
  }
  return out;
}

export async function fileOutline(assetId: string, rel: string): Promise<FileOutlineResult> {
  const root = path.resolve(await resolveRepoRoot(assetId));
  const absolute = await resolve(assetId, rel);
  let plain = '';
  try { plain = fs.readFileSync(absolute, 'utf8'); } catch { plain = ''; }

  /* 符号提取：逐行正则，保留行号（Java/TS/JS 通用近似：类/接口/方法/函数声明）。 */
  const symbols: OutlineSymbol[] = [];
  const seen = new Set<string>();
  const lineRegexps = [
    /(?:public|private|protected)?\s*(?:class|interface|enum)\s+(\w+)/,
    /(?:public|private|protected)\s+(?:static\s+)?[\w<>[\],\s]+\s+(\w+)\s*\(/,
    /(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
    /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/,
  ];
  plain.split(/\r?\n/).forEach((line, index) => {
    if (symbols.length >= 14) return;
    for (const regex of lineRegexps) {
      const match = regex.exec(line);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        const kind = /class|interface|enum/.test(regex.source) ? 'C' : 'M';
        symbols.push({ sg: kind, label: kind === 'C' ? match[1] : `${match[1]}(...)`, line: index + 1 });
        break;
      }
    }
  });
  if (symbols.length === 0) symbols.push({ sg: 'X', label: path.basename(rel), line: 1 });

  /* 引用真扫：除本文件外，其他仓库文件中出现符号名即计一次引用。 */
  const names = symbols.map((s) => s.label.replace(/\(\.\.\.\)$/, '')).filter((n) => n.length > 3);
  const referencingFiles = new Set<string>();
  for (const other of repoFiles(root)) {
    if (other === rel) continue;
    let content = '';
    try { content = fs.readFileSync(path.join(root, other), 'utf8'); } catch { continue; }
    if (names.some((name) => content.includes(name))) referencingFiles.add(other);
  }
  const references = [
    `被 ${referencingFiles.size} 个文件引用`,
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
  return { symbols, references, git };
}

/** 真实 git diff（B19）：对 HEAD 的工作区变更；git 不可用时如实报错。 */
export async function fileDiff(assetId: string, rel: string): Promise<{ diff: string; clean: boolean }> {
  const root = path.resolve(await resolveRepoRoot(assetId));
  await resolve(assetId, rel);
  let out = '';
  try {
    out = execFileSync('git', ['diff', 'HEAD', '--', rel], {
      cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true,
    }).trim();
  } catch {
    throw new ApiFailure('E_GIT_UNAVAILABLE', 'git 不可用，无法生成 diff');
  }
  return { diff: out, clean: out === '' };
}

export function patchId(): string {
  return newId('patch');
}
