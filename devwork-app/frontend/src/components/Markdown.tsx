/**
 * 轻量 Markdown 渲染：只覆盖模型输出里真正会出现的子集
 * —— 围栏代码块、标题、有序/无序列表、引用、行内 `code` 与 **加粗**。
 *
 * 为什么不引第三方 md 解析器：模型输出属于不可信内容，多一个解析器就多一份
 * XSS 面。这里全部走 React 文本节点，标签天然转义，不渲染任何 raw HTML。
 */
import React from 'react';
import type { InlineSeg } from '../api/client';

/** 行内标记：`code` 与 **加粗**。刻意不支持 raw HTML / 图片，避免注入面。 */
const INLINE_TOKEN = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

export function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE_TOKEN.lastIndex = 0;
  while ((match = INLINE_TOKEN.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(
        <code className="md-code" key={`${keyPrefix}-c${match.index}`}>
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      nodes.push(<strong key={`${keyPrefix}-b${match.index}`}>{token.slice(2, -2)}</strong>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Line = InlineSeg[];

type Block =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'heading'; level: number; line: Line }
  | { kind: 'list'; ordered: boolean; items: Line[] }
  | { kind: 'quote'; lines: Line[] }
  | { kind: 'paragraph'; lines: Line[] };

/** 把段落按换行拆成"行"，但保留 cite/strong 这类原子段的身份，引用角标不会丢。 */
function splitLines(segments: InlineSeg[]): Line[] {
  const lines: Line[] = [[]];
  segments.forEach((segment) => {
    if (segment.t !== 'text') {
      lines[lines.length - 1].push(segment);
      return;
    }
    const parts = segment.v.split('\n');
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part.length > 0) lines[lines.length - 1].push({ t: 'text', v: part });
    });
  });
  return lines;
}

function lineText(line: Line): string {
  return line
    .map((segment) => (segment.t === 'cite' ? `[${segment.id}]` : segment.v))
    .join('');
}

/** 去掉行首的标记字符（列表符号 / 标题井号 / 引用尖括号），返回剩余段。 */
function dropPrefix(line: Line, count: number): Line {
  let left = count;
  const out: Line = [];
  line.forEach((segment) => {
    if (left <= 0) {
      out.push(segment);
      return;
    }
    if (segment.t !== 'text') {
      out.push(segment);
      return;
    }
    if (segment.v.length <= left) {
      left -= segment.v.length;
      return;
    }
    out.push({ t: 'text', v: segment.v.slice(left) });
    left = 0;
  });
  return out;
}

/** 段落数组 → 块数组。跨段落的围栏代码块在这里合并，不会被 '\n\n' 拆断。 */
export function parseBlocks(paras: InlineSeg[][]): Block[] {
  const lines: (Line | null)[] = [];
  paras.forEach((para, index) => {
    if (index > 0) lines.push(null); // null = 段落边界
    splitLines(para).forEach((line) => lines.push(line));
  });

  const blocks: Block[] = [];
  let buffer: Line[] = [];
  let list: { ordered: boolean; items: Line[] } | null = null;
  let quote: Line[] = [];

  const flush = (): void => {
    if (buffer.length > 0) {
      blocks.push({ kind: 'paragraph', lines: buffer });
      buffer = [];
    }
    if (list && list.items.length > 0) {
      blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    }
    list = null;
    if (quote.length > 0) {
      blocks.push({ kind: 'quote', lines: quote });
      quote = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === null) {
      flush();
      continue;
    }
    const text = lineText(line).trim();

    if (text.startsWith('```')) {
      flush();
      const lang = text.slice(3).trim();
      const body: string[] = [];
      let started = false;
      let pendingBlank = false;
      index += 1;
      while (index < lines.length) {
        const next = lines[index];
        if (next === null) {
          /* 段落边界在围栏内代表一个空行；围栏刚打开时的边界不算（否则代码首行多空行）。 */
          if (started) pendingBlank = true;
          index += 1;
          continue;
        }
        const raw = lineText(next);
        if (raw.trim().startsWith('```')) break;
        if (raw.trim().length === 0) {
          if (started) pendingBlank = true;
          index += 1;
          continue;
        }
        /* 连续空行折叠成一个：服务端按 '\n\n' 切段，多个空行会产出空段落，
           不折叠会把 2 个空行放大成 4 个。 */
        if (pendingBlank && body.length > 0) body.push('');
        pendingBlank = false;
        started = true;
        body.push(raw);
        index += 1;
      }
      blocks.push({ kind: 'code', lang: lang || 'text', code: body.join('\n') });
      continue;
    }

    if (text.length === 0) {
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+/.exec(text);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', level: heading[1].length, line: dropPrefix(line, heading[0].length) });
      continue;
    }

    const bullet = /^[-*+]\s+/.exec(text);
    if (bullet) {
      if (!list || list.ordered) {
        flush();
        list = { ordered: false, items: [] };
      }
      list.items.push(dropPrefix(line, bullet[0].length));
      continue;
    }

    const numbered = /^\d+[.)]\s+/.exec(text);
    if (numbered) {
      if (!list || !list.ordered) {
        flush();
        list = { ordered: true, items: [] };
      }
      list.items.push(dropPrefix(line, numbered[0].length));
      continue;
    }

    const quoted = /^>\s?/.exec(text);
    if (quoted) {
      if (buffer.length > 0 || list) flush();
      quote.push(dropPrefix(line, quoted[0].length));
      continue;
    }

    if (quote.length > 0) flush();
    if (list) flush();
    buffer.push(line);
  }
  flush();
  return blocks;
}

interface MarkdownProps {
  /** 服务端按 '\n\n' 切好的段落，每段是带引用角标的分段数组。 */
  paras: InlineSeg[][];
  /** 单行的分段渲染器（由 ChatView 提供，负责 cite 点击等交互）。 */
  renderLine: (segments: InlineSeg[], key: string) => React.ReactNode;
  /** 代码块右上角的复制按钮。 */
  onCopy?: (code: string) => void;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'md-h1',
  2: 'md-h2',
  3: 'md-h3',
  4: 'md-h4',
  5: 'md-h5',
  6: 'md-h6',
};

export default function Markdown({ paras, renderLine, onCopy }: MarkdownProps): React.ReactElement {
  const blocks = React.useMemo(() => parseBlocks(paras), [paras]);
  return (
    <div className="md">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'code':
            return (
              <div className="md-codewrap" key={key}>
                <div className="md-codehead">
                  <span>{block.lang}</span>
                  {onCopy ? (
                    <button className="md-copy" type="button" onClick={() => onCopy(block.code)}>
                      复制
                    </button>
                  ) : null}
                </div>
                <pre className="md-pre">
                  <code>{block.code}</code>
                </pre>
              </div>
            );
          case 'heading': {
            const Tag = (`h${Math.min(6, Math.max(1, block.level))}` as unknown) as 'h1';
            return (
              <Tag className={`md-h ${HEADING_CLASS[block.level] ?? 'md-h6'}`} key={key}>
                {renderLine(block.line, key)}
              </Tag>
            );
          }
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag className={`md-list${block.ordered ? ' md-ol' : ''}`} key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-i${itemIndex}`}>{renderLine(item, `${key}-i${itemIndex}`)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote className="md-quote" key={key}>
                {block.lines.map((line, lineIndex) => (
                  <p key={`${key}-l${lineIndex}`}>{renderLine(line, `${key}-l${lineIndex}`)}</p>
                ))}
              </blockquote>
            );
          default:
            return (
              <p key={key}>
                {block.lines.map((line, lineIndex) => (
                  <React.Fragment key={`${key}-l${lineIndex}`}>
                    {lineIndex > 0 ? <br /> : null}
                    {renderLine(line, `${key}-l${lineIndex}`)}
                  </React.Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
