/**
 * 兼容入口。
 *
 * 智能体工作台已经按「工单 / 准入 / 账本」拆到 `./shadow/` 下 ——
 * 一个 900 行的单文件同时是执行台和策略台，改任何一处都要先通读全文。
 * App.tsx 的 import 保持不变，避免为了拆文件去动路由与侧栏。
 */
export { default } from './shadow/ShadowView';
