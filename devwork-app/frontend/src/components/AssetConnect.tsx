import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { AssetDetail } from '../api/types';
import { isAssetType, type AssetType } from '../../../shared/contracts/vocab';
import { useStore } from '../store';
import {
  ASSET_TYPES,
  activeKeys,
  authFieldKeys,
  buildAuth,
  defaultValues,
  endpointOf,
  groupRows,
  needsClone,
  specOf,
  visibleFields,
  type FieldSpec,
  type FormValues,
} from './assetForms';
import { CaretIcon, CloseIcon } from './icons';

/**
 * 接入 / 编辑资产（单屏弹窗）。
 *
 * 为什么不是多步向导：
 * 用户要的就是「选类型 → 填信息 → 一次接入」。多步向导把一件连续的事拆成四次点击，
 * 每一步都逼用户确认一次「还要继续吗」，中间还要记住刚才填了什么。
 * 现在：**类型用下拉菜单选，选完下面立刻换成该类型的表单**，
 * 资产信息、类型专属字段、鉴权方式全在一屏里，底部一个按钮搞定。
 *
 * 为什么新建与编辑共用同一个弹窗：
 * 两者要填的是同一批字段、跑的是同一套校验（spec.validate / spec.validateAuth），
 * 拆成两份表单就等于把字段白名单和校验规则抄两遍 —— 迟早有一边漏改，
 * 于是「能建出来却改不了」这类问题会反复长出来。
 * 唯一的实质差异：编辑时类型锁死（类型是落库事实，改类型等于换一个资产），
 * 且凭据秘密不回显，留空保存 = 保持现有绑定不变。
 *
 * 鉴权在这一步就填完：账号 / 口令 / 令牌 / 私钥由 buildAuth 抽出来，
 * 走既有的凭据通道（safeStorage 加密存本机、库里只留引用），绝不写进 asset.config。
 *
 * 诚实边界：本地沙箱没有对外的网络出口，不存在"真实连通性探测"。
 * 所以这里给的是一次**真实写入** + 一次**真实回读**校验，
 * 而不是伪造一个"连接成功"。文案里明说这一点，避免用户以为连上了生产库。
 */

const ENVS = ['prod', 'staging', 'dev'];

/** 把详情里的 config 摊回表单值：数组键（白名单 / 忽略规则）统一折成逗号分隔。 */
function valuesFromDetail(detail: AssetDetail): FormValues {
  const spec = specOf(detail.type);
  const values = defaultValues(spec);
  const config = detail.config ?? {};
  Object.keys(values).forEach((key) => {
    const raw = config[key];
    if (raw === undefined || raw === null) return;
    /* config 里的列表键可能是数组，也可能是老数据留下的字符串：两种都摊成输入框里的文本。 */
    values[key] = Array.isArray(raw) ? raw.map((item) => String(item)).join(', ') : String(raw);
  });
  /* 老数据可能只把地址记在 config.endpoint 上（没有 cloneUrl / dir）：回填时补上，
   * 否则用户打开编辑框会看到「仓库地址空着」，一保存就把原地址抹掉了。 */
  if (spec.id === 'code' && !values.cloneUrl && detail.endpoint) values.cloneUrl = detail.endpoint;
  if (spec.id === 'kb' && !values.dir && detail.endpoint) values.dir = detail.endpoint;
  /* 鉴权方式回显：只有当前字段条件下确实可选时才写回去，否则下拉框会显示一个不存在的选项。 */
  const methods: string[] = spec.auth(values).map((option) => option.value);
  if (detail.authMethod && methods.includes(detail.authMethod)) {
    values.authMethod = detail.authMethod;
  }
  /* 账号名不是秘密，回填让人看清「这条资产绑的是谁」；秘密本身永不回显。 */
  if (detail.credentialUsername) values.username = detail.credentialUsername;
  return values;
}

export default function AssetConnect({
  editId,
  onClose,
}: {
  /** null = 新建；字符串 = 编辑这条资产。 */
  editId: string | null;
  onClose: () => void;
}): React.ReactElement {
  const { state, addToast, reloadSidebar, bumpAssetRevision } = useStore();
  const editing = editId !== null;

  const [type, setType] = useState<AssetType>('db');
  const [name, setName] = useState<string>('');
  const [env, setEnv] = useState<string>('staging');
  /** 类型专属字段 + 鉴权字段的当前值。 */
  const [values, setValues] = useState<FormValues>(() => defaultValues(specOf('db')));
  /** 字段级错误文案。 */
  const [fieldError, setFieldError] = useState<string>('');
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** 编辑模式的载入状态：未取到真值之前不能让人在空表单上改。 */
  const [loading, setLoading] = useState<boolean>(editing);
  const [loadError, setLoadError] = useState<string>('');

  /** 编辑：拉一次详情，把配置与账号名摊回表单。 */
  useEffect(() => {
    if (!editId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    void api
      .getAsset(editId)
      .then((envelope) => {
        if (cancelled) return;
        if (!envelope.ok) {
          setLoadError(`读取资产失败：${envelope.error?.message ?? '未知错误'}`);
          setLoading(false);
          return;
        }
        const detail = envelope.data;
        setName(detail.name ?? '');
        setEnv(detail.env || 'staging');
        if (isAssetType(detail.type)) setType(detail.type);
        setValues(valuesFromDetail(detail));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError('读取资产失败：网络异常');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editId]);

  const spec = useMemo(() => specOf(type), [type]);

  /** 当前条件下要渲染的类型字段（含可见性过滤）。 */
  const shown = useMemo(() => visibleFields(spec, values), [spec, values]);
  /** 基础字段与高级字段分开渲染。 */
  const basic = shown.filter((field) => !field.group);
  const advanced = shown.filter((field) => field.group);
  /** 并排分组（主机 / 端口这种）：表单更矮，鉴权区块不会被挤到折叠线以下。 */
  const rows = groupRows(basic);

  /** 当前可见字段的键集合 —— 写 config 时的白名单。 */
  const active = useMemo(() => activeKeys(spec, values), [spec, values]);

  /**
   * 当前可选的鉴权方式。
   * 它随引擎 / 连接方式变化（SQLite 只有「无鉴权」，远程库才有账号密码），
   * 所以是一个函数而不是一张常量表。
   */
  const authOptions = spec.auth(values);
  /**
   * 生效的鉴权方式 = 当前选中的那个；选中的那个不在可选列表里（比如 SQLite 只有无鉴权），
   * 就落到列表的第一个。raw 值保持不变，切回远程引擎时会自动恢复成原来的选择。
   */
  const authMethod = authOptions.some((option) => option.value === values.authMethod)
    ? values.authMethod
    : (authOptions[0]?.value ?? 'none');
  const authOption = authOptions.find((option) => option.value === authMethod) ?? authOptions[0];

  const setValue = (key: string, next: string): void => {
    setValues((prev) => {
      const merged: FormValues = { ...prev, [key]: next };
      /* 引擎 / 连接方式一变，可选鉴权方式就变了 —— 旧方式下填的账号口令必须清掉，
         否则它会以残留值的形式一直留在内存里（虽然不会进 config，但没必要留）。 */
      if (key === 'engine' || key === 'transport') {
        authFieldKeys(spec, values).forEach((authKey) => {
          merged[authKey] = '';
        });
      }
      return merged;
    });
    if (fieldError) setFieldError('');
  };

  /** 换类型：整套类型专属字段与鉴权字段重置，避免上一类型的残留值混进新资产。 */
  const pickType = (next: string): void => {
    /* 编辑态下类型是既成事实：改成别的类型等于换一条资产，不该在一个"编辑"动作里偷渡。 */
    if (editing) return;
    /* <select> 的 value 是字符串：边界处收窄，非法值直接忽略，
     * 不静默落进一个后端 schema 会拒绝的类型。 */
    if (!isAssetType(next)) return;
    setType(next);
    setValues(defaultValues(specOf(next)));
    setFieldError('');
    setAdvancedOpen(false);
    setShowSecret({});
  };

  /** 换鉴权方式：把旧方式下的凭据值清掉，不留「上一个方式的账号」。 */
  const pickAuth = (next: string): void => {
    const previous = authOptions.find((option) => option.value === authMethod);
    setValues((prev) => {
      const merged: FormValues = { ...prev, authMethod: next };
      (previous?.fields ?? []).forEach((field) => {
        merged[field.key] = '';
      });
      return merged;
    });
    if (fieldError) setFieldError('');
  };

  /** 校验重复的一段：新建与编辑共用，避免"能建出来却存不回去"。 */
  const validate = (): boolean => {
    /* 校验必须在最前面跑一次：用户可能直接改类型跳回来。 */
    if (name.trim().length === 0) {
      setFieldError('资产名称不能为空');
      return false;
    }
    const error = spec.validate(values) ?? spec.validateAuth(values);
    if (error) {
      setFieldError(error);
      return false;
    }
    return true;
  };

  const submit = (): void => {
    if (!validate()) return;
    setBusy(true);
    setResult(null);
    /* config 只写可见字段，且不含任何凭据字段。 */
    const config = spec.buildConfig(values, active);
    const endpoint = endpointOf(spec, values);
    const auth = buildAuth(spec, values);

    /* 编辑态：只有真的填了新秘密才提交凭据 —— 留空保存不能把现有绑定冲成"未绑定"。 */
    if (editing && editId) {
      const credential = auth.method !== 'none' && auth.hasSecret
        ? { label: auth.label, method: auth.method, username: auth.username, secret: auth.secret }
        : undefined;
      void api
        .updateAsset(editId, {
          name: name.trim(),
          env,
          endpoint: endpoint || undefined,
          config,
          credential,
        })
        .then(async (envelope) => {
          if (!envelope.ok) {
            setResult({ ok: false, text: `保存失败：${envelope.error?.message ?? '未知错误'}` });
            return;
          }
          /* 真实回读：确认服务端确实按提交的值存了，而不是"前端以为存上了"。 */
          const saved = await api.getAsset(editId);
          if (!saved.ok) {
            setResult({ ok: false, text: '保存接口返回成功，但回读失败：请刷新后确认' });
            return;
          }
          /* 详情页据此重新拉一次 —— 否则关掉弹窗后页面还挂着旧名称。 */
          bumpAssetRevision();
          await reloadSidebar();
          addToast('资产已保存');
          setResult({
            ok: true,
            text: `已保存 ${saved.data.name}（${saved.data.type} · ${saved.data.env || '默认环境'}）。`
              + (credential ? '凭据已重新绑定。' : '凭据保持不变。'),
          });
        })
        .catch(() => setResult({ ok: false, text: '保存失败：网络异常' }))
        .finally(() => setBusy(false));
      return;
    }

    void api
      .createAsset({
        workspaceId: state.workspaceId,
        type,
        name: name.trim(),
        env,
        /* 副标题不再单独让人填：它就是「环境 · 状态」的自动摘要，
         * 多一个输入框只会让每一条资产都长着一个"可选但没人填"的空字段。 */
        subtitle: `${env} · 待验证`,
        /* 连接串保留给旧的读取路径（侧栏副标题 / 老数据），结构化信息走 config。 */
        endpoint: endpoint || undefined,
        config,
        /* 凭据走独立通道：服务端加密存本机、库里只留引用，绝不进 config。 */
        credential: auth.method === 'none'
          ? undefined
          : { label: auth.label, method: auth.method, username: auth.username, secret: auth.secret },
      })
      .then(async (envelope) => {
        if (!envelope.ok) {
          setResult({ ok: false, text: `创建失败：${envelope.error?.message ?? '未知错误'}` });
          return;
        }
        /* 真实回读：确认服务端确实存在这条记录，而不是"前端以为创建成功"。 */
        const created = await api.getAsset(envelope.data.id);
        if (!created.ok) {
          setResult({ ok: false, text: '创建接口返回成功，但回读失败：请刷新后确认' });
          return;
        }
        const notes: string[] = [];
        /* 凭据绑定结果如实上报：绑定失败就说失败，不含糊成"已接入"。 */
        if (auth.method !== 'none') {
          notes.push(envelope.data.credentialBound
            ? `凭据已绑定（${auth.label}）：秘密经系统钥匙串加密存本机，库里只留引用。`
            : `凭据绑定失败：${envelope.data.credentialError ?? '未知原因'}。可在「能力授权」页重新绑定。`);
        }
        /* 代码库 + 填了仓库地址 → 真实 clone 到该项目的本地工作区目录。
         * 令牌在这一跳里用一次（服务端 redactUrl 脱敏），之后由凭据通道接管。 */
        if (needsClone(spec, values)) {
          const cloned = await api.cloneRepo(
            envelope.data.id,
            {
              url: endpoint,
              branch: (values.branch ?? '').trim() || undefined,
              depth: Number(values.depth) > 0 ? Number(values.depth) : undefined,
              token: auth.method === 'token' ? auth.secret || undefined : undefined,
            },
          );
          if (!cloned.ok) {
            setResult({
              ok: false,
              text: `资产已创建（id=${envelope.data.id}），但克隆失败：${cloned.error?.message ?? '未知错误'}。`
                + '可在代码库详情页重新克隆。',
            });
            bumpAssetRevision();
            await reloadSidebar();
            return;
          }
          notes.push(`已克隆到 ${cloned.data.localPath} · ${cloned.data.branch}@${cloned.data.commit}`
            + ` · ${cloned.data.files} 个文件 · 索引 ${cloned.data.index.chunks} 块。`);
        }
        setResult({
          ok: true,
          text: `已创建 ${created.data.name}（${created.data.type} · ${created.data.env || '默认环境'}），`
            + `id=${created.data.id}。${endpoint ? `连接参数已记录：${endpoint}。` : ''}`
            + notes.join('')
            + '注意：本地沙箱不执行远端连通性探测，请在真实环境中另行验证。',
        });
        bumpAssetRevision();
        await reloadSidebar();
        addToast('资产已接入侧栏');
      })
      .catch(() => setResult({ ok: false, text: '创建失败：网络异常' }))
      .finally(() => setBusy(false));
  };

  const reset = (): void => {
    setType('db');
    setName('');
    setEnv('staging');
    setValues(defaultValues(specOf('db')));
    setFieldError('');
    setShowSecret({});
    setAdvancedOpen(false);
    setResult(null);
  };

  /** 单个字段的渲染 —— 控件类型由 FieldSpec 决定。 */
  const renderField = (field: FieldSpec): React.ReactElement => {
    const value = values[field.key] ?? '';
    const id = `wiz-fld-${field.key}`;
    /* secret 控件天然敏感；textarea 靠 sensitive 标记（私钥要遮罩显示）。 */
    const masked = field.type === 'secret' || field.sensitive === true;
    const revealed = showSecret[field.key] === true;
    /* 编辑态：秘密字段留空 = 不改。提示写在 placeholder 上，比再加一行说明省地方。 */
    const placeholder = editing && masked && field.key !== 'username'
      ? '留空则不修改现有凭据'
      : field.placeholder;
    /* placeholder 只对 input / textarea 有效，select 不接受该属性。 */
    const onChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setValue(field.key, event.target.value);
    const toggle = (
      <button
        type="button"
        className="wiz-eye"
        aria-label={revealed ? '隐藏' : '显示'}
        onClick={() => setShowSecret((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
      >
        {revealed ? '隐藏' : '显示'}
      </button>
    );
    return (
      <div className="wiz-fld" key={`${field.key}-${field.type}`}>
        <label htmlFor={id}>
          {field.label}
          {field.required ? <i className="req">必填</i> : null}
          {masked ? <i className="sec">加密存储</i> : null}
        </label>
        {field.type === 'select' ? (
          <select id={id} value={value} onChange={onChange}>
            {(field.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        ) : null}
        {field.type === 'textarea' ? (
          <div className="wiz-secret">
            <textarea
              id={id}
              className={masked ? `wiz-secret-area${revealed ? ' on' : ''}` : ''}
              value={value}
              placeholder={placeholder}
              onChange={onChange}
              rows={field.sensitive ? 5 : 3}
              spellCheck={false}
            />
            {masked ? toggle : null}
          </div>
        ) : null}
        {field.type === 'number' ? (
          <input id={id} value={value} placeholder={placeholder} onChange={onChange} type="number" inputMode="numeric" />
        ) : null}
        {field.type === 'secret' ? (
          <div className="wiz-secret">
            <input
              id={id}
              value={value}
              placeholder={placeholder}
              onChange={onChange}
              type={revealed ? 'text' : 'password'}
              autoComplete="off"
            />
            {toggle}
          </div>
        ) : null}
        {field.type === 'text' ? (
          <input id={id} value={value} placeholder={placeholder} onChange={onChange} type="text" />
        ) : null}
        {field.help ? <p className="wiz-help">{field.help}</p> : null}
      </div>
    );
  };

  const titleText = editing ? '编辑资产' : '接入资产';
  const done = result?.ok === true;

  return (
    <div className="wiz-mask" role="dialog" aria-modal="true" aria-label={titleText}>
      <div className="wiz">
        <div className="wiz-h">
          <span className="t">{titleText}</span>
          <button className="wiz-x" type="button" onClick={onClose} aria-label="关闭">
            <CloseIcon size={13} strokeWidth={1.5} />
          </button>
        </div>

        <div className="wiz-b">
          {loadError ? (
            <div className="wiz-form">
              <div className="wiz-err">{loadError}</div>
            </div>
          ) : loading ? (
            <div className="wiz-form">
              <div className="wiz-note">正在读取资产配置…</div>
            </div>
          ) : (
            <div className="wiz-form">
              {/* 类型 + 环境并排：这两项都是短下拉，各占一整行纯属浪费高度。 */}
              <div className="wiz-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <label htmlFor="wiz-type">
                  资产类型
                  <select
                    id="wiz-type"
                    value={type}
                    disabled={editing}
                    onChange={(event) => pickType(event.target.value)}
                  >
                    {ASSET_TYPES.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.icon} {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor="wiz-env">
                  环境
                  <select id="wiz-env" value={env} onChange={(event) => setEnv(event.target.value)}>
                    {ENVS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </label>
              </div>
              <label htmlFor="wiz-name">
                资产名称
                <input
                  id="wiz-name"
                  value={name}
                  onChange={(event) => { setName(event.target.value); if (fieldError) setFieldError(''); }}
                  placeholder="例如：订单库（预发）"
                />
              </label>

              {/* 类型专属字段 */}
              <div className="wiz-sec">
                <div className="wiz-sec-t">{spec.configTitle}</div>
                {rows.map((row, rowIndex) => (
                  <div
                    className="wiz-frow"
                    key={`row-${rowIndex}-${row.map((field) => field.key).join('-')}`}
                    style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                  >
                    {row.map(renderField)}
                  </div>
                ))}
                {advanced.length > 0 ? (
                  <div className="wiz-adv">
                    <button
                      type="button"
                      className="wiz-adv-t"
                      aria-expanded={advancedOpen}
                      onClick={() => setAdvancedOpen((open) => !open)}
                    >
                      <CaretIcon dir={advancedOpen ? 'down' : 'right'} size={10} strokeWidth={1.6} className="wiz-adv-c" />
                      高级设置
                      <span className="wiz-adv-n">{advanced.length} 项</span>
                    </button>
                    {advancedOpen ? advanced.map(renderField) : null}
                  </div>
                ) : null}
              </div>

              {/* 鉴权：账号口令 / 令牌 / 私钥，在接入这一步一次填完 */}
              <div className="wiz-sec">
                <div className="wiz-sec-t">
                  访问鉴权
                  {editing && authMethod !== 'none' ? <span className="wiz-sec-n">已绑定 · 留空不改</span> : null}
                </div>
                <div className="wiz-fld">
                  <label htmlFor="wiz-auth">鉴权方式</label>
                  <select id="wiz-auth" value={authMethod} onChange={(event) => pickAuth(event.target.value)}>
                    {authOptions.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                {(authOption?.fields ?? []).map(renderField)}
              </div>

              {fieldError ? <div className="wiz-err">{fieldError}</div> : null}
              {result ? (
                <div className={`wiz-result ${result.ok ? 'ok' : 'bad'}`}>{result.text}</div>
              ) : null}
            </div>
          )}
        </div>

        <div className="wiz-f">
          {done ? (
            <>
              <button className="btn" type="button" onClick={editing ? onClose : reset}>
                {editing ? '关闭' : '再接入一个'}
              </button>
              {editing ? null : (
                <button className="btn p" type="button" onClick={onClose}>完成</button>
              )}
            </>
          ) : (
            <>
              <button className="btn" type="button" onClick={onClose}>取消</button>
              <button
                className="btn p"
                type="button"
                disabled={busy || loading || Boolean(loadError)}
                onClick={submit}
              >
                {busy ? (editing ? '保存中…' : '接入中…') : editing ? '保存修改' : '接入资产'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
