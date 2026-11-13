/**
 * 跨端词表 —— 不含任何依赖的纯常量与守卫。
 *
 * 为什么单独一个文件：这份东西前端也要用（类型守卫、下拉选项），
 * 而 zod 只应在后端生效。若从 contracts/index 导入，zod 会被打进前端包（实测 +56KB）。
 * 需要词表的地方请直接引本文件或它的转出，不要引 index。
 */

/** 资产类型枚举，与 backend/src/config/tool-catalog.ts 的 AssetType 严格对齐。 */
export const ASSET_TYPES = ['code', 'db', 'server', 'kb', 'log', 'api'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/**
 * 类型守卫：DOM 边界（select / 查询串 / 消息载荷）拿到的永远是 string，
 * 在这里收窄一次，下游就能用联合类型；非法值应当被拒，而不是静默当成新类型。
 */
export function isAssetType(value: string): value is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(value);
}
