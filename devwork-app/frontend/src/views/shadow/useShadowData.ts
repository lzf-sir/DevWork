/**
 * 影子中心的数据层：一次加载，三个分区共用。
 *
 * 为什么做成 hook 而不是三个分区各自拉数据：
 *   KPI 要用 stats，工单列表要用 tickets，账本要用 decisions ——
 *   同一个 tick 里它们必须来自**同一时刻的快照**，否则会出现
 *   「KPI 说 5 张待研判，列表里只有 3 张」这种自相矛盾的界面。
 *
 * 所有写操作也集中在这里：三个分区只读 data，不自己调 api。
 * 这样「切模式之后顺便刷新详情」这种联动只写一遍。
 */
import React from 'react';
import { useStore } from '../../store';
import {
  api,
  type ShadowDecision,
  type ShadowMandate,
  type ShadowPolicy,
  type ShadowStats,
  type ShadowStatus,
  type ShadowTicket,
  type ShadowTrigger,
  type TicketDetail,
  type TicketStats,
} from '../../api/client';
import { SCHEDULE_PRESETS } from './labels';

export interface ShadowData {
  status: ShadowStatus | null;
  stats: ShadowStats | null;
  decisions: ShadowDecision[];
  triggers: ShadowTrigger[];
  mandates: ShadowMandate[];
  tickets: ShadowTicket[];
  ticketStats: TicketStats | null;
  loading: boolean;

  /* 详情 */
  detail: TicketDetail | null;
  detailId: string;
  detailLoading: boolean;
  openDetail: (id: string) => void;
  closeDetail: () => void;

  /* 交互态 */
  ticking: boolean;
  firing: boolean;
  ticketBusy: string;
  answers: Record<string, string>;
  setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  narrowing: string | null;
  keptActions: string[];
  setNarrowing: React.Dispatch<React.SetStateAction<string | null>>;
  setKeptActions: React.Dispatch<React.SetStateAction<string[]>>;

  /* 操作 */
  load: () => Promise<void>;
  runTick: () => Promise<void>;
  setMode: (mode: ShadowPolicy['acceptMode']) => Promise<void>;
  toggleRule: (id: string) => Promise<void>;
  toggleSource: (kind: string, enabled: boolean) => Promise<void>;
  saveList: (field: 'allowedActors' | 'allowedBots', next: string[]) => Promise<void>;
  promptAdd: (field: 'allowedActors' | 'allowedBots') => void;
  removeFrom: (field: 'allowedActors' | 'allowedBots', name: string) => void;
  setAuto: (patch: { autoMaxPerHour?: number; autoAllowWrites?: boolean }) => Promise<void>;
  setRate: (value: number) => Promise<void>;
  applySchedule: (value: string) => Promise<void>;
  fireNow: () => Promise<void>;
  review: (id: string, status: 'accepted' | 'narrowed' | 'rejected', actions?: string[]) => Promise<void>;
  runTicketAction: (
    id: string,
    action: () => Promise<{ ok: boolean; error?: { message?: string } | null }>,
    done: string,
  ) => Promise<void>;
  answerTicket: (ticket: ShadowTicket) => Promise<void>;
  toggleEnabled: () => Promise<void>;
  exportCsv: () => Promise<void>;
  stepLoop: () => Promise<void>;
}

const POLL_MS = 5000;

export function useShadowData(): ShadowData {
  const { state, addToast, setModal, refreshWaiting } = useStore();

  const [status, setStatus] = React.useState<ShadowStatus | null>(null);
  const [stats, setStats] = React.useState<ShadowStats | null>(null);
  const [decisions, setDecisions] = React.useState<ShadowDecision[]>([]);
  const [triggers, setTriggers] = React.useState<ShadowTrigger[]>([]);
  const [mandates, setMandates] = React.useState<ShadowMandate[]>([]);
  const [tickets, setTickets] = React.useState<ShadowTicket[]>([]);
  const [ticketStats, setTicketStats] = React.useState<TicketStats | null>(null);
  const [loading, setLoading] = React.useState(false);

  const [detail, setDetail] = React.useState<TicketDetail | null>(null);
  const [detailId, setDetailId] = React.useState('');
  const [detailLoading, setDetailLoading] = React.useState(false);

  const [ticking, setTicking] = React.useState(false);
  const [firing, setFiring] = React.useState(false);
  const [ticketBusy, setTicketBusy] = React.useState('');
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [narrowing, setNarrowing] = React.useState<string | null>(null);
  const [keptActions, setKeptActions] = React.useState<string[]>([]);

  /* detailId 用 ref 保存：load 是 useCallback([])，读 state 会拿到旧值。 */
  const detailRef = React.useRef('');
  detailRef.current = detailId;

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [statusEnv, statsEnv, decisionEnv, triggerEnv, mandateEnv, ticketEnv, ticketStatsEnv] = await Promise.all([
        api.getShadowStatus(),
        api.getShadowStats(),
        api.listShadowDecisions({ limit: 120 }),
        api.listShadowTriggers({ limit: 120 }),
        api.listShadowMandates({ limit: 40 }),
        api.listTickets({ limit: 40 }),
        api.getTicketStats(),
      ]);
      if (statusEnv.ok) setStatus(statusEnv.data);
      if (statsEnv.ok) setStats(statsEnv.data);
      if (decisionEnv.ok) setDecisions(decisionEnv.data.items ?? []);
      if (triggerEnv.ok) setTriggers(triggerEnv.data.items ?? []);
      if (mandateEnv.ok) setMandates(mandateEnv.data.items ?? []);
      if (ticketEnv.ok) setTickets(ticketEnv.data.items ?? []);
      if (ticketStatsEnv.ok) setTicketStats(ticketStatsEnv.data);

      /* 详情跟着列表一起刷新：看详情时最想看到的就是「这一轮又跑了什么」，
       * 如果详情只在打开时拉一次，它就会停在那儿不动。 */
      const openId = detailRef.current;
      if (openId) {
        const detailEnv = await api.getTicket(openId);
        if (detailEnv.ok) setDetail(detailEnv.data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (state.view !== 'shadow') return;
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [state.view, load]);

  const openDetail = React.useCallback((id: string) => {
    setDetailId(id);
    setDetail(null);
    setDetailLoading(true);
    void api.getTicket(id).then((env) => {
      if (env.ok) setDetail(env.data);
      setDetailLoading(false);
    });
  }, []);

  const closeDetail = React.useCallback(() => {
    setDetailId('');
    setDetail(null);
  }, []);

  const runTick = async (): Promise<void> => {
    setTicking(true);
    try {
      const envelope = await api.runShadowTick();
      if (!envelope.ok) {
        addToast(`研判失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      addToast(`研判完成：取 ${envelope.data.picked} 条 · 判 ${envelope.data.evaluated} 条 · 跳过 ${envelope.data.skipped} 条`);
      await load();
    } finally {
      setTicking(false);
    }
  };

  const setMode = async (mode: ShadowPolicy['acceptMode']): Promise<void> => {
    const envelope = await api.updateShadowPolicy({ acceptMode: mode });
    if (!envelope.ok) {
      addToast(`切换失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    addToast(`准入模式 → ${mode}（${envelope.data.policyVersion}）`);
    await load();
  };

  const toggleRule = async (id: string): Promise<void> => {
    const policy = status?.policy;
    if (!policy) return;
    const rules = policy.rules.map((rule) => ({
      ...rule,
      enabled: rule.id === id ? !rule.enabled : rule.enabled,
    }));
    const envelope = await api.updateShadowPolicy({ rules });
    if (!envelope.ok) {
      addToast(`规则更新失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    await load();
  };

  const toggleSource = async (kind: string, enabled: boolean): Promise<void> => {
    const envelope = await api.setShadowSource(kind, enabled);
    if (!envelope.ok) {
      addToast(`源开关失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    await load();
  };

  const saveList = async (
    field: 'allowedActors' | 'allowedBots',
    next: string[],
  ): Promise<void> => {
    const unique = [...new Set(next.map((item) => item.trim()).filter(Boolean))];
    const envelope = await api.updateShadowPolicy({ [field]: unique });
    if (!envelope.ok) {
      addToast(`保存失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    addToast(field === 'allowedActors'
      ? `白名单已更新：${unique.length} 人`
      : `允许机器人已更新：${unique.length} 个`);
    await load();
  };

  const promptAdd = (field: 'allowedActors' | 'allowedBots'): void => {
    const current = status?.policy[field] ?? [];
    setModal({
      kind: 'prompt',
      title: field === 'allowedActors' ? '添加白名单成员' : '添加允许的机器人',
      label: field === 'allowedActors'
        ? '输入身份名（与事件来源里显示的名字一致）：'
        : '输入机器人标识（如 dependabot[bot]）：',
      placeholder: field === 'allowedActors' ? '例如：黎忠芳' : '例如：dependabot[bot]',
      confirmLabel: '添加',
      onSubmit: (value: string) => {
        const name = value.trim();
        if (!name) return;
        void saveList(field, [...current, name]);
      },
    });
  };

  const removeFrom = (field: 'allowedActors' | 'allowedBots', name: string): void => {
    void saveList(field, (status?.policy[field] ?? []).filter((item) => item !== name));
  };

  const setAuto = async (patch: { autoMaxPerHour?: number; autoAllowWrites?: boolean }): Promise<void> => {
    const envelope = await api.updateShadowPolicy(patch);
    if (!envelope.ok) {
      addToast(`保存失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    await load();
  };

  const setRate = async (value: number): Promise<void> => {
    const envelope = await api.updateShadowPolicy({ threadRatePerHour: value });
    if (!envelope.ok) {
      addToast(`保存失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    await load();
  };

  const applySchedule = async (value: string): Promise<void> => {
    /* 预设在这里查，避免 UI 层和这里各维护一份 value → config 的映射。 */
    const preset = SCHEDULE_PRESETS.find((item) => item.value === value);
    if (!preset) return;
    const envelope = await api.setShadowSource('schedule', true, preset.config);
    if (!envelope.ok) {
      addToast(`设置失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    addToast(`定时巡检 → ${preset.label}`);
    await load();
  };

  const fireNow = async (): Promise<void> => {
    setFiring(true);
    try {
      const envelope = await api.fireShadowSource('schedule');
      if (!envelope.ok) {
        addToast(`投递失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      addToast(envelope.data.created ? '已投递一条巡检事件，可在账本查看研判' : '同一条巡检已存在，未重复投递');
      await load();
    } finally {
      setFiring(false);
    }
  };

  const review = async (
    id: string,
    next: 'accepted' | 'narrowed' | 'rejected',
    actions?: string[],
  ): Promise<void> => {
    const envelope = await api.reviewShadowMandate(id, { status: next, actions });
    if (!envelope.ok) {
      addToast(`表态失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    addToast(next === 'accepted'
      ? '已认可这份范围'
      : next === 'rejected' ? '已否决这份范围' : `已收窄到 ${actions?.length ?? 0} 个动作`);
    setNarrowing(null);
    await load();
  };

  const runTicketAction = async (
    id: string,
    action: () => Promise<{ ok: boolean; error?: { message?: string } | null }>,
    done: string,
  ): Promise<void> => {
    setTicketBusy(id);
    try {
      const envelope = await action();
      addToast(envelope.ok ? done : `操作失败：${envelope.error?.message ?? '未知错误'}`);
      await load();
      /* 动作改的是工单状态，而侧栏徽标读的是待人快照 —— 不立刻复核的话，
       * 你答完还盯着那个红点，会以为这一下没生效。 */
      if (envelope.ok) void refreshWaiting();
    } finally {
      setTicketBusy('');
    }
  };

  const answerTicket = async (ticket: ShadowTicket): Promise<void> => {
    const question = ticket.question;
    const text = (answers[ticket.id] ?? '').trim();
    if (!question || !text) return;
    await runTicketAction(
      ticket.id,
      () => api.answerTicket(ticket.id, { attentionId: question.id, answer: text }),
      '已回答，工单重新排队',
    );
    setAnswers((prev) => ({ ...prev, [ticket.id]: '' }));
  };

  const toggleEnabled = async (): Promise<void> => {
    const next = !(status?.enabled ?? true);
    const envelope = await api.setShadowEnabled(next);
    if (!envelope.ok) {
      addToast(`切换失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    addToast(envelope.data.enabled ? '已启用（两个循环恢复运转）' : '已关停（循环空转，不读不写）');
    await load();
  };

  const exportCsv = async (): Promise<void> => {
    const envelope = await api.exportShadowCsv(2000);
    if (!envelope.ok) {
      addToast(`导出失败：${envelope.error?.message ?? '未知错误'}`);
      return;
    }
    const blob = new Blob([envelope.data.content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = envelope.data.fileName;
    anchor.click();
    URL.revokeObjectURL(url);
    addToast(`已导出 ${envelope.data.rows} 条决策`);
  };

  const stepLoop = async (): Promise<void> => {
    setTicketBusy('__step__');
    try {
      await api.stepTickets();
      await load();
    } finally {
      setTicketBusy('');
    }
  };

  return {
    status, stats, decisions, triggers, mandates, tickets, ticketStats, loading,
    detail, detailId, detailLoading, openDetail, closeDetail,
    ticking, firing, ticketBusy, answers, setAnswers,
    narrowing, keptActions, setNarrowing, setKeptActions,
    load, runTick, setMode, toggleRule, toggleSource, saveList, promptAdd, removeFrom,
    setAuto, setRate, applySchedule, fireNow, review, runTicketAction, answerTicket,
    toggleEnabled, exportCsv, stepLoop,
  };
}
