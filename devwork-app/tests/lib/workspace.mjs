/**
 * 测试辅助：给资产级请求补上 workspaceId。
 *
 * 后端的工作区守卫是「缺省即拒」—— /api/assets/:id/... 不带 workspaceId
 * 一律 409 E_WORKSPACE_MISMATCH。之前后端是「缺省即放行」，所以测试里
 * 从来不用带工作区；守卫收紧后，所有资产级请求都必须显式声明工作区。
 *
 * 统一在这里补，而不是让每个用例手写 query：漏一个就是一处 409，
 * 而且漏的地方和「真的跨工作区」的用例混在一起，看不出是哪个原因。
 *
 * 显式写了 workspaceId 的请求不被覆盖 —— 跨工作区用例正需要它。
 */

/** 资产作用域路径：/assets/<id>/... */
const ASSET_SCOPE = /^\/assets\/([^/?]+)/;

/**
 * @param {string} urlPath 以 / 开头、不含 origin 的 API 路径
 * @param {string | ((assetId: string) => string)} workspaceId
 *        工作区 id；传函数则按资产 id 动态解析（一个用例里跑多个工作区时用）
 * @returns {string} 补好 workspaceId 的路径
 */
export function withWorkspace(urlPath, workspaceId) {
  const matched = ASSET_SCOPE.exec(urlPath);
  if (!matched) return urlPath;
  if (urlPath.includes('workspaceId=')) return urlPath;
  const resolved = typeof workspaceId === 'function' ? workspaceId(matched[1]) : workspaceId;
  if (!resolved) return urlPath;
  const sep = urlPath.includes('?') ? '&' : '?';
  return `${urlPath}${sep}workspaceId=${encodeURIComponent(resolved)}`;
}
