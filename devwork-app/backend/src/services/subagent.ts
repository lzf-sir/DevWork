/**
 * Subagent —— 把"大范围搜证"挪出主上下文。
 *
 * 为什么需要它：主循环的上下文是稀缺资源。一次"这个超时是哪里设的"的排查可能要
 * 翻 15 个文件，如果全发生在主上下文里，20 轮之后模型记得的是**文件名**，不是
 * 用户的问题。子代理把这段过程关在一个独立上下文里，只把结论回传。
 *
 * 四条硬约束（每一条都是为了不让子代理变成"另一个会说谎的地方"）：
 *
 * 1. **只读**。子面由调用方裁剪，但这里仍要再挡一次：任何写意图直接拒绝。
 *    权限不能只依赖"调用方记得裁剪"。
 * 2. **不可递归**。子面里不含 subtask 自身，否则一个任务能炸成 N 个子任务。
 * 3. **无模型就不跑**。没有真模型时网关会返回演示轨迹 —— 那段轨迹是编的。
 *    这里宁可明确拒绝，也不把演示内容包装成"子代理的调研结论"。
 * 4. **预算可数**。工具调用次数与总时长都是硬上限，用尽就如实标 exhausted，
 *    并且**不把用尽当成完成** —— 半程结论要写清"没查完"。
 */
import { createGateway } from './llm-gateway';
import { normalizeToolCall } from '../config/tool-catalog';
import type { GatewayContext, ToolExecutionResult } from './llm-gateway';

/** 子代理回传的摘要上限：超过这个长度就不是"摘要"了，而是把上下文又搬了回来。 */
const SUMMARY_MAX_CHARS = 3000;

/** 子代理默认预算：12 次工具调用 / 90 秒。够查一个小问题，不够跑一整个仓库。 */
const DEFAULT_MAX_TOOL_CALLS = 12;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface SubagentTask {
  /** 交给子代理的任务描述（要自包含：它看不到主对话历史）。 */
  goal: string;
  workspaceId: string;
  /** 主会话 id：子代理的工具调用仍记在这个会话下，审计能串起来。 */
  conversationId: string;
  /** 只读工具子面（含 JSON Schema）。调用方负责剔除写工具与 subtask 自身。 */
  tools: NonNullable<GatewayContext['toolFace']>;
  /** 只读执行器。 */
  executeTool: (name: string, argsJson: string) => Promise<ToolExecutionResult>;
  maxToolCalls?: number;
  timeoutMs?: number;
}

export interface SubagentOutcome {
  ok: boolean;
  /** 子代理的结论（已截断）。失败时为空串。 */
  summary: string;
  toolCalls: number;
  /** 实际用到的工具名（去重后按首次出现顺序）。 */
  toolsUsed: string[];
  /** 撞到预算上限（结论可能不完整）。 */
  exhausted: boolean;
  /** 没有结论时的原因；成功且有告警时也写在这里。 */
  note: string;
}

/**
 * 跑一个只读子循环，返回结论摘要。
 *
 * 注意：这里刻意**不**把子代理的中间工具行回传。原因不是省 token，而是
 * 「主模型看到子代理的 15 条工具行」会让它以为自己也查过了 —— 于是它开始
 * 引用自己没读过的文件。摘要必须是一段**可独立成立**的文字。
 */
export async function runSubagent(task: SubagentTask): Promise<SubagentOutcome> {
  const goal = task.goal.trim();
  if (!goal) {
    return {
      ok: false, summary: '', toolCalls: 0, toolsUsed: [], exhausted: false,
      note: 'goal 为空：子代理需要一个自包含的任务描述（它看不到主对话历史）。',
    };
  }
  if (task.tools.length === 0) {
    return {
      ok: false, summary: '', toolCalls: 0, toolsUsed: [], exhausted: false,
      note: '当前工作区没有可用于子代理的只读工具，无法执行调研。',
    };
  }

  const gateway = await createGateway();
  /* 演示轨迹不是调研结论。这一条拒绝是整套设计里最不能省的分支：
   * 把 MockGateway 的输出当成子代理的调研结果回传，等于用系统自己的模板冒充事实。 */
  if (gateway.kind === 'mock') {
    return {
      ok: false, summary: '', toolCalls: 0, toolsUsed: [], exhausted: false,
      note: '未接入模型：子代理需要真实模型才能执行；没有模型时它只会返回演示轨迹，那是编造，已拒绝执行。'
        + '请先用 code_find / code_view / db_query 自己分步查证，或到设置页接入模型。',
    };
  }

  const maxToolCalls = task.maxToolCalls && task.maxToolCalls > 0 ? task.maxToolCalls : DEFAULT_MAX_TOOL_CALLS;
  const timeoutMs = task.timeoutMs && task.timeoutMs > 0 ? task.timeoutMs : DEFAULT_TIMEOUT_MS;
  const allowed = new Set(task.tools.map((tool) => tool.function.name));
  const startedAt = Date.now();

  let calls = 0;
  const used: string[] = [];
  let exhausted = false;
  let exhaustReason = '';

  const guarded: NonNullable<GatewayContext['executeTool']> = async (rawName, argsJson) => {
    /* 归一后再判白名单：模型可能用旧名（code_read）来调，子面里只有正式名。 */
    const name = normalizeToolCall(rawName, {}).name;
    if (!allowed.has(name)) {
      return {
        ok: false,
        result: `子代理不可使用工具 ${rawName}：子代理只有只读工具面（${[...allowed].join(' / ')}）。`
          + '任何写操作都必须回到主流程走审批。',
      };
    }
    if (calls >= maxToolCalls) {
      exhausted = true;
      exhaustReason = `工具调用预算用尽（${maxToolCalls} 次）`;
      return { ok: false, result: `${exhaustReason}：请基于**已经查到的内容**给出结论，并明确写出哪部分没查完。` };
    }
    if (Date.now() - startedAt > timeoutMs) {
      exhausted = true;
      exhaustReason = `执行超时（${Math.round(timeoutMs / 1000)}s）`;
      return { ok: false, result: `${exhaustReason}：请立即基于已查到的内容收敛结论，并说明未完成部分。` };
    }
    calls += 1;
    if (!used.includes(name)) used.push(name);
    return task.executeTool(rawName, argsJson);
  };

  let text = '';
  const warnings: string[] = [];
  try {
    for await (const event of gateway.generate({
      conversationId: task.conversationId,
      workspaceId: task.workspaceId,
      content: subagentPrompt(goal),
      assetIds: [],
      readOnlyMode: true,
      /* 关键：history 为空。子代理不继承主对话，它只知道自己被问的那一句。 */
      history: [],
      toolFace: task.tools,
      executeTool: guarded,
    })) {
      if (event.type === 'text_delta' || event.type === 'text') text += event.content;
      else if (event.type === 'conclusion' && !text.trim()) text = event.content;
      else if (event.type === 'notice' && event.level === 'warn') warnings.push(event.title);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, summary: '', toolCalls: calls, toolsUsed: used, exhausted,
      note: `子代理执行失败（真实错误）：${message}`,
    };
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return {
      ok: false, summary: '', toolCalls: calls, toolsUsed: used, exhausted,
      note: `子代理跑完了 ${calls} 次工具调用但没有产出结论${warnings.length > 0 ? `（告警：${warnings.join('；')}）` : ''}。`,
    };
  }

  return {
    ok: true,
    summary: trimmed.length > SUMMARY_MAX_CHARS ? `${trimmed.slice(0, SUMMARY_MAX_CHARS)}\n（摘要已截断）` : trimmed,
    toolCalls: calls,
    toolsUsed: used,
    exhausted,
    note: [
      exhausted ? `${exhaustReason}：结论可能不完整，缺口见摘要里的说明。` : '',
      warnings.length > 0 ? `执行告警：${warnings.join('；')}` : '',
    ].filter(Boolean).join(' '),
  };
}

/** 子代理的系统提示由 content 承载：它没有主提示词，这段就是它的全部上下文。 */
function subagentPrompt(goal: string): string {
  return [
    '【子任务】你是一个只读调研子代理。主对话看不到你的过程，只能看到你的最终回复。',
    '',
    '要求：',
    '1. 只做只读查证，任何修改都不要做（你也没有写工具）；',
    '2. 先用 code_find(mode=glob|regex) 或 db_inspect 收敛范围，再 code_view(mode=content) 读关键片段，不要一上来就整文件读；',
    '3. 结论必须带证据：`文件:行号` 或 `表.列` 或工具命中原文；没有证据就写"未确认"，不要推测成事实；',
    '4. 最后用一段**可独立成立**的文字回答（主对话只会拿走这段文字），格式：',
    '   - 结论（1~3 条，每条带证据）',
    '   - 未确认的部分（如果有）',
    '   - 建议下一步（如果有）',
    '',
    `任务：${goal}`,
  ].join('\n');
}
