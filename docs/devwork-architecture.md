# DevWork 架构地图

> 2026-11-13 结构重构后的现状说明。目的是回答三个问题：
> 代码在哪、改动该往哪放、哪些地方看着能改其实不能动。
>
> 历史设计文档见 `devwork-design.md`（产品与能力设计），本文只讲**代码结构与工程约定**。

---

## 1. 顶层结构

```
DevWork/                      ← git 仓库根（含 docs/，不含 .workbuddy/）
├── docs/                     设计与审计文档
└── devwork-app/              唯一的应用工程
    ├── frontend/             React SPA（Vite root）
    │   ├── index.html
    │   └── src/              api / components / views / hooks / utils / types / store.tsx
    ├── backend/              Express API
    │   ├── src/              唯一后端源码
    │   ├── tsconfig.json
    │   └── .runtime/         data / sandbox / artifacts（运行时数据，不入库）
    ├── desktop/              Electron 壳（main.cjs / preload.cjs）
    ├── shared/contracts/     跨端契约（zod schema + 词表）
    ├── scripts/              唯一脚本目录（dev / start / package / verify-env）
    ├── tests/                冒烟、仓库克隆、数据库浏览、视觉回归
    ├── package.json          单 package.json（没有 workspaces）
    ├── vite.config.ts        root: 'frontend'，outDir: '../dist'
    └── electron-builder.yml  打包配置
```

**为什么不用 npm workspaces**：三端同版本发布、`node_modules` 只有一份，
workspaces 换来的是结构正确感，付出的是打包链路持续维护成本。
将来真要独立发布，`frontend/` `backend/` 已就位，加 package.json 即可。

---

## 2. 五条硬约定

### 2.1 打包契约（改目录名时最容易被打破）

交付产物内部布局是**固定契约**，与源码目录名解耦：

```
resources/
├── dist/            前端构建产物（electron-builder extraResources from: dist）
├── server/          后端运行时暂存（package.mjs 把 backend/src 拷成 server/src）
│   ├── src/
│   └── node_modules/ (express / cors / tsx / esbuild)
└── runtime/node.exe  内置 Node 22（后端依赖 node:sqlite，Electron 33 自带 Node 20 不够）
```

`desktop/main.cjs` 依赖这个布局（`SERVER_ROOT`、`SERVER_ENTRY`、`TSX_*`、`BUNDLED_NODE`）。
**改源码目录名没问题，改 resources 下的名字要同时改 main.cjs + package.mjs + electron-builder.yml。**

### 2.2 运行时数据只落在 `backend/.runtime/`

```
backend/.runtime/
├── data/       devwork.sqlite / demo.sqlite / logs/ / shell-token / secrets.enc.json
├── sandbox/    repos/（克隆的仓库） terminal/（终端会话）
└── artifacts/  用户产出的文件
```

- 路径**只有一处定义**：`backend/src/config.ts` 的 `RUNTIME_DIR`（含环境变量覆盖）。
- 打包态不落这里：`main.cjs` 把 `DEVWORK_DATA_DIR` 指向用户数据目录。
- 新增任何落盘路径，一律从 `config.ts` 取，不要就地 `path.join(SERVER_ROOT, ...)`。

### 2.3 端口与地址

`3001` 后端 / `5173` 前端。后端端口来自 `DEVWORK_PORT`（默认 3001，见 `config.ts`）；
前端 proxy 写在 `vite.config.ts`。改端口要同步 `config.ts`、`vite.config.ts`、
`desktop/main.cjs`、`scripts/{dev-supervisor,start}.mjs`。

### 2.4 Node 版本

`node:sqlite` 需要 **Node 22.5+**。`npm run check:env` 会拦住低版本，
打包时用 `build/pkg/runtime/node.exe` 兜底。

### 2.5 单仓库、单 package.json

依赖只有一份。前端不该 import `fs`/`node:*`，后端不该 import React ——
这条靠 tsconfig 的 include 边界约束，不是靠自觉。

---

## 3. 后端路由分层

`backend/src/routes/index.ts` 只有 46 行：装配顺序 + `/api` 兜底。全部 113 条路由分布在 13 个域模块：

| 模块 | 行数 | 路由 | 负责 |
|---|---:|---:|---|
| `system.ts` | 148 | 2 | 健康检查 / 启动自检 |
| `workspaces.ts` | 155 | 7 | 工作区增删改查、切换、本地目录 |
| `sidebar.ts` | 247 | 8 | 侧栏 / 状态栏 / 分组 / 条目移动 |
| `assets.ts` | 376 | 18 | 资产 CRUD / 能力 / 凭据 / 索引 / 仓库克隆 |
| `conversations.ts` | 365 | 22 | 会话 / 消息 / SSE / 审批 / 引用 |
| `artifacts.ts` | 197 | 3 | 产物下载与预览 |
| `browser.ts` | 117 | 4 | 内置浏览器状态与页面 |
| `terminal.ts` | 133 | 8 | 终端会话 / 历史 / 命令白黑名单 |
| `tools.ts` | 134 | 3 | 技能 / 工具面板 / 命令模板 |
| `sql.ts` | 247 | 7 | SQL 查询 / 表结构 / 导出 |
| `files.ts` | 136 | 8 | 文件树 / 内容 / 大纲 / git / 写回 |
| `settings.ts` | 404 | 18 | 设置 / LLM 配置 / 权限策略 / 维护 |
| `audit.ts` | 130 | 4 | 审计查询与导出 |
| `helpers.ts` | 230 | — | 请求解析、工作区守卫、审计筛选与导出格式 |

### 装配顺序不是随便排的

```
audit/export  必须早于  audit/:id
workspaces/:id/switch  必须早于  workspaces/:id
```

Express 按注册顺序匹配，前缀更宽的端点抢在前面就会吃掉具体路径。
**新增端点时放进对应模块的合适位置，不要往 `index.ts` 里加。**

---

## 4. 跨端契约层（shared/contracts）

### 4.1 只覆盖写入侧

读侧形状由后端 `repositories` 的 `*Shape` 函数稳定产出，重复声明收益低；
真正会漂移的是「客户端提交什么」，所以契约扎在写入侧。

```
asset.ts         创建/更新/凭据/能力/检索/进度/克隆
conversation.ts  会话/消息/截断/附件/审批/浏览器/命令建议
files.ts         保存/补丁/agent 写/克隆/终端
sql.ts           查询/导出
workspace.ts     工作区/分组/条目
settings.ts      LLM 配置/敏感规则/权限探测/设置分区
vocab.ts         零依赖词表 + isAssetType（前端专用）
index.ts         统一出口（后端用）
```

### 4.2 后端用法

```ts
import { parseBody } from '../http/validate';
import { folderCreateSchema } from '../../../shared/contracts';

app.post('/api/folders', wrap(async (req, res) => {
  const payload = parseBody(folderCreateSchema, req);   // 失败 → 400 E_VALIDATION
  ...
}));
```

- **一个路由块只解析一次**，块内统一用 `payload`。
- 只报第一处错误 —— 前端表单需要的是「改哪里」。
- 存在性检查（`requireRow` / `requireAssetId`）仍在形状校验**之前**，错误优先级（404 vs 400）保持原样。

### 4.3 前端用法（注意体积）

```ts
import type { AssetInput } from '../../../shared/contracts';        // ✅ 编译期擦除
import { isAssetType } from '../../../shared/contracts/vocab';      // ✅ 零依赖
import { assetCreateSchema } from '../../../shared/contracts';      // ❌ 会把 zod 打进前端
```

规则：**先问这行是 type 还是 value**。value 只能从 `vocab.ts` 取。
实测代价：从 `index` 引一个运行时值 → 前端包 425.60KB → 481.61KB。

---

## 5. 常用命令

```bash
npm run dev          # 一键开发：后端 3001 + 前端 5173 + Electron
npm run dev:server   # 只起后端（tsx watch）
npm run dev:client   # 只起前端
npm run check:env    # 环境门禁：Node 22 / node:sqlite / WAL / 目录可写
npm run typecheck    # 前端 + 后端 tsc，双份
npm run build        # typecheck + vite build → dist/
npm run pack         # 打包 portable exe（build/pkg 暂存 + release/ 输出）
npm run test:smoke   # 冒烟三件套：smoke 118 + repo-clone 21 + db-browse 35
```

`npm run launch` 会先跑 `check:env` 再决定启动方式。

---

## 6. 陷阱清单（都是踩过的）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 1 | 契约层抢业务判定 | 空 SQL 必须由 SQL Guard 判 **422**，契约层加 `min(1)` 会变成 400。形状归契约，合法性归守卫 |
| 2 | 枚举值按直觉命名 | `format` 真实取值是 `csv/json/md/sql`（不是 `markdown`）。写 enum 前先去读调用方 |
| 3 | `content` 加 `min(1)` | 「重试」复用消息端点且 content 为空、靠 `regenerate` 触发，加必填会打断重试链路 |
| 4 | 前端从 `contracts/index` 引运行时值 | 会把 zod 打进前端包（+56KB）。运行时值只从 `vocab.ts` 引 |
| 5 | 改 `vite` 的 `root` 忘了 `outDir` | `outDir` 相对 root 解析，`root: 'frontend'` 时必须是 `'../dist'` |
| 6 | 往 `index.ts` 加路由 | 加到对应域模块，注意 `audit/export` 这类前缀顺序 |
| 7 | 就地拼运行时路径 | 从 `config.ts` 的 `RUNTIME_DIR` / `DATA_DIR` 等常量取 |
| 8 | 批量改路由用「下一个 `body(req)`」定位 | 必须按**路由块**（扫描到配平 `}));`），否则单行内联或同路径多方法会串块 |
| 9 | 以为目录改名会破坏打包 | 打包契约是 `resources/{dist,server,runtime}`，与源码目录名无关；要改的是 main.cjs + package.mjs + builder.yml |

---

## 7. 新增一个能力的标准流程

1. **形状**：在 `shared/contracts/` 对应文件加 schema（从调用方真实载荷抄字段，含长度上界）。
2. **路由**：加到对应域模块，用 `parseBody(schema, req)` 取载荷。
3. **服务**：业务逻辑进 `backend/src/services/`，不要写在 handler 里。
4. **前端**：`client.ts` 加方法，入参用 `z.infer` 推导的类型（`import type`）。
5. **验证**：`npm run typecheck` → `npm run test:smoke` → 需要时负向 curl 一次（错误码要对）。

---

## 8. 变更记录（2026-11-13 结构重构）

| 提交 | 内容 |
|---|---|
| `60db5cb` | 建立版本控制基线（152 文件，无产物/密钥） |
| `32916e0` | Tier1：删空目录 `config/`、6 个孤儿探针、`server/scripts` 并入 `scripts/` |
| `d356011` | Tier2：`server/`→`backend/`、`src/`→`frontend/src`、`electron/`→`desktop/`、运行时收进 `.runtime/` |
| `cf00f1c` | 1815 行单体路由 → 13 域模块 + helpers，入口 46 行 |
| `b428fec` | 建立 zod 写入契约层（资产 / 会话）+ `parseBody` |
| `e4e036e` | 设置端点 6 条接入契约；资产类型编译期收紧；拆出 `vocab.ts` |
| `f5721f8` | 剩余写端点全接入（42 个）；修正 SQL / 导出格式的语义边界 |

**指标**：路由 1815 → 46 行入口 ｜ 写端点校验覆盖 42/42 ｜ 冒烟 174 项全绿 ｜ 前端包 425.60KB（零 zod）
