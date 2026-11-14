/**
 * WriteExecutor —— V2 写能力层的统一执行管线（设计 §6.1 三层防线）。
 *
 * 进入本模块的前提：权限内核已裁决 ask 且用户批准（或会话级审批记忆命中）。
 * 本模块负责剩下两层：
 *   预检（precheck）→ 执行（包裹：备份/事务/快照）→ 校验（verify）→ 回滚就绪。
 *
 * 审批通过 ≠ 执行无条件放行：precheck 失败（基线变了 / 参数白名单外）时
 * 即使审批已通过也要中止——审批针对意图，precheck 针对此刻的现实。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR } from '../config';
import { resolve as resolveRepoPath } from './file-service';
import { resolveRepoRoot } from './workspace-repos';
import { runSqlWrite, restoreDbBackup } from './sql-write';
import { restoreLogBackup } from './log-sink';
import { matchTemplate, validateParams, renderCommand, handleRotateLog, handleBackupFile } from '../config/cmd-templates';
import { writeAudit } from '../db/database';
import type { Identity } from '../http/core';

export interface WriteOutcome {
  ok: boolean;
  message: string;
  /** 回滚引用（JSON 字符串），存入审批卡 payload，rollback 端点据此执行。 */
  rollbackRef?: string;
  diskChanged: boolean;
  /** 数据库写路径专有：实际影响行数（非 DB 写为 undefined）。 */
  affectedRows?: number;
}

async function auditWrite(params: {
  workspaceId: string; actor: string; action: string; target: string;
  result: string; severity: 'info' | 'warn'; detail: string;
}): Promise<void> {
  writeAudit({
    workspaceId: params.workspaceId,
    actor: params.actor,
    source: 'agent',
    action: params.action,
    target: params.target,
    result: params.result,
    severity: params.severity,
    detail: params.detail,
  });
}

/** repo 文件清单（enumFromRepo 参数枚举用；跳过 .git / node_modules）。 */
async function repoFileList(assetId: string): Promise<string[]> {
  const root = path.resolve(await resolveRepoRoot(assetId));
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length > 200) return;
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    names.forEach((name) => {
      if (name === '.git' || name === 'node_modules' || name === '.devwork-snapshots') return;
      const absolute = path.join(dir, name);
      try {
        if (fs.statSync(absolute).isDirectory()) walk(absolute, depth + 1);
        else out.push(path.relative(root, absolute).replace(/\\/g, '/'));
      } catch { /* ignore */ }
    });
  };
  walk(root, 0);
  return out;
}

/* ---------------- code_edit / fs_write_file：文件写 ---------------- */

/** 快照目录的唯一计算处：运行时数据目录下的 snapshots/<conversationId>。 */
function snapshotDirOf(conversationId: string): string {
  const safe = String(conversationId || 'adhoc').replace(/[^\w-]/g, '_');
  return path.join(DATA_DIR, 'snapshots', safe);
}

export async function executeFileWrite(
  assetId: string,
  rel: string,
  content: string,
  identity: Identity,
  workspaceId: string,
  conversationId = '',
): Promise<WriteOutcome> {
  /* precheck 1：路径边界 + 敏感规则（file-service.resolve 统一裁决）。 */
  let absolute: string;
  try {
    absolute = await resolveRepoPath(assetId, rel);
  } catch (error) {
    return {
      ok: false,
      message: `precheck 失败（审批不豁免现实检查）：${error instanceof Error ? error.message : String(error)}`,
      diskChanged: false,
    };
  }
  /* precheck 2：读取基线并做快照（回滚就绪）。
   * 快照必须落在运行时数据目录（DATA_DIR/snapshots/<conversationId>/）：
   * 此前写在用户仓库里的 .devwork-snapshots/，会污染 `git status`、可能被误提交 ——
   * 而「你的仓库不被我弄脏」是写能力的第一信任前提（审计 A-P2-15）。 */
  let before: string | null = null;
  try {
    if (fs.existsSync(absolute)) before = fs.readFileSync(absolute, 'utf8');
  } catch { before = null; }
  const snapshotDir = snapshotDirOf(conversationId);
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `${Date.now()}-${path.basename(rel)}`);
    if (before !== null) fs.writeFileSync(snapshotPath, before, 'utf8');
    /* 执行：落盘。 */
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const buffer = Buffer.from(content, 'utf8');
    fs.writeFileSync(absolute, buffer);
    /* 校验：重读一致。 */
    const verify = fs.readFileSync(absolute, 'utf8');
    const ok = verify === content;
    await auditWrite({
      workspaceId, actor: identity.name, action: 'write.code_edit', target: rel,
      result: ok ? '放行' : '校验失败', severity: ok ? 'info' : 'warn',
      detail: `precheck=基线快照就绪 · bytesWritten=${buffer.length} · verify=${ok ? '通过' : '失败'} · rollbackRef=${before !== null ? '快照' : '新建无回滚'}`,
    });
    return {
      ok,
      message: ok
        ? `文件已写入：${rel}（${buffer.length} 字节）。基线快照保留在运行时数据目录（snapshots/${path.basename(snapshotDir)}/），可通过回滚端点恢复。`
        : `写入后校验失败：重读内容与预期不一致（罕见，检查磁盘）`,
      /* 回滚引用存**绝对路径** + 资产 id：回滚时要靠 assetId 断言目标仍在仓库根内。 */
      rollbackRef: before !== null
        ? JSON.stringify({ kind: 'file-snapshot', snapshotPath, targetPath: absolute, assetId })
        : undefined,
      diskChanged: true,
    };
  } catch (error) {
    return { ok: false, message: `执行失败（未落盘或部分落盘）：${error instanceof Error ? error.message : String(error)}`, diskChanged: fs.existsSync(absolute) };
  }
}

/* ---------------- db_query_write：DML ---------------- */

export async function executeDbWrite(
  sql: string,
  identity: Identity,
  workspaceId: string,
): Promise<WriteOutcome> {
  try {
    const result = await runSqlWrite(sql, 10000);
    await auditWrite({
      workspaceId, actor: identity.name, action: 'write.db_query_write', target: result.sql.slice(0, 80),
      result: '放行', severity: 'info',
      detail: `affectedRows=${result.affectedRows} · backup=${path.basename(result.backupPath)} · checksum ${result.checksumBefore === result.checksumAfter ? '未变化（可疑）' : '已变化'}`,
    });
    return {
      ok: true,
      message: `DML 已执行（事务提交）：影响 ${result.affectedRows} 行 · ${result.durationMs}ms。整库备份 ${path.basename(result.backupPath)}，可通过回滚端点恢复。`,
      rollbackRef: JSON.stringify({ kind: 'db-backup', backupPath: result.backupPath }),
      diskChanged: true,
      affectedRows: result.affectedRows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await auditWrite({
      workspaceId, actor: identity.name, action: 'write.db_query_write', target: sql.slice(0, 80),
      result: '失败', severity: 'warn', detail: `precheck/执行失败：${message.slice(0, 200)}`,
    });
    return { ok: false, message: `DML 未执行：${message}`, diskChanged: false };
  }
}

/* ---------------- srv_exec：意图导向模板执行 ---------------- */

export async function executeSrvTemplate(
  assetId: string,
  action: string,
  rawParams: Record<string, unknown>,
  identity: Identity,
  workspaceId: string,
): Promise<WriteOutcome> {
  /* 规则 2：无模板 = 拒绝执行，不 fallback 裸 shell。 */
  const template = matchTemplate(action, JSON.stringify(rawParams));
  if (!template) {
    await auditWrite({
      workspaceId, actor: identity.name, action: 'write.srv_exec', target: action,
      result: '拦截', severity: 'warn', detail: '意图不在模板库（模板外操作一律拒绝，转建议模式）',
    });
    return {
      ok: false,
      message: `意图「${action}」不在命令模板库中，拒绝执行（无模板 = 不裸跑 shell）。请转建议模式产出命令文本，或将该操作沉淀为新模板（模板变更需评审）。`,
      diskChanged: false,
    };
  }
  /* 规则 1：参数白名单校验（enumFromRepo 的枚举来自真实文件清单）。 */
  const validation = validateParams(
    template,
    rawParams,
    template.params.path?.enumFromRepo ? await repoFileList(assetId) : [],
  );
  if (!validation.ok) {
    await auditWrite({
      workspaceId, actor: identity.name, action: 'write.srv_exec', target: template.id,
      result: '拦截', severity: 'warn', detail: `参数白名单校验失败：${validation.error}`,
    });
    return { ok: false, message: `参数校验失败（审批不豁免白名单）：${validation.error}`, diskChanged: false };
  }

  /* 执行层：builtin（JS 真实现）或 native（spawn，沙箱内如实降级）。 */
  const filled = validation.filled ?? {};
  if (template.exec.kind === 'builtin' && template.exec.handler === 'rotate_log') {
    const outcome = handleRotateLog(filled);
    await auditWrite({
      workspaceId, actor: identity.name, action: `write.srv_exec · ${template.id}`, target: 'devwork.log',
      result: outcome.ok ? '放行' : '失败', severity: 'info',
      detail: `builtin handler · ${outcome.stdout.slice(0, 200)}`,
    });
    return { ok: outcome.ok, message: outcome.stdout, rollbackRef: outcome.rollbackRef, diskChanged: outcome.ok };
  }
  if (template.exec.kind === 'builtin' && template.exec.handler === 'backup_file') {
    const outcome = await handleBackupFile(assetId, filled);
    await auditWrite({
      workspaceId, actor: identity.name, action: `write.srv_exec · ${template.id}`, target: String(filled.path ?? ''),
      result: outcome.ok ? '放行' : '失败', severity: 'info',
      detail: `builtin handler · ${outcome.stdout.slice(0, 200)}`,
    });
    return { ok: outcome.ok, message: outcome.stdout, rollbackRef: outcome.rollbackRef, diskChanged: outcome.ok };
  }

  /* native：spawn 真实命令；环境不支持（如 Windows 无 systemctl）时如实上报 127。 */
  const command = renderCommand(template, filled);
  const nativeTokens = command.split(/\s+/);
  /* 先取执行结果、再写审计：审计是写操作，不能在回调里 fire-and-forget。 */
  const native = await new Promise<{ error: NodeJS.ErrnoException | null; stdout: string; stderr: string }>((resolve) => {
    execFile(nativeTokens[0], nativeTokens.slice(1), { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ error: error as NodeJS.ErrnoException | null, stdout: String(stdout), stderr: String(stderr) });
    });
  });
  if (native.error && native.error.code === 'ENOENT') {
    await auditWrite({
      workspaceId, actor: identity.name, action: `write.srv_exec · ${template.id}`, target: command,
      result: '降级', severity: 'warn', detail: `native exec：本机无 ${nativeTokens[0]}（exitCode=127），未伪造输出`,
    });
    return {
      ok: false,
      message: `模板 ${template.id} 命令「${command}」在本机不可用（${nativeTokens[0]} 未安装，exitCode=127）。这是真实探测结果，未伪造执行成功。`,
      rollbackRef: undefined,
      diskChanged: false,
    };
  }
  const ok = !native.error;
  await auditWrite({
    workspaceId, actor: identity.name, action: `write.srv_exec · ${template.id}`, target: command,
    result: ok ? '放行' : '失败', severity: ok ? 'info' : 'warn',
    detail: `native exec · exit=${native.error ? 'nonzero' : 0} · stdout=${native.stdout.slice(0, 120)} stderr=${native.stderr.slice(0, 120)}`,
  });
  return {
    ok,
    message: ok
      ? `模板 ${template.id} 已执行：${command}\n${native.stdout.slice(0, 800)}`
      : `模板 ${template.id} 执行失败：${(native.stderr || String(native.error)).slice(0, 400)}`,
    rollbackRef: JSON.stringify({ kind: 'native-command', command: template.rollback.command ?? '', params: validation.filled }),
    diskChanged: ok,
  };
}

/* ---------------- 回滚 ---------------- */

/** 统一回滚入口：按 rollbackRef.kind 分派（native 回滚为异步，整函数返回 Promise）。 */
export async function rollbackWritePlan(
  rollbackRefJson: string,
  identity: Identity,
  workspaceId: string,
): Promise<{ ok: boolean; message: string }> {
  let ref: { kind: string; [key: string]: unknown };
  try {
    ref = JSON.parse(rollbackRefJson) as { kind: string };
  } catch {
    return { ok: false, message: '回滚引用无效（不是合法 JSON）' };
  }
  switch (ref.kind) {
    case 'db-backup': {
      const result = restoreDbBackup(String(ref.backupPath ?? ''));
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.rollback · db-backup', target: String(ref.backupPath ?? ''),
        result: result.restored ? '放行' : '失败', severity: 'info',
        detail: result.restored ? 'demo 库已恢复到写入前备份' : '备份文件不存在，无法恢复',
      });
      return { ok: result.restored, message: result.restored ? '数据库已恢复到写前备份（checksum 以恢复后为准）' : '备份文件不存在，无法恢复' };
    }
    case 'log-backup': {
      const result = restoreLogBackup(String(ref.backupPath ?? ''));
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.rollback · log-backup', target: String(ref.backupPath ?? ''),
        result: result.restored ? '放行' : '失败', severity: 'info',
        detail: result.restored ? '日志文件已恢复到轮转前内容' : '备份不存在',
      });
      return { ok: result.restored, message: result.restored ? '日志已恢复到轮转前内容' : '备份文件不存在，无法恢复' };
    }
    case 'file-snapshot': {
      const snapshotPath = String(ref.snapshotPath ?? '');
      const targetPath = String(ref.targetPath ?? '');
      const assetId = String(ref.assetId ?? '');
      if (!fs.existsSync(snapshotPath)) {
        return { ok: false, message: '快照文件不存在，无法恢复' };
      }
      /* 回滚是「把内容拷回某个路径」——拷贝目标必须落在该资产仓库根内。
       * rollbackRef 目前由服务端生成、用户不可直接注入，所以当前不可利用；
       * 但缺了这道断言，将来只要它多一个入口就是任意文件覆盖（审计 A-P2-16）。 */
      let inside = false;
      try {
        const root = path.resolve(resolveRepoRoot(assetId));
        const target = path.resolve(targetPath);
        inside = target === root || target.startsWith(`${root}${path.sep}`);
      } catch {
        /* 拿不到仓库根（资产已删 / 目录不存在）→ 不放行。 */
        inside = false;
      }
      if (!inside) {
        await auditWrite({
          workspaceId, actor: identity.name, action: 'write.rollback · file-snapshot', target: targetPath,
          result: '拦截', severity: 'warn',
          detail: `E_PATH_ESCAPE：回滚目标不在资产（${assetId || '未知'}）仓库根内，已拒绝拷贝`,
        });
        return { ok: false, message: 'E_PATH_ESCAPE：回滚目标不在该资产仓库根目录内，已拒绝（未覆盖任何文件）' };
      }
      fs.copyFileSync(snapshotPath, targetPath);
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.rollback · file-snapshot', target: targetPath,
        result: '放行', severity: 'info', detail: '文件已恢复到写入前快照',
      });
      return { ok: true, message: `文件已恢复到写入前快照：${path.basename(targetPath)}` };
    }
    case 'native-command': {
      const command = String(ref.command ?? '');
      if (!command) return { ok: false, message: '该模板没有配置回滚命令' };
      const tokens = command.split(/\s+/);
      return await new Promise<{ ok: boolean; message: string }>((resolve) => {
        execFile(tokens[0], tokens.slice(1), { timeout: 15000, windowsHide: true }, (error, stdout) => {
          if (error) {
            resolve({ ok: false, message: `回滚命令在本机不可用（${tokens[0]}）：${String(error.message).slice(0, 200)}` });
            return;
          }
          resolve({ ok: true, message: `回滚命令已执行：${command}\n${String(stdout).slice(0, 400)}` });
        });
      });
    }
    default:
      return { ok: false, message: `未知回滚类型：${ref.kind}` };
  }
}
