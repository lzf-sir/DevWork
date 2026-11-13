import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** devwork-app 根目录。 */
export const ROOT = path.resolve(here, '../..');
/** server 根目录。 */
export const SERVER_ROOT = path.resolve(here, '..');
/* 数据目录与端口可被环境变量覆盖：自动化测试要能起一个用完即弃的实例，
 * 否则回归测试会把 QA 成员 / 测试会话永久写进用户的运行库（审查 P2-15）。 */
export const DATA_DIR = process.env.DEVWORK_DATA_DIR
  ? path.resolve(process.env.DEVWORK_DATA_DIR)
  : path.join(SERVER_ROOT, 'data');
/* 沙箱同理：测试会建终端会话、跑 git，这些都不该落在用户的 sandbox 里。 */
export const SANDBOX_DIR = process.env.DEVWORK_SANDBOX_DIR
  ? path.resolve(process.env.DEVWORK_SANDBOX_DIR)
  : path.join(SERVER_ROOT, 'sandbox');
export const REPOS_DIR = path.join(SANDBOX_DIR, 'repos');
export const TERMINAL_DIR = path.join(SANDBOX_DIR, 'terminal');
export const ARTIFACTS_DIR = process.env.DEVWORK_SANDBOX_DIR
  ? path.join(SANDBOX_DIR, 'artifacts')
  : path.join(SERVER_ROOT, 'artifacts');
export const DB_PATH = path.join(DATA_DIR, 'devwork.sqlite');
export const DEMO_DB_PATH = path.join(DATA_DIR, 'demo.sqlite');
export const SCHEMA_PATH = process.env.DEVWORK_SCHEMA_PATH
  ? path.resolve(process.env.DEVWORK_SCHEMA_PATH)
  : path.join(here, 'db', 'schema.sql');
export const DIST_DIR = path.join(ROOT, 'dist');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.DEVWORK_PORT ?? 3001);
export const CORS_ORIGINS = ['http://127.0.0.1:5173', 'http://localhost:5173'];

/**
 * 干净模式（打包态）。
 *
 * 打包出来的程序要交付给真实用户，库里**不应该躺着演示数据**：
 * 3 个写死的工作区、15 个假资产、6 个假会话、GMV 归因的假消息、
 * 还有 demo.sqlite 与 order-service 假仓库 —— 这些是开发期的原型素材，
 * 不是用户的东西。用户第一次打开看到的应该是「空环境，等我接入真实资源」。
 *
 * 打开后仍然会建**结构性骨架**（表结构、设置项、命令黑白名单、角色矩阵、
 * 策略、成员），这些是应用运行的必要配置，不是「假数据」——
 * 没有它们权限内核无法判定，设置页无法渲染。
 *
 * 开发态不打开：本地开发与自动化测试需要这些素材。
 */
export const CLEAN_MODE = process.env.DEVWORK_CLEAN === '1';
export const SQL_TIMEOUT_MS = 15000;
export const COMMAND_TIMEOUT_MS = 10000;
export const MAX_TERMINAL_SESSIONS = 5;

/**
 * Agent 的内置浏览器是否允许访问私有网段（127 / 10 / 172.16 / 192.168 / 本机名）。
 *
 * 默认**不允许** —— 借浏览器探本机与内网是 SSRF 的经典入口。
 * 但自托管场景里 Agent 要看内网 Wiki / 内部系统是常态，所以留一个显式开关：
 * 设 DEVWORK_BROWSER_ALLOW_PRIVATE=1 才放行（企业自管部署按需打开）。
 *
 * 读取放在函数体里而不是模块常量：进程启动后才设置 env 也能生效（测试与工具进程共用一套）。
 */
export function browserAllowPrivate(): boolean {
  return process.env.DEVWORK_BROWSER_ALLOW_PRIVATE === '1';
}

export function ensureDirs(): void {
  [DATA_DIR, SANDBOX_DIR, REPOS_DIR, TERMINAL_DIR, ARTIFACTS_DIR].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });
}

export function distExists(): boolean {
  return fs.existsSync(path.join(DIST_DIR, 'index.html'));
}
