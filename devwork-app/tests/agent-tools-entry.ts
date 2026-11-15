/**
 * 测试专用聚合入口（仅 tests/agent-tools.mjs 消费）。
 *
 * 为什么需要它：esbuild 每次打包都是独立模块图——write-executor 和 database
 * 分开打包就是两份模块状态，initDatabase 只会初始化其中一份。
 * 聚合成一个入口打包，全链路共享同一个 DB 连接与模块状态。
 * 该文件不参与业务构建（tsconfig include 不含 tests/）。
 */
export * from '../backend/src/db/database';
export { initDemoDatabase } from '../backend/src/db/demo';
export { seedIfEmpty, ensureAgentV9Assets } from '../backend/src/db/seed';
export { bootstrapRepo, REPO_ROOT } from '../backend/src/sandbox/bootstrap';
export { ensureFtsTable, runIndex } from '../backend/src/services/indexer';
export {
  deriveToolFace, gatewayToolFace, TOOL_CATALOG,
  LEGACY_TOOL_ALIASES, normalizeToolCall, validateToolCatalog, TOOL_FACE_BUDGET,
} from '../backend/src/config/tool-catalog';
export { executeAgentTool, API_ENDPOINTS } from '../backend/src/services/agent-tools';
export { executeFileWrite, executeFileStrReplace, executeFsManage, executeDbWrite, executeSrvTemplate, rollbackWritePlan } from '../backend/src/services/write-executor';
export { runSubagent } from '../backend/src/services/subagent';
export { searchBackend, searchWeb } from '../backend/src/services/web-search';
export { maskNonCode, extractSymbols, findOccurrences, lexLangOf, summarizeRefs, extractImports } from '../backend/src/services/code-lex';
export { splitDiffByFile, assembleDiff } from '../backend/src/services/git-diff';
export { diffRegion } from '../backend/src/services/text-diff';
export {
  grantSessionApproval, hasSessionApproval, clearSessionApprovals,
  approvalKeyOf, recordWriteDeny, recordWriteSuccess,
  breakerTripped, breakerStatus, DENY_BREAKER_THRESHOLD,
} from '../backend/src/services/session-approvals';
export { matchTemplate, validateParams, CMD_TEMPLATES } from '../backend/src/config/cmd-templates';
export { initLogSink, appendLog, readLogLines, rotateLog, restoreLogBackup, LOG_FILE } from '../backend/src/services/log-sink';
export { runSqlQuery } from '../backend/src/services/sql-query';
