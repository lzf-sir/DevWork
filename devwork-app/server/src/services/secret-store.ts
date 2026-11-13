/**
 * SecretStore（B17）：跨进程访问 Electron 主进程的 safeStorage。
 * 后端是独立 Node 进程，无法直接调 safeStorage；借 child IPC 通道
 * （main.cjs 已有 devwork:shutdown 同款通道）请求加解密。
 * safeStorage 不可用时绝不落盘明文 —— 只保存引用、如实降级。
 */

interface SecretIpcMessage {
  type?: string;
  reqId?: string;
  ok?: boolean;
  value?: string;
  error?: string;
}

const pending = new Map<string, (result: { ok: boolean; value?: string; error?: string }) => void>();
let reqSeq = 0;
let listenerAttached = false;

function attachListener(): void {
  if (listenerAttached || typeof process.on !== 'function') return;
  listenerAttached = true;
  process.on('message', (message: SecretIpcMessage) => {
    if (!message || typeof message !== 'object') return;
    if (message.type !== 'secret:result' || typeof message.reqId !== 'string') return;
    const resolve = pending.get(message.reqId);
    if (!resolve) return;
    pending.delete(message.reqId);
    resolve({ ok: message.ok === true, value: message.value, error: message.error });
  });
}

function request(
  op: 'encrypt' | 'decrypt' | 'delete',
  payload: Record<string, string>,
): Promise<{ ok: boolean; value?: string; error?: string }> {
  return new Promise((resolve) => {
    if (typeof process.send !== 'function') {
      resolve({ ok: false, error: 'no-ipc' });
      return;
    }
    attachListener();
    reqSeq += 1;
    const reqId = `sec-${Date.now()}-${reqSeq}`;
    const timer = setTimeout(() => {
      pending.delete(reqId);
      resolve({ ok: false, error: 'timeout' });
    }, 3000);
    pending.set(reqId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    process.send({ type: `secret:${op}`, reqId, ...payload });
  });
}

/** 加密并存入本机 secrets.enc.json（仅主进程可写）。返回存储模式供审计。 */
export async function storeSecret(ref: string, value: string): Promise<{ stored: boolean; mode: 'safeStorage' | 'none' }> {
  const result = await request('encrypt', { ref, value });
  if (result.ok) return { stored: true, mode: 'safeStorage' };
  // eslint-disable-next-line no-console
  console.warn(`[DevWork] safeStorage 不可用（${result.error ?? 'unknown'}），凭据仅保存引用、秘密不落盘`);
  return { stored: false, mode: 'none' };
}

/** 读取明文（本机解密）。不存在或通道不可用时返回 null。 */
export async function loadSecret(ref: string): Promise<string | null> {
  const result = await request('decrypt', { ref });
  return result.ok ? result.value ?? null : null;
}

/**
 * 删除某条秘密（模型档案被删除时，把它那把钥匙一起清掉）。
 * 不存在时也视为成功 —— 幂等，重复删不会报错。
 */
export async function deleteSecret(ref: string): Promise<boolean> {
  const result = await request('delete', { ref });
  return result.ok;
}
