import React, { useMemo, useState } from 'react';
import { api } from '../api/client';
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
  type AssetTypeSpec,
  type FieldSpec,
  type FormValues,
} from './assetForms';
import { AssetIcon, CaretIcon, CloseIcon } from './icons';

/**
 * 接入资产（单屏弹窗）。
 *
 * 为什么不是多步向导：
 * 用户要的就是「选类型 → 填信息 → 一次接入」。多步向导把一件连续的事拆成四次点击，
 * 每一步都逼用户确认一次「还要继续吗」，中间还要记住刚才填了什么。
 * 现在：**类型用下拉菜单选，选完下面立刻换成该类型的表单**，
 * 资产信息、类型专属字段、鉴权方式全在一屏里，底部一个「接入资产」按钮搞定。
 *
 * 鉴权在这一步就填完：账号 / 口令 / 令牌 / 私钥由 buildAuth 抽出来，
 * 走既有的凭据通道（safeStorage 加密存本机、库里只留引用），绝不写进 asset.config。
 *
 * 诚实边界：本地沙箱没有对外的网络出口，不存在"真实连通性探测"。
 * 所以这里给的是一次**真实写入**（POST /api/assets）+ 一次**真实回读**校验，
 * 而不是伪造一个"连接成功"。文案里明说这一点，避免用户以为连上了生产库。
 */

const ENVS = ['prod', 'staging', 'dev'];

export default function AssetConnect({ onClose }: { onClose: () => void }): React.ReactElement {
  const { state, addToast, reloadSidebar } = useStore();
  const [type, setType] = useState<AssetType>('db');
  const [name, setName] = useState<string>('');
  const [env, setEnv] = useState<string>('staging');
  const [subtitle, setSubtitle] = useState<string>('');
  /** 类型专属字段 + 鉴权字段的当前值。 */
  const [values, setValues] = useState<FormValues>(() => defaultValues(specOf('db')));
  /** 字段级错误文案。 */
  const [fieldError, setFieldError] = useState<string>('');
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

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

  const submit = (): void => {
    /* 校验必须在最前面跑一次：用户可能直接改类型跳回来。 */
    if (name.trim().length === 0) {
      setFieldError('资产名称不能为空');
      return;
    }
    const error = spec.validate(values) ?? spec.validateAuth(values);
    if (error) {
      setFieldError(error);
      return;
    }
    setBusy(true);
    setResult(null);
    /* config 只写可见字段，且不含任何凭据字段。 */
    const config = spec.buildConfig(values, active);
    const endpoint = endpointOf(spec, values);
    const auth = buildAuth(spec, values);
    void api
      .createAsset({
        workspaceId: state.workspaceId,
        type,
        name: name.trim(),
        env,
        subtitle: subtitle.trim() || `${env} · 待验证`,
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
    setSubtitle('');
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
              placeholder={field.placeholder}
              onChange={onChange}
              rows={field.sensitive ? 5 : 3}
              spellCheck={false}
            />
            {masked ? toggle : null}
          </div>
        ) : null}
        {field.type === 'number' ? (
          <input id={id} value={value} placeholder={field.placeholder} onChange={onChange} type="number" inputMode="numeric" />
        ) : null}
        {field.type === 'secret' ? (
          <div className="wiz-secret">
            <input
              id={id}
              value={value}
              placeholder={field.placeholder}
              onChange={onChange}
              type={revealed ? 'text' : 'password'}
              autoComplete="off"
            />
            {toggle}
          </div>
        ) : null}
        {field.type === 'text' ? (
          <input id={id} value={value} placeholder={field.placeholder} onChange={onChange} type="text" />
        ) : null}
        {field.help ? <p className="wiz-help">{field.help}</p> : null}
      </div>
    );
  };

  return (
    <div className="wiz-mask" role="dialog" aria-modal="true" aria-label="接入资产">
      <div className="wiz">
        <div className="wiz-h">
          <span className="t">接入资产</span>
          <span className="s">选类型 → 填信息 → 一次接入</span>
          <button className="wiz-x" type="button" onClick={onClose} aria-label="关闭">
            <CloseIcon size={13} strokeWidth={1.5} />
          </button>
        </div>

        <div className="wiz-b">
          {/* 类型选择：下拉菜单。选完下面立刻换成该类型的表单 —— 没有"下一步"。 */}
          <div className="wiz-top">
            <label className="wiz-tp" htmlFor="wiz-type">
              <span>资产类型</span>
              <select id="wiz-type" value={type} onChange={(event) => pickType(event.target.value)}>
                {ASSET_TYPES.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            <p className="wiz-td">
              <i className="ic">
                <AssetIcon type={spec.id} glyph={spec.icon} size={13} strokeWidth={1.4} />
              </i>
              {spec.desc}
            </p>
          </div>

          <div className="wiz-form">
            <label htmlFor="wiz-name">
              资产名称
              <input
                id="wiz-name"
                value={name}
                onChange={(event) => { setName(event.target.value); if (fieldError) setFieldError(''); }}
                placeholder="例如：订单库（预发）"
              />
            </label>
            <div className="wiz-row">
              <label htmlFor="wiz-env">
                环境
                <select id="wiz-env" value={env} onChange={(event) => setEnv(event.target.value)}>
                  {ENVS.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label htmlFor="wiz-subtitle">
                副标题（可选）
                <input
                  id="wiz-subtitle"
                  value={subtitle}
                  onChange={(event) => setSubtitle(event.target.value)}
                  placeholder="例如：PG 15 · 只读账号"
                />
              </label>
            </div>

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
              <div className="wiz-sec-t">鉴权方式</div>
              <div className="wiz-fld">
                <label htmlFor="wiz-auth">鉴权方式</label>
                <select id="wiz-auth" value={authMethod} onChange={(event) => pickAuth(event.target.value)}>
                  {authOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              {(authOption?.fields ?? []).map(renderField)}
              {authOption?.note ? <p className="wiz-help">{authOption.note}</p> : null}
            </div>

            {fieldError ? <div className="wiz-err">{fieldError}</div> : null}
            <div className="wiz-note">{spec.configNote}</div>
            {result ? (
              <div className={`wiz-result ${result.ok ? 'ok' : 'bad'}`}>{result.text}</div>
            ) : null}
          </div>
        </div>

        <div className="wiz-f">
          <button className="btn" type="button" onClick={result?.ok ? reset : onClose}>
            {result?.ok ? '再接入一个' : '取消'}
          </button>
          <button className="btn p" type="button" disabled={busy} onClick={result?.ok ? onClose : submit}>
            {busy ? '接入中…' : result?.ok ? '完成' : '接入资产'}
          </button>
        </div>
      </div>
    </div>
  );
}
