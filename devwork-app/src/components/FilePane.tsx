/**
 * 文件查看（右栏工作台 · 文件 Tab）。
 *
 * 产物预览需要版面 —— 气泡里塞不下一个图或一段代码。所以点产物卡 / 产物行之后，
 * 真正的预览落在这里：左边是本会话的产物清单，下方是打开的标签页，右侧是激活产物的内容。
 *
 * 多标签：产物开多少个都行（上限 12），点切换、点 × 关闭，中键也关。
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
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { api, type ArtifactPreview, type InlineSeg } from '../api/client';
import { useLiveData } from '../api/live';
import { highlight } from '../utils/highlight';
import Markdown, { renderInline } from './Markdown';
import { DownloadIcon, FileIcon } from './icons';

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

export default function FilePane(): React.ReactElement {
  const { state, addToast, openArtifact, closeArtifact, setArtifactActive } = useStore();
  const { OUTPUT_FILES } = useLiveData();
  const tabs = state.artifactTabs;
  const selected = state.artifactView;

  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  /* 预览缓存：切回已看过的标签不重新拉。Map 不触发渲染，读写走 ref。 */
  const cacheRef = useRef<Map<string, ArtifactPreview>>(new Map());

  /* 选中产物 → 拉预览。产物 id 可能来自产物清单（art-png）或卡片名（gmv_trend.png），
   * 服务端两条都认（id OR file_name）。 */
  useEffect(() => {
    if (!selected) {
      setPreview(null);
      setError('');
      return;
    }
    const cached = cacheRef.current.get(selected.id);
    if (cached) {
      setPreview(cached);
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    void api
      .getArtifactPreview(selected.id)
      .then((envelope) => {
        if (!alive) return;
        setLoading(false);
        if (!envelope.ok) {
          setPreview(null);
          setError(envelope.error?.message ?? '产物不存在');
          return;
        }
        cacheRef.current.set(selected.id, envelope.data);
        setPreview(envelope.data);
      })
      .catch(() => {
        if (!alive) return;
        setLoading(false);
        setPreview(null);
        setError('预览请求失败');
      });
    return () => {
      alive = false;
    };
  }, [selected?.id]);

  const download = (): void => {
    if (!selected) return;
    void api.downloadArtifact(selected.id).then((envelope) => {
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
      {/* 产物清单 */}
      <div className="filp-list">
        <div className="pt">本会话产物 {OUTPUT_FILES.length} 个</div>
        {OUTPUT_FILES.length === 0 ? (
          <div className="cempty">
            <span className="cempty-ic">
              <FileIcon size={14} strokeWidth={1.4} />
            </span>
            <span>本会话还没有产物。让 Agent 生成图表或文档后，这里会列出并可预览。</span>
          </div>
        ) : null}
        {OUTPUT_FILES.map((file) => (
          <div
            className={`frow${selected?.name === file.name ? ' on' : ''}`}
            key={file.name}
            onClick={() => openArtifact({ id: file.id ?? file.name, name: file.name })}
          >
            <div className="fi" style={{ background: file.bg, color: file.fg }}>
              {file.tag}
            </div>
            <div className="fn">{file.name}</div>
            <span style={{ fontSize: 11, color: 'var(--gray-400)' }}>{file.size}</span>
          </div>
        ))}
      </div>

      {/* 打开的标签页：点击切换，× / 中键关闭 */}
      {tabs.length > 0 ? (
        <div className="filp-tabs" role="tablist" aria-label="已打开的产物">
          {tabs.map((tab) => (
            <div
              className={`filp-tab${selected?.id === tab.id ? ' on' : ''}`}
              key={tab.id}
              role="tab"
              aria-selected={selected?.id === tab.id}
              title={tab.name}
              onClick={() => setArtifactActive(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeArtifact(tab.id);
                }
              }}
            >
              <span className="filp-tab-name">{tab.name}</span>
              <button
                className="filp-tab-x"
                type="button"
                title="关闭"
                aria-label={`关闭 ${tab.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeArtifact(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* 预览区 */}
      <div className="filp-view">
        {!selected ? (
          <div className="filp-empty">
            <span className="cempty-ic">
              <FileIcon size={14} strokeWidth={1.4} />
            </span>
            <span>在上方选一个产物，或在会话里点产物卡「在侧边栏打开」。可同时打开多个，各自占一个标签。</span>
          </div>
        ) : null}
        {selected ? (
          <div className="filp-hd">
            <span className="filp-name" title={selected.name}>{selected.name}</span>
            {mode ? <span className="filp-kind">{MODE_LABEL[mode]}</span> : null}
            <button className="brp-nav" type="button" title="下载原文件" aria-label="下载" onClick={download}>
              <DownloadIcon size={13} strokeWidth={1.4} />
            </button>
          </div>
        ) : null}
        {loading ? <div className="filp-note">加载中…</div> : null}
        {error ? <div className="filp-note err">{error}</div> : null}
        {preview && !loading && mode ? <PreviewBody preview={preview} mode={mode} /> : null}
      </div>
    </div>
  );
}
