/**
 * 「这一步它到底看到了什么」—— 把会话消息流折叠成**按轮次分组的步骤链**。
 *
 * 为什么不在面板里直接遍历 messages：
 *   上下文面板要回答的是一个结构化问题 ——「第 2 轮用了 3 步、花了 4.2 秒、
 *   卡在哪个工具上」。直接铺消息卡只能回答「模型说了什么」，
 *   而「哪一步开始变慢 / 哪一步要人批」需要先有「轮 / 步」这层结构。
 *
 * 口径上的一条硬规矩：**token 只显示真值**。
 *   只有服务端在轮末卡片上带了 usage 才算数；其余一律 null，
 *   面板显示「—」而不是拿字符数估一个好看的数。
 */
import type { Message } from '../api/client';

export type StepStatus = 'ok' | 'warn' | 'deny' | 'run' | 'wait';

export interface ContextStep {
  id: string;
  /** 步骤类型：决定图标与配色（工具 / 计划 / 待批 / 建议 / 产物 / 回复 / 提示）。 */
  kind: 'tool' | 'plan' | 'approval' | 'suggestion' | 'artifact' | 'answer' | 'notice';
  /** 主标题：工具名 / 计划意图 / 命令首行。 */
  label: string;
  /** 副标题：状态 · 耗时 · 参数摘要。 */
  meta: string[];
  status: StepStatus;
}

export interface ContextTurn {
  /** 轮次序号（从 1 开始，按用户提问计）。 */
  index: number;
  /** 该轮的用户提问（过长会截断显示，原文仍在会话里）。 */
  ask: string;
  /** 该轮 @ 到 / 绑定的资产标签。 */
  chips: string[];
  steps: ContextStep[];
  /** 该轮服务端回传的 token 真值；没有就是 null（不估）。 */
  tokens: { prompt: number | null; completion: number } | null;
  /** 该轮工具调用累计耗时（毫秒），用于一眼看出「哪轮变慢」。 */
  toolMs: number;
  /** 该轮是否仍在生成（流式中）。 */
  running: boolean;
}

/** 从 "312ms" / "1.2s" 这类展示字符串里抠出毫秒数；抠不出就当 0。 */
function parseMs(raw: string): number {
  const text = String(raw ?? '').trim();
  if (!text) return 0;
  const num = Number.parseFloat(text);
  if (!Number.isFinite(num)) return 0;
  return /s$/i.test(text) && !/ms$/i.test(text) ? Math.round(num * 1000) : Math.round(num);
}

/** 命令取首行并截断：待审批卡里往往是整段 shell，面板只要一眼能认出来的那截。 */
function firstLine(raw: string, max = 64): string {
  const line = String(raw ?? '').split(/\r?\n/)[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** 工具状态 → 步骤状态（服务端给的是中文展示词，这里只做语义收敛）。 */
function toolStatus(status: string, statusCls?: 'ok' | 'warn' | 'deny' | 'suggest'): StepStatus {
  if (statusCls === 'deny') return 'deny';
  if (statusCls === 'warn') return 'warn';
  if (statusCls === 'suggest') return 'wait';
  if (/失败|超时|拒绝/.test(status)) return 'warn';
  if (/待|等/.test(status)) return 'wait';
  return 'ok';
}

/**
 * 把消息流折叠成轮次步骤链。
 *
 * @param messages 当前会话的全部卡片（@ 前端 Message 联合类型）
 * @param streaming 该会话正在流式输出时为已收到的增量文本（否则 null）
 */
export function buildContextTurns(messages: Message[], streaming: string | null): ContextTurn[] {
  const turns: ContextTurn[] = [];
  const push = (turn: ContextTurn): void => {
    turns.push(turn);
  };

  const current = (): ContextTurn => {
    const last = turns[turns.length - 1];
    if (last) return last;
    /* 会话开头就有助手卡（欢迎语 / 系统提示）：补一个「开场」轮，别让这些步骤无处可归。 */
    const opening: ContextTurn = {
      index: 1,
      ask: '（开场）',
      chips: [],
      steps: [],
      tokens: null,
      toolMs: 0,
      running: false,
    };
    push(opening);
    return opening;
  };

  messages.forEach((message) => {
    if (message.kind === 'user') {
      push({
        index: turns.length + 1,
        ask: message.text,
        chips: message.chips ?? [],
        steps: [],
        tokens: null,
        toolMs: 0,
        running: false,
      });
      return;
    }
    const turn = current();
    if (message.usage) {
      turn.tokens = {
        prompt: typeof message.usage.promptTokens === 'number' ? message.usage.promptTokens : null,
        completion: typeof message.usage.completionTokens === 'number' ? message.usage.completionTokens : 0,
      };
    }
    switch (message.kind) {
      case 'tool': {
        const ms = parseMs(message.ms);
        turn.toolMs += ms;
        turn.steps.push({
          id: message.id,
          kind: 'tool',
          label: message.name,
          meta: [message.status, message.ms].filter(Boolean),
          status: toolStatus(message.status, message.statusCls),
        });
        return;
      }
      case 'plan':
        turn.steps.push({
          id: message.id,
          kind: 'plan',
          label: message.intent || '执行计划',
          meta: [
            `${message.steps.length} 步`,
            message.degraded ? '降级计划' : '',
          ].filter(Boolean),
          status: message.degraded ? 'warn' : 'ok',
        });
        return;
      case 'approval':
        turn.steps.push({
          id: message.id,
          kind: 'approval',
          label: firstLine(message.cmd),
          meta: [
            message.resolved ? '已裁决' : '待人裁决',
            message.risk ? `风险 ${message.risk}` : '',
            message.hasPlan ? '可执行' : '',
          ].filter(Boolean),
          status: message.resolved ? 'ok' : 'wait',
        });
        return;
      case 'suggestion':
        turn.steps.push({
          id: message.id,
          kind: 'suggestion',
          label: firstLine(message.cmd),
          meta: ['已拦截 · 转建议'],
          status: 'deny',
        });
        return;
      case 'artifact':
        turn.steps.push({
          id: message.id,
          kind: 'artifact',
          label: message.name,
          meta: [message.meta].filter(Boolean),
          status: 'ok',
        });
        return;
      case 'notice':
        turn.steps.push({
          id: message.id,
          kind: 'notice',
          label: message.title,
          meta: [message.level === 'warn' ? '警告' : '提示'],
          status: message.level === 'warn' ? 'warn' : 'ok',
        });
        return;
      case 'text':
      case 'conclusion':
        /* 回复本身也是一步：它是「看完全部上下文之后说了什么」的终点。 */
        turn.steps.push({
          id: message.id,
          kind: 'answer',
          label: '回复',
          meta: [message.kind === 'conclusion' ? `置信度 ${message.confidence}` : ''],
          status: 'ok',
        });
        return;
      default:
        return;
    }
  });

  /* 流式增量：它是「正在进行的最后一步」，必须显式标 run，
   * 否则面板会显示「已完成」，与用户眼前的打字动画自相矛盾。 */
  if (streaming && streaming.length > 0) {
    const turn = current();
    turn.running = true;
    turn.steps.push({
      id: 'step-streaming',
      kind: 'answer',
      label: '正在生成',
      meta: [`已收 ${streaming.length} 字符`],
      status: 'run',
    });
  }

  return turns;
}

/** 面板顶部汇总：轮数 / 步数 / 工具总耗时 / token 合计（只加真值）。 */
export function summarizeTurns(turns: ContextTurn[]): {
  turns: number;
  steps: number;
  toolMs: number;
  tokens: number;
  hasTokenTruth: boolean;
} {
  let steps = 0;
  let toolMs = 0;
  let tokens = 0;
  let hasTokenTruth = false;
  turns.forEach((turn) => {
    steps += turn.steps.length;
    toolMs += turn.toolMs;
    if (turn.tokens) {
      hasTokenTruth = true;
      tokens += (turn.tokens.prompt ?? 0) + turn.tokens.completion;
    }
  });
  return { turns: turns.length, steps, toolMs, tokens, hasTokenTruth };
}
