# DevWork 桌面端 v1.0.0 发布 PRD（范围与验收）

> 版本：v1.3（§8 六项已裁决 + 并入架构审查：3 个写通道补丁、P0-9 超长输入、P0-10 端口串环境、打包依赖闭包双层自检）· 2026-11-14 · 作者：许清楚（产品经理）
> 基线：`devwork-app` v0.4.2 · HEAD `506c85b` · 工作区干净 · `npm run typecheck` 0 error
> 依据：`devwork-design.md`（§0/§11）、`devwork-alignment-audit.md`（§0/§10）、`devwork-superagent-redesign.md`（§8.3–8.7/§14）、`devwork-architecture.md`（§2/§6）、`devwork-fix-summary.md`（§3）
> 本文只定义**范围与验收**，不含竞品/市场分析。

---

## 1. 发布目标与定位

**一句话价值**：把「0.4.2 的三栏演示壳」变成「装得上、首启自洽、证据链点得回原文、写操作逐次批准且可回滚」的可交付桌面工具。

**1.0 能力边界（以代码事实为准，不以设计文档为准）**

| 维度 | 1.0.0 真实状态 | 证据 |
|---|---|---|
| 读能力 | 只读工具真实执行（代码检索 / 知识库检索 / 只读 SQL / 文件读 / 浏览器读），失败态与拦截态分开展示 | `services/agent-tools.ts`、`config/tools.ts`、audit §10.1 |
| 写能力 | **已存在受控写通道**：审批卡 `approve` 且有可执行 plan 时真写盘（预检→备份→执行→校验→可回滚），默认 `readOnlyMode=true`、Agent 中低风险写直接 deny 转建议、prod 资产按 p3 策略默认只读 | `services/conversation.ts:1085-1120`、`services/write-executor.ts:1-12`、`kernel/permission.ts:104-163`、`db/seed.ts:195` |
| 自动化 | 影子链路 → 授权草案 → 工单 → 派工 → 单轮执行 → 收件箱扇出；只读可自动签发，写权限需显式放行 | superagent §8.3–8.7、`services/tickets.ts`、`services/worker-runtime.ts` |
| 明确没有 | MCP、Skill 运行时（现为提示词级）、记忆系统、远程策略下发、多用户账号（已整体移除）、账号类操作 | audit §5、superagent §14、fix-summary §3 |

> 一句话定位：**「只读为主 + 写操作逐次人工批准的可回滚受控写（实验性）」**。对外不要说"纯只读"（代码里能写），也不要说"写能力已开放"（默认 deny/ask）。
> 已裁决边界：版本号 **1.0.0**、平台 **仅 Windows x64**、许可 **闭源私有（Proprietary）**、自动更新 **仅预留不发 feed**、写执行 **保留但默认档位钉死**（见 §8）。

---

## 2. 用户故事

| # | 角色 | 我想要 | 以便 |
|---|---|---|---|
| U1 | 首次安装的开发者 | 在**没装 Node、没有模型 Key** 的机器上双击就得到可用的空环境 | 先判断这工具值不值得接资产，而不是先看一堆假数据 |
| U2 | 后端工程师 | 用 4 步向导接入本地代码库/数据库，并看到**真实**索引进度 | 确认它真的读到了我的项目 |
| U3 | 排障者 | 问「X 在哪个文件实现」拿到带 `path:line` 的可点开引用 | 10 秒内跳到源码，而不是再问一遍 |
| U4 | 后端/DBA | 在 SQL 页跑只读查询，被拦与写错语法**给不同提示** | 敢对着生产资产查 |
| U5 | 团队负责人 | 看到事件被研判成授权草案/工单，以及每张工单打扰我几次 | 用数据决定要不要放开写权限 |
| U6 | 管理员 | 配自己的 OpenAI 兼容端点与模型，并看清被只读模式锁住的能力 | 不泄密地试 |
| U7 | 谨慎用户 | 对 Agent 的每次写操作逐次批准，出错一键回滚 | 敢让它碰我的仓库 |
| U8 | 管理员 | 按条件筛审计并导出（导出条数=命中条数） | 出事故能回放"谁放了什么" |

---

## 3. P0 · 发布阻断项（不做就不能叫正式版）

| # | 条目 | 判定标准 | 依据 |
|---|---|---|---|
| P0-1 | **打包链路端到端可跑，且产物在仓库外能启动** | `node scripts/package.mjs` 六步全过**只是必要条件，不构成闸门**。历史两次 P0 都在暂存链上：先少一个包（`RUNTIME_MODULES` 曾只有 `express/cors/tsx`，漏 zod）、再少一份落点（shared 侧的裸包解析要走 `resources/node_modules`，`server/node_modules` 不在这条链上）。现状已修：`RUNTIME_MODULES` = `express/cors/tsx/zod` → `server/node_modules`，`SHARED_RUNTIME_MODULES` = `zod` → `resources/node_modules`。**但仓库内冒烟仍会把问题掩盖**（`smoke-package.mjs:75` 从仓库内启动会向上解析命中 `devwork-app/node_modules/zod`，六步全过而装机必崩）。**判定**：zip 与 portable 在**仓库外目录（如 `C:\tmp\dw\`）**解压/双击启动成功，且 `GET /api/bootstrap` 正常（不是报错页）。**自检按两层**：行为式（把 `build/pkg` 复制到 `os.tmpdir()` 从那里启动——一次性覆盖缺依赖/相对路径错/asar 不可读/node.exe 不对）+ 静态式（**两份落点都断言**：`server/node_modules/{express,cors,zod,tsx,@esbuild/*}` 与 `resources/node_modules/{zod}`，只为报错时指名缺哪个包）。**三条边界**：`sql.js` 是 Tier2 兜底（`db/adapter.ts:41`，try/catch 内，缺了走诚实诊断）**不在清单内且不得加入**；`tsx/esbuild` 是加载器、不在 import 图里，断言须双向豁免；静态扫描看不到 `import()` 与字符串 `require`，只能当第二层。**清单只能一处定义**：两份都在 `stage-runtime.mjs`，`package.mjs` 与发布预检 import 它（各写一份＝版本号三处硬编码的翻版）。NSIS 只验「能生成安装包」 | `devwork-app/scripts/lib/stage-runtime.mjs` 的 `RUNTIME_MODULES` / `SHARED_RUNTIME_MODULES`（当前 `:66` / `:79`，`copyDependencyClosure` 调用 `:142`；**以符号名为准，行号仅附注**）、`scripts/smoke-package.mjs:75`、`db/adapter.ts:41`、`electron-builder.yml:47-48` |
| P0-2 | **首启自洽（干净环境 + 无 Key 诚实降级）** | 删用户数据目录后启动：仅 1 个空工作区、无演示资产/会话；提任意问题只得「演示轨迹 · 未接入模型」降级卡，**不产出结论、不产出引用** | `desktop/main.cjs:431`（打包态 `DEVWORK_CLEAN=1`）、`db/seed.ts:465-480`、`services/llm-gateway.ts:276-364` |
| P0-3 | **升级不丢数据** | 用 0.4.2 的 `devwork.sqlite` 直接启动 1.0.0：工作区/资产/会话/消息/审计条数不变，`PRAGMA integrity_check` = ok | `db/database.ts:15-30/52-72`（幂等 schema + `ensureColumn`）、`db/migrate.ts`（启动期幂等整理） |
| P0-4 | **写通道不伤数据（保留能力 + 三个补丁）** | 保留不砍：`readOnlyMode` 默认 true、中低风险写 deny 转建议、prod 默认只读、仅显式批准的 plan 才真写盘。验收：批准→真写盘→回滚后逐字节一致；审计至少两条；未批准路径零磁盘变更。**「逐次批准、可回滚」要成立必须先打三个补丁**：① 移除会话级审批记忆（`session-approvals.ts:23` 记忆键不含参数，批准一次 `code_edit` 可在同会话免审写任意文件 → 1.0 直接移除「本会话内允许」按钮，后端收到 `scope:'session'` 也按 `once`）；② 写前快照从用户仓库内 `.devwork-snapshots/` 改落 `DATA_DIR/snapshots/`（否则污染 `git status`、可能被误提交）；③ 回滚 `file-snapshot` 分支加 `targetPath` 包含性断言（今天不可利用，防将来注入）。旁路核查已做：`executeWritePlan` 只有 3 个入口（会话记忆命中/事件回放/审批裁决），无第二条绕过审批的路 | `services/write-executor.ts:94-98/284-296`、`services/session-approvals.ts:23`、`services/conversation.ts:204/489/1118`、`kernel/permission.ts:110-163` |
| P0-5 | **版本号单源且真实** | 现为 **4 种写法**：`package.json`、`routes/system.ts:97`、`db/seed.ts:198`、`frontend/src/api/mock.ts:537`（`0.4.2-mock`）。做法：新增 `backend/src/config/version.ts` 作唯一字面量，后端两处派生；前端改用 `vite.config.ts` 已注入的 `__APP_VERSION__`；新增幂等 `migrateAboutVersion()` 覆盖 `setting.about.version`（`seedIfEmpty` 不会重写老库）；`check-version.mjs` 加 grep 断言——`0.4.2` 不得出现在 `backend/src`、`frontend/src` | `scripts/check-version.mjs:1-14`、`vite.config.ts:14`、`db/seed.ts:198` |
| P0-6 | **发布物料齐备（闭源私有）** | 仓库根有 `README.md`（安装/启动/环境要求/已知限制，**不加开源徽章**）、`CHANGELOG.md` 含 1.0.0 条目、`LICENSE` 写 **Proprietary**（版权归权利人、禁止再分发与反编译、无担保）。**当前仓库根与 `devwork-app` 均无 README/CHANGELOG/LICENSE（已确认）** | `ls D:\code\DevWork`、`devwork-app/*.md` |
| P0-7 | **对外口径与代码一致（诚实声明，5 条全中）** | ① **README 已知限制 6 条**：删除账号/多设备退出无后端（说明型弹窗）· 资产离线无真实探测（不显示"在线"）· 深色主题与拖拽调宽缺自动截图 · 写执行属实验性 · **内网访问限制** · **从 0.4.2 升级的库不清演示资产（`CLEAN` 只挡首启）**——**已裁决：代码不动升级数据，只声明**；要让老库变干净的正确做法是提供显式操作（删数据目录），不在升级路径里静默删除；关于页也**不承诺"升级后自动清理"**；② **README 与关于页都标注「受控写（实验性）」**（现状 `grep 受控写 frontend/src` = **0 处**，属表面关闭）；③ **设置页 `perm.p2` 描述必须与内核一致**：现状 `mock.ts:1144` 写「按风险分级=仅高风险弹审批，**低风险直接执行**」，而内核是**低风险一律 deny 转建议**——描述与实现相反，必须改；④ 更新能力声明为「**预留**」，不承诺可用；⑤ 修 `permission.ts:143-145` 过期注释：只删「当前版本没有写执行通道」半句，改为「写通道**已打通到执行器**：内核 `ask` → `respondApproval` → `write-executor`（预检/备份/执行/校验/回滚就绪）；`ask` 与 `deny` 的区别仍在 UI 卡片形态。**默认档位为只读，Agent 中低风险写一律 deny 转建议，仅用户显式批准的 plan 才真写盘**」 | `frontend/src/data/mock.ts`（关于页与 perm 描述）、`backend/src/services/llm-gateway.ts`（无资产时降级文案仍称"已挂载生产库与运营知识库"，见 `:153` 与 `:296` 的 `mountedAssets`）、`kernel/permission.ts:143-145`、`db/seed.ts:195` |
| P0-8 | **发布测试判据是「两条命令」** | `npm run test:all`（无前置依赖的 10 个套件：md / composer / skills / attention + **agent-tools / browser-tool / db-integrity / shadow:core / smoke / asset**）+ `npm run test:gui`（1 项：desktop-ipc，需 GUI Electron + CDP + 活的 3001）。**`test:all` 不含 GUI 项是刻意设计，不是遗漏**——GUI 缺前置会返回 `exit 2`，混进聚合命令会让"失败"与"前置缺失"语义失真。历史上"把所有套件塞进一个聚合命令"的写法已导致复核误判 P0-8 未关闭，本版不再使用该口径。**判"全绿"必须是同一次从头跑到尾的完整输出**：`smoke` 会起隔离实例（3011）、`asset` 依赖前一步构建产物，分开跑再拼贴不构成证据；也不接受"任一套件通过即可"的读法 | `package.json:51-55`、`tests/run-smoke.mjs:212-220` |
| P0-9 | **超长输入不得打死后端进程** | `routes/conversations.ts:172` 的 `/stream` 是唯一未包 `wrap()` 的 async 路由，而它是**前端主聊天路径**（`hooks/useChatSession.ts:245`）；`express.json({limit:'16mb'})` 会放行 200KB body、Composer 也不截长度 → 触发条件是「正常使用中的一次粘贴」。粘贴 >20 万字符 → 未处理 Promise 拒绝 → Node 22 退出（后端全挂、界面全白）。**关闭口径**：本条由**后端线单独关闭**，重启兜底（T04）不作为验收条件，避免"发布线没做完 → P0-9 判未关闭"的扯皮 | `routes/conversations.ts:172`、`hooks/useChatSession.ts:245`、`architecture.md` §3（wrap 约定） |
| P0-10 | **打包态不得接管别人的 3001（数据归属错误）** | 打包态故意不先探活：自己后端 `EADDRINUSE` 退出后，`waitForBackend()` 会探到**别人的** `/api/health` 200 → 窗口正常打开，读的是另一个实例的数据目录（很可能是开发库）。用户以为在看自己的项目，实际在看别人的数据，与 README「数据落在你自己的用户目录」直接冲突。判定：先 `npm run dev:server` 占住 3001 → 启动打包版 → 必须出现「3001 被占用」错误页，**不得**展示任何工作区/会话 | `desktop/main.cjs:898-931` |

---

## 4. P1 · 能进则进（体验与一致性）

| # | 条目 | 说明 | 依据 |
|---|---|---|---|
| P1-1 | 视觉回归补齐 | 深色主题 / 拖拽调宽改用 Chrome CDP 截图（`composer-visual.mjs` 已有可用先例），补打包态首启截图 | fix-summary §3-③ |
| P1-2 | 测试入口并入 CI | P0-8 的两条命令（`test:all` + `test:gui`）接进发布流水，前者无人值守、后者标记为需 GUI 环境，避免人工记忆决定跑哪些 | `package.json:51-55` |
| P1-3 | 打包元数据 | `package.json` 缺 `description/author/license`；`electron-builder.yml` 的 `copyright: DevWork local demo` 需改成正式文案 | `package.json`、`electron-builder.yml:3` |
| P1-4 | 首启引导 | 空环境下给出"接入第一个资产"的单一主行动（空状态已做，缺主 CTA 收口） | audit §10.3-9 |
| P1-5 | 错误码字典 | 把 `E_*` 全集 + HTTP 状态 + 用户话术整理成一页，供支持与前端复用（本轮已修过"未登记即 500"） | audit §10.5-1 |
| P1-6 | 工作区清理说明 | `tmp/qa-*`、`release/build-*` 历史目录不入库但占盘且易误发；打包前提示清理 | `.gitignore`、`scripts/check-version.mjs`（stale exe 仅 warn） |
| P1-7 | 归属硬编码清理 | 审批审计 `workspaceId` 等 **5 处**硬编码 `'w-ops'`，多工作区下审计归属全错（同类缺陷的统一宿主：`conversation.ts:1092` 起） | 架构审查 A-P2-05 |
| P1-8 | 崩溃后要有明确提示 | 后端异常退出后当前只表现为界面不可用，应给「后端已退出 · 重试」而非静默（与 P0-10 同族但不同故障：只"不告诉你坏了"，不会"给你看别人的东西"） | 架构审查 A-P1-02 |
| P1-9 | **端口同源 + 子进程 env 命名空间黑名单** | 壳与后端端口必须同源。子进程 env 按**命名空间黑名单**构造：以 `process.env` 为底**全量透传**，剔除所有外部 `DEVWORK_*` 前缀键、`ELECTRON_RUN_AS_NODE`、`NODE_OPTIONS`；再由 `main.cjs` 显式写入 `DEVWORK_PORT=API_PORT`、`DEVWORK_DATA_DIR`、`DEVWORK_SANDBOX_DIR`、`DEVWORK_CLEAN`、`DEVWORK_SHELL_TOKEN`。**`PATH`/`SystemRoot`/`TEMP`/`USERPROFILE`/`HOME`/`APPDATA`/`NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` 一律透传，不得裁剪**——后端有 **8 处裸名调 `git`**（`repositories.ts:604`、`bootstrap.ts:141`、`file-service.ts:238/260`、`shadow-collectors.ts:127/128`、`workdir.ts:54`、`workspace-repos.ts:204`），`spawnPlan()` 还起 `tasklist/git/docker/kubectl/systemctl/journalctl`；丢 `PATH` → `probeTools()` 判 git 不可用 → 克隆/文件大纲/diff/工单 worktree 全挂，**等于用一个 P0 回归修一个 P1**。现状：`main.cjs:420-432` 独漏 `DEVWORK_PORT`（`config.ts:35` 认它、壳 `API_PORT` 恒 3001）→ 残留 `DEVWORK_PORT=3031` 时 15s 错误页且日志无可查线索。`DEVWORK_SUPERAGENT=off` 保留生效但**必须打日志**（`[boot] env DEVWORK_SUPERAGENT=off ...`），不静默吞、不强行覆盖。**判定（①②③ 全中，②③ 是必要条件——只看①会被"端口修好了、代码库坏了"骗过去）**：① `set DEVWORK_PORT=3031` 启动打包版仍进首屏，且 `desktop.log` **能读到被强制的端口值**（形如 `env DEVWORK_PORT=3001 forced`，**允许文案差异，不逐字匹配**）；② `GET /api/health` → `gitAvailable:true`（`PATH` 被裁掉时它第一个变 false）；③ 真跑一次「克隆本地裸仓库（`file://`）→ 读文件大纲」，`files/outline` 的 git 段应为「最后修改 <hash>」而非「git 不可用」。**README 已知限制不写这条**（修掉的缺陷写进限制，等于暗示"可能连不上"） | `desktop/main.cjs:16/420-432`、`backend/src/config.ts:35`、`scripts/dev-supervisor.mjs:107` |

---

## 5. P2 / 明确不做（避免工程师误开工）

| 不做 | 理由 |
|---|---|
| MCP 客户端、Skill 运行时/脚手架/调试面板 | 设计排在 M2；现为提示词级技能登记表，做真运行时属独立版本（audit §5） |
| 记忆系统、远程策略下发、私有模型接入 | M2/M3 范围 |
| 多用户 / 账号 / 角色 / 远程身份 | 账号体系已整体移除，回填即推翻权限模型（superagent §14） |
| 删除账号、多设备退出 | 没有账号后端就不存在可删对象，保持说明型弹窗（fix-summary §3） |
| 资产离线真实探测 | 需真实连通性探测；宁可无此状态，不伪造绿点（audit §10.3） |
| 自动更新真实发布（**已裁决：仅预留**） | `publish.url` 保持占位 `update.devwork.example`，不发真实 feed；「检查更新」只做本地版本比对并如实说明；CHANGELOG 不承诺自动更新可用（`electron-builder.yml:46-52`） |
| tree-sitter / LSP / 向量检索 / 重排 | 重型检索管线，M1+ 排期，风险高收益延后 |
| macOS / Linux 产物（**已裁决**） | 1.0 **仅 Windows x64**；跨平台需重测内置 node.exe 与打包契约，属独立版本 |
| NSIS 安装流程跑通 | 只要求「能生成安装包」；本机 rcedit/签名已关，杀软可能拦，安装流程不作发布闸门（结果如实写进发布说明） |
| 生产环境写能力（p3 放开） | 设计闸门要求"写入期零数据损坏事故"；1.0 不碰 |

---

## 6. 发布验收标准（命令 + 期望结果）

| # | 项 | 命令 | 期望 |
|---|---|---|---|
| A1 | 类型 | `npm run typecheck` | 前后端 tsc 均 0 error |
| A2 | 单元基线 | `node tests/markdown.mjs` / `composer.mjs` / `skills.mjs` / `attention.cjs` | **实测已过**：8/8 · 16/16 · 16 · 全过 |
| A3 | 隔离冒烟（7 阶段） | `npm run build && npm run test:smoke` | smoke / repo / db / asset / context / shadow / tickets 全通过；临时目录打印且不污染用户库 |
| A4 | 影子核心 | `npm run test:shadow:core` | 全通过（拨时钟：到点/补发/工单生命周期/隔离/扇出） |
| A5 | **写执行层** | `npm run test:agent-tools` | 全通过（派生工具面 / 七组只读真实执行 / 写三层防线 / 回滚 / 连拒熔断） |
| A6 | 构建产物 | `npm run build` + `ls -l dist/assets` | 成功；实测 **527,983 B JS / 125,793 B CSS**，阈值定为 **JS ≤560kB、CSS ≤140kB**，且 `grep -c ZodError dist/assets/*.js` = 0（zod 不得进前端包） |
| A7 | 版本 | `npm run check:version` | 通过；且 grep 断言 `0.4.2` 不出现在 `backend/src`、`frontend/src`（含 `0.4.2-mock` 第四种写法） |
| A8 | 打包 | `npm run dist` / `--portable` / `--installer` | 六步全过；产出 `DevWork-1.0.0-win-x64.zip`、`-portable`、`DevWork-Setup-1.0.0-win-x64` + `stable.yml`；包内 `resources/server/node_modules` **含 zod** |
| A9 | 产物可启动（**仓库外**、无 Node 机器，zip + portable 都验）【**当前待 QA**】 | 拷到 `C:\tmp\dw\` 解压 → 双击 `DevWork.exe`；再双击 portable 单文件 | 两种形态均 5 秒内出三栏首屏、无报错页；`/api/health` = `driver=node:sqlite, wal=true, version=1.0.0`；**不得出现 `ERR_MODULE_NOT_FOUND: zod`**。⚠ 现有 `release/build/win-unpacked/resources` 仍是旧四件（`dist/runtime/server/shared`，**无 `node_modules`**），必须重新打包后验，不得凭旧产物判通过 |
| A10 | 首启无 Key | 清 `%APPDATA%\DevWork` → 启动 → 提「OrderService 在哪个文件实现？」 | 侧栏仅 1 空工作区；回答为「演示轨迹 · 未接入模型」；**无 conclusion、无 citation** |
| A11 | 升级不丢数据 | 拷 0.4.2 `devwork.sqlite` 覆盖新装数据目录 → 启动 | 各表条数不变；`PRAGMA integrity_check`=ok；关于页显示 1.0.0 |
| A12 | 写回滚演练 | 造一张写卡 → 批准 → 校验磁盘变更 → `POST /api/approvals/:messageId/rollback` | 文件恢复、审计含批准与回滚两条、重复裁决 409 `E_ALREADY_RESOLVED`、快照落 `DATA_DIR/snapshots/`（仓库内无 `.devwork-snapshots/`） |
| A13 | 干净关停 | `npm run test:desktop-ipc`（P0-8 要求补该 script） | 关窗后 3001 端口释放、无 `node.exe` 残留；人工兜底口径：`netstat -ano \| findstr :3001` 无监听 |
| A14 | 超长输入不崩（**三条全中，缺①判「表面关闭」**） | `POST /api/conversations/c-x/stream` 传 `content` = 200,001 字符 | ① 返回 **400 `E_VALIDATION`**（不是挂起转圈）② 紧接着 `GET /api/health` 仍 **200** ③ 后端 **PID 不变**。只加 `unhandledRejection` 兜底而没在 `writeHead` 前 try/catch 不算修（进程不死但请求永久挂起）；**本条由后端线单独关闭，重启兜底不作为验收条件** |
| A15 | 端口冲突不串环境（**正向 + 反向 + 日志序列**） | 先用**另一份数据目录**占住 3001：`DEVWORK_DATA_DIR=<临时目录> npm run dev:server`（端口变量是 `DEVWORK_PORT`，默认 3001；`main.cjs:16` 把打包态端口写死 3001）→ 再启动仓库外打包版 | ① 打包版**不得**显示那个库里的工作区/会话，须出错误页且文案指明「3001 被占用」；② **反向**：结束占用进程后再启动 → 必须正常进首屏（防 fix 写成"永远报错"）；③ `<userData>/logs/desktop.log` 不得出现「先 spawn 后端 → 再 attach 成功」序列（空界面与错误页截图相似，日志序列才是硬证据） |

---

## 7. 对架构师的三条提醒（审查最该盯的面）

> 引用约定：本文优先引**符号名/端点名**，行号只作附注——本轮已出现"核的时候对、落纸后又漂 7 行"（`stage-runtime.mjs` 头注释被扩写）。**行号失效看起来仍然精确，比没有依据更危险**，请以符号为准。

1. **写通道已裁决"保留能力、钉死档位"，旁路核查已完成（无第二条路）。** `executeWritePlan` 只有 3 个入口（会话记忆命中 `:204` / 事件回放 `:489` / 审批裁决 `:1118`），`permission.ts:143-145` 那句「当前版本没有写执行通道」是过期注释（P0-7 要求替换）。**唯一松点是会话级审批记忆**：记忆键不含参数，批准一次 `code_edit` 可同会话免审写任意文件 → P0-4 补丁①要求 1.0 直接移除「本会话内允许」；另两个补丁是快照落 `DATA_DIR`（否则污染用户 `git status`）与回滚路径包含性断言。
2. **"显示的值必须有真实来源"是 1.0 最容易被打破的约定。** 版本号 3 处硬编码 + `setting.about` 只在 seed 时写，就是同一类缺陷的复发（audit §10 刚清完一轮假数）。审查时统一问一句：这个数字/状态来自哪张表、哪次执行、哪次探测？说不出来就标红。
3. **打包契约是隐式同步，且"六步全过"不等于"能装"。布局是五件**：`resources/{dist,server,shared,node_modules,runtime}`（`shared/` 需自带 `package.json{type:module}`；`resources/node_modules` 供 shared 侧裸包解析——ESM 从 import 所在文件向上找，`server/node_modules` 不在这条链上）。**同步集是四处、缺一即静默出错**：`main.cjs`（注入 `DEVWORK_CLEAN`/`DEVWORK_DATA_DIR`、探活）+ **`stage-runtime.mjs`（`build/pkg/*` 的实际产出方——只改 builder 不改它，依赖会静默丢失）** + `package.mjs` 产物自检 + `electron-builder.yml`（`extraResources` 四条）。**依赖清单是「两份」不是「一份」**：`RUNTIME_MODULES` → `server/node_modules`（express/cors/tsx/zod）、`SHARED_RUNTIME_MODULES` → `resources/node_modules`（当前只有 zod）；两份都定义在 `stage-runtime.mjs`、被 `preflight` 与 `package.mjs` import。**写"两份"是因为 v1.0 两次 P0 都出在份数上**：第一次少一个包（zod 没进 server 清单）、第二次少一份落点（zod 在 server 下但 shared 解析不到）——"两份"能让人一眼看出"多类消费者"。另有掩盖效应：仓库内冒烟会向上解析到 `devwork-app/node_modules/zod`，六步全过而装机必崩。**规则**：清单是**手工维护**的，不能靠"记得同步"——必须由**仓库外目录的行为式自检**兜底（漏了清单但自检不过，包就发不出去）；新增后端运行时 import 时同时做两件事：同步两份暂存清单 + 跑一次仓库外启动自检。**把保证从"记住"换成"过不去"。** 同一族假设还有 P0-10：打包态不先探活，就把「端口被别人占着」误当成「自己的后端已就绪」——**必须把端口冲突当自己的失败，而不是接受别人的 200。**

---

## 8. 已裁决（原 Q1–Q6，主理人裁定）

| # | 事项 | 裁决结果 | 对 PRD 的影响 |
|---|---|---|---|
| Q1 | 版本号 | **发 1.0.0**（用户原话「第一个正式版本」）。语义 = 「只读为主 + 受控写可回滚」这一能力面的正式版，**不是功能齐全版** | 标题与 P0-5 保持 1.0.0；README/CHANGELOG 须按此措辞，不承诺"功能完整" |
| Q2 | 写执行 | **不砍能力，钉死默认档位与口径**：保留 `readOnlyMode=true` / 中低风险 deny / 仅显式批准 plan 真写；README 与关于页标「受控写（实验性）」；删 `permission.ts` 过期注释（工程师执行） | 改写 P0-4、P0-7；§7 提醒 1 改述为"查旁路" |
| Q3 | 打包实测 | **zip + portable 本机实测**；NSIS 只验「能生成安装包」，安装流程不作闸门，结果如实写进发布说明 | 改写 P0-1、A8、A9；§5 增 NSIS 行 |
| Q4 | 自动更新 | **不发真实 feed**，`publish.url` 保持占位；更新能力声明为「预留」，CHANGELOG 不承诺可用 | §5 该行加"已裁决"；P0-7 加第 ③ 款 |
| Q5 | 平台 | **仅 Windows x64**；mac/Linux 明确进「不做」 | §5 该行加"已裁决"；A9 只测 Windows |
| Q6 | 许可 | **闭源私有，LICENSE 写 `Proprietary`**（禁止再分发/反编译、无担保）；README 不加开源徽章 | 改写 P0-6 |

> 仍待确认（唯一）：0.4.2 存量库的 `setting.about` 迁移是否需要保留旧值展示——建议直接覆盖为 1.0.0，不保留历史。
> 补充（依据架构审查 A-P1-09 / A-P2-15 / A-P2-16）：Q2 的「保留」**附带三个补丁**，已全部并入 P0-4；「不砍能力」的前提是这三点修完，否则 README 里「逐次批准、可回滚」不成立。
