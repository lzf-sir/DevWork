/**
 * 会话三问面板 —— 上下文 / 执行 / 产物。
 *
 * 这三块是「这条会话在干什么」的三个追问：看到了什么 / 跑了什么 / 产出了什么。
 * 内容与容器分开：面板只管内容，装它的地方是**侧边工作区的一个 tab**
 * （见 components/WorkbenchPanel.tsx），入口是会话右缘的图标坞
 * （见 components/ChatHudDock.tsx）。
 *
 * 为什么不再用常驻栏位 / 悬浮气泡：
 *   常驻栏位把位置占死，气泡又不能并排看两份；工作区 tab 既能多个并存，
 *   又能随手关掉 —— 这才匹配「一边干活一边追问」的节奏。
 *
 * 数据统一由 LiveDataProvider 按活跃会话装配（useLiveData），
 * 组件里不写死任何演示常量。
 */
import React, { useMemo, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { useLiveData } from '../api/live';
import type { Message } from '../data/mock';
import { ChartIcon, DownloadIcon, FileIcon, FolderIcon, SearchIcon, TerminalIcon, TodoIcon } from './icons';
import { buildContextTurns, summarizeTurns } from '../utils/contextSteps';

/** 任务清单卡（从会话时间线里取的原始结构，不另建模型）。 */
type TodoCard = Extract<Message, { kind: 'todo' }>;

/** 产物行：点击 = 在工作区新开一个预览 tab；下载图标独立，不触发打开。 */
export interface ArtifactPaneProps {
  /** 紧凑模式：行距更紧（工作区里一般用默认，气泡时代的遗留参数保留）。 */
  compact?: boolean;
}

/** 上下文面板：它现在看到了什么？
 *
 *  分两段，回答两个不同的问题：
 *   ① 上半段「轮次 → 步骤」——**这一轮它走了几步、哪步慢、哪步等人**（结构化的过程）；
 *   ② 下半段「挂了什么 / 命中什么 / 构成如何」——**它凭什么这么答**（原料）。
 *  只有 ② 的时候，人只能看到结果；只有 ① 的时候，人又不知道它依据什么。
 */
export function ContextPane({ compact = false }: { compact?: boolean }): React.ReactElement {
  const { navigate, addToast, state } = useStore();
  const { CTX_MOUNTED, CTX_HITS, CTX_BARS } = useLiveData();

  const conversationId = state.activeConversationId;
  const messages = state.threads[conversationId] ?? [];
  const turns = useMemo(
    () => buildContextTurns(messages, state.streams[conversationId] ?? null),
    [messages, state.streams, conversationId],
  );
  const summary = useMemo(() => summarizeTurns(turns), [turns]);
  /* 默认展开最后一轮：人打开面板，八成是在问「它刚才那步干了什么」。 */
  const [openTurn, setOpenTurn] = useState<number | null>(null);
  const activeTurn = openTurn ?? turns[turns.length - 1]?.index ?? null;

  return (
    <>
      <div className="ctx-sum">
        <div>
          <b>{summary.turns}</b>
          <span>轮</span>
        </div>
        <div>
          <b>{summary.steps}</b>
          <span>步</span>
        </div>
        <div>
          <b>{summary.toolMs >= 1000 ? `${(summary.toolMs / 1000).toFixed(1)}s` : `${summary.toolMs}ms`}</b>
          <span>工具耗时</span>
        </div>
        <div>
          {/* token 只显示真值；没有就是「—」，不拿字符数估一个好看的数字。 */}
          <b>{summary.hasTokenTruth ? summary.tokens.toLocaleString() : '—'}</b>
          <span>tokens</span>
        </div>
      </div>

      <div className="pt">每一步</div>
      {turns.length === 0 ? (
        <div className="cempty">
          <span className="cempty-ic">
            <SearchIcon size={14} strokeWidth={1.4} />
          </span>
          <span>这条会话还没有步骤。发出第一条消息后，模型每走一步都会在这里留下痕迹。</span>
        </div>
      ) : null}

      {turns.map((turn) => {
        const open = activeTurn === turn.index;
        return (
          <div className={`ctx-turn${open ? ' on' : ''}`} key={`${turn.index}-${turn.ask.slice(0, 12)}`}>
            <button
              className="ctx-turn-hd"
              type="button"
              onClick={() => setOpenTurn(open ? -1 : turn.index)}
              aria-expanded={open}
            >
              <span className={`ctx-turn-no${turn.running ? ' run' : ''}`}>{turn.index}</span>
              <span className="ctx-turn-ask">{turn.ask || '（空提问）'}</span>
              <span className="ctx-turn-meta">
                {turn.steps.length} 步
                {turn.toolMs > 0 ? ` · ${turn.toolMs >= 1000 ? `${(turn.toolMs / 1000).toFixed(1)}s` : `${turn.toolMs}ms`}` : ''}
              </span>
            </button>
            {turn.chips.length > 0 ? (
              <div className="ctx-turn-chips">
                {turn.chips.map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </div>
            ) : null}
            {open ? (
              <div className="ctx-steps">
                {turn.steps.length === 0 ? (
                  <div className="ctx-step empty">这一轮还没有落到具体步骤</div>
                ) : (
                  turn.steps.map((step) => (
                    <div className="ctx-step" key={step.id} data-status={step.status}>
                      <span className="ctx-step-dot" aria-hidden="true" />
                      <span className="ctx-step-label">{step.label}</span>
                      <span className="ctx-step-meta">{step.meta.filter(Boolean).join(' · ')}</span>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="pt" style={{ marginTop: compact ? 10 : 14 }}>
        已挂载 {CTX_MOUNTED.length} 个资产
      </div>
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

/** 任务列表：这条会话的待办清单。
 *
 *  数据就是会话时间线里的 todo 卡（同一张卡原位更新，id 不变），这里只做
 *  「汇总 + 全量清单」的视图，**不另存一份状态** —— 否则会话里推进了、这里还是旧的。
 *
 *  为什么要有这个视图：清单卡在会话里是夹在对话中间的，长任务往下滚两屏就找不到了；
 *  钉在工作区里才能随时确认「还剩几步、哪步卡住了」。
 */
export function TodoListPane(): React.ReactElement {
  const { state } = useStore();
  const conversationId = state.activeConversationId;
  const cards = useMemo(() => {
    const messages = state.threads[conversationId] ?? [];
    return messages.filter((message): message is TodoCard => message.kind === 'todo');
  }, [state.threads, conversationId]);

  /* 汇总按「项」算，不按「卡」算：用户关心的是还剩几件事，不是还剩几张卡。 */
  const totals = cards.reduce(
    (acc, card) => ({
      total: acc.total + card.progress.total,
      done: acc.done + card.progress.done,
      doing: acc.doing + card.progress.doing,
      blocked: acc.blocked + card.progress.blocked,
    }),
    { total: 0, done: 0, doing: 0, blocked: 0 },
  );
  const percent = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;

  return (
    <>
      <div className="ctx-sum">
        <div>
          <b>{cards.length}</b>
          <span>清单</span>
        </div>
        <div>
          <b>{totals.done}/{totals.total}</b>
          <span>项已完成</span>
        </div>
        <div>
          <b>{totals.doing}</b>
          <span>进行中</span>
        </div>
        <div>
          <b style={totals.blocked > 0 ? { color: 'var(--warning)' } : undefined}>{totals.blocked}</b>
          <span>受阻</span>
        </div>
      </div>

      <div className="pt">完成度 {percent}%</div>
      <div className="bars">
        <div className="r">
          <span className="nm">任务进度</span>
          <span className="b">
            <i style={{ width: `${percent}%` }} />
          </span>
          <span className="v">{percent}%</span>
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="cempty">
          <span className="cempty-ic">
            <TodoIcon size={14} strokeWidth={1.4} />
          </span>
          <span>
            这条会话还没有任务清单。当它开始做一件需要多步完成的事（查数 → 取数 → 复核），
            会在这里列出每一步的状态。
          </span>
        </div>
      ) : null}

      {cards.map((card, cardIndex) => {
        const allDone = card.progress.total > 0 && card.progress.done === card.progress.total;
        return (
          <div className="todo" key={card.id} data-todo-progress={card.progress.percent}>
            <div className="th">
              <span className="tt">
                {allDone ? '任务已完成' : `任务清单 · 第 ${cardIndex + 1} 张`}
              </span>
              <span className="tp">
                {card.progress.done}/{card.progress.total}
              </span>
              {card.progress.blocked > 0 ? <span className="tb warn">{card.progress.blocked} 项受阻</span> : null}
              {card.degraded ? <span className="tb">演示轨迹</span> : null}
              <div className="tbar" title={`完成度 ${card.progress.percent}%`}>
                <i style={{ width: `${card.progress.percent}%` }} />
              </div>
            </div>
            <ul>
              {card.items.map((item, index) => (
                <li key={`${card.id}-${item.id}`} className={`ti ${item.status}`}>
                  <span className="tic" aria-hidden>
                    {item.status === 'done' ? '✓' : item.status === 'doing' ? '▸' : item.status === 'blocked' ? '!' : index + 1}
                  </span>
                  <span className="tit">{item.title}</span>
                  {item.note ? <span className="tin">{item.note}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}

/** 执行面板：它跑了什么？（工具调用清单 / 耗时 / 待审批项）
 *
 *  当前没有入口挂它（工作区只保留 上下文 / 任务列表 / 浏览器 / 产物详情），
 *  实现先留着：工具级明细是「任务列表」的下钻视图，后续接进任务列表的展开项。 */
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

/** 产物清单：它产出了什么？（浮层里用：选一个 → 在工作区开详情 tab）
 *
 *  这是**选择器**，不是内容区：清单不进工作区，工作区只放单个产物的详情。
 *  所以这里不做"展开预览"，点一行就直接开 tab 并收起浮层。 */
export function ArtifactPane({ compact = false }: ArtifactPaneProps): React.ReactElement {
  const { addToast, openArtifact } = useStore();
  const { OUTPUT_FILES } = useLiveData();

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
        <div
          className="frow"
          key={file.name}
          title={`在工作区查看 ${file.name}`}
          onClick={() => {
            /* 点行 = 开详情 tab（openArtifact 会顺手收起浮层）。 */
            openArtifact({ id: file.id ?? file.name, name: file.name });
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
      ))}
      {compact ? null : (
        <>
          <div className="pt" style={{ marginTop: 14 }}>
            说明
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--gray-400)', lineHeight: 1.7 }}>
            点一行就在工作区开一个详情标签页，产物随会话保存。
          </div>
        </>
      )}
    </>
  );
}
