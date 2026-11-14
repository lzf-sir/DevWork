/**
 * 产物预览（侧边工作区 · 一个产物一个 tab）。
 *
 * 只做一件事：把**某一个文件**的内容渲染出来 —— 按扩展名分发渲染器，给下载入口。
 * 产物清单不在这里：清单是「选择动作」，在会话右缘的产物浮层里（见 ChatHudDock），
 * 选完才开这个详情 tab。工作区只装详情，不装列表。
 *
 * 多格式按扩展名分发渲染器，不装成全能 —— 能渲染的如实渲染，不能的给下载：
 *   markdown → Markdown 组件（与会话气泡同一套安全渲染，不碰 raw HTML）；
 *   代码/文本 → highlight 高亮 + 行号（与代码库详情同一把高亮器）；
 *   json     → 美化后走代码视图；
 *   csv/tsv  → 表格；
 *   html     → 沙箱 iframe（allow-scripts、不给同源，脚本跑但摸不到主应用）；
 *   pdf      → 内联 iframe（服务端 ?inline=1 直给 mime）；
 *   图片     → 直接显示；
 *   二进制（docx/xlsx 等）→ 只给元信息与下载入口，不假装能渲染。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { api, type ArtifactPreview, type InlineSeg } from '../api/client';
import { highlight } from '../utils/highlight';
import Markdown, { renderInline } from './Markdown';
import { DownloadIcon } from './icons';

type ViewMode = 'markdown' | 'code' | 'json' | 'csv' | 'html' | 'pdf' | 'image' | 'binary';

const MODE_LABEL: Record<ViewMode, string> = {
  markdown: 'Markdown',
  code: '代码',
  json: 'JSON',
  csv: '表格',
  html: 'HTML',
  pdf: 'PDF',
  image: '图片',
  binary: '二进制',
};

function extOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at >= 0 ? name.slice(at + 1).toLowerCase() : '';
}

/** 扩展名 + 服务端 kind → 渲染模式。kind 管「拿得到什么」，扩展名管「怎么呈现」。 */
function viewModeFor(preview: ArtifactPreview): ViewMode {
  if (preview.kind === 'image') return 'image';
  const ext = extOf(preview.fileName);
  if (preview.kind === 'text') {
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (ext === 'json') return 'json';
    if (ext === 'csv' || ext === 'tsv') return 'csv';
    if (ext === 'html' || ext === 'htm') return 'html';
    return 'code';
  }
  if (ext === 'pdf') return 'pdf';
  return 'binary';
}

/** CSV/TSV 拆表：带引号字段（含转义引号与内嵌分隔符）。 */
function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** JSON 美化；不是 JSON 就原样返回（别为了漂亮编造结构）。 */
function prettyJson(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

/** 原文 → Markdown 组件吃的段落数组（空行分段，每段一个 text 原子段）。 */
function toParas(content: string): InlineSeg[][] {
  return content
    .split(/\n\s*\n/)
    .map((para) => [{ t: 'text', v: para }] as InlineSeg[]);
}

/* ---- 渲染器各自成组件：Hooks 顺序固定，不跨分支调用 ---- */

function ImageBody({ preview }: { preview: ArtifactPreview }): React.ReactElement {
  return (
    <div className="filp-img">
      <img src={preview.url ?? ''} alt={preview.fileName} />
      <div className="filp-cap">
        {preview.fileName} · {Math.max(1, Math.round(preview.sizeBytes / 1024))}KB
      </div>
    </div>
  );
}

function MarkdownBody({ content }: { content: string }): React.ReactElement {
  const paras = useMemo(() => toParas(content), [content]);
  /* 文件预览里没有引用角标交互：text 走行内标记渲染，cite 退化成 [n] 文本。 */
  const renderLine = (segments: InlineSeg[], key: string): React.ReactNode => (
    <span key={key}>
      {segments.map((seg, index) =>
        seg.t === 'cite'
          ? `[${seg.id}]`
          : seg.t === 'strong'
            ? <strong key={`${key}-s${index}`}>{seg.v}</strong>
            : renderInline(seg.v, `${key}-${index}`),
      )}
    </span>
  );
  return (
    <div className="filp-md">
      <Markdown paras={paras} renderLine={renderLine} />
    </div>
  );
}

function CodeBody({ content, fileName }: { content: string; fileName: string }): React.ReactElement {
  const html = useMemo(() => highlight(content, fileName), [content, fileName]);
  return <pre className="filp-text filp-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

function JsonBody({ content, fileName }: { content: string; fileName: string }): React.ReactElement {
  const html = useMemo(() => highlight(prettyJson(content), fileName), [content, fileName]);
  return <pre className="filp-text filp-code" dangerouslySetInnerHTML={{ __html: html }} />;
}

function CsvBody({ content, fileName }: { content: string; fileName: string }): React.ReactElement {
  const table = useMemo(
    () => parseDelimited(content, extOf(fileName) === 'tsv' ? '\t' : ','),
    [content, fileName],
  );
  /* 超大表只渲染前 500 行 × 30 列 —— 预览是「看一眼」，不是数据平台。 */
  const rows = table.slice(0, 500);
  const cols = Math.min(30, rows.reduce((max, row) => Math.max(max, row.length), 0));
  const clipped = table.length > 500 || rows.some((row) => row.length > cols);
  return (
    <div className="filp-scroll">
      <table className="filp-table">
        {rows.length > 0 && rows[0].length > 0 ? (
          <thead>
            <tr>
              {rows[0].slice(0, cols).map((cell, index) => (
                <th key={`h${index}`}>{cell}</th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rows.slice(1).map((row, rowIndex) => (
            <tr key={`r${rowIndex}`}>
              {row.slice(0, cols).map((cell, colIndex) => (
                <td key={`c${colIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {clipped ? <div className="filp-note">表较大，仅显示前 500 行 × 30 列；完整数据请下载。</div> : null}
    </div>
  );
}

function HtmlBody({ content, fileName }: { content: string; fileName: string }): React.ReactElement {
  /* 沙箱 iframe：允许脚本（图表类 HTML 要跑），但不给 allow-same-origin —— 摸不到主应用。 */
  return <iframe className="filp-frame" title={fileName} sandbox="allow-scripts" srcDoc={content} />;
}

function PdfBody({ preview }: { preview: ArtifactPreview }): React.ReactElement {
  return (
    <iframe className="filp-frame" title={preview.fileName} sandbox="allow-scripts" src={preview.url ?? ''} />
  );
}

function BinaryBody({ preview }: { preview: ArtifactPreview }): React.ReactElement {
  return (
    <div className="filp-note">
      {preview.fileName} 是二进制文件（{Math.max(1, Math.round(preview.sizeBytes / 1024))}KB），
      沙箱不解析二进制 —— 点击右上角下载图标保存原文件。
    </div>
  );
}

function PreviewBody({ preview, mode }: { preview: ArtifactPreview; mode: ViewMode }): React.ReactElement {
  const content = preview.content ?? '';
  switch (mode) {
    case 'image':
      return <ImageBody preview={preview} />;
    case 'markdown':
      return <MarkdownBody content={content} />;
    case 'json':
      return <JsonBody content={content} fileName={preview.fileName} />;
    case 'csv':
      return <CsvBody content={content} fileName={preview.fileName} />;
    case 'html':
      return <HtmlBody content={content} fileName={preview.fileName} />;
    case 'pdf':
      return <PdfBody preview={preview} />;
    case 'code':
      return <CodeBody content={content} fileName={preview.fileName} />;
    case 'binary':
    default:
      return typeof preview.content === 'string' ? (
        <pre className="filp-text">{preview.content}</pre>
      ) : (
        <BinaryBody preview={preview} />
      );
  }
}

/** 产物引用：清单行、产物面板、工作区 tab 都用这一对 id/name。 */
export interface ArtifactRef {
  id: string;
  name: string;
}

/** 预览缓存：按产物 id 记住拉到的内容，切走再切回不重新请求。
 *  进程级 Map 不做失效 —— 产物生成后不会被原地改写（重新生成 = 新 id / 新文件名）。 */
const PREVIEW_CACHE = new Map<string, ArtifactPreview>();

/** 单个产物的预览面板 —— 一个产物就是工作区的一个 tab。
 *
 *  这里只管「这一个文件怎么呈现」：拉预览、按格式分发渲染器、给下载入口。
 *  清单与「开哪个」的决策在产物浮层里，不在这。 */
export function ArtifactPreviewPane({ artifact }: { artifact: ArtifactRef }): React.ReactElement {
  const { addToast } = useStore();
  const [preview, setPreview] = useState<ArtifactPreview | null>(PREVIEW_CACHE.get(artifact.id) ?? null);
  const [loading, setLoading] = useState<boolean>(!PREVIEW_CACHE.has(artifact.id));
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const cached = PREVIEW_CACHE.get(artifact.id);
    if (cached) {
      setPreview(cached);
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    setPreview(null);
    void api
      .getArtifactPreview(artifact.id)
      .then((envelope) => {
        if (!alive) return;
        setLoading(false);
        if (!envelope.ok) {
          setError(envelope.error?.message ?? '产物不存在');
          return;
        }
        PREVIEW_CACHE.set(artifact.id, envelope.data);
        setPreview(envelope.data);
      })
      .catch(() => {
        if (!alive) return;
        setLoading(false);
        setError('预览请求失败');
      });
    return () => {
      alive = false;
    };
  }, [artifact.id]);

  const download = (): void => {
    void api.downloadArtifact(artifact.id).then((envelope) => {
      if (!envelope.ok) {
        addToast(`下载失败：${envelope.error?.message ?? '产物不存在'}`);
        return;
      }
      const anchor = document.createElement('a');
      anchor.href = envelope.data.url;
      anchor.download = envelope.data.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      addToast(`已开始下载 ${envelope.data.fileName}`);
    });
  };

  const mode: ViewMode | null = preview ? viewModeFor(preview) : null;

  return (
    <div className="filp">
      <div className="filp-view">
        <div className="filp-hd">
          <span className="filp-name" title={artifact.name}>{artifact.name}</span>
          {mode ? <span className="filp-kind">{MODE_LABEL[mode]}</span> : null}
          <button className="brp-nav" type="button" title="下载原文件" aria-label="下载" onClick={download}>
            <DownloadIcon size={13} strokeWidth={1.4} />
          </button>
        </div>
        {loading ? <div className="filp-note">加载中…</div> : null}
        {error ? <div className="filp-note err">{error}</div> : null}
        {preview && !loading && mode ? <PreviewBody preview={preview} mode={mode} /> : null}
      </div>
    </div>
  );
}
