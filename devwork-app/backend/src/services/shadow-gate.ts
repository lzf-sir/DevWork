/**
 * ShadowGate —— 影子链路的第一层：确定性准入。
 *
 * 为什么必须是纯函数：Gate 是整套架构里唯一「错了会一直错」的环节。
 * 它有状态就不可复现，不可复现就数不出误判率。所以这里不查库、不读 clock、
 * 不调模型 —— 所有事实由调用方准备好传进来（与 DeepSeek 的 stateless Eval 同一条思路）。
 *
 * 判定顺序不可调换（每一档都在防一个具体的失效模式）：
 *   ① 源关闭        —— 主动源默认 off，开了才谈接单
 *   ② 空事件        —— 空白消息不该进决策账本，否则分母永远是脏的
 *   ③ 机器人        —— 机器人只能产生「候选」，永远不能产生「明确请求」
 *   ④ 人 + 白名单   —— 这才是 explicit 的唯一来源
 *   ⑤ 人不在白名单  —— 默认不接（宁可漏接，不可自作主张）
 *   ⑥ 频控          —— 自动化事件同线程一小时内重复，挡掉但不丢记录（人不受限）
 *   ⑦ 准入模式      —— off / observe / auto 只影响 inferred
 *
 * 「挡掉但要留记录」是刻意的：影子期要量的不是「最终接了几单」，
 * 而是「本来会接几单、又被什么挡掉了」。所以 admitted=false 时也必须落 decision。
 */

export type AcceptMode = 'off' | 'observe' | 'auto';
export type Strength = 'explicit' | 'inferred';

/** 命中一条规则，意味着「最多允许动多大范围」。P2 的 Mandate 直接照抄它。 */
export interface RuleScope {
  /** 允许的动作名（与工具登记表的 action 对齐）。 */
  actions: string[];
  /** 风险上限：超过它的动作即使命中规则也不在授权范围内。 */
  riskCeiling: 'low' | 'medium' | 'high';
  /** 允许的写操作次数上限。0 = 纯只读。 */
  maxWrites: number;
}

export interface ShadowRule {
  id: string;
  name: string;
  enabled: boolean;
  /** 命中任一关键词即认为「这活该接」。空数组 = 不看关键词。 */
  keywords: string[];
  /** 只看这些资产类型；空数组 = 不限。 */
  assetTypes?: string[];
  /**
   * 这条规则愿意给出的授权范围。
   *
   * 为什么范围必须写在规则上、而不是让模型临时推断：授权范围是「人可以预期的东西」。
   * 让人每次都审一段模型现编的范围，等于没审。规则是数据，范围跟着规则走，改一次
   * 就能看到它对所有新工单的影响。
   */
  scope?: RuleScope;
}

export interface ShadowPolicy {
  acceptMode: AcceptMode;
  allowedActors: string[];
  allowedBots: string[];
  /** 同一线程每小时的决策上限。1 = 一小时内只研判一次，其余挡掉留痕。 */
  threadRatePerHour: number;
  /**
   * auto 模式下每小时最多自动签发几份授权。
   *
   * 为什么 auto 必须有预算：它是唯一一条「无人点头也能开工」的路径。
   * 没有上限，一个刷屏的日志源就能在一小时内签出几十张授权、建出几十张工单，
   * 而人只会在第二天早上看到账单和一堆被改过的文件。
   */
  autoMaxPerHour: number;
  /**
   * auto 是否允许自动签发「有写权限」的范围。默认 false。
   *
   * 这是整套授权模型里最该保守的开关：打开它意味着系统可以在
   * 没有任何人看过的前提下改代码。默认关闭；需要它的场景
   * （比如 CI 自动修 lint）应单独配规则、单独开。
   */
  autoAllowWrites: boolean;
  rules: ShadowRule[];
  policyVersion: string;
}

export interface GateFacts {
  sourceEnabled: boolean;
  sourceKind: string;
  actor: string;
  actorKind: 'person' | 'bot' | 'system';
  addressed: boolean;
  body: string;
  payloadKeys: string[];
  /** 该线程最近一小时已有的决策数（由调用方查库后传入）。 */
  recentDecisions: number;
}

export interface GateVerdict {
  admitted: boolean;
  /** admitted=false 时仍保留强度：便于统计「被挡掉的 explicit」。 */
  strength: Strength;
  reasonCode: string;
  reason: string;
}

function deny(strength: Strength, reasonCode: string, reason: string): GateVerdict {
  return { admitted: false, strength, reasonCode, reason };
}

/**
 * Gate 主体。返回 admitted=true 只代表「有权进入研判」，
 * 不代表「会接单」——接不接由规则匹配（assessRules）决定。
 */
export function gate(facts: GateFacts, policy: ShadowPolicy): GateVerdict {
  const strengthOf = (): Strength => 'inferred';

  /* ① 源未启用。主动源（log / schedule / ci / sql）默认关闭，
   * 打开是操作者的显式动作，不是 Agent 的自我授权。 */
  if (!facts.sourceEnabled) {
    return deny(strengthOf(), 'E_SOURCE_DISABLED', `事件源 ${facts.sourceKind} 未启用`);
  }

  /* ② 空事件。payload 里有结构字段（如 CI 结果）时不看正文。 */
  if (facts.body.trim() === '' && facts.payloadKeys.length === 0) {
    return deny(strengthOf(), 'E_EMPTY_TRIGGER', '正文与载荷皆空，不进入研判');
  }

  /* ③ 机器人 / 系统事件。
   * 「机器人永远不能产生明确请求」是授权模型的地基：否则给 dependabot 一个
   * 提权口子，等于把白名单交给上游仓库。
   * 频控也从这里开始生效 —— 只为自动化事件而设（见 rateLimit 的注释）。 */
  if (facts.actorKind === 'bot') {
    const listed = policy.allowedBots.some((bot) => bot.toLowerCase() === facts.actor.toLowerCase());
    if (!listed) {
      return deny('inferred', 'E_BOT_NOT_ALLOWED', `机器人 ${facts.actor} 不在允许列表`);
    }
    return rateLimit('inferred', policy, facts, 'E_BOT_INFERRED', `机器人 ${facts.actor} 产生候选`);
  }

  if (facts.actorKind === 'system') {
    /* CI 结果这类没有发送者的事件：按候选处理，不按人处理。 */
    return rateLimit('inferred', policy, facts, 'E_SYSTEM_INFERRED', '系统事件（无发送者）产生候选');
  }

  /* ④ 人 + 白名单 + 点名 → explicit。这是唯一能绕过 acceptMode 的路径。
   * 人不受频控：一小时内问五件事是五件事，不是噪音。 */
  const listed = policy.allowedActors.some((person) => person.toLowerCase() === facts.actor.toLowerCase());
  if (listed && facts.addressed) {
    return checkMode('explicit', policy, 'E_EXPLICIT_REQUEST', `${facts.actor} 明确请求`);
  }
  if (listed) {
    return checkMode('inferred', policy, 'E_LISTED_FOLLOWUP', `${facts.actor} 在白名单内但未点名（跟进）`);
  }

  /* ⑤ 人不在白名单：默认不接。点名也不行 —— 否则白名单形同虚设。
   * 这条与「宁可漏接」一致：要接就先把人加进白名单，这是操作者的动作。 */
  if (facts.addressed) {
    return deny('inferred', 'E_UNLISTED_ADDRESSED', `${facts.actor} 不在白名单（即使点名也不接）`);
  }
  return deny('inferred', 'E_UNLISTED_UNADDRESSED', `${facts.actor} 不在白名单且未点名`);
}

/**
 * 频控：同一线程一小时内的第一条照常研判，其余挡掉留痕。
 *
 * **只约束自动化事件**（机器人 / 系统）。人在一小时里问五件事，那是五件事，
 * 不是噪音——把人的请求也限流，会让「一天会接几单」这个数字系统性偏低，
 * 而 P1 存在的唯一理由就是把这个数字量准。（这条是 P1.5 接真实负载后改的：
 * 原本对所有人限流，接上真实对话才发现会把同一个会话的后续请求全挡掉。）
 *
 * 为什么「挡掉」而不是「不落库」：日志源一报错就是几百条，
 * 直接丢弃就看不到这个源的真实事件量级，也就无法判断阈值该设多少。
 */
function rateLimit(
  strength: Strength,
  policy: ShadowPolicy,
  facts: GateFacts,
  reasonCode: string,
  reason: string,
): GateVerdict {
  if (facts.recentDecisions >= policy.threadRatePerHour) {
    return deny(
      strength,
      'E_THREAD_RATE_LIMIT',
      `同线程一小时内已研判 ${facts.recentDecisions} 次（上限 ${policy.threadRatePerHour}）：${reasonCode}`,
    );
  }
  return checkMode(strength, policy, reasonCode, reason);
}

/** ⑦ 准入模式只约束 inferred；explicit 在任何模式下都放行。 */
function checkMode(
  strength: Strength,
  policy: ShadowPolicy,
  reasonCode: string,
  reason: string,
): GateVerdict {
  if (strength === 'inferred' && policy.acceptMode === 'off') {
    return deny('inferred', 'E_MODE_OFF', `准入模式 off，推断类候选不进入研判（${reasonCode}）`);
  }
  return { admitted: true, strength, reasonCode, reason };
}

/**
 * 规则匹配：判断「这活值不值得接」。
 *
 * 与旧 detectIntent() 的区别：那套正则写在代码里，改一个词要发版；
 * 这里是数据（setting.superagent.rules），操作者改设置即可，且每条规则
 * 在 decision.matched_rules 里留痕——「为什么接了这单」可回溯。
 */
export function matchRules(rules: ShadowRule[], text: string, assetType = ''): string[] {
  const haystack = text.toLowerCase();
  return rules
    .filter((rule) => {
      if (!rule.enabled) return false;
      if (rule.assetTypes && rule.assetTypes.length > 0 && assetType) {
        if (!rule.assetTypes.includes(assetType)) return false;
      }
      if (rule.keywords.length === 0) return true;
      return rule.keywords.some((keyword) => keyword.trim() !== '' && haystack.includes(keyword.toLowerCase()));
    })
    .map((rule) => rule.id);
}

/** 默认策略：白名单空 = 谁都不接。安全默认，配人之后才开始量。 */
export const DEFAULT_POLICY: ShadowPolicy = {
  acceptMode: 'observe',
  allowedActors: ['本机用户'],
  allowedBots: [],
  threadRatePerHour: 1,
  autoMaxPerHour: 3,
  autoAllowWrites: false,
  policyVersion: 'pol-1',
  rules: [
    {
      id: 'rule-metrics',
      name: '指标归因',
      enabled: true,
      keywords: ['gmv', '口径', '归因', '同比', '下降', 'metrics'],
      assetTypes: ['db', 'kb'],
      /* 归因只读：查库 + 检索口径文档，一个字都不写。 */
      scope: {
        actions: ['sql.query.read', 'kb.search.read', 'asset.read'],
        riskCeiling: 'low',
        maxWrites: 0,
      },
    },
    {
      id: 'rule-incident',
      name: '故障排查',
      enabled: true,
      keywords: ['报错', '超时', '故障', '慢查询', 'qps', '排查', 'error', 'timeout'],
      assetTypes: ['log', 'db', 'code', 'server'],
      /* 排查需要看日志 / 慢查询 / 代码，但仍然只读——
       * 「看一眼」和「动手改」必须分成两张授权，否则排查会自动带着改的权限。 */
      scope: {
        actions: ['log.read', 'sql.query.read', 'code.read', 'code.search.read', 'cmd.exec.read'],
        riskCeiling: 'low',
        maxWrites: 0,
      },
    },
    {
      id: 'rule-review',
      name: '代码审查',
      enabled: true,
      keywords: ['审查', 'review', '补丁', 'patch', 'pr '],
      assetTypes: ['code'],
      /* 审查允许落补丁，但只在中风险、最多 5 次写——审查不是重构。 */
      scope: {
        actions: ['code.read', 'code.search.read', 'file.read', 'file.write', 'patch.apply'],
        riskCeiling: 'medium',
        maxWrites: 5,
      },
    },
  ],
};
