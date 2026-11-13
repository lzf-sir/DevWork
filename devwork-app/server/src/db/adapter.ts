/**
 * 数据库运行时适配（T06 兜底）。
 *
 * 主选：系统 Node 22 独立进程 → node:sqlite（WAL）。
 * 兜底：运行时探测不到 node:sqlite（例如 Electron 33 内置 Node 20）时，
 *       尝试 sql.js WASM；仍不可用则给出明确中文诊断，由 main.cjs 的
 *       三级 Node 解析切换运行时。绝不静态 import 触发浏览器 stub。
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

const nodeRequire = createRequire(import.meta.url);

export interface DbOpenOptions {
  readOnly?: boolean;
}

/** 与 node:sqlite DatabaseSync 兼容的最小构造签名。 */
export type DbConstructor = new (filename: string, options?: DbOpenOptions) => DatabaseSync;

export type DbDriver = 'node:sqlite' | 'sql.js' | 'none';

let cachedCtor: DbConstructor | null = null;
let cachedDriver: DbDriver = 'none';
let cachedError = '';

/** 运行时探测 node:sqlite，不产生任何顶层静态依赖。 */
export function detectDriver(): DbDriver {
  if (cachedDriver !== 'none') return cachedDriver;
  try {
    const mod = nodeRequire('node:sqlite') as { DatabaseSync?: unknown };
    if (typeof mod.DatabaseSync === 'function') {
      cachedCtor = mod.DatabaseSync as DbConstructor;
      cachedDriver = 'node:sqlite';
      return cachedDriver;
    }
  } catch (error) {
    cachedError = error instanceof Error ? error.message : String(error);
  }
  try {
    const sqlJs = nodeRequire('sql.js') as { default?: unknown } | unknown;
    if (sqlJs) cachedDriver = 'sql.js';
  } catch {
    /* sql.js 未安装，走主选路径的中文诊断 */
  }
  return cachedDriver;
}

export function driverDiagnosis(): string {
  if (cachedDriver === 'node:sqlite') return '';
  return `当前运行时缺少 node:sqlite（${cachedError || 'Node < 22.5'}）。请设置 DEVWORK_NODE_BIN 指向系统 Node 22，或安装 sql.js 启用 Tier2 兜底。`;
}

/** 取得数据库构造器；无可用驱动时抛出可读错误，而不是让进程白屏。 */
export function sqliteCtor(): DbConstructor {
  detectDriver();
  if (cachedDriver === 'node:sqlite' && cachedCtor) return cachedCtor;
  throw new Error(driverDiagnosis());
}

export function hasWal(): boolean {
  return detectDriver() === 'node:sqlite';
}
