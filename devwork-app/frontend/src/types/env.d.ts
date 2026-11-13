/**
 * 构建期常量：由 vite.config.ts 的 define 注入，值来自 package.json 的 version。
 * 前端不允许再手写一份版本号字符串 —— 两份一定会漂移。
 */
declare const __APP_VERSION__: string;

/**
 * 是否为打包产物（编译期常量，由 DEVWORK_BUILD_PACKAGED 注入）。
 *
 * 打包态关闭 mock 降级：后端不可达时如实报错，而不是展示演示数据。
 */
declare const __PACKAGED__: boolean;
