/**
 * 轻量语法高亮：按语言对每行做单遍 tokenizer，输出 HTML span。
 * 仅用于「查看态」渲染；用户开始编辑后降级纯文本（保光标稳定，不重建 DOM）。
 */

const KEYWORDS: Record<string, string[]> = {
  Java: ['public', 'private', 'protected', 'class', 'interface', 'enum', 'static', 'final', 'void', 'return', 'new', 'this', 'extends', 'implements', 'import', 'package', 'throws', 'try', 'catch', 'finally', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'null', 'true', 'false', 'int', 'long', 'double', 'boolean', 'String', 'var'],
  JavaScript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue', 'new', 'this', 'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'null', 'undefined', 'true', 'false'],
  JSON: ['true', 'false', 'null'],
  YAML: [],
  XML: [],
  Markdown: [],
};

const COLORS = {
  string: '#a5b576',
  comment: 'var(--gray-400)',
  keyword: '#c678dd',
  number: '#d19a66',
  annotation: '#e5c07b',
} as const;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const detect = (path: string): string => {
  if (path.endsWith('.java')) return 'Java';
  if (/\.(ts|tsx|js|jsx|cjs|mts)$/.test(path)) return 'JavaScript';
  if (path.endsWith('.json')) return 'JSON';
  if (/\.(yml|yaml)$/.test(path)) return 'YAML';
  if (/\.(xml|html)$/.test(path)) return 'XML';
  if (/\.(md|markdown)$/.test(path)) return 'Markdown';
  return 'Text';
};

const TOKEN_RE = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/.*$|\/\*.*?(?:\*\/|$)|#.*$|<!--.*?-->|@\w+|\d+(?:\.\d+)?|\w+)/g;

/** 单行 tokenize：字符串/注释/关键字/数字/注解一次扫描，逐段转义后拼接。 */
function highlightLine(line: string, lang: string): string {
  if (lang === 'Text' || lang === 'Markdown') return escapeHtml(line);
  const keywords = KEYWORDS[lang] ?? KEYWORDS.JavaScript;
  const out: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(line)) !== null) {
    if (match.index > last) out.push(escapeHtml(line.slice(last, match.index)));
    const token = match[0];
    const escaped = escapeHtml(token);
    if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) {
      out.push(`<span style="color:${COLORS.string}">${escaped}</span>`);
    } else if (token.startsWith('//') || token.startsWith('/*') || token.startsWith('#') || token.startsWith('<!--')) {
      out.push(`<span style="color:${COLORS.comment}">${escaped}</span>`);
    } else if (token.startsWith('@')) {
      out.push(`<span style="color:${COLORS.annotation}">${escaped}</span>`);
    } else if (keywords.includes(token)) {
      out.push(`<span style="color:${COLORS.keyword}">${escaped}</span>`);
    } else if (/^\d/.test(token)) {
      out.push(`<span style="color:${COLORS.number}">${escaped}</span>`);
    } else {
      out.push(escaped);
    }
    last = match.index + token.length;
  }
  if (last < line.length) out.push(escapeHtml(line.slice(last)));
  return out.join('');
}

/** 多行文本 → 高亮 HTML（每行一个 div，与编辑器 gutter 对齐）。 */
export function highlight(plain: string, filePath: string): string {
  const lang = detect(filePath);
  return plain
    .split(/\r?\n/)
    .map((line) => `<div>${highlightLine(line, lang) || '&nbsp;'}</div>`)
    .join('');
}

/**
 * 查找态渲染（B19）：放弃语法高亮，纯文本 + <mark> 全量标注。
 * 返回每个命中所在行号（occurrence 顺序），供「下一个」滚动定位。
 */
export function markAll(
  plain: string,
  query: string,
  current: number,
): { html: string; lineOf: number[] } {
  const needle = escapeHtml(query).toLowerCase();
  const rows: string[] = [];
  const lineOf: number[] = [];
  let occ = 0;
  plain.split(/\r?\n/).forEach((line, lineIdx) => {
    const escaped = escapeHtml(line);
    if (!query || !needle) {
      rows.push(`<div>${escaped || '&nbsp;'}</div>`);
      return;
    }
    const hay = escaped.toLowerCase();
    const parts: string[] = [];
    let last = 0;
    let at = hay.indexOf(needle);
    while (at !== -1) {
      parts.push(escaped.slice(last, at));
      const isCur = occ === current;
      parts.push(
        `<mark data-cur="${isCur ? '1' : '0'}" style="background:${isCur ? '#e5c07b' : 'rgba(229,192,123,0.30)'};color:#1a1d29;border-radius:2px">${escaped.slice(at, at + needle.length)}</mark>`,
      );
      lineOf.push(lineIdx + 1);
      occ += 1;
      last = at + needle.length;
      at = hay.indexOf(needle, last);
    }
    parts.push(escaped.slice(last));
    rows.push(`<div>${parts.join('') || '&nbsp;'}</div>`);
  });
  return { html: rows.join(''), lineOf };
}
