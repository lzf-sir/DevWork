/**
 * Skill 登记表 —— 输入框「/ 技能」菜单的唯一事实来源。
 *
 * 形态（devwork-asset-capability-design.md §4 的可执行版）：
 * 提示词级 Skill = 方法论模板 + 依赖的只读工具 + （V2）声明的写工具。
 *
 * 硬约束：
 *  1. tools 里的每个名字必须真实存在于 TOOL_REGISTRY 且**不是写工具**——
 *     Skill 只能收窄权限不能放大，写工具必须单独声明在 writeTools 并走审批管线；
 *  2. requiresAssets 是 Skill 的可用性判据：工作区缺该类型资产 → 显示
 *     「不可用（缺少 xx 资产）」而非隐藏（设计 §4 末尾的产品决策）；
 *  3. budget 是真实预算：maxToolCalls 由会话编排消费，防循环烧工具调用。
 */
import { TOOL_REGISTRY } from './tools';
import { loadFileSkills, summarizeMethodology, type FileSkill } from '../services/skill-loader';

export type SkillCategory = '排障' | '数据' | '代码' | '文档';
export type SkillAssetType = 'code' | 'db' | 'server' | 'kb' | 'log' | 'api';

export interface SkillSpec {
  id: string;
  label: string;
  desc: string;
  category: SkillCategory;
  /** 插入输入框的模板（用户可编辑后随消息提交）。 */
  template: string;
  /** 依赖的只读工具名（白名单 ∩ 派生工具面 ∩ 已授权能力——只收不放）。 */
  tools: string[];
  /** 可用性判据：工作区必须存在的资产类型。 */
  requiresAssets: SkillAssetType[];
  /** 工具调用预算（会话编排消费）。 */
  budget: { maxToolCalls: number };
  /** V2 写工具声明（批准后走三层防线执行管线）。 */
  writeTools?: string[];
  /** 来处：builtin = 随代码发布（与前端镜像同源）；file = skills/<id>/SKILL.md。 */
  source?: 'builtin' | 'file';
  /** 触发场景：模型据此判断该不该加载（文件技能才有）。 */
  whenToUse?: string;
  /** 完整方法论：skill(mode=load) 时进上下文；内置技能的历史正文即 template。 */
  methodology?: string;
}

/**
 * 内置技能（随代码发布）。
 * 与前端离线镜像 `frontend/src/data/mock.ts` 的 MOCK_SKILLS 逐字段一致，
 * 由 `tests/skills.mjs` 把关——这份是"菜单能离线渲染"的底线，不要在这里加玩笑项。
 */
const BUILTIN_SKILLS: SkillSpec[] = [
  /* ================= 设计 §4 六大预置 Skill ================= */
  {
    id: 'bug-locator',
    label: 'Bug 定位',
    desc: '症状澄清 → 日志/代码/数据三层收敛 → 证据链 → 结论与修复建议',
    category: '排障',
    requiresAssets: ['code'],
    budget: { maxToolCalls: 40 },
    tools: ['code_find', 'code_view', 'db_query', 'kb_search', 'srv_log_tail'],
    writeTools: ['code_edit'],
    template:
      '[技能：Bug 定位] 请按「① collect：澄清症状并拉取相关日志 → ② locate：日志→代码→数据三层收敛定位 → '
      + '③ verify：用真实证据复现或排除 → ④ report：结论 + 修复建议（patch 以 diff 文本给出）」四步执行；'
      + '每一步引用真实工具结果，证据不足时明说不足，不要跳到结论。修复 patch 默认只建议不落盘。',
  },
  {
    id: 'cmd-advisor',
    label: '命令顾问',
    desc: '澄清意图 → 影响面评估 → 模板匹配 → 建议卡（命令+回滚）',
    category: '排障',
    requiresAssets: ['server'],
    budget: { maxToolCalls: 20 },
    tools: ['srv_status', 'srv_log_tail', 'ws_list_assets'],
    writeTools: ['srv_exec'],
    template:
      '[技能：命令顾问] 请按「① intent：澄清要做什么 → ② impact：用 srv_status 评估影响面 → '
      + '③ match：只使用命令模板库覆盖的意图（模板外操作明确说「模板库不支持，只能给建议」） → '
      + '④ present：给出命令、影响面与回滚命令」执行；禁止编造模板外的 shell 命令去执行。',
  },
  {
    id: 'log-investigator',
    label: '日志排查',
    desc: '时间窗与范围 → aggregate 摸量 → 取样关联 → 时间线与根因假设',
    category: '排障',
    requiresAssets: ['log'],
    budget: { maxToolCalls: 30 },
    tools: ['log_query', 'srv_status', 'code_find'],
    template:
      '[技能：日志排查] 请按「① frame：定时间窗与服务范围 → ② query：先小 limit 摸量再按需加大 → '
      + '③ correlate：跨服务/关键词关联 → ④ report：时间线 + 根因假设（标注置信依据）」执行；'
      + '直接全量检索会被熔断，先窄后宽。',
  },
  {
    id: 'sql-analyst',
    label: 'SQL 分析',
    desc: '读表结构 → EXPLAIN 执行计划 → 索引/扫描量分析 → 优化建议（DDL 仅文本）',
    category: '数据',
    requiresAssets: ['db'],
    budget: { maxToolCalls: 25 },
    tools: ['db_query', 'db_inspect', 'kb_search'],
    writeTools: ['db_query_write'],
    template:
      '[技能：SQL 分析] 请按「① read：db_inspect（mode=schema）看表结构与索引 → ② analyze：EXPLAIN 看执行计划与扫描量 → '
      + '③ report：优化建议（建议 DDL 一律以文本给出，不执行）」执行；写操作仅限明确确认后的 DML 且走审批。',
  },
  {
    id: 'doc-generator',
    label: '文档生成',
    desc: '读代码与已有文档 → 按模板起草 → 校验引用真实性 → 产出',
    category: '文档',
    requiresAssets: ['code'],
    budget: { maxToolCalls: 30 },
    tools: ['code_view', 'code_find', 'kb_search'],
    writeTools: ['fs_write_file'],
    template:
      '[技能：文档生成] 请按「① collect：读代码与已有文档 → ② draft：按结构起草 → '
      + '③ validate：核对文档中引用的接口/参数/行号是否真实存在（防文档幻觉） → ④ present」执行；'
      + '引用不存在的接口比不写更糟，校验不过就删掉那段。',
  },
  {
    id: 'code-reviewer',
    label: '代码审查（深）',
    desc: '定范围 → 分维度过 checklist → 分级问题清单（blocker/warning/nit）',
    category: '代码',
    requiresAssets: ['code'],
    budget: { maxToolCalls: 30 },
    tools: ['code_find', 'code_view'],
    template:
      '[技能：代码审查（深）] 请按「① scope：确定审查范围（diff/文件/符号） → ② review：超时/重试/空值/边界/'
      + '并发/事务分维度过 → ③ report：分级问题清单（blocker/warning/nit），每条指到文件与行」执行；'
      + '全程只读，不改文件。',
  },
  {
    id: 'release-check',
    label: '发布检查',
    desc: '工作区变更清单 → 关键文件 diff → 遗留标记 → 近期错误日志 → 服务状态 → 放行/阻断结论',
    category: '代码',
    requiresAssets: ['code', 'log'],
    budget: { maxToolCalls: 25 },
    tools: ['code_view', 'code_todos', 'log_query', 'srv_status'],
    template:
      '[技能：发布检查] 请按「① diff：先 code_view（mode=status）拿整仓变更清单（没路径也能列，比逐个猜文件靠谱）→ '
      + '对风险最高的 2-3 个文件再 code_view（mode=diff）看具体改动；清单里若出现本次没碰过的文件，说明还有别的改动来源，必须点名，别默认都是这批改动 → '
      + '② todos：code_todos 扫遗留标记（结果带 @ 所属方法；新增 FIXME/阻断性 TODO 要点名并给出归属） → '
      + '③ errors：log_query 查近期 ERROR/WARN → ④ status：srv_status 确认当前服务状态 → '
      + '⑤ verdict：给出 放行 / 带条件放行 / 阻断 结论与依据」执行；每一步引用真实工具结果，查不到就明说，不猜。',
  },
  {
    id: 'api-explorer',
    label: 'API 探查',
    desc: '端点规范 → 白名单内真实调用验证 → 代码定位 → 调用说明',
    category: '代码',
    requiresAssets: ['api'],
    budget: { maxToolCalls: 20 },
    tools: ['api_spec_read', 'api_call_read', 'kb_search', 'code_find'],
    template:
      '[技能：API 探查] 请按「① spec：api_spec_read 列端点规范 → ② probe：api_call_read 在只读白名单内真实调用验证（路径不在白名单就明说，不去猜） → '
      + '③ locate：code_find（mode=index）定位对应实现 → ④ present：给出请求形态、响应示例与实现位置」执行；'
      + '全程只读端点，禁止构造副作用调用。',
  },
  {
    id: 'perf-triage',
    label: '性能分诊',
    desc: '慢请求摸量 → 表规模画像 → 代码热点定位 → 分诊结论',
    category: '排障',
    requiresAssets: ['db', 'log', 'code'],
    budget: { maxToolCalls: 30 },
    tools: ['log_query', 'db_inspect', 'db_query', 'code_find'],
    writeTools: ['db_query_write'],
    template:
      '[技能：性能分诊] 请按「① measure：log_query 摸慢请求量与分布（先窄时间窗） → ② profile：db_inspect（mode=counts）看表规模，db_query+EXPLAIN 看扫描量 → '
      + '③ locate：code_find（mode=index）找到对应查询实现 → ④ triage：分诊结论（索引缺失/查询写法/数据量/服务资源），每条带证据」执行；'
      + '优化建议以文本给出，DML 走审批。',
  },
  /* ================= 原有技能（保留，前端镜像有对应项） ================= */
  {
    id: 'slow-query',
    label: '慢查询排查',
    desc: '慢日志 Top N → 量级分布 → 口径与索引核对，三步定位慢 SQL',
    category: '数据',
    requiresAssets: ['db'],
    budget: { maxToolCalls: 20 },
    tools: ['pg_sql_query', 'kb_search'],
    template:
      '[技能：慢查询排查] 请按「① 拉慢日志 Top N 语句 → ② 看命中语句的量级与耗时分布 → ③ 核对口径与索引」三步排查；'
      + '全程只读，每一步都要给出数据来源，查不到就直接说没有，不要推测。',
  },
  {
    id: 'gmv-attribution',
    label: 'GMV 归因',
    desc: '先确认口径，再按维度拆解，区分口径变化与业务变化',
    category: '数据',
    requiresAssets: ['db', 'kb'],
    budget: { maxToolCalls: 20 },
    tools: ['pg_sql_query', 'kb_search'],
    template:
      '[技能：GMV 归因] 请按「① 用知识库确认指标口径 → ② 按渠道/状态/时间维度拆解同比与环比 → ③ 区分口径变更与业务变化」三步归因；'
      + '结论必须标注引用角标，无法证实的部分写「暂无证据」。',
  },
  {
    id: 'code-review',
    label: '代码审查',
    desc: '定位变更 → 检查超时重试与边界 → 给风险等级和改法',
    category: '代码',
    requiresAssets: ['code'],
    budget: { maxToolCalls: 20 },
    tools: ['code_find'],
    template:
      '[技能：代码审查] 请按「① 定位变更文件与关键方法 → ② 检查超时/重试/空值与边界 → ③ 给出风险等级与具体改法」审查；'
      + '只做只读检索，不要修改任何文件，每条问题都要指到文件与行。',
  },
  {
    id: 'incident-review',
    label: '故障复盘',
    desc: '现象 → 时间线 → 直接/根本原因 → 改进项',
    category: '排障',
    requiresAssets: ['db', 'kb', 'code'],
    budget: { maxToolCalls: 30 },
    tools: ['pg_sql_query', 'kb_search', 'code_find'],
    template:
      '[技能：故障复盘] 请按「① 现象与影响面 → ② 关键时间线与证据 → ③ 直接原因 / 根本原因 → ④ 改进项与验收标准」四段输出；'
      + '每条结论都要有引用，缺证据就写「无证据」，不要用常识补齐。',
  },
  {
    id: 'kb-digest',
    label: '口径核对',
    desc: '列出文档原文口径、当前数据口径与是否一致',
    category: '文档',
    requiresAssets: ['kb'],
    budget: { maxToolCalls: 15 },
    tools: ['kb_search'],
    template:
      '[技能：口径核对] 请先检索知识库中与该问题相关的文档，逐条列出「文档原文口径 / 当前数据口径 / 是否一致」；'
      + '不一致时指出差异来源，不要自行调和两边。',
  },
];

/**
 * 文件技能 → SkillSpec。
 *
 * template 是**派生**的（正文压成一段摘要）：输入框菜单需要一个能直接发出去的
 * 一句话模板，而正文动辄几千字，塞进输入框既不可读也不好改。
 * methodology 保留全文，供 skill(mode=load) 按需加载。
 */
function fileSkillsAsSpecs(): SkillSpec[] {
  const report = loadFileSkills();
  return report.skills.map((skill: FileSkill) => ({
    id: skill.id,
    label: skill.label,
    desc: skill.desc,
    category: skill.category as SkillCategory,
    requiresAssets: skill.requiresAssets as SkillAssetType[],
    budget: { maxToolCalls: skill.budget },
    tools: skill.tools,
    writeTools: skill.writeTools.length > 0 ? skill.writeTools : undefined,
    source: 'file' as const,
    whenToUse: skill.whenToUse,
    methodology: skill.methodology,
    template: `[技能：${skill.label}] 请按该技能的方法论执行：${summarizeMethodology(skill.methodology)}`,
  }));
}

/**
 * 对外的技能清单 = 内置 + 文件技能。
 *
 * 两段的边界：内置项由代码发布、与前端镜像同源（离线菜单靠它）；
 * 文件项由 `backend/src/skills/<id>/SKILL.md` 提供，团队可自行增删，重启生效。
 * 合并顺序固定（内置在前），否则前端菜单顺序会在重启后跳来跳去。
 */
export const SKILL_REGISTRY: SkillSpec[] = [
  ...BUILTIN_SKILLS.map((skill) => ({ ...skill, source: 'builtin' as const })),
  ...fileSkillsAsSpecs(),
];

/** 登记表自检：只读工具必须存在且真是只读；写工具必须存在且真是写（V2 管线消费）。 */
export function validateSkillRegistry(): string[] {
  const problems: string[] = [];
  /* 文件技能的结构问题（frontmatter 缺字段、目录名与 id 不符、工具名不存在）
   * 由加载器收集——它们不该让整个 /api/skills 500，但也不能静默消失。 */
  problems.push(...loadFileSkills().problems);
  /* id 撞车：文件技能与内置技能同名会让 skill(mode=load) 拿到哪一个全凭数组顺序。 */
  const seen = new Set<string>();
  SKILL_REGISTRY.forEach((skill) => {
    if (seen.has(skill.id)) problems.push(`${skill.id}: 技能 id 重复（内置与文件技能撞名，请改名）`);
    seen.add(skill.id);
    if (!skill.template.trim()) problems.push(`${skill.id}: 模板为空`);
    if (!skill.budget?.maxToolCalls || skill.budget.maxToolCalls <= 0) problems.push(`${skill.id}: 预算缺失`);
    skill.tools.forEach((tool) => {
      if (!TOOL_REGISTRY[tool]) problems.push(`${skill.id}: 未知工具 ${tool}`);
      else if (TOOL_REGISTRY[tool].writeAction) problems.push(`${skill.id}: tools 里混入了写工具 ${tool}（写工具必须声明在 writeTools）`);
    });
    (skill.writeTools ?? []).forEach((tool) => {
      if (!TOOL_REGISTRY[tool]) problems.push(`${skill.id}: writeTools 未知工具 ${tool}`);
      else if (!TOOL_REGISTRY[tool].writeAction) problems.push(`${skill.id}: writeTools 里的 ${tool} 其实不是写工具`);
    });
  });
  return problems;
}

/** 可用性判据：requiresAssets ⊆ 工作区现有资产类型。缺失时显示「不可用」而非隐藏。 */
export function skillAvailability(requiresAssets: SkillAssetType[], presentTypes: string[]): { available: boolean; missing: string[] } {
  const missing = requiresAssets.filter((required) => !presentTypes.includes(required));
  return { available: missing.length === 0, missing };
}

/** 对外形状：附带工具的真实登记信息（标签/风险/是否只读）+ 可用性 + 预算。 */
export function skillShape(skill: SkillSpec, presentTypes?: string[]): Record<string, unknown> {
  const availability = presentTypes
    ? skillAvailability(skill.requiresAssets, presentTypes)
    : { available: true, missing: [] };
  return {
    id: skill.id,
    label: skill.label,
    desc: skill.desc,
    category: skill.category,
    template: skill.template,
    requiresAssets: skill.requiresAssets,
    budget: skill.budget,
    availability,
    /* 来源与正文长度要暴露给前端与诊断：菜单上没有标记的话，
     * 用户不知道这个技能是谁加进来的、为什么和别人的不一样。 */
    source: skill.source ?? 'builtin',
    whenToUse: skill.whenToUse ?? '',
    methodologyChars: (skill.methodology ?? skill.template).length,
    writeTools: (skill.writeTools ?? []).map((name) => {
      const spec = TOOL_REGISTRY[name];
      return { name, label: spec?.label ?? name, risk: spec?.risk ?? 'unknown', needsApproval: true };
    }),
    tools: skill.tools.map((name) => {
      const spec = TOOL_REGISTRY[name];
      return {
        name,
        label: spec?.label ?? name,
        risk: spec?.risk ?? 'unknown',
        readOnly: spec ? !spec.writeAction : false,
      };
    }),
  };
}
