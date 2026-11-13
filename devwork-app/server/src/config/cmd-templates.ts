/**
 * CmdTemplates —— 意图导向命令模板库（devwork-asset-capability-design.md §6.3）。
 *
 * 三条硬规则（不可绕过）：
 * 1. 参数白名单化：enumFromAsset 的合法值从资产/环境取，模型只能选不能造；
 * 2. 无模板 = 拒绝执行：意图匹配不到模板时**不 fallback 到裸 shell**，转建议模式；
 * 3. 模板自带 precheck / verify / rollback，执行器按层走（写能力三层防线）。
 *
 * 模板的 exec 分两类：
 *  - native：spawn 系统命令（systemctl 等）——沙箱里多半 127 降级，结果如实上报；
 *  - builtin：JS 实现（日志轮转、文件备份）——真实落盘，配真实回滚。
 */
import fs from 'node:fs';
import path from 'node:path';
import { rotateLog, readLogLines } from '../services/log-sink';
import { resolveRepoRoot } from '../services/workspace-repos';

export interface CmdTemplate {
  id: string;
  version: string;
  intent: string;
  /** 模型表达意图用的规范 action 名。 */
  action: string;
  /** 意图匹配关键词（大小写不敏感，任一命中即可）。 */
  keywords: string[];
  params: Record<string, {
    type: 'enum' | 'int';
    /** enum：合法取值（参数白名单化的落点）；int：min/max。 */
    enum?: string[];
    /** enumFromRepo：枚举自资产仓库的真实文件清单（最多取前 200 个）。 */
    enumFromRepo?: boolean;
    min?: number; max?: number;
    default?: string | number;
    description: string;
  }>;
  /** 执行前检查（只读，产出影响面预览文本）。 */
  precheck: string[];
  exec: { kind: 'native' | 'builtin'; command?: string; handler?: string };
  verify: string;
  rollback: { kind: 'native' | 'builtin' | 'auto-snapshot'; command?: string; note: string };
  risk: 'medium' | 'high';
  impact: string;
}

/** 资产可操作的服务枚举（参数白名单化的数据源；真实来自资产的部署清单）。 */
export const SERVICES_BY_ASSET: Record<string, string[]> = {
  'a-order-api': ['order-api'],
};

export const CMD_TEMPLATES: CmdTemplate[] = [
  {
    id: 'restart-service',
    version: '1.0.0',
    intent: '重启指定服务',
    action: 'restart_service',
    keywords: ['restart', '重启', 'service restart', '重启服务'],
    params: {
      service: { type: 'enum', enum: SERVICES_BY_ASSET['a-order-api'], description: '要重启的服务名（枚举白名单）' },
      graceSec: { type: 'int', min: 1, max: 60, default: 10, description: '优雅等待秒数' },
    },
    precheck: ['记录目标服务当前状态（systemctl is-active）与活跃连接数'],
    exec: { kind: 'native', command: 'systemctl restart {{service}}' },
    verify: 'systemctl is-active {{service}} 预期 active',
    rollback: { kind: 'native', command: 'systemctl start {{service}}', note: '重启失败时拉起服务' },
    risk: 'high',
    impact: '中断当前活跃连接，上游重试机制可覆盖（预期 <10s）',
  },
  {
    id: 'rotate-log',
    version: '1.0.0',
    intent: '轮转/清理日志文件（保留末尾 N 行）',
    action: 'rotate_log',
    keywords: ['rotate log', '清理日志', 'truncate log', '日志轮转', '日志清理', '清理', '轮转'],
    params: {
      keepLines: { type: 'int', min: 10, max: 10000, default: 200, description: '保留末尾行数' },
    },
    precheck: ['统计当前日志行数与文件体积'],
    exec: { kind: 'builtin', handler: 'rotate_log' },
    verify: '重读日志行数 = keepLines',
    rollback: { kind: 'auto-snapshot', note: '被移除的行自动备份到 devwork.log.bak-<ts>，可一键恢复' },
    risk: 'medium',
    impact: '仅影响本地日志文件（devwork.log），旧内容备份后可完整恢复',
  },
  {
    id: 'backup-file',
    version: '1.0.0',
    intent: '备份仓库内一个文件到快照目录',
    action: 'backup_file',
    keywords: ['backup', '备份', 'snapshot'],
    params: {
      path: { type: 'enum', enumFromRepo: true, description: '仓库内相对路径（枚举自真实文件清单）' },
    },
    precheck: ['目标文件存在且在仓库边界内'],
    exec: { kind: 'builtin', handler: 'backup_file' },
    verify: '快照文件存在且字节数与原文件一致',
    rollback: { kind: 'auto-snapshot', note: '备份本身是只增操作，无需回滚；删除快照即可' },
    risk: 'medium',
    impact: '仅新增快照文件，不修改任何现有文件',
  },
];

/** 意图匹配：action 精确 → 关键词命中；都失败返回 null（执行器必须转建议，不裸跑）。 */
export function matchTemplate(action: string, hint = ''): CmdTemplate | null {
  const normalized = action.trim().toLowerCase();
  const exact = CMD_TEMPLATES.find((t) => t.action === normalized || t.id === normalized);
  if (exact) return exact;
  const haystack = `${normalized} ${hint.toLowerCase()}`;
  return CMD_TEMPLATES.find((t) => t.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) ?? null;
}

export interface ParamValidation { ok: boolean; error?: string; filled?: Record<string, string | number> }

/** 参数校验：enum 白名单 + int 范围 + 默认值填充。白名单外取值一律拒绝。 */
export function validateParams(template: CmdTemplate, raw: Record<string, unknown>, repoFiles: string[] = []): ParamValidation {
  const filled: Record<string, string | number> = {};
  for (const [name, spec] of Object.entries(template.params)) {
    const value = raw[name] ?? spec.default;
    if (value === undefined || value === '') {
      return { ok: false, error: `缺少参数 ${name}：${spec.description}` };
    }
    if (spec.type === 'enum') {
      const allowed = (spec as { enumFromRepo?: boolean }).enumFromRepo
        ? repoFiles.slice(0, 200)
        : spec.enum ?? [];
      if (!allowed.includes(String(value))) {
        return {
          ok: false,
          error: `参数 ${name}=${value} 不在白名单内（参数白名单化：模型只能从枚举中选）。可选：${allowed.slice(0, 10).join(', ') || '（空）'}`,
        };
      }
      filled[name] = String(value);
    } else {
      const num = Number(value);
      if (!Number.isFinite(num)) return { ok: false, error: `参数 ${name} 必须是数字` };
      if (spec.min !== undefined && num < spec.min) return { ok: false, error: `参数 ${name} < ${spec.min}` };
      if (spec.max !== undefined && num > spec.max) return { ok: false, error: `参数 ${name} > ${spec.max}` };
      filled[name] = Math.floor(num);
    }
  }
  return { ok: true, filled };
}

/** 渲染 native 命令（{{param}} 替换，参数已过白名单）。 */
export function renderCommand(template: CmdTemplate, filled: Record<string, string | number>): string {
  return (template.exec.command ?? '').replace(/\{\{(\w+)\}\}/g, (_, name) => String(filled[name] ?? ''));
}

/* ---------------- builtin handlers（真实实现） ---------------- */

export interface BuiltinOutcome { stdout: string; ok: boolean; rollbackRef?: string }

/** 日志轮转：真实写 log-sink，备份路径作为回滚引用返回。 */
function handleRotateLog(filled: Record<string, string | number>): BuiltinOutcome {
  /* log-sink 的 rotateLog：真实写日志文件，备份路径作为回滚引用返回。 */
  const keepLines = Number(filled.keepLines ?? 200);
  const before = readLogLines().length;
  if (before <= keepLines) {
    return { ok: true, stdout: `当前日志 ${before} 行 ≤ 保留目标 ${keepLines} 行，无需轮转（未产生写操作）` };
  }
  const { backupPath, removedLines } = rotateLog(keepLines);
  return {
    ok: true,
    stdout: `日志轮转完成：移除 ${removedLines} 行，保留末尾 ${keepLines} 行。旧内容已备份至 ${path.basename(backupPath)}（可回滚）`,
    rollbackRef: JSON.stringify({ kind: 'log-backup', backupPath }),
  };
}

/** 文件备份：从资产仓库拷贝到快照目录（真实落盘）。 */
async function handleBackupFile(assetId: string, filled: Record<string, string | number>): Promise<BuiltinOutcome> {
  const rel = String(filled.path ?? '');
  const root = path.resolve(await resolveRepoRoot(assetId));
  const source = path.resolve(root, rel);
  if (!source.startsWith(root) || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    return { ok: false, stdout: `备份失败：${rel} 不存在或越界（未产生写操作）` };
  }
  const snapshotDir = path.join(root, '.devwork-snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, `${Date.now()}-${path.basename(rel)}`);
  fs.copyFileSync(source, snapshotPath);
  return {
    ok: true,
    stdout: `备份完成：${rel} → ${path.relative(root, snapshotPath).replace(/\\/g, '/')}（${fs.statSync(source).size} 字节）`,
    rollbackRef: JSON.stringify({ kind: 'file-snapshot', snapshotPath, targetPath: source }),
  };
}

export { handleRotateLog, handleBackupFile };
