/**
 * 桌面壳门禁 —— 「浏览器直连」与「软件打开」的边界。
 *
 * 需求：只有本地开发模式允许浏览器访问；非开发模式必须通过 DevWork 软件打开，
 * 浏览器地址直连一律拒绝。
 *
 * 判定：后端进程的 env 里有 DEVWORK_SHELL_TOKEN —— 说明它是桌面壳拉起的
 * （main.cjs spawnBackend 注入），即「软件模式」，此时启用门禁；
 * npm run dev / 手动起的后端没有这个 env，是「开发模式」，不做限制。
 *
 * 令牌落盘（DATA_DIR/shell-token）而不是只放 env：托盘常驻 + 二次启动会
 * 复用已在跑的后端（main.cjs bootstrap / scripts/start.mjs 都有复用路径），
 * 新的壳实例必须能认出同一个后端的令牌才不会把自己挡在门外。
 * 文件是跨进程的唯一信源：谁先认领谁写入，后来者一律读文件（flag 'wx' 防并发双写）。
 *
 * 为什么豁免 /api/health：探活方太多（main.cjs probe、start.mjs 自检、wait-on、
 * 测试等待器），它只暴露 Node/驱动版本这类元信息，不是应用数据。
 *
 * 这不是防本机恶意进程的安全边界（同机攻击者能直接读令牌文件与 sqlite），
 * 它是产品形态约束：这个软件要用软件打开，而不是一个挂在 3001 端口的网页。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { DATA_DIR } from '../config';
import { fail } from './core';

export const SHELL_TOKEN_FILE = path.join(DATA_DIR, 'shell-token');

/** 门禁是否启用：桌面壳拉起的后端才有 DEVWORK_SHELL_TOKEN。 */
export const GATE_ENABLED = (process.env.DEVWORK_SHELL_TOKEN ?? '').trim() !== '';

function persist(token: string): void {
  try {
    fs.mkdirSync(path.dirname(SHELL_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(SHELL_TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch {
    /* 已存在 / 无写权限：内存值兜底，单实例仍可用。 */
  }
}

/**
 * 令牌解析（幂等）。优先级：令牌文件 > env 显式指定 > 新生成。
 * 文件优先，保证壳与后端、以及复用同一后端的多个壳实例认同一枚令牌。
 */
export function ensureShellToken(): string {
  try {
    const fromFile = fs.readFileSync(SHELL_TOKEN_FILE, 'utf8').trim();
    if (fromFile !== '') return fromFile;
  } catch {
    /* 文件不存在 → 按下面的优先级认领。 */
  }
  const fromEnv = (process.env.DEVWORK_SHELL_TOKEN ?? '').trim();
  const token = fromEnv !== '' ? fromEnv : randomBytes(32).toString('hex');
  persist(token);
  return token;
}

/** 定长比较，避免按字符提前返回。 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const GATE_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>请通过 DevWork 软件打开</title>',
  '<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;background:#FAFAF9;color:#232320;',
  'display:grid;place-items:center;height:100vh;margin:0}h2{font-weight:500}p{color:#6B6B66;',
  'font-size:13px;line-height:1.8;max-width:520px}code{background:#EFEFEC;padding:2px 6px;border-radius:4px}</style>',
  '</head><body><div><h2>请通过 DevWork 软件打开</h2>',
  '<p>浏览器直连已停用：本应用在非开发模式下只允许桌面客户端访问。</p>',
  '<p>请启动 DevWork 桌面软件使用本应用。本地开发请执行 <code>npm run dev</code>（开发模式不做此限制）。</p>',
  '</div></body></html>',
].join('');

/**
 * 门禁中间件。开发模式（无 DEVWORK_SHELL_TOKEN）直接放行；
 * 软件模式下：/api/health 探活豁免、OPTIONS 预检放行，其余请求必须带对令牌。
 */
export function shellGate(): RequestHandler {
  /* 令牌在启动时认领一次（仅软件模式），避免每个请求碰磁盘。 */
  const token = GATE_ENABLED ? ensureShellToken() : '';
  return (req: Request, res: Response, next: NextFunction) => {
    if (!GATE_ENABLED) { next(); return; }
    if (req.method === 'OPTIONS') { next(); return; }
    /* 探活豁免（见文件头注释）；它不是应用数据入口。 */
    if (req.path === '/api/health') { next(); return; }
    if (tokenMatches(req.get('X-DevWork-Token') ?? '', token)) { next(); return; }

    if (req.path.startsWith('/api/')) {
      fail(res, 'E_SHELL_REQUIRED', '请通过 DevWork 软件打开：浏览器直连已禁用', 403);
      return;
    }
    res.status(403).type('html').send(GATE_HTML);
  };
}
