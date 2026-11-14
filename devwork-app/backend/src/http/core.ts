import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { orgName } from '../db/repositories';

/** 统一响应包络：{ ok, data, error, meta }。 */
export interface Envelope<T> {
  ok: boolean;
  data: T;
  error: { code: string; message: string; details?: unknown } | null;
  meta: { requestId: string; ts: number; apiMode: 'live' };
}

export const ERROR_STATUS: Record<string, number> = {
  E_VALIDATION: 400,
  E_NOT_FOUND: 404,
  E_WORKSPACE_MISMATCH: 409,
  E_PERMISSION_DENIED: 403,
  E_READONLY_SUGGEST: 409,
  E_TERMINAL_SESSION_LIMIT: 409,
  E_SQL_REJECTED: 422,
  E_SQL_SYNTAX: 400,
  E_SQL_TIMEOUT: 504,
  E_PATH_ESCAPE: 403,
  E_SENSITIVE_FILE: 403,
  E_CREDENTIAL_REQUIRED: 409,
  E_CREDENTIAL_EXPIRED: 409,
  E_CREDENTIAL_REVOKED: 409,
  /* 浏览器直连被拒（非开发模式必须通过桌面软件打开）。 */
  E_SHELL_REQUIRED: 403,
  E_ALREADY_RESOLVED: 409,
  E_POLICY_LOCKED: 409,
  /* 资产类型不匹配（如向 server 资产要 SQL 表结构）：语义错误，不是服务端故障。 */
  E_ASSET_NOT_DB: 422,
  /* 本机没有 git 可执行文件：环境缺依赖，重试无用，但也不是请求本身错了。 */
  E_GIT_UNAVAILABLE: 503,
  /* 请求体超过解析上限（body-parser 的 entity.too.large）：413 而不是 400，
   * 前端据此提示「分批发送」，而不是让用户去改字段。 */
  E_PAYLOAD_TOO_LARGE: 413,
  E_INTERNAL: 500,
};

export function ok<T>(res: Response, data: T, status = 200): Response {
  const envelope: Envelope<T> = {
    ok: true,
    data,
    error: null,
    meta: { requestId: randomUUID(), ts: Date.now(), apiMode: 'live' },
  };
  return res.status(status).json(envelope);
}

export function fail(
  res: Response,
  code: string,
  message: string,
  status?: number,
  details?: unknown,
): Response {
  const envelope: Envelope<Record<string, never>> = {
    ok: false,
    data: {},
    error: { code, message, details },
    meta: { requestId: randomUUID(), ts: Date.now(), apiMode: 'live' },
  };
  return res.status(status ?? ERROR_STATUS[code] ?? 500).json(envelope);
}

export class ApiFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** 把 async 路由的异常统一转成包络，避免 unhandled rejection。 */
export function wrap(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch((error: unknown) => {
      if (error instanceof ApiFailure) {
        fail(res, error.code, error.message, ERROR_STATUS[error.code], error.details);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      fail(res, 'E_INTERNAL', message, 500);
    });
  };
}

export interface Identity {
  name: string;
  org: string;
  actor: 'user';
  source: 'user';
}

/** 纯本地工具没有账号体系：审计主体固定为「本机用户」。 */
export const LOCAL_IDENTITY_NAME = '本机用户';

/**
 * 身份一律为本地固定值。
 *
 * 旧版本从登录会话 / 请求头 / member 表推导「我是谁、什么角色」；
 * 现在没有账号体系，也不再采信任何请求头里的身份声明 —— 参数保留只是为了
 * 不打断既有调用点，返回值与请求内容无关。
 */
export function identity(_req?: Request): Identity {
  return { name: LOCAL_IDENTITY_NAME, org: orgName(), actor: 'user', source: 'user' };
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiFailure('E_VALIDATION', `${field} 必须是非空字符串`);
  }
  return value;
}

export function queryString(req: Request, key: string, fallback = ''): string {
  const value = req.query[key];
  return typeof value === 'string' ? value : fallback;
}
