/**
 * REST 路由装配入口（G0–G11）。
 *
 * 原 1815 行单体路由已按域切分到同目录的 13 个模块，路由体未改写；
 * 本文件只保留装配顺序与兜底，新增端点请改对应域模块，不要再往这里堆。
 *
 * 契约要点：路径严格按架构定义；终端拦截属正常业务结果 → HTTP 200 + ok:true；
 * SQL Guard 拒绝 → 422 + E_SQL_REJECTED。
 */
import type { Express } from 'express';
import { fail } from '../http/core';
import { registerSystemRoutes } from './system';
import { registerWorkspaceRoutes } from './workspaces';
import { registerSidebarRoutes } from './sidebar';
import { registerAssetRoutes } from './assets';
import { registerConversationRoutes } from './conversations';
import { registerArtifactRoutes } from './artifacts';
import { registerBrowserRoutes } from './browser';
import { registerTerminalRoutes } from './terminal';
import { registerToolRoutes } from './tools';
import { registerSqlRoutes } from './sql';
import { registerFileRoutes } from './files';
import { registerSettingsRoutes } from './settings';
import { registerAuditRoutes } from './audit';

export function registerRoutes(app: Express): void {
  /* 装配顺序沿用原文件的相对次序：audit/export 先于 audit/:id、
   * workspaces/:id/switch 先于 workspaces/:id —— 前缀更宽的端点不能抢在前面。 */
  registerSystemRoutes(app);
  registerWorkspaceRoutes(app);
  registerSidebarRoutes(app);
  registerAssetRoutes(app);
  registerConversationRoutes(app);
  registerArtifactRoutes(app);
  registerBrowserRoutes(app);
  registerTerminalRoutes(app);
  registerToolRoutes(app);
  registerSqlRoutes(app);
  registerFileRoutes(app);
  registerSettingsRoutes(app);
  registerAuditRoutes(app);

  app.use('/api', (_req, res) => {
    fail(res, 'E_NOT_FOUND', '未找到对应的 REST 端点', 404);
  });
}
