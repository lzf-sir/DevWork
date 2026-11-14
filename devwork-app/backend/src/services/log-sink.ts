/**
 * LogSink —— Agent 日志工具组的真实数据后端。
 *
 * 为什么必须有这个文件：设计 §2.6 的 log_query / log_tail 需要「真实存在的日志」，
 * 而不是编造的假日志行。DevWork 服务端本来就在 console 打请求日志（index.ts），
 * 把同一份内容落一行结构化文本到 data/logs/devwork.log，日志工具就有真东西可查。
 *
 * 格式：ISO 时间戳 \t 级别 \t 消息（单行，写入前压平换行）。
 *
 * 写入策略：**异步追加流** + 按大小轮转 + 「未落盘行」内存影子。
 * 早前是每个请求 `appendFileSync`：同步 IO 意味着「日志写得越多，接口越慢」，
 * 而且文件从不轮转 —— 跑一年就是一个几 GB 的单文件，连 log_tail 都读不动。
 *
 * 为什么还要影子（pending）：异步写和同步读之间必然有窗口。`readLogLines()`
 * 是给日志工具与轮转用的同步 API，如果只读磁盘，刚写的那几行就看不见
 * （表现为「刚发生的错误查不到」）。所以未确认落盘的行留在内存里，
 * 读的时候拼在磁盘内容之后 —— 异步写入与「写完即可查」两个要求同时成立。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config';

export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'devwork.log');

/** 单个日志文件的大小上限：超过就转成 .bak-<ts> 再重开新文件。 */
const LOG_MAX_BYTES = 8 * 1024 * 1024;
/** 保留的备份份数：够定位最近几次问题即可，不保留全历史。 */
const LOG_BACKUP_KEEP = 5;

let initialized = false;

interface Sink {
  stream: fs.WriteStream;
  bytes: number;
  /** 代次：rotate / restore 之后旧流的回调不能再去动新的影子数组。 */
  id: number;
}

let sink: Sink | null = null;
let sinkSeq = 0;
/** 已交给流、但写回调还没触发的行（顺序 = 写入顺序）。 */
let pending: string[] = [];

export function initLogSink(): void {
  if (initialized) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, [
      `${new Date().toISOString()}\tINFO\tDevWork 日志沉降器初始化（本文件是 log_query / log_tail 的工具数据源）`,
    ].join('\n') + '\n', 'utf8');
  }
  initialized = true;
}

/** 打开（或复用）追加流；size 以磁盘上现有文件为准，用于轮转判定。 */
function openSink(): Sink {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let bytes = 0;
  try { bytes = fs.statSync(LOG_FILE).size; } catch { bytes = 0; }
  const id = (sinkSeq += 1);
  const stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  /* 流自身出错（磁盘满 / 权限）不能反过来拖垮主服务：丢弃引用，下次调用重开。 */
  stream.on('error', () => {
    if (sink?.id === id) sink = null;
  });
  return { stream, bytes, id };
}

/**
 * 停掉当前流并交出「还没落盘」的行。
 *
 * `destroy()` 会丢弃流队列里尚未写出的数据 —— 这正是我们要的：
 * 那些行还在 pending 里，由调用方自己决定补写到哪（原文件 / 备份 / 新文件），
 * 否则会和后续的同步重写叠在一起，同一行落两次。
 */
function detachSink(): string {
  const carry = pending.join('');
  pending = [];
  const current = sink;
  sink = null;
  try { current?.stream.destroy(); } catch { /* 销毁失败不影响后续同步写 */ }
  return carry;
}

/** 删除过旧的 .bak，保持备份数量有界。 */
function pruneBackups(): void {
  try {
    const backups = fs.readdirSync(LOG_DIR)
      .filter((name) => name.startsWith('devwork.log.bak-'))
      .map((name) => {
        const absolute = path.join(LOG_DIR, name);
        try { return { absolute, mtime: fs.statSync(absolute).mtimeMs }; } catch { return { absolute, mtime: 0 }; }
      })
      .sort((left, right) => right.mtime - left.mtime);
    backups.slice(LOG_BACKUP_KEEP).forEach((file) => {
      try { fs.unlinkSync(file.absolute); } catch { /* 删不掉不影响写入 */ }
    });
  } catch {
    /* 清理失败不阻断写入 */
  }
}

/** 按大小轮转：把待写行补进旧文件 → 改名 → 重开空文件。 */
function rotateBySize(): void {
  const carry = detachSink();
  try {
    if (carry) fs.appendFileSync(LOG_FILE, carry, 'utf8');
    fs.renameSync(LOG_FILE, `${LOG_FILE}.bak-${Date.now()}`);
  } catch {
    /* 改名失败（占用 / 权限）就继续写原文件：宁可文件大，也不能丢日志。 */
  }
  try { fs.writeFileSync(LOG_FILE, '', 'utf8'); } catch { /* 下一行会重开文件 */ }
  pruneBackups();
}

/**
 * 追加一行结构化日志（异步，不阻塞请求线程）。
 *
 * 调用方按 fire-and-forget 使用：日志工具不能反过来拖垮主服务，
 * 所以这里既不返回 Promise，也绝不让异常外泄。
 */
export function appendLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  if (!initialized) return;
  try {
    const line = `${new Date().toISOString()}\t${level}\t${message.replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (!sink) sink = openSink();
    /* 只按「磁盘上已有大小」轮转：文件为空时不折腾（否则每行都转一次）。 */
    if (sink.bytes > 0 && sink.bytes + bytes > LOG_MAX_BYTES) {
      rotateBySize();
      sink = openSink();
    }
    const active = sink;
    active.bytes += bytes;
    pending.push(line);
    active.stream.write(line, () => {
      /* 只有同一代次的流才有权从影子数组里移除（轮转后旧回调迟到是常态）。 */
      if (sink?.id === active.id) pending.shift();
    });
  } catch {
    /* 沉降失败不阻断业务 */
  }
}

/**
 * 关停前把缓冲刷出去（挂到 index.ts 的 shutdown 流程）。
 * 不调用 `fsync`：日志不是审计证据（审计在 SQLite 里），丢掉末尾几行可以接受。
 */
export function endLogSink(): void {
  const carry = detachSink();
  if (!carry) return;
  try { fs.appendFileSync(LOG_FILE, carry, 'utf8'); } catch { /* 关停期写不进去也没关系 */ }
}

export interface LogLine { ts: string; level: string; message: string; raw: string }

/** 读取全部日志行（磁盘内容 + 尚未落盘的行）。文件超过 8MB 会自动轮转。 */
export function readLogLines(): LogLine[] {
  const fromDisk = fs.existsSync(LOG_FILE)
    ? fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
    : [];
  const lines = pending.length > 0
    ? [...fromDisk, ...pending.join('').split(/\r?\n/).filter((l) => l.trim() !== '')]
    : fromDisk;
  return lines.map((line) => {
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
  /* 先把流摘掉并把未落盘的行取回来：否则异步重写会与队列里的写交错。 */
  const carry = detachSink();
  const disk = fs.existsSync(LOG_FILE)
    ? fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '')
    : [];
  const carried = carry === '' ? [] : carry.split(/\r?\n/).filter((l) => l.trim() !== '');
  const allLines = [...disk, ...carried];
  const keep = allLines.slice(-Math.max(1, keepLines));
  const removed = allLines.length - keep.length;
  const backupPath = `${LOG_FILE}.bak-${Date.now()}`;
  /* 全量备份：被移除的行 + 保留的行都在，恢复 = 原样还原。 */
  fs.writeFileSync(backupPath, allLines.join('\n') + (allLines.length > 0 ? '\n' : ''), 'utf8');
  fs.writeFileSync(LOG_FILE, keep.join('\n') + (keep.length > 0 ? '\n' : ''), 'utf8');
  pruneBackups();
  return { backupPath, removedLines: removed };
}

/** 恢复某个 .bak 备份（回滚路径，write-executor 调用）。 */
export function restoreLogBackup(backupPath: string): { restored: boolean } {
  if (!fs.existsSync(backupPath)) return { restored: false };
  /* 覆盖文件前先摘掉异步流：否则队列里剩余的行会盖在恢复结果上。
   * 恢复语义是「回到备份那一刻」，此刻还没落盘的行属于恢复之后 —— 丢弃是对的。 */
  detachSink();
  fs.copyFileSync(backupPath, LOG_FILE);
  return { restored: true };
}
