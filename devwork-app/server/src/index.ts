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
import { migrateCitations } from './db/migrate';
import { bootstrapArtifacts, bootstrapRepo } from './sandbox/bootstrap';
import { ensureFtsTable, runDocIndex, runIndex } from './services/indexer';
import { initLogSink, appendLog } from './services/log-sink';
import { registerRoutes } from './routes/index';
import { shellGate } from './http/shell-gate';
import { detectDriver, driverDiagnosis } from './db/adapter';
import { settingRaw } from './db/repositories';
import { CLEAN_MODE } from './config';

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
/* 派生管线需要 log / api 两类资产才能覆盖全部七组工具（幂等，老库也能补上）。 */
ensureAgentV9Assets();
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
/* 会话归档：archived_at 非空 = 已归档（侧栏隐藏，设置页可恢复 / 彻底删除）。 */
ensureColumn('conversation', 'archived_at', 'TEXT');
/* 内置浏览器：页面快照三列（前端回传当前页标题/正文，Agent 才能"看过"这一页）。 */
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
cleanupExpiredSnapshots();
setInterval(cleanupExpiredSnapshots, 6 * 3600 * 1000).unref();

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

/* 统一错误兜底（避免把异常裸奔到客户端）。 */
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error('[DevWork] unhandled error:', message);
  if (!res.headersSent) {
    res.status(400).json({
      ok: false, data: null,
      error: { code: 'E_VALIDATION', message: `请求体解析失败：${message}` },
      meta: { requestId: randomUUID(), ts: Date.now(), apiMode: 'live' },
    });
  }
});

/* ---------------- 自启动独立进程 ---------------- */
const server = app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[DevWork] API listening on http://${HOST}:${PORT} · driver=${driver} · dist=${distExists() ? 'served' : 'dev-only'}`);
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  // eslint-disable-next-line no-console
  console.log(`[DevWork] ${signal} → WAL checkpoint + close`);
  const force = setTimeout(() => {
    // eslint-disable-next-line no-console
    console.warn('[DevWork] 关闭超时，强制退出');
    process.exit(0);
  }, 3000);
  force.unref();
  server.close(() => {
    closeDatabase();
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
