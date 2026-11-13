/**
 * 会话写入契约 —— 前后端唯一真源。
 *
 * 注意 content 不做 min(1)：「重试」走同一个端点、沿用已有用户气泡，
 * 此时 content 允许为空、靠 regenerate 触发。把它设成必填会打断重试链路。
 */
import { z } from 'zod';

export const sendMessageSchema = z.object({
  content: z.string().max(200_000, '消息内容过长'),
  assetIds: z.array(z.string().min(1)).max(50).optional(),
  /** 已上传附件的文件名（先走 POST /attachments，再随消息提交）。 */
  attachments: z.array(z.string().min(1)).max(20).optional(),
  /** 会话级模型覆盖：只影响本次调用，不改全局配置。 */
  model: z.string().max(120).optional(),
  /** 重试：沿用已有用户气泡重新生成回复，不再插入新气泡。 */
  regenerate: z.boolean().optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

/** 消息时间线截断（撤回 / 编辑重发共用）。 */
export const truncateMessagesSchema = z.object({
  messageId: z.string().min(1),
  /** inclusive 连目标一起删；after 保留目标（用户气泡）删其后全部。 */
  mode: z.enum(['inclusive', 'after']).optional(),
});
export type TruncateMessagesInput = z.infer<typeof truncateMessagesSchema>;

/** 新建会话：普通会话不带资产绑定，从资产页唤起的会话带上。 */
export const conversationCreateSchema = z.object({
  title: z.string().max(300).optional(),
  workspaceId: z.string().min(1).max(64).optional(),
  folderId: z.string().min(1).max(64).nullable().optional(),
  assetId: z.string().min(1).max(64).nullable().optional(),
  assetType: z.string().max(32).optional(),
});
export type ConversationCreateInput = z.infer<typeof conversationCreateSchema>;

/** 会话属性更新（改名 / 归档）。 */
export const conversationPatchSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(300).optional(),
  archived: z.boolean().optional(),
});
export type ConversationPatchInput = z.infer<typeof conversationPatchSchema>;

/** 附件上传：内容走 base64，落盘后返回文件名随消息提交。 */
export const attachmentUploadSchema = z.object({
  name: z.string().trim().min(1, '文件名不能为空').max(255),
  contentBase64: z.string().min(1).max(20_000_000),
});
export type AttachmentUploadInput = z.infer<typeof attachmentUploadSchema>;

/** 工具调用审批：approve 放行，其余一律按拒绝处理（与服务工作层一致）。 */
export const approvalDecisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  /** once = 只此一次；session = 本会话内同类都放行。 */
  scope: z.enum(['once', 'session']).optional(),
  conversationId: z.string().min(1).max(64).optional(),
  rollbackRef: z.string().max(120).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

/** 命令建议（模型提议一条命令，等待用户确认后才执行）。 */
export const commandSuggestionSchema = z.object({
  command: z.string().trim().min(1, '命令不能为空').max(20_000),
  reason: z.string().max(2000).optional(),
  conversationId: z.string().min(1).max(64).optional(),
});
export type CommandSuggestionInput = z.infer<typeof commandSuggestionSchema>;

/** 内置浏览器导航：地址必须先归一化（服务层 normalizeBrowserUrl 负责）。 */
export const browserNavSchema = z.object({
  url: z.string().trim().min(1, 'URL 不能为空').max(2000),
});
export type BrowserNavInput = z.infer<typeof browserNavSchema>;

/** 浏览器页面内容写回（标题 + 正文快照）。 */
export const browserPageSchema = z.object({
  title: z.string().max(500).optional(),
  text: z.string().max(2_000_000).optional(),
});
export type BrowserPageInput = z.infer<typeof browserPageSchema>;

/** 审批回滚：只需要指出属于哪个会话。 */
export const approvalRollbackSchema = z.object({
  conversationId: z.string().min(1).max(64).optional(),
});
export type ApprovalRollbackInput = z.infer<typeof approvalRollbackSchema>;
