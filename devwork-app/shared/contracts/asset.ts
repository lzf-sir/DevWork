/**
 * 资产写入契约 —— 前后端唯一真源。
 *
 * 为什么只覆盖写入侧：读侧形状由 repositories 的 *Shape 函数稳定产出，长期一致；
 * 真正会漂移的是「客户端提交什么」。这里用 zod 一个定义同时给出运行时校验与编译期类型。
 *
 * 校验放在后端而不是前端：前端那层是体验，改包或直接调 API 都能绕过，服务端必须独立挡得住。
 */
import { z } from 'zod';

/* 词表与守卫在 vocab.ts（零依赖）：前端只需要它们时不该被迫引入 zod。 */
export { ASSET_TYPES, isAssetType } from './vocab';
export type { AssetType } from './vocab';
import { ASSET_TYPES } from './vocab';

/** 凭据载荷：秘密值只在当次动作里出现，落库前由 safeStorage 加密。 */
export const credentialInputSchema = z.object({
  label: z.string().trim().min(1, '凭据标签不能为空').max(64),
  secret: z.string().max(8192).optional(),
  username: z.string().max(256).optional(),
  /** 鉴权方式：password / token / key ……语义由 credential 服务解释，这里只约束形状。 */
  method: z.string().max(32).optional(),
});
export type CredentialInput = z.infer<typeof credentialInputSchema>;

/**
 * 创建资产。
 *
 * workspaceId 故意可选：服务端保留「未指定则落默认工作区」的既有语义，
 * 直接升为必填会打断现有调用方。
 */
export const assetCreateSchema = z.object({
  workspaceId: z.string().min(1).max(64).optional(),
  type: z.enum(ASSET_TYPES),
  name: z.string().trim().min(1, '资产名称不能为空').max(120),
  env: z.string().max(40).optional(),
  subtitle: z.string().max(200).optional(),
  folderId: z.string().min(1).nullable().optional(),
  /** 连接串 / 仓库地址（兼容串），服务端落 asset.config.endpoint。 */
  endpoint: z.string().max(500).optional(),
  /** 按类型注册表生成的结构化配置；服务端另有一层白名单清洗，这里只管形状。 */
  config: z.record(z.unknown()).optional(),
  credential: credentialInputSchema.optional(),
});
export type AssetCreateInput = z.infer<typeof assetCreateSchema>;

/** 更新资产：全部字段可选，语义与创建一致。 */
export const assetPatchSchema = assetCreateSchema.partial();
export type AssetPatchInput = z.infer<typeof assetPatchSchema>;

/** 索引进度上报：to 为目标百分比，delta 为增量，二选一。 */
export const indexProgressSchema = z.object({
  to: z.number().min(0).max(100).optional(),
  delta: z.number().optional(),
});
export type IndexProgressInput = z.infer<typeof indexProgressSchema>;

/** 能力授权开关 / 审批方式。 */
export const capabilityPatchSchema = z.object({
  granted: z.boolean().optional(),
  approval: z.string().max(32).optional(),
});
export type CapabilityPatchInput = z.infer<typeof capabilityPatchSchema>;

/** 资产内检索（FTS + LIKE 双路，服务层合并）。 */
export const assetSearchSchema = z.object({
  query: z.string().max(500),
});
export type AssetSearchInput = z.infer<typeof assetSearchSchema>;
