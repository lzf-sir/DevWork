/**
 * SQL 端点写入契约 —— 前后端唯一真源。
 *
 * 注意：这里**不做 SQL 语法校验**。SQL Guard 是独立的一层（服务层），
 * 本契约只管「有没有 sql、格式认不认」，越权判断留给 guard 并返回 422 E_SQL_REJECTED。
 */
import { z } from 'zod';

export const sqlQuerySchema = z.object({
  /* 不设 min(1)：空语句 / 越权语句属于 SQL Guard 的判定范围，
   * 由它返回 422 E_SQL_REJECTED。契约层抢先拒成 400 会破坏这条既有语义。 */
  sql: z.string().max(200_000),
  options: z.object({
    maxRows: z.number().int().min(1).max(100_000).optional(),
    timeoutMs: z.number().int().min(100).max(600_000).optional(),
  }).optional(),
});
export type SqlQueryInput = z.infer<typeof sqlQuerySchema>;

/* 与路由分支一一对应：json / md / sql，其余一律按 csv 处理。 */
export const SQL_EXPORT_FORMATS = ['csv', 'json', 'md', 'sql'] as const;
export type SqlExportFormat = (typeof SQL_EXPORT_FORMATS)[number];

export const sqlExportSchema = z.object({
  sql: z.string().max(200_000).optional(),
  format: z.enum(SQL_EXPORT_FORMATS).optional(),
});
export type SqlExportInput = z.infer<typeof sqlExportSchema>;
