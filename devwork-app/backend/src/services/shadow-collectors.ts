/**
 * 采集器 —— 把「环境里发生的事」翻译成 Trigger。
 *
 * 三条共同约定，缺一条就会出现重复接单或漏接：
 *   1. **位点存 source.read_position**。重启不重放，这是采集器的正确性底座。
 *   2. **一轮最多产一条**。日志一次刷 200 行，产 200 条 Trigger 只会把频控顶满，
 *      而且每条都不带上下文。聚合后的人话（最近一条 + 数量）信息量更大。
 *   3. **源未启用就一行代码都不跑**。主动看别人的文件、仓库、命令历史，必须是显式开启。
 *
 * sql 的数据源是 `sql_trace`：埋点在 sql-query 执行处（>=500ms 才落一行），
 * 采集器再按阈值筛。两层阈值分开，是为了让「多慢算慢」可以事后调，
 * 而不用改埋点重发版。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { all, get, run } from '../db/database';
import { ingestTrigger, rawConfigOf } from './shadow-scheduler';

type Row = Record<string, unknown>;

/** 单次最多读这么多字节：日志文件可能几个 G，不能一次读进内存。 */
const MAX_READ_BYTES = 64 * 1024;

function enabledSources(kind: string): Row[] {
  return all<Row>('SELECT * FROM source WHERE kind = ? AND enabled = 1', kind);
}

function advance(source: Row, position: string): void {
  run('UPDATE source SET read_position = ?, last_seen_at = ? WHERE id = ?', position, new Date().toISOString(), String(source.id));
}

function emit(source: Row, input: { threadKey: string; threadTitle: string; body: string; payload: Row; idemKey: string }): boolean {
  const result = ingestTrigger({
    workspaceId: String(source.workspace_id),
    sourceKind: String(source.kind) as 'log' | 'git' | 'terminal' | 'sql',
    threadKey: input.threadKey,
    threadTitle: input.threadTitle,
    actor: String(
      source.kind === 'git' ? 'git'
        : source.kind === 'terminal' ? 'shell'
          : source.kind === 'sql' ? 'db-monitor'
            : 'log-watcher',
    ),
    actorKind: 'system',
    body: input.body,
    payload: input.payload,
    idemKey: input.idemKey,
  });
  return result.created;
}

/**
 * 日志：按字节位点 tail 新增内容，命中 pattern 的行聚合成一条。
 *
 * 位点用字节而不是行号：行号在文件被追加时也会漂，而且「第 N 行」在轮转后毫无意义。
 */
export function collectLogs(): number {
  let emitted = 0;
  enabledSources('log').forEach((source) => {
    const config = rawConfigOf(source);
    const file = String(config.path ?? '').trim();
    if (!file) return;
    const patternText = String(config.pattern ?? 'ERROR|FATAL');
    let regex: RegExp;
    try {
      regex = new RegExp(patternText, 'i');
    } catch {
      regex = /ERROR|FATAL/i;
    }

    let size = 0;
    try {
      if (!fs.existsSync(file)) return;
      size = fs.statSync(file).size;
    } catch {
      return;
    }

    let position = Number(source.read_position ?? 0);
    if (!Number.isFinite(position) || position < 0 || position > size) position = 0; // 轮转 / 截断
    if (size <= position) return;

    const start = Math.max(position, size - MAX_READ_BYTES);
    let chunk = '';
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        chunk = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }

    const hits = chunk.split(/\r?\n/).filter((line) => line.trim() !== '' && regex.test(line));
    advance(source, String(size));
    if (hits.length === 0) return;

    const latest = hits[hits.length - 1].slice(0, 500);
    const created = emit(source, {
      threadKey: file,
      threadTitle: file,
      body: hits.length > 1 ? `${latest}（本轮新增 ${hits.length} 条命中）` : latest,
      payload: { file, matched: hits.length, pattern: patternText },
      /* 幂等键带字节位点：同一个位置绝不会被投两次。 */
      idemKey: `log:${String(source.id)}:${size}`,
    });
    if (created) emitted += 1;
  });
  return emitted;
}

/** Git：比较 HEAD，变了就投一条（提交信息比 hash 有用得多）。 */
export function collectGit(): number {
  let emitted = 0;
  enabledSources('git').forEach((source) => {
    const config = rawConfigOf(source);
    const repo = String(config.repoPath ?? '').trim();
    if (!repo || !fs.existsSync(repo)) return;

    let head = '';
    let subject = '';
    try {
      head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      subject = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
    } catch {
      /* 没有 git、不是仓库、权限不足：静默跳过，下一轮再试。 */
      return;
    }
    if (!head) return;
    const previous = String(source.read_position ?? '');
    if (head === previous) return;

    /* 首次采集只记位点，不投递：否则「刚开这个源」就会凭空多一条工单。 */
    advance(source, head);
    if (!previous) return;

    const created = emit(source, {
      threadKey: `git:${repo}`,
      threadTitle: repo,
      body: `仓库有新提交：${subject || head.slice(0, 8)}（${head.slice(0, 8)}）`,
      payload: { repo, head, previous, subject },
      idemKey: `git:${String(source.id)}:${head}`,
    });
    if (created) emitted += 1;
  });
  return emitted;
}

/**
 * 终端：从命令历史里捞「新出现的失败命令」。
 *
 * 为什么读历史表而不是给执行器挂钩子：历史表已经是事实（谁跑的、结果如何都记了），
 * 挂钩子等于把采集逻辑塞进执行路径，失败时会连累命令执行本身。
 */
export function collectTerminal(): number {
  let emitted = 0;
  enabledSources('terminal').forEach((source) => {
    const config = rawConfigOf(source);
    const since = String(source.read_position ?? '');
    const rows = all<Row>(
      `SELECT * FROM command_history WHERE created_at > ? ORDER BY created_at ASC LIMIT 20`,
      since || '1970-01-01T00:00:00.000Z',
    );
    if (rows.length === 0) return;

    const latest = rows[rows.length - 1];
    advance(source, String(latest.created_at ?? ''));
    /* 只看失败：成功的命令不构成「需要处理的事件」。 */
    const failed = rows.filter((row) => /失败|error|exit [1-9]|非零/i.test(String(row.result ?? '')));
    if (failed.length === 0 || !since) return;

    const last = failed[failed.length - 1];
    const created = emit(source, {
      threadKey: `shell:${String(last.asset_id ?? 'local')}`,
      threadTitle: '终端',
      body: `命令失败：${String(last.command ?? '').slice(0, 200)}`,
      payload: { command: String(last.command ?? ''), result: String(last.result ?? '').slice(0, 500) },
      idemKey: `term:${String(source.id)}:${String(last.id)}`,
    });
    if (created) emitted += 1;
  });
  return emitted;
}

/**
 * 慢查询：读 sql_trace，超过阈值的聚合成一条。
 *
 * 首次只记位点不投递 —— 和 git / terminal 一致。
 * 否则刚打开这个源，就会把历史上所有慢查询当成「现在发生的事」报上来。
 */
export function collectSql(): number {
  let emitted = 0;
  enabledSources('sql').forEach((source) => {
    const config = rawConfigOf(source);
    const threshold = Math.max(100, Number(config.slowMs ?? 1500) || 1500);
    const since = String(source.read_position ?? '');

    const rows = all<Row>(
      'SELECT * FROM sql_trace WHERE created_at > ? ORDER BY created_at ASC LIMIT 50',
      since || '1970-01-01T00:00:00.000Z',
    );
    if (rows.length === 0) return;

    /* 位点按「已读到的最新一条」推进，无论是否超过阈值：
     * 快的查不构成事件，但它们的位点必须过去，否则每轮都会重扫这批。 */
    const latest = rows[rows.length - 1];
    advance(source, String(latest.created_at ?? ''));
    if (!since) return;

    const slow = rows.filter((row) => Number(row.duration_ms ?? 0) >= threshold);
    if (slow.length === 0) return;

    const worst = slow.reduce((acc, row) => (
      Number(row.duration_ms ?? 0) > Number(acc.duration_ms ?? 0) ? row : acc
    ), slow[0]);

    const created = emit(source, {
      threadKey: `sql:${String(worst.asset_id ?? 'db')}`,
      threadTitle: `${String(worst.asset_id ?? '数据库')} 慢查询`,
      body: `慢查询：${Math.round(Number(worst.duration_ms ?? 0))}ms · ${String(worst.statement ?? '').slice(0, 300)}`
        + (slow.length > 1 ? `（本轮共 ${slow.length} 条慢查询）` : ''),
      payload: {
        assetId: String(worst.asset_id ?? ''),
        durationMs: Number(worst.duration_ms ?? 0),
        statement: String(worst.statement ?? '').slice(0, 500),
        rowCount: Number(worst.row_count ?? 0),
        slowCount: slow.length,
      },
      idemKey: `sql:${String(source.id)}:${String(worst.id)}`,
    });
    if (created) emitted += 1;
  });
  return emitted;
}

export function runCollectors(): { logs: number; git: number; terminal: number; sql: number } {
  return { logs: collectLogs(), git: collectGit(), terminal: collectTerminal(), sql: collectSql() };
}
