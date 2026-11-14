/**
 * 应用版本号的**唯一字面量**（后端侧）。
 *
 * 为什么单独立一个文件：版本号此前散落在 `/api/health`、种子里的 `setting.about`
 * 两处（外加前端 mock），发版时靠人记得改 —— 结果 1.0.0 的包仍对外报着旧版本号。
 * 一个数字出现在三个地方，就等于它出现在零个地方：问不出「这个数从哪来」。
 *
 * 约定：后端任何要暴露版本号的地方都 import 这里的常量；
 * 打包态的真实版本来自 `devwork-app/package.json`（由 `scripts/check-version.mjs` 校验一致）。
 */
export const APP_VERSION = '1.0.0';
