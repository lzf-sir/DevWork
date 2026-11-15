/**
 * ToolCatalog —— 工具派生管线（对应 devwork-asset-capability-design.md §1/§2/§3）。
 *
 * 三条硬规则（设计文档判断一/二/三）：
 * 1. 工具面从「工作区资产 × 能力声明 × 信任级别」派生，不是写死的清单；
 * 2. 权限跟 Capability 走：派生时把资产实例的风险与约束一起算出来；
 * 3. prod 资产的 write/exec 组**不存在**（不是 ask）——派生阶段就剪掉。
 *
 * 与旧 TOOL_REGISTRY（config/tools.ts）的关系：
 * 旧表是「权限裁决 + 兼容旧名」的事实来源。派生管线产出的工具面供 OpenAI 网关
 * toolsSpec 与 GET /api/tools 使用；执行器（agent-tools.ts）在入口把旧名归一成
 * 这里的正式名（见 LEGACY_TOOL_ALIASES），所以**同一个动作只有一份实现**。
 *
 * ============ 为什么合并工具（V10 的工具面收敛） ============
 *
 * 工具面有预算（TOOL_FACE_BUDGET）：每个工具都要进系统提示词，工具越多模型选错
 * 的概率越高——30 个"一次只做一件事"的工具，比 20 个"用一个参数说清要做什么"的
 * 工具更容易被正确使用，也更省上下文。
 *
 * 合并的判据只有一条：**同一个对象 + 互斥的动词**。
 *   · code_find  = 定位（同一对象：仓库里的位置）  ← code_search / code_grep / code_glob / refs
 *   · code_view  = 看一个文件（同一对象：文件）    ← code_read / code_symbols / code_diff
 *   · db_inspect = 看库（同一对象：库结构）        ← db_schema / db_tables
 *   · browser    = 内置浏览器（同一对象：当前页）  ← browser_navigate / browser_read_page
 *   · skill      = 技能（同一对象：技能）          ← skill_list / skill_load
 *   · code_edit  = 改文件（同一对象：文件）        ← code_edit / code_edit_str
 *
 * 反例（**故意不合并**）：db_query 与 db_query_write 是同一个对象（库），但风险档
 * 不同。合并成 db_query(mode=read|write) 就等于让"要不要审批"取决于模型传的字符串，
 * 权限裁决必须看**工具名**，不能看参数——这是安全边界，不是命名偏好。
 * 同理 fs_write_file 不并进 code_edit：写工具按**落点**分（代码库 / 工作区），
 * 而不是按动作分，落点决定快照目录与资产归属。
 *
 * 合并的代价必须显式支付：所有多 mode 工具都**要求显式传 mode**（required），
 * 不允许靠默认值猜——模型必须自己说清"我现在是要列文件还是搜内容"。
 */
import { all, get } from '../db/database';
import { TOOL_REGISTRY } from './tools';

export type ToolRisk = 'low' | 'medium' | 'high';
export type AssetType = 'code' | 'db' | 'server' | 'kb' | 'log' | 'api';

/** 工具面预算：进系统提示词的工具条数上限（超过就说明该合并而不是该加）。 */
export const TOOL_FACE_BUDGET = 30;

export interface CatalogParam {
  type: string;
  description: string;
  /** 枚举参数：写进 JSON Schema，让模型没有"发明一个 mode"的机会。 */
  enum?: string[];
}

/** 目录条目：一种「逻辑工具」。派生时绑定具体资产实例后才是可调用工具。 */
export interface CatalogEntry {
  name: string;
  group: 'common' | 'code' | 'db' | 'server' | 'kb' | 'log' | 'api';
  /** 绑定的资产类型；'workspace' 表示跨资产通用。 */
  assetType: AssetType | 'workspace';
  /** 只读动作名（参与权限裁决与能力映射）。 */
  action: string;
  /** 写动作名；只读工具为 undefined。 */
  writeAction?: string;
  risk: ToolRisk;
  /** v1 = 只读主干；v2 = 写能力层。 */
  version: 'v1' | 'v2';
  label: string;
  /** 给模型看的描述（决定它会不会用对）。多 mode 工具必须逐条写清每个 mode。 */
  description: string;
  /** 给模型的参数 schema（简化 JSON Schema properties）。 */
  params: Record<string, CatalogParam>;
  required?: string[];
  needsCredential?: boolean;
}

/** 参数统一包一层 object，符合 OpenAI function calling 形态。 */
function schemaOf(entry: CatalogEntry): Record<string, unknown> {
  return {
    type: 'object',
    properties: entry.params,
    required: entry.required ?? [],
  };
}

/** ============ 工具目录（设计 §2 全景清单的可执行版） ============ */
export const TOOL_CATALOG: CatalogEntry[] = [
  /* ---- 跨资产通用 ---- */
  {
    /* 任务清单：长任务先拆步、再逐步推进。这条工具**任何工作区都有**（assetType
     * 为 workspace），因为它操作的是 Agent 自己的计划状态，不是用户资产。 */
    name: 'todo_write', group: 'common', assetType: 'workspace',
    action: 'todo.plan', risk: 'low', version: 'v1',
    label: '任务清单', needsCredential: false,
    description: [
      '维护本次任务的计划清单（清单卡片原位更新，用户会实时看到进度）。',
      '长任务（预计超过 3 个动作）先一次性拆成 3~7 步再动手；每完成一步立刻回传',
      '完整清单并把该步 status 改成 done。status 只能是 pending / doing / done / blocked，',
      '卡住就标 blocked 并在 note 里写卡在哪，不要为了"看起来完成"把没做的标 done。',
    ].join(''),
    params: {
      items: {
        type: 'array',
        description: '清单项数组（建议全量回传）：[{ id?, title, status?, note? }]；id 可省略，按标题自动对上已有项',
      },
    },
    required: ['items'],
  },
  {
    name: 'ws_list_assets', group: 'common', assetType: 'workspace',
    action: 'asset.read', risk: 'low', version: 'v1',
    label: '资产清单', needsCredential: false,
    description: '列出当前工作区全部资产（id/类型/名称/环境/状态）。派生管线的自描述入口：先看清单再挑工具。',
    params: {},
  },
  {
    /* 内置浏览器两个动作的对象是同一个：会话当前页。合成一条工具后，
     * "导航"与"读页"的先后关系写在同一个描述里，比两条各自强调自己更不容易漏。 */
    name: 'browser', group: 'common', assetType: 'workspace',
    action: 'browser.page.read', risk: 'low', version: 'v1',
    label: '内置浏览器', needsCredential: false,
    description: '应用内置浏览器（用户右栏「浏览器」Tab 实时可见）。'
      + 'mode=navigate：跳到 http/https 网址（仅 http/https；本机与内网地址被拦截），只改地址、不读内容，'
      + '跳完要读正文得再调一次 mode=read；'
      + 'mode=read：读当前页标题与正文快照（前端回传的文本，最长 8000 字符）。'
      + '只想"看一眼某个网址的正文"且不必动用户浏览器时，用 web_fetch 更直接。',
    params: {
      mode: {
        type: 'string', enum: ['navigate', 'read'],
        description: 'navigate=导航到 url；read=读当前页快照。必须显式指定，不要靠默认值。',
      },
      url: { type: 'string', description: '目标网址（mode=navigate 必填，http/https）' },
    },
    required: ['mode'],
  },
  {
    name: 'web_fetch', group: 'common', assetType: 'workspace',
    action: 'web.fetch.read', risk: 'low', version: 'v1',
    label: '抓取网页', needsCredential: false,
    description: '由服务端直接抓取 http/https 网页并转成纯文本正文（去脚本样式，保留标题与段落）。'
      + '适用于"看一眼这份在线文档/规范/issue"。本机与内网地址会被拦截，重定向的每一跳都会重新校验。'
      + '抓不到就如实报错，不要用记忆里的内容代替页面内容。',
    params: {
      url: { type: 'string', description: '目标网址（http/https）' },
      maxChars: { type: 'number', description: '正文最多返回多少字符（默认 20000，上限 60000）' },
    },
    required: ['url'],
  },
  {
    /* 搜索只在真的配了后端时才执行。三分之一的价值在"能拒绝"：
     * 没有后端时返回一句明确的"未接入 + 替代路径"，比返回空列表让模型自由发挥安全得多。 */
    name: 'web_search', group: 'common', assetType: 'workspace',
    action: 'web.fetch.read', risk: 'low', version: 'v1',
    label: '外部检索', needsCredential: false,
    description: '在外部搜索引擎上检索（需要服务端配置搜索后端；未配置会明确报错，不会编造结果）。'
      + '返回标题/网址/摘要，**摘要是二次加工，不是原文**：要引用具体内容必须再用 web_fetch 打开该 URL。'
      + '不知道去哪找时先用它收敛候选，再逐个抓取。',
    params: {
      query: { type: 'string', description: '检索词（收敛成关键词，不要贴整段需求）' },
      limit: { type: 'number', description: '返回条数（默认 5，上限 10）' },
    },
    required: ['query'],
  },
  {
    /* 子代理：把"翻 15 个文件"这段过程关在独立上下文里，主上下文只收一段结论。
     * 它自己也有预算（工具调用次数），用尽会如实标"没查完"。 */
    name: 'subtask', group: 'common', assetType: 'workspace',
    action: 'subtask.read', risk: 'low', version: 'v1',
    label: '子代理调研', needsCredential: false,
    description: '派一个只读子代理去独立完成一段调研，只回传结论（中间过程不进你的上下文）。'
      + '适合"要翻很多文件才能回答、但结论很短"的问题。goal 必须自包含：它看不到本次对话。'
      + '子代理只有只读工具、有调用次数上限、不能再用子代理；未接入模型时直接拒绝执行。',
    params: {
      goal: { type: 'string', description: '调研目标（自包含：查什么、在哪查、要回答什么，2000 字符内）' },
      maxToolCalls: { type: 'number', description: '子代理工具调用预算（默认 12，上限 25）' },
    },
    required: ['goal'],
  },
  {
    /* 技能两段式：先清单、后正文。正文可能有几千字，一次性全塞进系统提示词
     * 会挤掉真正的工作上下文——所以加载必须是模型显式的第二次调用。 */
    name: 'skill', group: 'common', assetType: 'workspace',
    action: 'skill.read', risk: 'low', version: 'v1',
    label: '技能', needsCredential: false,
    description: '技能 = "这类活该怎么做"的方法论，不是工具本身。'
      + 'mode=list：列清单（id/名称/分类/适用场景/依赖资产/工具预算），可按 category 过滤；'
      + 'mode=load：按 id 取完整正文与推荐工具顺序，一次只加载一个（同时加载多个会互相稀释）。'
      + '遇到陌生任务类型先 list，再 load，然后按它的步骤执行；加载了不用等于没加载。',
    params: {
      mode: {
        type: 'string', enum: ['list', 'load'],
        description: 'list=看清单；load=取某个技能的正文（需 id）。必须显式指定。',
      },
      id: { type: 'string', description: '技能 id（mode=load 必填，来自 list 结果）' },
      category: { type: 'string', description: '只看某一类：排障 / 数据 / 代码 / 文档（mode=list 可选）' },
    },
    required: ['mode'],
  },
  {
    /* 长任务里最贵的信息不是"排到第几步"（那是 todo 的活），而是**已经确认过的事实**：
     * 压缩一发生，这些事实就从上下文里消失了。memo 是它们唯一能活下来的地方。 */
    name: 'memo', group: 'common', assetType: 'workspace',
    action: 'memo.note', risk: 'low', version: 'v1',
    label: '会话笔记', needsCredential: false,
    description: '本次会话的长期笔记（落库，跨上下文压缩存活；不写磁盘、不碰用户仓库）。'
      + 'mode=write：把**结论 / 已确认的事实 / 踩过的坑**追加进笔记（replace=true 则整体覆盖）；'
      + 'mode=read：取回全部笔记（上下文被压缩过之后，先读它再决定要不要重查）。'
      + '分工：进度归 todo_write，这里只放"丢了就得重查一遍"的信息，例如'
      + '"查询超时是因为索引缺失，已用 EXPLAIN 证实（3 次全表扫描）"。',
    params: {
      mode: {
        type: 'string', enum: ['write', 'read'],
        description: 'write=追加/覆盖笔记；read=取回笔记。必须显式指定。',
      },
      content: { type: 'string', description: 'mode=write 必填：一条结论或一个事实（一条一件事，别写成小作文）' },
      replace: { type: 'boolean', description: 'mode=write 时 true=整体覆盖（默认追加）' },
    },
    required: ['mode'],
  },
  /* ---- codebase ---- */
  {
    /* 四种"找"合并成一条：它们的**对象**都是"仓库里的位置"，区别只是判据。
     * 合成一条后，模型必须自己说清用哪种判据，也就没法"顺手拿索引结果当磁盘事实"。 */
    name: 'code_find', group: 'code', assetType: 'code',
    action: 'code.search.read', risk: 'low', version: 'v1',
    label: '定位代码', needsCredential: false,
    description: '在代码库里定位东西的入口，四种 mode 的证据强度不同，选错了会得到"看起来对但不可信"的结果：'
      + 'mode=regex：按正则逐行扫**真实文件**，带行号与上下文（结论里引用行号时用这个）；'
      + 'mode=glob：只按路径/文件名匹配，不读内容、最省时间（"这类文件在哪"）；'
      + 'mode=index：走 FTS5 索引，快但索引可能滞后于工作区（命中行号要再用 regex 复核）；'
      + 'mode=refs：给一个符号名，列出定义处与引用处（词法级：已排除注释与字符串里的同名文本，'
      + '但不做类型解析）。定义散在多个文件时会额外给一张「跨文件收敛」表：按每个文件真实的 import 语句，'
      + '说明它的同名引用归到哪一处定义，并明确标出「导入了多个定义、无法拆分」与「没有 import 证据、无法归属」两类。'
      + '顺序建议：先 glob 收敛范围 → 再 regex / refs 定位 → 最后 code_view 读上下文。'
      + '找不到就是真的没有，不要换一个猜的路径当结论。',
    params: {
      mode: {
        type: 'string', enum: ['regex', 'glob', 'index', 'refs'],
        description: 'regex=正则扫磁盘；glob=按文件名找；index=索引检索；refs=符号定义与引用。必须显式指定。',
      },
      pattern: { type: 'string', description: 'regex 填正则；glob 填模式（** / * / ? / {a,b}）；index 填关键词；refs 填符号名' },
      glob: { type: 'string', description: 'mode=regex/refs 时只搜匹配的文件，如 **/*.ts（可选）' },
      path: { type: 'string', description: '只在这个子目录下找（仓库内相对路径，可选）' },
      contextLines: { type: 'number', description: 'mode=regex 时每个命中前后各带几行上下文（0-5，默认 0）' },
      max: { type: 'number', description: '最多返回多少条（regex/refs 默认 40 上限 200；glob 默认 100 上限 300）' },
      ignoreCase: { type: 'boolean', description: 'mode=regex 是否忽略大小写（默认 true；精确匹配标识符时传 false）' },
    },
    required: ['mode', 'pattern'],
  },
  {
    name: 'code_view', group: 'code', assetType: 'code',
    action: 'code.read', risk: 'low', version: 'v1',
    label: '看代码文件', needsCredential: false,
    description: '看一个已有文件的四种视角（除 status 外都要 path，敏感文件被规则拦截，返回打码说明而非内容）：'
      + 'mode=content：按 offset/limit 读正文，返回总行数与"还有 N 行未读"；'
      + 'mode=outline：只看符号大纲（类/方法 + 起止行 + 所属类），注释里的假声明不算符号；'
      + 'mode=diff：只看该文件相对 git HEAD 的未提交变更（clean 时如实返回无变更；未追踪的新文件会单独说明，不会冒充 clean）。'
      + 'diff 同样**只按 hunk 边界**展开，装不下时给标好行数的窗口并说明还剩多少行，绝不裁半个 hunk；'
      + 'mode=status：整个工作区改到了哪些文件（path 可省略，给了就只看该路径），回答"这批活动过什么"。'
      + '长文件必须用 offset/limit 分页读到末尾才能对整文件下结论——'
      + '只读了前几十行就断言"整个文件是这样"是这套工具最常见的错误来源。',
    params: {
      mode: {
        type: 'string', enum: ['content', 'outline', 'diff', 'status'],
        description: 'content=读正文；outline=符号大纲；diff=单文件未提交变更；status=整仓工作区状态。必须显式指定。',
      },
      path: { type: 'string', description: '仓库内相对路径（content/outline/diff 必填；status 可省略，给了就只看该路径）' },
      offset: { type: 'number', description: 'mode=content 起始行号，1 起（默认 1）' },
      limit: { type: 'number', description: 'mode=content 读多少行（默认 120，上限 400）' },
    },
    required: ['mode'],
  },
  {
    name: 'code_todos', group: 'code', assetType: 'code',
    action: 'code.read', risk: 'low', version: 'v1',
    label: '标记扫描', needsCredential: false,
    description: '扫描仓库源码中的 TODO / FIXME / HACK 标记，返回文件、行号、标记内容与**所属符号**'
      + '（`@ OrderService.createOrder` 这种，改之前先读它）；可用 path 限定子目录。'
      + '结果会说明读了多少文件、跳过了几个超大文件、是否触到上限——'
      + '"没扫到"和"扫全了没有"是两件事，别把前者说成后者。',
    params: {
      max: { type: 'number', description: '最多返回条数（默认 30，上限 100）' },
      path: { type: 'string', description: '子目录（仓库内相对路径，可选）：只看这一棵子树' },
    },
  },
  {
    /* git 是"为什么代码是今天这样"的唯一证据来源。code_view(mode=diff) 只看工作区，
     * 历史要看 log/blame/show —— 这三件事同样共用一个对象（提交图）。 */
    name: 'git_history', group: 'code', assetType: 'code',
    action: 'git.read', risk: 'low', version: 'v1',
    label: 'git 历史', needsCredential: false,
    description: '查代码库的 git 历史（只读，不改仓库、不碰远端）：'
      + 'mode=log：提交列表（hash / 日期 / 作者 / 标题），可用 path 限定某个文件；'
      + 'mode=blame：逐行溯源（path 必填，用 offset/limit 限定行区间，别一次要整个文件）；'
      + 'mode=show：看某次提交改了什么（rev 缺省 HEAD）。diff 先给 --stat 概览，再**按文件整段**展开；'
      + '装不下时整文件跳过（绝不裁半个 hunk）并给出 path= 单查命令——没展开的文件就是没给证据，别当它没改；'
      + '合并提交默认没有 diff，会如实说明。'
      + '不是 git 仓库、没有提交、或 rev 不存在时如实报错，不要用记忆里的历史补。',
    params: {
      mode: {
        type: 'string', enum: ['log', 'blame', 'show'],
        description: 'log=提交列表；blame=逐行溯源；show=某次提交的改动。必须显式指定。',
      },
      path: { type: 'string', description: '仓库内相对路径（log 可选、blame 必填）' },
      rev: { type: 'string', description: '提交 / 分支 / 标签（mode=show 用，缺省 HEAD）' },
      offset: { type: 'number', description: 'mode=blame 起始行（默认 1）' },
      limit: { type: 'number', description: 'mode=log 提交条数（默认 20）/ mode=blame 行数（默认 60），上限 200' },
    },
    required: ['mode'],
  },
  /* ---- database ---- */
  {
    name: 'db_query', group: 'db', assetType: 'db',
    action: 'sql.query.read', risk: 'low', version: 'v1',
    label: '只读 SQL 查询', needsCredential: true,
    description: '对数据库执行只读 SQL（仅 SELECT/WITH/EXPLAIN，单语句，自动 LIMIT），返回行数与采样。',
    params: { sql: { type: 'string', description: '只读 SQL 语句' } },
    required: ['sql'],
  },
  {
    /* 三种"看库"合并：tables（有哪些表）/ schema（表长什么样）/ counts（有多大）。
     * 都不消耗查询预算，都是排查的第一步。 */
    name: 'db_inspect', group: 'db', assetType: 'db',
    action: 'sql.query.read', risk: 'low', version: 'v1',
    label: '看库结构与规模', needsCredential: false,
    description: '看数据库的结构、规模与执行计划（不消耗查询预算，排查前先看这个）：'
      + 'mode=tables：表清单（含对象类型）；'
      + 'mode=schema：指定 table 的列类型/可空/索引/外键；'
      + 'mode=counts：逐表 COUNT(*) 行数画像（上限 20 表，可传 tables 指定）；'
      + 'mode=explain：对给定 SELECT 看执行计划（是否走索引、是否全表扫描，需传 sql）。'
      + '注意 explain 给的是**计划**不是耗时——"慢不慢"要靠 db_query 实测 durationMs。'
      + '结构先看清再写 SQL——猜列名是无效查询的主要来源。',
    params: {
      mode: {
        type: 'string', enum: ['tables', 'schema', 'counts', 'explain'],
        description: 'tables=表清单；schema=单表结构；counts=行数画像；explain=看 SELECT 的执行计划。必须显式指定。',
      },
      table: { type: 'string', description: 'mode=schema 的表名（缺省则退化为列出全部表）' },
      tables: { type: 'string', description: 'mode=counts 的逗号分隔表名（缺省取全部表，上限 20）' },
      sql: { type: 'string', description: 'mode=explain 的 SELECT / WITH 语句（单条，不带分号）' },
    },
    required: ['mode'],
  },
  /* ---- knowledge ---- */
  {
    name: 'kb_search', group: 'kb', assetType: 'kb',
    action: 'kb.search.read', risk: 'low', version: 'v1',
    label: '知识库检索', needsCredential: false,
    description: '在知识库文档索引中检索片段，返回标题/位置/片段/相关度。',
    params: { query: { type: 'string', description: '检索关键词' } },
    required: ['query'],
  },
  /* ---- server ---- */
  {
    name: 'srv_status', group: 'server', assetType: 'server',
    action: 'cmd.exec.read', risk: 'low', version: 'v1',
    label: '服务状态', needsCredential: false,
    description: '读取服务器资产状态：进程总数（真实 tasklist/ps）、主机资源（内存/CPU/uptime）与终端会话数。',
    params: {},
  },
  {
    name: 'srv_log_tail', group: 'server', assetType: 'server',
    action: 'log.read', risk: 'low', version: 'v1',
    label: '日志尾部', needsCredential: false,
    description: '读取服务日志最后 N 行（真实日志文件，非编造）。',
    params: { lines: { type: 'string', description: '行数，默认 20，上限 100' } },
  },
  /* ---- log 资产 ---- */
  {
    name: 'log_query', group: 'log', assetType: 'log',
    action: 'log.read', risk: 'low', version: 'v1',
    label: '日志检索', needsCredential: false,
    description: '按时间窗与关键词检索结构化日志（时间戳\\t级别\\t消息），先 aggregate 摸量再取样的节奏。',
    params: {
      query: { type: 'string', description: '关键词（可选）' },
      from: { type: 'string', description: '起始时间 ISO（可选）' },
      to: { type: 'string', description: '结束时间 ISO（可选）' },
      limit: { type: 'string', description: '返回条数上限，默认 30' },
    },
  },
  /* ---- api 资产 ---- */
  {
    name: 'api_spec_read', group: 'api', assetType: 'api',
    action: 'api.read', risk: 'low', version: 'v1',
    label: 'API 规范', needsCredential: false,
    description: '读取 API 资产的端点清单（方法/路径/说明/副作用标注）。调用前先看规范。',
    params: {},
  },
  {
    name: 'api_call_read', group: 'api', assetType: 'api',
    action: 'api.read', risk: 'low', version: 'v1',
    label: '调用只读接口', needsCredential: false,
    description: '调用 GET 类只读接口（路径必须在规范清单内），返回真实 HTTP 响应。副作用接口被排除。',
    params: { path: { type: 'string', description: 'API 路径（以 /api/ 开头）' } },
    required: ['path'],
  },
  /* ================= V2 写能力层 ================= */
  {
    /* 整文件写与精确替换合并：两者改的是同一个对象（一个文件），
     * 而 replace 天然更安全（oldString 唯一命中是硬护栏）。所以 mode=replace
     * 是首选路径，mode=rewrite 只在"新建 / 确实要整篇重写"时用，且要求已读完整个文件。 */
    name: 'code_edit', group: 'code', assetType: 'code',
    action: 'code.read', writeAction: 'patch.apply', risk: 'high', version: 'v2',
    label: '修改代码文件', needsCredential: false,
    description: '改代码（写工具：走审批卡 → precheck → 落盘前快照 → 可一键回滚）。'
      + 'mode=replace：把 oldString 精确替换成 newString（**改局部优先用它**）；'
      + 'oldString 必须唯一命中、且必须来自真实的 code_view 结果——命中 0 次说明你对文件的理解是错的，'
      + '命中多次说明位置有歧义，两种情况 precheck 都会中止，不会瞎猜位置；'
      + 'mode=rewrite：整文件重写（只有在你已经分页读完整个文件、或要新建文件时才用；'
      + '没读到的部分会被"顺手补全"，那是这套工具最危险的用法）。',
    params: {
      mode: {
        type: 'string', enum: ['replace', 'rewrite'],
        description: 'replace=精确替换（需要 oldString）；rewrite=整文件重写（需要 content）。必须显式指定。',
      },
      path: { type: 'string', description: '仓库内相对路径' },
      oldString: { type: 'string', description: 'mode=replace 要被替换的原文（含缩进，必须唯一命中）' },
      newString: { type: 'string', description: 'mode=replace 替换后的内容（空串表示删除这段）' },
      replaceAll: { type: 'boolean', description: 'mode=replace 允许多处替换（默认 false：要求唯一命中）' },
      content: { type: 'string', description: 'mode=rewrite 修改后的完整文件内容' },
    },
    required: ['mode', 'path'],
  },
  {
    /* 文件组织能力：改内容有 code_edit，但"把文件挪个地方 / 删掉"一直没有工具，
     * Agent 只能建议用户自己去操作。四种 mode 的风险不同，都走审批：
     * delete 尤其不能真删——移进回收站，给回滚引用。 */
    name: 'fs_manage', group: 'code', assetType: 'code',
    action: 'code.read', writeAction: 'fs.manage', risk: 'high', version: 'v2',
    label: '文件组织', needsCredential: false,
    description: '组织仓库里的文件（写工具：走审批卡 → precheck 校验两条路径 → 执行 → 回滚就绪）。'
      + 'mode=move：移动/重命名（from → to）；mode=copy：复制单个文件；'
      + 'mode=mkdir：新建目录（to）；mode=delete：移出仓库（**不是真删**，进回收站，可回滚）。'
      + 'move/copy 的目标必须不存在——覆盖是显式写操作，不该是组织操作的副作用；'
      + '两条路径都必须落在仓库内，且不能作用于仓库根。',
    params: {
      mode: {
        type: 'string', enum: ['move', 'copy', 'mkdir', 'delete'],
        description: 'move=移动/重命名；copy=复制文件；mkdir=建目录；delete=移出仓库（可回滚）。必须显式指定。',
      },
      from: { type: 'string', description: '源路径（move/copy/delete 必填，仓库内相对路径）' },
      to: { type: 'string', description: '目标路径（move/copy/mkdir 必填，仓库内相对路径，且必须不存在）' },
    },
    required: ['mode'],
  },
  {
    name: 'db_query_write', group: 'db', assetType: 'db',
    action: 'sql.query.read', writeAction: 'sql.query.write', risk: 'high', version: 'v2',
    label: '数据库写入', needsCredential: true,
    description: '执行单条 DML（INSERT/UPDATE/DELETE）。走审批卡：备份库文件 → 事务执行 → 报告影响行数，可回滚到备份。'
      + '（与 db_query 分开是因为风险档不同：审批看工具名，不能看参数。）',
    params: { sql: { type: 'string', description: '单条 DML 语句（DDL 一律拒绝）' } },
    required: ['sql'],
  },
  {
    name: 'srv_exec', group: 'server', assetType: 'server',
    action: 'cmd.exec.read', writeAction: 'exec.write', risk: 'high', version: 'v2',
    label: '执行运维操作', needsCredential: false,
    description: '意图导向的命令模板执行（设计 §6.3）：先 GET cmd-templates 看支持哪些意图；模板外操作一律拒绝转建议。',
    params: {
      action: { type: 'string', description: '意图名，如 restart_service / rotate_log / backup_file' },
      params: { type: 'string', description: 'JSON 对象：模板参数（参数取值必须是白名单枚举）' },
    },
    required: ['action'],
  },
  {
    name: 'fs_write_file', group: 'common', assetType: 'workspace',
    action: 'file.read', writeAction: 'file.write', risk: 'high', version: 'v2',
    label: '写入工作区文件', needsCredential: false,
    description: '写入工作区内代码库文件（同 code_edit 的审批/快照/回滚管线，供 doc-generator 等技能产出文件用）。',
    params: {
      path: { type: 'string', description: '仓库内相对路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
];

/** ============ 旧名兼容层 ============
 *
 * V10 之前，这 13 个名字各自是一条工具。合并之后它们不再进模型工具面，但**必须
 * 继续能执行**，原因有三个，每一个都是硬需求：
 *   ① 历史轨迹与审计表里存的是旧名（tool_call.tool_name），按旧名查不到就等于丢证据；
 *   ② 14 个内置技能的模板正文里写着旧名，用户点技能发出去的提示词里也有旧名；
 *   ③ 旧版本客户端缓存的 toolsSpec 里可能还有旧名。
 * 所以别名不是"过渡期凑合"，而是**读旧数据的能力**：归一化只发生在执行器入口，
 * 权限裁决仍按登记表里旧名自己的那条记录走（读写档不会因为别名而漂移）。
 */
export interface LegacyToolAlias {
  /** 归一后的正式工具名。 */
  to: string;
  /** 归一后强制注入的 mode（旧名的语义是固定的）。 */
  mode?: string;
  /** 旧参数名 → 新参数名（同一个东西换了叫法，不该让模型或历史数据付两次费）。 */
  rename?: Record<string, string>;
  /** 为什么合并（诊断输出用）。 */
  reason: string;
}

export const LEGACY_TOOL_ALIASES: Record<string, LegacyToolAlias> = {
  code_search: { to: 'code_find', mode: 'index', rename: { query: 'pattern' }, reason: '索引检索是 code_find 的一种判据' },
  code_grep: { to: 'code_find', mode: 'regex', reason: '磁盘正则匹配是 code_find 的一种判据' },
  code_glob: { to: 'code_find', mode: 'glob', reason: '按名找文件是 code_find 的一种判据' },
  code_read: { to: 'code_view', mode: 'content', reason: '读正文是"看文件"的一种视角' },
  code_symbols: { to: 'code_view', mode: 'outline', reason: '符号大纲是"看文件"的一种视角' },
  code_diff: { to: 'code_view', mode: 'diff', reason: '未提交变更是"看文件"的一种视角' },
  db_schema: { to: 'db_inspect', mode: 'schema', reason: '看表结构是"看库"的一种视角' },
  db_tables: { to: 'db_inspect', mode: 'counts', reason: '行数画像是"看库"的一种视角' },
  browser_navigate: { to: 'browser', mode: 'navigate', reason: '导航是内置浏览器的一个动作' },
  browser_read_page: { to: 'browser', mode: 'read', reason: '读页是内置浏览器的一个动作' },
  skill_list: { to: 'skill', mode: 'list', reason: '列技能是 skill 的一个动作' },
  skill_load: { to: 'skill', mode: 'load', reason: '加载技能是 skill 的一个动作' },
  code_edit_str: { to: 'code_edit', mode: 'replace', reason: '精确替换是"改文件"的首选模式' },
};

export interface NormalizedCall {
  name: string;
  args: Record<string, unknown>;
  /** 非空表示这次调用来自旧名（审计/诊断能看出"账是老的，动作是新的"）。 */
  aliasedFrom?: string;
}

/**
 * 把旧名归一成正式名 + 注入固定 mode。
 *
 * 别名自己的 mode **优先于** 调用方传的 mode：`code_grep` 语义上就是正则扫描，
 * 如果同时接受 mode=glob，那"旧名"就变成了一个可以指东打西的口子。
 */
export function normalizeToolCall(name: string, args?: Record<string, unknown> | null): NormalizedCall {
  const input = args ?? {};
  const alias = LEGACY_TOOL_ALIASES[name];
  if (!alias) return { name, args: input };

  const mapped: Record<string, unknown> = { ...input };
  for (const [from, to] of Object.entries(alias.rename ?? {})) {
    if (mapped[from] === undefined) continue;
    if (mapped[to] === undefined) mapped[to] = mapped[from];
    delete mapped[from];
  }
  if (alias.mode) mapped.mode = alias.mode;
  return { name: alias.to, args: mapped, aliasedFrom: name };
}

export function catalogEntry(name: string): CatalogEntry | undefined {
  return TOOL_CATALOG.find((entry) => entry.name === name);
}

/* ================= 目录自检 ================= */

/**
 * 目录自检：把"改了一处忘了另一处"变成启动/测试期就能看见的报错。
 *
 * 检查的都是**曾经真实漂移过**的地方：
 *   · 目录里加了工具但权限表没登记 → 执行期被当成未知高风险写工具，行为与设计相反；
 *   · 目录与权限表的风险档/动作名不一致 → 审批档位与审计动作对不上；
 *   · 多 mode 工具忘了要求显式传 mode → 模型靠默认值猜，合并的收益立刻变负；
 *   · 别名指向不存在的工具、或 mode 不在枚举内 → 旧名静默变成"未知工具"；
 *   · 工具面超预算 → 系统提示词膨胀，模型选错率上升。
 */
export function validateToolCatalog(): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  TOOL_CATALOG.forEach((entry) => {
    if (names.has(entry.name)) problems.push(`工具名重复：${entry.name}`);
    names.add(entry.name);

    const spec = TOOL_REGISTRY[entry.name];
    if (!spec) {
      problems.push(`${entry.name}: 未在 config/tools.ts 登记（执行期会被当成未知高风险写工具）`);
    } else {
      if (spec.action !== entry.action) problems.push(`${entry.name}: 只读动作名与登记表不一致（${entry.action} ≠ ${spec.action}）`);
      if ((spec.writeAction ?? '') !== (entry.writeAction ?? '')) problems.push(`${entry.name}: 写动作名与登记表不一致`);
      if (spec.risk !== entry.risk) problems.push(`${entry.name}: 风险档与登记表不一致（${entry.risk} ≠ ${spec.risk}）`);
      if (Boolean(spec.writeAction) !== Boolean(entry.writeAction)) problems.push(`${entry.name}: 读写属性与登记表不一致`);
    }

    (entry.required ?? []).forEach((key) => {
      if (!entry.params[key]) problems.push(`${entry.name}: required 里的 ${key} 不在 params 中`);
    });
    if (entry.params.mode) {
      const modes = entry.params.mode.enum ?? [];
      if (modes.length < 2) problems.push(`${entry.name}: 有 mode 参数但枚举不足 2 个（不构成"多模式工具"）`);
      if (!(entry.required ?? []).includes('mode')) {
        problems.push(`${entry.name}: 多 mode 工具必须把 mode 放进 required（不允许靠默认值猜）`);
      }
    }
  });

  Object.entries(LEGACY_TOOL_ALIASES).forEach(([alias, target]) => {
    const entry = catalogEntry(target.to);
    if (!entry) {
      problems.push(`别名 ${alias} 指向不存在的工具 ${target.to}`);
      return;
    }
    if (names.has(alias)) problems.push(`别名 ${alias} 与目录里的正式工具同名`);
    if (target.mode && !(entry.params.mode?.enum ?? []).includes(target.mode)) {
      problems.push(`别名 ${alias} 的 mode=${target.mode} 不在 ${target.to} 的枚举内`);
    }
    Object.entries(target.rename ?? {}).forEach(([from, to]) => {
      if (!entry.params[to]) problems.push(`别名 ${alias} 把 ${from} 改名为 ${to}，但 ${target.to} 没有这个参数`);
    });
    const legacy = TOOL_REGISTRY[alias];
    if (!legacy) {
      problems.push(`别名 ${alias} 必须留在登记表里（历史轨迹/审计按旧名查询）`);
      return;
    }
    /* 只比写动作：旧名各自有更细的只读动作名（browser.navigate / browser.read），
     * 那是历史事实、也是审计要保留的粒度，不该为了对齐而抹掉。
     * 写动作必须一致——差一格就意味着"换个名字就能绕过审批"。 */
    if ((legacy.writeAction ?? '') !== (entry.writeAction ?? '')) {
      problems.push(`别名 ${alias} 的写动作与 ${target.to} 不一致（读写档不能因别名而漂移）`);
    }
  });

  if (TOOL_CATALOG.length > TOOL_FACE_BUDGET) {
    problems.push(`工具面 ${TOOL_CATALOG.length} 条已超预算 ${TOOL_FACE_BUDGET}：该合并工具，而不是加白名单`);
  }
  return problems;
}

/* ================= 派生管线 ================= */

export interface DerivedTool {
  name: string;
  /** 绑定的资产实例 id（凭据校验/能力裁决/审计都落在这里）。 */
  assetId: string;
  assetName: string;
  assetEnv: string;
  entry: CatalogEntry;
  /** 风险（资产实例化后的最终值）。 */
  risk: ToolRisk;
  /** 被什么规则挡住而不进模型工具面（诊断用，如 prod-env / prod-workspace）。 */
  gatedBy?: string;
  /** 给模型的 function calling 形态。 */
  schema: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
}

export interface ToolFace {
  workspaceId: string;
  workspaceTrust: string;
  /** 全部派生结果（含被剪枝的，gatedBy 标注原因）——诊断与 UI 展示用。 */
  all: DerivedTool[];
  /** 实际进入模型工具面的子集（无 gatedBy）。 */
  active: DerivedTool[];
  derivationRules: string[];
}

interface AssetRow {
  id: string; type: string; name: string; env: string; status: string; credential_bound: number;
}

/** 资产查询独立成函数：避免与派生结果变量 all 同名遮蔽（TDZ 会把导入的 all 变成不可调用）。 */
function allAssets(workspaceId: string): AssetRow[] {
  return all<AssetRow>(
    'SELECT id, type, name, env, status, credential_bound FROM asset WHERE workspace_id = ? ORDER BY created_at, id',
    workspaceId,
  );
}

/** 资产是否有索引切片（主实例优先选真有内容的资产，避免绑到空壳）。 */
function hasIndexChunks(assetId: string): boolean {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM index_chunk WHERE asset_id = ?', assetId);
  return Number(row?.n ?? 0) > 0;
}

/** 每类资产挑一个「主实例」：有索引切片 > 在线且已绑凭据 > 在线 > 顺位第一。 */
function primaryAssetOf(assets: AssetRow[], type: AssetType): AssetRow | undefined {
  const pool = assets.filter((a) => a.type === type);
  if (pool.length === 0) return undefined;
  const bound = pool.filter((a) => a.status === 'online' && Number(a.credential_bound) === 1);
  /* 索引切片判定要查库，故用顺序循环代替 find(async ...)。 */
  for (const candidate of bound) {
    if (hasIndexChunks(candidate.id)) return candidate;
  }
  return (
    bound[0]
    ?? pool.find((a) => a.status === 'online')
    ?? pool[0]
  );
}

/**
 * 派生一个工作区的工具面。
 *
 * 派生规则（设计 §3 的可执行版）：
 * R1 按资产裁剪：工作区没有该类型资产 → 整组不派生；
 * R2 prod 判定以资产 env 为准（与权限内核 p3 同口径）：env=prod 的资产不派生 v2 写工具；
 * R3 工作区 trust_level 仅作标注输出（信任边界在资产级落地，避免种子标注与真实能力漂移）；
 * R4 每类资产只绑一个主实例（有索引切片优先），工具面受 TOOL_FACE_BUDGET 约束。
 */
export function deriveToolFace(workspaceId: string): ToolFace {
  const workspace = get<{ trust_level: string }>('SELECT trust_level FROM workspace WHERE id = ?', workspaceId);
  const workspaceTrust = String(workspace?.trust_level ?? 'normal');
  const assets = allAssets(workspaceId);

  const rules: string[] = [
    'R1 按资产裁剪：无该类型资产 → 整组不派生',
    'R2 prod 判定以资产 env 为准（与权限内核同口径）：env=prod → v2 写工具不派生（不存在，而非 ask）',
    'R3 工作区 trust_level 仅作标注（信任边界在资产级落地）',
    `R4 每类资产绑一个主实例（有索引切片优先），工具面 ≤${TOOL_FACE_BUDGET} 预算（超了先合并工具）`,
  ];

  const primaries = new Map<AssetType | 'workspace', AssetRow | undefined>();
  for (const type of (['code', 'db', 'server', 'kb', 'log', 'api'] as AssetType[])) {
    primaries.set(type, primaryAssetOf(assets, type));
  }

  const derivedAll: DerivedTool[] = [];
  for (const entry of TOOL_CATALOG) {
    let asset: AssetRow | undefined;
    if (entry.assetType === 'workspace') {
      asset = { id: workspaceId, type: 'workspace', name: 'workspace', env: '', status: 'online', credential_bound: 1 };
    } else {
      asset = primaries.get(entry.assetType);
    }
    if (!asset) {
      /* R1：没有对应资产 → 整条不进（连诊断列表都不进，与设计语义一致）。 */
      continue;
    }
    let gatedBy: string | undefined;
    if (entry.version === 'v2' && asset.env === 'prod') gatedBy = 'prod-env';
    const derived: DerivedTool = {
      name: entry.name,
      assetId: asset.id,
      assetName: asset.name,
      assetEnv: asset.env,
      entry,
      risk: entry.risk,
      gatedBy,
      schema: {
        type: 'function',
        function: {
          name: entry.name,
          description: `${entry.description}（绑定资产：${asset.name} · ${asset.id}${asset.env ? ` · ${asset.env}` : ''}）`,
          parameters: schemaOf(entry),
        },
      },
    };
    derivedAll.push(derived);
  }

  return {
    workspaceId,
    workspaceTrust,
    all: derivedAll,
    active: derivedAll.filter((tool) => !tool.gatedBy),
    derivationRules: rules,
  };
}

/** 网关 toolsSpec 形态：只放行 active。 */
export function gatewayToolFace(face: ToolFace): { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return face.active.map((tool) => tool.schema);
}

/** 按名字取派生工具（执行器用）。 */
export function derivedTool(face: ToolFace, name: string): DerivedTool | undefined {
  return face.all.find((tool) => tool.name === name);
}
