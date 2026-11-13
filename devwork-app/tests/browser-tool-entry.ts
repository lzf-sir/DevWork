/**
 * 测试专用聚合入口（仅 tests/browser-tool.mjs 消费）。
 *
 * 与 agent-tools-entry.ts 同理：esbuild 每次打包是独立模块图，
 * database 与 services 必须打包进同一份，才能共享同一个 DB 连接与模块状态。
 */
export * from '../backend/src/db/database';
export { seedIfEmpty, ensureAgentV9Assets } from '../backend/src/db/seed';
export { initDemoDatabase } from '../backend/src/db/demo';
export { bootstrapRepo, bootstrapArtifacts } from '../backend/src/sandbox/bootstrap';
export { deriveToolFace } from '../backend/src/config/tool-catalog';
export { executeAgentTool } from '../backend/src/services/agent-tools';
export { normalizeBrowserUrl, readBrowserState, writeBrowserState, readBrowserPage, writeBrowserPage } from '../backend/src/services/browser';
