/**
 * 测试辅助（纯本地版）。
 *
 * 应用没有账号体系：所有 /api 端点无需登录、不校验会话，因此这里不再有
 * 登录请求、Cookie 或访客账号。保留 `adminCookie` / `installAuthFetch`
 * 两个导出名只是为了兼容既有测试文件里的调用，它们现在都是空实现。
 */
export async function adminCookie() {
  return '';
}

export function installAuthFetch() {
  /* 无账号体系：不需要给 fetch 注入会话头。 */
}
