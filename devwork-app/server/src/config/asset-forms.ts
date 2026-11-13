/**
 * 资产配置的**服务端白名单**。
 *
 * 为什么前端已经过滤了还要服务端再过一遍？
 * 前端那层是体验（不渲染、不落库），这里是安全（不信任任何客户端）。
 * 双层规则不同、失效模式不同：前端可能被绕过（改包、直接调 API），
 * 服务端这层必须能独立挡住。
 *
 * 三条硬规则：
 *
 * 1. **按键白名单**：只有该资产类型已知的键能进 config，未知键直接丢。
 *    资产类型本身也不在白名单 → 一律丢弃（fail closed）：
 *    新增类型忘了更新这里，表现是配置不生效，而不是任意键都能写进库。
 *
 * 2. **敏感键一律拒绝**：token / password / secret / apiKey 这类键名直接丢弃，
 *    哪怕它出现在白名单里。凭据只走 credential_binding 与系统钥匙串，不进 asset.config。
 *
 * 3. **值的形状与长度有界**：字符串限长，数组限项数且元素必须为字符串，
 *    数字必须是有限数，config 是扁平结构（不支持嵌套对象）。
 *    长度不设上限的话，一个 10MB 的字符串能塞进 config 字段。
 */

/** 服务端自己写入的键：客户端提交时一律丢弃（客户端不能指定克隆落点）。 */
export const SERVER_OWNED_KEYS = ['localPath', 'clonedAt', 'remote', 'reservedExternalMount'];

/** 敏感键名（小写匹配）：命中即丢弃，不进 config。 */
export const SENSITIVE_KEY_PATTERNS = [
  'token', 'password', 'passwd', 'secret', 'credential', 'apikey', 'api_key',
  'privatekey', 'private_key', 'passphrase', 'auth',
];

/** 每种资产类型允许写入 config 的键。 */
export const ASSET_CONFIG_KEYS: Record<string, string[]> = {
  db: [
    'engine', 'dbPath', 'host', 'port', 'database', 'schema', 'charset',
    'statementTimeoutMs', 'sampleRows',
  ],
  code: [
    'cloneUrl', 'branch', 'depth', 'indexMode', 'ignore', 'sensitiveDeny',
  ],
  server: [
    'transport', 'host', 'port', 'user', 'container', 'namespace', 'workdir',
    'allowedCommands', 'deniedCommands',
  ],
  kb: [
    'dir', 'indexMode', 'chunkSize', 'sensitivity',
  ],
};

const MAX_STRING = 512;
const MAX_LIST = 50;

/**
 * 哪些类型下的哪些键**语义上就是列表**，落库时统一成字符串数组。
 *
 * 为什么要在服务端归一化，而不是各写各的？
 * 前端 buildConfig 会把 schema 拆成数组，但直接调 API 的人可能传字符串 "public,biz"。
 * 同一个键在库里就有两种形状，下游消费方必须同时处理字符串和数组——
 * 这类"形状不一致"是最难查的一类 bug。归一化放在服务端，键的形状就只有一个。
 */
const ARRAY_KEYS: Record<string, string[]> = {
  db: ['schema'],
  code: ['ignore', 'sensitiveDeny'],
  server: ['allowedCommands', 'deniedCommands'],
};

/** 键名是否命中敏感规则。 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * 清洗客户端提交的资产配置。
 *
 * 返回可安全落库的 config；任何不合规的键值被静默丢弃（不报错——
 * 接入表单不该因为一条多余字段而失败），调用方可对比清洗前后的键数做审计。
 */
export function sanitizeAssetConfig(type: string, raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const allowed = ASSET_CONFIG_KEYS[type];
  /* fail closed：未知资产类型不接受任何配置键。 */
  if (!allowed) return {};
  const source = raw as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  allowed.forEach((key) => {
    if (SERVER_OWNED_KEYS.includes(key)) return;
    if (isSensitiveKey(key)) return;
    const value = source[key];
    if (value === undefined || value === null) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (text === '') return;
      /* 列表型键：字符串按逗号 / 换行拆成数组，保证该键在库里只有一种形状。 */
      if ((ARRAY_KEYS[type] ?? []).includes(key)) {
        const list = text
          .split(/[,\r\n]+/)
          .map((item) => item.trim())
          .filter((item) => item !== '')
          .slice(0, MAX_LIST)
          .map((item) => (item.length > MAX_STRING ? item.slice(0, MAX_STRING) : item));
        if (list.length > 0) clean[key] = list;
        return;
      }
      clean[key] = text.length > MAX_STRING ? text.slice(0, MAX_STRING) : text;
      return;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return;
      clean[key] = value;
      return;
    }
    if (typeof value === 'boolean') {
      clean[key] = value;
      return;
    }
    if (Array.isArray(value)) {
      const list = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .slice(0, MAX_LIST)
        .map((item) => (item.length > MAX_STRING ? item.slice(0, MAX_STRING) : item));
      if (list.length > 0) clean[key] = list;
    }
  });
  return clean;
}
