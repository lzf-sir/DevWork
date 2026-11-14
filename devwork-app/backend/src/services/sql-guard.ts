/**
 * SqlGuard —— 只读 SQL 防火墙（V3）。
 * 拒绝多语句 / DDL / DML / 危险关键字，自动追加 LIMIT 1000 并明示。
 *
 * 危险关键字按**整串**检测（含引号与注释内）—— 这是本文件既有的防绕过立场：
 * 一旦关键字扫描只看代码区，`SELECT 'DROP'` 就能把危险关键字藏进字面量，
 * 靠关键字白名单做裁决就不再可靠。多语句与首关键字才需要引号感知
 * （字面量里的分号不是语句分隔符，字面量里的字母不是首关键字）。
 *
 * 执行用**原文**：早期版本用正则剥注释后执行，`SELECT '--x'` 这类语句
 * 会被剥成残句（语法错误），写通道里还会把 `VALUES('--x')` 的内容吃掉。
 */
import { ApiFailure } from '../http/core';
import { firstWordOf, hasTopLevelSemicolon, scanSql } from './sql-scan';

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

/**
 * 查找「顶层」LIMIT 子句：忽略子查询括号内的 LIMIT，也忽略字符串字面量里的
 * 伪关键字。返回最后一个顶层 LIMIT 的位置与取值，供 ④ 判断是否追加 / 改写。
 *
 * 位置在 execSql 上定位（与 codeMask 等长），因此改写后原文字面量原样保留。
 */
function findTopLevelLimit(sql: string, codeMask: string): { found: boolean; value: number; start: number; end: number } {
  const regex = /\bLIMIT\s+(-?\d+)/gi;
  const topLevel: boolean[] = [];
  let depth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    topLevel[i] = depth === 0;
  }

  let found = false;
  let value = 0;
  let start = -1;
  let end = -1;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    const at = match.index;
    // 仅接受位于顶层、且不在字面量/注释内的 LIMIT；子查询里的 LIMIT 不算。
    if (!topLevel[at]) continue;
    if (codeMask.slice(at, at + match[0].length).trim() === '') continue;
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

  /* 引号 / 注释感知的扫描：多语句与首关键字只看代码区。 */
  const scan = scanSql(statement);
  const codeMask = scan.codeMask;

  /* ③ 危险关键字扫描（整串，含引号与注释内）—— 防绕过立场：
   *    关键字若能藏进字面量或注释，扫描就等于没做。 */
  const detected = FORBIDDEN.filter((keyword) => new RegExp(`\\b${keyword}\\b`, 'i').test(statement));

  /* ① 代码区里的分号 → 多语句（末尾分号已去除）。 */
  const multiStatement = hasTopLevelSemicolon(codeMask.replace(/;+\s*$/, ''));

  /* ② 首关键字必须 SELECT / WITH / EXPLAIN。 */
  const firstWord = firstWordOf(codeMask);
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

  /* ④ 顶层 LIMIT：无则追加，>maxRows 替换。
   * 改写作用在 execSql 上 —— 字面量内容原样保留，不会被清洗结果改写。 */
  const limit = findTopLevelLimit(scan.execSql, codeMask);
  let sql = scan.execStatement;
  let injected = false;
  let appliedLimit = limit.value;
  if (!limit.found) {
    sql = `${scan.execStatement}\nLIMIT ${maxRows}`;
    injected = true;
    appliedLimit = maxRows;
  } else if (limit.value > maxRows) {
    sql = `${scan.execSql.slice(0, limit.start)}LIMIT ${maxRows}${scan.execSql.slice(limit.end)}`.trim();
    appliedLimit = maxRows;
  }
  return {
    sql,
    guard: {
      injected,
      appliedLimit,
      notice: injected ? `已自动追加 LIMIT ${maxRows}` : `LIMIT 已限制为 ${appliedLimit}`,
    },
    detected,
    statement,
    multiStatement,
    normalized: sql,
  };
}
