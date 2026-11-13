import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

/**
 * Vite 配置：前端在 frontend/，5173 端口，/api 反代到 Express 3001。
 * 产物仍输出到仓库根 dist/ —— 打包契约（resources/dist）与后端同源托管都依赖它。
 */
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
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
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
