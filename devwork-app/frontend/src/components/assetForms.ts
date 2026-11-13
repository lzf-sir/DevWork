/**
 * 资产类型注册表 —— 接入表单从「资产类型」派生，而不是写在组件的 if-else 里。
 *
 * 设计要点（四条，缺一不可）：
 *
 * 1. **类型决定字段结构，不只是文案。** 每种资产类型自带一份 FieldSpec 列表：
 *    字段、控件类型、必填、默认值、条件显隐、帮助文案。新增资产类型 = 往注册表加一条数据，
 *    不用改渲染器，也不用改组件里的分支判断。
 *
 * 2. **字段对齐「后端已经认的 config 键」。** 不另造概念：
 *    - code  → cloneUrl / branch / depth（workspace-repos.ts 写的就是这几个键）
 *    - db    → dbPath / engine（repositories.ts 详情页读的就是 config.dbPath）
 *    - kb    → dir / indexMode / chunkSize
 *    - server→ transport / host / port / user / workdir
 *
 * 3. **凭据走独立通道，绝不进 config。** 账号、密码、令牌、私钥都**不**写进 asset.config：
 *    服务端的 SENSITIVE_KEY_PATTERNS 会把 token / password / secret / auth 这类键名直接丢弃，
 *    即使前端漏了这一层也进不了库。凭据只经 buildAuth() 抽出来，交给凭据通道
 *    （credential_binding + safeStorage 加密存本机，库里只留引用）。
 *
 * 4. **鉴权方式随上下文变化。** 同一个「数据库」类型，SQLite 是本地文件（没有账号密码），
 *    远程库才有。所以「可选项」是一个函数 auth(values) 而不是一张常量表：
 *    选了 SQLite 就只剩「无鉴权」，选了 PostgreSQL 才出现账号密码 / 令牌。
 *
 * 诚实边界：表单登记的是**目标接入形态**。当前本地沙箱里，
 *   - code  → 真实 git clone + 真实索引（配置立即生效；令牌真的会注入 clone URL）
 *   - kb    → 真实扫描目录重建索引（配置立即生效）
 *   - db    → SQL 页固定读演示库 demo.sqlite，登记的库信息暂不驱动查询
 *   - server→ 命令执行跑在本地沙箱，登记的主机信息暂不建立远程会话
 * 每种类型的 configNote 都如实写明这一点，避免用户以为填了就等于连上了。
 */

import type { AssetType } from '../../../shared/contracts/vocab';

export type FieldType = 'text' | 'number' | 'select' | 'textarea' | 'secret';

export interface FieldOption {
  value: string;
  label: string;
}

/** 单个显隐条件：某个字段等于某个值。 */
export interface FieldCondition {
  key: string;
  equals: string;
}

/**
 * 条件显隐规则。
 *
 * 为什么分成 all / any 两组？
 *   - 「密码框只在【选了账号密码】时出现」是单条件；
 *   - 「主机框在【是 PostgreSQL】或【是 MySQL】时出现」是 OR；
 *   - 「口令框在【选了账号密码】且【是远程引擎】时出现」是 AND。
 * 写成 {key,equals} 是简写，等价于 {all:[…]}。
 */
export interface VisibilityRule {
  all?: FieldCondition[];
  any?: FieldCondition[];
}

export type VisibleWhen = FieldCondition | VisibilityRule;

/** 鉴权方式。none = 明确不需要凭据（本地文件 / 公开仓库）。 */
export type AuthMethod = 'password' | 'token' | 'sshkey' | 'none';

export interface FieldSpec {
  /** 字段键。落 config 的键名 —— 凭据字段除外（它们不进 config）。 */
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  /** 字段下方的说明。写清楚「填了会发生什么」，而不是复述标签。 */
  help?: string;
  required?: boolean;
  options?: FieldOption[];
  defaultValue?: string;
  /** 条件显隐。 */
  visibleWhen?: VisibleWhen;
  /**
   * 敏感值：绝不进 asset.config，只能进凭据通道（safeStorage 加密存本机）。
   * type:'secret' 天然敏感；textarea 类型的私钥靠这个标记。
   */
  sensitive?: boolean;
  /**
   * 并排分组：同一行内共用一个分组键的字段会并排显示（主机 / 端口这种）。
   * 目的是让表单更矮 —— 鉴权区块不该被挤到折叠线以下。
   */
  row?: string;
  /** 分组标题：非空则归入「高级设置」折叠区。 */
  group?: string;
}

/** 一种鉴权方式，以及选它之后需要用户补的字段。 */
export interface AuthOption {
  value: AuthMethod;
  label: string;
  /** 选这种鉴权时要填的字段（账号 / 口令 / 令牌 / 私钥）。 */
  fields: FieldSpec[];
  /**
   * 账号名取自哪个字段。
   * - undefined：默认取本方式里的 'username' 字段，没有就没有账号；
   * - 'user'   ：复用类型字段里的某个键（服务器 SSH 的「登录用户」就是账号，不该再填一遍）；
   * - null     ：这种鉴权方式没有账号概念（令牌 / 私钥）。
   */
  usernameKey?: string | null;
  /** 这类凭据会被怎么存、当前沙箱能不能真的用上。如实写，不夸大。 */
  note: string;
}

/** 从表单里抽出来的凭据载荷（只在内存里活着，不进 config）。 */
export interface AuthPayload {
  method: AuthMethod;
  /** 账号名（口令 / 令牌类可以为空）。 */
  username: string;
  /** 秘密（口令 / 令牌 / 私钥明文）。 */
  secret: string;
  /** 凭据标签（人读，例：「账号密码 · readonly」）。 */
  label: string;
  /** 用户是否真的填了秘密。 */
  hasSecret: boolean;
}

export interface AssetTypeSpec {
  /* 收紧为资产类型枚举：规格表里写错类型（如 'database'）会在编译期暴露，
   * 而不是等到提交后被后端 schema 拒绝。 */
  id: AssetType;
  label: string;
  icon: string;
  desc: string;
  /** 类型专属配置区的标题。 */
  configTitle: string;
  /** 诚实说明：这个类型的配置当前是否真的生效。 */
  configNote: string;
  /** 默认鉴权方式（只有一种可选时会被强制覆盖）。 */
  defaultAuth: AuthMethod;
  /** 类型专属字段（落 config 的那些）。 */
  fields: FieldSpec[];
  /** 当前上下文下可选的鉴权方式。 */
  auth: (values: FormValues) => AuthOption[];
  /**
   * 表单值 → asset.config（结构化 JSON）。绝不包含凭据字段。
   *
   * active = 当前条件下可见字段的键集合。**必须只写 active 里的键**：
   * 用户从 PostgreSQL 切到 MySQL 时，charset 的旧值还留在表单里，
   * 若不按可见性过滤，它会被写进 MySQL 资产配置——一个用户从没看见过的字段悄悄生效。
   */
  buildConfig: (values: FormValues, active: Set<string>) => Record<string, unknown>;
  /** 类型专属字段的校验：返回第一条错误文案，通过则返回 null。 */
  validate: (values: FormValues) => string | null;
  /** 鉴权字段的校验：选了某种鉴权却没填对应内容时报错。 */
  validateAuth: (values: FormValues) => string | null;
}

/* ============================ 通用工具 ============================ */

export type FormValues = Record<string, string>;

/** 一份 spec 的初始表单值（取 defaultValue）。 */
export function defaultValues(spec: AssetTypeSpec): FormValues {
  const values: FormValues = {};
  spec.fields.forEach((field) => {
    values[field.key] = field.defaultValue ?? '';
  });
  values.authMethod = spec.defaultAuth;
  return values;
}

/** 单个条件是否命中。 */
function conditionMet(condition: FieldCondition, values: FormValues): boolean {
  return (values[condition.key] ?? '') === condition.equals;
}

/** 显隐规则是否命中。 */
function ruleMet(rule: VisibleWhen, values: FormValues): boolean {
  if ('key' in rule) return conditionMet(rule, values);
  if (rule.all && rule.all.length > 0 && !rule.all.every((item) => conditionMet(item, values))) return false;
  if (rule.any && rule.any.length > 0 && !rule.any.some((item) => conditionMet(item, values))) return false;
  return true;
}

/** 当前条件下真正要渲染的类型字段（条件显隐过滤后）。 */
export function visibleFields(spec: AssetTypeSpec, values: FormValues): FieldSpec[] {
  return spec.fields.filter((field) => {
    if (!field.visibleWhen) return true;
    return ruleMet(field.visibleWhen, values);
  });
}

/** 当前可见字段的键集合 —— 写 config 时的白名单，防止隐藏字段的残留值生效。 */
export function activeKeys(spec: AssetTypeSpec, values: FormValues): Set<string> {
  return new Set(visibleFields(spec, values).map((field) => field.key));
}

/**
 * 把字段按 row 分组：共用一个分组键的字段并排一行，其余各自一行。
 *
 * 为什么要它：单列表单太长，「鉴权方式」区块会被挤到折叠线以下 ——
 * 而那恰恰是用户最需要看见、也最容易漏掉的一块。主机 / 端口并排后省下的高度是实打实的。
 */
export function groupRows(fields: FieldSpec[]): FieldSpec[][] {
  const rows: FieldSpec[][] = [];
  const buckets = new Map<string, FieldSpec[]>();
  fields.forEach((field) => {
    if (!field.row) {
      rows.push([field]);
      return;
    }
    const bucket = buckets.get(field.row);
    if (bucket) {
      bucket.push(field);
      return;
    }
    const created = [field];
    buckets.set(field.row, created);
    rows.push(created);
  });
  return rows;
}

/** 该类型所有鉴权字段的键（切换鉴权方式时要清干净这些残留值）。 */
export function authFieldKeys(spec: AssetTypeSpec, values: FormValues): string[] {
  const keys: string[] = [];
  spec.auth(values).forEach((option) => {
    option.fields.forEach((field) => {
      if (!keys.includes(field.key)) keys.push(field.key);
    });
  });
  return keys;
}

/**
 * 键名是否敏感 —— 与服务端 SENSITIVE_KEY_PATTERNS 同一套规则。
 *
 * 前端自检用：config 里出现这种键名，说明有东西绕过了凭据通道，必须拦下来。
 * 服务端还会独立再挡一次（前端能被绕过，服务端那层是安全边界）。
 */
const SENSITIVE_KEY_PATTERNS = [
  'token', 'password', 'passwd', 'secret', 'credential', 'apikey', 'api_key',
  'privatekey', 'private_key', 'passphrase', 'auth',
];

/** 某个键名是不是敏感键。 */
export function isSensitiveKeyName(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** 取一个字段的当前值（缺省空串）。 */
export function val(values: FormValues, key: string): string {
  return values[key] ?? '';
}

/** 去掉首尾空白；空串返回 undefined（不写进 config）。 */
function clean(raw: string | undefined): string | undefined {
  const text = (raw ?? '').trim();
  return text === '' ? undefined : text;
}

/** 文本域按行拆成数组（忽略空行），用于白名单/忽略规则这类多值字段。 */
export function lines(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 数字字段：非空且可解析才落库，否则 undefined。 */
function num(raw: string | undefined): number | undefined {
  const text = (raw ?? '').trim();
  if (text === '') return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/* ============================ 鉴权字段模板 ============================ */

/**
 * 鉴权字段是共享的：数据库和服务器都要「账号 + 口令」，
 * 写成一份模板，避免两处各写一遍、改了一处忘了另一处。
 */
const USERNAME_FIELD: FieldSpec = {
  key: 'username',
  label: '账号',
  type: 'text',
  placeholder: 'readonly_user',
  help: '连接用的账号名。它会随凭据记录在本机，便于在资产详情里看清「绑的是谁」。',
};

const PASSWORD_FIELD: FieldSpec = {
  key: 'password',
  label: '密码',
  type: 'secret',
  placeholder: '••••••••',
  help: '口令经系统钥匙串（safeStorage）加密存本机，数据库里只留一条引用，不留明文。',
};

const TOKEN_FIELD: FieldSpec = {
  key: 'token',
  label: '访问令牌',
  type: 'secret',
  placeholder: 'ghp_… / glpat-… / gl-…',
  help: '令牌经系统钥匙串加密存本机，数据库里只留一条引用，不留明文。',
};

const SSHKEY_FIELD: FieldSpec = {
  key: 'privateKey',
  label: 'SSH 私钥',
  type: 'textarea',
  sensitive: true,
  placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----',
  help: '私钥内容加密存本机（默认以圆点遮罩显示，点「显示」才看得到）。',
};

/* ============================ 类型定义 ============================ */

const DB_SPEC: AssetTypeSpec = {
  id: 'db',
  label: '数据库',
  icon: '▤',
  desc: '只读 SQL 查询与表结构浏览',
  configTitle: '数据库配置',
  configNote:
    '当前沙箱的 SQL 页固定读取演示库 demo.sqlite，登记的库信息用于描述目标库、'
    + '并在驱动就绪后接管查询。凭据在下方「鉴权方式」里一次填完 —— '
    + '口令会经系统钥匙串加密存本机，库里只留引用。',
  defaultAuth: 'password',
  fields: [
    {
      key: 'engine',
      label: '数据库引擎',
      type: 'select',
      defaultValue: 'sqlite',
      options: [
        { value: 'sqlite', label: 'SQLite（本地文件）' },
        { value: 'postgresql', label: 'PostgreSQL' },
        { value: 'mysql', label: 'MySQL' },
      ],
      help: '引擎决定下面需要填哪几项：SQLite 只需文件路径，远程引擎需要主机与库名。',
    },
    {
      key: 'dbPath',
      label: '数据库文件路径',
      type: 'text',
      placeholder: 'demo.sqlite 或 order_db.sqlite',
      help: '相对 server/data 目录或填绝对路径。',
      visibleWhen: { key: 'engine', equals: 'sqlite' },
    },
    {
      key: 'host',
      label: '主机',
      type: 'text',
      placeholder: '10.20.1.31',
      row: 'conn',
      visibleWhen: {
        any: [
          { key: 'engine', equals: 'postgresql' },
          { key: 'engine', equals: 'mysql' },
        ],
      },
    },
    {
      key: 'port',
      label: '端口',
      type: 'number',
      placeholder: '5432（PG）/ 3306（MySQL）',
      row: 'conn',
      visibleWhen: {
        any: [
          { key: 'engine', equals: 'postgresql' },
          { key: 'engine', equals: 'mysql' },
        ],
      },
    },
    {
      key: 'database',
      label: '数据库名',
      type: 'text',
      placeholder: 'order_db',
      row: 'target',
      visibleWhen: {
        any: [
          { key: 'engine', equals: 'postgresql' },
          { key: 'engine', equals: 'mysql' },
        ],
      },
    },
    {
      key: 'schema',
      label: 'Schema（可选）',
      type: 'text',
      placeholder: 'public, biz',
      row: 'target',
      help: '多个用逗号分隔；留空表示全部可见。',
      visibleWhen: { key: 'engine', equals: 'postgresql' },
    },
    {
      key: 'charset',
      label: '字符集',
      type: 'select',
      defaultValue: 'utf8mb4',
      row: 'target',
      options: [
        { value: 'utf8mb4', label: 'utf8mb4（MySQL 8 默认）' },
        { value: 'utf8', label: 'utf8' },
      ],
      visibleWhen: { key: 'engine', equals: 'mysql' },
    },
    {
      key: 'statementTimeoutMs',
      label: '语句超时（毫秒）',
      type: 'number',
      defaultValue: '15000',
      group: '高级设置',
      help: '超时后主动中断，防止慢查询拖垮库。',
    },
    {
      key: 'sampleRows',
      label: '采样行数',
      type: 'number',
      defaultValue: '20',
      group: '高级设置',
      help: '建索引时的采样行数，用于推断字段类型。',
    },
  ],
  auth: (values) => {
    const engine = val(values, 'engine') || 'sqlite';
    if (engine === 'sqlite') {
      return [{
        value: 'none',
        label: '无鉴权（本地文件）',
        fields: [],
        note: 'SQLite 读的是本机文件，没有账号密码概念，绑定凭据反而是多余的一步。',
      }];
    }
    return [
      {
        value: 'password',
        label: '账号密码',
        fields: [USERNAME_FIELD, PASSWORD_FIELD],
        note: '口令加密存本机；绑定后资产才会进入 Agent 的查询工具面（db_query 需要凭据）。',
      },
      {
        value: 'token',
        label: '访问令牌',
        fields: [TOKEN_FIELD],
        usernameKey: null,
        note: '令牌加密存本机；适合只允许发令牌、不给账号口令的服务端。',
      },
      {
        value: 'none',
        label: '无鉴权',
        fields: [],
        note: '不绑定凭据。该资产不会被放行进 Agent 的查询工具面。',
      },
    ];
  },
  buildConfig: (values, active) => {
    const engine = val(values, 'engine') || 'sqlite';
    const config: Record<string, unknown> = { engine };
    if (engine === 'sqlite') {
      const dbPath = clean(values.dbPath);
      if (dbPath) config.dbPath = dbPath;
    } else {
      const host = clean(values.host);
      if (host && active.has('host')) config.host = host;
      const port = num(values.port);
      if (port && active.has('port')) config.port = port;
      const database = clean(values.database);
      if (database && active.has('database')) config.database = database;
      /* schema 只在 PostgreSQL 下可见、charset 只在 MySQL 下可见 —— active 会挡住残留值。 */
      const schema = clean(values.schema);
      if (schema && active.has('schema')) config.schema = schema.split(',').map((item) => item.trim()).filter(Boolean);
      const charset = clean(values.charset);
      if (charset && active.has('charset')) config.charset = charset;
    }
    const timeout = num(values.statementTimeoutMs);
    if (timeout) config.statementTimeoutMs = timeout;
    const sample = num(values.sampleRows);
    if (sample) config.sampleRows = sample;
    return config;
  },
  validate: (values) => {
    const engine = val(values, 'engine') || 'sqlite';
    if (engine === 'sqlite') {
      const dbPath = clean(values.dbPath);
      if (!dbPath) return 'SQLite 需要填写数据库文件路径';
      return null;
    }
    if (!clean(values.host)) return '远程数据库必须填写主机';
    if (!clean(values.database)) return '远程数据库必须填写数据库名';
    const port = num(values.port);
    if (port !== undefined && (port < 1 || port > 65535)) return '端口需在 1–65535 之间';
    return null;
  },
  validateAuth: (values) => {
    const method = val(values, 'authMethod');
    if (method === 'password') {
      if (!clean(values.username)) return '账号密码鉴权需要填写账号';
      if (!clean(values.password)) return '账号密码鉴权需要填写密码';
    }
    if (method === 'token' && !clean(values.token)) return '访问令牌鉴权需要填写令牌';
    return null;
  },
};

const CODE_SPEC: AssetTypeSpec = {
  id: 'code',
  label: '代码库',
  icon: '▣',
  desc: '仓库检索、文件浏览与 diff',
  configTitle: '仓库配置',
  configNote:
    '填了仓库地址会真实执行 git clone：仓库落到当前项目自己的本地工作区目录'
    + '（workspaces/<项目>/<仓库>），与其他项目互不干扰，克隆完成后自动重建索引。',
  defaultAuth: 'token',
  fields: [
    {
      key: 'cloneUrl',
      label: '仓库地址',
      type: 'text',
      placeholder: 'https://host/org/repo.git 或 git@host:org/repo.git',
      help: '支持 https 与 ssh 两种形式。',
    },
    {
      key: 'branch',
      label: '分支',
      type: 'text',
      defaultValue: 'main',
      row: 'repo',
      help: '留空则克隆远端默认分支。',
    },
    {
      key: 'depth',
      label: '克隆深度',
      type: 'number',
      defaultValue: '1',
      row: 'repo',
      help: '1 = 只取最新一次提交，最快；填 0 表示完整历史。',
    },
    {
      key: 'indexMode',
      label: '索引模式',
      type: 'select',
      defaultValue: 'full',
      options: [
        { value: 'full', label: '完整索引（全量扫描并分块）' },
        { value: 'lazy', label: '懒索引（按需建块）' },
        { value: 'off', label: '不索引（只浏览文件）' },
      ],
      group: '高级设置',
    },
    {
      key: 'ignore',
      label: '忽略规则',
      type: 'textarea',
      placeholder: '**/node_modules/**\n**/target/**',
      help: '每行一条 glob 规则，命中的文件不进索引。',
      group: '高级设置',
    },
    {
      key: 'sensitiveDeny',
      label: '敏感文件拒绝规则',
      type: 'textarea',
      placeholder: '.env*\n**/*.pem\n**/id_rsa*',
      help: '每行一条 glob 规则，命中的文件既不进索引也不出现在文件树里。',
      group: '高级设置',
    },
  ],
  auth: () => [
    {
      value: 'token',
      label: '访问令牌（PAT）',
      fields: [TOKEN_FIELD],
      usernameKey: null,
      note: '令牌加密存本机；克隆私有仓库时会真的注入到 clone URL（服务端日志做脱敏）。',
    },
    {
      value: 'sshkey',
      label: 'SSH 私钥',
      fields: [SSHKEY_FIELD],
      usernameKey: null,
      note: '私钥加密存本机。当前克隆流程只把 https 令牌注入 URL，SSH 私钥需先装进本机 ssh-agent 才生效。',
    },
    {
      value: 'none',
      label: '无鉴权（公开仓库）',
      fields: [],
      note: '公开仓库不需要任何凭据，克隆时直接匿名拉取。',
    },
  ],
  buildConfig: (values, active) => {
    const config: Record<string, unknown> = {};
    const cloneUrl = clean(values.cloneUrl);
    if (cloneUrl && active.has('cloneUrl')) config.cloneUrl = cloneUrl;
    const branch = clean(values.branch);
    if (branch && active.has('branch')) config.branch = branch;
    const depth = num(values.depth);
    if (depth !== undefined && active.has('depth')) config.depth = depth;
    const indexMode = clean(values.indexMode);
    if (indexMode && active.has('indexMode')) config.indexMode = indexMode;
    const ignore = lines(values.ignore);
    if (ignore.length > 0 && active.has('ignore')) config.ignore = ignore;
    const sensitive = lines(values.sensitiveDeny);
    if (sensitive.length > 0 && active.has('sensitiveDeny')) config.sensitiveDeny = sensitive;
    /* 凭据字段（token / privateKey）不在 spec.fields 里，天然进不了 config。 */
    return config;
  },
  validate: (values) => {
    const cloneUrl = clean(values.cloneUrl);
    if (cloneUrl && !/^(https?:\/\/|git@|ssh:\/\/)/i.test(cloneUrl)) {
      return '仓库地址需以 http(s):// 或 git@ 开头';
    }
    const depth = num(values.depth);
    if (depth !== undefined && depth < 0) return '克隆深度不能为负数';
    return null;
  },
  validateAuth: (values) => {
    const method = val(values, 'authMethod');
    if (method === 'token' && !clean(values.token)) return '访问令牌鉴权需要填写令牌（公开仓库请改选「无鉴权」）';
    if (method === 'sshkey' && !clean(values.privateKey)) return 'SSH 私钥鉴权需要填写私钥内容';
    return null;
  },
};

const SERVER_SPEC: AssetTypeSpec = {
  id: 'server',
  label: '服务器',
  icon: '▥',
  desc: '只读命令白名单终端',
  configTitle: '服务器配置',
  configNote:
    '命令执行跑在本地沙箱内（跨平台派发、绝不 shell:true、10 秒超时、cwd 受限）。'
    + '填写的远程主机信息用于描述目标机；SSH 通道就绪前不会建立远程会话。',
  defaultAuth: 'password',
  fields: [
    {
      key: 'transport',
      label: '连接方式',
      type: 'select',
      defaultValue: 'local',
      options: [
        { value: 'local', label: '本地沙箱（当前生效）' },
        { value: 'ssh', label: 'SSH' },
        { value: 'docker', label: 'Docker' },
        { value: 'k8s', label: 'Kubernetes' },
      ],
      help: '连接方式决定后面需要填哪几项。',
    },
    {
      key: 'host',
      label: '主机',
      type: 'text',
      placeholder: '10.20.1.31',
      row: 'conn',
      visibleWhen: { key: 'transport', equals: 'ssh' },
    },
    {
      key: 'port',
      label: '端口',
      type: 'number',
      placeholder: '22',
      row: 'conn',
      visibleWhen: { key: 'transport', equals: 'ssh' },
    },
    {
      key: 'user',
      label: '登录用户',
      type: 'text',
      placeholder: 'deploy',
      help: 'SSH 登录账号。选「账号密码」鉴权时，它就是凭据对应的账号。',
      visibleWhen: { key: 'transport', equals: 'ssh' },
    },
    {
      key: 'container',
      label: '容器名',
      type: 'text',
      placeholder: 'order-api',
      visibleWhen: { key: 'transport', equals: 'docker' },
    },
    {
      key: 'namespace',
      label: '命名空间',
      type: 'text',
      placeholder: 'default',
      visibleWhen: { key: 'transport', equals: 'k8s' },
    },
    {
      key: 'workdir',
      label: '工作目录',
      type: 'text',
      placeholder: '/opt/app',
      help: '命令执行时的工作根目录；空路径操作会被拒绝。',
    },
    {
      key: 'allowedCommands',
      label: '命令白名单',
      type: 'textarea',
      placeholder: 'docker*\nsystemctl status*\ntail*',
      help: '每行一条允许的命令前缀。留空表示沿用系统默认白名单。',
      group: '高级设置',
    },
    {
      key: 'deniedCommands',
      label: '命令拒绝规则',
      type: 'textarea',
      placeholder: 'rm -rf*\nmkfs*\nshutdown*',
      help: '每行一条拒绝规则，命中即拦截——白名单放行之后再过这一道。',
      group: '高级设置',
    },
  ],
  auth: (values) => {
    const transport = val(values, 'transport') || 'local';
    if (transport === 'local') {
      return [{
        value: 'none',
        label: '无鉴权（本地沙箱）',
        fields: [],
        note: '命令跑在本机沙箱里，没有远端账号概念。',
      }];
    }
    if (transport === 'ssh') {
      return [
        {
          value: 'password',
          label: '账号密码',
          fields: [PASSWORD_FIELD],
          /* 账号就是上面的「登录用户」，不再让人填一遍。 */
          usernameKey: 'user',
          note: '口令加密存本机；账号沿用上面填的「登录用户」。',
        },
        {
          value: 'sshkey',
          label: 'SSH 私钥',
          fields: [SSHKEY_FIELD],
          usernameKey: 'user',
          note: '私钥加密存本机；当前沙箱尚未建立远程会话，私钥先存着备用。',
        },
        {
          value: 'none',
          label: '无鉴权',
          fields: [],
          note: '不绑定凭据（依赖本机 ssh-agent 已有的密钥）。',
        },
      ];
    }
    return [
      {
        value: 'token',
        label: '访问令牌',
        fields: [TOKEN_FIELD],
        usernameKey: null,
        note: '令牌加密存本机；当前沙箱尚未建立远程会话，令牌先存着备用。',
      },
      {
        value: 'none',
        label: '无鉴权',
        fields: [],
        note: '不绑定凭据。',
      },
    ];
  },
  buildConfig: (values, active) => {
    const config: Record<string, unknown> = {};
    const transport = clean(values.transport) || 'local';
    config.transport = transport;
    if (transport === 'ssh') {
      const host = clean(values.host);
      if (host && active.has('host')) config.host = host;
      const port = num(values.port);
      if (port && active.has('port')) config.port = port;
      const user = clean(values.user);
      if (user && active.has('user')) config.user = user;
    }
    if (transport === 'docker') {
      const container = clean(values.container);
      if (container && active.has('container')) config.container = container;
    }
    if (transport === 'k8s') {
      const namespace = clean(values.namespace);
      if (namespace && active.has('namespace')) config.namespace = namespace;
    }
    const workdir = clean(values.workdir);
    if (workdir) config.workdir = workdir;
    const allowed = lines(values.allowedCommands);
    if (allowed.length > 0) config.allowedCommands = allowed;
    const denied = lines(values.deniedCommands);
    if (denied.length > 0) config.deniedCommands = denied;
    return config;
  },
  validate: (values) => {
    const transport = val(values, 'transport') || 'local';
    if (transport === 'ssh') {
      if (!clean(values.host)) return 'SSH 连接必须填写主机';
      if (!clean(values.user)) return 'SSH 连接必须填写登录用户';
      const port = num(values.port);
      if (port !== undefined && (port < 1 || port > 65535)) return '端口需在 1–65535 之间';
    }
    if (transport === 'docker' && !clean(values.container)) return 'Docker 连接必须填写容器名';
    const workdir = clean(values.workdir);
    if (workdir && !workdir.startsWith('/')) return '工作目录需为绝对路径';
    return null;
  },
  validateAuth: (values) => {
    const method = val(values, 'authMethod');
    if (method === 'password' && !clean(values.password)) return '账号密码鉴权需要填写密码';
    if (method === 'token' && !clean(values.token)) return '访问令牌鉴权需要填写令牌';
    if (method === 'sshkey' && !clean(values.privateKey)) return 'SSH 私钥鉴权需要填写私钥内容';
    return null;
  },
};

const KB_SPEC: AssetTypeSpec = {
  id: 'kb',
  label: '知识库',
  icon: '▧',
  desc: '文档检索与引用',
  configTitle: '知识库配置',
  configNote:
    '文档目录相对沙箱仓库根路径。创建后到知识库页点「重建索引」即可真实扫描该目录并分块入库。',
  defaultAuth: 'none',
  fields: [
    {
      key: 'dir',
      label: '文档目录',
      type: 'text',
      placeholder: 'docs/ops',
      help: '相对沙箱仓库根，例如 docs/ops。留空表示索引整仓。',
    },
    {
      key: 'indexMode',
      label: '索引模式',
      type: 'select',
      defaultValue: 'full',
      options: [
        { value: 'full', label: '完整索引（扫描整个目录）' },
        { value: 'lazy', label: '懒索引（按需分块）' },
      ],
      group: '高级设置',
    },
    {
      key: 'chunkSize',
      label: '分块大小（字符）',
      type: 'number',
      defaultValue: '800',
      group: '高级设置',
      help: '每个检索块的字符数，太小丢上下文，太大稀释语义。',
    },
    {
      key: 'sensitivity',
      label: '密级',
      type: 'select',
      defaultValue: 'internal',
      options: [
        { value: 'public', label: '公开' },
        { value: 'internal', label: '内部' },
        { value: 'confidential', label: '机密' },
      ],
      help: '机密级文档默认不进 Agent 的派生工具面，需管理员显式开启。',
    },
  ],
  auth: () => [{
    value: 'none',
    label: '无鉴权（本地目录）',
    fields: [],
    note: '知识库当前扫描的是本机目录，没有远端账号概念，因此不需要绑定凭据。',
  }],
  buildConfig: (values, active) => {
    const config: Record<string, unknown> = {};
    const dir = clean(values.dir);
    if (dir && active.has('dir')) config.dir = dir;
    const indexMode = clean(values.indexMode);
    if (indexMode && active.has('indexMode')) config.indexMode = indexMode;
    const chunkSize = num(values.chunkSize);
    if (chunkSize && active.has('chunkSize')) config.chunkSize = chunkSize;
    const sensitivity = clean(values.sensitivity);
    if (sensitivity && active.has('sensitivity')) config.sensitivity = sensitivity;
    return config;
  },
  validate: (values) => {
    const dir = clean(values.dir);
    if (dir && dir.startsWith('/')) return '文档目录需为相对路径（相对沙箱仓库根）';
    if (dir && dir.includes('..')) return '文档目录不允许包含 ..';
    const chunkSize = num(values.chunkSize);
    if (chunkSize !== undefined && chunkSize < 100) return '分块大小不宜小于 100 字符';
    return null;
  },
  validateAuth: () => null,
};

/* ============================ 注册表 ============================ */

/**
 * 资产类型注册表。键名与 asset.type 落库值严格一致（db / code / server / kb），
 * 改这里等于改历史资产类型，属于破坏性变更。
 */
export const ASSET_TYPES: AssetTypeSpec[] = [DB_SPEC, CODE_SPEC, SERVER_SPEC, KB_SPEC];

/** 按 id 取类型定义；未知类型回落到第一个（并由调用方按需提示）。 */
export function specOf(typeId: string): AssetTypeSpec {
  return ASSET_TYPES.find((spec) => spec.id === typeId) ?? ASSET_TYPES[0];
}

/**
 * 各类型落到 config.endpoint 的兼容串。
 * 保留 endpoint 是因为后端旧数据与侧栏副标题都按这个键读，新表单改结构化存储后不能把老路径断了。
 */
export function endpointOf(spec: AssetTypeSpec, values: FormValues): string {
  if (spec.id === 'code') return val(values, 'cloneUrl').trim();
  if (spec.id === 'kb') return val(values, 'dir').trim();
  if (spec.id === 'db') {
    const engine = val(values, 'engine') || 'sqlite';
    if (engine === 'sqlite') return val(values, 'dbPath').trim();
    return `${val(values, 'host').trim()}:${val(values, 'port').trim() || ''}/${val(values, 'database').trim()}`.replace(/\/+$/, '');
  }
  const transport = val(values, 'transport') || 'local';
  if (transport === 'ssh') return `${val(values, 'host').trim()}:${val(values, 'port').trim() || '22'}`;
  return val(values, 'workdir').trim();
}

/** 该类型是否需要「创建后立刻克隆」的后置动作。 */
export function needsClone(spec: AssetTypeSpec, values: FormValues): boolean {
  return spec.id === 'code' && val(values, 'cloneUrl').trim() !== '';
}

/**
 * 从表单里抽出凭据载荷。
 *
 * 只取**当前鉴权方式**下、且标记为敏感的那个字段 —— 用户切走鉴权方式后残留的旧值
 * 不会被带出去（buildAuth 每次都重新按当前选项取值，不读缓存）。
 */
export function buildAuth(spec: AssetTypeSpec, values: FormValues): AuthPayload {
  const options = spec.auth(values);
  const chosen = options.find((option) => option.value === val(values, 'authMethod')) ?? options[0];
  if (!chosen) return { method: 'none', username: '', secret: '', label: '无鉴权', hasSecret: false };
  const usernameKey = chosen.usernameKey === undefined
    ? (chosen.fields.some((field) => field.key === 'username') ? 'username' : null)
    : chosen.usernameKey;
  const username = usernameKey ? (values[usernameKey] ?? '').trim() : '';
  let secret = '';
  chosen.fields.forEach((field) => {
    if (field.key === usernameKey) return;
    if (field.sensitive === true || field.type === 'secret') {
      /* 口令 / 令牌 / 私钥**不做 trim** —— 首尾空格是有意义的字符，
       * 悄悄去掉会让用户以为填错了。是否为空另行判断。 */
      secret = values[field.key] ?? '';
    }
  });
  const label = chosen.value === 'none'
    ? '无鉴权'
    : `${chosen.label}${username ? ` · ${username}` : ''}`;
  return { method: chosen.value, username, secret, label, hasSecret: secret.trim() !== '' };
}

/** 当前是否需要绑定凭据（可选方式里除了「无鉴权」还有别的吗）。 */
export function authRequired(spec: AssetTypeSpec, values: FormValues): boolean {
  return spec.auth(values).some((option) => option.value !== 'none');
}
