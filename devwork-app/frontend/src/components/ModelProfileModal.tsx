import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { LlmPreset } from '../api/types';

/** 表单草稿：一条模型档案的可见字段 + Key。 */
export interface ModelProfileDraft {
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * 模型档案表单弹窗（新增 / 编辑共用）。
 *
 * 为什么独立成弹窗而不是内联在列表下面：
 * 列表一长，内联表单就被推到屏幕外，"再加一个模型"的入口找不到了 ——
 * 而新增恰恰是最常做的动作。表单属于"一次性的输入过程"，
 * 列表属于"常驻的状态"，两者不该挤在同一屏里互相稀释。
 *
 * 视觉复用全局弹窗的骨架（.ovl / .modal），保证和确认框是同一套语言。
 */
export function ModelProfileModal({
  mode,
  initial,
  profileId,
  presets,
  busy = false,
  onClose,
  onSubmit,
}: {
  mode: 'add' | 'edit';
  initial?: ModelProfileDraft;
  /** 编辑中的档案 id：拉模型列表时用它自己的钥匙串 Key，不用再手填。 */
  profileId?: string;
  presets: LlmPreset[];
  busy?: boolean;
  onClose: () => void;
  onSubmit: (draft: ModelProfileDraft) => void;
}): React.ReactElement {
  const [provider, setProvider] = useState<string>(initial?.provider ?? 'custom');
  const [label, setLabel] = useState<string>(initial?.label ?? '');
  const [baseUrl, setBaseUrl] = useState<string>(initial?.baseUrl ?? '');
  const [model, setModel] = useState<string>(initial?.model ?? '');
  const [apiKey, setApiKey] = useState<string>('');
  const [error, setError] = useState<string>('');

  /* 端点实拉的模型列表（GET /models）：模型名写死会过时，列表以端点为准。 */
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelSource, setModelSource] = useState<'none' | 'live' | 'fallback'>('none');
  const [modelMsg, setModelMsg] = useState<string>('');
  const [fetchingModels, setFetchingModels] = useState(false);

  /* 每次打开重置成初始值：新增是空白，编辑是那条档案的现值。 */
  useEffect(() => {
    setProvider(initial?.provider ?? 'custom');
    setLabel(initial?.label ?? '');
    setBaseUrl(initial?.baseUrl ?? '');
    setModel(initial?.model ?? '');
    setApiKey('');
    setError('');
    setModelOptions([]);
    setModelSource('none');
    setModelMsg('');
  }, [initial]);

  const preset = presets.find((p) => p.id === provider);
  const options = presets.length > 0 ? presets : [{ id: 'custom', label: '自定义', baseUrl: '', models: [], keyUrl: '' }];

  /**
   * 从端点实拉模型列表。传参优先于 state —— setState 是异步的，
   * 选预设/进编辑的同一拍里读 state 拿到的还是旧值。
   */
  const fetchModels = (input?: { baseUrl?: string; provider?: string; profileId?: string }): void => {
    const presetId = input?.provider ?? provider;
    const found = presets.find((p) => p.id === presetId);
    const url = (input?.baseUrl ?? baseUrl).trim() || found?.baseUrl || '';
    if (!url) {
      setModelSource('fallback');
      setModelMsg('请先填写 API 端点再拉取模型列表');
      return;
    }
    setFetchingModels(true);
    void api.fetchLlmModels({
      baseUrl: url,
      provider: presetId,
      ...(input?.profileId ?? profileId ? { profileId: (input?.profileId ?? profileId) } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    }).then((envelope) => {
      setFetchingModels(false);
      if (!envelope.ok) {
        setModelOptions(found?.models ?? []);
        setModelSource('fallback');
        setModelMsg(envelope.error?.message ?? '端点拉取失败，显示预设推荐（可能过时）');
        return;
      }
      const data = envelope.data;
      setModelOptions(data.models);
      setModelSource(data.source);
      setModelMsg(data.message);
    });
  };

  /** 选预设：自动带出端点与推荐模型；名称没填过时用预设名兜底。 */
  const applyPreset = (id: string): void => {
    setProvider(id);
    setError('');
    const next = presets.find((p) => p.id === id);
    if (!next) return;
    if (next.baseUrl) setBaseUrl(next.baseUrl);
    if (next.models.length > 0) setModel(next.models[0]);
    if (!label.trim()) setLabel(next.label);
    /* 网关类预设（LiteLLM 等）没有静态模型名，列表完全靠端点实拉 —— 选中即拉。 */
    if (next.baseUrl) fetchModels({ baseUrl: next.baseUrl, provider: id });
  };

  const submit = (): void => {
    const url = baseUrl.trim() || preset?.baseUrl || '';
    if (!url) {
      setError('API 端点不能为空');
      return;
    }
    if (!model.trim()) {
      setError('模型名不能为空');
      return;
    }
    /* 端点实拉过列表时，手填的名字必须真在里面：否则第一次调用就是 400，
     * 而用户看到的只有「模型调用失败」，很难联想到是模型名写错。 */
    if (modelSource === 'live' && modelOptions.length > 0 && !modelOptions.includes(model.trim())) {
      setError(`该端点没有模型「${model.trim()}」，可选：${modelOptions.slice(0, 8).join(' / ')}`);
      return;
    }
    onSubmit({ label: label.trim(), provider, baseUrl: url, model: model.trim(), apiKey: apiKey.trim() });
  };

  /** 模型名输入框下方的说明：优先报端点实拉的结果，其次才是预设兜底。 */
  const modelHint = (): string => {
    if (modelSource === 'live') return `已从端点实拉 ${modelOptions.length} 个模型 · 列表以端点为准，新增模型自动出现`;
    if (modelSource === 'fallback') return modelMsg || '端点拉取失败，显示预设推荐（可能过时）';
    if (preset && preset.models.length > 0) return `预设兜底推荐（可能过时）：${preset.models.join(' / ')} · 建议「拉取模型列表」以端点为准`;
    return '填写模型 ID，或点「拉取模型列表」从端点实拉（LiteLLM 网关推荐）';
  };

  return (
    <div
      className="ovl ovl-form"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      /* Esc 关闭本弹窗：必须拦住，否则会冒泡到全局快捷键，把设置页直接退回会话。 */
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="modal modal-form" onMouseDown={(event) => event.stopPropagation()}>
        <h3>{mode === 'add' ? '新增模型' : '编辑模型'}</h3>
        <div className="mbody" style={{ marginBottom: 10 }}>
          {mode === 'add'
            ? '一条档案 = 一个模型 + 它自己的端点 + 它自己的 API Key。添加后可用「设为当前」启用。'
            : '改动立即生效。API Key 留空表示沿用已保存的那把。'}
        </div>

        <div className="mform">
          <div className="mfield">
            <label className="mfield-l">供应商预设</label>
            <select className="sel" value={provider} onChange={(e) => applyPreset(e.target.value)}>
              {options.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
            <div className="mfield-h">选择主流供应商自动填充端点与推荐模型；「自定义」可接入任意 OpenAI 兼容端点</div>
          </div>

          <div className="mfield">
            <label className="mfield-l">名称</label>
            <input
              className="minput"
              value={label}
              placeholder="留空则用模型名"
              onChange={(e) => setLabel(e.target.value)}
            />
            <div className="mfield-h">列表里显示的名字，便于区分同一供应商的多个模型</div>
          </div>

          <div className="mfield">
            <label className="mfield-l">API 端点（Base URL）</label>
            <input
              className="minput"
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <div className="mfield-h">OpenAI 兼容地址，不含 /chat/completions 后缀</div>
          </div>

          <div className="mfield">
            <label className="mfield-l">模型名称</label>
            <div className="mrow">
              <input
                className="minput"
                list="model-profile-models"
                value={model}
                placeholder="模型 ID"
                onChange={(e) => setModel(e.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    submit();
                  }
                }}
              />
              <button
                className="btn"
                onClick={() => fetchModels()}
                disabled={fetchingModels}
              >
                {fetchingModels ? '拉取中…' : '拉取模型列表'}
              </button>
            </div>
            <datalist id="model-profile-models">
              {(modelOptions.length > 0 ? modelOptions : (preset?.models ?? [])).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <div className="mfield-h">{modelHint()}</div>
          </div>

          <div className="mfield">
            <label className="mfield-l">API Key</label>
            <input
              className="minput"
              type="password"
              value={apiKey}
              placeholder="sk-..."
              autoComplete="off"
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  submit();
                }
              }}
            />
            <div className="mfield-h">
              {preset?.local
                ? '本地端点无需 Key，可留空'
                : preset?.keyUrl
                  ? `留空表示不修改已保存的 Key · 申请入口：${preset.keyUrl}`
                  : '留空表示不修改已保存的 Key'}
            </div>
          </div>

          {error ? <div className="mfield-err">{error}</div> : null}
        </div>

        <div className="mfoot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn p" onClick={submit} disabled={busy}>
            {busy ? '保存中…' : mode === 'add' ? '添加' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
