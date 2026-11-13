/**
 * 文件 / 仓库 / 终端写入契约 —— 前后端唯一真源。
 *
 * 这几条的共同点：都能直接改动磁盘或执行命令，参数错一位就是另一件事
 * （比如 path 少了前缀就写到仓库外），所以形状与长度必须有硬约束。
 */
import { z } from 'zod';

/** 克隆 / 拉取仓库。token 只在内存里拼进 URL，不落库。 */
export const cloneRepoSchema = z.object({
  url: z.string().trim().min(1, '仓库地址不能为空').max(1000),
  branch: z.string().max(200).optional(),
  /** 浅克隆深度；0 表示全量克隆。 */
  depth: z.number().int().min(0).max(1000).optional(),
  token: z.string().max(8192).optional(),
  /** 已有克隆时是否拉取最新。 */
  pull: z.boolean().optional(),
});
export type CloneRepoInput = z.infer<typeof cloneRepoSchema>;

/** 保存文件（整文件覆盖，走 write-executor 的审计与回滚）。 */
export const saveFileSchema = z.object({
  path: z.string().trim().min(1, '文件路径不能为空').max(1000),
  content: z.string().max(5_000_000),
});
export type SaveFileInput = z.infer<typeof saveFileSchema>;

/** Agent 写文件：只产出建议，不直接落盘。 */
export const agentWriteSchema = z.object({
  path: z.string().trim().min(1, '文件路径不能为空').max(1000),
  patch: z.string().max(5_000_000),
});
export type AgentWriteInput = z.infer<typeof agentWriteSchema>;

/** 生成补丁（patch 可留空 = 由服务端根据 path 现状推导）。 */
export const patchFileSchema = z.object({
  path: z.string().trim().min(1, '文件路径不能为空').max(1000),
  patch: z.string().max(5_000_000).optional(),
});
export type PatchFileInput = z.infer<typeof patchFileSchema>;

/** 终端执行：命令白黑名单与 SQL Guard 在服务层，这里只约束形状。 */
export const terminalExecuteSchema = z.object({
  command: z.string().trim().min(1, '命令不能为空').max(20_000),
  sessionId: z.string().max(120).optional(),
});
export type TerminalExecuteInput = z.infer<typeof terminalExecuteSchema>;

/** 终端会话更新（目前只有工作目录）。 */
export const terminalSessionPatchSchema = z.object({
  cwd: z.string().max(1000).optional(),
});
export type TerminalSessionPatch = z.infer<typeof terminalSessionPatchSchema>;
