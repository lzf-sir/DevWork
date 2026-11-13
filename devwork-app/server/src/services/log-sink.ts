/**
 * LogSink —— Agent 日志工具组的真实数据后端。
 *
 * 为什么必须有这个文件：设计 §2.6 的 log_query / log_tail 需要「真实存在的日志」，
 * 而不是编造的假日志行。DevWork 服务端本来就在 console 打请求日志（index.ts），
 * 把同一份内容落一行结构化文本到 data/logs/devwork.log，日志工具就有真东西可查。
 *
 * 格式：ISO 时间戳 \t 级别 \t 消息（单行，写入前压平换行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config';

export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'devwork.log');

let initialized = false;

export function initLogSink(): void {
  if (initialized) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, [
      `${new Date().toISOString()}\tINFO\tDevWork 日志沉降器初始化（本文件是 log_query / log_tail 工具的真实数据源）`,
    ].join('\n') + '\n', 'utf8');
  }
  initialized = true;
}

/** 追加一行结构化日志；写入失败静默（日志工具不能反过来拖垮主服务）。 */
export function appendLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  if (!initialized) return;
  try {
    const line = `${new Date().toISOString()}\t${level}\t${message.replace(/[\r\n]+/g, ' ').slice(0, 500)}`;
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    /* 沉降失败不阻断业务 */
  }
}

export interface LogLine { ts: string; level: string; message: string; raw: string }

/** 读取全部日志行（文件不会太大：请求日志每行 ~100 字节，轮转见 rotate）。 */
export function readLogLines(): LogLine[] {
  if (!fs.existsSync(LOG_FILE)) return [];
  const raw = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  return raw.map((line) => {
    const [ts = '', level = '', ...rest] = line.split('\t');
    return { ts, level, message: rest.join('\t'), raw: line };
  });
}

/** 时间窗过滤：[fromIso, toIso]，任一为空表示不设界。 */
export function filterByWindow(lines: LogLine[], from?: string, to?: string): LogLine[] {
  return lines.filter((line) => {
    if (from && line.ts < from) return false;
    if (to && line.ts > to) return false;
    return true;
  });
}

/** 日志轮转：保留末尾 keepLines 行；备份是**全量快照**（回滚才能恢复完整文件）。 */
export function rotateLog(keepLines: number): { backupPath: string; removedLines: number } {
  initLogSink();
  const lines = readLogLines();
  const keep = lines.slice(-Math.max(1, keepLines));
  const removed = lines.length - keep.length;
  const backupPath = `${LOG_FILE}.bak-${Date.now()}`;
  /* 全量备份：被移除的行 + 保留的行都在，恢复 = 原样还原。 */
  fs.writeFileSync(backupPath, lines.map((l) => l.raw).join('\n') + (lines.length > 0 ? '\n' : ''), 'utf8');
  fs.writeFileSync(LOG_FILE, keep.map((l) => l.raw).join('\n') + (keep.length > 0 ? '\n' : ''), 'utf8');
  return { backupPath, removedLines: removed };
}

/** 恢复某个 .bak 备份（回滚路径，write-executor 调用）。 */
export function restoreLogBackup(backupPath: string): { restored: boolean } {
  if (!fs.existsSync(backupPath)) return { restored: false };
  fs.copyFileSync(backupPath, LOG_FILE);
  return { restored: true };
}
