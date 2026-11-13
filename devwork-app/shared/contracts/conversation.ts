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
});
export type TruncateMessagesInput = z.infer<typeof truncateMessagesSchema>;
