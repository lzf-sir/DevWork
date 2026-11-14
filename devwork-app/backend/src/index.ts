/**
 * DevWork 后端入口 —— 系统 Node 22 独立进程（T06 主选形态）。
 * 保持 app.listen(3001) 自启动；不导出 createServer 工厂给 Electron 主进程。
 * 仅新增 SIGINT/SIGTERM 优雅收尾：WAL checkpoint → 关库 → server.close()。
 */
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import { CORS_ORIGINS, DIST_DIR, HOST, PORT, distExists, ensureDirs } from './config';
import { initDatabase, closeDatabase, ensureColumn, normalizeAuditActors, run, dropLegacyAccountTables } from './db/database';
import { initDemoDatabase } from './db/demo';
import { seedIfEmpty, migrateLegacySettings, ensureAgentV9Assets } from './db/seed';
import { migrateAboutVersion, migrateCitations, migratePermScopeMemory, migrateSourceReadPosition } from './db/migrate';
import { bootstrapArtifacts, bootstrapRepo } from './sandbox/bootstrap';
import { ensureFtsTable, runDocIndex, runIndex } from './services/indexer';
import { initLogSink, appendLog, endLogSink } from './services/log-sink';
import { registerRoutes } from './routes/index';
import { startShadowScheduler, stopShadowScheduler, pruneShadowLedger } from './services/shadow-scheduler';
import { startAgentLoop, stopAgentLoop } from './services/agent-loop';
import { shellGate } from './http/shell-gate';
import { ApiFailure, ERROR_STATUS, fail } from './http/core';
import { detectDriver, driverDiagnosis } from './db/adapter';
import { settingRaw } from './db/repositories';
import { CLEAN_MODE } from './config';

/* ---------------- 进程级兜底（必须在任何启动动作之前注册） ----------------
 * 两个 handler 的策略**故意不同**，别合并成一个「都记录后继续」：
 *
 * ① unhandledRejection —— 记录后继续。未处理的拒绝通常只影响那一个请求
 *    （Express 4 不会把它转给错误中间件，所以那个请求会挂到前端超时），
 *    进程本身仍然可用。这条仍然**不能替代 wrap()**：它只保证「一个漏网的
 *    async 路由不会带走整个后端」，不保证那个请求能拿到错误包络。
 *    （handler 里拿不到对应的 req/res —— Node 只给 reason 与 promise，
 *    所以「交给 next(err)」在进程级无法实现，只能在路由内用 try/catch 做。）
 *
 * ② uncaughtException —— 记录后**尽力关库并退出**。走到这里说明异常已经穿透了
 *    所有同步调用栈，进程状态可能已损坏。继续跑会变成僵尸：`/api/health` 还答 200、
 *    界面还在、数据永不更新 —— 比直接死难排查得多。重启由桌面壳负责（main.cjs）。
 */
process.on('unhandledRejection', (reason: unknown) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  // eslint-disable-next-line no-console
  console.error('[DevWork] unhandledRejection（进程继续运行）:', detail);
  appendLog('ERROR', `unhandledRejection：${detail}`);
});
process.on('uncaughtException', (error: Error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  // eslint-disable-next-line no-console
  console.error('[DevWork] uncaughtException（进程将退出）:', detail);
  appendLog('ERROR', `uncaughtException：${detail}`);
  /* 尽力把 WAL 收干净再走：异常态下不能假设写入仍可用，所以整段吞异常。 */
  try { closeDatabase(); } catch {
    /* 关库失败也必须退出，不阻塞 */
  }
  process.exit(1);
});

/* ---------------- 启动前：运行时探测 + 数据层 ---------------- */
ensureDirs();
const driver = detectDriver();
if (driver === 'none') {
  // eslint-disable-next-line no-console
  console.error(`[DevWork] ${driverDiagnosis()}`);
  process.exit(1);
}
initDatabase(seedIfEmpty);
/* 旧版本的账号 / 成员 / 角色 / 策略表：账号体系已移除，这里清理残留。 */
dropLegacyAccountTables();
/* 派生管线需要 log / api 两类资产才能覆盖全部七组工具（幂等，老库也能补上）。
 * 干净模式跳过：这两个是演示资产（含连接/凭据/能力行），用户首启看到的应该是
 * 「空环境，等我接入真实资源」，不是「已经接好了两个我看不懂的资产」。 */
if (!CLEAN_MODE) ensureAgentV9Assets();
/* log_query / srv_log_tail 的真实数据源：服务端请求日志沉降到文件。 */
initLogSink();
/* 老业务库补列：引用要能点回原文，就必须存源文件路径与行号。 */
ensureColumn('citation', 'path', 'TEXT');
ensureColumn('citation', 'start_line', 'INTEGER');
ensureColumn('citation', 'end_line', 'INTEGER');
/* 接入资产时一并录入鉴权信息 → 凭据要记住「用的哪种鉴权」「哪个账号」。
 * 秘密本身仍只经 safeStorage 加密存本机，这里存的是方法名与账号名。 */
ensureColumn('credential_binding', 'auth_method', "TEXT NOT NULL DEFAULT ''");
ensureColumn('credential_binding', 'username', "TEXT NOT NULL DEFAULT ''");
/* 资产绑定会话：从代码库 / 数据 / 终端页唤起的会话默认挂在该资产上。 */
ensureColumn('conversation', 'asset_id', 'TEXT');
ensureColumn('conversation', 'asset_type', 'TEXT');

/* 扇出位点：这条事件被投给了哪张工单。
 * 用它而不是新表，是因为「投递」天然是事件的一个属性（谁收的、收没收），
 * 建成独立表后每次查「投了没」都要 JOIN 一次，而这一步在 tick 里每轮都跑。 */
ensureColumn('trigger', 'delivered_ticket_id', 'TEXT');
/* 扇出处理位点：空 = 这条事件还没被分发过。
 * 必须有它，否则「没有工单可投」的事件会每轮都被扫出来重判一次。 */
ensureColumn('trigger', 'fanout_at', 'TEXT');
/* 会话归档：archived_at 非空 = 已归档（侧栏隐藏，设置页可恢复 / 彻底删除）。 */
ensureColumn('conversation', 'archived_at', 'TEXT');
/* 内置浏览器：页面快照三列（前端回传当前页标题/正文，Agent 才能"看过"这一页）。 */
ensureColumn('source', 'next_fire_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('browser_state', 'page_title', "TEXT NOT NULL DEFAULT ''");
ensureColumn('browser_state', 'page_text', "TEXT NOT NULL DEFAULT ''");
ensureColumn('browser_state', 'page_captured_at', "TEXT NOT NULL DEFAULT ''");
migrateLegacySettings();
normalizeAuditActors();
ensureFtsTable();

if (CLEAN_MODE) {
  /* 干净模式：不生成任何演示素材。
   * demo.sqlite 只建表结构不插行（SQL 浏览功能需要表结构，用户接入真实库后即可用），
   * order-service 假仓库、假产物文件一律不生成 —— 这些是开发期的原型样本，
   * 不是用户的东西。用户接入自己的资产后，索引由真实文件重建。 */
  initDemoDatabase();
  // eslint-disable-next-line no-console
  console.log('[DevWork] 干净模式：已跳过沙箱仓库 / 产物播种');
} else {
  initDemoDatabase();
  bootstrapRepo();
  bootstrapArtifacts();
  runIndex('a-order-service');
  /* 知识库资产同样从磁盘真实重建：启动即把种子里的假 doc 块换成 docs/ 下的真文件，
   * 引用落点才可能点回原文。 */
  const docStats = runDocIndex('a-kb');
  /* 侧栏副标题跟着真实索引走：种子里的「3 片段」在重建索引后就是假的。 */
  run(
    'UPDATE asset SET subtitle = ? WHERE id = ?',
    `${docStats.files} 个文档 · ${docStats.chunks} 个片段`, 'a-kb',
  );
  // eslint-disable-next-line no-console
  console.log(`[DevWork] 知识库索引：${docStats.files} 个文档 / ${docStats.chunks} 个片段`);
}
/* 索引就绪后再整理历史引用：只有此时才能判断某个 locator 是否真的指向磁盘文件。 */
const citationFix = migrateCitations();
if (citationFix.fixed > 0 || citationFix.removed > 0) {
  // eslint-disable-next-line no-console
  console.log(`[DevWork] 引用整理：补齐定位 ${citationFix.fixed} 条 / 删除无落点 ${citationFix.removed} 条`);
}
/* 采集器位点曾被幂等键覆盖：清掉写坏的值，否则 terminal / sql 采集器永远采不到新行。 */
const positionFix = migrateSourceReadPosition();
if (positionFix.fixed > 0) {
  // eslint-disable-next-line no-console
  console.log(`[DevWork] 采集器位点整理：清理写坏位点 ${positionFix.fixed} 处`);
}
/* 审批档位曾有一个内核从未实现的「本会话内记住」：归一成真实生效的「按风险分级」，
 * 否则设置页会展示一个承诺了记忆却毫无记忆行为的档位。 */
const permScopeFix = migratePermScopeMemory();
if (permScopeFix.changed) {
  // eslint-disable-next-line no-console
  console.log('[DevWork] 审批档位已归一：本会话内记住 → 按风险分级');
}

/* 版本单源：老库的 setting.about.version 只在首启 seed 时写过一次，
 * 不覆盖的话升级后「关于」永远显示旧版本号（问不出出处的数字）。 */
const aboutFix = migrateAboutVersion();
if (aboutFix.changed) {
  // eslint-disable-next-line no-console
  console.log(`[DevWork] 关于页版本已对齐当前版本：${aboutFix.version}`);
}

/* ---------------- Express 应用 ---------------- */
const app = express();

app.use(cors({
  origin: CORS_ORIGINS,
  /* 纯本地工具，无登录态与跨源凭据；仅保留桌面壳令牌头。 */
  allowedHeaders: ['Content-Type', 'X-DevWork-Token'],
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
}));
app.use(express.json({ limit: '16mb' }));

/* 隐私 v1「会话留存」：定期清理过期的派生数据（上下文快照）。
 * 只删可重建的 context_snapshot；会话/消息/审计/产物一律不动。 */
function cleanupExpiredSnapshots(): void {
  try {
    const raw = String(settingRaw('privacy').v1 ?? '').trim();
    if (raw === '永久保留') return;
    const days = Number.parseInt(raw, 10) || Number(settingRaw('privacy').retentionDays ?? 30) || 30;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const removed = run('DELETE FROM context_snapshot WHERE created_at < ?', cutoff);
    if (removed > 0) {
      // eslint-disable-next-line no-console
      console.log(`[DevWork] 留存清理：删除 ${days} 天前的上下文快照 ${removed} 条`);
    }
  } catch {
    /* 清理失败不阻断启动。 */
  }
}
/* 影子链路账本留存：每一条用户消息都会落一条 trigger，桌面端跑一年就是几十万行。
 * 只删可重建的观测数据（decision / 已处置的 trigger / 空 thread），审计与工单一律不动。 */
function pruneShadowLedgerSafely(): void {
  try {
    const result = pruneShadowLedger();
    const total = result.decisions + result.triggers + result.threads + result.mandates + result.sqlTraces;
    if (total > 0) {
      // eslint-disable-next-line no-console
      console.log(`[DevWork] 影子账本留存清理：决策 ${result.decisions} / 触发 ${result.triggers} / 线程 ${result.threads} / 草案 ${result.mandates} / 慢查询 ${result.sqlTraces}`);
    }
  } catch {
    /* 清理失败不阻断启动。 */
  }
}
cleanupExpiredSnapshots();
pruneShadowLedgerSafely();
setInterval(cleanupExpiredSnapshots, 6 * 3600 * 1000).unref();
setInterval(pruneShadowLedgerSafely, 6 * 3600 * 1000).unref();

/** 服务端请求日志：requestId 可追溯（V7 佐证）。 */
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  const start = Date.now();
    res.on('finish', () => {
      const line = `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`;
      // eslint-disable-next-line no-console
      console.log(`[DevWork] requestId=${requestId} ${line}`);
      appendLog('INFO', line);
    });
  next();
});

/* 桌面壳门禁：软件模式（DEVWORK_SHELL_TOKEN 存在）下浏览器直连一律拒绝，
 * 必须通过 Electron 壳注入的 X-DevWork-Token 打开。必须先于 registerRoutes
 * 注册，否则路由会先应答、门禁形同虚设；开发模式（npm run dev）不设令牌，零影响。 */
app.use(shellGate());

registerRoutes(app);

/* P1 影子链路：只记录「本来会接哪些单」，不建工单、不派工、不执行。
 * 位置在路由装配之后、listen 之前 —— 早了数据库还没播种完（源要挂 workspace），
 * 晚了第一批事件要等下一个 tick。DEVWORK_SUPERAGENT=off 可整体关停。 */
const shadowBoot = startShadowScheduler();
// eslint-disable-next-line no-console
console.log(`[DevWork] 影子链路：${shadowBoot.reason}`);

/* P2：研判之后还要派单与执行。单独一个循环，reason 同上。
 * 注意它只在 has accepted mandate 时才建工单 —— 没有授权就没有工单。 */
const agentBoot = startAgentLoop();
// eslint-disable-next-line no-console
console.log(`[DevWork] Agent 循环：${agentBoot.reason}`);

/* 生产 / 桌面态：Express 托管 dist，与 /api 同源，零 CORS。 */
if (distExists()) {
  app.use(express.static(DIST_DIR, { index: false }));
  app.get('*', (req: Request, res: Response) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ ok: false, data: null, error: { code: 'E_NOT_FOUND', message: '未找到端点' } });
      return;
    }
    const indexFile = path.join(DIST_DIR, 'index.html');
    if (fs.existsSync(indexFile)) {
      res.sendFile(indexFile);
    } else {
      res.status(503).type('text/plain').send('DevWork 前端尚未构建，请先执行 npm run build');
    }
  });
} else {
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DevWork API</title></head>'
      + '<body style="font-family:sans-serif;padding:32px"><h2>DevWork REST 服务已启动</h2>'
      + '<p>前端开发态请访问 <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>。</p>'
      + '<p>健康检查：<a href="/api/health">/api/health</a></p></body></html>',
    );
  });
}

/* 统一错误兜底（避免把异常裸奔到客户端）。
 * 语义必须分开：body-parser 的 413 是「请求太大」，内部异常是「服务端故障」。
 * 早前一律回 400「请求体解析失败」，等于把服务器炸了说成用户填错了。 */
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error('[DevWork] unhandled error:', message);
  if (res.headersSent) return;
  /* body-parser 把超限标记在 error.type 上，不读它就只能靠文案猜。 */
  if ((error as { type?: string } | null)?.type === 'entity.too.large') {
    fail(res, 'E_PAYLOAD_TOO_LARGE', '请求体过大：请分批发送，或缩小附件后重试', 413);
    return;
  }
  /* 畸形 JSON 是**客户端**错误（400），不是服务端故障。body-parser 抛的是
   * SyntaxError + type='entity.parse.failed'，不单独认它就会一路掉到 E_INTERNAL 500，
   * 前端会把「我发错了」当成「服务器坏了」。
   * 同族的编码 / 字符集 / 中断错误同样是「请求本身不合格」，一并按 400 处理；
   * 413（entity.too.large）已在上一条返回，不会被这里抢走。 */
  const parserType = String((error as { type?: string } | null)?.type ?? '');
  const parseFailed = parserType === 'entity.parse.failed'
    || parserType === 'entity.verify.failed'
    || parserType === 'encoding.unsupported'
    || parserType === 'charset.unsupported'
    || parserType === 'request.aborted';
  if (parseFailed) {
    fail(res, 'E_VALIDATION', `请求体解析失败：${message}`, 400);
    return;
  }
  /* 既有 ApiFailure 的 code / status 不被改写（403 不能变 500）。 */
  if (error instanceof ApiFailure) {
    fail(res, error.code, error.message, ERROR_STATUS[error.code], error.details);
    return;
  }
  fail(res, 'E_INTERNAL', `服务端内部错误：${message}`, 500);
});

/* ---------------- 自启动独立进程 ---------------- */
const server = app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[DevWork] API listening on http://${HOST}:${PORT} · driver=${driver} · dist=${distExists() ? 'served' : 'dev-only'}`);
});
/**
 * 监听失败（端口被占 / 无权限）属**启动失败**，不是「运行期异常」。
 *
 * 必须在这里显式处理：不加的话 EADDRINUSE 会冒到 uncaughtException 兜底里，
 * 而那条路要关库、退出码也不一样；更糟的是万一被当成可恢复错误吞掉，
 * 桌面壳就会「连上一个不存在的服务」—— 窗口正常打开、所有请求失败，
 * 用户看到的是一堆 E_INTERNAL 而不是「端口 3001 被占用」。
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  const reason = error.code === 'EADDRINUSE'
    ? `端口 ${PORT} 已被占用（可能还有一个 DevWork 后端在跑），请关闭它或改用 DEVWORK_PORT 指定其它端口`
    : error.code === 'EACCES'
      ? `没有权限监听 ${HOST}:${PORT}（端口小于 1024 需要管理员权限）`
      : `监听 ${HOST}:${PORT} 失败：${error.message}`;
  // eslint-disable-next-line no-console
  console.error(`[DevWork] 启动失败 · ${reason}`);
  appendLog('ERROR', `启动失败 · ${reason}`);
  endLogSink();
  process.exit(1);
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  /* 先停两个循环：tick 里还有写库动作，晚停会撞上 checkpoint。 */
  stopAgentLoop();
  stopShadowScheduler();
  // eslint-disable-next-line no-console
  console.log(`[DevWork] ${signal} → WAL checkpoint + close`);
  const force = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn('[DevWork] 关闭超时，强制退出');
    /* 日志是异步追加流：退出前把缓冲刷出去，否则最后几行会丢。 */
    endLogSink();
    process.exit(0);
  }, 3000);
  force.unref();
  server.close(() => {
    closeDatabase();
    endLogSink();
    clearTimeout(force);
    // Windows 下 Electron 主进程等待这个 ack 才认定后端已优雅收尾。
    if (typeof process.send === 'function') {
      process.send({ type: 'devwork:shutdown-ack', signal });
    }
    // eslint-disable-next-line no-console
    console.log('[DevWork] 已优雅退出');
    process.exit(0);
  });
  // 关闭 keep-alive 连接，避免 server.close 回调被挂起。
  server.closeAllConnections?.();
  // 无活跃连接时 server.close 回调一般立即触发；兜底再做一次关库。
  setTimeout(() => {
    closeDatabase();
  }, 100).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
/** Windows 下 Electron 用 IPC 通知优雅收尾（SIGTERM 会被映射为 TerminateProcess）。 */
process.on('message', (message: unknown) => {
  if (message && typeof message === 'object' && (message as { type?: string }).type === 'devwork:shutdown') {
    shutdown('IPC shutdown');
  }
});
/**
 * 断线自清理（孤儿兕底）：Electron/tsx 外壳横死时（任务管理器结束、崩溃），
 * before-quit 不会触发、没人再发 devwork:shutdown —— 但 IPC 通道会随之断开，
 * 'disconnect' 就是"父链没了"的信号。自己走完 WAL checkpoint 后退出，
 * 不把端口 3001 和文件锁留给下一次启动收拾。
 */
process.on('disconnect', () => shutdown('parent-disconnect'));
