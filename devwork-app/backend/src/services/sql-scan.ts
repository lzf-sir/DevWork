/**
 * SQL 扫描器 —— 引号 / 注释感知。
 *
 * 存在的原因：早期实现用正则剥注释（`/\\*...\\*\\//` 与 `/--...$/`），
 * 完全不识别引号，于是把字符串字面量里的内容当成注释吃掉——
 * 例如 `INSERT INTO t(v) VALUES('<注释符>x<注释符>')` 实际落库变成了 `" "`，
 * 读侧 `SELECT 'x<注释符>y<注释符>z'` 则返回了错误的数据。
 * 更糟的是「剥注释后的结果」被直接当作要执行的 SQL 发给数据库，
 * 于是判定用的清洗结果变成了真正执行的语句。
 *
 * 这里给出两份等长视图，长度与原串一致，位置一一对应：
 * - execSql：只把注释内容置空，字符串字面量原样保留 → 可安全执行；
 * - codeMask：注释内容与字符串字面量内容都置空 → 用于「代码区」判定
 *   （分号计数、危险关键字），避免把数据误判成语法。
 *
 * 换行符始终保留，保证行号与列号不错位。
 */

export interface SqlScan {
  /** 与原串等长：注释置空、字面量保留 —— 执行用。 */
  execSql: string;
  /** 与原串等长：注释与字面量内容都置空 —— 代码区判定用。 */
  codeMask: string;
  /** 去掉末尾分号后的执行语句（可直接交给数据库）。 */
  execStatement: string;
}

/** 注释 / 字面量内部的字符一律置空（保留 \r\n），其余原样拷贝。 */
function blank(text: string): string {
  let out = '';
  for (const char of text) {
    out += char === '\n' || char === '\r' ? char : ' ';
  }
  return out;
}

/**
 * 扫描 SQL，产出两份等长视图。
 *
 * 识别的语法要素：
 * - 单引号字符串 `'...'`（`''` 为转义）；
 * - 双引号标识符 `"..."`（`""` 为转义）与反引号标识符 `` `...` ``；
 * - 行注释 `-- ...` 到行尾；
 * - 块注释（斜杠星号 … 星号斜杠，未闭合时按「到串尾」处理）。
 */
export function scanSql(raw: string): SqlScan {
  const execChars: string[] = [];
  const maskChars: string[] = [];
  const length = raw.length;
  let i = 0;

  while (i < length) {
    const char = raw[i];

    /* 行注释：-- 到行尾。 */
    if (char === '-' && raw[i + 1] === '-') {
      let end = i;
      while (end < length && raw[end] !== '\n') end += 1;
      const chunk = raw.slice(i, end);
      execChars.push(blank(chunk));
      maskChars.push(blank(chunk));
      i = end;
      continue;
    }

    /* 块注释：从斜杠星号开始，到星号斜杠结束（未闭合则到串尾）。 */
    if (char === '/' && raw[i + 1] === '*') {
      let end = i + 2;
      while (end < length && !(raw[end] === '*' && raw[end + 1] === '/')) end += 1;
      const close = end < length ? end + 2 : end;
      const chunk = raw.slice(i, close);
      execChars.push(blank(chunk));
      maskChars.push(blank(chunk));
      i = close;
      continue;
    }

    /* 字符串 / 标识符：引号内的内容一律视作数据。 */
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      let end = i + 1;
      while (end < length) {
        if (raw[end] === quote) {
          /* 双写转义：'' / "" / `` */
          if (raw[end + 1] === quote) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      const chunk = raw.slice(i, Math.min(end, length));
      execChars.push(chunk);
      maskChars.push(blank(chunk));
      i = Math.min(end, length);
      continue;
    }

    execChars.push(char);
    maskChars.push(char);
    i += 1;
  }

  const execSql = execChars.join('');
  const codeMask = maskChars.join('');
  /* 末尾分号只是语句结束符，不是多语句；去掉它再判定与执行。 */
  const execStatement = execSql.trim().replace(/;+\s*$/, '').trim();
  return { execSql, codeMask, execStatement };
}

/** 代码区里是否还有分号（字面量与注释内的分号不算）。 */
export function hasTopLevelSemicolon(codeMask: string): boolean {
  return codeMask.includes(';');
}

/** 取代码区的首个单词（首关键字判定用）。 */
export function firstWordOf(codeMask: string): string {
  return (codeMask.match(/^\s*([A-Za-z]+)/)?.[1] ?? '').toUpperCase();
}
