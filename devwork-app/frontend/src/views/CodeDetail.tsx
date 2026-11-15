import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { useLiveData } from '../api/live';
import { useAssetTarget } from '../hooks/useAssetTarget';
import { Banner, DetailHeader, DetailTabs, GearSvg, Pill } from '../components/ui';
import { CaretIcon, ChatIcon, CloseIcon, CodeIcon, DotsIcon, FolderIcon, FileTypeIcon } from '../components/icons';
import AssetConfigDrawer from '../components/AssetConfigDrawer';
import { highlight, markAll } from '../utils/highlight';
import { todoGaps, todoOwner, todoRailSummary } from '../utils/todo-copy';
import { serializeEditor } from '../utils/editor-text';
import RepoSearchPanel from '../components/RepoSearchPanel';
import { STALE_PANEL_NOTE, STALE_RAIL_LABEL, shouldInvalidateScans } from '../utils/stale-copy';
import type { FileRefsResult, FileTodosResult, RefFileGroup, RepoStatus, TodoHitShape } from '../api/types';

const TABS = [
  { id: 'main', label: '编辑器' },
];

/** 树节点（mock 与 live 装配形状对齐：file 为空串/null 表示目录）。 */
type TreeNode = { label: string; depth: number; caret: string; path: string | null };

/** 引用面板的运行态：`symbol` 始终有值，数据可能还在路上或已失败。 */
type RefsState = {
  symbol: string;
  loading: boolean;
  data: FileRefsResult | null;
  error?: string;
  /* 保存过文件之后，这份数据就不再描述磁盘上的现状了（见 stale-copy.ts）。 */
  stale?: boolean;
};

/** 收敛四类各自的标签与语气。措辞按「能证明什么」写，不按「看起来像什么」写。 */
const REF_KIND: Record<RefFileGroup['kind'], { label: string; tone: string }> = {
  local: { label: '同文件', tone: '' },
  linked: { label: '归入', tone: 'ok' },
  split: { label: '分不开', tone: 'warn' },
  unknown: { label: '无法归属', tone: '' },
};

/** 单个文件分组的归因说明——每句话都对应一条可核对的原文证据。 */
function refReason(group: RefFileGroup): string {
  if (group.kind === 'local') return `定义 ${group.defs} 处，引用与定义同文件`;
  if (group.kind === 'unknown') {
    /* 「同目录」不是归属：Java 同包不需要 import，这条只说明下一个该看哪儿。 */
    return group.sameDir
      ? `没有 import 证据（同目录有 ${group.sameDir}：同包无需 import，从 import 判不出来）`
      : '没有 import 证据，无法归属';
  }
  if (group.kind === 'split') {
    return `导入了 ${group.links.length} 个定义文件，无法拆分 → ${group.links.map((l) => l.target).join('、')}`;
  }
  const link = group.links[0];
  return `导入 ${link.specifier} → ${link.target}`
    + (link.via === 'name' ? '（import 名单里就有这个符号）' : '（只导入了模块，名单里没有这个符号）');
}

/**
 * 符号引用面板：把 `/files/refs` 的证据摊在编辑器底部，而不是弹窗——
 * 因为看完一行就要点过去，弹窗会挡着跳转目标。
 *
 * 三条硬规矩（和工具侧 `code_find(mode=refs)` 同一口径）：
 *   ① 绝不说「引用共 N 处」这种结论式措辞，只报词法计数与四类归属计数；
 *   ② 「归入」只表示该文件导入了那个定义所在模块，不表示每处调用都解析到它；
 *   ③ 扫描的每个缺口（注释排除数 / 命中截断 / 超大文件跳过 / import 一条没解析出来）
 *      都要单独说，否则「全是无法归属」会被误读成符号本身没有引用。
 */
function RefsPanel({
  state,
  onClose,
  onJump,
  onRescan,
}: {
  state: RefsState;
  onClose: () => void;
  onJump: (path: string, line: number) => void;
  onRescan: () => void;
}): React.ReactElement {
  const { symbol, loading, data, error, stale } = state;
  const defs = data ? data.hits.filter((hit) => hit.kind === 'definition').length : 0;
  const refs = data ? data.hits.length - defs : 0;
  const conv = data?.convergence;
  const summary = data?.summary;
  /* 定义散在多个文件时，import 才有收敛意义：单文件里两个类的同名方法，import 帮不上忙。 */
  const converged = (conv?.definitionFiles.length ?? 0) >= 2;
  const empty = data !== null && data.hits.length === 0 && data.excludedInNonCode === 0;
  /* 接收者表全是「(裸名)」（类型名、import 之类）时它什么都说明不了，整块不印。 */
  const receiverRows = summary && !(summary.byReceiver.length === 1 && summary.byReceiver[0].label === '(裸名)')
    ? summary.byReceiver
    : [];
  const ambiguous = converged
    || (summary?.definitionScopes.length ?? 0) > 1
    || receiverRows.length > 1
    || (summary?.byScope.length ?? 0) > 1;
  const fmtGroups = (rows: Array<{ label: string; count: number }>): React.ReactNode =>
    rows.map((row, index) => (
      <span key={`${row.label}:${index}`}>
        {index > 0 ? '、' : ''}
        {row.label} <b>{row.count}</b>
      </span>
    ));
  /* 分组跳到该文件的第一处命中，而不是第 1 行：跳到文件头等于让用户自己再找一遍。 */
  const firstLineOf = (path: string): number => data?.hits.find((hit) => hit.path === path)?.line ?? 1;

  return (
    <div className="rp">
      <div className="rp-head">
        <span>符号引用</span>
        <span className="nm">{symbol}</span>
        {data && !empty ? (
          <span style={{ color: 'var(--gray-400)', fontSize: 11 }}>
            {/* 过期标注放在计数**之前**：先看到"保存前"，后面那串数字才不会被当成现状。 */}
            {`${stale ? '保存前 · ' : ''}定义 ${defs} · 引用 ${refs} · ${data.filesMatched} 个文件`}
          </span>
        ) : null}
        <span className="sp">
          {stale ? (
            <button className="rp-re" type="button" onClick={onRescan} title="按当前磁盘内容重新扫描">
              重新扫描
            </button>
          ) : null}
          <button className="x" type="button" onClick={onClose} title="关闭引用面板" aria-label="关闭引用面板">
            <CloseIcon size={12} strokeWidth={1.5} />
          </button>
        </span>
      </div>
      <div className="rp-body">
        {stale ? <div className="rp-warn">{STALE_PANEL_NOTE}</div> : null}
        {loading ? <div className="rp-note">正在扫描仓库…（整仓词法扫描，大仓库需要几秒）</div> : null}
        {error ? <div className="rp-err">扫描失败：{error}</div> : null}
        {empty && data ? (
          <>
            <div className="rp-lead">
              代码里没有任何出现（扫描 {data.filesScanned} 个文件
              {data.skippedLarge > 0 ? `，${data.skippedLarge} 个超大文件跳过` : ''}）。
            </div>
            {data.skippedLarge > 0 ? (
              <div className="rp-warn">有文件因体积被跳过：这里的「没有」只覆盖读过的那些文件。</div>
            ) : null}
          </>
        ) : null}
        {data && !empty ? (
          <>
            <div className="rp-lead">
              代码里出现 {data.hits.length} 处（定义 {defs} / 引用 {refs}）· 涉及 {data.filesMatched} 个文件
            </div>
            <div className="rp-note">
              {data.excludedInNonCode > 0
                ? `另有 ${data.excludedInNonCode} 处出现在注释或字符串里，已排除（不是代码引用）`
                : '注释与字符串里没有同名文本（本次排除 0 处）'}
              {` · 扫描 ${data.filesScanned} 个文件`}
              {data.skippedLarge > 0 ? ` · ${data.skippedLarge} 个超大文件跳过` : ''}
              {data.truncated ? ' · 命中已达上限，下列计数只覆盖已列出的部分' : ''}
            </div>

            {conv && conv.definitionFiles.length > 0 ? (
              <>
                <div className="rp-sec">
                  {converged
                    ? `定义所在文件（同名候选 ${conv.definitionFiles.length} 个）`
                    : '定义所在文件'}
                </div>
                {conv.definitionFiles.map((file) => (
                  <div className="rp-row" key={`d:${file.path}`} onClick={() => onJump(file.path, file.line)}>
                    <span className="p">{file.path}</span>
                    <span className="why">{file.scope ? `在 ${file.scope} 里` : ''}</span>
                    <span className="n">:{file.line}</span>
                  </div>
                ))}
              </>
            ) : null}
            {conv && conv.files.length > 0 ? (
              <>
                {/* 引用文件表**常显**：用户问的就是「用到它的文件在哪」，只给个总数等于不给。
                    只有收敛标注（归入/分不开/无法归属）依赖多定义前提，单定义时不印——
                    只有一个候选时还说「归入」，是把必然说成了推断。 */}
                <div className="rp-sec">
                  {converged ? '引用文件（按 import 关系收敛 · 不做类型推断）' : '引用文件'}
                </div>
                {conv.files.map((group) => (
                  <div className="rp-row" key={`r:${group.path}`} onClick={() => onJump(group.path, firstLineOf(group.path))}>
                    <span className="p">{group.path}</span>
                    <span className="why">{refReason(group)}</span>
                    <span className="n">{group.refs} 处</span>
                    {converged ? (
                      <span className={`rp-tag ${REF_KIND[group.kind].tone}`}>{REF_KIND[group.kind].label}</span>
                    ) : null}
                  </div>
                ))}
                {converged ? grouped(conv).map((line) => (
                  <div className="rp-note" key={line}>{line}</div>
                )) : null}
                {conv.hiddenFiles > 0 ? (
                  <div className="rp-note">另有 {conv.hiddenFiles} 个引用文件未列出（文件数上限）。</div>
                ) : null}
                {converged && conv.importsParsed === 0 ? (
                  <div className="rp-warn">
                    这些文件里一条 import 都没解析出来：可能是不支持的方言（只认 ts/java/python/go/rust），
                    也可能依赖是全局注入的——此时的「无法归属」不是符号本身的问题。
                  </div>
                ) : null}
                {converged ? (
                  <div className="rp-note">
                    「归入」只表示该文件导入了那个定义所在模块，不表示每一处调用都解析到它（变量的实际类型仍需人工确认）。
                  </div>
                ) : null}
              </>
            ) : null}
          </>
        ) : null}

        {data && !empty && ambiguous && summary ? (
          <>
            <div className="rp-sec">同名候选分组（按书写形式分 · 不做类型推断）</div>
            <div className="rp-groups">
              {/* 收敛表已经逐个列了定义文件与所属符号，这里不再重复一张容器表。 */}
              {!converged && summary.definitionScopes.length > 0 ? (
                <span>定义容器：{fmtGroups(summary.definitionScopes)}</span>
              ) : null}
              {!converged && summary.definitionScopes.length === 0 ? (
                <span>扫描范围内没有 {symbol} 的定义（可能来自依赖）</span>
              ) : null}
              {receiverRows.length > 0 ? <span>引用按接收者：{fmtGroups(receiverRows)}</span> : null}
              {summary.byScope.length > 0 ? <span>引用按所在符号：{fmtGroups(summary.byScope)}</span> : null}
            </div>
            {summary.hiddenGroups > 0 ? (
              <div className="rp-note">另有 {summary.hiddenGroups} 个分组未列出（可在会话里用 code_find 缩小范围再看）。</div>
            ) : null}
            {data.truncated ? (
              <div className="rp-note">分组基于已列出的 {summary.covered} 处，命中已被上限截断。</div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 四类归属计数汇总：合计正好是「能归属 / 分不开 / 判不了 / 本来就在一起」。 */
function grouped(conv: NonNullable<FileRefsResult['convergence']>): string[] {
  const total = conv.linkedRefs + conv.unknownRefs + conv.splitRefs + conv.localRefs;
  return [
    `汇总：引用 ${total} 处 —— 按 import 归入唯一定义 ${conv.linkedRefs}、`
    + `导入多个定义分不开 ${conv.splitRefs}、无法归属 ${conv.unknownRefs}、与定义同文件 ${conv.localRefs}`,
  ];
}

/* ===== 遗留标记（TODO / FIXME / HACK） ===== */

type TodosState = { loading: boolean; data: FileTodosResult | null; error?: string; stale?: boolean };

/* 只有 FIXME 与 HACK 有特殊语气；TODO 是常态，用默认灰。 */
const MARKER_TONE: Record<string, string> = { FIXME: 'bad', HACK: 'warn' };

/**
 * 遗留标记面板：与引用面板共用底部位置（`onJump` 同一个），因为两者都是
 * 「看一行 → 点过去改」，弹窗会挡着跳转目标。
 *
 * 措辞纪律（与工具 `code_todos` 同口径）：
 *   ① 有缺口时抬头写「已列 N 条」而不是「共 N 条」——第 N 条之后没读过，说"共"就是假的；
 *   ② 归属按 `codeFile` 分叉，非代码文件不印归属；
 *   ③ 标记后没有说明也照样列出（"有标记但没写内容"本身就是结论）。
 */
function TodosPanel({
  state,
  onClose,
  onJump,
  onRescan,
}: {
  state: TodosState;
  onClose: () => void;
  onJump: (path: string, line: number) => void;
  onRescan: () => void;
}): React.ReactElement {
  const { loading, data, error, stale } = state;
  const gaps = data ? todoGaps(data) : [];
  const incomplete = gaps.length > 0;

  /* 按文件分组：同一文件的多条标记连在一起看，才知道这个文件烂到什么程度。 */
  const byFile = new Map<string, TodoHitShape[]>();
  for (const hit of data?.hits ?? []) {
    const bucket = byFile.get(hit.path);
    if (bucket) bucket.push(hit);
    else byFile.set(hit.path, [hit]);
  }

  /* 标记分布：FIXME/HACK 与普通 TODO 的紧迫度不同，先给一张分布比让人自己数。 */
  const markerCount = new Map<string, number>();
  for (const hit of data?.hits ?? []) markerCount.set(hit.marker, (markerCount.get(hit.marker) ?? 0) + 1);

  /* 过期时不是把数字撤掉，而是在数字**之前**写清「保存前」——抬头是这一屏最先被读的地方，
     标注放在数字后面，等于让人先读走一个已经错位的计数。 */
  const count = data ? `${data.hits.length} 条 · ${byFile.size} 个文件` : '';
  const head = !data
    ? ''
    : `${stale ? '保存前 · ' : ''}${incomplete ? '已列 ' : ''}${count}`
      + `${incomplete ? '（扫描未覆盖全部）' : ''}`;

  return (
    <div className="rp">
      <div className="rp-head">
        <span>遗留标记</span>
        {head ? <span style={{ color: 'var(--gray-400)', fontSize: 11 }}>{head}</span> : null}
        <span className="sp">
          {stale ? (
            <button className="rp-re" type="button" onClick={onRescan} title="按当前磁盘内容重新遍历">
              重新扫描
            </button>
          ) : null}
          <button className="x" type="button" onClick={onClose} title="关闭遗留标记面板" aria-label="关闭遗留标记面板">
            <CloseIcon size={12} strokeWidth={1.5} />
          </button>
        </span>
      </div>
      <div className="rp-body">
        {stale ? <div className="rp-warn">{STALE_PANEL_NOTE}</div> : null}
        {loading ? <div className="rp-note">正在遍历仓库…（只读文本文件，单文件上限 200KB）</div> : null}
        {error ? <div className="rp-err">扫描失败：{error}</div> : null}

        {data && data.hits.length === 0 ? (
          <div className="rp-lead">
            {incomplete
              ? `这次没有命中，但扫描没有覆盖全部文件（读了 ${data.filesRead} 个）。`
              : `读过 ${data.filesRead} 个文件，没有 TODO / FIXME / HACK。`}
          </div>
        ) : null}

        {data && data.hits.length > 0 ? (
          <>
            <div className="rp-lead">
              {incomplete ? '已列' : '扫到'} {data.hits.length} 条遗留标记 · 涉及 {byFile.size} 个文件 ·
              读过 {data.filesRead} 个文件
            </div>
            {markerCount.size > 0 ? (
              <div className="rp-groups">
                {Array.from(markerCount.entries()).map(([marker, count]) => (
                  <span key={marker}>
                    {marker} <b>{count}</b>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {gaps.map((gap) => (
          <div className="rp-warn" key={gap}>{gap}</div>
        ))}

        {Array.from(byFile.entries()).map(([filePath, hits]) => (
          <React.Fragment key={filePath}>
            <div className="rp-sec">{filePath}（{hits.length} 条）</div>
            {hits.map((hit) => (
              <div
                className="rp-row"
                key={`${hit.path}:${hit.line}`}
                onClick={() => onJump(hit.path, hit.line)}
                title={hit.text ? `${hit.marker}: ${hit.text}` : `${hit.marker}（没有说明）`}
              >
                <span className="n">:{hit.line}</span>
                <span className={`rp-tag ${MARKER_TONE[hit.marker] ?? ''}`}>{hit.marker}</span>
                {/* 没有说明也要成行：这本身就是一条结论，过滤掉等于替用户做了取舍。 */}
                <span className="why">{hit.text || '（标记后没有说明）'}</span>
                {todoOwner(hit) ? <span className="rp-who">{todoOwner(hit)}</span> : null}
              </div>
            ))}
          </React.Fragment>
        ))}

        {data && data.hits.length > 0 ? (
          <div className="rp-note">
            标记来自词法匹配（含注释与字符串），不是语义分析：字符串里写着 "TODO" 也会被列出。
            归属同样来自词法层，跨语言对"最内层符号"的判定不完全一致。
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 代码库详情：默认落在编辑器主功能区；能力授权 / 仓库信息收进右侧配置抽屉。 */
export default function CodeDetail(): React.ReactElement {
  const {
    state, setDetailTab, addToast, setModal, consumeSource, setConfigOpen,
    openAssetChat, openAssetForm, openSource,
  } = useStore();
  /* B2：指标 / KV / 活动 / 能力 / 文件树 / diff / patch 全部由 REST 装配层提供。 */
  const {
    CAPS_CODE,
    CODE_ACTIVITY_KV,
    CODE_DIFF,
    CODE_FILES,
    CODE_METRICS,
    CODE_PATCH,
    CODE_REPO_KV,
    CODE_TREE,
  } = useLiveData();
  const [activePath, setActivePath] = useState<string>('src/main/java/order/InventoryClient.java');
  const [modified, setModified] = useState<boolean>(true);
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 42, col: 31 });
  /** B18：编辑态标记 —— 一旦输入就不再重放高亮（DOM 为准），保光标稳定。 */
  const [edited, setEdited] = useState<boolean>(false);
  /** B2：当前文件内容优先 /api/.../files/content，离线时回落 REST 装配的文件表。 */
  const [liveContent, setLiveContent] = useState<Record<string, string>>({});
  /** B18：大纲 / 引用 / per-file git 来自服务端真实扫描。 */
  const [outline, setOutline] = useState<{ symbols: { sg: string; label: string; line?: number }[]; references: string[]; git: string[] } | null>(null);
  /** B18：仓库分支（git 真查），离线回落静态值。 */
  const [branch, setBranch] = useState<string>('feature/order-retry');
  /** B18：目录树收起集合（按节点下标）。 */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  /** B19：查找态（⌘F）—— null 关闭；编辑态不支持。 */
  const [find, setFind] = useState<{ open: boolean; query: string; index: number } | null>(null);
  /** 符号级引用面板：null 关闭。它是**符号**维度的（整仓扫），不随打开的文件变。 */
  const [refs, setRefs] = useState<RefsState | null>(null);
  /* 遗留标记：底部位置只有一个，"点一次付一次"——不自动触发整仓遍历。 */
  const [todos, setTodos] = useState<TodosState | null>(null);
  /** 全库检索（⌘⇧F）：查的是落盘内容的全文索引，不是当前文件的已渲染文本。 */
  const [repoSearch, setRepoSearch] = useState<boolean>(false);
  const findInputRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  /* 当前选中的代码库资产：详情页据此绑定**自己的**本地克隆目录，不再写死 a-order-service。
   * 优先用用户刚点过的那个（它一定在本工作区），否则取本工作区第一个代码库资产。 */
  const codeAsset = useAssetTarget('code');
  const assetId = codeAsset?.id ?? '';
  /* 真实文件树（按资产拉取）；离线 / mock 模式回落 CODE_TREE。 */
  const [tree, setTree] = useState<TreeNode[]>([]);
  /* 本地仓库状态：本地路径 / 分支 / 提交 / 是否有未提交改动。 */
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  const [assetName, setAssetName] = useState<string>('');
  /* 克隆面板：URL / 分支 / 深度 —— 「代码库 = 克隆到本地」的入口。 */
  const [cloneOpen, setCloneOpen] = useState<boolean>(false);
  const [cloneUrl, setCloneUrl] = useState<string>('');
  const [cloneBranch, setCloneBranch] = useState<string>('');
  const [cloneDepth, setCloneDepth] = useState<string>('1');
  const [cloneBusy, setCloneBusy] = useState<boolean>(false);

  /* B18：解析当前路径 → 文件元数据；不在 CODE_FILES 的真实仓库文件合成一个空壳条目。 */
  const file = useMemo(() => {
    const base = CODE_FILES.find((item) => item.path === activePath)
      ?? CODE_FILES.find((item) => item.name === activePath.split('/').pop())
      ?? ({
        name: activePath.split('/').pop() ?? activePath,
        path: activePath,
        html: '<div>&nbsp;</div>',
        gutterStart: 1,
        lang: activePath.split('.').pop() ?? '',
        symbols: [],
        modified: false,
      });
    const plain = liveContent[activePath];
    if (plain === undefined) return base;
    /* B19：查找态优先 —— 全量 <mark> 标注（放弃语法高亮换准确定位）。 */
    if (find?.open && find.query) {
      return { ...base, html: markAll(plain, find.query, find.index).html };
    }
    /* B18：查看态应用语法高亮（每行一个 div，与 gutter 对齐）。 */
    return { ...base, html: highlight(plain, activePath) };
    /* 编辑态**不能**在这里换 html —— 早先的写法是 `edited ? base : 高亮`，
     * 后果在真输入下才现形：敲下第一个字符，`__html` 从高亮结果变成 `base.html`
     * （真实仓库文件在 live 侧是纯 `<div>` 包裹，未加载时甚至是占位的 `<div>&nbsp;</div>`），
     * React 发现字符串变了就重设 innerHTML，**连光标所在的节点一起换掉**——
     * 用户第二下按键落不到原来那一行，字符静默丢失；占位那种情形更是整份内容被清空。
     * 反过来，只要 plain / find 没变，这里的 html 字符串与上一次完全相同，
     * React 就不会碰 DOM —— 用户敲的字与光标原地保留，这正是编辑态要的。 */
  }, [activePath, CODE_FILES, liveContent, find]);

  /** 打开文件 / 切换文件时拉取真实仓库内容 + 大纲（路径越界与敏感文件由服务端拒绝）。 */
  const loadContent = (path: string): void => {
    setActivePath(path);
    setEdited(false);
    void api.getFileContent(assetId, path).then((envelope) => {
      if (!envelope.ok) return;
      const plain = String(envelope.data.plain ?? '');
      if (plain) setLiveContent((prev) => ({ ...prev, [path]: plain }));
    });
    void api.getFileOutline(assetId, path).then((envelope) => {
      if (envelope.ok) setOutline(envelope.data);
    });
  };

  /* 资产切换 → 重新拉树 / 仓库状态 / 分支；默认打开的文件优先用演示路径，
   * 真实克隆的仓库没有那个路径时退到树里第一个文件。 */
  useEffect(() => {
    let cancelled = false;
    setLiveContent({});
    /* 换资产等于换仓库：符号引用的扫描结果不能跨仓库复用。 */
    setRefs(null);
    /* 没有选中资产（打包态首屏就是这种）时不要发 `/assets//...`：
     * 空 id 只会换来一串 404，界面本来也没有可渲染的树。 */
    if (!assetId) {
      setTree([]);
      setRepo(null);
      return () => { cancelled = true; };
    }
    void api.getFileTree(assetId).then((envelope) => {
      if (cancelled || !envelope.ok) return;
      const nodes: TreeNode[] = envelope.data.map((n) => ({
        label: n.name, depth: n.depth, caret: n.caret, path: n.isFile ? n.path : null,
      }));
      setTree(nodes);
      const defaultPath = 'src/main/java/order/InventoryClient.java';
      const hit = envelope.data.find((n) => n.isFile && n.path === defaultPath);
      const first = envelope.data.find((n) => n.isFile);
      const target = hit?.path ?? first?.path;
      if (target) loadContent(target);
    });
    void api.getRepoStatus(assetId).then((envelope) => {
      if (!cancelled && envelope.ok) setRepo(envelope.data);
    });
    void api.getAsset(assetId).then((envelope) => {
      if (!cancelled && envelope.ok) setAssetName(envelope.data.name);
    });
    void api.getGitSummary(assetId).then((envelope) => {
      if (!cancelled && envelope.ok && envelope.data.branch) setBranch(envelope.data.branch);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId, state.assetRevision]);

  /* 引用浮层「打开」→ 加载源文件并跳到真实行号。
   * 内容是从 /files/content 异步拉的，所以要等 DOM 渲染出对应行再滚；
   * 给 20 次 × 120ms 的上限，超时如实提示而不是无限等。 */
  useEffect(() => {
    const pending = state.pendingSource;
    if (!pending) return;
    loadContent(pending.path);
    const line = pending.line;
    if (!line) {
      addToast(`已打开 ${pending.path}`);
      consumeSource();
      return;
    }
    let tries = 0;
    const timer = window.setInterval(() => {
      const target = codeRef.current?.children[line - 1] as HTMLElement | undefined;
      if (target) {
        window.clearInterval(timer);
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.style.background = 'var(--accent-weak, rgba(99,102,241,0.18))';
        window.setTimeout(() => { target.style.background = ''; }, 1200);
        addToast(`已跳到 ${pending.path}:${line}`);
      } else if (++tries > 20) {
        window.clearInterval(timer);
        addToast(`已打开 ${pending.path}，但第 ${line} 行未能定位`);
      }
    }, 120);
    consumeSource();
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.pendingSource]);

  /* 可打开的文件清单：优先用当前资产的真实文件树；拉不到才回落全局装配。 */
  const filePaths = useMemo(() => {
    const fromTree = tree.filter((node) => node.path).map((node) => node.path as string);
    if (fromTree.length > 0) return fromTree;
    return CODE_FILES.map((item) => item.path);
  }, [tree, CODE_FILES]);

  /* 行数：兼容两种 HTML 格式 —— mock 的 \n 分行文本 与 highlight/markAll 的每行 <div>。
   * 取两者较大值，避免 highlight 输出（join('') 无 \n）导致 gutter 只显示 1 行。 */
  const lineCount = Math.max(
    file.html.split('\n').length,
    (file.html.match(/<div>/g) || []).length,
    1,
  );

  const save = (): void => {
    setModified(false);
    addToast(`已保存 ${file.name} · 用户手动修改不受只读模式限制`);
    /* 没编辑过就直接回写原文（`liveContent` 是接口返回的原始字节），**不走 DOM**：
     * 编辑区是渲染出来的 DOM，任何序列化都有损耗风险；而"只是点了下保存"理应零改动。
     * 编辑过就按行结构序列化（不是 innerText）——理由见 utils/editor-text.ts：
     * innerText 会把空行的占位 `<br>` 也算成一次断行，保存时给每条空行多插一行。 */
    const fromDisk = liveContent[activePath];
    let content: string;
    if (!edited && fromDisk !== undefined) {
      content = fromDisk;
    } else {
      content = serializeEditor(codeRef.current);
      /* 序列化不保留文件末尾的换行：不补回来，每编辑一次保存就少一个尾换行，
         多存几次会对整个文件产生一行假 diff。 */
      if (fromDisk !== undefined && fromDisk.endsWith('\n') && !content.endsWith('\n')) content += '\n';
    }
    // actor=user 是唯一真实落盘路径；服务端 FileService 校验路径与敏感规则后写盘 + 审计。
    void api
      .saveFile(assetId, { path: file.path, content })
      .then((envelope) => {
        if (!envelope.ok) {
          addToast(`保存被拒绝：${envelope.error?.code ?? 'E_INTERNAL'} ${envelope.error?.message ?? ''}`);
          setModified(true);
          return;
        }
        addToast(`服务端已落盘 ${envelope.data.bytesWritten} 字节 · diskChanged=${envelope.data.diskChanged}`);
        /* 保存成功后重拉大纲（符号随内容变化）。 */
        void api.getFileOutline(assetId, file.path).then((result) => {
          if (result.ok) setOutline(result.data);
        });
        /* 引用 / 遗留标记是**整仓扫描**，保存后它们的行号与计数全部基于旧内容。
         * 不标过期的话，同一屏里会出现「右栏粗扫已更新、底部面板还是旧数字」——
         * 正是 §22 想避免的那种自相矛盾。没真改动就不标，假警多了真警没人信。 */
        if (shouldInvalidateScans(envelope.data.diskChanged)) {
          setRefs((prev) => (prev ? { ...prev, stale: true } : prev));
          setTodos((prev) => (prev ? { ...prev, stale: true } : prev));
        }
      })
      .catch(() => undefined);
  };

  /* 全库检索面板：⌘⇧F 或文件树顶部的入口打开。
   * 底部只有一片空间，三个面板（引用 / 遗留标记 / 全库检索）互斥——同屏两块数据抢位置，
   * 用户会以为「打开新的那个」只是叠加，实际是把上一个挤没了。 */
  const openRepoSearch = (): void => {
    if (!assetId) {
      addToast('还没有选中代码库资产，无法全库检索');
      return;
    }
    setRefs(null);
    setTodos(null);
    setRepoSearch(true);
  };

  useEffect(() => {
    if (!state.hotkey || state.view !== 'detail-code') return;
    if (state.hotkey.kind === 'openFile') {
      // ⌘P 在代码库详情内任意 Tab 均可用，选中后自动进入编辑器。
      setModal({
        kind: 'files',
        title: '打开文件 ⌘P · order-service',
        files: filePaths,
        onPick: (path: string) => {
          setDetailTab('main');
          loadContent(path);
          addToast(`已打开 ${path}`);
        },
      });
    } else if (state.hotkey.kind === 'saveCode' && state.detailTab === 'main') {
      save();
    } else if (state.hotkey.kind === 'searchRepo') {
      openRepoSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hotkey]);

  /* B18：大纲符号跳行 —— 滚动到对应行并短暂高亮。 */
  const jumpToLine = (line: number): void => {
    const target = codeRef.current?.children[line - 1] as HTMLElement | undefined;
    if (!target) {
      addToast(`跳转到第 ${line} 行（内容未加载）`);
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.style.background = 'var(--accent-weak, rgba(99,102,241,0.18))';
    window.setTimeout(() => {
      target.style.background = '';
    }, 900);
  };

  /**
   * 拉某个符号的引用明细（整仓扫描）。
   *
   * 只有「当前请求的符号」能写回状态：用户连续点两个符号时，先发的那个可能后到，
   * 不校验就会把 A 的数据显示在 B 的标题下面——这比慢一点严重得多。
   */
  const openRefs = (symbol: string): void => {
    if (!assetId) {
      addToast('还没有选中代码库资产，无法扫描引用');
      return;
    }
    if (refs?.symbol === symbol && refs.loading) return;
    /* 底部只放得下一个面板：开引用就收掉另外两块，否则它们抢同一片空间。 */
    setTodos(null);
    setRepoSearch(false);
    setRefs({ symbol, loading: true, data: null });
    const land = (next: RefsState): void => {
      setRefs((prev) => (prev && prev.symbol === symbol ? next : prev));
    };
    void api.getFileRefs(assetId, symbol).then((envelope) => {
      land({
        symbol,
        loading: false,
        data: envelope.ok ? envelope.data : null,
        error: envelope.ok ? undefined : `${envelope.error?.code ?? 'E_INTERNAL'} ${envelope.error?.message ?? ''}`.trim(),
      });
    }).catch(() => land({ symbol, loading: false, data: null, error: '网络异常' }));
  };

  /** 引用面板的行 → 跳转。同文件内滚动高亮，跨文件交给 openSource（加载完再定位）。 */
  const jumpToRef = (path: string, line: number): void => {
    if (path === activePath) jumpToLine(line);
    else openSource(path, line);
  };

  /**
   * 扫整仓的遗留标记。
   *
   * 不做"进详情就自动扫"：整仓遍历 + 逐文件读，仓库大一点就是几秒的同步开销，
   * 而用户多数时候只是来看某个文件。所以是显式的「点一次付一次」，和 refs 同一口径。
   */
  const openTodos = (force = false): void => {
    if (!assetId) {
      addToast('还没有选中代码库资产，无法扫描遗留标记');
      return;
    }
    if (todos?.loading) return;
    /* 已经有结果且不是强制刷新：只把面板展开，不重复扫。 */
    if (todos?.data && !force) {
      setRefs(null);
      setRepoSearch(false);
      return;
    }
    setRefs(null);
    setRepoSearch(false);
    setTodos({ loading: true, data: null });
    void api.getFileTodos(assetId).then((envelope) => {
      setTodos({
        loading: false,
        data: envelope.ok ? envelope.data : null,
        error: envelope.ok ? undefined : `${envelope.error?.code ?? 'E_INTERNAL'} ${envelope.error?.message ?? ''}`.trim(),
      });
    }).catch(() => setTodos({ loading: false, data: null, error: '网络异常' }));
  };

  /* B19：⌘F 查找条开关（编辑态如实提示不可用）。 */
  useEffect(() => {
    if (!state.hotkey || state.hotkey.kind !== 'find') return;
    if (state.view !== 'detail-code' || state.detailTab !== 'main') return;
    if (edited) {
      addToast('查找在编辑态暂不可用（高亮暂停）· 保存后即可查找');
      return;
    }
    setFind((prev) => (prev?.open ? null : { open: true, query: '', index: 0 }));
    window.setTimeout(() => findInputRef.current?.focus(), 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.hotkey]);

  /* B19：查找数据（命中位置 → 行号映射）。 */
  const findData = useMemo(() => {
    const plain = liveContent[activePath];
    if (!find?.open || !find.query || plain === undefined || edited) return null;
    return markAll(plain, find.query, find.index);
  }, [find, liveContent, activePath, edited]);

  /* 当前命中滚入视野。 */
  useEffect(() => {
    if (!find?.open || !findData || findData.lineOf.length === 0) return;
    const line = findData.lineOf[Math.min(find.index, findData.lineOf.length - 1)];
    const target = codeRef.current?.children[line - 1] as HTMLElement | undefined;
    target?.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find?.index, findData]);

  const findStep = (delta: number): void => {
    if (!findData || findData.lineOf.length === 0) return;
    const total = findData.lineOf.length;
    setFind((prev) => (prev ? { ...prev, index: (prev.index + delta + total) % total } : prev));
  };

  const updateCursor = (): void => {
    const el = codeRef.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0 || !selection.anchorNode) return;
    if (!el.contains(selection.anchorNode)) return;
    try {
      const range = document.createRange();
      range.setStart(el, 0);
      range.setEnd(selection.anchorNode, selection.anchorOffset);
      const parts = range.toString().split('\n');
      setCursor({
        line: file.gutterStart + parts.length - 1,
        col: parts[parts.length - 1].length + 1,
      });
    } catch {
      /* 忽略无法计算光标位置的边界情况 */
    }
  };

  const gutter = Array.from({ length: lineCount }, (_, index) => file.gutterStart + index).join('\n');

  /* B18：目录树展开/收起 —— 真文件树按祖先目录过滤。 */
  const visibleNodes = useMemo(() => {
    /* 优先用按资产拉到的真实树；拉不到才回落全局装配的 CODE_TREE。 */
    const source: TreeNode[] = tree.length > 0 ? tree : (CODE_TREE as unknown as TreeNode[]);
    const result: { node: TreeNode; index: number }[] = [];
    const dirStack: { index: number; depth: number }[] = [];
    source.forEach((node, index) => {
      while (dirStack.length > 0 && dirStack[dirStack.length - 1].depth >= node.depth) dirStack.pop();
      const hidden = dirStack.some((dir) => collapsed.has(dir.index));
      if (!hidden) result.push({ node: node as TreeNode, index });
      if (!node.path) dirStack.push({ index, depth: node.depth });
    });
    return result;
  }, [tree, CODE_TREE, collapsed]);

  const toggleDir = (index: number): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  /** ⋯ 菜单：重建索引 / 分支详情 / 重命名 —— 全部走真实端点。 */
  const [menuOpen, setMenuOpen] = useState<boolean>(false);
  const reindexAsset = (): void => {
    void api.advanceIndex(assetId).then((envelope) => {
      addToast(envelope.ok ? `已推进索引：${envelope.data.indexProgress}% · ${envelope.data.status}` : `索引推进失败：${envelope.error?.message ?? '未知错误'}`);
      void api.getRepoStatus(assetId).then((result) => {
        if (result.ok) setRepo(result.data);
      });
    });
  };
  const showBranch = (): void => {
    void api.getGitSummary(assetId).then((envelope) => {
      setModal({
        kind: 'info',
        title: `仓库分支 · ${assetName || assetId}`,
        body: envelope.ok
          ? Object.entries(envelope.data as unknown as Record<string, unknown>).map(([k, v]) => `${k}：${String(v)}`).join('\n')
          : 'git 摘要查询失败（离线或非 git 环境）',
        mono: true,
      });
    });
  };
  /** 真实 clone：把远端仓库拉到该项目的本地工作区目录，随后自动重建索引。 */
  const runClone = (): void => {
    const url = cloneUrl.trim();
    if (!url) {
      addToast('请先填写仓库地址');
      return;
    }
    setCloneBusy(true);
    void api.cloneRepo(assetId, {
      url,
      branch: cloneBranch.trim() || undefined,
      depth: Number(cloneDepth) || 0,
    }).then((envelope) => {
      setCloneBusy(false);
      if (!envelope.ok) {
        addToast(`克隆失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      const result = envelope.data;
      setCloneOpen(false);
      setCloneUrl('');
      setCloneBranch('');
      addToast(`已${result.action === 'pulled' ? '拉取' : '克隆'}到 ${result.localPath} · ${result.branch}@${result.commit} · 索引 ${result.index.chunks} 块`);
      /* 重新拉树与仓库状态：文件列表与分支都变了。 */
      void api.getFileTree(assetId).then((result2) => {
        if (!result2.ok) return;
        setTree(result2.data.map((n) => ({
          label: n.name, depth: n.depth, caret: n.caret, path: n.isFile ? n.path : null,
        })));
      });
      void api.getRepoStatus(assetId).then((result2) => {
        if (result2.ok) setRepo(result2.data);
      });
      void api.getGitSummary(assetId).then((result2) => {
        if (result2.ok && result2.data.branch) setBranch(result2.data.branch);
      });
    }).catch(() => {
      setCloneBusy(false);
      addToast('克隆失败：网络异常');
    });
  };
  const showRepoInfo = (): void => {
    if (!repo) {
      addToast('仓库状态未知');
      return;
    }
    setModal({
      kind: 'info',
      title: `本地仓库 · ${assetName || assetId}`,
      body: [
        `本地路径：${repo.absolutePath}`,
        `工作区相对路径：${repo.localPath || '—'}`,
        `远端地址：${repo.cloneUrl || '—'}`,
        `分支：${repo.branch || '—'}`,
        `提交：${repo.commit || '—'}`,
        `最近提交：${repo.lastCommit || '—'}`,
        `文件数：${repo.files}`,
        `未提交改动：${repo.dirty ? '有' : '无'}`,
        repo.error ? `异常：${repo.error}` : '',
      ].filter(Boolean).join('\n'),
      mono: true,
    });
  };
  /* 编辑资产：仓库地址 / 分支 / 索引模式 / 忽略规则 / 敏感文件规则与鉴权，
   * 全在同一张表单里改。只给"重命名"的话，填错一个分支就只能删了重建。 */
  const editAsset = (): void => {
    if (!assetId) {
      addToast('还没有可编辑的代码库资产');
      return;
    }
    openAssetForm(assetId);
  };

  return (
    <div className={`view${state.view === 'detail-code' ? ' on' : ''}`} data-view="detail-code">
      <DetailHeader
        icon={<CodeIcon size={15} strokeWidth={1.4} />}
        name={assetName || '代码库'}
        sub={repo?.cloned
          ? `本地工作区 · ${repo.localPath} · ${repo.branch || branch}`
          : `尚未克隆到本地 · ${branch}`}
        pills={
          <>
            <Pill tone="ok">
              <span className="sdot" />
              {repo?.cloned ? '已索引' : '待克隆'}
            </Pill>
            <Pill tone="ro">只读</Pill>
          </>
        }
        actions={
          <>
            <button
              className="btn p"
              onClick={() =>
                openAssetChat({ assetId, assetName: assetName || '代码库', assetType: 'code' })
              }
              title="在当前页面唤起一条绑定该代码库的 AI 会话"
            >
              <ChatIcon size={13} strokeWidth={1.4} />
              AI 会话
            </button>
            <button className="btn" onClick={() => setCloneOpen((value) => !value)}>
              {repo?.cloned ? '拉取最新' : '克隆仓库'}
            </button>
            <button
              className="btn p"
              onClick={() =>
                setModal({
                  kind: 'files',
                  title: '打开文件 ⌘P · order-service',
                  files: filePaths,
                  onPick: (path: string) => {
                    setDetailTab('main');
                    loadContent(path);
                    addToast(`已打开 ${path}`);
                  },
                })
              }
            >
              打开文件 ⌘P
            </button>
            <button
              className="dcfg"
              type="button"
              title="资产配置（能力授权 / 仓库信息）"
              aria-label="资产配置"
              onClick={() => setConfigOpen(true)}
            >
              <GearSvg />
            </button>
            <div className="amore" onClick={() => setMenuOpen((value) => !value)}>
              <DotsIcon size={14} />
            </div>
            {menuOpen ? (
              <div className="cmenu" onMouseLeave={() => setMenuOpen(false)}>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); setCloneOpen((value) => !value); }}>
                  {repo?.cloned ? '拉取最新 / 换仓库' : '克隆仓库到本地'}
                </div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); showRepoInfo(); }}>仓库信息</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); reindexAsset(); }}>重建索引</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); showBranch(); }}>查看分支</div>
                <div className="cmenu-item" onClick={() => { setMenuOpen(false); editAsset(); }}>编辑资产…</div>
              </div>
            ) : null}
          </>
        }
      />
      <DetailTabs tabs={TABS} active={state.detailTab} onChange={setDetailTab} />

        <div className={`dbody${state.detailTab === 'main' ? ' on' : ''}`} data-dt="main">
        <Banner>
          {state.readOnly
            ? '只读模式仅约束 Agent：你的手动修改可直接保存；Agent 的提议修改以 patch 形式提供，确认后才会落盘'
            : '只读已关闭：你的手动修改可直接保存；Agent 的提议修改仍以 patch 形式提供，确认后才会落盘'}
        </Banner>
        {cloneOpen ? (
          <div style={{ borderBottom: '1px solid var(--gray-700, #2a2f3a)', padding: '10px 12px' }}>
            <div style={{ fontSize: 12, color: 'var(--gray-400)', marginBottom: 8 }}>
              克隆到本地工作区：仓库会被拉到该项目自己的目录下（workspaces/&lt;项目&gt;/&lt;仓库&gt;），
              与其他项目的仓库互不干扰。私有仓库请确保本机已配置 SSH Key 或 Git 凭据助手。
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={cloneUrl}
                onChange={(event) => setCloneUrl(event.target.value)}
                placeholder="仓库地址 · https://host/org/repo.git 或 git@host:org/repo.git"
                style={{
                  flex: '2 1 320px', background: 'var(--gray-800, rgba(255,255,255,0.04))',
                  border: '1px solid var(--gray-700, #2a2f3a)', borderRadius: 6,
                  color: 'inherit', padding: '5px 9px', outline: 'none', fontSize: 12,
                }}
              />
              <input
                value={cloneBranch}
                onChange={(event) => setCloneBranch(event.target.value)}
                placeholder="分支（可空）"
                style={{
                  flex: '0 1 140px', background: 'var(--gray-800, rgba(255,255,255,0.04))',
                  border: '1px solid var(--gray-700, #2a2f3a)', borderRadius: 6,
                  color: 'inherit', padding: '5px 9px', outline: 'none', fontSize: 12,
                }}
              />
              <input
                value={cloneDepth}
                onChange={(event) => setCloneDepth(event.target.value)}
                placeholder="深度"
                title="浅克隆深度；填 0 为全量克隆"
                style={{
                  flex: '0 1 64px', background: 'var(--gray-800, rgba(255,255,255,0.04))',
                  border: '1px solid var(--gray-700, #2a2f3a)', borderRadius: 6,
                  color: 'inherit', padding: '5px 9px', outline: 'none', fontSize: 12,
                }}
              />
              <button className="btn p" onClick={runClone} disabled={cloneBusy}>
                {cloneBusy ? '克隆中…' : repo?.cloned ? '拉取' : '克隆'}
              </button>
              <button className="btn" onClick={() => setCloneOpen(false)} disabled={cloneBusy}>取消</button>
            </div>
          </div>
        ) : null}
        <div className="split">
          <div className="ftree">
            {/* 全库检索入口：⌘⇧F 是唯一"看不见"的快捷键里最值得配按钮的一个 ——
                「这里找不到，那去别处找」是看代码时最常冒出来的念头。 */}
            <button className="fsearch" type="button" onClick={openRepoSearch} title="全库检索 ⌘⇧F">
              <span>搜全库</span>
              <span className="k">⌘⇧F</span>
            </button>
            {visibleNodes.map(({ node, index }) => {
              const isDir = !node.path;
              const isCollapsed = collapsed.has(index);
              return (
                <div
                  className={`fnode${!isDir && node.path === file.path ? ' on' : ''}`}
                  key={`${index}:${node.label}`}
                  style={{ paddingLeft: 10 + node.depth * 14 }}
                  onClick={() => {
                    if (isDir) {
                      toggleDir(index);
                    } else if (node.path) {
                      /* 用节点的完整路径直连读盘：不再按文件名反查，重名文件也不会跳错。 */
                      loadContent(node.path);
                      addToast(`已打开 ${node.path}`);
                    }
                  }}
                >
                  <span className="ic">
                    {isDir ? (
                      <CaretIcon dir={isCollapsed ? 'right' : 'down'} size={10} strokeWidth={1.6} />
                    ) : (
                      <span style={{ width: 10, display: 'inline-block' }} />
                    )}
                  </span>
                  <span className="ftic">
                    {isDir ? (
                      <span style={{ color: '#d4a017', display: 'inline-flex' }}>
                        <FolderIcon size={13} strokeWidth={1.4} />
                      </span>
                    ) : (
                      <FileTypeIcon name={node.label} size={13} strokeWidth={1.4} />
                    )}
                  </span>
                  {node.label}
                  {!isDir && node.path === file.path && modified ? <span className="md" /> : null}
                </div>
              );
            })}
          </div>
          <div className="editor">
            <div className="ebar">
              <span className="fn">{file.name}</span>
              {modified ? (
                <>
                  <span className="moddot" />
                  <span style={{ color: 'var(--gray-400)' }}>已修改</span>
                </>
              ) : (
                <span style={{ color: 'var(--gray-400)' }}>已保存</span>
              )}
              {edited ? <span style={{ color: 'var(--gray-400)', fontSize: 11 }}>编辑态 · 高亮暂停</span> : null}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <button
                  className="btn"
                  onClick={() => {
                    /* B19：真实 git diff（对 HEAD）；离线/非 git 回落静态 CODE_DIFF。 */
                    void api.getFileDiff(assetId, file.path).then((envelope) => {
                      if (!envelope.ok) {
                        setModal({ kind: 'info', title: 'Diff · 与 HEAD 对比', body: CODE_DIFF, mono: true });
                        return;
                      }
                      if (envelope.data.clean) {
                        addToast('工作区与 HEAD 一致 · 无未提交变更');
                        return;
                      }
                      /* 未追踪的新文件：diff 是空的，但把它说成"无变更"就是撒谎。 */
                      if (envelope.data.untracked) {
                        addToast('该文件尚未被 git 追踪（新增未 add）· diff 看不到内容');
                        return;
                      }
                      setModal({
                        kind: 'info',
                        title: `Diff · ${file.name} · 与 HEAD 对比（git 真查）`,
                        body: envelope.data.diff,
                        mono: true,
                      });
                    });
                  }}
                >
                  Diff
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    /* B2：patch 由服务端生成（applicable:false，磁盘零变更）。 */
                    void api
                      .generatePatch(assetId, { path: file.path, patch: CODE_PATCH })
                      .then((envelope) => {
                        const patch = envelope.ok ? envelope.data.patch : CODE_PATCH;
                        setModal({
                          kind: 'command',
                          title: '生成 patch（建议 · 不落盘）',
                          command: patch,
                          body: '只读模式仅约束 Agent：这是 Agent 生成的建议 patch，需你确认后手动保存。',
                        });
                        addToast('patch 已生成（Agent 建议，未落盘）');
                      });
                  }}
                >
                  生成 patch
                </button>
                <button className="btn p" onClick={save}>
                  保存 ⌘S
                </button>
              </span>
            </div>
            {find?.open ? (
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px',
                  borderBottom: '1px solid var(--gray-700, #2a2f3a)', fontSize: 12,
                }}
              >
                <span style={{ color: 'var(--gray-400)' }}>查找</span>
                <input
                  ref={findInputRef}
                  value={find.query}
                  onChange={(event) => setFind({ open: true, query: event.target.value, index: 0 })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      findStep(event.shiftKey ? -1 : 1);
                    } else if (event.key === 'Escape') {
                      event.stopPropagation();
                      setFind(null);
                    }
                  }}
                  placeholder="输入关键词 · Enter 下一个 · Shift+Enter 上一个 · Esc 关闭"
                  style={{
                    flex: 1, background: 'var(--gray-800, rgba(255,255,255,0.04))',
                    border: '1px solid var(--gray-700, #2a2f3a)', borderRadius: 6,
                    color: 'inherit', padding: '3px 8px', outline: 'none',
                  }}
                />
                <span style={{ color: 'var(--gray-400)', minWidth: 64, textAlign: 'right' }}>
                  {findData && findData.lineOf.length > 0
                    ? `${Math.min(find.index + 1, findData.lineOf.length)} / ${findData.lineOf.length}`
                    : '0 个'}
                </span>
                <button className="btn" onClick={() => findStep(-1)} title="上一个 (Shift+Enter)">‹</button>
                <button className="btn" onClick={() => findStep(1)} title="下一个 (Enter)">›</button>
                <button className="btn" onClick={() => setFind(null)} title="关闭 (Esc)" aria-label="关闭查找">
                  <CloseIcon size={12} strokeWidth={1.5} />
                </button>
              </div>
            ) : null}
            <div className="codewrap">
              <div className="gutter">{gutter}</div>
              <div
                className="codebody"
                key={activePath}
                ref={codeRef}
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                dangerouslySetInnerHTML={{ __html: file.html }}
                onClick={updateCursor}
                onKeyUp={updateCursor}
                onInput={() => {
                  if (!modified) setModified(true);
                  if (!edited) setEdited(true);
                }}
              />
            </div>
            {repoSearch ? (
              <RepoSearchPanel
                assetId={assetId}
                onClose={() => setRepoSearch(false)}
                onJump={jumpToRef}
              />
            ) : null}
            {refs ? (
              <RefsPanel
                state={refs}
                onClose={() => setRefs(null)}
                onJump={jumpToRef}
                onRescan={() => openRefs(refs.symbol)}
              />
            ) : null}
            {todos ? (
              <TodosPanel
                state={todos}
                onClose={() => setTodos(null)}
                onJump={jumpToRef}
                onRescan={() => openTodos(true)}
              />
            ) : null}
          </div>
          <div className="rinfo">
            <div className="rt">大纲</div>
            {(outline?.symbols ?? file.symbols).map((symbol) => {
              /* 大纲标签对方法带 `(...)` 后缀（`deduct(...)`），后台扫描要的是裸标识符；
               * 构造函数、运算符之类取不到裸名的，就不给「引」入口，而不是发一个注定 400 的请求。 */
              const bare = symbol.label.replace(/\(\.\.\.\)$/, '');
              const canRefs = symbol.sg !== 'X' && /^[A-Za-z_$][\w$]*$/.test(bare);
              return (
                <div
                  className="sym"
                  key={`${symbol.label}:${symbol.line ?? 0}`}
                  onClick={() => jumpToLine(symbol.line ?? 1)}
                  style={{ cursor: 'pointer' }}
                  title={symbol.line ? `跳转到第 ${symbol.line} 行` : undefined}
                >
                  <span className="sg">{symbol.sg}</span>
                  {symbol.label}
                  {canRefs ? (
                    <span
                      className="refsbtn"
                      role="button"
                      title={`查看 ${bare} 的引用（符号级扫描：排除注释与字符串，按 import 做跨文件收敛）`}
                      onClick={(event) => {
                        /* 点「引」是查引用，不是跳行：不拦冒泡会连带滚动一次。 */
                        event.stopPropagation();
                        openRefs(bare);
                      }}
                    >
                      引
                    </span>
                  ) : null}
                  {symbol.line ? <span className="ln">:{symbol.line}</span> : null}
                </div>
              );
            })}
            <div className="rt" style={{ marginTop: 16 }}>
              引用
            </div>
            {(outline?.references ?? ['被 2 个文件提到（文件级粗扫：子串命中、含注释与字符串、不区分同名符号）'])
              .map((reference) => (
                <div
                  className="sym"
                  key={reference}
                  style={{ color: reference.startsWith('·') ? 'var(--gray-300)' : 'var(--gray-400)', cursor: 'default' }}
                >
                  {reference}
                </div>
              ))}
            <div className="sym" style={{ color: 'var(--gray-400)', cursor: 'default', fontSize: 11 }}>
              点上方符号的「引」看符号级明细（排除注释/字符串，并给出跨文件归属）
            </div>
            <div className="rt" style={{ marginTop: 16 }}>
              Git
            </div>
            {(outline?.git ?? ['最后修改 a3f21c9', '1 小时前 · 黎']).map((item) => (
              <div className="sym" key={item} style={{ color: 'var(--gray-400)' }}>
                {item}
              </div>
            ))}
            {/* 遗留标记：仓库级，与上面三栏（都是当前文件视角）故意分开。
                不自动扫描——整仓遍历是同步的，用户多数时候只是来看某个文件。 */}
            <div className="rt" style={{ marginTop: 16 }}>
              遗留标记
            </div>
            {todos?.loading ? (
              <div className="sym" style={{ color: 'var(--gray-400)', cursor: 'default' }}>正在遍历仓库…</div>
            ) : null}
            {todos?.error ? (
              <div className="sym" style={{ color: 'var(--danger)', cursor: 'default' }}>扫描失败：{todos.error}</div>
            ) : null}
            {/* 过期态**撤掉旧数字**，不是加个角标继续显示：
                旧数字带上小字注释之后仍然会被读走，而它的行号已经指错地方了。 */}
            {todos?.data && todos.stale ? (
              <div
                className="sym"
                style={{ color: 'var(--warning)' }}
                onClick={() => openTodos(true)}
                title="文件保存后原来的行号与计数已失效"
              >
                {STALE_RAIL_LABEL}
              </div>
            ) : null}
            {todos?.data && !todos.stale ? (
              <>
                <div className="sym" onClick={() => openTodos()}>
                  {todoRailSummary(todos.data)}
                  <span className="refsbtn" role="button" title="打开遗留标记明细面板">明细</span>
                </div>
                {todos.data.hits.slice(0, 3).map((hit) => (
                  <div
                    className="sym"
                    key={`${hit.path}:${hit.line}`}
                    style={{ color: 'var(--gray-400)', fontSize: 11.5 }}
                    onClick={() => jumpToRef(hit.path, hit.line)}
                    title={`${hit.marker} ${hit.path}:${hit.line}`}
                  >
                    {/* 只留末两段：212px 放不下整条路径，但只给文件名遇到同名文件就没法区分。 */}
                    {hit.marker} {hit.path.split('/').slice(-2).join('/')}:{hit.line}
                  </div>
                ))}
                <div
                  className="sym"
                  style={{ color: 'var(--gray-400)', fontSize: 11 }}
                  onClick={() => openTodos(true)}
                  title="重新遍历仓库（结果会覆盖当前这份）"
                >
                  重新扫描
                </div>
              </>
            ) : null}
            {!todos ? (
              <div className="sym" onClick={() => openTodos()} title="遍历仓库文本文件，只读；单文件上限 200KB">
                扫描 TODO / FIXME / HACK
              </div>
            ) : null}
          </div>
        </div>
        <div className="dbar2">
          <span>{branch}</span>
          <span>UTF-8</span>
          <span>{file.lang}</span>
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span className="sr">
            <span>⌘F 本文件查找</span>
            <span>⌘⇧F 全库检索</span>
            <span>⌘P 跳转文件</span>
            <span>点击大纲符号跳行</span>
          </span>
        </div>
      </div>

        <AssetConfigDrawer
        open={state.configOpen && state.view === 'detail-code'}
        title={assetName || '代码库'}
        sub={branch}
        caps={CAPS_CODE}
        assetId={assetId}
        readOnly={state.readOnly}
        metrics={CODE_METRICS}
        kv={CODE_REPO_KV.map((row) => ({ k: row.k, v: row.v }))}
        activity={CODE_ACTIVITY_KV.map((row) => ({ k: row.k, v: row.v }))}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  );
}
