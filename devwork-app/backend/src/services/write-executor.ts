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
import { diffRegion } from './text-diff';
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
    /* 新建文件没有基线：说"快照保留、可回滚"是假话，会让用户以为能退回去。 */
    const region = before === null ? null : diffRegion(before, content);
    return {
      ok,
      message: ok
        ? [
          before === null
            ? `文件已新建：${rel}（${buffer.length} 字节）。这是新建文件，没有基线快照，回滚只能靠删除它。`
            : `文件已写入：${rel}（${buffer.length} 字节）。基线快照保留在运行时数据目录（snapshots/${path.basename(snapshotDir)}/），可通过回滚端点恢复。`,
          region && !region.unchanged ? region.block : '',
          region && region.unchanged ? '（内容与写入前逐字节相同：这次写没有改变任何一行）' : '',
          region && region.clipped ? region.hint : '',
          'verify 只证明落盘内容与预期一致，不判断改动是否正确。',
        ].filter(Boolean).join('\n')
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

/* ---------------- code_edit_str：精确替换 ---------------- */

/**
 * 精确替换（oldString → newString）。
 *
 * 为什么要有这条路径：整文件重写（code_edit）要求模型把整个文件重新吐一遍，
 * 长文件里它一定会"顺手整理"没读到的部分——那不是用户要的改动。
 * 精确替换把改动范围钉死在一段原文上，闸门也更硬：
 *   · oldString 命中 0 次 → 说明模型对当前内容的认知是错的，中止；
 *   · 命中多次且未声明 replaceAll → 位置有歧义，中止（不许猜第一个）。
 * 两者都在**用户批准之后**的 precheck 里再判一次：审批针对意图，precheck 针对此刻的现实。
 */
export async function executeFileStrReplace(
  assetId: string,
  rel: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  identity: Identity,
  workspaceId: string,
  conversationId = '',
): Promise<WriteOutcome> {
  const needle = String(oldString ?? '');
  if (needle.trim() === '') {
    return { ok: false, message: 'precheck 失败：oldString 为空（要新建文件请用 fs_write_file）', diskChanged: false };
  }
  if (needle.length > 200 * 1024) {
    return { ok: false, message: 'precheck 失败：oldString 超过 200KB，这不像"局部替换"，请改用 code_edit 整文件写', diskChanged: false };
  }

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
  if (!fs.existsSync(absolute)) {
    return { ok: false, message: `precheck 失败：文件不存在（${rel}）。新建文件请用 fs_write_file`, diskChanged: false };
  }

  const before = fs.readFileSync(absolute, 'utf8');
  const occurrences = before.split(needle).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      message: `precheck 失败：oldString 在 ${rel} 中未命中（0 次）。当前文件内容与模型的理解不一致，`
        + '已中止且磁盘零变更 —— 请先用 code_read 复核原文再重试。',
      diskChanged: false,
    };
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      message: `precheck 失败：oldString 在 ${rel} 中命中 ${occurrences} 处，位置有歧义。`
        + '请带上更长的上下文让它唯一命中，或明确传 replaceAll: true。磁盘零变更。',
      diskChanged: false,
    };
  }

  /* 快照（回滚就绪）+ 计算替换结果。
   * 用 split/join 而不是 String.replace：后者会把 newString 里的 $& / $1
   * 当成替换模式解释，改一次正则就变成另一段代码——这类 bug 极难发现。 */
  const snapshotDir = snapshotDirOf(conversationId);
  const snapshotPath = path.join(snapshotDir, `${Date.now()}-${path.basename(rel)}`);
  try {
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(snapshotPath, before, 'utf8');
  } catch (error) {
    return {
      ok: false,
      message: `precheck 失败：无法写基线快照，已中止（没有回滚就不动盘）：${error instanceof Error ? error.message : String(error)}`,
      diskChanged: false,
    };
  }

  const expected = replaceAll
    ? before.split(needle).join(String(newString ?? ''))
    : (() => {
        const at = before.indexOf(needle);
        return before.slice(0, at) + String(newString ?? '') + before.slice(at + needle.length);
      })();
  const firstLine = before.slice(0, before.indexOf(needle)).split('\n').length;

  try {
    const buffer = Buffer.from(expected, 'utf8');
    fs.writeFileSync(absolute, buffer);
    const verify = fs.readFileSync(absolute, 'utf8');
    const ok = verify === expected;
    await auditWrite({
      workspaceId, actor: identity.name, action: 'write.code_edit_str', target: rel,
      result: ok ? '放行' : '校验失败', severity: ok ? 'info' : 'warn',
      detail: `precheck=唯一性通过(${occurrences} 处) + 快照就绪 · 首处 L${firstLine} · bytesWritten=${buffer.length} · verify=${ok ? '通过' : '失败'}`,
    });
    /* 落盘证据：`expected` 就是刚被 verify 确认过的磁盘内容，拿它和 `before` 比。 */
    const region = diffRegion(before, expected);
    return {
      ok,
      message: ok
        ? [
          `已精确替换 ${rel} 第 ${firstLine} 行起的 ${occurrences} 处（${needle.length} → ${String(newString ?? '').length} 字符）。`
            + '基线快照已保留，可通过回滚端点恢复。',
          region.unchanged
            ? '（oldString 与 newString 逐字节相同：文件内容没有变化，这次写是空操作）'
            : region.block,
          region.clipped ? region.hint : '',
          /* 「verify=通过」证明的只是"落盘的是我打算写的"。打算本身对不对，
           * 工具无法判断——这句话不写，模型会把 verify 当成改动正确性的背书。 */
          'verify 只证明落盘内容与预期一致，不判断改动是否正确。',
        ].filter(Boolean).join('\n')
        : '替换后校验失败：重读内容与预期不一致（罕见，检查磁盘）',
      rollbackRef: JSON.stringify({ kind: 'file-snapshot', snapshotPath, targetPath: absolute, assetId }),
      diskChanged: true,
    };
  } catch (error) {
    return {
      ok: false,
      message: `执行失败：${error instanceof Error ? error.message : String(error)}（快照可用，可回滚）`,
      diskChanged: fs.existsSync(absolute),
      rollbackRef: JSON.stringify({ kind: 'file-snapshot', snapshotPath, targetPath: absolute, assetId }),
    };
  }
}

/* ---------------- fs_manage：移动 / 复制 / 建目录 / 删除 ---------------- */

/** 回收站目录：删除不是"真删"，是把文件挪出仓库。与快照同理落在 DATA_DIR，不污染用户仓库。 */
function trashDirOf(conversationId: string): string {
  const safe = String(conversationId || 'adhoc').replace(/[^\w-]/g, '_');
  return path.join(DATA_DIR, 'trash', safe);
}

/** 路径是否在该资产仓库根**之内**（根本身不算：不允许对仓库根 rename/delete）。 */
function insideRepo(assetId: string, candidate: string): boolean {
  if (!candidate) return false;
  try {
    const root = path.resolve(resolveRepoRoot(assetId));
    const target = path.resolve(candidate);
    return target !== root && target.startsWith(`${root}${path.sep}`);
  } catch {
    /* 拿不到仓库根（资产已删 / 目录不存在）→ 不放行。 */
    return false;
  }
}

/** 路径是否在 DATA_DIR/trash 之内（回滚删除时的源）。 */
function insideTrash(candidate: string): boolean {
  if (!candidate) return false;
  const root = path.resolve(DATA_DIR, 'trash');
  return path.resolve(candidate).startsWith(`${root}${path.sep}`);
}

export type FsManageMode = 'move' | 'copy' | 'mkdir' | 'delete';

/**
 * 文件组织操作。四种 mode 都走同一条三层防线，但风险不同：
 *   · mkdir / copy 不会丢东西（copy 目标必须不存在，不会覆盖）；
 *   · move 会让源路径消失（回滚 = 移回去）；
 *   · delete 最容易后悔，所以**从不真删**：移到 DATA_DIR/trash/<会话>/ 并给出回滚引用。
 * 目标已存在一律拒绝——"覆盖"应该是显式的 write，而不是组织操作的副作用。
 */
export async function executeFsManage(
  assetId: string,
  mode: FsManageMode,
  from: string,
  to: string,
  identity: Identity,
  workspaceId: string,
  conversationId = '',
): Promise<WriteOutcome> {
  const sourceRel = String(from ?? '').trim().replace(/\\/g, '/');
  const targetRel = String(to ?? '').trim().replace(/\\/g, '/');

  if (mode !== 'mkdir' && mode !== 'delete' && !sourceRel) {
    return { ok: false, message: `precheck 失败：mode=${mode} 需要 from`, diskChanged: false };
  }
  if ((mode === 'move' || mode === 'copy' || mode === 'mkdir') && !targetRel) {
    return { ok: false, message: `precheck 失败：mode=${mode} 需要 to`, diskChanged: false };
  }

  const resolveOrFail = async (rel: string): Promise<{ absolute?: string; error?: string }> => {
    try {
      return { absolute: await resolveRepoPath(assetId, rel) };
    } catch (error) {
      return { error: `precheck 失败（审批不豁免现实检查）：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  /* 两个路径都要过 resolve：只校验 from 等于允许"从仓库里搬出去"。 */
  const source = sourceRel ? await resolveOrFail(sourceRel) : { absolute: undefined as string | undefined };
  if (source.error) return { ok: false, message: source.error, diskChanged: false };
  const target = targetRel ? await resolveOrFail(targetRel) : { absolute: undefined as string | undefined };
  if (target.error) return { ok: false, message: target.error, diskChanged: false };

  try {
    /* ---- mkdir ---- */
    if (mode === 'mkdir') {
      const dir = target.absolute as string;
      if (fs.existsSync(dir)) {
        return { ok: false, message: `precheck 失败：目录已存在（${targetRel}），未做任何改动`, diskChanged: false };
      }
      fs.mkdirSync(dir, { recursive: true });
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.fs_manage · mkdir', target: targetRel,
        result: '放行', severity: 'info', detail: 'precheck=路径边界通过 · verify=目录已存在',
      });
      return {
        ok: true,
        message: `已创建目录：${targetRel}`,
        diskChanged: true,
        rollbackRef: JSON.stringify({ kind: 'fs-mkdir', path: dir, assetId }),
      };
    }

    /* ---- 源必须存在且不能是仓库根 ---- */
    const fromPath = source.absolute as string;
    if (!fs.existsSync(fromPath)) {
      return { ok: false, message: `precheck 失败：源不存在（${sourceRel}）`, diskChanged: false };
    }
    let isDir = false;
    try { isDir = fs.statSync(fromPath).isDirectory(); } catch { /* 保持 false */ }

    /* ---- delete：移到回收站，不真删 ---- */
    if (mode === 'delete') {
      const trashDir = trashDirOf(conversationId);
      fs.mkdirSync(trashDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
      const trashPath = path.join(trashDir, `${stamp}-${path.basename(fromPath)}`);
      moveOrCopy(fromPath, trashPath, true);
      const stillThere = fs.existsSync(fromPath);
      if (stillThere) {
        return { ok: false, message: `执行失败：${sourceRel} 仍存在于原位置（未完成移除）`, diskChanged: false };
      }
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.fs_manage · delete', target: sourceRel,
        result: '放行', severity: 'warn',
        detail: `precheck=路径边界通过 · 目标=回收站（非真删） · trash=${trashPath} · verify=源已消失`,
      });
      return {
        ok: true,
        message: `已移出仓库（可回滚）：${sourceRel}${isDir ? '（整个目录）' : ''} → 回收站`,
        diskChanged: true,
        rollbackRef: JSON.stringify({ kind: 'fs-trash', trashPath, original: fromPath, assetId }),
      };
    }

    /* ---- move / copy：目标必须不存在 ---- */
    const toPath = target.absolute as string;
    if (fs.existsSync(toPath)) {
      return { ok: false, message: `precheck 失败：目标已存在（${targetRel}），不覆盖（要覆盖请用 fs_write_file 显式写）`, diskChanged: false };
    }
    if (mode === 'copy' && isDir) {
      return { ok: false, message: 'precheck 失败：copy 只支持单个文件（目录请用 move，或逐个文件复制）', diskChanged: false };
    }
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    moveOrCopy(fromPath, toPath, mode === 'move');

    /* 校验：目标存在、源状态符合预期。 */
    const targetExists = fs.existsSync(toPath);
    const sourceGone = mode === 'move' ? !fs.existsSync(fromPath) : fs.existsSync(fromPath);
    if (!targetExists || !sourceGone) {
      return {
        ok: false,
        message: `执行失败：${mode === 'move' ? '移动' : '复制'}后状态不符（目标${targetExists ? '存在' : '缺失'} / 源${sourceGone ? '符合预期' : '异常'}）`,
        diskChanged: targetExists,
      };
    }
    await auditWrite({
      workspaceId, actor: identity.name, action: `write.fs_manage · ${mode}`, target: `${sourceRel} → ${targetRel}`,
      result: '放行', severity: 'info',
      detail: `precheck=双路径边界通过 · 目标原不存在 · verify=通过`,
    });
    return {
      ok: true,
      message: mode === 'move' ? `已移动：${sourceRel} → ${targetRel}` : `已复制：${sourceRel} → ${targetRel}`,
      diskChanged: true,
      rollbackRef: JSON.stringify(
        mode === 'move'
          ? { kind: 'fs-move', from: fromPath, to: toPath, assetId }
          : { kind: 'fs-copy', path: toPath, assetId },
      ),
    };
  } catch (error) {
    return {
      ok: false,
      message: `执行失败：${error instanceof Error ? error.message : String(error)}`,
      diskChanged: false,
    };
  }
}

/** 跨盘 rename 会 EXDEV，所以移动要能退化成"复制再删"。 */
function moveOrCopy(from: string, to: string, move: boolean): void {
  if (!move) {
    fs.copyFileSync(from, to);
    return;
  }
  try {
    fs.renameSync(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
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
    /* ---- fs_manage 的四种回滚 ----
     * 与 file-snapshot 同一个前提：rollbackRef 由服务端生成，但路径必须重新校验。
     * 这里多一类边界：回收站位于 DATA_DIR（不在仓库内），fs-trash 的回滚源在那里，
     * 其余三种的目标必须在仓库内。 */
    case 'fs-mkdir': {
      const dir = String(ref.path ?? '');
      const assetId = String(ref.assetId ?? '');
      if (!insideRepo(assetId, dir)) {
        return { ok: false, message: 'E_PATH_ESCAPE：目录不在该资产仓库根内，已拒绝' };
      }
      if (!fs.existsSync(dir)) return { ok: true, message: '目录已不存在（无需回滚）' };
      /* 只删空目录：用户/Agent 后来放进来的文件不该被回滚顺手删掉。 */
      if (fs.readdirSync(dir).length > 0) {
        return { ok: false, message: '目录非空，未删除（回滚只撤销"创建空目录"这一步）' };
      }
      fs.rmdirSync(dir);
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.rollback · fs-mkdir', target: dir,
        result: '放行', severity: 'info', detail: '空目录已移除',
      });
      return { ok: true, message: '空目录已移除' };
    }
    case 'fs-move': {
      const from = String(ref.from ?? '');
      const to = String(ref.to ?? '');
      const assetId = String(ref.assetId ?? '');
      if (!insideRepo(assetId, from) || !insideRepo(assetId, to)) {
        return { ok: false, message: 'E_PATH_ESCAPE：回滚路径不在该资产仓库根内，已拒绝' };
      }
      if (!fs.existsSync(to)) return { ok: false, message: '移动目标已不存在，无法移回' };
      if (fs.existsSync(from)) return { ok: false, message: `原路径已被占用（${path.basename(from)}），未覆盖` };
      fs.mkdirSync(path.dirname(from), { recursive: true });
      moveOrCopy(to, from, true);
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.rollback · fs-move', target: `${to} → ${from}`,
        result: '放行', severity: 'info', detail: '文件已移回原路径',
      });
      return { ok: true, message: '文件已移回原路径' };
    }
    case 'fs-copy': {
      const target = String(ref.path ?? '');
      const assetId = String(ref.assetId ?? '');
      if (!insideRepo(assetId, target)) {
        return { ok: false, message: 'E_PATH_ESCAPE：回滚路径不在该资产仓库根内，已拒绝' };
      }
      if (!fs.existsSync(target)) return { ok: true, message: '复制出来的文件已不存在（无需回滚）' };
      fs.rmSync(target, { force: true });
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.rollback · fs-copy', target,
        result: '放行', severity: 'info', detail: '复制产物已删除（源文件未受影响）',
      });
      return { ok: true, message: '复制产物已删除' };
    }
    case 'fs-trash': {
      const trashPath = String(ref.trashPath ?? '');
      const original = String(ref.original ?? '');
      const assetId = String(ref.assetId ?? '');
      if (!insideTrash(trashPath) || !insideRepo(assetId, original)) {
        return { ok: false, message: 'E_PATH_ESCAPE：回收站或目标路径越界，已拒绝' };
      }
      if (!fs.existsSync(trashPath)) return { ok: false, message: '回收站里的副本已不存在，无法恢复' };
      if (fs.existsSync(original)) return { ok: false, message: `原路径已被占用（${path.basename(original)}），未覆盖` };
      fs.mkdirSync(path.dirname(original), { recursive: true });
      moveOrCopy(trashPath, original, true);
      await auditWrite({
        workspaceId, actor: identity.name, action: 'write.rollback · fs-trash', target: `${trashPath} → ${original}`,
        result: '放行', severity: 'info', detail: '删除已撤销，文件回到原路径',
      });
      return { ok: true, message: '删除已撤销，文件回到原路径' };
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
