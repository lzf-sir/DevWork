/**
 * LlmGateway —— 未配 Key 时用规则化 MockGateway 驱动会话轨迹（V8）。
 * 配了 Key 时替换为 OpenAiCompatibleGateway，前端零改动；只替换 Gateway 实现。
 *
 * 硬规则（对应设计 §5.6 反幻觉三条）：MockGateway **不得**产出 conclusion 与
 * citation。没有模型就没有推理，宁可明说"本次不给结论"，也不能拿模板文本冒充
 * 分析结果——设计 §12 风险 1 的原话是「一个错误的根因分析会让人往错的方向
 * 排查半天」。Mock 只负责：真实调用只读工具 → 把真实结果与真实引用交给 UI。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_ROOT } from '../config';
import { loadSecret, storeSecret } from './secret-store';
import { settingRaw } from '../db/repositories';
import { all, run } from '../db/database';
import { toolIsWrite, toolRisk } from '../config/tools';

/** 没有供应商 usage 时的本地估算（字符数 / 1.5 ≈ token 数，仅用于兜底，不是真值）。 */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 1.5));
}

export type GatewayKind = 'mock' | 'openai-compatible';

export type AgentEvent =
  | { type: 'routing'; intent: string; mountedAssets: string[]; model: string; degraded?: boolean }
  | { type: 'plan'; intent: string; steps: { goal: string; durationMs: number }[]; degraded?: boolean }
  /** 任务清单：长任务的每一步状态。同一会话反复出现时前端按 id 原位更新同一张卡。 */
  | { type: 'todo'; items: { id?: string; title: string; status?: string; note?: string }[]; degraded?: boolean }
  | { type: 'text'; content: string }
  | { type: 'text_delta'; content: string }
  /** level=warn 用于降级说明（未接入模型 / 模型调用失败），UI 需常驻可见。 */
  | { type: 'notice'; level: 'info' | 'warn'; title: string; content: string }
  | {
      type: 'tool_call';
      toolName: string;
      /** 卡片展示名（可写「kb_search + code_find」这类组合说明）。 */
      label?: string;
      args: string;
      durationMs: number;
      risk: 'low' | 'medium' | 'high';
      result: string;
      /** 真实执行结果是否成功；缺省视为未知（历史轨迹回放场景）。 */
      ok?: boolean;
      write: boolean;
    }
  | {
      type: 'citation';
      id: string;
      title: string;
      source: string;
      locator: string;
      snippet: string;
      confidence: number;
      version: string;
      /** 源文件定位：路径 + 行区间，「打开」据此直达编辑器对应行。 */
      path?: string;
      startLine?: number;
      endLine?: number;
      kind?: 'code' | 'doc';
    }
  | { type: 'conclusion'; confidence: string; citationIds: string[]; content: string; paras: Record<string, string>[][] }
  | { type: 'artifact'; name: string; fileName: string; fileType: string; sizeBytes: number; meta: string; desc: string }
  /** 真实用量：provider = 供应商回传的 usage；estimate = 本地按字符估算（不是真值）。 */
  | { type: 'usage'; promptTokens: number; completionTokens: number; model: string; source: 'provider' | 'estimate' }
  | { type: 'done'; intent: string };

export interface GatewayContext {
  conversationId: string;
  workspaceId: string;
  content: string;
  assetIds: string[];
  readOnlyMode: boolean;
  /** 多轮上下文（旧消息按时间正序，含 user/assistant 文本）。 */
  history?: { role: 'user' | 'assistant'; content: string }[];
  /** 派生工具面（OpenAI function calling 形态）。由会话编排按工作区资产计算后注入；
   *  缺省时网关退回内置三个只读工具（兼容老轨迹）。 */
  toolFace?: { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  /** 真实工具执行器（由 conversation 服务提供，含权限内核裁决 + 凭据检查）。 */
  executeTool?: (toolName: string, argsJson: string) => Promise<ToolExecutionResult>;
  /** 当前任务清单的一行式快照（todo.ts 的 todoPromptOf）—— 进系统提示，
   *  让模型在长任务里始终看得见自己排到第几步，而不是靠"记忆"。 */
  todoText?: string;
}

export interface CitationSeed {
  title: string;
  source: string;
  locator: string;
  snippet: string;
  confidence: number;
  version: string;
  /** 源文件路径与行号：前端「打开」据此跳到编辑器对应行。 */
  path?: string;
  startLine?: number;
  endLine?: number;
  kind?: 'code' | 'doc';
}

export interface ToolExecutionResult {
  ok: boolean;
  result: string;
  citations?: CitationSeed[];
}

export interface LlmGateway {
  readonly kind: GatewayKind;
  /** 实际模型名；未接入模型时明确写「未接入模型」，不能编一个型号糊上去。 */
  readonly modelName: string;
  generate(ctx: GatewayContext): AsyncIterable<AgentEvent>;
  /**
   * 上下文压缩用的一次性摘要（非流式）。
   *
   * 只有接了真模型才实现它 —— 没模型时 compress 走规则提炼（抽取用户诉求与已有结论），
   * 并在摘要卡上如实标注 source='rule'，不冒充模型总结。
   */
  summarize?(transcript: string, maxChars: number): Promise<{ text: string; source: 'model'; model: string }>;
}

export function detectIntent(content: string): string {
  if (/GMV|口径|下降|归因|同比|metrics|gmv/i.test(content)) return 'metrics_attribution';
  if (/QPS|慢查询|报错|超时|故障|排查|incident|error|timeout/i.test(content)) return 'incident_diagnosis';
  if (/审查|PR|review|代码|code review|补丁|patch/i.test(content)) return 'code_review';
  return 'general';
}

/**
 * 只读工具步骤。toolName 必须是执行器真实认识的名字，
 * 否则 Mock 会请执行器返回「未知工具」——这是刻意的：宁可失败也不假装成功。
 */
interface ToolStep {
  toolName: string;
  label: string;
  args: string;
  risk: 'low' | 'medium' | 'high';
  write: boolean;
  /**
   * 只是示例、当前环境并不具备执行条件（例如日志资产没挂载时给 `fs_truncate_log` 的命令）。
   * 标了它就不再给出针对不存在文件的具体路径，只说明「需先挂载日志资产」。
   */
  sampleOnly?: boolean;
}

interface Template {
  steps: { goal: string; durationMs: number }[];
  /** 固定正文（不涉及"挂载了什么"的那几句）。 */
  text: string;
  /**
   * 正文里需要说明"挂载了哪些资产"时，只给后半句，前半句由 `mountingSentence()`
   * 按当前工作区真实资产拼——模板里不能再写死任何资产名。
   */
  mountingTail?: string;
  tools: ToolStep[];
}

const TEMPLATES: Record<string, Template> = {
  metrics_attribution: {
    steps: [
      { goal: '识别意图并挂载生产库 / 运营知识库', durationMs: 120 },
      { goal: '查询 order 表状态分布', durationMs: 1800 },
      { goal: '检索 GMV 口径说明与季度复盘', durationMs: 900 },
      { goal: '把证据交给用户判断（未接入模型，不产出结论）', durationMs: 120 },
    ],
    text: '',
    mountingTail: '先按只读方式核对订单状态分布，再检索口径文档。',
    tools: [
      {
        toolName: 'pg_sql_query',
        label: 'pg_sql_query',
        args: '{"sql":"SELECT status, count(*) AS n FROM \\"order\\" GROUP BY status"}',
        risk: 'low',
        write: false,
      },
      {
        toolName: 'kb_search',
        label: 'kb_search',
        args: '{"query":"GMV 口径 退款 冲减"}',
        risk: 'low',
        write: false,
      },
      {
        toolName: 'fs_truncate_log',
        label: 'fs_truncate_log',
        args: '{"path":"/var/log/order-api/error.log"}',
        risk: 'high',
        write: true,
      },
    ],
  },
  incident_diagnosis: {
    steps: [
      { goal: '拉取慢查询日志 Top 语句', durationMs: 900 },
      { goal: '检索超时与重试相关代码', durationMs: 600 },
      { goal: '把证据交给用户判断（未接入模型，不产出结论）', durationMs: 120 },
    ],
    text: '正在比对慢查询日志与超时配置，全过程只读。',
    tools: [
      {
        toolName: 'pg_sql_query',
        label: 'pg_sql_query',
        args: '{"sql":"SELECT statement, duration FROM slow_log ORDER BY duration DESC LIMIT 20"}',
        risk: 'low',
        write: false,
      },
      {
        toolName: 'code_find',
        label: 'code_find',
        args: '{"mode":"index","pattern":"setConnectTimeout"}',
        risk: 'low',
        write: false,
      },
      {
        toolName: 'service.restart',
        label: 'service.restart',
        args: '{"service":"order-api"}',
        risk: 'high',
        write: true,
      },
    ],
  },
  code_review: {
    steps: [
      { goal: '定位变更文件与 diff', durationMs: 180 },
      { goal: '检索 InventoryClient 超时配置', durationMs: 600 },
      { goal: '把命中位置交给用户判断（未接入模型，不产出结论）', durationMs: 120 },
    ],
    text: '已定位 InventoryClient 的连接超时配置，正在核对上下文。',
    tools: [
      {
        toolName: 'code_find',
        label: 'code_find',
        args: '{"mode":"index","pattern":"setConnectTimeout"}',
        risk: 'low',
        write: false,
      },
      {
        toolName: 'patch.apply',
        label: 'patch.apply',
        args: '{"path":"InventoryClient.java"}',
        risk: 'high',
        write: true,
      },
    ],
  },
  general: {
    steps: [
      { goal: '识别意图并挂载资产', durationMs: 120 },
      { goal: '在知识库与代码库中检索与问题相关的片段', durationMs: 310 },
      { goal: '把证据交给用户判断（未接入模型，不产出结论）', durationMs: 120 },
    ],
    text: '已收到。下面用你的原问题在本地索引里做一次真实检索。',
    tools: [
      {
        toolName: 'kb_search',
        label: 'kb_search',
        args: '{"query":"{{content}}"}',
        risk: 'low',
        write: false,
      },
      {
        toolName: 'code_find',
        label: 'code_find',
        args: '{"mode":"index","pattern":"{{content}}"}',
        risk: 'low',
        write: false,
      },
      {
        toolName: 'fs_truncate_log',
        label: 'fs_truncate_log',
        args: '{"risk":"high"}',
        risk: 'high',
        write: true,
      },
    ],
  },
};

/** 从用户原问题里抽出检索用的关键词：整句直接喂给 FTS 往往命中率极低。 */
function keywordQuery(content: string): string {
  const cleaned = content
    .replace(/[?？。，,！!：:；;、"'"'（）()\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(' ').filter((token) => token.length >= 2);
  return tokens.length > 0 ? tokens.join(' ') : cleaned;
}

/** 当前工作区**实际**挂载的资产。 */
interface MountedAsset {
  id: string;
  name: string;
  type: string;
}

/**
 * 读当前工作区真实挂载的资产（按创建顺序，与侧栏一致）。
 *
 * 为什么降级轨迹必须查库而不是沿用模板里的写死值：模板里写的是演示种子资产
 * （生产库 / 运营知识库），干净环境（打包态首启）一个资产都没有，那时对用户说
 * 「已挂载生产库与运营知识库」就是**假话**——与「版本号报旧的」「审计归属恒 w-ops」
 * 同属"记录/文案说 A、实际是 B"。所以文案一律按运行时事实生成，不按 CLEAN_MODE 硬切：
 * 演示态真有这些资产，文案自然还是真的。
 */
function mountedAssetsOf(workspaceId: string): MountedAsset[] {
  if (!workspaceId) return [];
  return all<{ id: string; name: string; type: string }>(
    'SELECT id, name, type FROM asset WHERE workspace_id = ? ORDER BY created_at, id',
    workspaceId,
  ).map((row) => ({ id: String(row.id), name: String(row.name), type: String(row.type) }));
}

/** 「先说哪几类」的优先级：这句正文在讲核对订单分布 + 检索口径文档，库与知识库最相关。 */
const MOUNT_ORDER = ['db', 'kb', 'code', 'server', 'log', 'api'];

/**
 * 「已挂载哪些资产」的诚实文案。
 * 0 个资产时**不得出现「已挂载」字样**：没有挂载就说没有，并告诉用户下一步该做什么。
 */
function mountingSentence(assets: MountedAsset[], tail = ''): string {
  if (assets.length === 0) {
    return '当前工作区尚未挂载资产。接入一个资产后，我才能给出带引用的结论。';
  }
  const rank = (type: string): number => {
    const index = MOUNT_ORDER.indexOf(type);
    return index < 0 ? MOUNT_ORDER.length : index;
  };
  /* 同名资产（dev / prod 两个 order_db）只报一次名字，否则会出现「order_db、order_db」这种废话；
   * 计数仍按真实资产条数，不因去重而少报。 */
  const names: string[] = [];
  for (const asset of [...assets].sort((a, b) => rank(a.type) - rank(b.type))) {
    if (!names.includes(asset.name)) names.push(asset.name);
  }
  const listed = names.length <= 3
    ? `${names.join('、')}（共 ${assets.length} 个资产）`
    : `${names.slice(0, 3).join('、')} 等 ${assets.length} 个资产`;
  return `已挂载${listed}。${tail}`;
}

/** 未接入模型时的统一说明文案（不再有任何结论或置信度）。 */
const DEGRADED_NOTICE = [
  '本次未调用大模型：服务端没有配置可用 Key（DEVWORK_API_KEY 或系统钥匙串），因此不会产出结论、置信度与产物。',
  '下面展示的是真实执行的只读工具结果与真实引用片段——它们来自本地索引与演示库，可以直接核对；结论需要你自己判断。',
  '要获得真正的分析结论，请在「设置 · 模型」里绑定 API Key，或配置 DEVWORK_LLM_PROVIDER / DEVWORK_LLM_BASE_URL / DEVWORK_LLM_MODEL。',
].join('\n');

/**
 * 规则化模拟 Agent：routing → plan → text → tool_call（真实执行） → citation（真实命中） → notice → done。
 * **永不产出 conclusion / artifact。**
 */
export class MockGateway implements LlmGateway {
  readonly kind: GatewayKind = 'mock';
  readonly modelName = '未接入模型';

  /**
   * fallbackReason：这条轨迹是「真网关调用失败后」的降级，而不是「压根没配 Key」。
   *
   * 两者长得一样但话不能一样说 —— 有 Key 却报「服务端没有配置可用 Key」是假的，
   * 用户会照着这句话去设置页白找一遍。
   */
  constructor(private readonly fallbackReason?: string) {}

  async *generate(ctx: GatewayContext): AsyncIterable<AgentEvent> {
    const intent = detectIntent(ctx.content);
    const template = TEMPLATES[intent] ?? TEMPLATES.general;
    const query = keywordQuery(ctx.content);
    /* 本工作区真实挂载了什么，是这段轨迹里所有"已挂载 X"文案的唯一来源。 */
    const assets = mountedAssetsOf(ctx.workspaceId);
    const hasLogAsset = assets.some((asset) => asset.type === 'log');

    yield {
      type: 'routing',
      intent,
      mountedAssets: assets.map((asset) => asset.id),
      model: this.fallbackReason ? '降级轨迹（模型调用失败）' : '未接入模型',
      degraded: true,
    };
    /* 步骤标题里若提到挂载某类资产，clean 态必须改成"尚未挂载"——
     * 否则计划卡第一行就在暗示"已经接好了一个生产库"。 */
    const steps = assets.length === 0
      ? template.steps.map((step) => (step.goal.includes('挂载')
        ? { ...step, goal: '识别意图（当前工作区尚未挂载资产）' }
        : step))
      : template.steps;
    yield { type: 'plan', intent, steps, degraded: true };
    /* 演示轨迹也给一张清单卡：让人先看清"长任务长什么样"。
     * 全部 pending —— 这几步并没有被执行过，标 done 就是假装。 */
    yield {
      type: 'todo',
      items: steps.map((step, index) => ({ id: `t${index + 1}`, title: step.goal, status: 'pending' })),
      degraded: true,
    };
    /* 正文里凡涉及"挂载了什么"，一律按当前工作区真实资产生成；
     * 其它模板不涉挂载，原样输出（它们没有对环境的断言）。 */
    yield {
      type: 'text',
      content: template.mountingTail !== undefined
        ? mountingSentence(assets, template.mountingTail)
        : template.text,
    };

    const citations: CitationSeed[] = [];
    for (const rawStep of template.tools) {
      /* 日志资产没挂载时，`fs_truncate_log /var/log/order-api/error.log` 指向的是一个
       * **不存在**的文件：给出这种具体命令等于编造现场。降级为示例，只说"需先挂载日志资产"。 */
      const step: ToolStep = rawStep.toolName === 'fs_truncate_log' && !hasLogAsset
        ? { ...rawStep, label: 'fs_truncate_log（示例）', args: '{"example":true}', sampleOnly: true }
        : rawStep;
      const args = step.args.replace('{{content}}', query);
      /* 写操作不做任何执行尝试：交给权限内核判 deny/suggest，这里只输出意图。
       * 这是 Mock 唯一"不真实"的地方，而且它不会假装成功——result 明确写未执行。 */
      if (step.write) {
        yield {
          type: 'tool_call',
          toolName: step.toolName,
          label: step.label,
          args,
          durationMs: 0,
          risk: step.risk,
          result: step.sampleOnly
            ? '示例命令 · 需先挂载日志资产（未执行）'
            : '未执行 · Agent 写操作由权限内核拦截，只生成建议',
          ok: false,
          write: true,
        };
        continue;
      }

      const startedAt = Date.now();
      const outcome = ctx.executeTool
        ? await ctx.executeTool(step.toolName, args)
        : { ok: false, result: '工具执行器不可用（服务端未注入 executeTool）', citations: [] as CitationSeed[] };
      if (outcome.citations) citations.push(...outcome.citations);
      yield {
        type: 'tool_call',
        toolName: step.toolName,
        label: step.label,
        args,
        durationMs: Date.now() - startedAt,
        risk: step.risk,
        result: outcome.result,
        ok: outcome.ok,
        write: false,
      };
    }

    /* 只把真实命中的片段作为引用抛出；没有命中就一条都不给。 */
    for (let index = 0; index < citations.length && index < 4; index += 1) {
      const cit = citations[index];
      yield {
        type: 'citation',
        id: `cit-${ctx.conversationId}-${index + 1}`,
        title: cit.title,
        source: cit.source,
        locator: cit.locator,
        snippet: cit.snippet,
        confidence: cit.confidence,
        version: cit.version,
        path: cit.path,
        startLine: cit.startLine,
        endLine: cit.endLine,
        kind: cit.kind,
      };
    }

    yield {
      type: 'notice',
      level: 'warn',
      title: this.fallbackReason ? '演示轨迹 · 模型调用失败后的降级' : '演示轨迹 · 未接入模型',
      content: this.fallbackReason
        ? [
          `本次大模型调用失败（原因见上方通知），因此没有结论、没有置信度、没有产物。`,
          '下面是真实执行的只读工具结果与真实引用片段 —— 它们来自本地索引，可以直接核对。',
          '修好模型配置后重发这一句即可拿到真正的分析结论。',
        ].join('\n')
        : DEGRADED_NOTICE,
    };
    yield { type: 'done', intent };
  }
}

/** OpenAI 兼容网关（B16 真实现）：SSE 流式 + 多轮上下文 + tool-calling 循环。
 *  失败自动退回规则化轨迹（同样不伪造结论）。 */
/**
 * 供应商 4xx/5xx 的正文往往直接写着原因（模型不存在 / Key 无效 / 余额不足 / 参数非法），
 * 只抛 `llm http 400` 会让用户对着一个状态码干瞪眼。把正文一起带出来。
 */
async function providerError(prefix: string, status: number, response: Response): Promise<Error> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 400).replace(/\s+/g, ' ').trim();
  } catch {
    /* 读不到正文时只报状态码，不掩盖原始错误 */
  }
  return new Error(detail ? `${prefix} http ${status}：${detail}` : `${prefix} http ${status}`);
}

export class OpenAiCompatibleGateway implements LlmGateway {
  readonly kind: GatewayKind = 'openai-compatible';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    /** 设置页「单任务 token 上限」(model.maxTokens)：>0 时作为 max_tokens 传给供应商。 */
    private readonly maxTokens = 0,
  ) {}

  get modelName(): string {
    return this.model;
  }

  /** 生效端点：诊断导出与「当前用的是哪个模型」需要它。 */
  get endpoint(): string {
    return this.baseUrl;
  }

  private systemPrompt(ctx: GatewayContext): string {
    const toolNames = (ctx.toolFace ?? []).map((tool) => tool.function.name);
    return [
      '你是 DevWork 的运维/研发分析 Agent。工具面由所在工作区的资产派生：',
      `- 可用工具：${toolNames.length > 0 ? toolNames.join(' / ') : 'pg_sql_query / kb_search / code_find'}；`,
      '- 只读工具直接调用；写工具（code_edit / fs_manage / db_query_write / srv_exec / fs_write_file）表达意图即可，',
      '  它们会生成审批卡，由用户批准后按 precheck→执行→校验→回滚 管线真执行，你不要虚构执行结果；',
      /* 写后的证据口径：工具已经给了改动片段，模型就不该再"凭记忆复述改了什么"；
       * 而 verify=通过 只证明落盘一致，把它当"改对了"是这套工具最贵的误读。 */
      '- 写工具返回的「改动片段」是可以当证据的改动描述，直接引它；片段以外的行就是没看到，不要顺手描述。',
      '  返回里 verify=通过 只表示落盘内容与预期一致，不表示改动正确——改对没改对要靠重放调用点',
      '  （code_find mode=refs 的前后对比）与 code_view(mode=outline) 看结构有没有被改坏；',
      '  返回「空操作」说明磁盘没有变化，不要说"已修改"；返回「新建文件，没有基线快照」时不要说能一键回滚；',
      '- 服务器运维操作只能用 srv_exec 表达意图（action 参数），模板库不支持的操作要明说不支持；',
      /* 合并工具的纪律：mode 是必填项。没有这条，模型会少传 mode 然后拿到一条报错，
       * 或者更糟——按默认值猜一个，于是"想找文件却搜了内容"。
       * 三个判据的语义差异（索引 / 磁盘正则 / 按名找文件 / 符号引用）必须点明，
       * 否则它会一直用最熟悉的那一个。 */
      '- 工具带 mode 时必须显式传：code_find 的 regex/glob/index/refs、code_view 的 content/outline/diff/status、',
      '  db_inspect 的 tables/schema/counts/explain、browser 的 navigate/read、skill 的 list/load、',
      '  code_edit 的 replace/rewrite、fs_manage 的 move/copy/mkdir/delete；',
      '- 找代码的顺序：先 code_find(mode=glob) 收敛范围 → 再 code_find(mode=regex 或 refs) 定位到行 →',
      '  最后 code_view(mode=content) 带 offset/limit 读上下文；',
      '  code_view 返回里写着「还有 N 行未读」时，不许对这个文件下整体结论——继续读，或明说只看过哪一段；',
      '  问"这次改了哪些文件"用 code_view(mode=status)（不用猜文件名）；单文件改动细节才用 mode=diff；',
      '  mode=diff 说「未追踪」时不是「没改」：新文件在 diff 里看不到内容，要改用 mode=content 读；',
      '  mode=diff 开头写着「共 N 个 hunk、本次展示多少」时同理：没展开的 hunk 也等于没看，',
      '  别把它当成「没改」——用 mode=content 按 @@ 行号补读，或者明说结论只覆盖了哪几段；',
      '  code_find(mode=index) 是索引检索，快但可能滞后于工作区：引用行号前用 mode=regex 或 code_view 复核；',
      '  查"这块代码为什么长这样"用 git_history（log/blame/show），它是唯一的历史证据来源；',
      /* 搜索与抓取的分工：搜索给候选，抓取给原文。混起来用就会拿摘要当原文引用。 */
      '- 需要外部资料：不知道去哪找时先 web_search 收敛候选，再 web_fetch 打开具体页面取原文；',
      '  只有 url 已知就直接 web_fetch。web_search 的摘要是二次加工，引用必须落到原文；',
      '  抓不到就如实说抓不到，不要用记忆里的内容代替页面内容；',
      /* 子代理：什么时候值得用、结论怎么用。不写清就会变成"什么活都丢给子代理"。 */
      '- 需要翻很多文件但结论很短时，用 subtask 派只读子代理（goal 必须自包含；它有调用次数上限）；',
      '  子代理的结论不是"你读到的"：关键结论要用 code_view 复核原文再写进最终回答；',
      '  简单问题不要开子代理——一次 code_find 就够的事，开子代理只是多一层延迟；',
      /* 技能两段式：清单轻、正文重。写清"先看后载"才不会有模型在轮次一开始就把所有正文拉进来。 */
      '- 遇到不熟悉的任务类型，先 skill(mode=list) 看有没有对应技能，再用 skill(mode=load, id=...) 取方法论并按其步骤执行；',
      '  一次只加载一个技能，加载了就要真的用（不要只在回复里提一句它的名字）；',
      /* 长任务的三条纪律：先拆步、事实落笔记、每步落地后回报。没有这条，10 步之后模型就忘了原始目标，
       * 而用户看到的只是一堆工具行，不知道现在做到哪了。上下文一压缩，"已经查过什么"最先消失。 */
      '- 长任务（预计超过 3 个动作）先调用 todo_write 拆成 3~7 步，再逐步执行；',
      '  每完成一步立刻调用 todo_write 回传完整清单并把该步标 done；卡住就标 blocked 并写 note，',
      '  不要为了"看起来完成"把没做的步骤标 done，也不要在一次调用里把所有步骤一次性标完成；',
      '- 查证得到的关键事实（不是进度）用 memo(mode=write) 记一条，例如"超时根因：索引缺失，EXPLAIN 已证实"；',
      '  上下文被压缩过之后，先 memo(mode=read) 取回再决定要不要重查——不要把已经查清的事再查一遍；',
      '- 结论必须给出置信度，引用检索到的证据时用 [1][2] 角标标注；',
      '- 检索结果为空时直接说"没有找到"，不要编造文件路径或行号。',
      `- 当前只读模式：${ctx.readOnlyMode ? '开启' : '关闭'}；挂载资产：${ctx.assetIds.join(', ') || '默认（生产库+运营知识库)'}。`,
      ctx.todoText ? `\n${ctx.todoText}` : '',
      '回答用简体中文，尽量简短、分点。',
    ].filter(Boolean).join('\n');
  }

  private toolsSpec(ctx: GatewayContext) {
    /* 派生工具面优先（按工作区资产动态计算）；没有则退回内置三个只读工具。 */
    if (ctx.toolFace && ctx.toolFace.length > 0) return ctx.toolFace;
    return [
      {
        type: 'function',
        function: {
          name: 'pg_sql_query',
          description: '对生产库执行只读 SQL（仅 SELECT/WITH/EXPLAIN，自动加 LIMIT），返回行数与采样结果。',
          parameters: {
            type: 'object',
            properties: { sql: { type: 'string', description: '只读 SQL 语句' } },
            required: ['sql'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'kb_search',
          description: '在运营知识库索引中检索文档片段（FTS5 全文检索），返回标题/位置/片段/相关度。',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: '检索关键词' } },
            required: ['query'],
          },
        },
      },
      {
        /* 静态兜底也要用正式名：没有派生面时模型仍会拿它去调，
         * 给旧名等于让"工具面为空"这条路径永远测不到归一逻辑。 */
        type: 'function',
        function: {
          name: 'code_find',
          description: '定位代码：mode=index 走索引检索，mode=regex 在磁盘上按正则精确定位（带行号）。',
          parameters: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['index', 'regex'], description: 'index=索引检索；regex=磁盘正则' },
              pattern: { type: 'string', description: '检索关键词或正则' },
            },
            required: ['mode', 'pattern'],
          },
        },
      },
    ];
  }

  /**
   * 上下文压缩用的摘要（一次性、非流式）。
   * 失败直接抛：调用方会退回规则提炼并在摘要卡上标 source='rule'，
   * 把「模型没答上来」写成一张空摘要卡才是最坏的结果。
   */
  async summarize(transcript: string, maxChars = 900): Promise<{ text: string; source: 'model'; model: string }> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: [
              '你在压缩一段 Agent 与用户的对话上下文，供后续轮次继续工作。',
              '只保留仍然有用的信息：用户目标、已确认的结论、已完成的动作、未决问题与约束条件。',
              '不要复述工具调用的过程细节，不要编造没有发生的结论。',
              '输出简洁的中文要点（每行一条），不写寒暄。',
            ].join(''),
          },
          { role: 'user', content: `把下面这段对话压缩成不超过 ${maxChars} 字的中文要点：\n\n${transcript}` },
        ],
        temperature: 0.2,
        max_tokens: Math.max(200, Math.min(1200, Math.round(maxChars / 1.2))),
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw await providerError('llm summarize', response.status, response);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = String(data.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('llm summarize 空回复');
    return { text: text.slice(0, maxChars), source: 'model', model: this.model };
  }

  async *generate(ctx: GatewayContext): AsyncIterable<AgentEvent> {
    let text = '';
    try {
      yield { type: 'routing', intent: detectIntent(ctx.content), mountedAssets: mountedAssetsOf(ctx.workspaceId).map((asset) => asset.id), model: this.model };

      const messages: Record<string, unknown>[] = [
        { role: 'system', content: this.systemPrompt(ctx) },
        ...(ctx.history ?? []).slice(-12),
        { role: 'user', content: ctx.content },
      ];
      const citations: CitationSeed[] = [];
      let providerUsage: { promptTokens: number; completionTokens: number } | null = null;
      /* 思考模式会先吃掉一大截输出预算：max_tokens 太小时 content 还没开始写就被
       * finish_reason=length 截断，表现为「模型回了但一个字都没有」。撞上就放大重试。 */
      let maxTokens = this.maxTokens;
      let escalated = 0;
      let lastFinish = '';
      /* 工具轮上限：4 轮时，稍复杂一点的代码问题会「一直查资料、没来得及写结论」，
       * 最后一轮照样 finish=tool_calls，正文永远空 —— 用户看到的就是「llm 空回复」。 */
      const MAX_ROUNDS = 8;
      let toolsEnabled = true;
      let nudged = false;

      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const lastRound = round === MAX_ROUNDS - 1;
        if (lastRound && !nudged) {
          /* 最后一轮剥夺工具并明说要结论：否则模型会继续调用工具，把轮次耗干。 */
          toolsEnabled = false;
          nudged = true;
          messages.push({
            role: 'user',
            content: '（系统）工具调用轮次已用完：本轮不要再调用任何工具，直接用中文写出最终结论。',
          });
        }
        const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages,
            ...(toolsEnabled ? { tools: this.toolsSpec(ctx) } : {}),
            stream: true,
            ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
            /* 让供应商在最后一帧带上真实 usage；不支持的实现会忽略该字段，
             * 那样就落到 estimate 分支并在 notice 里说明「用量为估算」。 */
            stream_options: { include_usage: true },
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) throw await providerError('llm', response.status, response);
        if (!response.body) throw new Error('llm 响应无正文流');

        /* 解析 SSE：增量文本直接以 text_delta 转发；tool_calls 增量按 index 聚合。 */
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finish = '';
        let roundText = '';
        /* 思考模式的思维链：必须原样回传给下一轮，否则 DeepSeek 直接 400。 */
        let roundReasoning = '';
        const toolCalls: { index: number; name: string; args: string }[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n');
          buffer = parts.pop() ?? '';
          for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;
            let chunk: {
              choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            try { chunk = JSON.parse(data); } catch { continue; }
            if (chunk.usage && typeof chunk.usage.prompt_tokens === 'number') {
              providerUsage = {
                promptTokens: Number(chunk.usage.prompt_tokens),
                completionTokens: Number(chunk.usage.completion_tokens ?? 0),
              };
            }
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (delta?.reasoning_content) {
              roundReasoning += delta.reasoning_content;
            }
            if (delta?.content) {
              roundText += delta.content;
              text += delta.content;
              yield { type: 'text_delta', content: delta.content };
            }
            if (delta?.tool_calls) {
              delta.tool_calls.forEach((tc) => {
                const index = Number(tc.index ?? 0);
                const existing = toolCalls.find((item) => item.index === index);
                if (!existing) {
                  toolCalls.push({ index, name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' });
                } else {
                  if (tc.function?.name) existing.name = tc.function.name;
                  if (tc.function?.arguments) existing.args += tc.function.arguments;
                }
              });
            }
            if (choice?.finish_reason) finish = choice.finish_reason;
          }
        }

        /* 每轮把真实回包形状落一行日志：再出「空回复」时能直接看出是截断、
         * 空 delta 还是工具轮 —— 不用再猜。 */
        lastFinish = finish;
        console.log(
          `[llm] round=${round} finish=${finish || '(none)'} text=${roundText.length}`
          + ` reasoning=${roundReasoning.length} tools=${toolCalls.length} maxTokens=${maxTokens}`,
        );

        if (finish === 'length' && !roundText.trim() && toolCalls.length === 0 && escalated < 3) {
          const before = maxTokens;
          maxTokens = Math.min(65536, Math.max(16384, maxTokens * 2));
          escalated += 1;
          yield {
            type: 'notice',
            level: 'info',
            title: '思考模式占满输出上限，已放大 max_tokens 重试',
            content: `本轮被 finish_reason=length 截断（${before} tokens 全被思考吃掉，正文还没开始）。已自动提高到 ${maxTokens} 重试。`,
          };
          /* 不消耗轮次预算：这一轮等于没产出。 */
          round -= 1;
          continue;
        }

        if (finish === 'tool_calls' && toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: roundText || null,
            /* DeepSeek 思考模式的硬性要求：带 tool_calls 的 assistant 消息必须把
             * 本轮 reasoning_content 一起回传，否则下一轮 400
             * 「The `reasoning_content` in the thinking mode must be passed back to the API」。 */
            ...(roundReasoning ? { reasoning_content: roundReasoning } : {}),
            tool_calls: toolCalls.map((tc) => ({
              id: `call_${tc.index}`, type: 'function',
              function: { name: tc.name, arguments: tc.args || '{}' },
            })),
          });
          for (const tc of toolCalls) {
            const executor = ctx.executeTool;
            const startedAt = Date.now();
            const outcome = executor
              ? await executor(tc.name, tc.args || '{}')
              : { ok: false, result: '工具执行器不可用' };
            if (outcome.citations) citations.push(...outcome.citations);
            yield {
              type: 'tool_call',
              toolName: tc.name,
              args: tc.args || '{}',
              durationMs: Date.now() - startedAt,
              /* 风险与写属性来自登记表，不能让"模型自己声明自己是低风险"。 */
              risk: toolRisk(tc.name),
              result: outcome.result,
              ok: outcome.ok,
              write: toolIsWrite(tc.name),
            };
            messages.push({ role: 'tool', tool_call_id: `call_${tc.index}`, content: outcome.result.slice(0, 4000) });
          }
          continue; // 带着工具结果进入下一轮流式生成
        }

        /* finish=stop：最终回答已流完。 */
        break;
      }

      if (!text.trim()) {
        throw new Error(
          `llm 空回复：模型跑完了 ${MAX_ROUNDS} 轮，正文依旧为空（最后一次 finish=${lastFinish || '(none)'}，maxTokens=${maxTokens}）。`
          + '若 finish=length，说明思考模式把输出预算吃光了；若 finish=(none)，说明供应商回的是空流。',
        );
      }

      /* 引用事件：来自真实 kb_search / code_find 命中，与结论 [n] 角标顺序对应。 */
      const cited = citations.slice(0, 4);
      const citeIds = cited.map((_cit, index) => `cit-${ctx.conversationId}-${index + 1}`);
      for (let index = 0; index < cited.length; index += 1) {
        const cit = cited[index];
        yield {
          type: 'citation',
          id: `cit-${ctx.conversationId}-${index + 1}`,
          title: cit.title,
          source: cit.source,
          locator: cit.locator,
          snippet: cit.snippet,
          confidence: cit.confidence,
          version: cit.version,
          path: cit.path,
          startLine: cit.startLine,
          endLine: cit.endLine,
          kind: cit.kind,
        };
      }

      /* 用量：有供应商 usage 就用真值，否则标注为估算。 */
      yield providerUsage
        ? { type: 'usage', promptTokens: providerUsage.promptTokens, completionTokens: providerUsage.completionTokens, model: this.model, source: 'provider' }
        : { type: 'usage', promptTokens: estimateTokens(messages.map((m) => JSON.stringify(m)).join('').length), completionTokens: estimateTokens(text.length), model: this.model, source: 'estimate' };

      yield {
        type: 'conclusion',
        /* 模型不会返回一个可信的置信度数字，就不写数字。
         * 硬编 0.90 是拿一个看起来专业的假数字骗用户。 */
        confidence: '未提供',
        citationIds: citeIds,
        content: text.slice(0, 400),
        paras: text.split('\n\n').map((para) => parseCiteParagraph(para.trim())).filter((p) => p.length > 0),
      };
      yield { type: 'done', intent: detectIntent(ctx.content) };
    } catch (error) {
      /* 网络失败 / 空回复 → 退回规则化轨迹。降级本身要显式告知，不能静默。 */
      const reason = error instanceof Error ? error.message : String(error);
      yield {
        type: 'notice',
        level: 'warn',
        title: '模型调用失败，已降级为演示轨迹',
        content: `原因：${reason.slice(0, 200)}\n本次调用：${this.baseUrl.replace(/\/$/, '')}/chat/completions · model=${this.model}\n降级后不会产出结论，只给出真实工具执行结果。`,
      };
      const fallback = new MockGateway(reason);
      for await (const event of fallback.generate(ctx)) yield event;
    }
  }
}

/** 把模型文本中的一段解析成 InlineSeg 段落，[n] 角标转 cite。 */
function parseCiteParagraph(para: string): Record<string, string>[] {
  const segments: Record<string, string>[] = [];
  const pattern = /\[(\d)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(para)) !== null) {
    if (match.index > lastIndex) segments.push({ t: 'text', v: para.slice(lastIndex, match.index) });
    segments.push({ t: 'cite', id: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < para.length) segments.push({ t: 'text', v: para.slice(lastIndex) });
  return segments;
}

/** 手写解析 server/.env（最多 10 行，忽略注释与空行）。前端永不可见。 */
function readEnvFile(): Record<string, string> {
  const result: Record<string, string> = {};
  const file = path.join(SERVER_ROOT, '.env');
  if (!fs.existsSync(file)) return result;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 10);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index < 1) return;
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
  });
  return result;
}

export const LLM_KEY_REF = 'vault/llm-api-key';

/* ---------------- 用户自配置（C1）：预设主流供应商，配置存 DB，Key 存钥匙串 ---------------- */

/** 主流供应商预设：选预设自动带出端点与推荐模型；custom / ollama 允许全手填。 */
export interface LlmPreset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  /** Key 的申请入口，UI 展示用。 */
  keyUrl: string;
  /** 本地端点（Ollama / vLLM）无需 Key。 */
  local?: boolean;
}

/**
 * 仅收录 OpenAI 兼容端点（网关按 /chat/completions 调用，不兼容的供应商无法接入）。
 *
 * models 数组只是**离线兜底推荐**——模型名写死在代码里必然过时。
 * 真正的模型列表以 `fetchLlmModels()` 从端点 GET /models 实拉的为准；
 * LiteLLM 网关类预设干脆留空（models: []），列表完全随网关走。
 */
export const LLM_PRESETS: LlmPreset[] = [
  {
    id: 'deepseek', label: 'DeepSeek（深度求索）',
    /* 2026-11 起 DeepSeek 只认 deepseek-flash / deepseek-v4-pro，deepseek-chat 与
     * deepseek-reasoner 已下线：拿旧名字调 /chat/completions 会被判 400 Model Not Exist。
     * 这里的列表只是离线兜底，点「拉取模型列表」以端点实拉为准。 */
    baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen', label: '通义千问 Qwen（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'glm', label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'kimi', label: 'Kimi（月之暗面 Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1', models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'doubao', label: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115'],
    keyUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'openai', label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic', label: 'Anthropic（Claude · OpenAI 兼容端点）',
    baseUrl: 'https://api.anthropic.com/v1', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'ollama', label: '本地 Ollama（无需 Key）',
    baseUrl: 'http://localhost:11434/v1', models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b'],
    keyUrl: 'https://ollama.com/library', local: true,
  },
  {
    id: 'litellm', label: 'LiteLLM 网关（自部署 · 一个 Key 走所有上游）',
    baseUrl: 'http://localhost:4000/v1', models: [],
    keyUrl: 'https://docs.litellm.ai/docs/proxy/quick_start',
  },
  {
    id: 'custom', label: '自定义（OpenAI 兼容端点）',
    baseUrl: '', models: [],
    keyUrl: '',
  },
];

export interface LlmRuntimeConfig {
  provider: string;
  baseUrl: string;
  model: string;
  /** db = 设置页配置；env = 环境变量/.env 兜底；none = 两者皆无。 */
  source: 'db' | 'env' | 'none';
}

/* ───────────────────────── 模型配置档案（多模型） ───────────────────────── */

/**
 * 一条模型档案 = 一个模型 + 它自己的端点 + 它自己的 Key。
 *
 * 为什么是"档案"而不是"模型名列表"：预设里同时有 DeepSeek、OpenAI、本地 Ollama，
 * 它们的端点和 Key 互不相同。只记模型名、共用一套端点的做法，跨供应商根本不成立。
 */
export interface LlmProfile {
  id: string;
  /** 用户给这条档案起的名字，列表里显示它。 */
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  /** 本地端点（Ollama / vLLM）无需 Key。 */
  local: boolean;
}

/** 档案的对外视图：附带 Key 状态，只回布尔与来源，绝不回显明文。 */
export interface LlmProfileView extends LlmProfile {
  keyConfigured: boolean;
  keySource: 'keychain' | 'env' | 'none';
}

/** 档案 Key 的钥匙串引用。每个档案一把钥匙，互不串味。 */
export function llmProfileKeyRef(profile: LlmProfile): string {
  /* 老库的单条配置的 Key 一直存在 vault/llm-api-key，保持原地不动，
   * 升级后不必迁移也能继续用。 */
  return profile.id === 'legacy' ? LLM_KEY_REF : `${LLM_KEY_REF}/${profile.id}`;
}

function normalizeProfiles(input: unknown): LlmProfile[] {
  if (!Array.isArray(input)) return [];
  const out: LlmProfile[] = [];
  const seen = new Set<string>();
  input.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? '').trim();
    const baseUrl = String(row.baseUrl ?? '').trim();
    const model = String(row.model ?? '').trim();
    /* 端点与模型名缺一不可 —— 档案不完整就不该出现在列表里。 */
    if (!id || !baseUrl || !model || seen.has(id)) return;
    seen.add(id);
    const provider = String(row.provider ?? 'custom').trim() || 'custom';
    const preset = LLM_PRESETS.find((p) => p.id === provider);
    out.push({
      id,
      label: String(row.label ?? '').trim() || model,
      provider,
      baseUrl,
      model,
      local: row.local === true || preset?.local === true,
    });
  });
  return out;
}

/**
 * 生效的档案列表。
 *
 * 优先读 setting.model.llmProfiles；老库（只有单条 llmBaseUrl/llmModel）
 * 合成一条 'legacy' 返回 —— 这样升级后设置页立刻能看到已有模型，
 * 而不是退回一片空白。
 */
export async function llmProfileList(): Promise<LlmProfile[]> {
  let raw: Record<string, unknown> = {};
  try {
    raw = await settingRaw('model');
  } catch {
    return [];
  }
  const stored = normalizeProfiles(raw.llmProfiles);
  if (stored.length > 0) return stored;
  const baseUrl = String(raw.llmBaseUrl ?? '').trim();
  const model = String(raw.llmModel ?? '').trim();
  if (!baseUrl || !model) return [];
  const provider = String(raw.llmProvider ?? 'custom').trim() || 'custom';
  const preset = LLM_PRESETS.find((p) => p.id === provider);
  return [{
    id: 'legacy',
    label: preset ? preset.label : model,
    provider,
    baseUrl,
    model,
    local: preset?.local === true,
  }];
}

/** 当前生效的档案 id：显式指定优先，否则取列表第一条。 */
export async function llmActiveProfileId(): Promise<string> {
  const stored = await settingRaw('model');
  const explicit = String(stored.llmActiveId ?? '').trim();
  const list = await llmProfileList();
  if (explicit && list.some((p) => p.id === explicit)) return explicit;
  return list[0]?.id ?? '';
}

/** 当前生效的档案。 */
export async function llmActiveProfile(): Promise<LlmProfile | null> {
  const list = await llmProfileList();
  if (list.length === 0) return null;
  const activeId = await llmActiveProfileId();
  return list.find((p) => p.id === activeId) ?? list[0];
}

/**
 * 写档案列表与当前生效 id。
 * 同时镜像 llmProvider/llmBaseUrl/llmModel —— 老读取方（状态栏、诊断、网关兜底）
 * 仍按这三个字段工作，镜像后不必全链路改造。
 */
export async function saveLlmProfiles(profiles: LlmProfile[], activeId: string): Promise<void> {
  const raw = { ...(await settingRaw('model')) };
  raw.llmProfiles = profiles.map((p) => ({
    id: p.id, label: p.label, provider: p.provider, baseUrl: p.baseUrl, model: p.model, local: p.local,
  }));
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];
  raw.llmActiveId = active?.id ?? '';
  if (active) {
    raw.llmProvider = active.provider;
    raw.llmBaseUrl = active.baseUrl;
    raw.llmModel = active.model;
  } else {
    delete raw.llmProvider;
    delete raw.llmBaseUrl;
    delete raw.llmModel;
  }
  run('UPDATE setting SET raw = ? WHERE section = ?', JSON.stringify(raw), 'model');
}

/** 用户自配置的模型参数：当前档案优先，env/.env 兜底（老用户升级不炸）。 */
export async function llmRuntimeConfig(): Promise<LlmRuntimeConfig> {
  let provider = '';
  let baseUrl = '';
  let model = '';
  let source: LlmRuntimeConfig['source'] = 'none';
  try {
    const active = await llmActiveProfile();
    if (active) {
      provider = active.provider;
      baseUrl = active.baseUrl;
      model = active.model;
      source = 'db';
    }
  } catch {
    /* DB 尚未初始化（极早期调用）→ 继续走 env 兜底。 */
  }
  if (source !== 'db') {
    const file = readEnvFile();
    provider = process.env.DEVWORK_LLM_PROVIDER ?? file.DEVWORK_LLM_PROVIDER ?? '';
    baseUrl = process.env.DEVWORK_LLM_BASE_URL ?? file.DEVWORK_LLM_BASE_URL ?? '';
    model = process.env.DEVWORK_LLM_MODEL ?? file.DEVWORK_LLM_MODEL ?? '';
    if (baseUrl && model) source = 'env';
    else source = 'none';
  }
  return { provider, baseUrl, model, source };
}

/**
 * API Key 解析：先按引用取钥匙串密文，再回落 env/.env。
 *
 * 刻意**不**让非 legacy 档案回落全局钥匙串 `vault/llm-api-key`：
 * 那会把 A 供应商的 Key 发给 B 供应商。档案没有自己的 Key 就是没有。
 */
export async function resolveLlmApiKey(ref: string = LLM_KEY_REF): Promise<{ apiKey: string; source: 'keychain' | 'env' | 'none' }> {
  const keychainKey = await loadSecret(ref);
  if (keychainKey) return { apiKey: keychainKey, source: 'keychain' };
  const file = readEnvFile();
  const envKey = process.env.DEVWORK_API_KEY ?? file.DEVWORK_API_KEY ?? '';
  if (envKey) return { apiKey: envKey, source: 'env' };
  return { apiKey: '', source: 'none' };
}

/** 某条档案的 Key 状态（只回布尔与来源）。 */
export async function llmProfileKeyStatus(profile: LlmProfile): Promise<{ configured: boolean; source: 'keychain' | 'env' | 'none' }> {
  const { apiKey, source } = await resolveLlmApiKey(llmProfileKeyRef(profile));
  return { configured: Boolean(apiKey), source };
}

/** 非流式最小请求做连通性测试：真实打一发，不做任何 mock。 */
export async function testLlmConnection(input: {
  baseUrl: string; apiKey: string; model: string;
}): Promise<{ ok: boolean; latencyMs: number; model: string; message: string }> {
  const startedAt = Date.now();
  const base = input.baseUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: '回复"ok"两个字母即可' }],
        max_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(20000),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false, latencyMs, model: input.model,
        message: `HTTP ${response.status}${detail ? ` · ${detail.slice(0, 180)}` : ''}`,
      };
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const reply = String(data.choices?.[0]?.message?.content ?? '').trim();
    return { ok: true, latencyMs, model: input.model, message: reply.slice(0, 80) || '连接成功' };
  } catch (error) {
    return {
      ok: false, latencyMs: Date.now() - startedAt, model: input.model,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 从 OpenAI 兼容端点实拉模型列表（GET /models）。
 *
 * 为什么要有它：模型名写死在预设里必然过时（gpt-4o / moonshot-v1 这批就是教训），
 * 而端点不会变。列表以端点为准——LiteLLM 网关加了新模型，这里自动跟着出现，零维护。
 * 拉取失败不装死：回落预设静态推荐并如实标注「可能过时」。
 */
export interface LlmModelList {
  models: string[];
  /** live = 端点实拉；fallback = 预设静态兜底（拉取失败 / 端点未填）。 */
  source: 'live' | 'fallback';
  message: string;
}

export async function fetchLlmModels(input: {
  baseUrl: string;
  apiKey?: string;
  provider?: string;
  profileId?: string;
}): Promise<LlmModelList> {
  const provider = (input.provider ?? '').trim();
  const preset = LLM_PRESETS.find((p) => p.id === provider);
  const fallbackModels = [...(preset?.models ?? [])];
  const base = (input.baseUrl ?? '').trim().replace(/\/+$/, '') || (preset?.baseUrl ?? '').replace(/\/+$/, '');
  if (!base) {
    return { models: fallbackModels, source: 'fallback', message: '未填写 API 端点，无法实拉模型列表' };
  }
  /* Key 解析顺序与连通性测试一致：表单输入 > 档案钥匙串 > env。
   * 不带 Key 也照发 —— Ollama 与未设 master key 的 LiteLLM 网关不需要鉴权。 */
  let apiKey = (input.apiKey ?? '').trim();
  if (!apiKey && input.profileId) {
    const profiles = await llmProfileList();
    const profile = profiles.find((p) => p.id === input.profileId);
    if (profile) apiKey = (await resolveLlmApiKey(llmProfileKeyRef(profile))).apiKey;
  }
  if (!apiKey) {
    apiKey = (await resolveLlmApiKey()).apiKey;
  }
  try {
    const response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        models: fallbackModels, source: 'fallback',
        message: `端点返回 HTTP ${response.status}${detail ? ` · ${detail.slice(0, 120)}` : ''}，已回落预设推荐（可能过时）`,
      };
    }
    const data = (await response.json()) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] };
    /* OpenAI 形状是 data[].id；个别网关回 models[]，id / name 都认。 */
    const raw = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const models = [...new Set(raw.map((m) => String(m?.id ?? m?.name ?? '').trim()).filter(Boolean))].sort();
    if (models.length === 0) {
      return { models: fallbackModels, source: 'fallback', message: '端点未返回任何模型，已回落预设推荐（可能过时）' };
    }
    return { models, source: 'live', message: `实拉 ${models.length} 个模型` };
  } catch (error) {
    return {
      models: fallbackModels, source: 'fallback',
      message: `端点拉取失败：${error instanceof Error ? error.message : String(error)}，已回落预设推荐（可能过时）`,
    };
  }
}

/**
 * 工厂（B19 → C1）：配置优先级 —— 设置页（DB）> env/.env；Key 钥匙串 > env。
 *
 * modelOverride：会话级模型覆盖（输入框模型切换器）。它**只改本次调用**用的模型，
 * 不动全局配置。多档案下它的含义是「这次用哪条档案」：按模型名找到对应档案，
 * 连同该档案自己的端点与 Key 一起用 —— 而不是拿全局端点去套一个陌生模型名。
 *
 * 覆盖也造不出模型 —— 没有端点或没有 Key 时照样退回 MockGateway，
 * 由前端如实显示「未接入模型」。
 */
export async function createGateway(modelOverride?: string): Promise<LlmGateway> {
  const override = modelOverride?.trim();
  const profiles = await llmProfileList();
  const activeId = await llmActiveProfileId();
  /* 当前档案优先被匹配（同名模型时用正在生效的那条），其次取第一条同名档案。 */
  let target = profiles.find((p) => p.id === activeId) ?? profiles[0];
  if (override) {
    const hit = profiles.find((p) => p.id === activeId && p.model === override)
      ?? profiles.find((p) => p.model === override);
    if (hit) target = hit;
  }
  if (target) {
    const { apiKey } = await resolveLlmApiKey(llmProfileKeyRef(target));
    /* 本地端点（Ollama / vLLM）不需要 Key —— 有端点就能真连，不该退化成 Mock。 */
    if (apiKey || target.local) {
      const model = override || target.model;
      /* 单任务 token 上限（model.maxTokens / 设置页）：无效值一律按 0 处理。 */
      const rawMax = Number((await settingRaw('model')).maxTokens ?? 0);
      const maxTokens = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 0;
      return new OpenAiCompatibleGateway(target.baseUrl, apiKey, model, maxTokens);
    }
  }
  /* 兜底：没有档案时的老路径（env/.env 单条配置）。 */
  const cfg = await llmRuntimeConfig();
  const { apiKey } = await resolveLlmApiKey();
  const model = override || cfg.model;
  if (cfg.baseUrl && apiKey && model) {
    /* 单任务 token 上限（model.maxTokens / 设置页 m3）：无效值一律按 0 处理。 */
    const rawMax = Number((await settingRaw('model')).maxTokens ?? 0);
    const maxTokens = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 0;
    return new OpenAiCompatibleGateway(cfg.baseUrl, apiKey, model, maxTokens);
  }
  return new MockGateway();
}

/** Key 配置状态（只回状态与来源，绝不回显明文）。 */
export async function llmKeyStatus(): Promise<{ configured: boolean; source: 'keychain' | 'env' | 'none' }> {
  const keychain = await loadSecret(LLM_KEY_REF);
  if (keychain) return { configured: true, source: 'keychain' };
  const file = readEnvFile();
  const envKey = process.env.DEVWORK_API_KEY ?? file.DEVWORK_API_KEY ?? '';
  if (envKey) return { configured: true, source: 'env' };
  return { configured: false, source: 'none' };
}

/** 把 Key 写入本机钥匙串（safeStorage 密文）；不可用则如实降级、不落盘。 */
export async function setLlmKey(secret: string, ref: string = LLM_KEY_REF): Promise<{ stored: boolean; mode: 'safeStorage' | 'none' }> {
  return storeSecret(ref, secret);
}
