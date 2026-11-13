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

/** 敏感文件规则（整表替换）：id / pattern / description 三元组。 */
export const sensitiveRulesSchema = z.object({
  rules: z.array(z.object({
    id: z.string().min(1).max(32),
    pattern: z.string().min(1).max(200),
    description: z.string().max(200),
  })).max(500),
});
export type SensitiveRulesInput = z.infer<typeof sensitiveRulesSchema>;

/** 权限探测：按动作 / 资产 / 风险等级推导「当前配置下会不会被拦」。 */
export const permissionProbeSchema = z.object({
  action: z.string().trim().min(1, 'action 不能为空').max(120),
  actor: z.string().max(120).optional(),
  assetId: z.string().max(64).optional(),
  risk: z.string().max(32).optional(),
});
export type PermissionProbeInput = z.infer<typeof permissionProbeSchema>;

/**
 * 设置分区更新：键由分区自身定义（含 `perm.` 前缀的扁平键），
 * 因此这里只能是开放记录 —— 严格列字段反而会把设置项写死在契约里。
 */
export const settingSectionPatchSchema = z.record(z.unknown());
export type SettingSectionPatch = z.infer<typeof settingSectionPatchSchema>;
