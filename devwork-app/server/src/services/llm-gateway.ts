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
import { run } from '../db/database';
import { toolIsWrite, toolRisk } from '../config/tools';

/** 没有供应商 usage 时的本地估算（字符数 / 1.5 ≈ token 数，仅用于兜底，不是真值）。 */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 1.5));
}

export type GatewayKind = 'mock' | 'openai-compatible';

export type AgentEvent =
  | { type: 'routing'; intent: string; mountedAssets: string[]; model: string; degraded?: boolean }
  | { type: 'plan'; intent: string; steps: { goal: string; durationMs: number }[]; degraded?: boolean }
  | { type: 'text'; content: string }
  | { type: 'text_delta'; content: string }
  /** level=warn 用于降级说明（未接入模型 / 模型调用失败），UI 需常驻可见。 */
  | { type: 'notice'; level: 'info' | 'warn'; title: string; content: string }
  | {
      type: 'tool_call';
      toolName: string;
      /** 卡片展示名（可写「kb_search + code_search」这类组合说明）。 */
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
}

interface Template {
  steps: { goal: string; durationMs: number }[];
  text: string;
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
    text: '已挂载生产库与运营知识库。先按只读方式核对订单状态分布，再检索口径文档。',
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
        toolName: 'code_search',
        label: 'code_search',
        args: '{"query":"setConnectTimeout"}',
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
        toolName: 'code_search',
        label: 'code_search',
        args: '{"query":"setConnectTimeout"}',
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
        toolName: 'code_search',
        label: 'code_search',
        args: '{"query":"{{content}}"}',
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

  async *generate(ctx: GatewayContext): AsyncIterable<AgentEvent> {
    const intent = detectIntent(ctx.content);
    const template = TEMPLATES[intent] ?? TEMPLATES.general;
    const query = keywordQuery(ctx.content);

    yield { type: 'routing', intent, mountedAssets: ['a-order-db-prod', 'a-kb'], model: '未接入模型', degraded: true };
    yield { type: 'plan', intent, steps: template.steps, degraded: true };
    yield { type: 'text', content: template.text };

    const citations: CitationSeed[] = [];
    for (const step of template.tools) {
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
          result: '未执行 · Agent 写操作由权限内核拦截，只生成建议',
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

    yield { type: 'notice', level: 'warn', title: '演示轨迹 · 未接入模型', content: DEGRADED_NOTICE };
    yield { type: 'done', intent };
  }
}

/** OpenAI 兼容网关（B16 真实现）：SSE 流式 + 多轮上下文 + tool-calling 循环。
 *  失败自动退回规则化轨迹（同样不伪造结论）。 */
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
      `- 可用工具：${toolNames.length > 0 ? toolNames.join(' / ') : 'pg_sql_query / kb_search / code_search'}；`,
      '- 只读工具直接调用；写工具（code_edit / db_query_write / srv_exec / fs_write_file）表达意图即可，',
      '  它们会生成审批卡，由用户批准后按 precheck→执行→校验→回滚 管线真执行，你不要虚构执行结果；',
      '- 服务器运维操作只能用 srv_exec 表达意图（action 参数），模板库不支持的操作要明说不支持；',
      '- 结论必须给出置信度，引用检索到的证据时用 [1][2] 角标标注；',
      '- 检索结果为空时直接说"没有找到"，不要编造文件路径或行号。',
      `- 当前只读模式：${ctx.readOnlyMode ? '开启' : '关闭'}；挂载资产：${ctx.assetIds.join(', ') || '默认（生产库+运营知识库)'}。`,
      '回答用简体中文，尽量简短、分点。',
    ].join('\n');
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
        type: 'function',
        function: {
          name: 'code_search',
          description: '在代码库 order-service 索引中检索代码片段。',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      },
    ];
  }

  async *generate(ctx: GatewayContext): AsyncIterable<AgentEvent> {
    let text = '';
    try {
      yield { type: 'routing', intent: detectIntent(ctx.content), mountedAssets: ['a-order-db-prod', 'a-kb'], model: this.model };

      const messages: Record<string, unknown>[] = [
        { role: 'system', content: this.systemPrompt(ctx) },
        ...(ctx.history ?? []).slice(-12),
        { role: 'user', content: ctx.content },
      ];
      const citations: CitationSeed[] = [];
      let providerUsage: { promptTokens: number; completionTokens: number } | null = null;

      for (let round = 0; round < 4; round += 1) {
        const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({
            model: this.model,
            messages,
            tools: this.toolsSpec(ctx),
            stream: true,
            ...(this.maxTokens > 0 ? { max_tokens: this.maxTokens } : {}),
            /* 让供应商在最后一帧带上真实 usage；不支持的实现会忽略该字段，
             * 那样就落到 estimate 分支并在 notice 里说明「用量为估算」。 */
            stream_options: { include_usage: true },
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok || !response.body) throw new Error(`llm http ${response.status}`);

        /* 解析 SSE：增量文本直接以 text_delta 转发；tool_calls 增量按 index 聚合。 */
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finish = '';
        let roundText = '';
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
              choices?: { delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
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

        if (finish === 'tool_calls' && toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: roundText || null,
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

      if (!text.trim()) throw new Error('llm 空回复');

      /* 引用事件：来自真实 kb_search/code_search 命中，与结论 [n] 角标顺序对应。 */
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
        content: `原因：${reason.slice(0, 200)}\n降级后不会产出结论，只给出真实工具执行结果。`,
      };
      const fallback = new MockGateway();
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
    baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'],
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
