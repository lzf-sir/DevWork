/**
 * 详情页资产解析 —— 「当前工作区 + 资产类型」→ 真实资产。
 *
 * 背景：详情页原先把资产 id 写死成 w-ops 的演示资产
 * （a-order-db-prod / a-order-api / a-kb）。后端工作区守卫改成
 * 「缺省即拒、跨区即拒」之后，切到别的工作区再打开这些页面，
 * 请求会被判成跨工作区访问（409），页面一片空白。
 *
 * 现在统一按当前工作区的侧栏解析：解析不到就返回 null，
 * 调用方保持空态 —— 而不是拿别的资产的 id 去撞后端。
 */
import { useMemo } from 'react';
import { useStore } from '../store';
import { resolveAssetTarget, type AssetTarget } from '../api/adapters';
import type { AssetGo } from '../api/client';

/**
 * @param go 资产类型（code / db / server / kb）
 * @returns 命中的资产；当前工作区没有该类资产时为 null
 */
export function useAssetTarget(go: AssetGo): AssetTarget | null {
  const { state } = useStore();
  return useMemo(
    () => resolveAssetTarget(state.projects, state.workspaceId, go, state.activeAssetId),
    [state.projects, state.workspaceId, go, state.activeAssetId],
  );
}
