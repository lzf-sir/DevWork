/**
 * Composer —— 会话输入框。
 *
 * 五件事都在这里闭环，且都不是装饰：
 *  1. @ 引用：在正文里敲 @ 弹出真实资产候选，选中后 chip 落到工具行，
 *     发送时解析成 assetIds 交给服务端（用户手写的 @生产库 同样算数）；
 *  2. / 技能：敲 / 弹出「技能 + 命令」两类候选。技能来自服务端登记表
 *     （/api/skills），选中后把方法论模板插入正文，随消息真实发给模型；
 *  3. 模型切换：模型下拉里选的是服务端登记的供应商预设模型，选择只作用于
 *     本次会话的下一条消息（不改全局配置），没配 Key 时如实说明；
 *  4. 附件：真实上传到服务端产物目录，发送时随消息提交文件名。
 *  5. 模式切换：只读 / 读写，点击即切（默认只读）；只读下 Agent 不执行写操作。
 *
 * 布局：输入区在上，全部功能以图标排列在底部工具栏。
 * 交互约定：↑↓ 选择、Enter/Tab 确认、Esc 收起候选（且不触发全局"中断生成"）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { api, type ContextUsage, type Skill } from '../api/client';
import { useLiveRefresh } from '../api/live';
import {
  AtIcon,
  AssetIcon,
  ClipIcon,
  CloseIcon,
  LockIcon,
  ModelIcon,
  SendIcon,
  SkillIcon,
  TerminalIcon,
  UnlockIcon,
} from './icons';
import {
  detectTrigger,
  filterCandidates,
  removeMention,
  replaceRange,
  resolveAssetIds,
  syncMentions,
  type Candidate,
  type TriggerMatch,
} from '../utils/composer';
import { SLASH_COMMANDS, filterSlashCommands, type SlashCommandSpec } from '../utils/slash';

export interface AssetCandidate extends Candidate {
  /** 资产类型：db / code / server / kb。 */
  type?: string;
  /** 类型图标。 */
  icon?: string;
  /** 环境标签（prod / dev）：同名资产靠它区分。 */
  tag?: string;
}

export interface ComposerProps {
  value: string;
  onChange: (next: string) => void;
  /** 发送：把正文里真实解析出的资产 id 交给上层。 */
  onSend: (assetIds: string[]) => void;
  /** 可被 @ 引用的资产（真实工作区资产 + 离线兜底）。 */
  assets: AssetCandidate[];
  /** 已选中的引用（chip）。 */
  picked: AssetCandidate[];
  onPickedChange: (next: AssetCandidate[]) => void;
  attachments: { id: string; name: string }[];
  onAttachmentsChange: (next: { id: string; name: string }[]) => void;
  onUpload: (files: FileList | null) => void;
  uploading: boolean;
  /** 本次会话选中的模型（空串 = 跟随全局默认）。 */
  model: string;
  onModelChange: (model: string) => void;
  /** 需要上层执行的命令（新建会话 / 导出会话）。 */
  onCommand: (id: string) => void;
  /** 计量行（上下文占用 / 费用）。 */
  meter: React.ReactNode;
  /** 只读模式下禁用发送（信任边界由服务端裁决，前端只是同步提示）。 */
  readOnly?: boolean;
  /** 上下文消耗 + 压缩（工具栏右侧的小按钮）。缺省时不显示该按钮。 */
  context?: ComposerContextMeter;
}

/** 上下文小按钮的数据与控制口（由页面通过 useContextUsage 提供）。 */
export interface ComposerContextMeter {
  usage: ContextUsage | null;
  loading: boolean;
  compacting: boolean;
  onRefresh: () => void;
  onCompact: () => void;
}

interface MenuItem {
  key: string;
  group: string;
  title: string;
  subtitle?: string;
  badge?: string;
  /** 候选行左侧图标（React 节点，资产类才有）。 */
  icon?: React.ReactNode;
  /** 不可用（依赖资产缺失）：置灰展示，不可选（设计 §4：显示不可用而非隐藏）。 */
  disabled?: boolean;
  payload: AssetCandidate | Skill | SlashCommandSpec;
}

const TYPE_LABEL: Record<string, string> = { db: '数据库', code: '代码库', server: '服务器', kb: '知识库' };
const TYPE_ICON: Record<string, string> = { db: '▤', code: '▣', server: '▥', kb: '▧' };

/** 资产类型 → 显示名（候选副标题用）。 */
export function assetTypeLabel(type: string): string {
  return TYPE_LABEL[type] ?? '资产';
}

/**
 * 资产类型 → 图标字符。
 *
 * 这是数据侧的契约（服务端 / mock 仍下发 '▤' 这类字符），
 * 真正渲染时由 components/icons 的 AssetIcon 按类型画成 SVG；
 * 保留这个函数是为了让离线兜底表与实时资产表走同一条渲染路径。
 */
export function assetTypeIcon(type: string): string {
  return TYPE_ICON[type] ?? '▣';
}

/* ── 底部工具栏图标 ────────────────────────────────── */
function IconAt(): React.ReactElement {
  return <AtIcon size={15} strokeWidth={1.3} />;
}
function IconSkill(): React.ReactElement {
  return <SkillIcon size={15} strokeWidth={1.2} />;
}
function IconTerminal(): React.ReactElement {
  return <TerminalIcon size={15} strokeWidth={1.2} />;
}
function IconClip(): React.ReactElement {
  return <ClipIcon size={15} strokeWidth={1.2} />;
}
function IconLock(): React.ReactElement {
  return <LockIcon size={14} strokeWidth={1.3} />;
}
function IconUnlock(): React.ReactElement {
  return <UnlockIcon size={14} strokeWidth={1.3} />;
}
function IconModel(): React.ReactElement {
  return <ModelIcon size={15} strokeWidth={1.2} />;
}

/* ── 上下文消耗的小圆环 ─────────────────────────────────
 * 用圆环而不是纯数字：一圈还剩多少是"余光可读"的，数字要点进去才看得懂。
 * 颜色只在 near / over 时才变 —— 常态下不抢注意力。 */
function ctxText(tokens: number): string {
  if (tokens >= 10000) return `${Math.round(tokens / 1000)}k`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function CtxRing({ ratio, state }: { ratio: number; state: 'ok' | 'near' | 'over' }): React.ReactElement {
  const r = 6.2;
  const circumference = 2 * Math.PI * r;
  const filled = Math.min(1, Math.max(0, ratio));
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" className={`ctxring ${state}`} aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={1.8} opacity={0.16} />
      <circle
        cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth={1.8}
        strokeDasharray={`${circumference * filled} ${circumference}`}
        strokeLinecap="round" transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

export default function Composer(props: ComposerProps): React.ReactElement {
  const {
    value, onChange, onSend, assets, picked, onPickedChange,
    attachments, onAttachmentsChange, onUpload, uploading,
    model, onModelChange, onCommand, meter, context,
  } = props;
  const { state, addToast, setModal, setHelp, setReadOnly, toggleReadOnly } = useStore();
  const refresh = useLiveRefresh();
  const readOnly = state.readOnly;

  const [trigger, setTrigger] = useState<TriggerMatch | null>(null);
  const [active, setActive] = useState<number>(0);
  const [modelOpen, setModelOpen] = useState<boolean>(false);
  /** 上下文浮层开关。点空白处自动收起 —— 它是"按需一瞥"的面板，不该常驻。 */
  const [ctxOpen, setCtxOpen] = useState<boolean>(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  /* 模型候选 = **用户已添加的模型档案**，不是供应商目录。
   * 目录里的模型用户一个都没配过，选了也调不通 —— 下拉里该列的是"我真能用的那些"。 */
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string; model: string; baseUrl: string; usable: boolean }[]>([]);
  const [globalModel, setGlobalModel] = useState<string>('');
  const [modelReady, setModelReady] = useState<boolean>(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef<boolean>(false);
  const ctxWrapRef = useRef<HTMLDivElement>(null);

  /* 点浮层外面就收起：不阻塞其它按钮，也不留一个挡视线的面板。 */
  useEffect(() => {
    if (!ctxOpen) return undefined;
    const onDown = (event: MouseEvent): void => {
      if (ctxWrapRef.current && !ctxWrapRef.current.contains(event.target as Node)) setCtxOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ctxOpen]);

  /* 技能清单来自服务端登记表；离线时 api 层自动回落内置副本。 */
  useEffect(() => {
    let alive = true;
    void api.listSkills().then((envelope) => {
      if (!alive || !envelope.ok || !Array.isArray(envelope.data)) return;
      setSkills(envelope.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 模型候选来自已添加的模型档案（设置页维护），打开下拉时再拉一次保证最新。 */
  const loadModelConfig = useCallback(() => {
    void api.getLlmConfig().then((envelope) => {
      if (!envelope.ok) return;
      const config = envelope.data;
      const profiles = config.profiles ?? [];
      const active = profiles.find((p) => p.id === config.activeId) ?? profiles[0];
      setGlobalModel(active?.model ?? config.model ?? '');
      /* 当前生效的那条能不能真用起来：有 Key，或本地端点免 Key。 */
      setModelReady(Boolean(active && (active.local || active.keyConfigured)));
      setModelOptions(profiles.map((p) => ({
        id: p.id,
        label: p.label,
        model: p.model,
        baseUrl: p.baseUrl,
        usable: p.local || p.keyConfigured,
      })));
    });
  }, []);

  useEffect(() => {
    loadModelConfig();
  }, [loadModelConfig]);

  /** 同名资产（order_db 的 prod / dev 两套）在 chip 上必须能分辨，否则两个 chip 一模一样。 */
  const ambiguousLabels = useMemo(() => {
    const counts = new Map<string, number>();
    assets.forEach((asset) => counts.set(asset.label, (counts.get(asset.label) ?? 0) + 1));
    const set = new Set<string>();
    counts.forEach((count, label) => {
      if (count > 1) set.add(label);
    });
    return set;
  }, [assets]);

  /** 候选列表：@ → 资产；/ → 技能 + 客户端命令。 */
  const menuItems = useMemo<MenuItem[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === 'asset') {
      return filterCandidates(assets, trigger.query).map((asset) => ({
        key: `asset-${asset.id}`,
        group: '引用资产',
        title: `@ ${asset.label}`,
        subtitle: asset.hint,
        /* 图标优先按类型画（db/code/server/kb），类型缺失时用数据侧字符兜底。 */
        icon: <AssetIcon type={asset.type} glyph={asset.icon} size={14} strokeWidth={1.3} />,
        payload: asset,
      }));
    }
    const skillItems: MenuItem[] = filterCandidates(skills, trigger.query).map((skill) => ({
      key: `skill-${skill.id}`,
      group: '技能',
      title: skill.label,
      subtitle: skill.availability && !skill.availability.available
        ? `不可用 · 缺少资产：${skill.availability.missing.join(' / ')}`
        : skill.desc,
      badge: skill.availability && !skill.availability.available ? '不可用' : skill.category,
      disabled: skill.availability ? !skill.availability.available : false,
      payload: skill,
    }));
    const commandItems: MenuItem[] = filterSlashCommands(SLASH_COMMANDS, trigger.query).map((command) => ({
      key: `cmd-${command.id}`,
      group: '命令',
      title: command.label,
      subtitle: command.desc,
      payload: command,
    }));
    return [...skillItems, ...commandItems];
  }, [trigger, assets, skills]);

  /** 把光标移到指定位置（插入候选后要落在正确的地方）。 */
  const setCaret = useCallback((pos: number) => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    requestAnimationFrame(() => {
      el.setSelectionRange(pos, pos);
    });
  }, []);

  /** 在光标处插入触发符并打开候选浮层（工具行上的 @ / 技能 chip 用它）。 */
  const insertTrigger = useCallback((char: '@' | '/') => {
    const el = inputRef.current;
    /* 输入框没获得焦点时 selectionStart 不可信（多半是 0），一律追加到末尾。 */
    const focused = !!el && document.activeElement === el;
    const caret = focused ? el?.selectionStart ?? value.length : value.length;
    const head = value.slice(0, caret);
    const tail = value.slice(caret);
    const needSpace = head.length > 0 && !/\s$/.test(head);
    const prefix = needSpace ? ' ' : '';
    const next = `${head}${prefix}${char}${tail}`;
    const start = caret + prefix.length;
    onChange(next);
    setTrigger({ kind: char === '@' ? 'asset' : 'command', start, end: start + 1, query: '' });
    setActive(0);
    setCaret(start + 1);
  }, [value, onChange, setCaret]);

  /** 选中 @ 资产：正文写入 @名称，同时登记 chip。 */
  const chooseAsset = useCallback((asset: AssetCandidate) => {
    if (!trigger) return;
    const { text, caret } = replaceRange(value, trigger.start, trigger.end, `@${asset.label} `);
    onChange(text);
    const merged = picked.some((item) => item.id === asset.id) ? picked : [...picked, asset];
    onPickedChange(syncMentions(text, merged));
    setTrigger(null);
    setCaret(caret);
  }, [trigger, value, picked, onChange, onPickedChange, setCaret]);

  /** 选中技能：把方法论模板插入正文（用户可继续编辑），随消息真实发给模型。
   *  依赖资产缺失的技能拒绝插入（服务端也不执行不可用技能的工作流）。 */
  const chooseSkill = useCallback((skill: Skill) => {
    if (!trigger) return;
    if (skill.availability && !skill.availability.available) {
      addToast(`技能「${skill.label}」不可用：当前工作区缺少 ${skill.availability.missing.join(' / ')} 资产`);
      return;
    }
    const { text, caret } = replaceRange(value, trigger.start, trigger.end, `${skill.template} `);
    onChange(text);
    setTrigger(null);
    setCaret(caret);
    addToast(`已插入技能「${skill.label}」的方法论模板 · 可继续编辑后发送`);
  }, [trigger, value, onChange, setCaret, addToast]);

  /** 客户端命令：先清掉触发文本，再执行动作。 */
  const runSlashCommand = useCallback((command: SlashCommandSpec) => {
    if (trigger) {
      const { text } = replaceRange(value, trigger.start, trigger.end, '');
      onChange(text);
    }
    setTrigger(null);
    switch (command.id) {
      case 'model':
        setModelOpen(true);
        loadModelConfig();
        break;
      case 'skills':
        setModal({
          kind: 'info',
          title: `技能清单 · ${skills.length} 项（服务端登记表）`,
          body: [
            '提示词级技能：方法论模板 + 依赖的只读工具（预算内运行）。',
            '选中后模板会插入输入框，随消息真实发给模型；声明了写工具的技能，写操作仍走审批卡。',
            '依赖资产缺失的技能显示「不可用」，需先在对应工作区挂载该类资产。',
            '',
            ...skills.map((skill) => {
              const budget = skill.budget?.maxToolCalls ? ` · 预算 ${skill.budget.maxToolCalls} 次工具` : '';
              const write = skill.writeTools && skill.writeTools.length > 0
                ? ` · 写工具（需审批）：${skill.writeTools.map((t) => t.label ?? t.name).join('/')}` : '';
              const state = skill.availability && !skill.availability.available
                ? `【不可用 · 缺 ${skill.availability.missing.join('/')}】` : '';
              return `· ${state}${skill.label}（${skill.category}）— ${skill.desc} · 工具 ${skill.tools.map((t) => t.name).join(' / ')}${budget}${write}`;
            }),
          ].join('\n'),
          mono: true,
        });
        break;
      case 'assets':
        insertTrigger('@');
        break;
      case 'new':
        onCommand('new');
        break;
      case 'export':
        onCommand('export');
        break;
      case 'clear':
        onChange('');
        onPickedChange([]);
        break;
      case 'help':
        setHelp(true);
        break;
      default:
        break;
    }
  }, [trigger, value, onChange, skills, insertTrigger, onCommand, setModal, setHelp, loadModelConfig]);

  const chooseItem = useCallback((item: MenuItem) => {
    if (item.payload && 'template' in item.payload) {
      chooseSkill(item.payload as Skill);
      return;
    }
    if (item.payload && 'desc' in item.payload && 'keywords' in (item.payload as SlashCommandSpec)) {
      runSlashCommand(item.payload as SlashCommandSpec);
      return;
    }
    chooseAsset(item.payload as AssetCandidate);
  }, [chooseAsset, chooseSkill, runSlashCommand]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    onChange(next);
    /* 中文输入法组字期间不弹候选：组字中间态会出现半截拼音，弹出来只会碍事。 */
    if (composingRef.current) return;
    const caret = event.target.selectionStart ?? next.length;
    const matched = detectTrigger(next, caret);
    setTrigger(matched);
    setActive(0);
    /* 正文里被手动删掉的 @ 引用，chip 也要跟着消失。 */
    onPickedChange(syncMentions(next, picked));
  }, [onChange, onPickedChange, picked]);

  const send = useCallback(() => {
    if (!value.trim()) {
      addToast('请输入你的问题后再发送');
      return;
    }
    /* 引用来源：点选的 chip（带真实 id）+ 正文里手写且名称唯一的 @名称。 */
    onSend(resolveAssetIds(value, assets, picked));
  }, [value, assets, picked, onSend, addToast]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current) return;
    if (trigger && menuItems.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((prev) => (prev + 1) % menuItems.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((prev) => (prev - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        /* 阻止冒泡：否则全局 ⌘↵ 也会跟着发一次，出现两条消息。 */
        event.stopPropagation();
        const item = menuItems[Math.min(active, menuItems.length - 1)];
        if (item) chooseItem(item);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        /* 收起候选时不要连带触发全局 Esc（那会中断正在跑的生成）。 */
        event.stopPropagation();
        setTrigger(null);
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }, [trigger, menuItems, active, chooseItem, send]);

  const removePicked = useCallback((asset: AssetCandidate) => {
    const next = picked.filter((item) => item.id !== asset.id);
    onPickedChange(next);
    /* chip 消失，正文里的 @名称 也要一起删掉，否则两处对不上。 */
    onChange(removeMention(value, asset.label));
  }, [picked, onPickedChange, value, onChange]);

  const removeAttachment = useCallback((id: string) => {
    onAttachmentsChange(attachments.filter((item) => item.id !== id));
  }, [attachments, onAttachmentsChange]);

  const chooseModel = useCallback((next: string) => {
    onModelChange(next);
    setModelOpen(false);
    addToast(next
      ? `本次会话已切到模型 ${next}${modelReady ? '' : ' · 但尚未配置 API Key，实际调用仍走规则化轨迹'}`
      : '本次会话已改为跟随全局默认模型');
  }, [onModelChange, addToast, modelReady]);

  const currentModel = model || globalModel || '未接入模型';

  /** 只读/读写切换：写服务端 /api/settings/perm，按 effective-policy 同步本地状态。 */
  const toggleMode = useCallback(() => {
    const next = !state.readOnly;
    void api.updateSettings('perm', { readOnlyMode: next }).then((envelope) => {
      if (!envelope.ok) {
        addToast(`模式切换失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      void api.getEffectivePolicy().then((policy) => {
        const effective = policy.ok ? policy.data.readOnlyMode : next;
        if (effective !== state.readOnly) toggleReadOnly();
        addToast(
          effective
            ? '已切换为只读模式：Agent 不会执行任何写操作'
            : '已切换为读写模式：Agent 可执行写操作（仍需审批）',
        );
        refresh();
      });
    });
  }, [state.readOnly, toggleReadOnly, addToast, refresh]);

  return (
    <div className="composer">
      <div className="cbox">
        {trigger && menuItems.length > 0 ? (
          <div className="cpop">
            <div className="cph2">
              {trigger.kind === 'asset' ? '选择要引用的资产' : '技能与命令'}
              {trigger.query ? <span className="cq">关键词「{trigger.query}」</span> : null}
            </div>
            <div className="clist">
              {menuItems.map((item, index) => {
                const previous = menuItems[index - 1];
                const showGroup = !previous || previous.group !== item.group;
                return (
                  <React.Fragment key={item.key}>
                    {showGroup ? <div className="cgroup">{item.group}</div> : null}
                    <div
                      className={`citem${index === active ? ' on' : ''}${item.disabled ? ' off' : ''}`}
                      onMouseEnter={() => setActive(index)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseItem(item)}
                      style={item.disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}
                    >
                      {item.icon ? <span className="ci">{item.icon}</span> : null}
                      <span className="ct2">{item.title}</span>
                      {item.badge ? <span className="cb">{item.badge}</span> : null}
                      {item.subtitle ? <span className="cs">{item.subtitle}</span> : null}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
            <div className="cfoot">↑↓ 选择 · Enter 确认 · Esc 收起</div>
          </div>
        ) : null}

        {/* 输入区 */}
        <div className="irow">
          <textarea
            ref={inputRef}
            className="cinput"
            rows={1}
            value={value}
            placeholder={readOnly ? '输入你的问题…（只读模式，Agent 不会执行写操作）' : '输入你的问题…  @ 引用资产 · / 技能'}
            style={{ height: `${Math.min(120, 24 + value.split('\n').length * 20)}px` }}
            onChange={handleChange}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            /* 点别处就收起候选浮层（候选项的 mousedown 阻止了默认行为，
             * 选候选不会触发 blur，所以这里不会把刚选中的项收掉）。 */
            onBlur={() => setTrigger(null)}
            onKeyDown={handleKeyDown}
          />
        </div>

        {/* 引用 / 附件 chip 行（有内容时才显示） */}
        {picked.length > 0 || attachments.length > 0 ? (
          <div className="cchiprow">
            {picked.map((asset) => (
              <span
                className="atchip"
                key={asset.id}
                title={asset.hint ? `${asset.hint}\n点击移除该引用（正文里的 @名称 会一起删掉）` : '点击移除该引用（正文里的 @名称 会一起删掉）'}
                style={{ cursor: 'pointer' }}
                onClick={() => removePicked(asset)}
              >
                <span className="atchip-label">
                  @ {asset.label}
                  {ambiguousLabels.has(asset.label) && asset.tag ? ` · ${asset.tag}` : ''}
                </span>
                <CloseIcon size={11} strokeWidth={1.5} className="atchip-x" />
              </span>
            ))}
            {attachments.map((file) => (
              <span
                className="atchip"
                key={file.id}
                title="点击移除该附件（服务端产物保留）"
                style={{ cursor: 'pointer' }}
                onClick={() => removeAttachment(file.id)}
              >
                <ClipIcon size={11} strokeWidth={1.4} className="atchip-ic" />
                <span className="atchip-label">{file.name}</span>
                <CloseIcon size={11} strokeWidth={1.5} className="atchip-x" />
              </span>
            ))}
          </div>
        ) : null}

        {/* 底部图标工具栏 */}
        <div className="ctoolbar">
          <button className="tbtn" type="button" title="引用资产（@）" onClick={() => insertTrigger('@')}>
            <IconAt />
          </button>
          <button className="tbtn" type="button" title="技能与命令（/）" onClick={() => insertTrigger('/')}>
            <IconSkill />
          </button>
          <button
            className="tbtn"
            type="button"
            title="终端只读命令白名单"
            onClick={() => {
              void api.getCommandWhitelist().then((envelope) => {
                const list = envelope.ok && Array.isArray(envelope.data)
                  ? envelope.data.map((w) => String((w as { prefix?: string; command?: string }).prefix ?? (w as { command?: string }).command ?? '')).filter(Boolean)
                  : [];
                setModal({
                  kind: 'info',
                  title: `Agent 可用命令 · ${list.length} 条只读白名单`,
                  body: [
                    '会话用自然语言提问即可，Agent 会自动选择工具；没有斜杠命令语法。',
                    '终端仅放行以下只读白名单命令（完整列表见服务器详情页）：',
                    '',
                    ...list.slice(0, 40),
                  ].join('\n'),
                  mono: true,
                });
              });
            }}
          >
            <IconTerminal />
          </button>
          <button
            className="tbtn"
            type="button"
            title={uploading ? '上传中…' : '附件'}
            onClick={() => fileInputRef.current?.click()}
          >
            <IconClip />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(event) => {
              onUpload(event.target.files);
              event.target.value = '';
            }}
          />

          {/* 模型切换 */}
          <div className="msel-wrap">
            <button
              className={`tbtn tbtn-label${modelOpen ? ' on' : ''}`}
              type="button"
              title="切换本次会话使用的模型"
              onClick={() => {
                setModelOpen((prev) => !prev);
                setTrigger(null);
                loadModelConfig();
              }}
            >
              <IconModel />
              <span className="tbtn-text">{currentModel}</span>
            </button>
            {modelOpen ? (
              <div className="mdrop">
                <div className="cph2">模型 · 只作用于本次会话的下一条消息</div>
                <div
                  className={`mdi${model === '' ? ' on' : ''}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseModel('')}
                >
                  <span className="ct2">跟随全局默认</span>
                  <span className="cs">{globalModel || '未配置'}</span>
                </div>
                {modelOptions.length === 0 ? (
                  <div className="mdi" onMouseDown={(event) => event.preventDefault()}>
                    <span className="ct2">还没有添加模型</span>
                    <span className="cs">去「设置 · 模型」添加</span>
                  </div>
                ) : null}
                {modelOptions.map((profile) => (
                  <div
                    className={`mdi${model === profile.model ? ' on' : ''}`}
                    key={profile.id}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseModel(profile.model)}
                  >
                    <span className="ct2">{profile.label}</span>
                    <span className="cs">{profile.model}</span>
                    {model === profile.model ? <span className="cb">本次会话</span> : null}
                    {!profile.usable ? <span className="cb warn">缺 Key</span> : null}
                  </div>
                ))}
                <div
                  className="cfoot mfoot"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setModelOpen(false);
                    setModal({
                      kind: 'info',
                      title: '模型接入状态',
                      body: modelReady
                        ? `已接入模型：${globalModel}\n共 ${modelOptions.length} 个已添加模型，切换只影响本次会话的下一条消息，不会改动全局配置。`
                        : '尚未配置 API Key 与端点：本次选择的模型会被记住，但服务端仍走规则化轨迹（不产出结论）。\n请到「设置 · 模型」添加模型并绑定 Key 后再切换。',
                      mono: true,
                    });
                  }}
                >
                  {modelReady ? `已接入 ${modelOptions.length} 个 · ${globalModel}` : '未接入模型 · 去设置 →'}
                </div>
              </div>
            ) : null}
          </div>

          {/* 只读/读写模式切换 */}
          <button
            className={`tbtn tbtn-label mode-btn${readOnly ? ' ro' : ' rw'}`}
            type="button"
            title={readOnly ? '当前：只读模式（点击切换为读写）' : '当前：读写模式（点击切换为只读）'}
            onClick={toggleMode}
          >
            {readOnly ? <IconLock /> : <IconUnlock />}
            <span className="tbtn-text">{readOnly ? '只读' : '读写'}</span>
          </button>

          <div className="grow" />

          {/* 上下文消耗 + 压缩：决策点就在输入框旁边 ——
           * "我还要不要接着问"这个判断是在这里做的，不是去看状态栏。 */}
          {context ? (
            <div className="ctxwrap" ref={ctxWrapRef}>
              <button
                className={`tbtn tbtn-label ctxbtn${ctxOpen ? ' on' : ''}`}
                type="button"
                title={context.usage
                  ? `上下文 ${ctxText(context.usage.used)} / ${ctxText(context.usage.budget)} · 点击查看构成与压缩`
                  : '上下文用量读取中'}
                onClick={() => {
                  setCtxOpen((prev) => !prev);
                  setModelOpen(false);
                  setTrigger(null);
                  if (!ctxOpen) context.onRefresh();
                }}
              >
                <CtxRing ratio={context.usage?.ratio ?? 0} state={context.usage?.state ?? 'ok'} />
                <span className="tbtn-text">
                  {context.usage ? `${ctxText(context.usage.used)}/${ctxText(context.usage.budget)}` : '—'}
                </span>
              </button>
              {ctxOpen ? (
                <div className="ctxpop">
                  {context.usage ? (
                    <>
                      <div className="cxh">
                        <span className="cxt">上下文占用</span>
                        <span className={`cxpct ${context.usage.state}`}>
                          {Math.round(context.usage.ratio * 100)}%
                        </span>
                      </div>
                      <div className="cxbar">
                        <i
                          className={context.usage.state}
                          style={{ width: `${Math.min(100, Math.max(2, context.usage.ratio * 100))}%` }}
                        />
                      </div>
                      <div className="cxline">
                        <span>{ctxText(context.usage.used)} / {ctxText(context.usage.budget)} tokens</span>
                        <span>{context.usage.messages.inWindow}/{context.usage.messages.total} 条在提示内</span>
                      </div>
                      <div className="cxlist">
                        {context.usage.breakdown.map((item) => (
                          <div className="cxrow" key={item.name}>
                            <span className="cxn">{item.name}</span>
                            <span className="cxb">
                              <i style={{ width: `${context.usage && context.usage.used > 0 ? Math.max(2, (item.tokens / context.usage.used) * 100) : 2}%` }} />
                            </span>
                            <span className="cxv">{ctxText(item.tokens)}</span>
                          </div>
                        ))}
                      </div>
                      <div className={`cxnote${context.usage.state === 'over' ? ' warn' : ''}`}>
                        {context.usage.state === 'over'
                          ? `已到自动压缩水位（${Math.round(context.usage.autoCompactAt * 100)}%）：下一轮发送前会自动压缩并继续。`
                          : context.usage.messages.folded > 0
                            ? `预算外还有 ${context.usage.messages.folded} 条消息未进提示${context.usage.summary ? '（已由上面那次摘要覆盖）' : '，点「压缩上下文」可把它们提炼成摘要'}。`
                            : `预算来源：${context.usage.windowSource === 'setting' ? '设置页指定' : context.usage.windowSource === 'model' ? '按模型推断' : '默认 128k'}。`}
                        {context.usage.summary
                          ? ` 上次压缩：折叠 ${context.usage.summary.messages} 条 · ${context.usage.summary.source === 'model' ? '模型提炼' : '规则提炼'}。`
                          : ''}
                      </div>
                      <div className="cxf">
                        <button
                          className="btn"
                          type="button"
                          disabled={context.compacting || context.loading}
                          onClick={context.onCompact}
                        >
                          {context.compacting ? '压缩中…' : '压缩上下文'}
                        </button>
                        <button className="btn" type="button" disabled={context.loading} onClick={context.onRefresh}>
                          刷新
                        </button>
                      </div>
                      <div className="cfoot">压缩只影响「发给模型的内容」，原始消息仍完整留在时间线里。</div>
                    </>
                  ) : (
                    <div className="cxempty">
                      {context.loading ? '正在读取上下文用量…' : '暂无用量数据（会话还没有消息，或后端未就绪）'}
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 发送 */}
          <button className="send" type="button" title="发送 ⌘↵" onClick={send}>
            <SendIcon size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
      <div className="meter">{meter}</div>
    </div>
  );
}
