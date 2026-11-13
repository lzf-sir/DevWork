/**
 * 会话三问面板 —— 上下文 / 执行 / 产物。
 *
 * 这三块内容以前是右栏里的三个常驻 Tab。现在它们改成**会话区右侧的悬浮气泡**
 * （见 components/ChatHudDock.tsx），所以内容必须从布局里抽出来，
 * 让「气泡」和「任何未来要复用它的地方」都能挂同一份实现。
 *
 * 为什么是悬浮气泡而不是右栏常驻：
 * 右栏那个位置应该留给**工具**（内置浏览器、文件、终端）——
 * 那是「我现在能操作什么」；而上下文 / 执行 / 产物回答的是
 * 「刚才那轮到底怎么回事」——是**追问**，问完就该收起来。
 *
 * 数据统一由 LiveDataProvider 按活跃会话装配（useLiveData），
 * 组件里不写死任何演示常量。
 */
import React, { useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { useLiveData } from '../api/live';
import { ChartIcon, DownloadIcon, FileIcon, FolderIcon, SearchIcon, TerminalIcon } from './icons';

/** 产物行：气泡里点击 = 在右栏「文件」Tab 打开；下载图标独立，不触发打开。 */
export interface ArtifactPaneProps {
  /** 紧凑模式（气泡内）：行距更紧，少留白。 */
  compact?: boolean;
}

/** 上下文面板：它现在看到了什么？（已挂载资产 / 检索命中 / 上下文构成） */
export function ContextPane({ compact = false }: { compact?: boolean }): React.ReactElement {
  const { navigate, addToast } = useStore();
  const { CTX_MOUNTED, CTX_HITS, CTX_BARS } = useLiveData();

  return (
    <>
      <div className="pt">已挂载 {CTX_MOUNTED.length} 个资产</div>
      {CTX_MOUNTED.length === 0 ? (
        <div className="cempty">
          <span className="cempty-ic">
            <FolderIcon size={14} strokeWidth={1.4} />
          </span>
          <span>
            还没有挂载任何资产。在输入框用 <code>@</code> 选择一个资产，或从左侧资产中心打开后再提问。
          </span>
        </div>
      ) : null}
      {CTX_MOUNTED.map((asset) => (
        <div
          className="achip"
          key={asset.name}
          onClick={() => {
            if (asset.go) navigate(`detail-${asset.go}` as 'detail-code' | 'detail-db' | 'detail-server' | 'detail-kb');
            else addToast(`${asset.name}：检索型资产`);
          }}
        >
          <div className="an">{asset.name}</div>
          <div className="am">{asset.meta}</div>
        </div>
      ))}

      <div className="pt" style={{ marginTop: compact ? 10 : 14 }}>
        检索命中
      </div>
      {CTX_HITS.length === 0 ? (
        <div className="cempty">
          <span className="cempty-ic">
            <SearchIcon size={14} strokeWidth={1.4} />
          </span>
          <span>本次没有检索命中。换一个更具体的问法，或确认资产索引已建好。</span>
        </div>
      ) : null}
      {CTX_HITS.map((hit) => (
        <div className="hit" key={hit.name}>
          <div className="hn">{hit.name}</div>
          <div className="hm">
            {hit.meta.map((meta) => (
              <span key={meta}>{meta}</span>
            ))}
          </div>
        </div>
      ))}

      <div className="pt" style={{ marginTop: compact ? 10 : 14 }}>
        上下文构成
      </div>
      <div className="bars">
        {CTX_BARS.length === 0 ? (
          <div className="cempty">
            <span className="cempty-ic">
              <ChartIcon size={14} strokeWidth={1.4} />
            </span>
            <span>还没有上下文用量（发送第一条消息后统计）。</span>
          </div>
        ) : null}
        {CTX_BARS.map((bar) => (
          <div className="r" key={bar.name}>
            <span className="nm">{bar.name}</span>
            <span className="b">
              <i style={{ width: `${bar.width}%` }} />
            </span>
            <span className="v">{bar.value}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** 执行面板：它跑了什么？（工具调用清单 / 耗时 / 待审批项） */
export function ExecutionPane({ compact = false }: { compact?: boolean }): React.ReactElement {
  const { focusApproval, addToast } = useStore();
  const { RUN_TOOLS, RUN_BARS } = useLiveData();

  return (
    <>
      <div className="pt">本次执行 {RUN_TOOLS.length} 步</div>
      {RUN_TOOLS.length === 0 ? (
        <div className="cempty">
          <span className="cempty-ic">
            <TerminalIcon size={14} strokeWidth={1.4} />
          </span>
          <span>本次还没有执行任何工具。提出需要查询或执行的问题后，这里会逐步显示。</span>
        </div>
      ) : null}
      {RUN_TOOLS.map((tool, index) => (
        <div
          className="hit"
          key={`${tool.name}-${index}`}
          style={tool.pending ? { borderColor: 'var(--warning-line)', background: 'var(--warning-bg)', cursor: 'pointer' } : undefined}
          onClick={() => {
            if (!tool.pending) return;
            focusApproval();
            addToast('已定位到会话中的待审批卡');
          }}
        >
          <div className="hn">{tool.name}</div>
          <div className="hm">
            {tool.meta.map((meta) => (
              <span key={meta} style={tool.pending && meta.startsWith('待审批') ? { color: 'var(--warning)' } : undefined}>
                {meta}
              </span>
            ))}
          </div>
        </div>
      ))}
      <div className="pt" style={{ marginTop: compact ? 10 : 14 }}>
        工具耗时
      </div>
      <div className="bars">
        {RUN_BARS.map((bar) => (
          <div className="r" key={bar.name}>
            <span className="nm">{bar.name}</span>
            <span className="b">
              <i style={{ width: `${bar.width}%` }} />
            </span>
            <span className="v">{bar.value}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** 产物面板：它产出了什么？（文件列表 + 下载 + 在右栏打开） */
export function ArtifactPane({ compact = false }: ArtifactPaneProps): React.ReactElement {
  const { addToast, openArtifact } = useStore();
  const { OUTPUT_FILES } = useLiveData();
  const [expanded, setExpanded] = useState<string | null>(null);

  /** 产物下载：走服务端真接口拿下载地址，再用浏览器下载。 */
  const download = (id: string, name: string): void => {
    void api.downloadArtifact(id || name).then((envelope) => {
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

  return (
    <>
      <div className="pt">本次产物 {OUTPUT_FILES.length} 个</div>
      {OUTPUT_FILES.length === 0 ? (
        <div className="cempty">
          <span className="cempty-ic">
            <FileIcon size={14} strokeWidth={1.4} />
          </span>
          <span>本会话还没有产物。让 Agent 生成图表或文档后，会在这里列出并支持下载。</span>
        </div>
      ) : null}
      {OUTPUT_FILES.map((file) => (
        <React.Fragment key={file.name}>
          <div
            className="frow"
            onClick={() => {
              /* 点行 = 在右栏「文件」Tab 里打开并预览（气泡只是入口，预览有专门的版面）。 */
              openArtifact({ id: file.id ?? file.name, name: file.name });
              setExpanded(file.name);
            }}
          >
            <div className="fi" style={{ background: file.bg, color: file.fg }}>
              {file.tag}
            </div>
            <div className="fn">{file.name}</div>
            <span style={{ fontSize: 11, color: 'var(--gray-400)' }}>{file.size}</span>
            <span
              className="fdl"
              title={`下载 ${file.name}`}
              onClick={(event) => {
                event.stopPropagation();
                download(file.id ?? file.name, file.name);
              }}
            >
              <DownloadIcon size={13} strokeWidth={1.4} />
            </span>
          </div>
          {expanded === file.name ? (
            <div className="fpreview">
              <div className="fpimg">
                {file.name} · 已推送到右栏「文件」Tab 预览
              </div>
              <div>
                {file.name} · {file.size} · 生成于本会话 · 点击右侧下载图标保存原文件
              </div>
            </div>
          ) : null}
        </React.Fragment>
      ))}
      <div className="pt" style={{ marginTop: compact ? 10 : 14 }}>
        说明
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--gray-400)', lineHeight: 1.7 }}>
        点一行在右栏预览，产物随会话保存。
      </div>
    </>
  );
}
