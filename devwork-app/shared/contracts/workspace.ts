/**
 * 工作区 / 分组 / 条目移动契约 —— 前后端唯一真源。
 *
 * parentId / targetFolderId 一律允许 null：null 表示「挪到根」，
 * 与「不传此字段（不改动）」是两种不同语义，schema 必须能区分。
 */
import { z } from 'zod';

export const workspaceCreateSchema = z.object({
  name: z.string().trim().min(1, '工作区名称不能为空').max(120),
  description: z.string().max(500).optional(),
});
export type WorkspaceCreateInput = z.infer<typeof workspaceCreateSchema>;

export const workspacePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
});
export type WorkspacePatchInput = z.infer<typeof workspacePatchSchema>;

/** 分组（文件夹）：kind 区分资产组与会话组。 */
export const folderCreateSchema = z.object({
  workspaceId: z.string().min(1).max(64).optional(),
  kind: z.string().max(32).optional(),
  name: z.string().trim().min(1, '分组名称不能为空').max(120),
  parentId: z.string().min(1).max(64).nullable().optional(),
});
export type FolderCreateInput = z.infer<typeof folderCreateSchema>;

export const folderPatchSchema = z.object({
  name: z.string().trim().min(1, '分组名称不能为空').max(120).optional(),
  /** 折叠状态要落库，否则重进应用抽屉会全弹开。 */
  collapsed: z.boolean().optional(),
  parentId: z.string().min(1).max(64).nullable().optional(),
});
export type FolderPatchInput = z.infer<typeof folderPatchSchema>;

/** 批量重排：按给定顺序落 sort_order。 */
export const folderReorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'ids 不能为空').max(2000),
});
export type FolderReorderInput = z.infer<typeof folderReorderSchema>;

/** 条目移动到分组（targetFolderId 为 null = 挪回根）。 */
export const itemsMoveSchema = z.object({
  itemId: z.string().min(1, 'itemId 不能为空').max(64),
  kind: z.string().min(1).max(32),
  targetFolderId: z.string().min(1).max(64).nullable().optional(),
});
export type ItemsMoveInput = z.infer<typeof itemsMoveSchema>;
