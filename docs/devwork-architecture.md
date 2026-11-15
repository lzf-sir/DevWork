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

---

## 11. 变更记录（2026-11-15 内置工具与技能补齐）

对照两个参照实现补齐了「能读到真相」和「知道这类活怎么做」两块能力：
Claude Code 的 Read/Grep/Glob/Edit/WebFetch 语义，以及 DeepSeek Harness 的
`skills/<id>/SKILL.md` 文件驱动 + 子代理/计划模式。

### 11.1 新增工具（6 个，目录条目 22 → 28）

| 工具 | 组 | 语义 | 边界（为什么这么定） |
|---|---|---|---|
| `code_glob` | code | glob（`**`/`*`/`?`/`{a,b}`）列文件，按 mtime 降序 | 不读内容；跳过依赖/构建产物/敏感文件；扫描 4000 文件封顶 |
| `code_grep` | code | 正则逐行搜真实文件，带行号与上下文行 | 单文件 512KB 封顶并**如实上报跳过数**；pattern ≤200 字符防 ReDoS |
| `code_read`（增强） | code | 支持 `offset`/`limit` 分页，返回总行数与"还有 N 行未读" | 单文件 2MB 封顶（超限指向 grep，不硬读） |
| `web_fetch` | common | 服务端抓 http/https 并转纯文本 | 私有网段拦截；**重定向自己跟、每跳重校验**（自动 follow 是 SSRF 洞）；2MB/12s 双限 |
| `skill_list` | common | 技能清单（适用场景 + 可用性 + 预算），不含正文 | 省 token：正文只在 `skill_load` 时进上下文 |
| `skill_load` | common | 按 id 加载方法论正文 + 推荐工具 + 预算 | 缺资产时**拒绝加载**并说明缺什么，不硬跑 |

写工具新增 1 个：

| 工具 | 语义 | 三层防线 |
|---|---|---|
| `code_edit_str` | `oldString` → `newString` 精确替换 | precheck 要求**唯一命中**（0 次=理解错了、多次=位置有歧义，都中止）→ 快照 → 落盘 → verify 重读；回滚引用与 `code_edit` 同一套 |

为什么不给"任意 bash"：运维动作仍走 `srv_exec` 的意图模板（设计 §6.3）。
给一个自由 shell 等于把三层防线一次性架空，宁可牺牲一点灵活性。

### 11.2 SKILL.md 文件驱动（技能的第二个事实来源）

```
backend/src/skills/<id>/SKILL.md      frontmatter(id/label/desc/category/when/tools/writeTools/requiresAssets/budget) + 方法论正文
backend/src/services/skill-loader.ts  解析 / 校验 / 缓存；目录按候选链探测
backend/src/config/skills.ts          内置 TS 登记表 + 文件技能合并 → SKILL_REGISTRY
```

**两层边界（写死的分工，不是过渡态）**：

| 层 | 来源 | 是否进前端镜像 | 改一句话要做什么 |
|---|---|---|---|
| builtin | `config/skills.ts` | **是**（`mock.ts` 的 MOCK_SKILLS 逐字段一致，`tests/skills.mjs` 把关） | 改代码 + 改镜像 |
| file | `skills/<id>/SKILL.md` | 否（`source:'file'`） | 只改 Markdown，重启生效 |

目录探测走候选链（`DEVWORK_SKILLS_DIR` → `SERVER_ROOT/src/skills` → `cwd/backend/src/skills` → `cwd/src/skills`）：
开发态锚在 `backend/`，打包态锚在 `server/`（`stage-runtime.mjs` 整目录拷 `backend/src`，
所以**不需要改任何打包清单**），esbuild bundle 态锚点漂移则退回 cwd。

本次随附 5 个文件技能：`code-navigator`（定位顺序）、`diff-review`（增量审查六维度）、
`web-research`（引用纪律）、`data-dictionary`（结构/采样/推测三档标注）、`write-safety`（写前自检）。

### 11.3 系统提示词

新增四条纪律（`llm-gateway.ts` 的 `systemPrompt`）：先 glob 收敛 → grep 定位 → read 分页读；
"还有 N 行未读"时不许下整体结论；`code_search` 是索引结果、引用行号前要复核；
外部资料用 `web_fetch` 抓、抓不到就说抓不到；陌生任务先 `skill_list` 再 `skill_load`，一次只加载一个。

### 11.4 陷阱补充（接 §6 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 15 | 用 `String.replace(needle, newString)` 做精确替换 | `newString` 里的 `$&`/`$1` 会被当替换模式解释，改一次正则就变成另一段代码。用 `split/join`（全替换）或 `slice` 拼接（单次） |
| 16 | 给 `config/skills.ts` 加 fs 依赖后直接跑 `tests/skills.mjs` | esbuild 默认不认 `node:*` 内置模块，bundle 会报 "Could not resolve node:fs"。测试的 bundle 需要 `--platform=node` |
| 17 | 把文件技能也塞进前端 `MOCK_SKILLS` 并让测试比总数 | 镜像只兜底**内置**项；文件技能总数随仓库变化，测试要比"内置子集严格一致 + 文件技能结构完整"，否则每加一个 SKILL.md 都要改前端 |
| 18 | 用 `**` 模式匹配根目录文件 | `**/` 必须编译成 `(?:[^/]+/)*`（零层可匹配），写成 `.*\/` 会漏掉根目录 |
| 19 | 工具面持续加功能而不看预算 | 派生面约定 ≤30；w-ops 曾到 active 27。**这条问题的正解在 §12**：先按"同对象多动词"合并，再扩能力 |

### 11.5 明确没做的（别当遗漏）

| 能力 | 参照实现 | 为什么本轮不做 |
|---|---|---|
| 子代理（Task / subagents） | 两者都有 | 需要独立上下文 + 工具面裁剪 + 递归预算，是一整套运行时；先让单 agent 的工具面扎实 |
| 向用户提问（AskUserQuestion） | Claude Code | 需要新的卡片类型与"等待用户输入"的会话状态机，牵动 SSE 与恢复逻辑 |
| 联网搜索（WebSearch） | 两者都有 | 没有可用的搜索后端；未接入就编造搜索结果是铁律禁止的。宁可只给 `web_fetch` |
| 计划模式（ExitPlanMode） | Claude Code | `todo_write` + 审批卡已覆盖"先给计划再动手"的实际需求 |

### 11.6 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:skills` | 23 项全绿（内置逐字段一致 + 文件技能结构 + 撞名检测） |
| `npm run test:agent-tools` | 88 项全绿（新增 22 项：glob/grep/read 分页/SSRF 拦截/技能加载/精确替换三层防线） |
| `npm run test:smoke` | 七阶段全通过：冒烟 119 + 仓库克隆 21 + 数据库浏览 35 + 资产表单 + 上下文压缩 + 影子链路 + 工单链路 |

## 12. 变更记录（2026-11-15 工具面收敛：28 → 22，并新增 2 个工具）

上一轮把工具面堆到了 28 条（active 27/预算 30）。这一轮先**收敛再扩容**：
合并 9 条"同对象多动词"的工具，腾出预算后加 2 条真正缺的能力。

### 12.1 合并判据（比合并结果更重要）

判据只有一条：**同一个对象 + 互斥的动词**。

| 合并后 | 吸收的旧工具 | mode 取值 |
|---|---|---|
| `code_find` | `code_search` / `code_grep` / `code_glob`（新增 refs） | `regex` / `glob` / `index` / `refs` |
| `code_view` | `code_read` / `code_symbols` / `code_diff` | `content` / `outline` / `diff` |
| `db_inspect` | `db_schema` / `db_tables` | `tables` / `schema` / `counts` |
| `browser` | `browser_navigate` / `browser_read_page` | `navigate` / `read` |
| `skill` | `skill_list` / `skill_load` | `list` / `load` |
| `code_edit` | `code_edit` / `code_edit_str` | `replace` / `rewrite` |

**故意不合并的反例**（这是判据的边界，不是遗漏）：

| 看起来可以合 | 为什么不合 |
|---|---|
| `db_query` + `db_query_write` → `db_query(mode=read\|write)` | 对象相同、风险档不同。审批看**工具名**，一旦合并，"要不要审批"就取决于模型传的字符串 |
| `code_edit` + `fs_write_file` | 写工具按**落点**分（代码库 / 工作区），落点决定快照目录与资产归属 |
| `srv_status` + `srv_log_tail` | 对象不同（主机 vs 日志文件），合了只会让描述更长 |

合并的代价必须显式付：所有多 mode 工具的 `mode` 都进 `required`，
缺了直接报错并列出可选值——**不允许靠默认值猜**。猜错的代价是"看起来成功、其实查错了东西"，
比报错贵得多。

### 12.2 新增 2 个工具

| 工具 | 语义 | 边界 |
|---|---|---|
| `git_history` | `log`（提交列表）/ `blame`（逐行溯源）/ `show`（某次提交改动） | 真 git CLI、只读；`rev` 只接受引用字符集（`-` 开头会被 git 当选项，`--output=` 就能写文件）；`path` 禁绝对路径与 `..`；8s/2MB 双限 |
| `memo` | `write`（追加/覆盖）/ `read`（取回） | 落 `conversation_memo` 表，**跨上下文压缩存活**；12000 字符封顶（从最旧裁，如实报裁掉多少）；单条 ≤2000 字符；动作名 `memo.note` 刻意不含 write，否则每条笔记都弹审批 |

`memo` 与 `todo_write` 的分工写进了工具描述：**todo 记进度，memo 记事实**。
进度可以重排，事实重查一次就是几十分钟——所以后者才需要独立存储。

### 12.3 旧名兼容层（不是过渡期凑合）

```
LEGACY_TOOL_ALIASES（tool-catalog.ts） 旧名 → {正式名, 固定 mode, 参数改名}
normalizeToolCall()                     只在执行器入口归一
TOOL_REGISTRY 里的旧名记录              保留，权限仍按它自己的读写档裁决
```

三个必须保留旧名的理由：① 历史 `tool_call` / 审计行按旧名查询；
② 14 个内置技能的模板正文写着旧名；③ 旧客户端缓存的 `toolsSpec` 里还有旧名。

两条硬规则：
- **别名自带的 mode 优先于调用方传的 mode**。否则 `code_grep` 能被传成 `mode=glob`，
  旧名就成了"指东打西"的口子。
- **归一放在执行器入口，而不是每个调用点**。否则"旧名有 bug、新名修好了"必然发生一次。

### 12.4 目录自检（`validateToolCatalog()`）

把"改了一处忘了另一处"变成测试期可见的报错，检查的都是**曾经真实漂移过**的地方：
目录 ↔ 权限表的动作名/风险档/读写属性、`required` 的键是否存在于 `params`、
多 mode 工具是否把 mode 放进 `required`、别名指向的工具与 mode 是否存在、
别名的写动作是否与正式名一致（差一格 = 换个名字就能绕过审批）、工具面是否超预算。

自检不只活在测试里：`GET /api/tools` 与 `/api/skills` 同口径，自检不过直接 500 并列出问题
——工具面与权限表漂移的后果是"换个名字就能绕过审批"，静默返回一个错的面比报错更糟。

新增表一张（`schema.sql`，`CREATE TABLE IF NOT EXISTS` 对老库同样生效）：

```sql
CREATE TABLE IF NOT EXISTS conversation_memo (
  conversation_id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT ''
);
```

### 12.5 陷阱补充（接 §6 / §11.4 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 20 | 给 `git blame` 传 `--no-color` | 部分 git 版本的 blame 颜色选项是 `--color-lines` / `--color-by-age`，`--no-color` 被判**歧义**直接失败（实测 git 2.4x：`ambiguous option: no-color`）。execFile 没有 tty，本来就不着色，去掉即可 |
| 21 | 合并工具只写 `mode`，忘了放进 `required` | 模型会省略它，然后被默认值悄悄带到另一个动作上：查文件变成搜内容，还不报错 |
| 22 | 别名归一直接覆盖 `args.mode` | 覆盖方向反了就等于给了旧名一个自由模式。别名是**固定语义**，mode 必须由别名说了算 |
| 23 | 只改执行器不改测试的 `run()` 助手 | 旧名不再出现在派生面上，`face.all.find(旧名)` 拿到 `undefined`，资产绑定回落到静态默认值——测试会"看起来在跑"，其实绑定的是另一个资产 |

### 12.6 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:skills` | 23 项全绿（内置逐字段一致，含改名后的 tools/模板） |
| `npm run test:agent-tools` | 111 项全绿（新增 23 项：工具面收敛/别名归一/自检/refs/git_history/memo） |
| `npm run test:browser-tool` | 23 项全绿（含"缺 mode 必须报错"） |
| `npm run test:smoke` | 七阶段全通过 |

## 13. 变更记录（2026-11-15 补广度：3 个新工具 + 3 个新技能）

上一轮（§12）是"先合并腾预算"，这一轮是"把腾出来的位置花掉"。判断顺序很明确：
**先决定新增，再决定合并**。反过来做会得出"位置不够所以不加"的结论，那是预算在替产品做决定。

### 13.1 新增 3 个工具（目录条目 22 → 25，active 24）

| 工具 | 填的是哪个洞 | 关键约束 |
|---|---|---|
| `web_search`（mode 无，纯查询词） | 上一轮只有 `web_fetch`：URL 已知才有用，而"去哪找"才是常态。§11.5 当时把 WebSearch 列为"没做"，理由是"没有搜索后端就不许编造" | **没配 `DEVWORK_SEARCH_URL` 就明确报错**，报错里直接给替代路径（`web_fetch` + 已知站点）。配了就按 SearXNG 兼容格式解析，兼容 `results` / `data` / 裸数组三种返回 || `subtask`（只读子代理） | 主上下文是稀缺资源。一次"这个超时在哪设的"要翻 15 个文件，20 轮后模型记得的是文件名而不是问题 | 四条硬约束见 §13.2 |
| `fs_manage`（move/copy/mkdir/delete 写工具） | 原来只能**改内容**不能**改结构**：重命名、挪目录、清理无用文件全做不到，而这是"整理仓库"最常见的诉求 | 删除**走回收站**不真删；`from` 与 `to` **都要**过 `resolveRepoPath`（只校验 from 等于允许"搬到仓库外"）；全部走审批卡 |

`db_inspect` 顺带多了 `mode=explain`：慢查询排查的核心动作，跑 `EXPLAIN QUERY PLAN` 并把扫描方式如实列出。
**它只给计划，不给"慢/不慢"的结论** —— 200 行的表全表扫比走索引还快，替用户下结论就会误导。

### 13.2 子代理的四条硬约束（每一条都在防"另一个会说谎的地方"）

1. **只读**。子面由调用方裁剪，执行器里**再挡一次**：任何不在白名单的工具直接拒绝。权限不能只依赖"调用方记得裁剪"。
2. **不可递归**。子面剔除 `subtask` 自身，否则一个任务能炸成 N 个子任务。
3. **无模型就不跑**。`gateway.kind === 'mock'` 时直接拒绝并说明原因 —— 演示轨迹是编的，把它包装成"子代理的调研结论"是本仓库最不能犯的错。
4. **预算可数**。默认 12 次工具调用 / 90 秒，用尽标 `exhausted` 并**不把用尽当完成**：摘要里必须写清哪部分没查完。

另外一条设计决定：**不回传子代理的中间工具行**。原因不是省 token，而是主模型看到"15 条工具行"会以为自己查过了，然后开始引用自己没读过的文件。摘要必须是一段可独立成立的文字。

### 13.3 为什么 `web_search` 不做私网拦截

`web_fetch` / `browser` 禁私网是因为**模型能指定目标地址**（SSRF 面）。
`web_search` 的基址来自环境变量、模型只能给查询词，攻击面不同；而自建 SearXNG 本来就在内网，
套那层限制会让唯一的合法用法失效。**同一个检查不该无差别套在两种不同信任边界上。**

配套的**状态披露**：`/api/health` 加了 `webSearch: boolean`，设置页权限分区多一行「外部检索」。
理由是"不能让用户以为搜不到是 Agent 笨"——没接入时工具会明确报错，但如果界面什么都不说，
用户只会看到 Agent 反复说"抓不到"。三态文案与「内网访问」那行同口径：
**拿不到值就说「未获取到状态」，不默认成"未接入"**（默认 false 会让用户去找一个其实存在的配置）。

### 13.4 新增 3 个文件技能（8 个，总技能 22）

- `subagent-brief`：怎么把任务写成"自包含"的——子代理看不到主对话，`goal` 里少一个文件路径，它就会去猜。
- `file-refactor`：移动/复制/删除的安全顺序，重点是"删得掉也要还得回来"。
- `query-explain`：执行计划判读。**与内置 `slow-query` / `perf-triage` 分工写进了正文第一段**：那两个负责"从日志里找出是哪条 SQL / 端到端分诊"，这个只管"拿到一条语句后怎么读计划"。

技能 id 撞车被自检抓了一次（`perf-triage` 与内置同名），改名 `query-explain`。
这正是 §11.2 里那条设计的意义：**文件技能的 id 唯一性必须是加载期报错，不能靠数组顺序决胜。**

### 13.5 陷阱补充（接 §6 / §11.4 / §12.5 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 24 | 文件技能 id 与内置技能同名 | 加载器按数组顺序取，谁赢取决于文件系统遍历顺序。自检必须把"id 撞车"当错误，而不是当覆盖 |
| 25 | `tools` 里混进写工具 | 技能的 `tools` 是**只读白名单**，写工具必须进 `writeTools`。混进去的后果是技能被当成"可以直接写"的授权，绕开了审批 |
| 26 | 子代理直接把 `history` 传下去 | 传了就等于子代理继承了主上下文，"独立上下文"这个前提消失，省 token 的意义也没了。`history` 必须是空数组 |
| 27 | `fs_manage` 只校验 `from` | 只校验源等于允许"从仓库里搬到仓库外"。两个路径都要过 `resolveRepoPath` |

### 13.6 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:skills` | 26 项全绿（含 8 个文件技能的结构校验、id 撞车自检） |
| `npm run test:agent-tools` | 127 项全绿（新增 16 项：子代理拒绝路径 / web_search 未配置报错 / fs_manage 四动作 / explain） |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过 |

## 14. 变更记录（2026-11-15 补深度：词法层）

§13 补的是"能做什么"，这一节补的是"说得对不对"。触发点是上一轮自己留下的问题：
`code_find(mode=refs)` 是子串匹配，注释里写一句 `// 这里也要调 setConnectTimeout`
就会被算成一处引用，模型据此说出"有 7 处调用"——而真实调用可能只有 3 处。
**误报比漏报更贵**：它不会让模型停下来，只会让它在错的前提上继续推理。

### 14.1 新增 `backend/src/services/code-lex.ts`（纯函数，无 fs）

三件事，都建立在同一个原语上：**先把注释与字符串抹成空格，保留行列位置与换行**。

| 函数 | 作用 | 为什么不能只靠正则 |
|---|---|---|
| `maskNonCode(content, lang)` | 状态机抹注释/字符串 | 块注释、模板字符串、Java 文本块、Python 三引号都是**跨行**的。逐行处理必然把"字符串的第 2 行"当代码 |
| `extractSymbols(masked, original, lang)` | 符号 + 起止行 + 所属容器 | `// class FakeController` 会在侧栏里多出一个可点击的符号，点了跳到注释 |
| `findOccurrences(masked, original, name)` | 定义/引用分类 + **被排除数** | 注释/字符串里的同名文本不该计入，但"排除了多少"本身就是有用信息 |

三个方言各自处理：`ts/clike`（`//` `/* */` `` ` `` + `${}` 递归回代码态）、`java`（含 `"""` 文本块）、
`python`（`#` + `'''`/`"""` + 缩进区间）。

### 14.2 `mode=refs` 的输出变了（这才是这一节的重点）

```
符号 setConnectTimeout：代码里出现 1 处（定义 0 / 引用 1），涉及 1 个文件
注释与字符串里没有同名文本（本次排除 0 处）
（词法级判定，非类型系统：同名不同符号会合并；不做正则字面量识别）
```

三条设计决定：

1. **"被排除 N 处"必须单独报**。模型的直觉是"grep 到 7 处、工具说 3 处 → 工具漏了"。
   把差值的来源直接写出来，它才不会去怀疑工具，也不会把 7 当事实。
2. **绝不说"引用共 N 处"**。只说"代码里出现 N 处"——措辞上就不给"这是引用计数"的暗示。
   `User.save()` 与 `Order.save()` 会被合并，这个局限要说在输出里，不是因为可以修掉，是因为**不能说没有**。
3. **定义 0 处要能解释得通**。`setConnectTimeout` 在仓库里确实只有调用没有定义（来自 Spring 客户端），
   旧输出说"疑似定义 0 处，这个符号可能来自依赖或拼错了"；新输出直接写"定义 0 处"，
   不加猜测。**能确定的事说确定，不能确定的别补一句。**

### 14.3 `mode=outline` 带区间与容器

`- [M] InventoryClient.setTimeout L5-7`。模型据此可以直接
`code_view(mode=content, offset=5, limit=3)` 读方法体，不必"从第 1 行读到第 400 行再自己找"。

没有解析出闭合大括号时**只写起始行、不写区间**（`L12` 而不是 `L12-12`）——
后者看起来像"这个方法只有一行"，是另一种形式的撒谎。

顺带修掉两个噪音源：

- **注释里的假声明**不再进大纲（词法层保证）；
- **函数体内的局部变量**不再进大纲（`declDepth === 0` 才收）。少列 20 个 `tmp`，大纲才会有人看。

### 14.4 两处刻意不做

- **不做类型解析**。真引用关系需要符号表（`User.save` vs `Order.save`），那等于引入一个语言服务。
  现在这一步的收益/成本比最好，再往上就走错方向了。
  （§15 补了一句修正：不做类型解析，**不等于**把歧义留给一句免责声明——歧义可以"摆出来"。）
- **不识别正则字面量**（`/foo/g` 里的标识符仍算引用）。反过来（把除法当正则起始）
  会破坏后续所有解析——**错在没有能力总比错在状态错乱好**。

### 14.5 陷阱补充（接 §6 / §11.4 / §12.5 / §13.5 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 28 | 抹除时把换行也抹掉 | 行号是引用证据的坐标。换行必须是"保留原字符"，其余才替换成空格 |
| 29 | 模板字符串整体当一个字符串 | `` `${foo()}` `` 里的调用是真实代码。要能回到代码态并数清嵌套的 `{}` |
| 30 | 逐行处理注释/字符串 | 块注释与三引号跨行。必须用**跨行状态机**，否则"字符串第 2 行"会被当代码 |
| 31 | 大纲把局部变量也列出来 | 只看 `declDepth === 0`（模块级/类体第一层）。局部变量不是导航目标，列出来只会让人不再看大纲 |
| 32 | 抹过的文本反过来当原文输出 | `signature`/`snippet` 必须取自**原文**。抹过的文本里字符串是空格，拿它当签名等于把代码显示成空白 |

### 14.6 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 147 项全绿（新增 20 项 B5：抹除/符号/三方言/定义与引用分类/端到端 refs 与 outline） |
| `npm run test:skills` | 26 项全绿（`code-navigator` 已同步 refs 新口径） |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过 |
| `npm run test:shadow:core` | 通过（大纲接口形状向后兼容：只加可选字段） |

## 15. 变更记录（2026-11-15 补同名分组：把 refs 的歧义摆出来）

§14 收尾时留下一个二选一：`refs` 把 `User.save` 与 `Order.save` 合并计数，只在输出里写一句
"同名不同符号会合并"。这句免责声明真正的毛病是——它把判断责任推给模型，
而模型手上**没有任何信息**可用于判断。两条下一步：

| 方案 | 代价 | 结论 |
|---|---|---|
| 写 Java/TS 各 200 行局部符号表 | 只覆盖两种语言，第三门语言又回到原点 | 否决 |
| 按**书写形式**分组（接收者 / 所属符号 / 定义落在哪个容器） | 分组可能分错；只承诺拼写，不承诺类型 | 采纳 |

采纳第二个不是因为便宜，是因为它**不会撒谎**：`user.save()` 里的 `user` 是原文里实打实写着的，
"`user` 的类型是 `User`" 才是推断。前者能当证据，后者不能。

### 15.1 三个字段 + 三张表

`findOccurrences` 的每条命中多了两个字段（**不改变任何计数**，只加解释）：

| 字段 | 取自 | 例子 |
|---|---|---|
| `receiver` | 命中位置左边的标识符链 | `user.save()` → `user`；`this.repo.save()` → `this.repo` |
| `scope` | 包含该行的最内层符号（用 §14.3 的区间 + 容器） | `OrderController.get` |

`summarizeRefs(hits)` 压成三张表：定义落在哪些容器 / 引用按什么接收者写出 / 引用分布在哪些符号里。
每张表上限 6 组，超出部分报"另有 N 个分组未列出"——**截断要出声**。

`receiver` 只认标识符链，不认 `new X().` 与 `arr[0].`：认不出就归入"(裸名)"，不猜。

### 15.2 输出（真跑出来的）

夹具：`User` 与 `Order` 各一个 `void save() { }`，另有一行注释提到 `save`。

```
符号 save：代码里出现 4 处（定义 2 / 引用 2），涉及 1 个文件
另有 1 处出现在注释或字符串里，已排除（不是代码引用）
（词法级判定，非类型系统：同名不同符号在总数里合并、在下面的分组里分开；不做正则字面量识别）
同名候选分组（按书写形式分，不做类型推断）：
  · 定义落在 2 个容器：Order.save 1、User.save 1
  · 引用按接收者：order 1、user 1
  · 引用按所在符号：Caller.run 2
定义：
- v9-test/refs/Save.java:L4:C8 · void save() { }
- v9-test/refs/Save.java:L8:C8 · void save() { }
```

四条决定：

1. **只在真有歧义时才印**。判据是"定义容器 > 1 或接收者分组 > 1 或所在符号 > 1"。
   单定义 + 单接收者的符号多印三行只是噪音。
2. **全是裸名时整行不印**。类型名（`Order`）的引用永远没有接收者，`(裸名) 4` 什么都说明不了。
3. **定义 1 处时说"大概率同源"，不说"就是同一个"**。依赖里的同名方法不在扫描范围，
   这句限定必须带着走。
4. **同一个数字不给两种口径**。总数仍然是"代码里出现 N 处"，分组只是把 N 拆开看；
   绝不出现"引用共 N 处"这种结论式措辞（§14.2 第 2 条继续有效）。

### 15.3 顺带修掉的定义漏检

写夹具时发现的真缺陷：`extractSymbols` 的成员判定要求行尾是 `{` 或 `=>`，于是

- `void save() { }`（单行体，Java getter / 空实现的常见写法）**不算定义**；
- `List<Order> findByStatus(String s);`（接口/抽象声明）**也不算定义**。

结果是 `refs` 说"定义 0 处"——而这个符号明明有定义。现在的判定改成三选一：
块体 `{` / 单行体 `{ ... }` / 抽象 `);`，其中 `);` 加两道排除
（前缀是 `return|throw|yield|new|await`，或 `(` 前出现赋值），否则
`return new Foo(x);` 会被当成一个叫 `Foo` 的方法。

### 15.4 陷阱补充（接 §6 / §11.4 / §12.5 / §13.5 / §14.5 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 33 | 把"同名会合并"写成免责声明就完事 | 免责声明只在**没法给信息**时才合格。能给分组就给分组，把歧义摆出来 |
| 34 | 分组键用推断出来的类型 | 只能用原文里写着的拼写（`user`）。推断出来的键分错一次，整张表都不可信 |
| 35 | 分组静默截断 | 超出上限要说"另有 N 组未列出"。否则模型以为这就是全部 |
| 36 | 单行方法体 / 接口声明不进符号表 | `void save() { }` 与 `foo();` 形状相似但含义相反。用"前缀是 return/含赋值"排除表达式，别用行尾字符排除声明 |

### 15.5 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 152 项全绿（新增 6 项 B3-10a~e：同名分组/口径/注释排除/分组上限） |
| `npm run test:skills` | 26 项全绿（`code-navigator` 增加"先看分组再下结论"步骤） |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过 |
| `npm run test:shadow:core` | 75 项全绿 |

## 16. 变更记录（2026-11-15 补广度：diff 的两处"看不见"）

上一节把 `refs` 的精度补了一层，这一节回到广度，补的是 `code_view` 上的两个诚实性缺口。
两个缺口的共同点：**工具说的和事实不符，而且不符的方向都指向"少做一件事"**。

| 缺口 | 现象 | 代价 |
|---|---|---|
| 未追踪的新文件 | `git diff HEAD` 永远不含未追踪文件，于是输出"无变更（clean）" | 模型据此认为"这个文件没改"，而它可能是这次唯一的产出 |
| 整仓清单缺失 | 只有单文件 `mode=diff`，模型想知道"改了哪些文件"只能猜文件名 | 猜文件名是这一步唯一的幻觉入口，猜错就是"查了但没查到" |

### 16.1 diff 从两档变三档

`fileDiff` 返回 `{ diff, clean, untracked }`：

```
clean = (diff 为空) && (文件已被追踪)
```

`untracked` 只在 `git diff HEAD` 为空时才去问 `git status --porcelain`——有 diff 就已经说明
文件被追踪且已改动，多跑一条 git 是浪费。三种结果对应三个不同动作：

| 结果 | 模型该做的 |
|---|---|
| clean | 不用看，基线干净 |
| 未追踪 | **必须**用 `mode=content` 读原文（diff 里没有内容），且回滚没有基点 |
| 有变更 | 看 diff |

前端 `CodeDetail` 的 Diff 按钮也分成三个 toast——服务端分了档、界面又合并回去，
等于在 UI 层把同一个谎再说一遍。

### 16.2 新增 `code_view(mode=status)`

`git status --porcelain=v1 --untracked-files=all`，path 可选（给了就只看该路径）。
四条实现细节都不是可选优化：

1. **`--untracked-files=all` 必须加**。默认只给目录级 `?? v9-test/`，而"新增了哪些文件"正是要看的东西。
2. **重命名原样保留**（`R  old -> new`）。拆成两行就丢掉"从哪来"，而"从哪来"决定这次改动的影响面。
3. **敏感路径只报数量、不回显**。文件树有 12 条排除规则，status 若不接同一套规则，就是自己开的后门。
4. **上限 40 项并如实说明截断**。大改动时列 300 行只会把上下文烧光。

状态码原样输出（`M ` / ` M` / `??` / `D `），因为"已暂存"和"未暂存"对提交动作的影响不同——
归并成"改了"就丢掉了这条信息。

### 16.3 path 退出 required：契约松紧的取舍

`code_view` 原来是 `required: ['mode', 'path']`，status 不需要 path，只能把它拿掉。
代价是 `content` / `outline` 缺 path 时不再由工具 schema 拦。处理方式：

- 只放 `path` 一个字段，`mode` 仍在 required（"必须说清要干什么"这条不让）；
- 执行器补一条显式错误，并**顺手指出替代路径**：`mode=content 需要 path……想看"改到了哪些文件"请用 mode=status`。

**校验从 schema 挪到执行器，错误信息就必须写得更具体**；否则等于白松一次，只是把
"参数错误"换成了"工具返回奇怪的空结果"。

### 16.4 技能同步（说明什么时候该用哪个）

| 技能 | 改法 |
|---|---|
| `release-check`（内置） | ① 先 `mode=status` 拿清单 → ② 对风险最高的 2-3 个文件再 `mode=diff` |
| `diff-review`（文件技能） | 「逐个看关键文件的未提交变更」→ 先清单后抽样，并写明"未追踪"要改用 content |
| `write-safety`（文件技能） | 确认基线时补一句：未追踪文件回滚没有基点，先存原文 |

`frontend/src/data/mock.ts` 里的同款模板同步改了一遍——两处文案必须一致，
否则演示数据和真实技能说的不是一件事。

### 16.5 陷阱补充（接 §6 / §11.4 / §12.5 / §13.5 / §14.5 / §15.4 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 37 | 把"空 diff"读成"没有改动" | `git diff HEAD` 不含未追踪文件，也不含被 `.gitignore` 忽略的文件。空 diff 必须先问 `git status` 才能下结论 |
| 38 | 文件树过滤敏感路径，status 忘了过滤 | 任何"能看见文件名"的新通道都要接同一套规则。这里只报数量、不回显路径 |
| 39 | 为少一个参数把 required 整组放开 | 只放开确实可选的字段，并在执行器补更具体的错误信息 |
| 40 | 服务端分了三档，界面合并成两档 | 分层就要一路分到底：UI 把 untracked 显示成 clean，等于在展示层重犯同一个错 |

### 16.6 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 158 项全绿（新增 6 项 B3-12a~f：未追踪/整仓清单/路径过滤/干净路径/敏感隐藏/缺 path 报错） |
| `npm run test:skills` | 26 项全绿（release-check 模板改为先 status 后 diff） |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过 |
| `npm run test:shadow:core` | 75 项全绿 |

## 17. 变更记录（2026-11-15 补 git show 的证据完整性）

§16 之后剩下最后一个"会骗人但不容易被发现"的地方：`git_history(mode=show)` 的
`result.stdout.slice(0, 4000)`。它在一段 unified diff 的**中间**裁一刀。

裁在中间的问题不是"少看了一点"，而是**裁出来的东西看起来是完整的**：
一个 hunk 里 `-oldMethod()` 在上面、`+newMethod()` 在下面，切开之后只剩前半段，
读起来就是"这次提交删了一个方法"。**半个 hunk 比没有 hunk 危险**：
没有 hunk 会让人再查一次，半个 hunk 会让人生成一个确定的错误结论。

### 17.1 新增 `backend/src/services/git-diff.ts`（纯函数，无 fs）

| 函数 | 作用 |
|---|---|
| `splitDiffByFile(diffText)` | 按 `diff --git` / `diff --cc` 切成文件块，附路径、hunk 数、是否二进制 |
| `assembleDiff(chunks, budget)` | 按预算装配，**只在文件边界与 hunk 边界上裁** |

装配的三档降级（越往下越保守，并且每一档都把自己的缺口说出来）：

| 档 | 条件 | 输出 |
|---|---|---|
| ① 整文件 | 文件 diff + 40 ≤ 剩余预算 | 完整 diff，抬头写 `（N 个 hunk）` |
| ② 整 hunk | 装不下整文件，但装得下部分 hunk | 完整 hunk 若干 + 抬头写 `（N 个 hunk，本次展开前 M 个）` |
| ③ 行窗口 | 连一个 hunk 都装不下 | 前 K 行 + 尾注 `[该 hunk 还有 X 行未显示]`，K/X 都是准确数字 |

第 ③ 档为什么存在：如果只做到 ②，一个大 hunk 的文件会**永远拿不到任何内容**——
调用方再换 `path=` 重新 `show` 一次，拿到的还是同一段超长 hunk。死路。
行窗口是"标好行数的半个 hunk"，与"裁完不说"是两件完全不同的事。

### 17.2 分配顺序与输出顺序必须分开

第一版按文件顺序分配，实测一个 6.4KB 的文件吃掉 4953/5000 字符，
同提交的两个**只有 2 行**的小文件被整段挤掉——而小文件往往才是结论所在。
（这段取舍在写代码前就被我写进了注释，实现却相反。注释不能替代测试。）

现在的规则：

- **分配先小后大**：预算有限时，最小的改动优先获得完整展示；
- **输出保持原文件顺序**：读者看到的是这次提交的真实形状，而不是预算排序的结果；
- **单文件上限 = 预算的 40%**（下限 600）：只约束 ②③ 两档，不约束整文件。
  没有这条，三个 8KB 文件里第一个就会把另外两个变成"未展开"。

真实效果（4 文件提交，预算 5000）：`完整 2 个 · 行窗口 2 个`，四个文件都有内容，
没有一个是"未展开"。

### 17.3 输出长这样

```
git show HEAD · 共 4 个文件
8f53f90|2026-11-15|DevWork|test: 多文件提交
 v9-test/show/big-a.ts   | 120 +++...
 v9-test/show/small-a.md |   2 +
 4 files changed, 244 insertions(+)
（diff 按文件整段展开：完整 2 个 · 行窗口 2 个，共用 4359/5000 字符）
hunk 过长、只给了行窗口的文件：big-a.ts（28/121 行）、big-b.ts（28/121 行）——窗口末尾写着还剩多少行
--- v9-test/show/big-a.ts（1 个 hunk，第 1 个 hunk 共 121 行，本次只给前 28 行）---
diff --git a/v9-test/show/big-a.ts b/v9-test/show/big-a.ts
...
[… 该 hunk 还有 93 行未显示：换更小的 path 范围，或用 code_view(mode=content) 读原文件 …]
```

`--stat` 单独一次调用：它短、永远完整，而且"这次改动大不大"应该由它先回答，
而不是由第一个文件的 diff 猜。

### 17.4 陷阱补充（接 §6 / §11.4 / §12.5 / §13.5 / §14.5 / §15.4 / §16.5 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 41 | 对 diff 做字符截断 | 只能按文件/ hunk 边界裁。半个 hunk 会读成"删了几行"，而且看不出来被裁过 |
| 42 | 只按顺序分配预算 | 顺序决定取舍时，取舍就由体积决定。分配按尺寸、输出按原序，两件事分开 |
| 43 | 把"装不下"处理成"什么都不给" | 换 `path=` 重查也拿不到同样的内容，等于死路。给标好行数的窗口 |
| 44 | 注释里写了正确取舍，实现没跟上 | 写进注释的判断必须有一条测试盯着，否则它只是自我安慰 |

### 17.5 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 166 项全绿（新增 7 项 B3-14a~h：stat 概览/路径过滤/文件切分/整 hunk/行窗口/预算充足/小文件优先/巨型文件不挤人） |
| `npm run test:skills` | 26 项全绿 |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过 |
| `npm run test:shadow:core` | 75 项全绿 |

## 18. 变更记录（2026-11-15 收掉同一个 bug 的第二处）

§17 把 `git show` 的字符截断换成了边界装配，但同一个毛病还有第二处：
`code_view(mode=diff)` 的 `diff.diff.slice(0, 3000)`。**单文件视图更容易踩**——
一个文件改了几百行时，模型只拿到前三行改动，而抬头没有任何提示。

这次不是重写，是**复用** `assembleDiff`。复用的过程中暴露了两个"适配差异"，
它们比功能本身更值得记：

| 差异 | 多文件视图 | 单文件视图 | 处理 |
|---|---|---|---|
| 单文件 40% 上限 | 必要（防止一个文件抢走别人的份额） | **必须失效**（没有"别人"） | `chunks.length <= 1` 时上限 = 整个预算 |
| 块抬头 `--- path（N 个 hunk）---` | 必要（多文件时区分） | 冗余（正文第一行已经印了路径） | `options.header: false` |

### 18.1 上限跟着"有没有竞争者"走

`assembleDiff` 里有 `perFileCap = max(600, cap * 0.4)`。直接拿它跑单文件，
一个 4000 字符的 diff 在 3000 预算下只会展开 1200 字符——**明明预算够，却只给三分之一**。
这条上限的语义是"别抢别人的份额"，单文件视图里不存在"别人"，所以它必须失效：

```
perFileCap = chunks.length <= 1 ? cap : max(600, cap * 0.4)
```

测试 B3-12h 专门盯这件事：同一份两 hunk 的夹具，预算 3000，
断言「展开 1 个完整 hunk」而不是「退成行窗口」。若上限还在，一个 hunk 都装不下。

### 18.2 关掉抬头时，行数不能跟着关

`header: false` 省掉 `--- path ---` 装饰，但**降级档的行数必须留在正文里**：

```
（第 1 个 hunk 共 129 行，本次只给前 38 行，其余 1 个 hunk 未展开）
```

「其余 N 个 hunk 未展开」是这轮补的一句。之前只说「第 1 个 hunk 共 129 行，只给前 38 行」，
读者要靠抬头里那个「共 2 个 hunk」自己减——**减法不该由模型做**。

真实输出（往 `OrderService.java` 顶部插 120 行后的单文件 diff）：

```
src/main/java/order/OrderService.java 的未提交变更（共 2 个 hunk）：
（本次展示 2977/3000 字符；没展示的部分就是没展示，别把"没看到"当成"没改"）
这个 hunk 太长，只给了行窗口——末尾写着还剩多少行，缺的部分用 mode=content 按行号补读
（第 1 个 hunk 共 129 行，本次只给前 38 行，其余 1 个 hunk 未展开）
diff --git a/src/main/java/order/OrderService.java b/src/main/java/order/OrderService.java
@@ -1,6 +1,127 @@
 ...
[… 该 hunk 还有 91 行未显示 …]
```

单文件时上面第二条不再复述数字（块里已经写了），只说下一步用 `mode=content` 补读——
**重复的数字白烧 token，缺的下一步才是模型需要的**。

### 18.3 顺带修掉的一个假错误信息

`fileDiff` 里所有异常都被归成 `E_GIT_UNAVAILABLE / git 不可用`。但 `execFileSync` 默认
`maxBuffer` 是 1MB，超过抛 `ENOBUFS`——于是"这个文件改了 6MB"会被说成"git 没装"。
两句话指向完全不同的下一步（一个让你缩小范围，一个让你放弃）。

现在：`maxBuffer` 显式设 8MB；溢出单独成 `E_DIFF_TOO_LARGE` 并给绕行方式
（`mode=content` 读原文，或按目录拆分）。**错误码是给程序看的，错误消息是给模型看的**，
把两种完全不同的失败塞进同一个字符串，等于让模型自己猜"是环境坏了还是数据太大"。

### 18.4 同步

- `tool-catalog` 的 `code_view` 描述：diff 与 show 同一套边界规则；
- 系统提示词：`mode=diff` 抬头写着「共 N 个 hunk、本次展示多少」时，没展开的 hunk 等于没看；
- 文件技能 `diff-review`：审查结论只覆盖已展开的 hunk 时要明说，否则"看过了"是假的。

### 18.5 陷阱补充（接 §6 / §11.4 / §12.5 / §13.5 / §14.5 / §15.4 / §16.5 / §17.4 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 45 | 复用装配器时把"多文件"的默认假设一起搬过去 | 上限类参数要跟着"有没有竞争者"变，单文件视图里 40% 就是削足适履 |
| 46 | 关掉冗余抬头时连带关掉了降级说明 | 抬头是装饰、行数是证据，两者必须能分开开关 |
| 47 | 让读者自己数「共 2 个 hunk 而只展开 1 个」 | 差额要写成一句话。"模型做减法"是错误设计 |
| 48 | 把所有 git 异常归成一个"git 不可用" | ENOBUFS ≠ 没装 git。错误码分开，消息给出各自的下一步 |

### 18.6 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 169 项全绿（新增 3 项 B3-12g~i：真实两处改动各自成 hunk / 单文件不吃 40% 上限 / 关抬头仍保留行数） |
| `npm run test:skills` | 26 项全绿 |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过（含工单链路 35/35） |
| `npm run test:shadow:core` | 75 项全绿 |

## 19. 变更记录（2026-11-15 给遗留标记补归属）

`code_todos` 原来是散在 `agent-tools.ts` 分发分支里的一个私有 `walk`。它的输出是
`- path:L42 · TODO · 改成异步`——知道"哪一行有个 TODO"，但不知道**这一行在哪个方法里**。
改它的人得先自己去找上下文，而找上下文正是这个工具本该省掉的那一步。

### 19.1 搬到 `code-nav.scanTodos`

三个变化，第一个跟功能无关但更重要：

| 变化 | 说明 |
|---|---|
| 复用 `walkFiles` | 原来分支里自带一份 `skipDirs` + `textExt` + 200KB 判断。这三条规则在 glob/grep 里已经有过一份，两套实现必然漂移——**敏感文件过滤也是从 `walkFiles` 里来的**，自己再写一份就等于给自己开后门 |
| 补 `owner` | 包含该行的最内层符号（复用 §14.3 的区间 + 容器） |
| "可能没扫全"拆成三个事实 | 大文件跳过数 / 遍历上限截断 / 命中触顶，三者原因不同，混成一句"已截断"就没人能判断该不该重扫 |

**懒解析**是关键的成本控制：只对**真有标记**的文件跑 `maskNonCode` + `extractSymbols`。
整仓扫 TODO 时给几千个文件建符号表，为了四条命中付一次全量词法成本，不划算。

### 19.2 归属只回答"写在哪"，不回答"该谁修"

四档措辞，缺一档就会开始编：

| 情况 | 输出 | 为什么 |
|---|---|---|
| 在方法里 | `@ Probe.saveOrder` | 原文能直接读出的事实 |
| 在类里、方法外 | `@ Probe` | 只有类包含它，说成方法就是编 |
| 代码文件里谁都不包含 | `@ (模块级，不在任何方法/类内)` | "顶层"是个位置，不是推断 |
| 非代码文件（`.md`/`.json`） | 不标 | 那里没有"方法"这个概念，标"模块级"是给 markdown 编造结构 |

刻意**不做**的一件事：注释紧挨在某个方法声明上方时，不把它归给那个方法。
那需要"注释属于下一个声明"的语法约定，跨语言不一致，而且错的时候看不出来。
**宁可说"在类里"，也不说"应该是这个方法的"。**

判定"是不是代码文件"也不能用 `lexLangOf`——它对未知扩展名返回 `'clike'` 兜底，
那是"按 C 语法试试"，不是"这是代码"。用的是独立的扩展名白名单。

### 19.3 一个被真实输出逼出来的措辞修正

第一版在命中触顶时写「命中数已达上限 2：**后面还有**，提高 max 或缩小 subPath 再看」。
跑一次真实输出就发现这句话会撒谎：第 2 条恰好是仓库最后一个标记时，"后面还有"是假的，
而模型会据此再扫一遍、再得到同样 2 条。

改成只陈述**本次扫描的行为**，不预测仓库的内容：

```
扫到 4 个标记（读过 2 个文本文件）
（@ 后是包含该行的最内层符号；改之前先看这一段）
- v9-test/todos/Probe.java:L4 · TODO · 重试次数是拍脑袋定的 @ Probe
- v9-test/todos/Probe.java:L8 · FIXME · 并发下会互相覆盖 @ Probe.saveOrder
- v9-test/todos/probe.ts:L1 · TODO · 这个文件的名字先这样 @ (模块级，不在任何方法/类内)
- v9-test/todos/probe.ts:L3 · HACK · 用环境变量默认值兜底 @ loadConfig
```

触顶时第一行变成：

```
扫到 2 个标记（读过 1 个文本文件）；已达上限 2（按路径顺序截断，结果不保证完整）：要全看完请提高 max 或缩小 path
```

"结果不保证完整"永远为真，"后面还有"不总是为真。**能说的和想说的不是一回事。**

顺带：`truncated` 这个字段名也改成了 `stoppedAtCap`。它描述的是"这次扫描提前结束"，
不是"精度损失"——字段名会顺着类型定义传到调用方，叫 `truncated` 就会有人写"还有更多"。

同一个毛病在"0 命中"分支上也有一次：原来写「**这是全量结果**」。但依赖目录、构建产物、
敏感文件都按规则跳过了，"全量"是个绝对说法。改成「范围内该读的都读了（依赖目录/构建产物
按规则跳过，敏感文件不读）」——说的是**扫描做了什么**，不是**仓库里有什么**。

### 19.4 新增 `path` 参数

大仓库上"只看这个目录"是刚需，而且它让测试能只扫夹具目录（不必让整仓扫描变慢）。
path 指向文件时 `resolveScanRoot` 抛「不是目录」，执行器补一条更具体的：
`path 必须是仓库内的目录；不确定目录名就先 code_find(mode=glob) 看一眼，或不传 path 扫全仓`。
同 §16.3 的规矩——**参数校验在 schema 之外发生时，错误信息必须补到能直接行动**。

### 19.5 陷阱补充（接 §6 … §18.5 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 49 | 工具分支里自带一份遍历规则 | 跳过目录/敏感文件/体积上限只能有一份实现。复制第二份就是在复制漏判 |
| 50 | 把"注释在方法上方"当成"属于这个方法" | 只报包含该行的符号。跨语言约定不一致，错了还看不出来 |
| 51 | 用语言兜底值判断"这是不是代码" | `lexLangOf` 的 `'clike'` 是"按 C 试"，不是"是代码"。判定要用独立白名单 |
| 52 | 命中触顶时说"后面还有" | 只能说"本次提前结束、结果不保证完整"。预测仓库内容的话，错的时候没人能发现 |

### 19.6 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 177 项全绿（新增 8 项 B6d~k：夹具、方法归属、类归属、模块级、非代码不标、path 限定、触顶措辞、path 指向文件报错） |
| `npm run test:skills` | 26 项全绿（release-check 模板同步"归属"要求） |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过（含工单链路 35/35） |
| `npm run test:shadow:core` | 75 项全绿 |

## 20. 变更记录（2026-11-15 把「定位」与「验证」接成一条链）

§19 补的是归属，这一节没有新增能力。它补的是**接口**：`code-navigator` 讲怎么定位、
`write-safety` 讲怎么写、`diff-review` 讲怎么审，三篇各自都对，但它们之间没有交接物。
于是"改完到底改对没有"这一步只能靠模型自述——而自述是最容易编的证据。

### 20.1 缺口：写入结果没有"改了什么"的载体

写执行管线返回的是：

```
已精确替换 src/.../OrderService.java 第 120 行起的 1 处（75 → 111 字符）。基线快照已保留…
```

这句话回答的是"动了几处"，不是"改完长什么样"。而 `write-safety` 里写着"给出改了什么"——
**要求写了，材料没给**，剩下的只能由模型凭记忆复述。

新增 `backend/src/services/text-diff.ts`：纯函数 `diffRegion(before, after, options)`，
用公共前缀/后缀裁剪（写操作的改动是一段连续区域，结果与 LCS 一致，成本线性），
只回答三件事：改了哪几行、增删多少、改完那段长什么样。

行号口径照 git（`@@ -旧起点,旧行数 +新起点,新行数 @@`，正文不带行号）：
两侧行号系统不同（删除行属于旧文件），在同一列里混排两种编号，比不给行号更容易被读错。

### 20.2 四条实现决定

| 决定 | 理由 |
|---|---|
| 上限只约束**改动行**（默认 40），不把上下文算进预算 | 上下文是常数（两侧各 3 行）。把它计入总额，25 行改动会因为多了 6 行上下文就变成"不给"——上限成了随机数 |
| 超限时**不给片段**，只给区间 + `code_view` 读法 | 半个片段会被读成全部改动。这与 §17.1 第 ③ 档（行窗口）的取舍不同：那里是"换 path 重查也拿不到"的死路，这里下一步随时能按区间读 |
| 片段**自带围栏**，长度按内容里最长的反引号串算 | 片段会以 markdown 正文进入对话，`-old` 在 markdown 里是列表项、`+new` 是普通段落。而改的正好是 markdown 文件时，正文自带三连反引号，写死三个会被提前闭合 |
| 前后逐字节相同 → 明说"空操作" | "已精确替换"读起来像改动生效了，而磁盘一个字都没变 |

真实输出（对一个 Java 方法插入一行审计调用）：

````
已精确替换 v9-test/Evidence.java 第 10 行起的 1 处（75 → 111 字符）。基线快照已保留，可通过回滚端点恢复。
改动片段 @@ -11,0 +11,1 @@（+1）
```diff
             throw new IllegalArgumentException("qty");
         }
         Order order = new Order(sku, qty);
+        audit.write("create", sku);
         return repo.save(order);
     }
}
```
verify 只证明落盘内容与预期一致，不判断改动是否正确。
````

### 20.3 顺带修掉一句假话

`executeFileWrite` 对**新建文件**也返回"基线快照保留…可通过回滚端点恢复"，
但此时 `rollbackRef` 是 `undefined`——没有基线，没有快照，没有回滚。
文案必须跟着 `before === null` 分支走：新建文件写清楚"回滚只能靠删除它"。

这一类错误（§16 的未追踪文件、§19 的"后面还有"）有同一个形状：
**文案是常量，而事实是有分支的**。文案写死在一处，分支一多就必然有一支在撒谎。

### 20.4 `verify` 的语义边界（写进返回、写进提示词、写进技能）

`verify=通过` 证明的是「落盘的内容就是打算写的那些字节」。它**不证明打算本身是对的**。
这两句话指向完全不同的下一步（一个可以收工，一个要继续查），所以现在三处都点明：

- 写入返回最后一行固定是「verify 只证明落盘内容与预期一致，不判断改动是否正确」；
- 系统提示词写明：正确性靠重放 `code_find(mode=refs)` 与 `code_view(mode=outline)` 看结构；
- `write-safety` 的技能正文把它列成独立一段。

### 20.5 技能的交接物：定位单

`code-navigator` 的输出从"一串 文件:行号"改成一张**定位单**：

```
- 定义：src/.../OrderService.java:L120-L140（OrderService.createOrder）
- 待改处：L128（`repo.save(entity)` 这行）
- 调用点：refs 接收者分组 order 3 / service 1（共 4 处引用，1 处定义）
- 未确认：L118 的 `repo` 字段类型没读到（在此文件外声明），改参数前要确认
```

四栏分别防四种漏：改错行、漏改调用方、把猜测当事实、以及"看完就忘"。
最后一条对应 `memo`：上下文一压缩，定位单是最先消失的东西，而它正是改后验证的基线。

`write-safety` 的"写完之后"从"重读 + 摘要"改成**三条证据**：对片段、重放调用点、看结构没坏。
第二条是新增的实质动作——改签名时，引用数下降或某条被改成"定义"，都说明有一处没改到。

顺手接的一处：`release-check` 的第一步加了一句「清单里出现本次没碰过的文件，
说明还有别的改动来源，必须点名」。写入片段说改了几个文件，`mode=status` 说工作区里改了几个文件——
这两个数字对不上，就是有价值的信息，不该默认它们相等。

### 20.6 陷阱补充（接 §6 … §19.5 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 53 | 把"动了几处"当成"改了什么" | 位置不是内容。写入结果要么给片段，要么明说不给 |
| 54 | 拿"总行数"当片段上限 | 上限约束改动行；把上下文算进去，上限就变成了随机数 |
| 55 | 片段直接拼进 markdown | `-old` 会被渲染成列表项；围栏长度按内容算，不写死三个 |
| 56 | `verify=通过` 当成"改对了" | verify 只证明落盘一致；正确性要靠重放调用点与大纲 |
| 57 | 新建文件沿用"可回滚"的文案 | 文案有分支，不能是常量。没有基线就没有回滚 |
| 58 | 三篇技能各自写得好，接口空着 | 交接物（定位单 → 重放名单）要有测试盯着，否则"两篇都好"就是链路断 |

### 20.7 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 189 项全绿（新增 10 项 C2b-10~13 / C2c-1~8：片段内容、空操作、超限不给片段、新建文件不谎称可回滚、纯追加旧侧 0 行、首行改动不走整文件、超长行截断、围栏与围栏加长） |
| `npm run test:skills` | 30 项全绿（新增 4 项链路断言：定位单四栏 / 重放调用点 / verify 语义 / 写结果四形态） |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过（含工单链路 35/35） |
| `npm run test:shadow:core` | 75 项全绿 |

## 21. 变更记录（2026-11-15 refs 跨文件收敛：import 是唯一能精确解析的证据）

§15 的分组是按**书写形式**分的（接收者、所在符号）。它在单文件里够用，跨文件时常常失效：
三个文件里都写 `save()`（裸名或各自叫 `svc` 的变量），分组表把它们并成一栏，
`定义散在 3 个容器、涉及 4 个文件` 只是一个数字——**哪个文件对哪一处定义，仍然不知道**。

这一节补的就是这件事。用的证据只有一个：**import 语句**。

### 21.1 为什么是 import

| 候选证据 | 能回答什么 | 问题 |
|---|---|---|
| 变量名（§15 的 receiver） | `u.save()` 里的 `u` | 跨文件时常常都叫 `src`/`service`，区分不了 |
| 目录/文件名相似度 | "大概相关" | 是猜测，而且猜错看不出来 |
| **import 语句** | 这个文件导入了哪个模块 | 原文里实打实写着的，可精确解析 |

代价要说清楚：import 证明的是「**这个文件**导入了那个定义所在模块」，
**不是**「这一行调用解析到它」。所以输出里不许出现"指向"这种结论词，
只能写"归入"，并且必须带一句口径说明（见 21.4）。

### 21.2 三个实现要点

**① 结构在抹过的文本上匹配，说明符从原文的同一偏移取。**
说明符本身就是字符串，`maskNonCode` 会把它抹成等长的空格——位置一一对应。
先抹再取，注释里那句 `// import { save } from '../defs/util'` 自然不会变成证据。
这正是 refs 上一版踩过的坑：**新证据通道不能重新打开旧的误报来源。**

**② `\s*$` 会把整个说明符吃掉。**
第一版的锚点是 `/\bfrom\s*$/`——抹过之后行尾是一大片空格，`\s*` 贪婪吞掉它们，
偏移直接落在行尾之外，`importsParsed` 恒为 0。改成"只在关键字后给一个偏移，
由取值函数自己跳过空格并在原文里读引号"，四种形态（`from` / 侧效 `import 'x'` /
`require(` / 动态 `import(`）才都通。

**③ 解析要求唯一命中。**
相对路径按目录拼接，并补齐 `./x.js → x.ts` 这类 ESM 换扩展名的写法；
非相对说明符（`a.b.C`、`github.com/x/y`）按路径尾部匹配，从最长尾部往下试。
两种方式都**只在命中恰好一个定义文件时才算数**——命中两个，说明这条说明符本身歧义，
此时返回 null 让调用方写"无法归属"，比挑一个"更像答案"的强。

### 21.3 四类结果，四种下一步

| kind | 含义 | 输出措辞 | 模型该做的 |
|---|---|---|---|
| `local` | 文件自己就有定义 | 引用与定义同文件 | 按大纲区间读即可 |
| `linked` | 恰好导入了一个定义文件 | 导入 `../defs/user` → `defs/user.ts` | 归入那处定义；括号里写证据强度 |
| `split` | 导入了 ≥2 个定义文件 | 导入了 N 个定义文件，无法拆分 | 按接收者逐处看，**不许合并成一个数** |
| `unknown` | 没有任何 import 命中 | 没有 import 证据，无法归属 | 同包/全局注入/依赖都可能，不要猜 |

证据强度分两档，抄在行尾：

- `（import 名单里就有这个符号）`——`import { save } from '...'`，强证据；
- `（只导入了模块，名单里没有这个符号）`——`import { User }` 之后调 `user.save()`，
  只说明文件同源，调用本身没被证明。

`unknown` 里唯一多给的一条信息：同目录下恰好有一个定义文件、且扩展名是 `.java` 时，
补一句「Java 同包无需 import，从 import 判不出来」。这是**下一个该看哪儿**，不是归属。

### 21.4 真实输出

夹具：3 个定义文件（`User.save` / `Order.save` / `save()` 函数）、5 个引用文件
（分别相对导入、名单导入、双导入、无导入、定义文件自身）。

```
符号 save：代码里出现 12 处（定义 3 / 引用 9），涉及 8 个文件
同名候选的跨文件收敛（按 import 关系，不做类型推断）——定义散在 3 个文件：
  · 定义 1 处：v9-test/refsx/defs/order.ts:L2（Order.save）
  · 定义 1 处：v9-test/refsx/defs/user.ts:L2（User.save）
  · 定义 1 处：v9-test/refsx/defs/util.ts:L1（save）
  · calls/api.ts（引用 2）：导入 ../defs/user → defs/user.ts（只导入了模块，名单里没有这个符号）
  · calls/direct.ts（引用 2）：导入 ../defs/util → defs/util.ts（import 名单里就有这个符号）
  · calls/mixed.ts（引用 2）：导入了 2 个定义文件，无法拆分 → defs/user.ts（../defs/user）、defs/order.ts（../defs/order）
  · calls/legacy.ts（引用 1）：没有 import 证据，无法归属
  · calls/web.ts（引用 1）：导入 ../defs/order → defs/order.ts（只导入了模块，名单里没有这个符号）
  · defs/user.ts（引用 1 / 定义 1）：引用与定义同文件
  · 汇总：引用 9 处——按 import 归入唯一定义 5、导入多个定义分不开 2、无法归属 1、与定义同文件 1
  · 「归入」只表示该文件导入了那个定义所在模块，不表示每一处调用都解析到它（变量实际类型仍需人工确认）
```

四条输出纪律：

1. **只在定义散在 ≥2 个文件时出现**。单文件里两个类的同名方法，import 帮不上忙，多印一段只是噪音（B3-10f 盯着这条）。
2. **定义行号与所属符号一起给**（`defs/user.ts:L2（User.save）`），否则读完表还得回去找。
3. **汇总只给四类计数**，四类互斥且相加等于引用总数——不写"共 9 处引用指向 2 个符号"这种总结论。
4. **`importsParsed === 0` 时单独解释**：可能是方言不支持（只认 ts/java/python/go/rust），
   也可能是依赖全局注入。不说这一句，读者会以为"这些文件真的没有 import"。

### 21.5 顺带挖出的两个真缺陷

写夹具时 refs 报「定义 0 处」，而夹具里明明有定义。查下来是 `extractSymbols` 的成员判定：

| 漏掉的形态 | 原因 |
|---|---|
| TS 类方法 `save() {` / `empty() { }` | `MEMBER` 正则要求「返回类型 + 名 + (」，TS 方法通常不写返回类型 |
| Java 构造器 `public User() {` | 同上：没有返回类型 |
| 内联注解 `@Override public void save() {` | 行首是 `@`，所有声明正则都匹配不上 |

补法（顺序很重要）：先剥内联注解，再试 `MEMBER`，最后试新增的 `BARE_METHOD`
（`name(` 形状 + **括号在本行配平** + 行内有块体）。括号配平这条是关键：
`doSomething(x);` 没有 `{`，`run((x) => {` 是 2 开 1 闭，两者都不会被误收成方法；
`foo(a, (b) => {` 同理被 `=>` 排除。B3-21e/f 两个断言分别盯"该认的认"和"不该认的不认"。

### 21.6 陷阱补充（接 §6 … §20.6 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 59 | 在新证据通道上重新打开旧的误报来源（注释里的 import） | 结构匹配走抹过的文本，说明符从原文同偏移取。老坑不该在新功能里复现 |
| 60 | 用 `\s*$` 定位掩码区里的位置 | 掩码区就是空格，`\s*` 会把它整个吃掉。只给关键字后偏移，跳空格交给取值函数 |
| 61 | 说明符能匹配多个定义时挑一个"最像"的 | 歧义要显式写成"无法拆分"并列出候选。挑一个等于把不确定藏起来 |
| 62 | 把「导入了模块」说成「调用指向它」 | 证据分级：名单里有符号 / 只导入模块。措辞必须跟着证据走 |
| 63 | 只在返回类型存在时才认方法定义 | TS 方法、构造器、带注解的方法都是定义。判据换成"括号配平 + 有块体" |
| 64 | 让调用语句混进符号表（`doSomething(x);`） | 声明判定要能区分声明与调用：块体、括号配平、排除 `=>` 回调 |

### 21.7 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 205 项全绿（新增 16 项 B3-10f / B3-20a~i / B3-21a~f：不做跨文件收敛、收敛表内容、定义行号、相对解析、证据分级、无法拆分、无法归属、同文件、四类汇总、Java 绝对包名收敛、三方言 import、注释里的 import、无返回类型方法、调用语句不误收） |
| `npm run test:skills` | 30 项全绿（`code-navigator` 增第 6 步跨文件收敛、`write-safety` 增"抄收敛表"） |
| `npm run test:browser-tool` | 23 项全绿 |
| `npm run test:smoke` | 七阶段全通过（含工单链路 35/35） |
| `npm run test:shadow:core` | 75 项全绿（大纲只增符号，不删字段） |

## 22. 变更记录（2026-11-15 把 refs 的证据接到界面上）

§15–§21 五轮都在工具侧加深度：同名分组、跨文件收敛、diff 装配、TODO 归属、定位与验证的链。
结果是工具能力明显走在界面前面——**`code_find(mode=refs)` 的收敛表在界面上没有任何入口**。
这一轮不加新能力，只做两件事：给已有的证据开一个入口，以及把入口背后一直静默失效的一处实现修掉。

### 22.1 一个符号，两种口径

界面右栏原来那一栏叫「引用」，内容是 `fileOutline` 的 `references`：除本文件外，
任何文件的原文里**子串**出现本文件的符号名就算一次。它有三个弱证据叠在一起：

- 符号名长度 > 3；
- 名字在本文件里确实是个符号；
- 别的文件里那句话包含这串字符。

于是 `User` 命中 `UserService`，注释里提一句也算，`user.save()` 与 `order.save()` 完全分不开。

**为什么不干脆把它换成精确扫描**：精确扫描要逐符号抹注释再匹配，40 个符号就是 40 遍整仓。
侧栏打开一次会卡死几十秒。所以分工是固定的：

| 口径 | 数据源 | 成本 | 回答的问题 | 界面位置 |
|---|---|---|---|---|
| 文件级粗扫 | `files/outline` → `references` | 一次遍历 + 每文件前 256KB | **大概去哪些文件找** | 右栏「引用」 |
| 符号级精确 | `files/refs` → `hits` + `convergence` | 一次整仓词法扫描（点一次付一次） | **这 N 处是不是同一个符号** | 底部「符号引用」面板 |

两处数字不一致是**设计结果**。但正因如此，两者不能都叫「引用」——否则用户会以为其中一个算错了。
所以粗扫那一行自己交代口径：

```
被 1 个文件提到（文件级粗扫：子串命中、含注释与字符串、不区分同名符号）
```

「提到」是它能承诺的最强措辞。「引用」这个词留给了符号级视图。

### 22.2 界面结构

**入口**：大纲每个符号行右侧一个 `引` 徽标（常显、低调）。
不藏——藏起来没人会点；也不抢——大纲本身的主职是跳行。

- 点符号名 → 跳行（原行为不变）；
- 点 `引` → 拉该符号的引用明细；
- 名字带 `(...)` 后缀的（`deduct(...)`）取裸标识符再查；取不到合法标识符的（`sg === 'X'` 的兜底行）**不给入口**，而不是发一个注定 400 的请求。

**面板**（编辑器底部，不是弹窗）：看完一行就要点过去，弹窗会挡住跳转目标。

```
符号引用  InventoryClient   定义 1 · 引用 1 · 2 个文件            [×]
代码里出现 2 处（定义 1 / 引用 1）· 涉及 2 个文件
注释与字符串里没有同名文本（本次排除 0 处） · 扫描 11 个文件
定义所在文件
  src/main/java/order/InventoryClient.java            在 InventoryClient 里   :8
引用文件
  src/test/java/order/InventoryClientTest.java        没有 import 证据，无法归属   1 处
```

定义散在 ≥2 个文件时，才额外出现收敛表（定义文件带行号与所属容器、
每个引用文件带 `归入 / 分不开 / 无法归属 / 同文件` 标签与 import 证据、四类汇总、`归入` 口径说明）。
单定义时不印标签——只有一个候选还说「归入」，是把必然说成了推断。

**引用文件表常显**是这一轮改的：第一版把整块放进 `converged` 分支，结果单定义符号
只剩一句「涉及 2 个文件」，而用户问的恰恰是「用到它的文件在哪」。数字不是位置。

### 22.3 措辞纪律在界面上同样适用

工具输出里那几条规矩，搬到 UI 上一字不改：

| 规矩 | 界面落点 |
|---|---|
| 不说"引用共 N 处"这种结论 | 抬头只给词法计数：`定义 1 / 引用 1`，不给判断 |
| 扫描缺口要单独说 | 注释排除数、超大文件跳过数、命中触顶三条各占一句 |
| 归入 ≠ 解析到 | 收敛表下方固定一句「只表示导入了那个模块，不表示每一处调用都解析到它」 |
| `importsParsed === 0` 要解释 | 单独一条黄色提示：方言不支持或全局注入，此时「无法归属」不是符号的问题 |
| 空结果不说"没有" | 命中 0 且排除 0 时写「代码里没有任何出现（扫描 N 个文件）」，有跳过时补一句覆盖范围 |

另外，`refs` 面板的路由**只接受单个标识符**（`/^[A-Za-z_$][\w$]*$/`），否则 400。
这和工具侧同一道闸门：传正则或整段文本请走 `code_find(mode=regex)`，别指望这里能跑通。

### 22.4 顺带挖出的静默失效：`repoFiles` 的相对路径

做这件事时在演示仓库上发现 `outline` 的粗扫对 `OrderController.java` 报 0，
可那个文件里明明写着 `private final OrderService service;`。查下来是 `repoFiles` 的递归写错了：

```ts
// 错的：每次递归都拿"当前目录"当根
const rel = path.relative(root, absolute);      // → 'OrderController.java'
repoFiles(absolute, out, depth + 1, state);     // 子层 root 变了

// 对的：基准根一路传下去
const rel = path.relative(base, absolute);      // → 'src/main/java/order/OrderController.java'
repoFiles(absolute, out, depth + 1, state, base);
```

后果链条很具体：路径变成纯文件名 → 调用方 `path.join(root, 'OrderController.java')`
指向不存在的文件 → `readFileSync` 抛错 → `catch { continue }` 吞掉 →
**所有权扫只覆盖仓库根目录下的那几个文件，其余一律当"没提到"**。

为什么这个 bug 能活这么久：它的输出是「0 个文件提到」，一个完全合法的数字。
没有异常、没有日志、界面上一行灰字。这类"错得很安静"的 bug 只能靠参数语义堵住，
所以修复时把 `base` 设成显式参数并写了注释——下一个改这段的人不可能"顺手"传错。

顺带说明为什么这一轮会撞上它：把措辞从「被 N 个文件**引用**」改成
「被 N 个文件**提到**（文件级粗扫…）」之后，那个 0 才变得刺眼。
**措辞诚实化的副作用是让实现里的谎话显形**——这本身是收益，不是代价。

### 22.5 陷阱补充（接 §6 … §21.6 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 65 | 两套口径共用同一个词（都叫「引用」） | 弱证据那份必须自报口径（粗扫/含注释/不区分同名），把词让给强证据 |
| 66 | 把有用的表塞进「有歧义才显示」的分支 | 分歧才需要标签，**位置**永远有用。文件表常显，标签按条件显示 |
| 67 | 只有一个候选时标「归入」 | 唯一候选下的归属是必然，不是推断。标签只在定义散在 ≥2 文件时出现 |
| 68 | 递归遍历里用"当前层"当相对基准 | 基准根必须显式下传；否则深层路径退化成文件名，错误会被 `catch` 吞掉 |
| 69 | 长路径在 212px 侧栏里不换行 | `overflow-wrap:anywhere`。否则文本顶出面板边界被窗口裁掉半截，看起来像渲染崩了 |
| 70 | 连点两个符号时让先发的响应写状态 | 落地前校验 `symbol` 是否仍是当前请求的那个，否则 A 的数据会挂在 B 的标题下 |

### 22.6 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 205 项全绿 |
| `npm run test:smoke` | 七阶段全通过；F 段新增 4 项：outline 自报「文件级粗扫」、refs 拒绝非标识符（400 + `E_VALIDATION`）、refs 返回符号级命中与收敛表、Java 同包给出「无法归属 + 同目录定义」 |
| `npm run test:skills` | 30 项全绿 |
| `npm run test:refs:visual` | 11 项全绿（Chrome headless + CDP）：大纲带「引」、右栏自报粗扫、点开面板、抬头跟随符号、命中/排除/扫描口径齐全、文件表有行、行内是仓库相对路径（盯 §22.4 那个 bug）、无 `undefined` 泄漏、换符号重拉、可关闭 |

## 23. 变更记录（2026-11-15 遗留标记：把「为什么没扫全」画到界面上）

§22 把符号级的引用证据接进了界面。这一轮接另一半：`code_todos` 的结果。
它比 refs 更容易撒谎——因为它的**主要输出是一个数字**，而数字天生可以只报一半。

### 23.1 这个面板不能写「共 N 条」

`scanTodos` 的返回值里没有 `truncated`，只有三个互不替代的布尔/计数：

| 字段 | 它实际的含义 | 损失的是 | 用户应该做什么 |
|---|---|---|---|
| `stoppedAtCap` | 命中达到上限后**停止读接下来的文件** | 后面的文件一条都没看 | 换路径（`subPath`）分段扫 |
| `walkTruncated` | 遍历被文件数上限截断 | 仓库里还有文件**没进范围** | 知道这次覆盖的是子集 |
| `skippedLarge` | 有整份文件因超 200KB 未读 | 读到的文件里有整份空白 | 单独打开那个文件看 |

三者压成一个 `truncated`，界面就只能说一句「结果可能不完整」——这句话对三种情况都说，
等于什么都没说。所以路由层原样透出，文案层再各自成句。

抬头措辞因此分两支：扫描完整时 `4 条 · 3 个文件`；有任一缺口时
`已列 4 条 · 3 个文件（扫描未覆盖全部）`。**「共」这个字只在完整时成立。**

零命中那支更细：完整 → `没有遗留标记`；有缺口 → `没扫到（未覆盖全部文件）`。
差一个词，结论差一个量级。

### 23.2 归属的三句话，和一句「不说」

`TodoHit.owner` 是 `undefined` 时有两种原因，靠 `codeFile` 分开：

```
在 OrderService.create 里        ← 方法内（owner 带点）
在 OrderController 里            ← 类内（owner 就是类名）
模块级（不在任何符号内）          ← 代码文件里确实不在任何符号内：这是结论
（不印归属）                     ← 非代码文件（pom.xml / md）：没有符号这个概念
```

最后一行是这一轮唯一「不说」的地方。配置文件里的 TODO 谈不上归属，
硬套一句「模块级」会让用户以为扫描器看过那个格式的语法。

### 23.3 界面结构

**入口**：右栏第四栏「遗留标记」，与上面三栏（大纲 / 引用 / Git）刻意分开——
上面三栏都是**当前文件**视角，这一栏是**仓库级**。

**不自动扫描**。整仓遍历是同步的，`refs` 那套「点一次付一次」同样适用；
进详情就扫会拖住首屏，而用户多数时候只是来看某个文件。

扫完之后右栏给两样东西：摘要（条数 + 文件数，带覆盖率标记）+ 前 3 条可直接跳的命中。
窄，但**覆盖率不能因为窄就不说**——否则「右栏写 100 条」会被读成「仓库总共 100 条」。
短列表用末两段路径（`order/OrderService.java:1`）而不是纯文件名：同名文件在 212px 里
长得一模一样。

**明细面板**与 refs 共用底部位置，两者互斥（开一个收另一个）。按文件分组，
每行 `:行号 [标记] 说明 归属`；标记后没有说明也照样成行——「有标记但没写内容」本身就是结论。

### 23.4 把文案抽成纯函数

`todoOwner` / `todoGaps` / `todoRailSummary` 三个函数从 1200 行的视图里挪到
`frontend/src/utils/todo-copy.ts`，不碰 React。理由很直接：
**截图只能证明「渲染出来了」，证明不了「每一支都说对了」。**

抽出来之后可以逐分支断言（`tests/todo-copy.spec.ts`，14 项）：
三种归属、非代码文件不印、三种缺口各成一句且不合并、叠加时是三句、
触顶文案里不许出现「还有」、零命中在两种覆盖状态下的两种措辞。

### 23.5 演示仓库补了三条标记

原来演示仓库里一条 TODO 都没有——这个功能打开就是「没有遗留标记」，
既看不出它工作，也测不到归属分支。于是在 `sandbox/bootstrap.ts` 里按三种位置各放一条：

| 位置 | 期望归属 |
|---|---|
| `InventoryClient.deduct` 方法体内 | `在 InventoryClient.deduct 里` |
| `OrderController` 类体内（方法外） | `在 OrderController 里` |
| `OrderService.java` 文件头（`package` 之前） | 模块级 |

**夹具也是一种文档**：读者看文件名就知道哪三种情况该有不同措辞。
顺带让 smoke 的归属断言有了真实输入，而不是靠构造 JSON。

### 23.6 陷阱补充（接 §6 … §22.5 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 71 | 把三个「为什么没扫全」的理由合并成一个 `truncated` | 三条通道损失的东西不同，合并后文案只能模糊；字段分开、句子分开 |
| 72 | 命中触顶时说「后面还有」 | 只能到「上限之后没读」。最后一条恰好是仓库最后一条时，「还有」就是假话 |
| 73 | 零命中时不分覆盖状态，一律说「没有」 | 没扫全的时候只能说「没扫到」，不能说「没有」 |
| 74 | 非代码文件的标记硬套「模块级」 | 那个格式没有符号概念，`owner` 为空 ≠ 模块级；只有 `codeFile` 能分开 |
| 75 | 「概览窄所以只给条数」 | 窄可以省明细，不能省覆盖率。摘要必须带「已列 / 未覆盖」 |
| 76 | 窄侧栏里只显示文件名 | 同名文件无法区分。至少给末两段路径 |
| 77 | 文案逻辑埋在大视图里，靠截图验收 | 抽纯函数 + 逐分支断言。截图证明"画出来了"，证明不了"说对了" |
| 78 | 演示数据全绿，分支永远走不到 | 夹具按分支造（方法内/类内/文件头各一条），并补一条 `max=1` 的触顶断言证明 flag 是活的 |

### 23.7 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:agent-tools` | 205 项全绿 |
| `npm run test:smoke` | 七阶段全通过；F 段新增 3 项：三字段缺口齐全且无 `truncated`、`max=1` 时 `stoppedAtCap` 置真、归属覆盖方法内/类内/模块级 |
| `npm run test:todos:copy` | 14 项全绿（纯函数逐分支：归属 4 支、缺口 5 支、摘要 5 支） |
| `npm run test:todos:visual` | 16 项全绿（Chrome headless + CDP）：入口存在且不自动扫描、扫码后右栏给条数+文件数、面板抬头、每行完整（行号+标记+说明）、按文件分组、三种归属措辞、完整扫描不出现「已列」、点行跨文件跳转、可关闭 |
| `npm run test:refs:visual` | 11 项全绿（回归：新面板没有抢掉 refs 的 `.rp` 选择器） |

## 24. 变更记录（2026-11-15 扫描结果的保质期，以及保存路径上的两个谎）

§23 做完，界面上已经有「引用」和「遗留标记」两块扫描结果。它们有一个共同特征：
**能一口气活到下一次手动重扫**。于是问题变成——文件被改过之后，这两块还在说旧话。

### 24.1 过期数字比没有数字更危险

保存成功后，`outline` 会重拉（右栏「引用」的粗扫数字会变），但底部面板不会。
同一屏里就会出现「右栏说 3 处、面板说 2 处」——正是 §22 想避免的那种自相矛盾。

更隐蔽的是**行号**：面板每一行都能点着跳过去，文件改过之后那个行号指向的是别的地方。
用户不会怀疑它，因为数字不像会骗人的东西。

所以规矩写成三条（`frontend/src/utils/stale-copy.ts`）：

| 规矩 | 落点 |
|---|---|
| 只有**真的写盘**才标过期 | `diskChanged` 为真才标记——没改还报警，用户下次就不看这个提示了 |
| 过期时**在数字前面**写「保存前 · 」 | 抬头是最先被读的地方；把标注放在数字后面，等于让人先读走一个错位的计数 |
| 右栏直接**撤掉旧数字**，只留动作 | 212px 里挂不住"数字 + 警示"两句话，而旧数字带上小字注释仍然会被读走 |

面板里保留列表（可能要对比改动前后），但顶部固定一句：
「这份列表是保存前的扫描结果：文件已经变了，行号与计数都可能偏移。」

### 24.2 顺着这条线挖出保存路径上的两个谎

**谎一：`diskChanged` 恒为 true。** 服务端 `save()` 无条件返回 `diskChanged: true`，
根本没读旧内容。字段名承诺的是「磁盘上的字节变没变」，实现却只表示「有人点了保存」。
后果不止界面：审计明细里也一直写着 `diskChanged=true`。

修法是先读后比：

```ts
const previous = (() => { try { return fs.readFileSync(absolute, 'utf8'); } catch { return null; } })();
fs.writeFileSync(absolute, buffer);
const diskChanged = previous !== content;
```

**谎二：空行被高亮序列化成 U+00A0。** `highlight()` 为了让空行不塌陷，渲染成
`<div>&nbsp;</div>`；而这个 div 同时是 contentEditable 编辑区，保存读的是它的 `innerText`。
于是 **打开一个文件、什么都不改、点一次保存**：

```
before 916 字节：package com.example.order;\n\nimport ...
after  922 字节：package com.example.order;\n \nimport ...
```

每条空行都多出一个不可见字符，`git diff` 会把整片空行标成改动。
用户什么都没做，却拿到一份看不懂的 diff——而且 toast 上写着「已落盘 922 字节」，
看起来完全正常。

两处一起改：

- 空行改用 `<br>` 撑行高（`innerText` 仍是空行），`highlight` 与 `markAll` 三处同步；
- `save()` 在**没编辑过**时直接回写接口返回的原文（`liveContent`），压根不经过 DOM；
  编辑过才用 `innerText`，并补回文件末尾的换行（`innerText` 不保留它，否则每存一次少一行）。

### 24.3 为什么这个 bug 能活到现在

因为它只在「文件从来没被 UI 保存过」时出现：第一次保存把 `&nbsp;` 写进去之后，
文件本身就含 U+00A0，下一次 `innerText` 读出来还是 U+00A0，`diskChanged` 反而变 `false`。
**它自己把自己的现场擦掉了**——只有拿一份没动过的夹具才复现得出来。

这一轮能撞上它，纯粹是因为先加了「没改内容就不该标过期」这条断言，
而夹具在每次 `run-smoke` 里都是全新解包的。

### 24.4 陷阱补充（接 §6 … §23.6 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 79 | 扫描结果没有保质期，文件改了还照旧显示 | 保存（真写盘）后立刻标过期，并在数字**之前**说明 |
| 80 | 用「保存过」代替「内容变了」 | `diskChanged` 必须真的比较前后字节；恒 true 等于这个字段不存在 |
| 81 | 用假警兜住可能的漏警 | 没改也报警 → 用户学会忽略提示 → 真警失效 |
| 82 | 用 `&nbsp;` 给 contentEditable 撑空行 | 序列化会变成真字符；用 `<br>`。渲染产物就是保存产物，任何"不可见占位"都会落盘 |
| 83 | 保存总是走 DOM 序列化 | 没编辑过就回写原文；序列化只在真有编辑时才是"用户看到的即他要的" |
| 84 | 用「已经被自己改过」的夹具验证保存 | 这类 bug 会自我擦除现场，必须每次用全新夹具 |

### 24.5 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:smoke` | 七阶段全通过；K 段新增 1 项：同内容再存一次必须 `diskChanged=false`（防有人把它改回恒 true） |
| `npm run test:agent-tools` | 205 项全绿 |
| `npm run test:todos:copy` | 18 项全绿（新增 4 项：真写盘才标过期、`diskChanged=false` 不标、提示要说清行号偏移、右栏过期态不含数字） |
| `npm run test:todos:visual` | 23 项全绿（新增 5 项：无改动保存不标过期、保存后面板标过期、出现重扫按钮、右栏撤掉旧数字、重扫后数字回来且行数增加） |
| `npm run test:refs:visual` | 11 项全绿（回归） |
| `npm run test:skills` | 30 项全绿 |

## 25. 变更记录（2026-11-15 三处口径不同源，以及写路径上的一次 DOM 重建）

这一轮起点是「还有什么没补齐」：不凭记忆列，而是把工具目录、路由表、前端视图与 api client 的
调用点对了一遍，找出**后端有能力、界面没有入口**的那几条。补的过程中撞到一个比缺入口更贵的
问题：写路径在真实输入下会重建 DOM，把用户刚敲的字丢掉。

### 25.1 敏感规则：三处读到的是同一个值吗

补之前，规则有**三个读取点**：文件树走 `isSensitive`（读库），而索引器与命令执行器各自
`import { SENSITIVE_RULES }`（读常量）。设置页改完规则，界面上的 `.env` 消失了，索引里那份还在，
终端里也照跑。这是最难查的一类不一致：**没有任何一处报错，只有比对两个屏幕才看得出来**。

现在 `repositories.sensitivePatterns()` 是唯一出口，三处都从这里取；`GET /api/sensitive-rules`
也改成返回**生效值**而不是常量 —— 此前 `GET` 读常量、`PUT` 写库，刷新一次界面就退回默认值，
再保存一次就把用户的自定义规则覆盖掉了。

### 25.2 空表不是「没有规则」，是「全部放行」

删光规则看起来是"更宽松"，实际是把 `.env`、`id_rsa`、`*.pem` 重新放回文件树、索引与会话上下文。
所以 `PUT` 拒绝空列表（`E_VALIDATION`），而不是接受它然后假装规则还在。

规则变动的两个方向后果不同，界面上必须分开说：

- **收紧**会**清掉**已有索引块（`purgeSensitiveChunks`）——否则"不索引"只对新文件成立；
- **放宽**不会**补建**索引——"搜不到是还没索引，不是规则没生效"。

两个零的含义不同，压成一句「规则已生效」就等于让用户自己去猜是哪种零。

### 25.3 凭据不能压成一个布尔

`revoked` 与 `unbound` 在库里都是 `credential_bound = 0`，但一个是"配过又被收回"，
一个是"从来没配过"。压成布尔之后，指标卡写「未绑定」而详情角标写「已吊销」——
同一屏里两个说法，用户只能信其中一个。现在 `credentialStateText` 给五态，
指标卡与详情块共用同一个函数。

顺着这条线还挖出两个动作是空转的：

- `renew()` 只改标签、把状态改回 `active`，**密文没换**。提示写着"新版本密文已写入本机钥匙串"，
  而旧密钥原地不动 —— 这就是"轮换了一个标签"。现在没给新秘密直接 `E_VALIDATION`。
- `revoke()` 只改状态，**没有调用 `deleteSecret`** —— 账号注销了，密码还抄在便签上。
  现在吊销会真的抹掉密文，并把 `secretRemoved` 如实回给界面。

还有一种必须点名的状态：`secretMode: 'none'` 表示秘密**从未**落本机钥匙串（无 OS 钥匙串的环境）。
把它报成"已保存"比不保存更糟。

### 25.4 写路径：渲染产物就是保存产物

上一轮修掉了 `&nbsp;` 撑空行导致的"保存即改写"。这一轮把这条链补成常驻断言时，撞到反面：

`file.html` 的 memo 里原本写着 `edited ? base : 高亮`。`base` 对真实仓库文件是 live 侧装配的
纯 `<div>` 包裹（未加载时甚至是占位的 `<div>&nbsp;</div>`）。于是用户敲下**第一个字符**：
`edited` 变 true → `__html` 从高亮结果换成 `base.html` → React 发现字符串变了就重设 `innerHTML`
→ **连光标所在的那个节点一起换掉**。第二下按键落不到原来那一行，字符静默丢失；
占位那种情形更是整份内容被清空。

正确做法不是"编辑态换一份 html"，而是**编辑态不换 html**：只要 `plain` / `find` 没变，
这里产出的字符串与上一次完全相同，React 就不会去动 DOM —— 用户敲的字与光标原地保留。

### 25.5 这条断言为什么以前测不出来

旧的视觉测试用 `dispatchEvent(new InputEvent('input'))` 模拟输入，事件没进到 React 的
onInput，`edited` 一直是 false，于是 `save()` 走的是"没编辑过就回写原文"那条分支 ——
**测试通过，功能是坏的**。现在改成 CDP 真输入（`Input.insertText`）分两段打，并在打完的 DOM 上
读两件事：盖在目标行上的 `data-probe` 还在不在、两段字是不是落在同一行。
装回旧写法跑一遍，这两条同时变红（`盖戳节点存活=false`），恢复后变绿。

夹具必须每次是全新的：这类 bug 会自我擦除现场（第二次保存就"一致"了）。

### 25.6 全库检索与文件内查找是两件事

`searchAsset`（FTS5）此前只有知识库详情在用，代码库详情只有文件内 ⌘F。补的时候把两者的
**语义差别**写进界面，而不是共用一个入口：

| | 文件内 ⌘F | 全库检索 ⌘⇧F |
|---|---|---|
| 查什么 | 当前文件已渲染文本 | 落盘内容的全文索引 |
| 要索引吗 | 不要 | 要（敏感文件按规则排除） |
| 搜不到意味着 | 这个文件里没有 | 可能没索引 / 被规则排除 / 真的没有 |

为了让"搜不到"能被解释，检索命中补了两个字段：`snippet`（命中那一行的原文，截断到 160 字）
与 `snippetLine`（**绝对行号** = 块起始行 + 块内偏移）。块是 40 行窗口，
`startLine` 是块首 —— 拿块首当跳转目标等于让用户自己再找一遍。空态里给「重建索引」按钮
（`POST /index/progress` 对代码资产会真跑 `runIndex`），把"没索引"这条出路也一起给了。

### 25.7 陷阱补充（接 §6 … §24.4 编号）

| # | 陷阱 | 正确做法 |
|---|---|---|
| 85 | 同一个规则在三个地方各读一份（库/常量） | 收敛到一个函数；`GET` 必须返回生效值，不能返回默认值 |
| 86 | 允许把敏感规则清空 | 空表 = 全部放行，必须拒绝；"更宽松"不是"没有规则" |
| 87 | 规则收紧后不清索引 | 收紧要清已有块，否则承诺只对新文件成立 |
| 88 | 用「已生效」一句话盖住收紧/放宽 | 收紧会清、放宽不补建，两个零含义不同，要分开说 |
| 89 | 用布尔表示凭据状态 | `revoked` / `unbound` 都是 0，语义不同；五态分别给文案 |
| 90 | 轮换只改标签 | 不换秘密就不是轮换，直接拒绝 |
| 91 | 吊销只改状态 | 必须 `deleteSecret`，否则密码还留在钥匙串里 |
| 92 | 编辑态换一份 html 渲染 | 编辑态**不换** html；字符串不变 React 才不重设 innerHTML |
| 93 | 用合成 InputEvent 测受控输入 | 合成事件进不了 React 的输入链，必须用 CDP 真输入 |
| 94 | 用"没改过"的夹具测保存 | 这类 bug 自我擦除现场，每次用新夹具 |
| 95 | 检索结果只给文件 + 行号 | 带上命中行原文；行号用命中行，不用块首行 |
| 96 | 把"搜不到"当空列表 | 说清索引快照语义，并给重建索引的出路 |

### 25.8 验证

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | 前端 + 后端双份通过 |
| `npm run test:smoke` | 八阶段全通过；主冒烟 144/144（新增「代码检索命中带命中行的原文与真实行号」，逐条读盘比对 snippet 与 snippetLine 是否同时对齐） |
| `npm run test:save:visual` | 9/9（新增：连续输入不被重设 DOM；换回旧写法即红） |
| `npm run test:search:visual` | 12/12（入口、与 ⌘F 的区分、片段三件套、命中行号、跨文件跳转、无命中出路、⌘⇧F 重开） |
| `npm run test:rules:visual` | 15/15 |
| `npm run test:cred:visual` | 13/13 |
