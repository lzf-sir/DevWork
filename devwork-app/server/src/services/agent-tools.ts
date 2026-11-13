/**
 * AgentTools —— 派生工具面的真实执行器（V1 七组只读工具）。
 *
 * 每个 实现 都必须「真」：要么真实读盘/真实查询/真实 HTTP，要么如实报降级，
 * 绝不编造输出（这是本仓库从 V8 起的铁律）。
 * 写工具（v2）在这里只表达意图不执行——执行走 write-executor 的三层防线，
 * 且只有「会话级审批记忆」命中时才会真正落盘。
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readContent, fileOutline, fileDiff } from './file-service';
import { resolveRepoRoot } from './workspace-repos';
import { runSqlQuery } from './sql-query';
import { listObjects, tableFields } from './sql-browse';
import { searchAsset as searchIndex, chunkById } from './indexer';
import { all } from '../db/database';
import { readLogLines, filterByWindow } from './log-sink';
import { normalizeBrowserUrl, readBrowserPage, writeBrowserState } from './browser';
import { PORT, browserAllowPrivate } from '../config';
import type { Identity } from '../http/core';
import type { CitationSeed, ToolExecutionResult } from './llm-gateway';
import type { DerivedTool } from '../config/tool-catalog';

export interface ToolContext {
  assetId: string;
  workspaceId: string;
  conversationId: string;
  identity: Identity;
}

function snippetOf(content: string): string {
  return content.split('\n').slice(0, 5).join('\n');
}

/** 索引检索（kb_search / code_search 共用实现）。 */
async function searchTool(assetId: string, query: string, sourceLabel: string): Promise<ToolExecutionResult> {
  const hits = await searchIndex(assetId, query);
  if (hits.length === 0) {
    return {
      ok: true,
      result: `未命中任何片段（资产=${assetId} · query=${query}）。没有证据就不该有结论。`,
      citations: [],
    };
  }
  const citations: CitationSeed[] = [];
  for (const hit of hits.slice(0, 4)) {
    const chunk = await chunkById(hit.id);
    if (!chunk) continue;
    citations.push({
      title: hit.title,
      source: `${sourceLabel} · ${hit.path}`,
      locator: hit.locator,
      snippet: snippetOf(chunk.content),
      confidence: Number(hit.score) || 0.8,
      version: hit.kind === 'doc' ? 'doc' : 'code',
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      kind: hit.kind,
    });
  }
  const summary = hits.map((hit) => `- ${hit.title} · ${hit.locator} · 相关度 ${hit.score}`).join('\n');
  return { ok: true, result: `命中 ${hits.length} 个片段（资产=${assetId}）\n${summary}`, citations };
}

/** API 资产的真实端点清单（本服务自身的只读 REST 面）。 */
export const API_ENDPOINTS: { method: string; path: string; desc: string; readOnly: boolean }[] = [
  { method: 'GET', path: '/api/health', desc: '健康检查（git/docker 探测）', readOnly: true },
  { method: 'GET', path: '/api/workspaces', desc: '工作区列表', readOnly: true },
  { method: 'GET', path: '/api/assets', desc: '资产列表', readOnly: true },
  { method: 'GET', path: '/api/skills', desc: '技能清单（含派生可用性）', readOnly: true },
  { method: 'GET', path: '/api/settings', desc: '设置快照', readOnly: true },
  { method: 'GET', path: '/api/cmd-templates', desc: '命令模板库（意图导向）', readOnly: true },
  { method: 'GET', path: '/api/tools', desc: '派生工具面（诊断）', readOnly: true },
];

/** api_call_read 的路径白名单 = 规范清单里的只读端点。 */
function isAllowedApiPath(pathname: string): boolean {
  return API_ENDPOINTS.some((endpoint) => endpoint.readOnly && endpoint.path === pathname);
}

/**
 * 派生工具执行入口。
 * 只读工具在这里真实执行；写工具只表达意图（真实执行在 write-executor，
 * 由审批批准或会话级记忆触发）。
 */
export async function executeAgentTool(
  toolName: string,
  args: Record<string, unknown>,
  tool: DerivedTool | undefined,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const assetId = tool?.assetId ?? ctx.assetId;

  switch (toolName) {
    /* ---- 通用 ---- */
    case 'ws_list_assets': {
      const rows = all<Record<string, unknown>>(
        'SELECT id, type, name, env, status, credential_bound FROM asset WHERE workspace_id = ? ORDER BY created_at, id',
        ctx.workspaceId,
      );
      const lines = rows.map((row) => `- ${row.id} · ${row.type} · ${row.name}${row.env ? ` · ${row.env}` : ''} · ${row.status}`);
      return { ok: true, result: `工作区 ${ctx.workspaceId} 共 ${rows.length} 个资产：\n${lines.join('\n')}` };
    }

    /* ---- 内置浏览器：Agent 真的能"开网页"，而不只是文案 ---- */
    case 'browser_navigate': {
      /* Agent 侧默认禁私有网段：借浏览器探本机/内网是 SSRF 的经典入口。
       * 自托管部署可显式放开（DEVWORK_BROWSER_ALLOW_PRIVATE=1）。
       * 用户手动导航不受此限（用户自己想去哪是他的自由度）。 */
      const normalized = normalizeBrowserUrl(args.url, { allowPrivate: browserAllowPrivate() });
      if (!normalized.ok) return { ok: false, result: `导航被拒：${normalized.reason}` };
      const state = await writeBrowserState(ctx.conversationId, normalized.url ?? '', 'agent');
      return {
        ok: true,
        result: [
          `内置浏览器已导航到 ${normalized.url}`,
          '右栏「浏览器」Tab 已同步该地址（用户可见）。',
          `要读这页内容，请再调 browser_read_page（页面快照由前端回传）。`,
          `state: by=${state.by} · ${state.updatedAt}`,
        ].join('\n'),
      };
    }
    case 'browser_read_page': {
      const page = await readBrowserPage(ctx.conversationId);
      if (!page.text.trim()) {
        return {
          ok: false,
          result: page.url
            ? `当前页 ${page.url} 还没有页面快照（前端未回传正文，或页面是纯图片/空白）。`
            : '内置浏览器还没有导航过任何页面，也没有页面快照。',
        };
      }
      return {
        ok: true,
        result: [
          `标题：${page.title || '（无标题）'}`,
          `地址：${page.url || '（未知）'}`,
          `抓取时间：${page.capturedAt}`,
          '正文：',
          page.text,
        ].join('\n'),
      };
    }

    /* ---- codebase ---- */
    case 'code_search': {
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, result: 'query 参数为空' };
      return searchTool(assetId, query, '代码库');
    }
    case 'code_read': {
      const rel = String(args.path ?? '').trim();
      if (!rel) return { ok: false, result: 'path 参数为空' };
      try {
        const content = await readContent(assetId, rel);
        if (!content.plain) return { ok: true, result: `文件存在但为空，或该资产没有本地克隆：${rel}` };
        return { ok: true, result: `${rel}（${content.language}）前 80 行：\n${content.plain.split('\n').slice(0, 80).join('\n')}` };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, result: `读取被拦截：${message}` };
      }
    }
    case 'code_symbols': {
      const rel = String(args.path ?? '').trim();
      if (!rel) return { ok: false, result: 'path 参数为空' };
      try {
        const outline = await fileOutline(assetId, rel);
        const symbols = outline.symbols.map((s) => `- [${s.sg}] ${s.label} @ L${s.line}`).join('\n');
        return { ok: true, result: `${rel} 符号大纲：\n${symbols}\n${outline.references.join('；')}\n${outline.git.join(' · ')}` };
      } catch (error) {
        return { ok: false, result: `大纲失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }
    case 'code_diff': {
      const rel = String(args.path ?? '').trim();
      if (!rel) return { ok: false, result: 'path 参数为空' };
      try {
        const diff = await fileDiff(assetId, rel);
        return { ok: true, result: diff.clean ? `${rel} 相对 HEAD 无变更（clean）` : `${rel} 的未提交变更：\n${diff.diff.slice(0, 3000)}` };
      } catch (error) {
        return { ok: false, result: `diff 失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }

    case 'code_todos': {
      /* 真实遍历仓库源码，扫 TODO/FIXME/HACK 标记。跳过依赖与构建产物，
       * 单文件 200KB 封顶（防扫描二进制/压缩产物），总量上限由 max 参数控制。 */
      const root = await resolveRepoRoot(assetId);
      const max = Math.min(Math.max(Number(args.max ?? 30) || 30, 1), 100);
      const skipDirs = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'tmp', '.devwork-snapshots']);
      const textExt = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.go', '.sql', '.css', '.scss', '.md', '.json', '.yaml', '.yml', '.html', '.vue']);
      const pattern = /\b(TODO|FIXME|HACK)\b[:\s]?([^\n]{0,120})/;
      const findings: string[] = [];
      const walk = (dir: string, depth: number): void => {
        if (depth > 8 || findings.length >= max) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (findings.length >= max) return;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!skipDirs.has(entry.name)) walk(full, depth + 1);
            continue;
          }
          if (!textExt.has(path.extname(entry.name).toLowerCase())) continue;
          try {
            const stat = fs.statSync(full);
            if (stat.size > 200 * 1024) continue;
            const content = fs.readFileSync(full, 'utf8');
            content.split('\n').forEach((line, index) => {
              if (findings.length >= max) return;
              const match = pattern.exec(line);
              if (match) {
                const rel = path.relative(root, full).replace(/\\/g, '/');
                findings.push(`- ${rel}:L${index + 1} · ${match[1]} · ${(match[2] ?? '').trim() || '（无说明）'}`);
              }
            });
          } catch { /* 不可读文件跳过，不中断扫描 */ }
        }
      };
      walk(root, 0);
      return {
        ok: true,
        result: findings.length === 0
          ? '仓库内未扫到 TODO/FIXME/HACK 标记（真实扫描，未编造）'
          : `扫到 ${findings.length} 个标记（上限 ${max}）：\n${findings.join('\n')}`,
      };
    }

    /* ---- database ---- */
    case 'db_query': {
      const sql = String(args.sql ?? '').trim();
      if (!sql) return { ok: false, result: 'sql 参数为空' };
      const result = await runSqlQuery(sql, { maxRows: 200, timeoutMs: 8000 }, ctx.identity, assetId);
      const sample = result.rows.slice(0, 8).map((row) => JSON.stringify(row)).join('\n');
      return {
        ok: true,
        result: `查询成功 · ${result.rowCount} 行 · ${result.durationMs}ms · checksum ${result.dbChecksumBefore === result.dbChecksumAfter ? '未变化' : '变化'}\n采样：\n${sample}`,
      };
    }
    case 'db_schema': {
      const table = String(args.table ?? '').trim();
      if (table) {
        const fields = tableFields(table);
        const columns = fields.columns.map((c) => `- ${c.name} · ${c.type}${c.nullable ? ' · NULL' : ''}`).join('\n');
        return {
          ok: true,
          result: `表 ${table}：\n${columns}\n索引：${fields.indexes.map((idx) => idx.join(',')).join('；') || '无'}\n外键：${fields.foreignKeys.map((fk) => fk.join(',')).join('；') || '无'}`,
        };
      }
      const objects = listObjects();
      const nodes = objects.nodes.slice(0, 30).map((node) => `- ${node.name}（${node.kind}）`).join('\n');
      return { ok: true, result: `数据库表清单（${objects.nodes.length} 个）：\n${nodes}` };
    }

    case 'db_tables': {
      /* 行数画像：逐表真实 COUNT（上限 20 表）。scale 判断与数据倾斜排查的第一步。 */
      const objects = listObjects();
      const tables = objects.nodes.filter((node) => node.kind === 'table').map((node) => node.name);
      const requested = String(args.tables ?? '').split(',').map((t) => t.trim()).filter(Boolean);
      const targets = (requested.length > 0 ? requested : tables).slice(0, 20);
      if (targets.length === 0) return { ok: false, result: '数据库中未发现表（真实查询，未编造）' };
      const results: string[] = [];
      for (const table of targets) {
        try {
          const result = await runSqlQuery(`SELECT COUNT(*) AS n FROM "${table}"`, { maxRows: 1, timeoutMs: 5000 }, ctx.identity, assetId);
          const row = result.rows[0] as unknown as Record<string, unknown> | undefined;
          const count = Number(row?.n ?? row?.N ?? 0);
          results.push(`- ${table}：${count} 行`);
        } catch (error) {
          results.push(`- ${table}：计数失败（${error instanceof Error ? error.message.slice(0, 60) : String(error).slice(0, 60)}）`);
        }
      }
      return {
        ok: true,
        result: `行数画像（${results.length}/${tables.length} 表，上限 20）：\n${results.join('\n')}`,
      };
    }

    /* ---- knowledge ---- */
    case 'kb_search': {
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, result: 'query 参数为空' };
      return searchTool(assetId, query, '运营知识库');
    }

    /* ---- server ---- */
    case 'srv_status': {
      const procCount = await new Promise<number>((resolve) => {
        const cmd = process.platform === 'win32' ? 'tasklist' : 'ps';
        const argv = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['aux'];
        execFile(cmd, argv, { timeout: 4000, windowsHide: true }, (error, stdout) => {
          if (error) { resolve(-1); return; }
          resolve(stdout.split('\n').filter((line) => line.trim() !== '').length);
        });
      });
      const sessionRows = all<{ n: number }>('SELECT COUNT(*) AS n FROM terminal_session');
      const sessions = Number(sessionRows[0]?.n ?? 0);
      return {
        ok: true,
        result: [
          `主机：${os.platform()} ${os.arch()} · CPU ${os.cpus().length} 核 · 内存 ${Math.round(os.totalmem() / 1024 ** 3)}G（空闲 ${Math.round(os.freemem() / 1024 ** 3)}G）`,
          `uptime ${Math.floor(os.uptime() / 3600)}h · 进程数 ${procCount >= 0 ? procCount : '采集失败（真实探测，未编造）'}`,
          `资产绑定终端会话：${sessions} 个`,
        ].join('\n'),
      };
    }
    case 'srv_log_tail': {
      const lines = Math.min(Math.max(Number(args.lines ?? 20) || 20, 1), 100);
      const all0 = readLogLines();
      const tail = all0.slice(-lines);
      return {
        ok: true,
        result: tail.length === 0
          ? '日志文件为空（真实读取，未编造）'
          : `日志尾部 ${tail.length}/${all0.length} 行：\n${tail.map((line) => line.raw).join('\n')}`,
      };
    }

    /* ---- log 资产 ---- */
    case 'log_query': {
      const query = String(args.query ?? '').trim().toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit ?? 30) || 30, 1), 100);
      let lines = readLogLines();
      const total = lines.length;
      lines = filterByWindow(lines, args.from ? String(args.from) : undefined, args.to ? String(args.to) : undefined);
      if (query) lines = lines.filter((line) => line.raw.toLowerCase().includes(query));
      const sample = lines.slice(-limit);
      return {
        ok: true,
        result: `日志检索：总 ${total} 行 → 命中 ${lines.length} 行（显示末尾 ${sample.length} 行）\n${sample.map((line) => line.raw).join('\n') || '（无命中）'}`,
      };
    }

    /* ---- api 资产 ---- */
    case 'api_spec_read': {
      const list = API_ENDPOINTS.map((endpoint) => `- ${endpoint.method} ${endpoint.path} · ${endpoint.desc}${endpoint.readOnly ? ' · 只读' : ' · 副作用（不派生）'}`).join('\n');
      return { ok: true, result: `API 资产端点规范（${API_ENDPOINTS.length} 个，全部只读）：\n${list}` };
    }
    case 'api_call_read': {
      const pathname = String(args.path ?? '').trim();
      if (!pathname.startsWith('/api/')) return { ok: false, result: '路径必须以 /api/ 开头' };
      if (!isAllowedApiPath(pathname)) {
        return { ok: false, result: `路径不在只读规范清单内（防副作用调用）：${pathname}。可用：${API_ENDPOINTS.filter((e) => e.readOnly).map((e) => e.path).join(', ')}` };
      }
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: AbortSignal.timeout(6000) });
        const body = await response.text();
        return { ok: true, result: `GET ${pathname} → HTTP ${response.status}\n${body.slice(0, 1500)}` };
      } catch (error) {
        return { ok: false, result: `API 调用失败（真实结果）：${error instanceof Error ? error.message : String(error)}` };
      }
    }

    default:
      return { ok: false, result: `未知只读工具：${toolName}` };
  }
}
