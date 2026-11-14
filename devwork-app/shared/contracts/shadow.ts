/**
 * 影子链路写入契约（P1）。
 *
 * 只覆盖写入侧：注入事件、改策略、开关源。
 * 读侧形状由后端 `decisionShape` / `shadowStats` 稳定产出，不在契约层重复声明。
 *
 * 为什么事件注入也要 zod：这是唯一能往决策账本里塞数据的入口，
 * 形状一松，影子期的统计就全是脏数——而 P1 的全部价值就是这些数字。
 */
import { z } from 'zod';

/** 七类事件源。与 backend/src/services/shadow-scheduler.ts 的 SOURCE_CATALOG 一一对应。 */
export const SOURCE_KINDS = ['user', 'terminal', 'git', 'sql', 'log', 'schedule', 'ci'] as const;
export const ACCEPT_MODES = ['off', 'observe', 'auto'] as const;
export const ACTOR_KINDS = ['person', 'bot', 'system'] as const;

/** 注入一条外部事件（用于度量 Gate 噪音；P1 不接 ConversationService）。 */
export const shadowTriggerSchema = z.object({
  workspaceId: z.string().max(80).optional(),
  sourceKind: z.enum(SOURCE_KINDS).default('user'),
  /** 源内稳定键：会话 id / 文件路径 / issue 号。缺省 inbox。 */
  threadKey: z.string().max(200).optional(),
  threadTitle: z.string().max(200).optional(),
  /** 事件所属资产：决定授权范围的 assets。缺省 = 范围未定（不能授权）。 */
  assetId: z.string().max(80).optional(),
  actor: z.string().trim().min(1, 'actor 不能为空').max(120),
  actorKind: z.enum(ACTOR_KINDS).default('person'),
  addressed: z.boolean().default(false),
  body: z.string().max(8000).default(''),
  payload: z.record(z.unknown()).optional(),
  /** 幂等键：同一外部事件重复投递只留一条。 */
  idemKey: z.string().min(1).max(200).optional(),
  receivedAt: z.string().max(40).optional(),
});
export type ShadowTriggerInput = z.infer<typeof shadowTriggerSchema>;

/**
 * 改策略。
 *
 * acceptMode 是 P1 里唯一有「语义」的开关：
 *   off      —— 推断类候选不进研判（只留 explicit 记录）
 *   observe  —— 默认值，研判但不接单
 *   auto     —— P1 里与 observe 等价（都只记录）；真正生效在 P3
 * 这样设计是为了让操作者能先看数据再「拧旋钮」，而不是上线当天就选好。
 */
export const shadowPolicySchema = z.object({
  acceptMode: z.enum(ACCEPT_MODES).optional(),
  allowedActors: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  allowedBots: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  threadRatePerHour: z.number().int().min(1).max(24).optional(),
  /** auto 每小时最多签发几份。0 = 完全关闭自动签发（auto 退化成 observe）。 */
  autoMaxPerHour: z.number().int().min(0).max(20).optional(),
  /** 是否允许 auto 签发「有写权限」的范围。默认 false，改它要显式传 true。 */
  autoAllowWrites: z.boolean().optional(),
  rules: z.array(z.object({
    id: z.string().min(1).max(80),
    name: z.string().max(80).optional(),
    enabled: z.boolean().optional(),
    keywords: z.array(z.string().trim().max(80)).max(30).optional(),
    assetTypes: z.array(z.string().trim().max(40)).max(10).optional(),
    /* scope 必须过契约：丢了它，规则就只剩关键词，
     * 而授权范围全靠它 —— 表现是「决策照常，但草案永远发不出来」。 */
    scope: z.object({
      actions: z.array(z.string().trim().min(1).max(80)).min(1).max(30),
      riskCeiling: z.enum(['low', 'medium', 'high']).optional(),
      maxWrites: z.number().int().min(0).max(99).optional(),
    }).optional(),
  })).max(50).optional(),
});
export type ShadowPolicyInput = z.infer<typeof shadowPolicySchema>;

/** 定时源的调度配置。只有 schedule 源认这些字段，其余源原样忽略。 */
export const shadowScheduleSchema = z.object({
  schedule: z.enum(['daily', 'interval']).optional(),
  /** daily 用：HH:MM（本地时区，1~2 位小时）。 */
  at: z.string().regex(/^\d{1,2}:\d{2}$/, 'at 需为 HH:MM').optional(),
  /** interval 用：5 分钟 ~ 7 天。低于 5 分钟只会被频控反复挡掉，没有意义。 */
  everyMinutes: z.number().int().min(5).max(10080).optional(),
  prompt: z.string().max(2000).optional(),
});
export type ShadowScheduleInput = z.infer<typeof shadowScheduleSchema>;

/** 开关事件源。主动源默认关闭，打开是操作者的显式动作。 */
export const shadowSourceSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
  enabled: z.boolean(),
  schedule: shadowScheduleSchema.optional(),
});
export type ShadowSourceInput = z.infer<typeof shadowSourceSchema>;

/**
 * 人对授权草案表态。
 *
 * narrowed 时传 actions = 想保留的动作；服务端只会**取交集**，
 * 传进来原本没有的动作会被丢弃 —— 收窄不是提权的后门。
 */
export const shadowMandateReviewSchema = z.object({
  status: z.enum(['accepted', 'narrowed', 'rejected']),
  note: z.string().max(500).optional(),
  actions: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
});
export type ShadowMandateReviewInput = z.infer<typeof shadowMandateReviewSchema>;

/** 总开关：关掉之后两个循环只空转，不读不写。 */
export const shadowEnabledSchema = z.object({
  enabled: z.boolean(),
});
export type ShadowEnabledInput = z.infer<typeof shadowEnabledSchema>;

/** 回答工单的提问。answer 是人的原话，不再二次加工。 */
export const ticketAnswerSchema = z.object({
  attentionId: z.string().min(1).max(80),
  answer: z.string().trim().min(1, '回答不能为空').max(2000),
});
export type TicketAnswerInput = z.infer<typeof ticketAnswerSchema>;

/** 立即触发一次（面板「立即巡检」/ 测试）：等价于「假装现在到点了」。 */
export const shadowFireSchema = z.object({
  kind: z.enum(SOURCE_KINDS),
});
export type ShadowFireInput = z.infer<typeof shadowFireSchema>;
