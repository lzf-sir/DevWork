/**
 * 冒烟测试隔离运行器（审查 P2-15）。
 *
 * 为什么需要它：`tests/smoke.mjs` 是黑盒测试，直接对着运行实例写入——
 * 曾经把 11 条 qa-cn 成员、295 条消息、40 个产物永久写进用户库，
 * 席位一度显示 23/20。测试污染真实数据是不可接受的，所以：
 *
 *   1. 用临时目录当 DATA_DIR / SANDBOX_DIR（服务端支持环境变量覆盖）；
 *   2. 起独立端口（默认 3011），不碰正在用的 3001；
 *   3. 等 /api/health 就绪后跑 smoke.mjs；
 *   4. 无论成败都杀掉子进程；临时目录保留（失败时正是现场，成功时也无害），
 *      清理交给使用者 / CI，避免测试脚本自带"删目录"这种危险动作。
 *
 * 用法：`npm run test:smoke`（需要先 npm run build 让 dist 存在，
 * 否则静态资源相关用例会跳过/失败）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 3011);
const BASE = `http://127.0.0.1:${PORT}`;
/* 可选阶段过滤：`node tests/run-smoke.mjs shadow` 只跑影子链路。
 * 用位置参数而不是环境变量，是为了 Windows 上 `npm run` 不必依赖 cross-env。 */
const ONLY = (process.argv[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (stage) => ONLY.length === 0 || ONLY.includes(stage);
const RUN_DIR = path.join(ROOT, 'tmp', `qa-run-${Date.now()}`);
const DATA_DIR = path.join(RUN_DIR, 'data');
const SANDBOX_DIR = path.join(RUN_DIR, 'sandbox');

function log(message) {
  process.stdout.write(`[test:smoke] ${message}\n`);
}

async function waitHealthy(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function runSmoke() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'smoke.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWORK_BASE: BASE,
        DEVWORK_DATA_DIR: DATA_DIR,
        DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** 仓库克隆链路（真实 git clone → 按项目隔离 → 索引 → 检索 → 越界防护）。 */
function runRepoClone() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'repo-clone.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWORK_BASE: BASE,
        DEVWORK_DATA_DIR: DATA_DIR,
        DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** 数据库浏览能力（Navicat 式只读浏览层：对象树 / 排序 / 筛选 / DDL / 多格式导出 / 注入防护）。 */
function runDbBrowse() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'db-browse.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWORK_BASE: BASE,
        DEVWORK_DATA_DIR: DATA_DIR,
        DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** 资产接入表单（按类型差异化 + config 白名单与敏感键拒绝）。 */
function runAssetForms() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'asset-forms.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWORK_BASE: BASE,
        DEVWORK_DATA_DIR: DATA_DIR,
        DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** P2 工单链路（授权 → 建单 → 派工 → 报告 → 停止）。 */
function runTickets() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'tickets.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWORK_BASE: BASE,
        DEVWORK_DATA_DIR: DATA_DIR,
        DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** 任务清单 + 上下文压缩（原位更新 / 进度推导 / 折叠摘要 / 用量回退）。 */
function runContext() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'context.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWORK_BASE: BASE,
        DEVWORK_DATA_DIR: DATA_DIR,
        DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** P1 影子链路（Gate 各档位 + 频控 + 幂等 + 策略开关 + 统计口径）。 */
function runShadow() {  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tests', 'shadow.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWORK_BASE: BASE,
        DEVWORK_DATA_DIR: DATA_DIR,
        DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  log(`隔离数据目录：${RUN_DIR}`);
  log(`独立端口：${PORT}（不干扰 3001 上的实例）`);

  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'backend', 'src', 'index.ts')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DEVWORK_PORT: String(PORT),
        DEVWORK_DATA_DIR: DATA_DIR,
        DEVWORK_SANDBOX_DIR: SANDBOX_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += String(chunk); });
  server.stderr.on('data', (chunk) => { serverLog += String(chunk); });

  const cleanup = () => {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      /* 子进程可能在收尾（WAL checkpoint）；给 3s 再强杀，避免留下半开端口。 */
      setTimeout(() => { if (server.exitCode === null) server.kill('SIGKILL'); }, 3000).unref();
    }
    /* 刻意不删临时目录：自动化脚本自行递归删除目录风险过高（一旦变量错位就是
     * 灾难），保留几 MB 的现场远好过这种风险。需要清理时手动删 tmp/qa-run-*。 */
    log(`临时目录已保留：${RUN_DIR}（可手动清理）`);
  };

  let exitCode = 1;
  try {
    const healthy = await waitHealthy();
    if (!healthy) {
      log('服务未在 60s 内就绪，下面是它的日志：');
      process.stderr.write(serverLog.slice(-4000));
      exitCode = 1;
    } else {
      log(`服务就绪，开始跑用例${ONLY.length > 0 ? `（仅 ${ONLY.join(',')}）` : ''}`);
      const stages = [
        { name: 'smoke', label: '冒烟用例', run: runSmoke },
        { name: 'repo', label: '仓库克隆链路', run: runRepoClone },
        { name: 'db', label: '数据库浏览能力', run: runDbBrowse },
        { name: 'asset', label: '资产接入表单', run: runAssetForms },
        { name: 'context', label: '清单与上下文压缩', run: runContext },
        { name: 'shadow', label: '影子链路', run: runShadow },
        { name: 'tickets', label: '工单链路', run: runTickets },
      ];
      for (const stage of stages) {
        if (!want(stage.name)) continue;
        log(`${stage.label} 开始`);
        exitCode = await stage.run();
        if (exitCode !== 0) {
          log(`${stage.label} 失败（exit=${exitCode}），后续阶段跳过`);
          break;
        }
        log(`${stage.label} 通过`);
      }
    }
  } finally {
    cleanup();
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('[test:smoke] 运行器自身异常:', error);
  process.exit(2);
});
