import React, { useEffect, useMemo, useState } from 'react';
import { useStore, THEME_LABEL, type Theme } from '../store';
import { api, type SettingRow } from '../api/client';
import type { LlmPreset, LlmProfile, ToolFace } from '../api/types';
import { useLiveData, useLiveRefresh, useLiveVersion } from '../api/live';
import { applyLookRows } from '../look';
import { downloadFile } from '../components/ui';
import { ArchiveIcon, CloseIcon, GearIcon, InfoIcon, LockIcon, ModelIcon, PaletteIcon, PlusIcon, SearchIcon, ShieldIcon } from '../components/icons';
import { ModelProfileModal, type ModelProfileDraft } from '../components/ModelProfileModal';
import type { Conversation } from '../api/types';

/** 构建期注入的版本号（vite define，来自 package.json）。 */
const BUILD_VERSION = __APP_VERSION__;

type Values = Record<string, string | boolean>;

/** 运行时探测到的环境信息：模型档案、后端版本、日志目录、规则条数。 */
interface EnvInfo {
  /** 已添加的模型数量。 */
  modelCount: number;
  /** 当前生效的模型名。 */
  modelName: string;
  /** 当前生效的模型是否真的能用（有 Key，或本地端点免 Key）。 */
  modelReady: boolean;
  backendVersion: string;
  nodeVersion: string;
  driver: string;
  logsPath: string;
  sensitiveCount: number;
  whitelistCount: number;
  offline: boolean;
}

const EMPTY_ENV: EnvInfo = {
  modelCount: 0,
  modelName: '',
  modelReady: false,
  backendVersion: '',
  nodeVersion: '',
  driver: '',
  logsPath: '',
  sensitiveCount: 0,
  whitelistCount: 0,
  offline: true,
};

/**
 * C1 模型自配置（多模型）：**已添加模型列表** + 添加模型表单。
 *
 * 为什么列表是主角：模型可以添加多个，那"我加了哪些模型、哪个在用、哪个还没配 Key"
 * 就成了必须一眼看清的事。原来的单条表单加完就没了痕迹 —— 加第二个模型时，
 * 第一个去哪了？用户只能靠记忆。现在列表常驻，档案是持久对象。
 *
 * 每条档案自带端点与 Key（Key 存本机钥匙串，DB 只存引用），
 * 不同供应商的模型可以并存，切换时连端点与 Key 一起换。
 */
function ModelConfigCard({
  values,
  setValue,
}: {
  values: Values;
  setValue: (id: string, value: string | boolean, label: string, sectionId: string) => void;
}): React.ReactElement {
  const { addToast, setModel, setModal } = useStore();
  const { SETTINGS_SECTIONS } = useLiveData();
  const refresh = useLiveRefresh();

  const [presets, setPresets] = useState<LlmPreset[]>([]);
  const [profiles, setProfiles] = useState<LlmProfile[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [offline, setOffline] = useState<boolean>(false);
  const [busy, setBusy] = useState<string>('');
  /**
   * 表单弹窗的状态：null = 关闭；'add' = 新增；LlmProfile = 编辑该条。
   * **表单不在列表里内联** —— 列表一长，内联表单就被挤出屏幕，
   * 而新增恰恰是最常做的动作，入口必须一直在眼前。
   */
  const [formState, setFormState] = useState<'add' | LlmProfile | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  const tokenRow = SETTINGS_SECTIONS
    .find((section) => section.id === 'model')
    ?.rows.find((row) => row.id === 'maxTokens');

  /** 拉一次档案列表。列表是设置页与输入框切换器共同的唯一数据源。 */
  const load = React.useCallback(() => {
    void api.getLlmConfig().then((envelope) => {
      if (!envelope.ok) {
        setOffline(true);
        return;
      }
      const cfg = envelope.data;
      setPresets(cfg.presets ?? []);
      setProfiles(cfg.profiles ?? []);
      setActiveId(cfg.activeId ?? '');
      setOffline(false);
      /* 状态栏跟随真实生效的模型名，不再显示写死的「Claude-Sonnet」。 */
      if (cfg.model) setModel(cfg.model);
    });
  }, [setModel]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 新增或保存档案（由弹窗提交）。
   * 表单的状态在弹窗自己那儿，这里只负责落库与回写列表。
   */
  const submitDraft = (draft: ModelProfileDraft): void => {
    const editing = formState && formState !== 'add' ? formState : null;
    const payload = {
      label: draft.label || draft.model,
      provider: draft.provider,
      baseUrl: draft.baseUrl,
      model: draft.model,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
    };
    setSaving(true);
    const call = editing
      ? api.updateLlmProfile(editing.id, payload)
      : api.addLlmProfile(payload);
    void call.then((envelope) => {
      setSaving(false);
      if (!envelope.ok) {
        addToast(`保存失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      const cfg = envelope.data;
      setProfiles(cfg.profiles ?? []);
      setActiveId(cfg.activeId ?? '');
      setFormState(null);
      addToast(editing ? `模型档案已更新 · ${payload.label}` : `已添加模型 · ${payload.label}`);
      refresh();
    });
  };

  /** 编辑：打开弹窗并预填该条档案的现值。 */
  const startEdit = (profile: LlmProfile): void => {
    setFormState(profile);
  };
  /** 设为当前生效。 */
  const activate = (profile: LlmProfile): void => {
    setBusy(profile.id);
    void api.activateLlmProfile(profile.id).then((envelope) => {
      setBusy('');
      if (!envelope.ok) {
        addToast(`切换失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      const cfg = envelope.data;
      setProfiles(cfg.profiles ?? []);
      setActiveId(cfg.activeId ?? '');
      if (cfg.model) setModel(cfg.model);
      addToast(`当前模型已切换为 ${profile.label}`);
      refresh();
    });
  };

  /** 连通性测试：测的是这条档案自己的端点与 Key，不是全局的那一套。 */
  const test = (profile: LlmProfile): void => {
    setBusy(profile.id);
    void api.testLlmConfig({
      profileId: profile.id,
      baseUrl: profile.baseUrl,
      model: profile.model,
    }).then((envelope) => {
      setBusy('');
      if (!envelope.ok) {
        addToast(`测试失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      const r = envelope.data;
      addToast(r.ok ? `连接成功 · ${r.latencyMs}ms · ${r.model}` : `连接失败：${r.message}`);
    });
  };

  /** 删除档案：二次确认，并说明这把 Key 也会一并从钥匙串清除。 */
  const remove = (profile: LlmProfile): void => {
    setModal({
      kind: 'confirm',
      title: `删除模型档案「${profile.label}」？`,
      body: [
        `模型：${profile.model}`,
        `端点：${profile.baseUrl}`,
        '',
        '这条档案对应的 API Key 会从本机钥匙串中一并删除（不可恢复）。',
        '其他档案不受影响。',
      ].join('\n'),
      confirmLabel: '删除',
      danger: true,
      onConfirm: () => {
        void api.removeLlmProfile(profile.id).then((envelope) => {
          if (!envelope.ok) {
            addToast(`删除失败：${envelope.error?.message ?? '未知错误'}`);
            return;
          }
          const cfg = envelope.data;
          setProfiles(cfg.profiles ?? []);
          setActiveId(cfg.activeId ?? '');
          if (formState === profile.id) setFormState(null);
          addToast(`已删除模型档案「${profile.label}」· 其 Key 已从钥匙串清除`);
          refresh();
        });
      },
    });
  };

  /** 某条档案的 Key 状态说明（只说真话）。 */
  const keyText = (profile: LlmProfile): string => {
    if (profile.local) return '本地端点 · 无需 Key';
    if (profile.keyConfigured && profile.keySource === 'keychain') return 'Key 已配置 · OS 钥匙串';
    if (profile.keyConfigured && profile.keySource === 'env') return 'Key 已配置 · env 明文（建议改存钥匙串）';
    return '未配置 Key · 这条模型暂不可用';
  };

  /** 这条档案能不能真的用起来。 */
  const usable = (profile: LlmProfile): boolean => profile.local || profile.keyConfigured;

  const activeProfile = profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null;
  /* 「有没有模型可用」以当前生效档案为准 —— 当前这条没 Key，就等于整个应用没接入模型。 */
  const ready = activeProfile ? usable(activeProfile) : false;

  return (
    <div className="modelcfg">
      {offline ? (
        <div className="srow">
          <div className="sl">
            <div className="sn">离线 Mock 模式</div>
            <div className="sd2">后端不可达，模型档案需要连接后端服务后才能读写。</div>
          </div>
        </div>
      ) : null}

      {/* ── 已添加模型：列表是这一分区的主角 ── */}
      <div className="pfhead">
        <div className="pftitle">
          已添加模型
          <span className="pfcount">{profiles.length} 个</span>
        </div>
        {/* 新增入口常驻在列表头部：列表再长也不会把它挤走。 */}
        <button className="btn p" onClick={() => setFormState('add')} disabled={offline}>
          <PlusIcon size={13} strokeWidth={1.6} />
          新增模型
        </button>
      </div>
      {!ready && profiles.length > 0 ? (
        <div className="mcfg-warn inline">
          <b>当前模型尚不可用</b>
          <span>当前生效的是「{activeProfile?.label ?? '—'}」，{activeProfile && !activeProfile.local ? '它还没有配置 API Key' : '请先添加一个模型'}。未配置前 Agent 走本地规则化轨迹，不会产出结论。</span>
        </div>
      ) : null}

      {profiles.length === 0 ? (
        <div className="pfempty">
          <div className="pfempty-t">还没有添加任何模型</div>
          <div className="pfempty-d">点右上角「新增模型」填好端点、模型名与 API Key —— 配齐后 Agent 才会真正开始产出结论。</div>
        </div>
      ) : (
        <div className="pflist">
          {profiles.map((profile) => (
            <div className={`pfrow${profile.id === activeId ? ' on' : ''}`} key={profile.id}>
              <div className="pfl">
                <div className="pfn">
                  {profile.label}
                  {profile.id === activeId ? <span className="pfbadge">当前</span> : null}
                  {!usable(profile) ? <span className="pfbadge warn">缺 Key</span> : null}
                </div>
                <div className="pfd">{profile.model} · {profile.baseUrl}</div>
                <div className="pfd">{keyText(profile)}</div>
              </div>
              <div className="pfr">
                {profile.id !== activeId ? (
                  <button className="btn" onClick={() => activate(profile)} disabled={busy === profile.id}>设为当前</button>
                ) : null}
                <button className="btn" onClick={() => test(profile)} disabled={busy === profile.id}>
                  {busy === profile.id ? '…' : '测试'}
                </button>
                <button className="btn" onClick={() => startEdit(profile)}>编辑</button>
                <button className="btn danger" onClick={() => remove(profile)}>删除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* token 上限与模型配置是同一件事（它就是发给供应商的 max_tokens），
          所以并进卡片，而不是孤零零挂在卡片外面当一行。 */}
      {tokenRow ? (
        <div className="srow">
          <div className="sl">
            <div className="sn">{tokenRow.name}</div>
            <div className="sd2">{tokenRow.desc}</div>
          </div>
          <div className="sc">
            <input
              className="sinput"
              value={String(values[tokenRow.id] ?? '')}
              onChange={(e) => setValue(tokenRow.id, e.target.value, tokenRow.name, 'model')}
            />
          </div>
        </div>
      ) : null}

      {/* ── 新增 / 编辑表单：独立弹窗，与列表分开 ── */}
      {formState ? (
        <ModelProfileModal
          mode={formState === 'add' ? 'add' : 'edit'}
          initial={formState === 'add' ? undefined : {
            label: formState.label,
            provider: formState.provider,
            baseUrl: formState.baseUrl,
            model: formState.model,
            apiKey: '',
          }}
          profileId={formState === 'add' ? undefined : formState.id}
          presets={presets}
          busy={saving}
          onClose={() => setFormState(null)}
          onSubmit={submitDraft}
        />
      ) : null}
    </div>
  );
}

function valuesFrom(sections: { rows: SettingRow[] }[]): Values {
  const values: Values = {};
  sections.forEach((section) =>
    section.rows.forEach((row) => {
      if (row.control.type === 'toggle') values[row.id] = row.control.on ?? false;
      else values[row.id] = row.control.value ?? '';
    }),
  );
  return values;
}

/** 分区附带的额外检索词：模型分区的主体是自配置卡片，不在 rows 里。 */
const SEARCH_EXTRA: Record<string, string> = {
  model: '供应商预设 API 端点 Base URL 模型名称 API Key 钥匙串 测试连接 保存配置',
};

/** 分区 → 导航图标：同一形状代表同一类事情，扫一眼就知道自己在哪个域。 */
const SECTION_ICON: Record<string, (props: { size?: number; strokeWidth?: number }) => React.ReactElement> = {
  gen: GearIcon,
  model: ModelIcon,
  perm: LockIcon,
  privacy: ShieldIcon,
  archive: ArchiveIcon,
  look: PaletteIcon,
  about: InfoIcon,
};

function sectionIcon(sectionId: string): React.ReactNode {
  const Icon = SECTION_ICON[sectionId] ?? GearIcon;
  return <Icon size={13} strokeWidth={1.4} />;
}

/**
 * 设置（重做）：左侧「搜索 + 分类导航」，右侧「状态总览 + 分区内容」。
 *
 * 为什么加状态总览：设置是低频但必须齐的模块，用户带着「我要关掉某个东西」
 * 的目的进来，三秒内要能定位。原来六个分类平铺、没有搜索、也没有任何状态提示，
 * 「模型没配」这种致命事实只躺在一行灰字里——等于不存在。
 *
 * 为什么加搜索：分区越加越多，光靠滚动找设置是撞运气。搜索跨分类过滤行，
 * 命中结果按分区重新聚合，一屏看完全部匹配。
 */
export default function SettingsView(): React.ReactElement {
  const { state, setSettingsSection, setModal, addToast, toggleReadOnly, setTheme } = useStore();
  const { SETTINGS_SECTIONS, COMMAND_WHITELIST, ORG_AUDIT } = useLiveData();
  const refresh = useLiveRefresh();
  const version = useLiveVersion();
  const [values, setValues] = useState<Values>(() => valuesFrom(SETTINGS_SECTIONS));
  const [query, setQuery] = useState<string>('');
  /* 搜索时的分区筛选：空串 = 看全部分区的命中结果。 */
  const [scope, setScope] = useState<string>('');
  const [env, setEnv] = useState<EnvInfo>(EMPTY_ENV);

  useEffect(() => {
    setValues(valuesFrom(SETTINGS_SECTIONS));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  /* 状态总览与分类状态点的数据源：全部运行时探测，不写死。 */
  useEffect(() => {
    let alive = true;
    void Promise.all([
      api.getLlmConfig().catch(() => null),
      api.health().catch(() => null),
      api.getSensitiveRules().catch(() => null),
      api.getCommandWhitelist().catch(() => null),
      window.desktop?.logsPath?.().catch(() => '') ?? Promise.resolve(''),
    ]).then(([cfg, health, rules, whitelist, logsPath]) => {
      if (!alive) return;
      const c = cfg && cfg.ok ? cfg.data : null;
      const h = health && health.ok ? (health.data as unknown as Record<string, unknown>) : null;
      const profiles = c?.profiles ?? [];
      const active = profiles.find((p) => p.id === c?.activeId) ?? profiles[0];
      setEnv({
        modelCount: profiles.length,
        modelName: active?.model ?? c?.model ?? '',
        /* 当前生效的模型能不能用：有 Key，或本地端点免 Key。 */
        modelReady: Boolean(active && (active.local || active.keyConfigured)),
        backendVersion: String(h?.version ?? ''),
        nodeVersion: String(h?.node ?? ''),
        driver: String(h?.driver ?? ''),
        logsPath: typeof logsPath === 'string' ? logsPath : '',
        sensitiveCount: rules && rules.ok ? rules.data.length : 0,
        whitelistCount: whitelist && whitelist.ok ? whitelist.data.length : 0,
        offline: !h,
      });
    });
    return () => {
      alive = false;
    };
  }, [version]);

  const setValue = (id: string, value: string | boolean, label: string, sectionId: string): void => {
    setValues((prev) => ({ ...prev, [id]: value }));
    /* 外观三项（字号 / 代码字体 / 密度）保存即生效，不等服务端回读。 */
    if (sectionId === 'look') applyLookRows({ [id]: String(value) });
    void api.updateSettings(sectionId as 'gen' | 'model' | 'perm' | 'privacy' | 'look' | 'about', { [id]: value })
      .then((envelope) => {
        if (!envelope.ok) {
          addToast(`保存失败：${envelope.error?.message ?? '未知错误'}`);
          return;
        }
        addToast(`已保存：${label}`);
        refresh();
      });
  };

  /** B6：只读开关写服务端，随后刷新 effective-policy，状态以服务端为准。 */
  const applyReadOnly = (next: boolean): void => {
    void api.updateSettings('perm', { readOnlyMode: next }).then((envelope) => {
      if (!envelope.ok) {
        addToast(`只读开关更新失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      void api.getEffectivePolicy().then((policy) => {
        if (!policy.ok) return;
        if (policy.data.readOnlyMode !== state.readOnly) toggleReadOnly();
        addToast(policy.data.readOnlyMode
          ? '只读模式已开启（只约束 Agent）'
          : '只读已关闭：Agent 写操作转为建议仍需你确认');
        refresh();
      });
    });
  };

  const handleButton = (row: SettingRow): void => {
    const action = row.control.action ?? '';
    const label = row.control.label ?? row.name;
    switch (action) {
      case 'confirm-clear':
        setModal({
          kind: 'confirm',
          title: '清除缓存',
          body: '将清空上下文快照与用量统计。会话、产物、审计日志与索引不受影响。确认继续？',
          confirmLabel: '确认清除',
          danger: true,
          onConfirm: () => {
            void api.clearCache().then((envelope) => {
              if (!envelope.ok) {
                addToast(`清除缓存失败：${envelope.error?.message ?? '未知错误'}`);
                return;
              }
              const { clearedSnapshots, clearedUsage } = envelope.data;
              addToast(`已清除上下文快照 ${clearedSnapshots} 条、用量统计 ${clearedUsage} 条 · 会话与产物未改动`);
              refresh();
            });
          },
        });
        return;
      case 'export-audit': {
        void api.exportAuditCsv({}).then((envelope) => {
          if (!envelope.ok) {
            const fallback = [
              '时间,操作人,动作,对象,结果',
              ...ORG_AUDIT.map((item) => [item.time, item.actor, item.action, item.target, item.result].join(',')),
            ].join('\r\n');
            downloadFile('devwork-audit.csv', `\uFEFF${fallback}`);
            addToast(`审计导出失败（${envelope.error?.message ?? '未知错误'}）· 已降级为离线快照`);
            return;
          }
          downloadFile(envelope.data.fileName, envelope.data.content);
          addToast('审计日志 CSV 已导出 · 导出动作已记入审计');
          refresh();
        });
        return;
      }
      case 'whitelist':
        void api.getCommandWhitelist().then((envelope) => {
          const list = envelope.ok ? envelope.data : [];
          const lines = list.length > 0
            ? list.map((item) => `· ${String((item as { prefix?: string; pattern?: string }).prefix ?? (item as { pattern?: string }).pattern ?? '')}`)
            : COMMAND_WHITELIST.map((item) => `· ${item.prefix}*`);
          setModal({
            kind: 'info',
            title: `命令白名单 · ${list.length || COMMAND_WHITELIST.length} 条只读命令`,
            body: lines.join('\n'),
            mono: true,
          });
        });
        return;
      case 'rules':
        /* 直接开编辑器。原来这里先弹一个只读 modal：看一眼规则数，再关掉，
         * 然后去别处找改的地方——而那个"别处"从来不存在。 */
        setModal({
          kind: 'rules',
          title: '敏感文件排除规则',
          onClose: () => setModal(null),
          onSaved: (count) => setEnv((prev) => ({ ...prev, sensitiveCount: count })),
        });
        return;
      case 'export-diag':
        /* B14：诊断内容从 /api/health 真实字段组装，不再写死。 */
        void api.health().then((envelope) => {
          if (!envelope.ok) {
            downloadFile('devwork-diagnostics.txt', 'DevWork 诊断\n后端：不可达（离线 Mock）', 'text/plain;charset=utf-8');
            addToast('诊断信息已导出（后端不可达）');
            return;
          }
          const h = envelope.data as unknown as {
            version?: string; node?: string; driver?: string; wal?: boolean;
            gitAvailable?: boolean; dockerAvailable?: boolean; port?: number;
          };
          const lines = [
            `DevWork ${h.version ?? '—'} 诊断报告`,
            `生成时间：${new Date().toLocaleString()}`,
            `后端端口：${h.port ?? '—'} · 状态：正常`,
            `Node：${h.node ?? '—'}`,
            `存储驱动：${h.driver ?? '—'} · WAL：${h.wal ? '已开启' : '未开启'}`,
            `Git：${h.gitAvailable ? '可用' : '不可用'} · Docker：${h.dockerAvailable ? '可用' : '不可用'}`,
            '',
            '（不含代码内容与凭据）',
          ];
          downloadFile('devwork-diagnostics.txt', lines.join('\n'), 'text/plain;charset=utf-8');
          addToast('诊断信息已导出（不含代码与凭据）');
        });
        return;
      case 'update':
        /* 私有分发没有更新通道：能诚实回答的是"前后端版本是否一致"，不编"已是最新"。 */
        void api.health().then((envelope) => {
          if (!envelope.ok) {
            addToast('检查更新：后端不可达，无法确认版本（离线 Mock 模式）');
            return;
          }
          const h = envelope.data as unknown as { version?: string; node?: string };
          const same = Boolean(h.version) && h.version === BUILD_VERSION;
          addToast(
            `当前前端 ${BUILD_VERSION} · 后端 ${h.version ?? '未知'}`
            + `${same ? '（一致）' : '（不一致，建议重启后端）'} · 私有分发，未接自动更新通道`,
          );
        });
        return;
      case 'open-logs':
        /* B14：真实打开系统日志目录（Electron 桥），Web 模式降级提示。 */
        if (window.desktop?.openLogs) {
          void window.desktop.openLogs().then((opened) => {
            addToast(opened ? '已打开日志目录' : '日志目录打开失败');
          });
        } else {
          addToast('日志目录：Web 预览模式无桌面桥，请用桌面端打开');
        }
        return;
      default:
        addToast(`${label}：操作已记录`);
    }
  };

  const renderControl = (row: SettingRow, sectionId: string): React.ReactNode => {
    const control = row.control;
    if (control.type === 'select') {
      return (
        <select
          className="sel"
          /* 主题是客户端偏好（localStorage），以 store 为准，不用服务端回填值，
             否则刷新后会出现"选的是深色、生效的是浅色"的错位。 */
          value={row.id === 'l1' ? THEME_LABEL[state.theme] : String(values[row.id] ?? control.value ?? '')}
          onChange={(event) => {
            const next = event.target.value;
            if (row.id === 'l1') {
              const theme = (Object.keys(THEME_LABEL) as Theme[]).find((key) => THEME_LABEL[key] === next) ?? 'system';
              setTheme(theme);
            }
            setValue(row.id, next, row.name, sectionId);
          }}
        >
          {(control.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }
    if (control.type === 'input') {
      return (
        <input
          className="sinput"
          value={String(values[row.id] ?? '')}
          onChange={(event) => setValue(row.id, event.target.value, row.name, sectionId)}
        />
      );
    }
    if (control.type === 'toggle') {
      const on = control.bindReadOnly ? state.readOnly : Boolean(values[row.id]);
      return (
        <button
          className={`toggle${on ? '' : ' off'}`}
          aria-label={row.name}
          onClick={() => {
            if (control.bindReadOnly) applyReadOnly(!on);
            else setValue(row.id, !on, row.name, sectionId);
          }}
        />
      );
    }
    return (
      <button className={`btn${control.danger ? ' danger' : ''}`} onClick={() => handleButton(row)}>
        {control.label ?? labelOf(control)}
      </button>
    );
  };

  /* ── 搜索：跨分区匹配行，命中结果按分区重新聚合 ── */
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return SETTINGS_SECTIONS.map((section) => {
      const extra = (SEARCH_EXTRA[section.id] ?? '').toLowerCase();
      const rows = section.rows.filter((row) => {
        if (extra.includes(q)) return true;
        return `${row.name} ${row.desc} ${row.id}`.toLowerCase().includes(q);
      });
      return { section, rows };
    }).filter((group) => group.rows.length > 0);
  }, [query, SETTINGS_SECTIONS]);

  const searching = query.trim().length > 0;
  const hitCount = (sectionId: string): number => hits.find((g) => g.section.id === sectionId)?.rows.length ?? 0;

  /* 分类状态点：橙 = 有需要处理的事，绿 = 已就绪。 */
  const sectionTone = (sectionId: string): 'warn' | 'ok' | '' => {
    if (sectionId === 'model') {
      if (env.modelCount === 0) return 'warn';
      return env.modelReady ? 'ok' : 'warn';
    }
    if (sectionId === 'perm') return state.readOnly ? 'ok' : '';
    return '';
  };

  /* 「关于」分区的说明改成运行时真值：版本、平台、日志路径都不写死。 */
  const rowDesc = (row: SettingRow): string => {
    if (row.id === 'a1') {
      return `前端 ${BUILD_VERSION} · 后端 ${env.backendVersion || '不可达'}`
        + `${env.nodeVersion ? ` · Node ${env.nodeVersion}` : ''}${env.driver ? ` · 存储 ${env.driver}` : ''}`;
    }
    if (row.id === 'a2') {
      return env.logsPath || '桌面端可打开此目录（当前环境无桌面桥，取不到真实路径）';
    }
    if (row.id === 'p4') {
      return env.sensitiveCount > 0
        ? `${env.sensitiveCount} 条规则，命中者不索引、不进入上下文`
        : '命中者不索引、不进入上下文';
    }
    if (row.id === 'p5') {
      return env.whitelistCount > 0
        ? `服务器终端可执行的 ${env.whitelistCount} 条只读命令`
        : '服务器终端可执行的只读命令';
    }
    return row.desc;
  };

  const jumpTo = (sectionId: string): void => {
    setScope('');
    setSettingsSection(sectionId);
  };

  const activeSection = SETTINGS_SECTIONS.find((s) => s.id === state.settingsSection) ?? SETTINGS_SECTIONS[0];

  return (
    <div className={`view${state.view === 'settings' ? ' on' : ''}`} data-view="settings">
      <div className="chead">
        <div className="ctitle">设置</div>
      </div>
      <div className="set">
        {/* ── 左：搜索 + 分类导航（带状态点与命中数） ── */}
        <div className="setnav">
          <div className="setsearch">
            <span className="setsearch-i" aria-hidden>
              <SearchIcon size={13} strokeWidth={1.5} />
            </span>
            <input
              className="setsearch-in"
              value={query}
              placeholder="搜索设置"
              onChange={(e) => setQuery(e.target.value)}
              spellCheck={false}
            />
            {searching ? (
              <button className="setsearch-x" onClick={() => { setQuery(''); setScope(''); }} aria-label="清空搜索">
                <CloseIcon size={12} strokeWidth={1.5} />
              </button>
            ) : null}
          </div>
          {SETTINGS_SECTIONS.map((section) => {
            const tone = sectionTone(section.id);
            const count = searching ? hitCount(section.id) : 0;
            const on = searching ? scope === section.id : state.settingsSection === section.id;
            return (
              <div
                className={`si${on ? ' on' : ''}${searching && count === 0 ? ' dim' : ''}`}
                data-s={section.id}
                key={section.id}
                onClick={() => {
                  if (searching) setScope(scope === section.id ? '' : section.id);
                  else setSettingsSection(section.id);
                }}
              >
                <span className="si-ic">{sectionIcon(section.id)}</span>
                <span className="si-l">{section.label}</span>
                {searching ? <span className="si-n">{count}</span> : tone ? <span className={`si-dot ${tone}`} title={tone === 'warn' ? '需要处理' : '已就绪'} /> : null}
              </div>
            );
          })}
        </div>

        <div className="setmain">
          {/* ── 状态总览：一眼看到「哪件事还没配好」，点一下直接跳过去 ── */}
          {!searching ? (
            <div className="setov">
              <OvTile
                k="只读模式"
                v={state.readOnly ? '开启' : '关闭'}
                s="只约束 Agent，不约束你"
                tone={state.readOnly ? 'ok' : 'warn'}
                onClick={() => jumpTo('perm')}
              />
              <OvTile
                k="模型"
                v={env.modelCount > 0 ? `${env.modelCount} 个已添加` : '未添加'}
                s={env.modelReady
                  ? `当前：${env.modelName}`
                  : env.modelCount > 0
                    ? `当前：${env.modelName || '—'} · 缺 Key`
                    : 'Agent 不产出结论'}
                tone={env.modelReady ? 'ok' : 'warn'}
                onClick={() => jumpTo('model')}
              />
              <OvTile
                k="Token 上限"
                v={String(values.maxTokens ?? '—')}
                s="单任务 max_tokens"
                onClick={() => jumpTo('model')}
              />
              <OvTile
                k="版本"
                v={env.offline ? '离线' : env.backendVersion}
                s={env.offline
                  ? '后端不可达 · 离线 Mock'
                  : `前端 ${BUILD_VERSION}${env.nodeVersion ? ` · Node ${env.nodeVersion.replace(/^v/, '')}` : ''}`}
                onClick={() => jumpTo('about')}
              />
            </div>
          ) : null}

          <div className="setbody">
            {searching ? (
              /* 搜索态：所有命中行按分区聚合，一屏看完全部匹配。 */
              hits.length === 0 ? (
                <div className="setempty">
                  <div className="setempty-t">没有匹配「{query.trim()}」的设置项</div>
                  <div className="setempty-d">换个关键词试试，或直接浏览左侧分类</div>
                </div>
              ) : (
                hits
                  .filter((group) => !scope || group.section.id === scope)
                  .map((group) => (
                    <div className="setsec on" data-s={group.section.id} key={group.section.id}>
                      <div className="stitle">{group.section.title}</div>
                      <div className="sdesc">{group.section.desc}</div>
                      {group.section.id === 'model' ? <ModelConfigCard values={values} setValue={setValue} /> : null}
                      {group.section.id === 'perm' ? <ToolFaceCard /> : null}
                      {group.section.id === 'perm' ? <BrowserPrivateRow /> : null}
                      {group.section.id === 'perm' ? <WebSearchRow /> : null}
                      {group.section.id === 'about' ? <AboutBoundaryRow /> : null}
                      {group.section.id === 'archive' ? <ArchiveManagerCard /> : null}
                      {group.rows
                        .filter((row) => !(group.section.id === 'model' && row.id === 'maxTokens'))
                        .map((row) => (
                          <div className="srow" key={row.id}>
                            <div className="sl">
                              <div className="sn">{row.name}</div>
                              <div className="sd2">{rowDesc(row)}</div>
                            </div>
                            <div className="sc">{renderControl(row, group.section.id)}</div>
                          </div>
                        ))}
                    </div>
                  ))
              )
            ) : (
              <div className="setsec on" data-s={activeSection.id}>
                <div className="stitle">{activeSection.title}</div>
                <div className="sdesc">{activeSection.desc}</div>
                {/* C1：模型分区用自配置卡片替代原内置模型下拉。
                    token 上限并进卡片，避免它孤零零挂在卡片外面。 */}
                {activeSection.id === 'model' ? <ModelConfigCard values={values} setValue={setValue} /> : null}
                {activeSection.id === 'perm' ? <ToolFaceCard /> : null}
                {activeSection.id === 'perm' ? <BrowserPrivateRow /> : null}
                {activeSection.id === 'perm' ? <WebSearchRow /> : null}
                {activeSection.id === 'about' ? <AboutBoundaryRow /> : null}
                {activeSection.id === 'archive' ? <ArchiveManagerCard /> : null}
                {activeSection.rows
                  .filter((row) => !(activeSection.id === 'model' && row.id === 'maxTokens'))
                  .map((row) => (
                    <div className="srow" key={row.id}>
                      <div className="sl">
                        <div className="sn">{row.name}</div>
                        <div className="sd2">{rowDesc(row)}</div>
                      </div>
                      <div className="sc">{renderControl(row, activeSection.id)}</div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 内网访问状态（只读一行，**始终渲染**，不是开关）。
 *
 * 为什么必须有这一行：`DEVWORK_BROWSER_ALLOW_PRIVATE=1` 会让 Agent 的内置浏览器
 * 能访问 127/10/172.16/192.168 与**本机无鉴权的服务**（Jupyter / Ollama / 各类 admin 面板）。
 * 只写 `desktop.log` 等于没告知 —— 用户不会去翻 `%APPDATA%\DevWork\logs\`，
 * 而"能读日志的人"和"需要被告知的人"不是同一批。
 *
 * 四条原则：
 *   ① 数据只从 `/api/health.browserAllowPrivate` 取，前端不自己读环境变量
 *      （前端进程根本拿不到后端的 env，读了必然错）；
 *   ② **始终渲染三态**：只在"已开启"时渲染的话，绝大多数用户永远看不到这一行，
 *      README 那句"设置页会显示当前状态"就只对少数人成立；复核时也分不清
 *      「找不到」与「没开启所以不显示」。
 *   ③ 拿不到值时显示「未获取到状态」，**不默认"未开启"** —— "未开启"是断言，
 *      后端不通时我们并不知道；这与 empty.ts 那套"宁可不显示也不糊假数据"一致。
 *   ④ 不做成可点击控件：打包态改不了环境变量，能点但点不动的按钮就是新的界面说谎。
 */
function BrowserPrivateRow(): React.ReactElement {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [offline, setOffline] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    void api.health().then((envelope) => {
      if (!alive) return;
      if (!envelope.ok) {
        setOffline(true);
        return;
      }
      /* browserAllowPrivate() 是每次调用读 env（config.ts 特意写在函数体里），
       * 所以这里拿到的是**实时值**，不存在"启动时算好之后不变"的陈旧问题。 */
      setEnabled(envelope.data.browserAllowPrivate);
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 三态文案定死（验收按这三条字面量核对）。 */
  const stateText = offline || enabled === undefined
    ? '内网访问：未获取到状态'
    : enabled
      ? '内网访问：已开启（由环境变量 DEVWORK_BROWSER_ALLOW_PRIVATE 提供）'
      : '内网访问：未开启（默认）';

  return (
    <div className="srow">
      <div className="sl">
        <div className="sn">{stateText}</div>
        <div className="sd2">
          Agent 浏览器工具默认不可访问本机与内网地址；如需自托管内网 Wiki 等场景，
          需在启动前设置该环境变量。
        </div>
      </div>
    </div>
  );
}

/**
 * 外部检索（web_search）的接入状态。
 *
 * 这一行的存在理由是"不能让用户以为搜不到是 Agent 笨"：
 * 没配 `DEVWORK_SEARCH_URL` 时 `web_search` 会明确报错并给替代路径，
 * 但如果界面上什么都不说，用户只会看到 Agent 反复说"抓不到"。
 *
 * 三态与 BrowserPrivateRow 同口径（始终渲染 / 拿不到就说不确定 / 不做成可点控件）：
 * 打包态改不了环境变量，能点但点不动的开关就是新的界面说谎。
 */
function WebSearchRow(): React.ReactElement {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [offline, setOffline] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    void api.health().then((envelope) => {
      if (!alive) return;
      if (!envelope.ok) {
        setOffline(true);
        return;
      }
      setEnabled(envelope.data.webSearch);
    });
    return () => {
      alive = false;
    };
  }, []);

  const stateText = offline || enabled === undefined
    ? '外部检索：未获取到状态'
    : enabled
      ? '外部检索：已接入（由环境变量 DEVWORK_SEARCH_URL 提供）'
      : '外部检索：未接入（web_search 会直接报错，只能用 web_fetch 打开已知地址）';

  return (
    <div className="srow">
      <div className="sl">
        <div className="sn">{stateText}</div>
        <div className="sd2">
          未接入搜索后端时，Agent 不会编造搜索结果，而是明确告诉你无法检索；
          需要该能力可在启动前设置 SearXNG 兼容的检索地址。
        </div>
      </div>
    </div>
  );
}

/**
 * 关于页的能力口径（只读两行，与 README「能力边界」逐字一致）。
 *
 * PRD P0-7 要求「README **与关于页**统一标注」，而关于页此前只有"版本、运行环境与诊断"，
 * 用户在本机唯一能看到"这版到底能干什么"的地方却什么都没说。
 *
 * 措辞是裁决过的对外口径：只说「受控写（实验性）」——
 * 不说"纯只读"（代码里确实能写），也不说"写能力已开放"（默认只读 + 中低风险 deny）。
 * 不做成可点控件：这里没有任何可设置的东西。
 */
function AboutBoundaryRow(): React.ReactElement {
  return (
    <div className="srow">
      <div className="sl">
        <div className="sn">能力：只读为主 + 写操作逐次人工批准（受控写 · 实验性）</div>
        <div className="sd2">写执行仅在显式批准的 plan 上生效，可回滚；默认只读模式开启</div>
      </div>
    </div>
  );
}

/** Agent 派生工具面诊断卡：当前工作区资产×能力×信任级别算出的工具清单。
 *  在「权限」分区展示 —— Agent 能用什么不该是黑盒，这里是黑盒的盖子。 */
function ToolFaceCard(): React.ReactElement {
  const [face, setFace] = useState<ToolFace | null>(null);
  const [offline, setOffline] = useState<boolean>(false);

  useEffect(() => {
    let alive = true;
    void api.getToolFace().then((envelope) => {
      if (!alive) return;
      if (envelope.ok) setFace(envelope.data);
      else setOffline(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (offline) {
    return (
      <div className="srow">
        <div className="sl">
          <div className="sn">Agent 工具面（派生）</div>
          <div className="sd2">后端不可达，无法读取派生工具面（离线模式不展示虚构清单）</div>
        </div>
      </div>
    );
  }
  if (!face) {
    return (
      <div className="srow">
        <div className="sl">
          <div className="sn">Agent 工具面（派生）</div>
          <div className="sd2">加载中…</div>
        </div>
      </div>
    );
  }
  const gated = face.all.filter((tool) => tool.gatedBy);
  return (
    <div className="srow">
      <div className="sl" style={{ maxWidth: 'none' }}>
        <div className="sn">Agent 工具面（派生）</div>
        <div className="sd2">
          工作区 {face.workspaceId}（trust={face.workspaceTrust}）· 按资产×能力×信任级别实时计算，
          共 {face.all.length} 个逻辑工具，{face.active.length} 个进入模型工具面
        </div>
        <pre style={{ fontSize: 11.5, lineHeight: 1.7, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
          {[
            `▸ 在工具面内（${face.active.length}）：`,
            ...face.active.map((tool) =>
              `  ${tool.name} — ${tool.assetName}[${tool.assetEnv}] · risk=${tool.risk}${tool.version ? ` · ${tool.version}` : ''}`),
            ...(gated.length > 0
              ? [`▸ 被剪枝（${gated.length}）：`,
                ...gated.map((tool) =>
                  `  ${tool.name} — ${tool.assetName}[${tool.assetEnv}] · 原因：${tool.gatedBy}`)]
              : []),
            '',
            '▸ 派生规则：',
            ...face.derivationRules.map((rule) => `  ${rule}`),
          ].join('\n')}
        </pre>
      </div>
    </div>
  );
}

/** ISO 时间 → 紧凑本地显示（归档列表用）。 */
function formatWhen(iso?: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', {
    hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * 会话归档管理：归档会话的唯一管理入口。
 *
 * 为什么归档不是删除：侧栏的「归档」只是收起（数据仍在、folder_id 保留），
 * 真正的终点在这里 —— 「恢复」回到原文件夹，「删除」才不可恢复。
 * 列表跨工作区：设置是全局入口，不该按工作区切来切去。
 */
function ArchiveManagerCard(): React.ReactElement {
  const { state, setModal, unarchiveConversation, removeConversation } = useStore();
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [offline, setOffline] = useState<boolean>(false);

  const load = React.useCallback(() => {
    setLoading(true);
    void api.listConversations(undefined, { archived: true }).then((envelope) => {
      setLoading(false);
      if (!envelope.ok) {
        setOffline(true);
        return;
      }
      setOffline(false);
      setItems(envelope.data ?? []);
    });
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const workspaceName = (workspaceId?: string | null): string =>
    state.projects.find((p) => p.id === workspaceId)?.name ?? workspaceId ?? '';

  /** 恢复：store 动作负责 PATCH + 刷侧栏，本地列表乐观移除。 */
  const restore = (item: Conversation): void => {
    unarchiveConversation(item.id);
    setItems((prev) => prev.filter((c) => c.id !== item.id));
  };

  const removeItem = (item: Conversation): void => {
    setModal({
      kind: 'confirm',
      title: '彻底删除会话',
      body: `删除「${item.title}」后不可恢复，消息记录一并移除。`,
      confirmLabel: '彻底删除',
      danger: true,
      onConfirm: () => {
        removeConversation(item.id);
        setItems((prev) => prev.filter((c) => c.id !== item.id));
      },
    });
  };

  return (
    <div>
      <div className="srow">
        <div className="sl" style={{ maxWidth: 'none' }}>
          <div className="sn">已归档会话{loading ? '' : `（${items.length}）`}</div>
          <div className="sd2">
            归档只是从侧栏收起，数据还在。恢复会回到原文件夹；删除则不可恢复。
          </div>
        </div>
      </div>
      {loading ? (
        <div className="srow">
          <div className="sl"><div className="sd2">加载中…</div></div>
        </div>
      ) : offline ? (
        <div className="srow">
          <div className="sl">
            <div className="sn">归档列表不可用</div>
            <div className="sd2">后端不可达，无法读取归档列表（离线模式不展示虚构清单）</div>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="srow">
          <div className="sl">
            <div className="sn">归档箱是空的</div>
            <div className="sd2">在侧栏会话的 ⋯ 菜单里选「归档」，会话就会收进这里。</div>
          </div>
        </div>
      ) : (
        items.map((item) => (
          <div className="srow" key={item.id}>
            <div className="sl">
              <div className="sn">{item.title}</div>
              <div className="sd2">
                归档于 {formatWhen(item.archivedAt)}
                {workspaceName(item.workspaceId) ? ` · ${workspaceName(item.workspaceId)}` : ''}
              </div>
            </div>
            <div className="sc" style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => restore(item)}>恢复</button>
              <button className="btn danger" onClick={() => removeItem(item)}>删除</button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** 状态总览里的一块：键 + 值 + 一句说明，可点击跳到对应分区。 */
function OvTile({
  k,
  v,
  s,
  tone = '',
  onClick,
}: {
  k: string;
  v: string;
  s: string;
  tone?: '' | 'ok' | 'warn';
  onClick: () => void;
}): React.ReactElement {
  return (
    <button className={`ovtile${tone ? ` ${tone}` : ''}`} onClick={onClick}>
      <div className="ovtile-k">{k}</div>
      <div className="ovtile-v">{v}</div>
      <div className="ovtile-s">{s}</div>
    </button>
  );
}

function labelOf(control: SettingRow['control']): string {
  return control.label ?? '打开';
}
