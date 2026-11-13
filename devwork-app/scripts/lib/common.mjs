/**
 * 启动 / 打包脚本的公共工具。
 *
 * 为什么脚本用 Node 写而不是 .bat：
 *  - .cmd 的中文在 GBK 控制台里容易变乱码，Node 直接输出 UTF-8 没有这个问题；
 *  - 端口探测、依赖检查、目录复制这些逻辑在批处理里几乎写不动；
 *  - Windows / macOS / Linux 共用同一份逻辑，.bat / .sh 只是薄包装。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);

export const log = (text = '') => process.stdout.write(`${text}\n`);
export const step = (text) => log(`${paint('36', '▸')} ${text}`);
export const ok = (text) => log(`${paint('32', '✔')} ${text}`);
export const warn = (text) => log(`${paint('33', '!')} ${text}`);
export const fail = (text) => log(`${paint('31', '✘')} ${text}`);
export const title = (text) => {
  log('');
  log(paint('1', `── ${text} ─────────────────────────────────────────`));
};

/** npm 可执行名：Windows 下必须是 npm.cmd，否则 spawn 会被当成 bat 脚本。 */
export const npmBin = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

/** 同步执行一条命令（继承 stdio），失败即抛。 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`);
  }
  return result;
}

/** 静默执行（只取状态码），用于"存在即跳过"的判断。 */
export function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
  });
  return result.status === 0;
}

/** HTTP 探活：不受系统 http_proxy 影响（直接打 127.0.0.1）。 */
export async function probeHttp(url, timeoutMs = 1200) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

/** 等待某个地址就绪（打包后启动自检用）。 */
export async function waitForHttp(url, timeoutMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHttp(url, 1000)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/**
 * 前置门禁：Node 版本 + 依赖是否装好。
 *
 * Node 版本是硬门槛：后端用 node:sqlite（Node 22.5+ 才有），
 * 低版本会在启动时抛 "Cannot find module 'node:sqlite'"，与其到时候看堆栈，
 * 不如在这里一句话说清。
 */
export function preflight(root, { requireNode = 22, autoInstall = true } = {}) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < requireNode) {
    fail(`需要 Node ${requireNode} 及以上（后端依赖 node:sqlite），当前是 ${process.versions.node}`);
    log('  请到 https://nodejs.org 下载 LTS 版本后重试。');
    process.exit(1);
  }
  ok(`Node ${process.versions.node}`);

  const modules = path.join(root, 'node_modules');
  if (!fs.existsSync(path.join(modules, 'vite'))) {
    if (!autoInstall) {
      fail('依赖未安装，请先执行 npm install');
      process.exit(1);
    }
    step('依赖未安装，正在执行 npm install（首次会比较久）…');
    const hasLock = fs.existsSync(path.join(root, 'package-lock.json'));
    run(npmBin(), [hasLock ? 'ci' : 'install'], { cwd: root });
    ok('依赖安装完成');
  } else {
    ok('依赖已就绪');
  }
}

/**
 * 递归复制 node_modules 里的依赖闭包（生产运行时用）。
 *
 * 为什么不用 `npm install --omit=dev --prefix`：那需要联网解析版本，
 * 而这里直接把**当前已验证过**的那份依赖原样搬过去，版本不会漂。
 */
export function copyDependencyClosure(names, targetModulesDir, root) {
  const copied = new Set();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || copied.has(name)) continue;
    const source = path.join(root, 'node_modules', name);
    if (!fs.existsSync(source)) {
      /* 可选依赖（例如非本平台的 @esbuild/*）缺失是正常的，跳过即可。 */
      warn(`跳过缺失的可选依赖：${name}`);
      continue;
    }
    copied.add(name);
    const destination = path.join(targetModulesDir, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    queue.push(...Object.keys(manifest.dependencies ?? {}));
    queue.push(...Object.keys(manifest.optionalDependencies ?? {}));
  }
  return [...copied];
}

/** 递归复制目录（用于 staging 运行时产物）。 */
export function copyDir(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

/**
 * 删除目录。
 *
 * 为什么不用一行 fs.rmSync：部分环境（带回收站拦截的 CLI / 受控沙箱）会改写
 * rmSync 的行为，目录里混有只读文件或被占用文件时它会直接抛错，
 * 于是"清理暂存区"这种最不该失败的步骤把整个打包流程带崩。
 * 这里先试 rmSync，失败再逐项删。
 */
export function removeDir(target) {
  if (!fs.existsSync(target)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  } catch {
    /* 退回到逐项删除 */
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      removeDir(full);
      continue;
    }
    try {
      fs.unlinkSync(full);
    } catch {
      /* 删不掉的文件不阻塞打包 */
    }
  }
  try {
    fs.rmdirSync(target);
  } catch {
    /* 同上 */
  }
}

/** 列出目录下的直接子目录名。 */
export function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** 启动一个常驻子进程（stdout 继承，Ctrl+C 一起退出）。 */
export function spawnForeground(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: process.platform === 'win32',
  });
  const stop = () => {
    if (!child.killed) child.kill();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
  return child;
}
