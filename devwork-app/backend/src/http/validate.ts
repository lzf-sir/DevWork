/**
 * 请求体校验：用 shared/contracts 里的 zod schema 校验并收窄类型。
 *
 * 为什么在服务端做：前端校验是体验，改包或直接调 API 都能绕过；
 * 这一层是契约的最终防线，失败统一抛 E_VALIDATION（HTTP 400，见 ERROR_STATUS）。
 */
import type { Request } from 'express';
import { z } from 'zod';
import { ApiFailure } from './core';

export function parseBody<S extends z.ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const parsed = schema.safeParse(req.body ?? {});
  if (parsed.success) return parsed.data;

  /* 只报第一处问题：前端表单需要的是「改哪里」，不是一屏错误列表。 */
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? issue.path.join('.') : 'body';
  throw new ApiFailure(
    'E_VALIDATION',
    `${where}: ${issue?.message ?? '字段不合法'}`,
    parsed.error.issues,
  );
}
