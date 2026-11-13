/**
 * 设置 / 模型配置写入契约 —— 前后端唯一真源。
 *
 * 这里参数最多、默认值最绕（provider 决定 baseUrl 兜底、apiKey 留空表示不改动），
 * 所以形状必须有一处权威定义，而不是散在 handler 的 typeof 判断里。
 *
 * 约定：字段一律可选，缺省语义由服务端解释（沿用档案现值 / 预设兜底）；
 * 本条只负责「类型对了、长度有界」，不替业务判断必填。
 */
import { z } from 'zod';

/** 模型 Key：写进本机钥匙串，不落数据库。 */
export const llmKeySchema = z.object({
  secret: z.string().trim().min(1, 'secret 不能为空').max(8192),
});
export type LlmKeyInput = z.infer<typeof llmKeySchema>;

/**
 * 模型档案（创建 / 更新 / 全局配置共用）。
 * apiKey 留空 = 不改动已保存的 Key —— 因此不能设 min(1)。
 */
export const llmProfileSchema = z.object({
  provider: z.string().max(40).optional(),
  baseUrl: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  label: z.string().max(120).optional(),
  apiKey: z.string().max(8192).optional(),
});
export type LlmProfileInput = z.infer<typeof llmProfileSchema>;

/** 连通性测试：profileId 指定测哪条档案自己的 Key。 */
export const llmTestSchema = z.object({
  baseUrl: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(8192).optional(),
  profileId: z.string().max(64).optional(),
});
export type LlmTestInput = z.infer<typeof llmTestSchema>;

/** 动态拉取可用模型列表。 */
export const llmModelsSchema = z.object({
  baseUrl: z.string().max(500).optional(),
  provider: z.string().max(40).optional(),
  profileId: z.string().max(64).optional(),
  apiKey: z.string().max(8192).optional(),
});
export type LlmModelsInput = z.infer<typeof llmModelsSchema>;
