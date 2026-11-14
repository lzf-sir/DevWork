// vite.config.ts
import { defineConfig } from "file:///D:/code/DevWork/devwork-app/node_modules/vite/dist/node/index.js";
import react from "file:///D:/code/DevWork/devwork-app/node_modules/@vitejs/plugin-react/dist/index.js";

// package.json
var package_default = {
  name: "devwork-app",
  private: true,
  version: "0.4.2",
  type: "module",
  main: "desktop/main.cjs",
  scripts: {
    "check:env": "node scripts/verify-env.mjs",
    dev: "node scripts/dev-supervisor.mjs",
    "dev:server": "tsx watch backend/src/index.ts",
    "dev:client": "vite --host 127.0.0.1 --port 5173",
    "dev:electron": "wait-on tcp:127.0.0.1:3001 tcp:127.0.0.1:5173 && electron .",
    serve: "tsx backend/src/index.ts",
    launch: "node scripts/start.mjs",
    "launch:prod": "node scripts/start.mjs --prod",
    pack: "node scripts/package.mjs",
    "pack:dir": "node scripts/package.mjs --dir",
    "test:smoke": "node tests/run-smoke.mjs",
    "test:db": "node tests/db-browse.mjs",
    "test:asset": "npx tsx tests/asset-forms.spec.ts && node tests/asset-forms.mjs",
    "test:asset:visual": "node tests/run-electron.cjs asset-connect-visual.cjs",
    "test:db:visual": "node tests/run-electron.cjs db-visual.cjs",
    "test:asset-chat:visual": "node tests/run-electron.cjs asset-chat-visual.cjs",
    "test:layout:visual": "node tests/layout-visual.mjs",
    "test:db:theme": "node tests/run-electron.cjs db-theme.cjs",
    typecheck: "tsc --noEmit -p tsconfig.json && tsc --noEmit -p backend/tsconfig.json",
    build: "tsc --noEmit -p tsconfig.json && tsc --noEmit -p backend/tsconfig.json && vite build",
    start: "electron .",
    preview: "vite preview",
    "prepare:runtime": "node scripts/prepare-runtime.mjs",
    smoke: "node scripts/smoke-package.mjs",
    "check:version": "node scripts/check-version.mjs",
    dist: "node scripts/package.mjs",
    "dist:current": "node scripts/package.mjs",
    "dist:zip": "node scripts/package.mjs --zip",
    "dist:all": "node scripts/package.mjs --all",
    "dist:dir": "node scripts/package.mjs --dir",
    "dist:installer": "node scripts/package.mjs --installer",
    "dist:portable": "node scripts/package.mjs --portable",
    "test:md": "node tests/markdown.mjs",
    "test:composer": "node tests/composer.mjs",
    "test:skills": "node tests/skills.mjs",
    "test:repo": "node tests/repo-clone.mjs",
    test: "npm run test:md && npm run test:composer && npm run test:skills && npm run test:smoke && npm run test:asset",
    "test:agent-tools": "node tests/agent-tools.mjs"
  },
  dependencies: {
    cors: "^2.8.5",
    "electron-updater": "^6.8.11",
    express: "^4.21.2",
    react: "^18.3.1",
    "react-dom": "^18.3.1",
    zod: "^3.24.1"
  },
  devDependencies: {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^22.10.2",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    concurrently: "^9.1.2",
    electron: "^33.2.0",
    "electron-builder": "^25.1.8",
    tsx: "^4.19.2",
    typescript: "^5.6.3",
    vite: "^5.4.11",
    "wait-on": "^8.0.1"
  }
};

// vite.config.ts
var vite_config_default = defineConfig({
  root: "frontend",
  plugins: [react()],
  /* 版本号取自 package.json，前端不再手写一份"当前最新版本"的字符串。 */
  define: {
    __APP_VERSION__: JSON.stringify(package_default.version),
    /**
     * 打包态标志（编译期常量）。
     *
     * 打包产物**不做 mock 降级**：后端不通时如实报错，
     * 而不是拿演示数据糊一层假的「一切正常」——那正是「给我 mock 数据」。
     * 开发态（npm run dev / vite build 本地调试）保持 mock 兜底不变。
     *
     * 由 scripts/package.mjs 在打包时设 DEVWORK_BUILD_PACKAGED=1 注入。
     */
    __PACKAGED__: JSON.stringify(process.env.DEVWORK_BUILD_PACKAGED === "1")
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    /* 契约层在仓库根的 shared/（frontend 之外），dev server 需显式放行。 */
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true
      }
    }
  },
  build: {
    /* 相对 root（frontend/）解析：回到仓库根的 dist/。 */
    outDir: "../dist",
    emptyOutDir: true
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiLCAicGFja2FnZS5qc29uIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiRDpcXFxcY29kZVxcXFxEZXZXb3JrXFxcXGRldndvcmstYXBwXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCJEOlxcXFxjb2RlXFxcXERldldvcmtcXFxcZGV2d29yay1hcHBcXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0Q6L2NvZGUvRGV2V29yay9kZXZ3b3JrLWFwcC92aXRlLmNvbmZpZy50c1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gJ3ZpdGUnO1xuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0JztcbmltcG9ydCBwa2cgZnJvbSAnLi9wYWNrYWdlLmpzb24nO1xuXG4vKipcbiAqIFZpdGUgXHU5MTREXHU3RjZFXHVGRjFBXHU1MjREXHU3QUVGXHU1NzI4IGZyb250ZW5kL1x1RkYwQzUxNzMgXHU3QUVGXHU1M0UzXHVGRjBDL2FwaSBcdTUzQ0RcdTRFRTNcdTUyMzAgRXhwcmVzcyAzMDAxXHUzMDAyXG4gKiBcdTRFQTdcdTcyNjlcdTRFQ0RcdThGOTNcdTUxRkFcdTUyMzBcdTRFRDNcdTVFOTNcdTY4MzkgZGlzdC8gXHUyMDE0XHUyMDE0IFx1NjI1M1x1NTMwNVx1NTk1MVx1N0VBNlx1RkYwOHJlc291cmNlcy9kaXN0XHVGRjA5XHU0RTBFXHU1NDBFXHU3QUVGXHU1NDBDXHU2RTkwXHU2MjU4XHU3QkExXHU5MEZEXHU0RjlEXHU4RDU2XHU1QjgzXHUzMDAyXG4gKi9cbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XG4gIHJvb3Q6ICdmcm9udGVuZCcsXG4gIHBsdWdpbnM6IFtyZWFjdCgpXSxcbiAgLyogXHU3MjQ4XHU2NzJDXHU1M0Y3XHU1M0Q2XHU4MUVBIHBhY2thZ2UuanNvblx1RkYwQ1x1NTI0RFx1N0FFRlx1NEUwRFx1NTE4RFx1NjI0Qlx1NTE5OVx1NEUwMFx1NEVGRFwiXHU1RjUzXHU1MjREXHU2NzAwXHU2NUIwXHU3MjQ4XHU2NzJDXCJcdTc2ODRcdTVCNTdcdTdCMjZcdTRFMzJcdTMwMDIgKi9cbiAgZGVmaW5lOiB7XG4gICAgX19BUFBfVkVSU0lPTl9fOiBKU09OLnN0cmluZ2lmeShwa2cudmVyc2lvbiksXG4gICAgLyoqXG4gICAgICogXHU2MjUzXHU1MzA1XHU2MDAxXHU2ODA3XHU1RkQ3XHVGRjA4XHU3RjE2XHU4QkQxXHU2NzFGXHU1RTM4XHU5MUNGXHVGRjA5XHUzMDAyXG4gICAgICpcbiAgICAgKiBcdTYyNTNcdTUzMDVcdTRFQTdcdTcyNjkqKlx1NEUwRFx1NTA1QSBtb2NrIFx1OTY0RFx1N0VBNyoqXHVGRjFBXHU1NDBFXHU3QUVGXHU0RTBEXHU5MDFBXHU2NUY2XHU1OTgyXHU1QjlFXHU2MkE1XHU5NTE5XHVGRjBDXG4gICAgICogXHU4MDBDXHU0RTBEXHU2NjJGXHU2MkZGXHU2RjE0XHU3OTNBXHU2NTcwXHU2MzZFXHU3Q0NBXHU0RTAwXHU1QzQyXHU1MDQ3XHU3Njg0XHUzMDBDXHU0RTAwXHU1MjA3XHU2QjYzXHU1RTM4XHUzMDBEXHUyMDE0XHUyMDE0XHU5MEEzXHU2QjYzXHU2NjJGXHUzMDBDXHU3RUQ5XHU2MjExIG1vY2sgXHU2NTcwXHU2MzZFXHUzMDBEXHUzMDAyXG4gICAgICogXHU1RjAwXHU1M0QxXHU2MDAxXHVGRjA4bnBtIHJ1biBkZXYgLyB2aXRlIGJ1aWxkIFx1NjcyQ1x1NTczMFx1OEMwM1x1OEJENVx1RkYwOVx1NEZERFx1NjMwMSBtb2NrIFx1NTE1Q1x1NUU5NVx1NEUwRFx1NTNEOFx1MzAwMlxuICAgICAqXG4gICAgICogXHU3NTMxIHNjcmlwdHMvcGFja2FnZS5tanMgXHU1NzI4XHU2MjUzXHU1MzA1XHU2NUY2XHU4QkJFIERFVldPUktfQlVJTERfUEFDS0FHRUQ9MSBcdTZDRThcdTUxNjVcdTMwMDJcbiAgICAgKi9cbiAgICBfX1BBQ0tBR0VEX186IEpTT04uc3RyaW5naWZ5KHByb2Nlc3MuZW52LkRFVldPUktfQlVJTERfUEFDS0FHRUQgPT09ICcxJyksXG4gIH0sXG4gIHNlcnZlcjoge1xuICAgIGhvc3Q6ICcxMjcuMC4wLjEnLFxuICAgIHBvcnQ6IDUxNzMsXG4gICAgLyogXHU1OTUxXHU3RUE2XHU1QzQyXHU1NzI4XHU0RUQzXHU1RTkzXHU2ODM5XHU3Njg0IHNoYXJlZC9cdUZGMDhmcm9udGVuZCBcdTRFNEJcdTU5MTZcdUZGMDlcdUZGMENkZXYgc2VydmVyIFx1OTcwMFx1NjYzRVx1NUYwRlx1NjUzRVx1ODg0Q1x1MzAwMiAqL1xuICAgIGZzOiB7IGFsbG93OiBbJy4uJ10gfSxcbiAgICBwcm94eToge1xuICAgICAgJy9hcGknOiB7XG4gICAgICAgIHRhcmdldDogJ2h0dHA6Ly8xMjcuMC4wLjE6MzAwMScsXG4gICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbiAgYnVpbGQ6IHtcbiAgICAvKiBcdTc2RjhcdTVCRjkgcm9vdFx1RkYwOGZyb250ZW5kL1x1RkYwOVx1ODlFM1x1Njc5MFx1RkYxQVx1NTZERVx1NTIzMFx1NEVEM1x1NUU5M1x1NjgzOVx1NzY4NCBkaXN0L1x1MzAwMiAqL1xuICAgIG91dERpcjogJy4uL2Rpc3QnLFxuICAgIGVtcHR5T3V0RGlyOiB0cnVlLFxuICB9LFxufSk7XG4iLCAie1xuICBcIm5hbWVcIjogXCJkZXZ3b3JrLWFwcFwiLFxuICBcInByaXZhdGVcIjogdHJ1ZSxcbiAgXCJ2ZXJzaW9uXCI6IFwiMC40LjJcIixcbiAgXCJ0eXBlXCI6IFwibW9kdWxlXCIsXG4gIFwibWFpblwiOiBcImRlc2t0b3AvbWFpbi5janNcIixcbiAgXCJzY3JpcHRzXCI6IHtcbiAgICBcImNoZWNrOmVudlwiOiBcIm5vZGUgc2NyaXB0cy92ZXJpZnktZW52Lm1qc1wiLFxuICAgIFwiZGV2XCI6IFwibm9kZSBzY3JpcHRzL2Rldi1zdXBlcnZpc29yLm1qc1wiLFxuICAgIFwiZGV2OnNlcnZlclwiOiBcInRzeCB3YXRjaCBiYWNrZW5kL3NyYy9pbmRleC50c1wiLFxuICAgIFwiZGV2OmNsaWVudFwiOiBcInZpdGUgLS1ob3N0IDEyNy4wLjAuMSAtLXBvcnQgNTE3M1wiLFxuICAgIFwiZGV2OmVsZWN0cm9uXCI6IFwid2FpdC1vbiB0Y3A6MTI3LjAuMC4xOjMwMDEgdGNwOjEyNy4wLjAuMTo1MTczICYmIGVsZWN0cm9uIC5cIixcbiAgICBcInNlcnZlXCI6IFwidHN4IGJhY2tlbmQvc3JjL2luZGV4LnRzXCIsXG4gICAgXCJsYXVuY2hcIjogXCJub2RlIHNjcmlwdHMvc3RhcnQubWpzXCIsXG4gICAgXCJsYXVuY2g6cHJvZFwiOiBcIm5vZGUgc2NyaXB0cy9zdGFydC5tanMgLS1wcm9kXCIsXG4gICAgXCJwYWNrXCI6IFwibm9kZSBzY3JpcHRzL3BhY2thZ2UubWpzXCIsXG4gICAgXCJwYWNrOmRpclwiOiBcIm5vZGUgc2NyaXB0cy9wYWNrYWdlLm1qcyAtLWRpclwiLFxuICAgIFwidGVzdDpzbW9rZVwiOiBcIm5vZGUgdGVzdHMvcnVuLXNtb2tlLm1qc1wiLFxuICAgIFwidGVzdDpkYlwiOiBcIm5vZGUgdGVzdHMvZGItYnJvd3NlLm1qc1wiLFxuICAgIFwidGVzdDphc3NldFwiOiBcIm5weCB0c3ggdGVzdHMvYXNzZXQtZm9ybXMuc3BlYy50cyAmJiBub2RlIHRlc3RzL2Fzc2V0LWZvcm1zLm1qc1wiLFxuICAgIFwidGVzdDphc3NldDp2aXN1YWxcIjogXCJub2RlIHRlc3RzL3J1bi1lbGVjdHJvbi5janMgYXNzZXQtY29ubmVjdC12aXN1YWwuY2pzXCIsXG4gICAgXCJ0ZXN0OmRiOnZpc3VhbFwiOiBcIm5vZGUgdGVzdHMvcnVuLWVsZWN0cm9uLmNqcyBkYi12aXN1YWwuY2pzXCIsXG4gICAgXCJ0ZXN0OmFzc2V0LWNoYXQ6dmlzdWFsXCI6IFwibm9kZSB0ZXN0cy9ydW4tZWxlY3Ryb24uY2pzIGFzc2V0LWNoYXQtdmlzdWFsLmNqc1wiLFxuICAgIFwidGVzdDpsYXlvdXQ6dmlzdWFsXCI6IFwibm9kZSB0ZXN0cy9sYXlvdXQtdmlzdWFsLm1qc1wiLFxuICAgIFwidGVzdDpkYjp0aGVtZVwiOiBcIm5vZGUgdGVzdHMvcnVuLWVsZWN0cm9uLmNqcyBkYi10aGVtZS5janNcIixcbiAgICBcInR5cGVjaGVja1wiOiBcInRzYyAtLW5vRW1pdCAtcCB0c2NvbmZpZy5qc29uICYmIHRzYyAtLW5vRW1pdCAtcCBiYWNrZW5kL3RzY29uZmlnLmpzb25cIixcbiAgICBcImJ1aWxkXCI6IFwidHNjIC0tbm9FbWl0IC1wIHRzY29uZmlnLmpzb24gJiYgdHNjIC0tbm9FbWl0IC1wIGJhY2tlbmQvdHNjb25maWcuanNvbiAmJiB2aXRlIGJ1aWxkXCIsXG4gICAgXCJzdGFydFwiOiBcImVsZWN0cm9uIC5cIixcbiAgICBcInByZXZpZXdcIjogXCJ2aXRlIHByZXZpZXdcIixcbiAgICBcInByZXBhcmU6cnVudGltZVwiOiBcIm5vZGUgc2NyaXB0cy9wcmVwYXJlLXJ1bnRpbWUubWpzXCIsXG4gICAgXCJzbW9rZVwiOiBcIm5vZGUgc2NyaXB0cy9zbW9rZS1wYWNrYWdlLm1qc1wiLFxuICAgIFwiY2hlY2s6dmVyc2lvblwiOiBcIm5vZGUgc2NyaXB0cy9jaGVjay12ZXJzaW9uLm1qc1wiLFxuICAgIFwiZGlzdFwiOiBcIm5vZGUgc2NyaXB0cy9wYWNrYWdlLm1qc1wiLFxuICAgIFwiZGlzdDpjdXJyZW50XCI6IFwibm9kZSBzY3JpcHRzL3BhY2thZ2UubWpzXCIsXG4gICAgXCJkaXN0OnppcFwiOiBcIm5vZGUgc2NyaXB0cy9wYWNrYWdlLm1qcyAtLXppcFwiLFxuICAgIFwiZGlzdDphbGxcIjogXCJub2RlIHNjcmlwdHMvcGFja2FnZS5tanMgLS1hbGxcIixcbiAgICBcImRpc3Q6ZGlyXCI6IFwibm9kZSBzY3JpcHRzL3BhY2thZ2UubWpzIC0tZGlyXCIsXG4gICAgXCJkaXN0Omluc3RhbGxlclwiOiBcIm5vZGUgc2NyaXB0cy9wYWNrYWdlLm1qcyAtLWluc3RhbGxlclwiLFxuICAgIFwiZGlzdDpwb3J0YWJsZVwiOiBcIm5vZGUgc2NyaXB0cy9wYWNrYWdlLm1qcyAtLXBvcnRhYmxlXCIsXG4gICAgXCJ0ZXN0Om1kXCI6IFwibm9kZSB0ZXN0cy9tYXJrZG93bi5tanNcIixcbiAgICBcInRlc3Q6Y29tcG9zZXJcIjogXCJub2RlIHRlc3RzL2NvbXBvc2VyLm1qc1wiLFxuICAgIFwidGVzdDpza2lsbHNcIjogXCJub2RlIHRlc3RzL3NraWxscy5tanNcIixcbiAgICBcInRlc3Q6cmVwb1wiOiBcIm5vZGUgdGVzdHMvcmVwby1jbG9uZS5tanNcIixcbiAgICBcInRlc3RcIjogXCJucG0gcnVuIHRlc3Q6bWQgJiYgbnBtIHJ1biB0ZXN0OmNvbXBvc2VyICYmIG5wbSBydW4gdGVzdDpza2lsbHMgJiYgbnBtIHJ1biB0ZXN0OnNtb2tlICYmIG5wbSBydW4gdGVzdDphc3NldFwiLFxuICAgIFwidGVzdDphZ2VudC10b29sc1wiOiBcIm5vZGUgdGVzdHMvYWdlbnQtdG9vbHMubWpzXCJcbiAgfSxcbiAgXCJkZXBlbmRlbmNpZXNcIjoge1xuICAgIFwiY29yc1wiOiBcIl4yLjguNVwiLFxuICAgIFwiZWxlY3Ryb24tdXBkYXRlclwiOiBcIl42LjguMTFcIixcbiAgICBcImV4cHJlc3NcIjogXCJeNC4yMS4yXCIsXG4gICAgXCJyZWFjdFwiOiBcIl4xOC4zLjFcIixcbiAgICBcInJlYWN0LWRvbVwiOiBcIl4xOC4zLjFcIixcbiAgICBcInpvZFwiOiBcIl4zLjI0LjFcIlxuICB9LFxuICBcImRldkRlcGVuZGVuY2llc1wiOiB7XG4gICAgXCJAdHlwZXMvY29yc1wiOiBcIl4yLjguMTdcIixcbiAgICBcIkB0eXBlcy9leHByZXNzXCI6IFwiXjQuMTcuMjFcIixcbiAgICBcIkB0eXBlcy9ub2RlXCI6IFwiXjIyLjEwLjJcIixcbiAgICBcIkB0eXBlcy9yZWFjdFwiOiBcIl4xOC4zLjEyXCIsXG4gICAgXCJAdHlwZXMvcmVhY3QtZG9tXCI6IFwiXjE4LjMuMVwiLFxuICAgIFwiQHZpdGVqcy9wbHVnaW4tcmVhY3RcIjogXCJeNC4zLjRcIixcbiAgICBcImNvbmN1cnJlbnRseVwiOiBcIl45LjEuMlwiLFxuICAgIFwiZWxlY3Ryb25cIjogXCJeMzMuMi4wXCIsXG4gICAgXCJlbGVjdHJvbi1idWlsZGVyXCI6IFwiXjI1LjEuOFwiLFxuICAgIFwidHN4XCI6IFwiXjQuMTkuMlwiLFxuICAgIFwidHlwZXNjcmlwdFwiOiBcIl41LjYuM1wiLFxuICAgIFwidml0ZVwiOiBcIl41LjQuMTFcIixcbiAgICBcIndhaXQtb25cIjogXCJeOC4wLjFcIlxuICB9XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQTJRLFNBQVMsb0JBQW9CO0FBQ3hTLE9BQU8sV0FBVzs7O0FDRGxCO0FBQUEsRUFDRSxNQUFRO0FBQUEsRUFDUixTQUFXO0FBQUEsRUFDWCxTQUFXO0FBQUEsRUFDWCxNQUFRO0FBQUEsRUFDUixNQUFRO0FBQUEsRUFDUixTQUFXO0FBQUEsSUFDVCxhQUFhO0FBQUEsSUFDYixLQUFPO0FBQUEsSUFDUCxjQUFjO0FBQUEsSUFDZCxjQUFjO0FBQUEsSUFDZCxnQkFBZ0I7QUFBQSxJQUNoQixPQUFTO0FBQUEsSUFDVCxRQUFVO0FBQUEsSUFDVixlQUFlO0FBQUEsSUFDZixNQUFRO0FBQUEsSUFDUixZQUFZO0FBQUEsSUFDWixjQUFjO0FBQUEsSUFDZCxXQUFXO0FBQUEsSUFDWCxjQUFjO0FBQUEsSUFDZCxxQkFBcUI7QUFBQSxJQUNyQixrQkFBa0I7QUFBQSxJQUNsQiwwQkFBMEI7QUFBQSxJQUMxQixzQkFBc0I7QUFBQSxJQUN0QixpQkFBaUI7QUFBQSxJQUNqQixXQUFhO0FBQUEsSUFDYixPQUFTO0FBQUEsSUFDVCxPQUFTO0FBQUEsSUFDVCxTQUFXO0FBQUEsSUFDWCxtQkFBbUI7QUFBQSxJQUNuQixPQUFTO0FBQUEsSUFDVCxpQkFBaUI7QUFBQSxJQUNqQixNQUFRO0FBQUEsSUFDUixnQkFBZ0I7QUFBQSxJQUNoQixZQUFZO0FBQUEsSUFDWixZQUFZO0FBQUEsSUFDWixZQUFZO0FBQUEsSUFDWixrQkFBa0I7QUFBQSxJQUNsQixpQkFBaUI7QUFBQSxJQUNqQixXQUFXO0FBQUEsSUFDWCxpQkFBaUI7QUFBQSxJQUNqQixlQUFlO0FBQUEsSUFDZixhQUFhO0FBQUEsSUFDYixNQUFRO0FBQUEsSUFDUixvQkFBb0I7QUFBQSxFQUN0QjtBQUFBLEVBQ0EsY0FBZ0I7QUFBQSxJQUNkLE1BQVE7QUFBQSxJQUNSLG9CQUFvQjtBQUFBLElBQ3BCLFNBQVc7QUFBQSxJQUNYLE9BQVM7QUFBQSxJQUNULGFBQWE7QUFBQSxJQUNiLEtBQU87QUFBQSxFQUNUO0FBQUEsRUFDQSxpQkFBbUI7QUFBQSxJQUNqQixlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxJQUNsQixlQUFlO0FBQUEsSUFDZixnQkFBZ0I7QUFBQSxJQUNoQixvQkFBb0I7QUFBQSxJQUNwQix3QkFBd0I7QUFBQSxJQUN4QixjQUFnQjtBQUFBLElBQ2hCLFVBQVk7QUFBQSxJQUNaLG9CQUFvQjtBQUFBLElBQ3BCLEtBQU87QUFBQSxJQUNQLFlBQWM7QUFBQSxJQUNkLE1BQVE7QUFBQSxJQUNSLFdBQVc7QUFBQSxFQUNiO0FBQ0Y7OztBRDdEQSxJQUFPLHNCQUFRLGFBQWE7QUFBQSxFQUMxQixNQUFNO0FBQUEsRUFDTixTQUFTLENBQUMsTUFBTSxDQUFDO0FBQUE7QUFBQSxFQUVqQixRQUFRO0FBQUEsSUFDTixpQkFBaUIsS0FBSyxVQUFVLGdCQUFJLE9BQU87QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxJQVUzQyxjQUFjLEtBQUssVUFBVSxRQUFRLElBQUksMkJBQTJCLEdBQUc7QUFBQSxFQUN6RTtBQUFBLEVBQ0EsUUFBUTtBQUFBLElBQ04sTUFBTTtBQUFBLElBQ04sTUFBTTtBQUFBO0FBQUEsSUFFTixJQUFJLEVBQUUsT0FBTyxDQUFDLElBQUksRUFBRTtBQUFBLElBQ3BCLE9BQU87QUFBQSxNQUNMLFFBQVE7QUFBQSxRQUNOLFFBQVE7QUFBQSxRQUNSLGNBQWM7QUFBQSxNQUNoQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQUEsRUFDQSxPQUFPO0FBQUE7QUFBQSxJQUVMLFFBQVE7QUFBQSxJQUNSLGFBQWE7QUFBQSxFQUNmO0FBQ0YsQ0FBQzsiLAogICJuYW1lcyI6IFtdCn0K
