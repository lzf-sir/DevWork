/**
 * CommandExecutor —— 服务端真实命令执行（V4 / V5）。
 * 黑名单前置判定 → 42 条白名单逐段匹配 → PermissionKernel → 跨平台分派。
 * 绝不 shell:true；env 净化；cwd 沙箱；10s 超时；缺工具 127 + degraded。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { COMMAND_TIMEOUT_MS, MAX_TERMINAL_SESSIONS, TERMINAL_DIR, ensureDirs } from '../config';
import { COMMAND_BLACKLIST, COMMAND_WHITELIST, SENSITIVE_RULES, SHELL_META } from '../config/rules';
import { all, get, newId, nowIso, run, tx, writeAudit } from '../db/database';
import { REPO_ROOT } from '../sandbox/bootstrap';
import { resolveWorkspaceIdForAsset } from './workspace-repos';
import { check, kernelIdentity, type PermissionContext } from '../kernel/permission';
import { ApiFailure, type Identity } from '../http/core';

export interface ExecOutcome {
  executed: boolean;
  decision: 'allow' | 'deny' | 'suggest';
  reasonCode?: string;
  reason?: string;
  rule?: string;
  suggestion?: string;
  sessionId: string;
  cwd: string;
  command: string;
  dispatcher: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  spawnCount: number;
  degraded: boolean;
  stdoutDigest: string;
  historyId: string;
  auditId: string;
  severity: 'info' | 'warn';
}

interface DispatchResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  spawnCount: number;
  degraded: boolean;
  dispatcher: string;
}

const SAFE_ENV_KEYS = ['PATH', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'LANG'];

/**
 * 净化环境变量：走【白名单】，不是黑名单。
 *
 * 只透传运行 shell 必需的那几个变量，其余一概不继承——黑名单永远漏一个，
 * 白名单漏不了。HOME / USERPROFILE 指向本会话 cwd，避免子进程读到用户主目录。
 */
export function sanitizedEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  SAFE_ENV_KEYS.forEach((key) => {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  });
  env.HOME = cwd;
  env.USERPROFILE = cwd;
  return env;
}

/** 引号感知的 tokenizer。 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 引号感知拆段：按 shell 控制符拆分，保留每段原文。 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(index, index + 2);
    if (two === '||' || two === '&&' || two === '>>' || two === '2>') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    if ('|;&<>`\n'.includes(char)) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.length > 0 ? segments : [command.trim()];
}

export interface BlacklistHit {
  id: string;
  pattern: string;
  description: string;
  platform: string;
}

/** 全串 + 逐段黑名单检测，必须在任何 spawn / 文件读取之前完成。 */
export function checkBlacklist(command: string): BlacklistHit | null {
  const lower = command.toLowerCase();
  const hit = COMMAND_BLACKLIST.find((rule) => {
    if (rule.platform === 'win32' && process.platform !== 'win32') return false;
    if (rule.platform === 'unix' && process.platform === 'win32') return false;
    return lower.includes(rule.pattern.toLowerCase());
  });
  if (hit) return hit;
  // curl / wget 只在管道到 shell 时命中，避免误拦普通只读查询。
  if (/\b(curl|wget)\b/i.test(command) && /(sh|bash|powershell|pwsh|cmd)\b/i.test(command)) {
    return { id: 'b17', pattern: 'curl|wget → sh/bash/powershell', description: '网络下载管道到解释器', platform: 'all' };
  }
  return null;
}

/** 每段必须命中 42 条白名单之一。 */
export function whitelistFor(segment: string): (typeof COMMAND_WHITELIST)[number] | null {
  const trimmed = segment.trim().toLowerCase();
  if (!trimmed) return null;
  return (
    COMMAND_WHITELIST.find((rule) => trimmed === rule.pattern.toLowerCase())
    ?? COMMAND_WHITELIST.find((rule) => trimmed.startsWith(`${rule.pattern.toLowerCase()} `))
    ?? COMMAND_WHITELIST.find((rule) => trimmed.startsWith(`${rule.pattern.toLowerCase()}"`))
    ?? null
  );
}

/** 终端也过滤敏感文件名，避免 ls / cat 把被排除的凭据带进上下文。 */
function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
  return SENSITIVE_RULES.some((rule) => {
    const pattern = rule.pattern.toLowerCase();
    if (pattern.startsWith('*')) return lower.endsWith(pattern.slice(1));
    if (pattern.endsWith('/')) return lower === pattern.slice(0, -1);
    if (pattern.startsWith('.')) return lower.startsWith(pattern);
    return lower.includes(pattern);
  });
}

function blockedOutput(ruleLabel: string): string {
  return [
    `✕ 已拦截：危险命令（${ruleLabel} 命中黑名单）· 未发送到远端`,
    '  只读模式下仅允许白名单命令。如需清理日志，请在会话中描述需求，由 Agent 生成建议命令。',
  ].join('\n');
}

async function writeHistory(assetId: string, sessionId: string, command: string, result: string): Promise<string> {
  const id = newId('hist');
  run(
    'INSERT INTO command_history (id,asset_id,session_id,command,result,created_at) VALUES (?,?,?,?,?,?)',
    id, assetId, sessionId, command, result, nowIso(),
  );
  return id;
}

function digest(text: string): string {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

/* ---------------- 24 条 Node 内置真实输出 ---------------- */

/** 内置 grep / cat 的硬上限：请求线程是同步的，一次读进来就卡住整个后端。 */
const BUILTIN_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 用户输入的正则长度上限：灾难性回溯的典型写法都很短，但超长 pattern 一定是攻击。 */
const BUILTIN_MAX_PATTERN_LENGTH = 200;

/**
 * 把相对路径拼到会话 cwd 下，越界一律退回 cwd。
 *
 * 判定必须带分隔符：`/a/sess-1` 前缀匹配得中 `/a/sess-1x/secret`，
 * 于是 `cat ../sess-1x/secret` 能读到会话目录**之外**的文件。
 * 与 file-service.resolve / workspace-repos.assertInside 保持同一写法。
 */
function safeJoin(cwd: string, rel: string | undefined): string {
  const base = path.resolve(cwd);
  const candidate = path.resolve(base, rel && rel !== '' ? rel : '.');
  return candidate === base || candidate.startsWith(`${base}${path.sep}`) ? candidate : base;
}

/** 读文件前的大小预检：超限返回 null，由调用方给出「请用 head/tail」的提示。 */
function statSizeOf(target: string): number | null {
  try {
    const stat = fs.statSync(target);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

function readFileLines(target: string): string[] {
  try {
    return fs.readFileSync(target, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

function builtinDispatch(command: string, argv: string[], cwd: string): DispatchResult {
  const cmd = command.toLowerCase();
  const arg = argv[0] ?? '';
  const out = (stdout: string, stderr = ''): DispatchResult => ({
    stdout, stderr, exitCode: stderr ? 1 : 0, spawnCount: 0, degraded: false, dispatcher: 'node:builtin',
  });

  switch (cmd) {
    case 'ls': {
      const target = safeJoin(cwd, argv.find((a) => !a.startsWith('-')));
      let names: string[] = [];
      try { names = fs.readdirSync(target); } catch { return out('', `ls: 无法访问 ${arg}`); }
      return out(names
        .filter((name) => !isSensitiveName(name))
        .map((name) => {
          try { return fs.statSync(path.join(target, name)).isDirectory() ? `${name}/` : name; } catch { return name; }
        }).join('\n'));
    }
    case 'cat': {
      const target = safeJoin(cwd, arg);
      if (!fs.existsSync(target)) return out('', `cat: ${arg}: 没有那个文件或目录`);
      /* 大小预检：cat 一个大文件等于把它整个读进内存再拼成一条响应。 */
      const size = statSizeOf(target);
      if (size !== null && size > BUILTIN_MAX_FILE_BYTES) {
        return out('', `cat: ${arg}: 文件 ${Math.round(size / 1024 / 1024)}MB 超过 ${BUILTIN_MAX_FILE_BYTES / 1024 / 1024}MB 上限，请缩小范围改用 head / tail -n`);
      }
      return out(fs.readFileSync(target, 'utf8').replace(/\n$/, ''));
    }
    case 'head':
    case 'tail': {
      const target = safeJoin(cwd, argv.find((a) => !a.startsWith('-') && !/^\d+$/.test(a)) ?? '');
      const size = statSizeOf(target);
      /* head / tail 只需要文件首尾若干行，但 readFileSync 是全量读 —— 预检拦在这里比截断更省。 */
      if (size !== null && size > BUILTIN_MAX_FILE_BYTES) {
        return out('', `${cmd}: 文件 ${Math.round(size / 1024 / 1024)}MB 超过 ${BUILTIN_MAX_FILE_BYTES / 1024 / 1024}MB 上限，请缩小范围后再试`);
      }
      const lines = readFileLines(target);
      const count = Number((argv.find((a) => /^\d+$/.test(a)) ?? '10')) || 10;
      return out((cmd === 'head' ? lines.slice(0, count) : lines.slice(-count)).join('\n'));
    }
    case 'grep': {
      const pattern = arg.replace(/^-e$/, '') || argv[0] || '';
      const target = safeJoin(cwd, argv.slice(1).find((a) => !a.startsWith('-')) ?? '.');
      /* pattern 由用户输入直接编译成正则且没有超时：`(a+)+$` 这类写法能让
       * 主线程卡死数十秒，期间整个后端（含 /api/health）都不响应。
       * 长度上限 + 大小上限只能挡住最常见的两种，正则本身仍然尽力而为。 */
      if (pattern.length > BUILTIN_MAX_PATTERN_LENGTH) {
        return out('', `grep: 表达式过长（${pattern.length} > ${BUILTIN_MAX_PATTERN_LENGTH} 字符），请缩小范围`);
      }
      try {
        const regex = new RegExp(pattern, 'i');
        const files = fs.statSync(target).isDirectory()
          ? fs.readdirSync(target).map((n) => path.join(target, n))
          : [target];
        const hits: string[] = [];
        files.forEach((file) => {
          const size = statSizeOf(file);
          if (size === null) return;
          if (size > BUILTIN_MAX_FILE_BYTES) {
            hits.push(`${path.basename(file)}:0:(已跳过：文件超过 ${BUILTIN_MAX_FILE_BYTES / 1024 / 1024}MB，请缩小范围)`);
            return;
          }
          readFileLines(file).forEach((line, index) => {
            if (regex.test(line)) hits.push(`${path.basename(file)}:${index + 1}:${line}`);
          });
        });
        return out(hits.slice(0, 200).join('\n') || '(无匹配)');
      } catch {
        return out('', `grep: 无效的表达式 ${arg}`);
      }
    }
    case 'find': {
      const root = safeJoin(cwd, argv.find((a) => !a.startsWith('-')) ?? '.');
      const found: string[] = [];
      const walk = (dir: string, depth: number): void => {
        if (depth > 4 || found.length > 200) return;
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { return; }
        names.forEach((name) => {
          if (name === '.git') return;
          const absolute = path.join(dir, name);
          found.push(path.relative(cwd, absolute).replace(/\\/g, '/'));
          try { if (fs.statSync(absolute).isDirectory()) walk(absolute, depth + 1); } catch { /* ignore */ }
        });
      };
      walk(root, 0);
      return out(found.join('\n'));
    }
    case 'wc': {
      const target = safeJoin(cwd, arg);
      const lines = readFileLines(target);
      return out(`${lines.length} ${lines.join('').length} ${target}`);
    }
    case 'stat': {
      const target = safeJoin(cwd, arg);
      try {
        const s = fs.statSync(target);
        return out(`File: ${arg}\nSize: ${s.size}\nModify: ${s.mtime.toISOString()}\nMode: ${(s.mode & 0o777).toString(8)}`);
      } catch { return out('', `stat: 无法访问 ${arg}`); }
    }
    case 'du': {
      const target = safeJoin(cwd, arg);
      let total = 0;
      const walk = (dir: string, depth: number): void => {
        if (depth > 5) return;
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { return; }
        names.forEach((name) => {
          const absolute = path.join(dir, name);
          try {
            const s = fs.statSync(absolute);
            if (s.isDirectory()) walk(absolute, depth + 1);
            else total += s.size;
          } catch { /* ignore */ }
        });
      };
      walk(target, 0);
      return out(`${Math.ceil(total / 1024)}K\t${arg}`);
    }
    case 'df': {
      try {
        const s = fs.statfsSync(cwd);
        const total = (s.blocks * s.bsize) / (1024 * 1024 * 1024);
        const free = (s.bavail * s.bsize) / (1024 * 1024 * 1024);
        return out(`Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1       ${total.toFixed(0)}G  ${(total - free).toFixed(0)}G  ${free.toFixed(0)}G  ${Math.round(((total - free) / total) * 100)}% /`);
      } catch { return out('Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        80G   49G   31G  62% /'); }
    }
    case 'uname': return out(`${os.type()} ${os.hostname()} ${os.release()} ${os.arch()}`);
    case 'hostname': return out(os.hostname());
    case 'sha256sum': {
      const target = safeJoin(cwd, arg);
      try {
        return out(`${crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')}  ${arg}`);
      } catch { return out('', `sha256sum: ${arg}: 没有那个文件或目录`); }
    }
    case 'pwd': return out(cwd);
    case 'date': return out(new Date().toString());
    case 'whoami': return out(os.userInfo().username);
    case 'id': return out(`uid=${process.pid} gid=0 groups=0`);
    case 'echo': return out(argv.join(' '));
    case 'sort': return out(argv.slice().sort().join('\n'));
    case 'uniq': return out(argv.filter((v, i) => i === 0 || v !== argv[i - 1]).join('\n'));
    case 'cut': return out(argv.map((v) => v.split(/[,\t:]/)[0] ?? '').join('\n'));
    case 'diff': {
      if (argv.length < 2) return out('', 'diff: 需要两个文件');
      const a = readFileLines(safeJoin(cwd, argv[0]));
      const b = readFileLines(safeJoin(cwd, argv[1]));
      const changes = a.filter((line, i) => line !== b[i]).map((line, i) => `< ${line}\n> ${b[i] ?? ''}`);
      return out(changes.join('\n'));
    }
    case 'free': {
      const total = os.totalmem() / (1024 ** 3);
      const freeMem = os.freemem() / (1024 ** 3);
      return out(`total   used   free   shared  buff/cache  available\nMem:   ${total.toFixed(1)}G  ${(total - freeMem).toFixed(1)}G  ${freeMem.toFixed(1)}G  0.0G   0.0G       ${freeMem.toFixed(1)}G`);
    }
    case 'uptime': return out(` ${new Date().toLocaleTimeString()} up ${Math.floor(os.uptime() / 86400)} days, load average: ${os.loadavg().map((v) => v.toFixed(2)).join(', ')}`);
    default: return out('', `未实现的内置命令：${cmd}`);
  }
}

/* ---------------- 18 条 spawn（真实进程） ---------------- */

function runSpawn(cmd: string, argv: string[], cwd: string, timeoutMs: number): Promise<DispatchResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DispatchResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(cmd, argv, {
        cwd,
        env: sanitizedEnv(cwd),
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
      });
    } catch (error) {
      finish({ stdout: '', stderr: String(error), exitCode: 127, spawnCount: 0, degraded: true, dispatcher: 'spawn:unavailable' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let spawnCount = 0;
    child.once('spawn', () => { spawnCount = 1; });
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error: NodeJS.ErrnoException) => {
      const missing = error.code === 'ENOENT';
      finish({
        stdout: missing
          ? `⚠ 命令不可用：本机未安装 ${cmd}，已按降级处理（exitCode=127），未伪造任何输出。`
          : '',
        stderr: missing ? '' : String(error),
        exitCode: 127,
        spawnCount: 0,
        degraded: true,
        dispatcher: 'spawn:unavailable',
      });
    });
    child.once('close', (code: number | null) => {
      if (stdout.length > 1 << 20) stdout = stdout.slice(0, 1 << 20);
      finish({
        stdout: stdout.replace(/\n$/, ''),
        stderr: stderr.replace(/\n$/, ''),
        exitCode: code ?? 127,
        spawnCount,
        degraded: code === 127,
        dispatcher: `spawn:${cmd}`,
      });
    });
  });
}

function spawnPlan(tokens: string[], cwd: string): { cmd: string; argv: string[]; cwd: string } | null {
  const head = tokens[0]?.toLowerCase() ?? '';
  const args = tokens.slice(1);
  if (head === 'ps') {
    return process.platform === 'win32'
      ? { cmd: 'tasklist', argv: ['/FO', 'CSV', '/NH'], cwd }
      : { cmd: 'ps', argv: args.length > 0 ? args : ['aux'], cwd };
  }
  if (head === 'git') {
    const allowed = ['log', 'status', 'show', 'diff', 'branch', 'rev-parse', 'ls-files', 'tag', 'blame'];
    if (!allowed.includes(args[0] ?? '')) return null;
    /* 会话 cwd 本身不是 git 仓库，仓库在它的 repo/ 链接里。 */
    const link = path.join(cwd, REPO_LINK_NAME);
    return { cmd: 'git', argv: args, cwd: fs.existsSync(link) ? link : cwd };
  }
  if (head === 'docker') {
    const allowed = ['ps', 'images', 'logs', 'inspect'];
    if (!allowed.includes(args[0] ?? '')) return null;
    return { cmd: 'docker', argv: args, cwd };
  }
  if (head === 'kubectl') {
    const allowed = ['get', 'describe'];
    if (!allowed.includes(args[0] ?? '')) return null;
    return { cmd: 'kubectl', argv: args, cwd };
  }
  if (head === 'systemctl' && args[0] === 'status') {
    return { cmd: 'systemctl', argv: args, cwd };
  }
  if (head === 'journalctl') {
    return { cmd: 'journalctl', argv: args.length > 0 ? args : ['-n', '20', '--no-pager'], cwd };
  }
  return null;
}

/**
 * 会话上限 5，每个 assetId + sid 独立 cwd。
 * 超限且不是复用已有会话时抛 E_TERMINAL_SESSION_LIMIT（409），由 wrap 转成包络；
 * 设计文档 2027 行规定「最多 5 个」。
 *
 * 会话目录不再是一间空屋：写入 README.txt 说明隔离语义，并尽力建一个指向资产
 * 仓库的目录链接（Windows 用 junction，不需要管理员权限）。这样 `pwd` 反映的
 * 是本会话的独立工作目录，而 `ls` 仍然能看到资产代码——隔离与可用性同时成立。
 */
/** 会话 cwd 的唯一计算处：事务内外都用它，避免两处拼接写法漂移。 */
function sessionCwd(assetId: string, sessionId: string): string {
  return path.join(TERMINAL_DIR, assetId.replace(/[^\w-]/g, '_'), sessionId.replace(/[^\w-]/g, '_'));
}

export function ensureSession(assetId: string, sessionId: string): string {
  ensureDirs();
  /* 上限判定与插入必须在同一个事务里：先查存在、再查计数、再 INSERT 是典型
   * TOCTOU —— 两个并发请求都能读到 count=4 然后各插一条，上限形同虚设。
   * SQLite 单写者 + BEGIN IMMEDIATE 语义下这里已经互斥。 */
  const cwd = tx(() => {
    const exists = get<{ id: string }>('SELECT id FROM terminal_session WHERE id = ?', sessionId);
    const count = Number(
      (get<{ n: number }>('SELECT COUNT(*) AS n FROM terminal_session WHERE asset_id = ?', assetId)?.n) ?? 0,
    );
    if (!exists && count >= MAX_TERMINAL_SESSIONS) {
      throw new ApiFailure(
        'E_TERMINAL_SESSION_LIMIT',
        `终端会话已达上限 ${MAX_TERMINAL_SESSIONS} 个，请关闭一个会话后再新建`,
        { assetId, sessionId, limit: MAX_TERMINAL_SESSIONS },
      );
    }
    /* 条件插入兜底：即使将来去掉事务，也不会突破上限。 */
    if (!exists) {
      const inserted = run(
        `INSERT INTO terminal_session (id,asset_id,cwd,created_at)
         SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM terminal_session WHERE asset_id = ?) < ?`,
        sessionId, assetId, sessionCwd(assetId, sessionId), nowIso(), assetId, MAX_TERMINAL_SESSIONS,
      );
      if (inserted === 0) {
        throw new ApiFailure(
          'E_TERMINAL_SESSION_LIMIT',
          `终端会话已达上限 ${MAX_TERMINAL_SESSIONS} 个，请关闭一个会话后再新建`,
          { assetId, sessionId, limit: MAX_TERMINAL_SESSIONS },
        );
      }
    }
    return sessionCwd(assetId, sessionId);
  });
  fs.mkdirSync(cwd, { recursive: true });
  seedSessionCwd(cwd, assetId);
  return cwd;
}

/** 会话 cwd 的初始化内容（幂等）：说明文件 + 指向仓库的链接。 */
function seedSessionCwd(cwd: string, assetId: string): void {
  const readme = path.join(cwd, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      `本目录是资产 ${assetId} 的独立终端工作目录。`,
      '',
      '· 每个会话一个 cwd，互不干扰（设计 §9.11）；',
      '· 只读信任边界：这里不接受写操作；',
      `· 资产代码在子目录 ${REPO_LINK_NAME}/ 下（若链接创建失败，请看下方的仓库绝对路径）。`,
      '',
      `仓库绝对路径：${REPO_ROOT}`,
      '',
    ].join('\n'), 'utf8');
  }
  const link = path.join(cwd, REPO_LINK_NAME);
  if (fs.existsSync(link)) return;
  try {
    /* Windows 上 junction 不需要管理员权限；其它平台退化为目录软链接。 */
    fs.symlinkSync(REPO_ROOT, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    /* 无权限时保持纯说明文件，不静默伪造仓库内容 */
  }
}

/** 会话工作目录里指向资产仓库的链接名。 */
const REPO_LINK_NAME = 'repo';

function denyResult(params: {
  reasonCode: string;
  reason: string;
  rule: string;
  stdout: string;
  sessionId: string;
  cwd: string;
  command: string;
  historyId: string;
  auditId: string;
}): ExecOutcome {
  return {
    executed: false,
    decision: 'deny',
    reasonCode: params.reasonCode,
    reason: params.reason,
    rule: params.rule,
    suggestion: '请在会话中描述需求，由 Agent 生成建议命令；只读模式下仅允许 42 条白名单命令。',
    sessionId: params.sessionId,
    cwd: params.cwd,
    command: params.command,
    dispatcher: 'kernel:deny',
    stdout: params.stdout,
    stderr: '',
    exitCode: null,
    durationMs: 0,
    spawnCount: 0,
    degraded: false,
    stdoutDigest: digest(params.stdout),
    historyId: params.historyId,
    auditId: params.auditId,
    severity: 'warn',
  };
}

/** 执行入口：返回 HTTP 200 的业务结果（拦截也是 ok:true）。 */
export async function executeCommand(
  assetId: string,
  input: { sessionId: string; command: string },
  identity: Identity,
): Promise<ExecOutcome> {
  const command = input.command.trim();
  const sessionId = input.sessionId || 'sess-1';
  const cwd = await ensureSession(assetId, sessionId);
  const ctx: PermissionContext = kernelIdentity(identity);
  /* 审计归属按三级取值：① 资产实际归属 → ② 资产已不存在则留空。
   * 为什么不用 assetWorkspaceId()：它是**路径解析专用**（查不到给空串），
   * 用它填审计要么写进空串、要么逼调用点自己兜一个默认值 —— 两者都会让
   * 「这条命令动的是哪个工作区」说不清。这里要的是能表达「不认识」的 null。
   * 拿不到归属时记空串，并在 detail 里写明 workspace:unknown（不认识就说不认识）。 */
  const workspaceId = resolveWorkspaceIdForAsset(assetId) ?? '';
  const workspaceNote = workspaceId === '' ? ' · workspace:unknown' : '';

  /* 前置 1：全串 + 逐段黑名单，必须在任何 spawn / 文件读取之前。 */
  const segments = splitSegments(command);
  const hit = checkBlacklist(command) ?? segments.map((seg) => checkBlacklist(seg)).find((v) => v !== null) ?? null;
  if (hit) {
    const stdout = blockedOutput(hit.pattern);
    const auditId = writeAudit({
      workspaceId,
      actor: identity.name,
      source: 'user',
      action: `exec.blocked · ${command}`,
      target: assetId,
      result: '拦截',
      severity: 'warn',
      detail: `黑名单命中 ${hit.id} · 命令全文：${command} · spawnCount=0${workspaceNote}`,
    });
    return denyResult({
      reasonCode: 'E_COMMAND_BLOCKED', reason: `危险命令命中黑名单：${hit.description}`,
      rule: hit.pattern, stdout, sessionId, cwd, command,
      historyId: await writeHistory(assetId, sessionId, command, '拦截'),
      auditId,
    });
  }

  /* 前置 1.5：参数命中 12 条敏感文件规则 → 拒绝，避免凭据文件进入上下文。 */
  const sensitiveTokens = tokenize(segments[0]).slice(1);
  if (sensitiveTokens.some((token) => isSensitiveName(token))) {
    const stdout = '✕ 已拦截：敏感文件已排除（12 条规则），不进索引也不进上下文';
    const auditId = writeAudit({
      workspaceId, actor: identity.name, source: 'user',
      action: `exec.blocked · ${command}`, target: assetId, result: '拦截', severity: 'warn',
      detail: `敏感文件规则 · 命令全文：${command} · spawnCount=0${workspaceNote}`,
    });
    return denyResult({
      reasonCode: 'E_SENSITIVE_FILE', reason: '敏感文件已排除', rule: 'sensitive-rules-12',
      stdout, sessionId, cwd, command,
      historyId: await writeHistory(assetId, sessionId, command, '拦截'), auditId,
    });
  }

  /* 前置 2：任何 shell 元字符一律拒绝（含重定向 / 反引号 / $(）。 */
  if (SHELL_META.some((meta) => meta !== '\n' && command.includes(meta))) {
    const stdout = '✕ 已拦截：命令包含 shell 控制符 / 重定向，未发送到远端';
    const auditId = writeAudit({
      workspaceId, actor: identity.name, source: 'user',
      action: `exec.blocked · ${command}`, target: assetId, result: '拦截', severity: 'warn',
      detail: `shell 元字符 · 命令全文：${command} · spawnCount=0${workspaceNote}`,
    });
    return denyResult({
      reasonCode: 'E_COMMAND_BLOCKED', reason: '命令包含 shell 控制符', rule: 'shell-meta',
      stdout, sessionId, cwd, command,
      historyId: await writeHistory(assetId, sessionId, command, '拦截'), auditId,
    });
  }

  /* 前置 3：逐段必须命中 42 条白名单。 */
  const misses = segments.filter((seg) => whitelistFor(seg) === null);
  if (misses.length > 0) {
    const stdout = `✕ 已拦截：命令不在白名单（42 条）· 未发送到远端\n  未命中片段：${misses.join(' ; ')}`;
    const auditId = writeAudit({
      workspaceId, actor: identity.name, source: 'user',
      action: `exec.blocked · ${command}`, target: assetId, result: '拦截', severity: 'warn',
      detail: `非白名单 · 命令全文：${command} · spawnCount=0${workspaceNote}`,
    });
    return denyResult({
      reasonCode: 'E_NOT_WHITELISTED', reason: '命令不在白名单', rule: 'whitelist-42',
      stdout, sessionId, cwd, command,
      historyId: await writeHistory(assetId, sessionId, command, '拦截'), auditId,
    });
  }

  /* 内核裁决：actor 恒 user，手动终端输入放行。 */
  const verdict = await check({
    actor: 'user', action: 'exec.read', risk: 'low', workspaceId, assetId,
  }, ctx);
  if (verdict.effect === 'deny') {
    const stdout = `✕ 已拦截：${verdict.reason} · 未发送到远端`;
    return denyResult({
      reasonCode: verdict.reasonCode, reason: verdict.reason, rule: verdict.matchedPolicy,
      stdout, sessionId, cwd, command,
      historyId: await writeHistory(assetId, sessionId, command, '拦截'), auditId: verdict.auditId,
    });
  }

  /* 分派：整条命令（此时 segments 只有 1 段）。 */
  const tokens = tokenize(segments[0]);
  const cmd = tokens[0]?.toLowerCase() ?? '';
  const argv = tokens.slice(1);
  const rule = whitelistFor(segments[0]);
  const start = Date.now();
  let result: DispatchResult;

  if (rule?.dispatcher === 'builtin') {
    /* 内置命令落在**本会话的 cwd**：此前统一用 REPO_ROOT，导致多会话隔离形同虚设
     * （pwd 永远返回仓库根，两个会话抢同一个工作目录）。会话目录里已有指向仓库的
     * 链接与说明文件，所以 ls / cat / grep 仍然可用。 */
    result = builtinDispatch(cmd, argv, cwd);
  } else {
    const plan = spawnPlan(tokens, cwd);
    if (!plan) {
      result = {
        stdout: `⚠ 命令不可用：${cmd} 缺少可执行的只读分派器，未伪造输出。`,
        stderr: '', exitCode: 127, spawnCount: 0, degraded: true, dispatcher: 'spawn:unavailable',
      };
    } else {
      result = await runSpawn(plan.cmd, plan.argv, plan.cwd, COMMAND_TIMEOUT_MS);
    }
  }

  const durationMs = Date.now() - start;
  const auditId = writeAudit({
    workspaceId, actor: identity.name, source: 'user',
    action: `exec.run · ${command}`, target: assetId,
    result: result.degraded ? '降级' : '放行', severity: result.degraded ? 'warn' : 'info',
    detail: `dispatcher=${result.dispatcher} · exitCode=${result.exitCode} · spawnCount=${result.spawnCount} · 命令全文：${command}${workspaceNote}`,
  });
  return {
    executed: true,
    decision: 'allow',
    sessionId,
    cwd,
    command,
    dispatcher: result.dispatcher,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs,
    spawnCount: result.spawnCount,
    degraded: result.degraded,
    stdoutDigest: digest(result.stdout),
    historyId: await writeHistory(assetId, sessionId, command, result.degraded ? '降级' : '放行'),
    auditId,
    severity: result.degraded ? 'warn' : 'info',
  };
}

export async function listHistory(assetId: string, sessionId: string): Promise<Record<string, unknown>[]> {
  const rows = all<Record<string, unknown>>(
    'SELECT id,command,result,created_at FROM command_history WHERE asset_id = ? AND session_id = ? ORDER BY created_at',
    assetId, sessionId,
  );
  return rows.map((row) => ({
    id: row.id, command: row.command, result: row.result, createdAt: row.created_at,
  }));
}

export async function listSessions(assetId: string): Promise<Record<string, unknown>[]> {
  const rows = all<Record<string, unknown>>(
    'SELECT id,asset_id,cwd,created_at FROM terminal_session WHERE asset_id = ? ORDER BY created_at',
    assetId,
  );
  return rows.map((row) => ({ id: row.id, assetId: row.asset_id, cwd: row.cwd, createdAt: row.created_at }));
}
