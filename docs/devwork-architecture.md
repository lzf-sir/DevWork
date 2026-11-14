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
├── server/          后端运行时暂存（stage-runtime 把 backend/src 拷成 server/src）
│   ├── package.json         { "type": "module" }  ← 后端 ESM 上下文
│   ├── src/
│   └── node_modules/        express / cors / tsx / esbuild（tsx 加载后端源码用）
├── shared/          契约层（stage-runtime 把仓库根 shared/ 拷过来）
│   ├── package.json         { "type": "module" }  ← **缺了它 shared 会被当 CJS**
│   └── contracts/
├── node_modules/    **shared 侧的运行期依赖（只有 zod）** ← 见下，不能放 server 下
└── runtime/node.exe  内置 Node 22（后端依赖 node:sqlite，Electron 33 自带 Node 20 不够）
```

`desktop/main.cjs` 依赖这个布局（`SERVER_ROOT`、`SERVER_ENTRY`、`TSX_*`、`BUNDLED_NODE`）。
**改源码目录名没问题，改 resources 下的名字要同时改
`main.cjs` + `scripts/lib/stage-runtime.mjs` + `scripts/package.mjs` 的产物自检 + `electron-builder.yml`。**

### 2.1.1 为什么 `shared/` 需要自己那两样东西（v1.0 踩过的两个坑）

后端以 `../../../shared/contracts` 引用契约层，所以 `shared/` 与 `server/` 必须同级。
但**同级还不够** —— v1.0 打包后「仓库外双击起不来」，根因是两件互相独立的事：

| # | 缺什么 | 后果 | 为什么仓库内不复现 |
|---|---|---|---|
| a | `resources/shared/package.json`（`type:"module"`） | 没有祖先 `package.json` → `shared/contracts/*.ts` 被按 **CJS** 解释 → ESM 具名导出探测失败 | 仓库内 `devwork-app/package.json` 的 `"type":"module"` 是 `shared/` 的祖先；打包后这个祖先消失 |
| b | `resources/node_modules/zod` | zod 找不到 → `ERR_MODULE_NOT_FOUND` | 仓库内向上能命中 `devwork-app/node_modules/zod` |

**为什么 zod 不能只放 `resources/server/node_modules`**：ESM 裸包解析从**import 语句所在文件**逐级向上找 `node_modules`。
`resources/shared/contracts/index.ts` 的链是
`shared/contracts/node_modules` → `shared/node_modules` → `resources/node_modules` → `resources/../…`，
**`server/node_modules` 根本不在这条链上**。所以 shared 侧的依赖必须落在 `resources/node_modules`（或 `shared/node_modules`）。

**落点取舍（刻意留痕，别"整理")**：本可以落 `resources/shared/node_modules` —— 那样连 `electron-builder.yml` 都不用改，
因为 `from: build/pkg/shared → to: shared` 是递归拷贝。最终选 **resources 根**，理由是 server 侧将来若有"后端与契约共享的依赖"
可以复用同一份，不必再往 `shared/` 里塞 node_modules；**代价是 `electron-builder.yml` 多一处
`from: build/pkg/node_modules → to: node_modules` 需要与 `stage-runtime.mjs` 的暂存逻辑同步**。
两种落点都能被解析，选根是权衡不是随手。**若要改落点，必须同时改五处**：
`stage-runtime.mjs`（真正拷包的地方）、`electron-builder.yml`（`extraResources` 的 `from/to`）、
`preflight-release.mjs` ④（静态断言校验的路径）、`package.mjs` 的产物自检（在 `win-unpacked/resources` 下再查一次）、
`smoke-package.mjs`（前置检查 + 复制到 `os.tmpdir()` 的清单里都有 `pkg/node_modules` 这一件）。
漏改前两处会**静默丢依赖**（包没进产物，但闸门是绿的）；漏改后三处会让闸门**指向旧路径**（红得没有意义，修的人会去动错误的目录）。

**验证方式（唯一真闸门）**：产物必须在**「祖先既没有 `node_modules` 也没有 `package.json`」的目录**里启动一次
（`stage-runtime.mjs` 与 `smoke-package.mjs` 都为此把 `build/pkg` 复制到 `os.tmpdir()` 再跑）。
在 `devwork-app/` 下面任何位置启动都会向上命中仓库的 `package.json` 与 `node_modules`，**红不起来** —— 这两个坑都是这么漏掉的。

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

`backend/src/routes/index.ts` 只有 48 行：装配顺序 + `/api` 兜底。全部 134 条路由分布在 15 个域模块：

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
| `shadow.ts` | 214 | 13 | 影子链路（事件 / 定时源 / 草案 / 策略 / 统计 / 开关 / 导出） |
| `tickets.ts` | 108 | 8 | 工单（列表 / 详情 / 回答 / 停止 / 重派 / 推进循环） |
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
npm run test:smoke   # 六阶段：smoke 118 + repo 21 + db 35 + asset 51 + shadow 87 + tickets 35
npm run test:shadow        # 只跑影子链路（起隔离实例，端口 3011）
npm run test:shadow:core   # 影子核心逻辑（进程内，拨时钟验到点/补发）
npm run test:shadow:visual # 影子决策页视觉验收（需先 build，产出截图）
npm run test:tickets      # 只跑工单链路（授权 → 建单 → 派工 → 报告）
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
| 9 | 以为目录改名会破坏打包 | 打包契约是 `resources/{dist,server,shared,node_modules,runtime}`（**五件**，见 §2.1），与源码目录名无关；要改的是 `main.cjs` + `stage-runtime.mjs` + `electron-builder.yml` |
| 10 | 把清单工具的 action 命名成 `todo.write` | `isWriteAction()` 会判成写操作，清单每更新一次就弹一张审批卡。用 `todo.plan` |
| 11 | 深色主题只覆盖了 `--gray-*` | `--surface-1` 原先是字面量 `#FFFFFF`，深色下不翻转 → 拿它做底的卡片白底配浅字，几乎读不出来。新增卡片优先用 `--gray-25/--gray-50`（跟计划卡一致），别用 `--surface-1` |
| 12 | 前端按 id 追加卡片 | 清单卡每步回传同一个 id，`mergeThread()` 必须按 id 原位替换，否则一个 20 步任务刷出 20 张清单 |
| 13 | 上下文预算写死数字 | 一律走 `resolveContextWindow()` / `measureContext()`；前端显示按 `/1000` 折算（128000 → 128k），别用 `/1024` |
| 14 | **在仓库内验证打包产物** | 在 `devwork-app/` 下面任何位置启动 `build/pkg` 或 `win-unpacked`，都会向上命中仓库的 `package.json`（`type:module`）与 `node_modules`，把「缺 `shared/package.json`」「缺 zod」两类问题完美掩盖。**打包验证必须把产物复制到 `os.tmpdir()` 之类「祖先既无 `node_modules` 也无 `package.json`」的目录里启动**（v1.0 为此连挂两次：`zod` 未进暂存清单、`shared/` 失去 ESM 上下文） |

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

---

## 9. 变更记录（2026-11-13 P1 影子链路）

| 新增 | 作用 | 边界 |
|---|---|---|
| `backend/src/db/schema.sql`（+4 表） | `source` / `thread` / `trigger` / `decision` | 只记录，不动既有表语义 |
| `backend/src/services/shadow-gate.ts` | 七档确定性准入（纯函数，无 IO） | 不查库、不调模型 |
| `backend/src/services/shadow-scheduler.ts` | 800ms tick：收事件 → 研判 → 记账 | **不建工单、不派工、不执行** |
| `backend/src/routes/shadow.ts` | 8 条只读 / 开关端点 | 无执行副作用 |
| `shared/contracts/shadow.ts` | 写入侧 zod 契约 | 前端不引（避免 zod 进包） |
| `services/conversation.ts`（+6 行） | `ingestUserTurn()` 取料，fire-and-forget | 内部吞异常，观测不得成为故障源 |
| `pruneShadowLedger()`（6h） | 账本留存 30 天 | 只删可重建观测数据，审计与工单不动 |
| `frontend/src/views/shadow/ShadowView.tsx` | 智能体工作台的壳：三分区切换 + 总开关 + 待办徽标 | 分区是「问题」的切分，不是页面的切分 |
| `frontend/src/views/shadow/useShadowData.ts` | 一次加载、三个分区共用；所有写操作集中在此 | 同屏数字必须来自同一时刻的快照 |
| `frontend/src/views/shadow/TicketsPanel.tsx` | 工单分区：KPI / 筛选 / 搜索 / 待人输入 | 待人排最前，不按时间倒序 |
| `frontend/src/views/shadow/TicketDetail.tsx` | 工单详情：范围 / 轮次 / 提问 / 收件箱 / 工作目录 | 就地展开，不遮挡列表 |
| `frontend/src/views/shadow/GatePanel.tsx` | 准入分区：模式 / auto 刹车 / 白名单 / 源 / 规则范围 | 每个开关带「改它会怎样」 |
| `frontend/src/views/shadow/LedgerPanel.tsx` | 账本分区：授权草案 / 决策表 / 原因分布 | 只记录，不执行 |
| `frontend/src/views/ShadowView.tsx` | 兼容入口，re-export `./shadow/ShadowView` | 拆分不动 App 的路由与侧栏 |
| `backend/src/services/tickets.ts` | 工单状态机 + Router + 派工 + 注意力 | stage 由事实推导，不手工赋值 |
| `backend/src/services/worker-runtime.ts` | 单轮执行：Mandate 裁剪工具面 + 双闸 | 没有 accepted 授权不开跑 |
| `backend/src/services/agent-loop.ts` | 研判 → 派单 → 执行 → 回收 的 1s 循环 | 关停后只空转 |
| `backend/src/services/shadow-collectors.ts` | log / git / terminal / sql 四类采集器 | 位点存库，一轮最多一条；sql 读 `sql_trace` |
| `backend/src/services/subscription.ts` | 订阅扇出：把同线程后续事件投进工单收件箱 | 只投 `would_accept=1`，不送权限 |
| `backend/src/services/workdir.ts` | 每工单一个目录 + 代码资产 git worktree | 写目标从派生面推导；建不出隔离就 blocked，不降级 |
| `backend/src/services/exec-context.ts` | AsyncLocalStorage 覆盖仓库根 + 声明本单必须隔离的写目标 | 只覆盖本单声明过的资产；隔离缺根时拒绝回落共享仓库 |
| `tests/shadow-visual.mjs` | 8 项视觉验收（CDP 截图 + 断言） | `npm run test:shadow:visual`，需先 `npm run build` |
| `tests/shadow.mjs` | 87 项：判定 / 频控 / 定时源 / 授权名单 / 真人取料 / 草案与粒度 / auto | 独立文件，可单跑 |
| `tests/shadow-visual.mjs` | 34 项：三分区切换 / 详情展开 / 徽标 / auto 水位 | 需先 `npm run build` |
| `tests/shadow-core.ts` | 75 项：定时源 + 工单生命周期 + 四类采集器 + 工作区隔离 + 扇出 + auto 签发 | 进程内跑，`npm run test:shadow:core` |
| `tests/tickets.mjs` | 35 项：授权 → 建单 → 派工 → 报告 → 详情聚合 → 停止 | `npm run test:tickets` |

关键约定：**tick 的全部状态在表里**（`trigger.disposition` 游标 / `thread.eval_running`
线程锁 / `decision` 账本），进程重启后 `recoverShadowState()` 抹平残留锁即可续跑。
`DEVWORK_SUPERAGENT=off` 一键关停。

`tests/run-smoke.mjs` 支持阶段过滤：`node tests/run-smoke.mjs shadow`
（用位置参数而非环境变量，Windows 下不必依赖 cross-env）。

---

## 10. 变更记录（2026-11-14 任务清单与上下文压缩）

长任务看不出发进度、Context 满了就直接报错——这两件事是同一个问题的两面：
**Agent 干到一半没了状态**。所以一次性做掉：清单卡记「做到哪一步」，
上下文压缩记「聊到哪一段」，两者都不删原始消息。

| 新增 | 作用 | 边界 |
|---|---|---|
| `backend/src/services/todo.ts` | 任务清单：一张卡原位更新（`revision` 自增），进度由状态推导 | 最多 30 项；`writeTodoPlan()` 先按 id 对齐、再按标题对齐、最后才新增 |
| `backend/src/config/tools.ts`（+1） | `todo_write` 工具，`action:'todo.plan'` | 不能叫 `todo.write`，否则每一步弹审批（陷阱 10） |
| `backend/src/config/tool-catalog.ts`（+1） | 工具目录条目（`assetType:'workspace'`） | 描述里写死「先拆 3~7 步、每步回传完整清单、不许假装完成」 |
| `backend/src/services/context-budget.ts` | 口径唯一：`estimateTokens` / `resolveContextWindow` / `measureContext` / `buildBudgetedHistory` / `compactConversation` | 测量与装载共用同一套累加逻辑，避免「显示 60% 实际塞 95%」 |
| `backend/src/routes/conversations.ts`（+2） | `GET /:id/context-usage`、`POST /:id/compact` | 压缩走 `mode:'manual'`，落 `context.compact` 审计 |
| `shared/contracts/conversation.ts`（+1） | `compactContextSchema`（`model?` / `keepShare` 0.1~0.5） | 形状归契约，越界由 zod 挡成 400 |
| `frontend/src/hooks/useContextUsage.ts` | 取数 + 手动压缩，失败保留上一份不清空 | 不轮询；只在发消息后 / 手动刷新时打 |
| `frontend/src/components/Composer.tsx`（+） | 输入框右侧的 16px 圆环 + 消耗浮层 | ok/near/over 三档变色，浮层点外部收起 |
| `frontend/src/store.tsx`（+`mergeThread`） | 同 id 原位替换、其余追加 | 清单卡与摘要卡都靠它，否则长任务刷屏（陷阱 12） |
| `frontend/src/components/ChatThread.tsx`（+2） | `todo` 卡（✓/▸/!/序号 + 进度条）与 `summary` 卡（折叠早前 N 条） | 摘要卡默认收起，但必须写明「原始消息仍完整保留」 |
| `tests/context.mjs` | 34 项：清单原位更新 / revision 推进 / 压缩少于原来 / 原始消息未删 / 404 与越界 400 | 第七阶段，`node tests/run-smoke.mjs context` |

两条纪律（写进 `systemPrompt()`，模型可见）：
1. 多步任务先 `todo_write` 拆成 3~7 步，每完成一步回传**完整清单**（不是增量）；
2. 卡住就标 `blocked` 并说明缺什么，不许把没做的事写成完成。

压缩的三条硬约束：
- **不删原始消息**。压缩只改「发给模型的内容」，时间线里的消息一条不少；
- **提炼后没变小就不插卡**（`skipped` + 原因），负收益的压缩比不压缩更糟；
- **来源必须可追溯**：接得上模型时 `source:'model'`，否则 `source:'rule'` 并如实标注「规则提炼」。
