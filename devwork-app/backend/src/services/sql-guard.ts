/**
 * SqlGuard —— 只读 SQL 防火墙（V3）。
 * 拒绝多语句 / DDL / DML / 危险关键字，自动追加 LIMIT 1000 并明示。
 * 引号与注释内的危险关键字同样检测（防绕过）。
 */
import { ApiFailure } from '../http/core';

export interface GuardResult {
  sql: string;
  guard: { injected: boolean; appliedLimit: number; notice: string };
  detected: string[];
  statement: string;
  multiStatement: boolean;
  normalized: string;
}

/* 注意：REPLACE 不在此列。它是合法只读函数 SELECT REPLACE(name,'a','b')，
 * 而真正危险的 REPLACE INTO 会被下面"首关键字必须是 SELECT/WITH/EXPLAIN"拦掉。
 * 误杀合法查询比漏杀更伤信任——用户会以为安全策略不可靠。 */
const FORBIDDEN = [
  'DROP', 'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CREATE', 'TRUNCATE',
  'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'load_extension',
  'BEGIN', 'COMMIT', 'ROLLBACK', 'GRANT', 'REVOKE', 'MERGE', 'EXEC',
];

const FIRST_KEYWORDS = ['SELECT', 'WITH', 'EXPLAIN'];

/** 去掉行注释与块注释（保留字符串字面量内容）。 */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/**
 * 查找「顶层」LIMIT 子句：忽略子查询括号内的 LIMIT，也忽略字符串字面量里的
 * 伪关键字。返回最后一个顶层 LIMIT 的位置与取值，供 ④ 判断是否追加 / 改写。
 * 引号感知（单引号 '' 与双引号 "" 转义）与括号深度扫描都在这里真正生效，
 * 不再保留 QA 指出的「算完不用」的死代码。
 */
function findTopLevelLimit(sql: string): { found: boolean; value: number; start: number; end: number } {
  const regex = /\bLIMIT\s+(\d+)/gi;
  const topLevel: boolean[] = [];
  const quote: (string | null)[] = [];
  let activeQuote: string | null = null;
  let depth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    quote[i] = activeQuote;
    if (activeQuote) {
      if (char === activeQuote) {
        if (sql[i + 1] === activeQuote) {
          quote[i + 1] = activeQuote;
          i += 1;
        } else {
          activeQuote = null;
        }
      }
      topLevel[i] = false;
      continue;
    }
    if (char === '\'' || char === '"') {
      activeQuote = char;
      quote[i] = char;
      topLevel[i] = false;
      continue;
    }
    topLevel[i] = depth === 0;
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
  }

  let found = false;
  let value = 0;
  let start = -1;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    const at = match.index;
    // 仅接受位于顶层、且不在引号内的 LIMIT；子查询里的 LIMIT 不算。
    if (!topLevel[at] || quote[at] !== null) continue;
    found = true;
    value = Number(match[1]);
    start = at;
    end = at + match[0].length;
  }
  return { found, value, start, end };
}

/** 校验并改写 SQL；拒绝时抛 ApiFailure(E_SQL_REJECTED)。 */
export function guard(raw: string, maxRows = 1000): GuardResult {
  const statement = raw.trim();
  if (statement === '') {
    throw new ApiFailure('E_SQL_REJECTED', 'SQL 不能为空', {
      detected: [], statement, multiStatement: false,
    });
  }

  /* ③ 全串扫描危险关键字（引号 / 注释内同样检测）。 */
  const upper = statement.toUpperCase();
  const detected = FORBIDDEN.filter((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(upper));

  /* ① 去注释后非末尾单分号 → 多语句。 */
  const cleaned = stripComments(statement).trim().replace(/;+\s*$/, '').trim();
  const multiStatement = /;/.test(cleaned);

  /* ② 首关键字必须 SELECT / WITH / EXPLAIN。 */
  const firstWord = (cleaned.match(/^\s*([A-Za-z]+)/)?.[1] ?? '').toUpperCase();
  const validFirst = FIRST_KEYWORDS.includes(firstWord);

  if (detected.length > 0 || multiStatement || !validFirst) {
    throw new ApiFailure(
      'E_SQL_REJECTED',
      detected.length > 0
        ? `只读执行：检测到禁止关键字 ${detected.join(', ')}，未发送到数据库`
        : multiStatement
          ? '只读执行：禁止多语句，未发送到数据库'
          : '只读执行：仅允许 SELECT / WITH / EXPLAIN，未发送到数据库',
      { detected, statement, multiStatement },
    );
  }

  /* ④ 顶层 LIMIT：无则追加，>maxRows 替换。 */
  const limit = findTopLevelLimit(cleaned);
  let sql = cleaned;
  let injected = false;
  let appliedLimit = limit.value;
  if (!limit.found) {
    sql = `${cleaned}\nLIMIT ${maxRows}`;
    injected = true;
    appliedLimit = maxRows;
  } else if (limit.value > maxRows) {
    sql = `${cleaned.slice(0, limit.start)}LIMIT ${maxRows}${cleaned.slice(limit.end)}`;
    appliedLimit = maxRows;
  }
  return {
    sql,
    guard: {
      injected,
      appliedLimit,
      notice: injected ? '已自动追加 LIMIT 1000' : `LIMIT 已限制为 ${appliedLimit}`,
    },
    detected,
    statement,
    multiStatement,
    normalized: sql,
  };
}
