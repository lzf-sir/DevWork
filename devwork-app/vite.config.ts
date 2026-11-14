import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

/**
 * Vite 配置：前端在 frontend/，5173 端口，/api 反代到 Express 3001。
 * 产物仍输出到仓库根 dist/ —— 打包契约（resources/dist）与后端同源托管都依赖它。
 */
/**
 * 后端端口必须跟着 DEVWORK_PORT 走。
 *
 * 后端（backend/src/config.ts）与 dev-supervisor 都认这个环境变量，只有这里写死 3001，
 * 于是 `DEVWORK_PORT=3031 npm run dev` 时后端在 3031、vite 仍代理到 3001 → 全站 API 404
 * （架构文档 §2.3 要求「改端口要同步四处」，实际只有一处支持）。默认值不变。
 */
const API_PORT = Number(process.env.DEVWORK_PORT ?? 3001);

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  /* 版本号取自 package.json，前端不再手写一份"当前最新版本"的字符串。 */
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    /**
     * 打包态标志（编译期常量）。
     *
     * 打包产物**不做 mock 降级**：后端不通时如实报错，
     * 而不是拿演示数据糊一层假的「一切正常」——那正是「给我 mock 数据」。
     * 开发态（npm run dev / vite build 本地调试）保持 mock 兜底不变。
     *
     * 由 scripts/package.mjs 在打包时设 DEVWORK_BUILD_PACKAGED=1 注入。
     */
    __PACKAGED__: JSON.stringify(process.env.DEVWORK_BUILD_PACKAGED === '1'),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    /* 契约层在仓库根的 shared/（frontend 之外），dev server 需显式放行。 */
    fs: { allow: ['..'] },
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    /* 相对 root（frontend/）解析：回到仓库根的 dist/。 */
    outDir: '../dist',
    emptyOutDir: true,
  },
});
