/**
 * 测试专用聚合入口（仅 tests/agent-tools.mjs 消费）。
 *
 * 为什么需要它：esbuild 每次打包都是独立模块图——write-executor 和 database
 * 分开打包就是两份模块状态，initDatabase 只会初始化其中一份。
 * 聚合成一个入口打包，全链路共享同一个 DB 连接与模块状态。
 * 该文件不参与业务构建（tsconfig include 不含 tests/）。
 */
export * from '../server/src/db/database';
export { initDemoDatabase } from '../server/src/db/demo';
export { seedIfEmpty, ensureAgentV9Assets } from '../server/src/db/seed';
export { bootstrapRepo, REPO_ROOT } from '../server/src/sandbox/bootstrap';
export { ensureFtsTable, runIndex } from '../server/src/services/indexer';
export { deriveToolFace, gatewayToolFace, TOOL_CATALOG } from '../server/src/config/tool-catalog';
export { executeAgentTool, API_ENDPOINTS } from '../server/src/services/agent-tools';
export { executeFileWrite, executeDbWrite, executeSrvTemplate, rollbackWritePlan } from '../server/src/services/write-executor';
export {
  grantSessionApproval, hasSessionApproval, clearSessionApprovals,
  approvalKeyOf, recordWriteDeny, recordWriteSuccess,
  breakerTripped, breakerStatus, DENY_BREAKER_THRESHOLD,
} from '../server/src/services/session-approvals';
export { matchTemplate, validateParams, CMD_TEMPLATES } from '../server/src/config/cmd-templates';
export { initLogSink, appendLog, readLogLines, rotateLog, restoreLogBackup, LOG_FILE } from '../server/src/services/log-sink';
export { runSqlQuery } from '../server/src/services/sql-query';
