# DevWork 实现 × 设计文档 对齐审查报告

> 审查日期：2026-11-13 · 对象：`devwork-app`（v0.4.2，src+server 约 1.4 万行）· 基准：`docs/devwork-design.md`（v0.1，2599 行）
> 方法：全文读设计文档 → 逐模块读代码 → 起后端实测接口 → 跑 typecheck 与自带 94 项冒烟测试

---

## 0. 一句话结论

**"壳"做到了 M1 水准，"里子"停在 M0 之前。**

三栏骨架、六类视图、组件语言、设计令牌、快捷键、审计追加、SQL 防火墙、命令白/黑名单、凭据五态、路径越界防护——这些是**真做的、可验证的**。
但设计文档反复强调的两条护城河——**上下文治理**和**权限治理**——以及"证据链可信"这个产品的立身之本，目前大量由**模板文本 + 种子数据**兜住；默认配置下（未配模型 Key），Agent 会对任何问题给出与问题无关的预制结论，并挂上伪造的引用角标。

> 设计 §12 风险 1 的原话：「一个错误的根因分析会让人往错的方向排查半天」。当前出厂状态正好踩在这条上。

| 维度 | 对齐度 | 判断依据 |
|---|---|---|
| 前端布局 / 交互 / 视觉 | **90%** | 208/300/44/30 尺寸全对，六类视图齐全，13 个快捷键生效 |
| 资产详情三类页（终端/SQL/编辑器） | **75%** | 骨架、Tab 顺序、守卫都在；执行链路有实质缺陷 |
| 权限与安全（内核/审计/凭据） | **60%** | 内核可跑、审计只追加；但约束项、审批流、速率预算缺失 |
| 会话与证据链 | **35%** | 卡片形态齐；证据内容假、工具状态假、用量假 |
| 编排与检索（Agent Runtime） | **15%** | 无计划器/无 ReAct/无预算/无重排/无记忆 |
| 生态（Skill / MCP / 工作流定义） | **0%** | 全局搜索无实现痕迹（仅 mock 文案出现 "MCP"） |

---

## 1. 已对齐且质量在线的部分

先说做对的，避免"全是问题"的错觉：

1. **三栏骨架与尺寸纪律**：`styles.css:54/99/292/359` 精确 44/208/300/30，中栏限宽、右栏仅会话视图存在、⌘B / ⌘\ 折叠且折叠后顶栏给出展开入口——与 §9.2 一致。
2. **权限内核是唯一 choke point**：`kernel/permission.ts` 六段判定顺序固定，所有裁决写审计并返回 `auditId`；`probe()` 不写审计可做前后对照，这个设计比文档还细。
3. **Agent 写 ≡ 拒绝**：`issue-②` 无条件 deny + suggestion，实测只读开关开/关都是 `bytesWritten=0 / diskChanged=false`，与 §0 判断五、§9.13 的"约束 Agent 不约束用户"完全对齐。
4. **审计 append-only**：SQLite trigger `audit_event_no_update/no_delete` 兜底，导出动作本身也记一条审计（`routes/index.ts:901-920`），落实了 §9.9「查日志也要被记录」。
5. **SQL 防火墙工程质量高**：引号/注释感知、顶层 LIMIT 识别、自动追加并明示、worker 线程 15s 超时 + `terminate`、执行前后 checksum 比对——§9.12 的五个细节做到了四个。
6. **终端拦截三件套**：黑名单全串+逐段 → 敏感文件名 → shell 元字符 → 42 条白名单逐段 → 内核裁决，且**零 spawn**；拦截文案也照抄了 §9.11 的"做了什么/没副作用/下一步"三段式。
7. **凭据五态 + safeStorage**：秘密经 Electron IPC 走 `safeStorage` 加密落盘，DB 只存 `secret_ref`；未绑定返回 `E_CREDENTIAL_REQUIRED` 而不是连接异常——§8.5 的"失效不能静默"落地了。
8. **前端只有一个数据入口**：`api/client.ts` 是唯一出口，`live.tsx` 统一装配，组件不直接 import mock；这个约束守得很干净。

---

## 2. P0：会直接摧毁用户信任的 4 个问题

### P0-1 未配模型 Key 时，任意提问都返回预制结论 + 无关引用

**复现**（无 `DEVWORK_API_KEY`）：

```
POST /api/conversations/c-gmv/messages  {"content":"OrderService 在哪个文件实现？"}
→ intent=general
→ text:       已收到。正在检索已挂载资产并整理上下文，随后给出结论。
→ conclusion: 已完成分析：本次仅使用只读检索，未对生产环境产生任何写操作[1][2]
→ citations:  [1] GMV 口径说明 v2.3  docs/ops/metrics.md:40-42
              [2] 2026Q3 运营复盘    docs/ops/q3-review.md:88-90
```

**根因**：`llm-gateway.ts:176-215` `MockGateway.generate()` 用 `detectIntent()` 选模板，**完全忽略用户输入内容**；`citationFor()`（:154-173）两条引用写死为 GMV 文档。问代码定位，答 GMV 口径，还带 0.86 置信度。

**违反**：§0 判断一、§5.6 三条反幻觉硬规则、§12 风险 1 与"无引用不给结论"、§11 M0 验收（"问 X 在哪实现 → 可点行号的准确答案"）。

**建议**：mock 轨迹**不得产出 conclusion 与 citation 事件**，只输出"演示轨迹 · 未接入模型"的说明卡；或在 UI 顶部挂持续可见的降级条。宁可说"我不知道"，也不能给假结论——这正是文档判断五的逻辑。

### P0-2 引用的落点不存在，证据链点不回原文

- `docs/ops/metrics.md`、`docs/ops/q3-review.md` 在沙箱仓库中**不存在**（`server/sandbox/repos/order-service/` 只有 README/pom/src）。
- `index_chunk` 里 `a-kb` 的 2 条 doc 块是**种子文本**（`ic-1` GMV 口径、`ic-2` Q3 复盘），磁盘无源文件。
- 因此浮层里「打开」按钮只能弹 `已打开来源 … （mock）`（`ChatView.tsx:465`）。

**违反**：§2.4「citation 独立表是可信 Agent 和聊天玩具的分水岭」、§9.16 两级证据。

**建议**：把 2 篇种子文档真实写入 `docs/ops/`，并让 citation 的 `locator` 由索引器生成（而不是模板字符串），「打开」按钮直连编辑器并跳到行号。

### P0-3 工具失败，卡片仍显示"已自动放行"

实测 `tool_row` 的 `result` 是「需绑定凭据：该资产配置已共享，你还没有绑定只读凭据」，而同一条卡片的 `status` 恒为 **「已自动放行」**（`conversation.ts:291-300` 写死）。

**违反**：§9.18「工具失败：工具卡标红 + 错误摘要 + 『换个方式』」；也让"放行/拦截"这一整套可信信号失真。

**建议**：`status` 由 `verdict.effect + result.ok` 推导（放行 / 失败 / 已拦截 / 转建议），失败态进右栏「执行」Tab 用警告色。

### P0-4 kb_search 被数据库凭据错绑

`makeToolExecutor`（`conversation.ts:97-152`）里 `kb_search`/`code_search` 本身不查凭据，但事件落到 `allow` 分支后统一走 `executeReadOnlyTool()`（:154-174），**该函数恒用 `a-order-db-prod` 做 `requireCredential`**。结果：知识库检索、代码检索一起被"请先绑定生产库凭据"挡死。

**违反**：§2.3 能力矩阵（knowledge 与 database 是不同能力）、§3.4 按资产能力裁剪工具。

**建议**：凭据校验下移到各工具自身的资产上（kb → `a-kb`，code → `a-order-service`，sql → `a-order-db-prod`），并把 `executeReadOnlyTool` 里那条写死的 `SELECT status, count(*) FROM "order"` 换成真实工具结果。

---

## 3. P1：功能缺口 / 与文档承诺不符（10 条）

| # | 问题 | 证据 | 文档条款 |
|---|---|---|---|
| P1-1 | **SQL 查询页默认语句必然报错**：默认 SQL 用 PG 语法 `now() - interval '2 hours'`，引擎是 SQLite。实测 422 `near "'2 hours'": syntax error`，且前端显示为「✕ 已拦截 E_SQL_REJECTED」——把语法错误伪装成安全拦截 | `data/mock.ts:789`、`sql-query.ts:143`、`DatabaseDetail.tsx:76` | §9.12「错误码翻译成人话 + 光标定位」 |
| P1-2 | **终端多会话 cwd 隔离失效**：会话目录建了不用，`pwd` 返回 `sandbox/repos/order-service`，而非会话自己的 `sandbox/terminal/a-order-api/sess-1` | `command-executor.ts:607-610`、`:409-439` | §9.11「每个会话独立 cwd，避免抢同一 shell 工作目录」 |
| P1-3 | **组织两条硬约束缺失**：删除唯一管理员返回 200；删除成员不要求资产接收人，`transferredAssets` 恒 0 | `routes/index.ts:860-864` | §9.9「移除必须指定接收人」「不能移除最后一个管理员」 |
| P1-4 | **右栏 3 Tab 永远是 c-gmv**：装配层写死 `getContextPanel('c-gmv')`；ContextPanel 的按会话请求只用来 bump revision，数据被丢弃 | `live.tsx:115-117`、`ContextPanel.tsx:24-38` | §9.4「三个 Tab 都是会话级」 |
| P1-5 | **切工作区不加载会话**：`App.tsx` 恒把 bootstrap 消息塞进 `'c-gmv'`（实测 w-data 返回的是 c-metric-check 的 2 条消息）；`setWorkspace` 只改 id 不拉消息 → 切过去是空对话 | `App.tsx:233-236`、`store.tsx:241-262` | §9.7 切换副作用清单 |
| P1-6 | **文件夹能力只做了折叠**：client 有 create/update/delete/reorder/move，服务端全套路由就绪，前端 **0 调用**；无重命名/移动/拖拽排序/新建子文件夹；折叠状态不持久化；无"≤12 平铺 / 13~30 自动分组 / >30 筛选"；服务端不校验 depth≤2 | `Sidebar.tsx:22,89`、`client.ts:249-253`、`routes/index.ts:291-325` | §9.6 全表 |
| P1-7 | **资产接入向导缺失**：设计 M0 明确要求"4 步向导 + 测试连接"，现状点 `＋` 只弹 toast；连带新建/断开/重新索引入口都没有 | `Sidebar.tsx:89` | §11 M0、§2.5 |
| P1-8 | **知识库 / 日志详情页缺失**：kb 类资产 `go=null`，点击只 toast「检索型资产，暂无独立详情页」；`log` 资产类型整个没有（§5.5 五阶段、§9.14 pattern 聚类均无） | `repositories.ts:81-82`、`Sidebar.tsx:51` | §9.14、§2.3 |
| P1-9 | **审批卡不可达**：agent 写操作在判定②就 deny，`ask` 分支（:125）永远到不了；UI 里的"审批卡"其实是 suggestion 映射来的（`adapters.ts:70`），点"批准执行"只写一条文本卡，不执行任何东西 | `permission.ts:103-129`、`conversation.ts:433-450` | §8.2 五级审批、§5.3 三层命令模型 |
| P1-10 | **用量/费用是假数**：每轮固定 `+2048 tokens / +0.02 元`，首轮写死 34816/0.44。实测 106496 → 108544，与真实 token 无关 | `conversation.ts:348-373` | §9.4 上下文构成、§8.4 cost、§12 风险 12 |

---

## 4. P2：一致性与体验偏差（清单）

| # | 问题 | 位置 |
|---|---|---|
| 1 | 计划卡未渲染：`plan` 被压成一行文字「计划 N 步 · intent」 | `adapters.ts:53-58`；§9.17 |
| 2 | 产物展开是**一个全局布尔**，点一个所有产物一起展开；内联预览是占位文字 | `ChatView.tsx:39,332-337`；§9.17 |
| 3 | 状态栏恒 `32768/0.42`；SQL 结果条恒「1,283 行 · 42ms」 | `repositories.ts:77-79`、`DatabaseDetail.tsx:362` |
| 4 | 审计筛选只做前端分类，服务端已支持的 actor/assetId/action/from/to 未被使用；导出 8 列 vs 文档 5 列 | `OrgView.tsx:146`、`routes/index.ts:138-159` |
| 5 | 策略"影响面"用种子文案，未用 `/org/policies/impact`（该接口已实现） | `OrgView.tsx:255` |
| 6 | **无深色模式**（§9.19 明写"深色模式必备"）；设计令牌改版为阴影体系，与文档"阴影几乎不用"相反 | `styles.css:1-40` |
| 7 | 左右栏宽度不可拖拽（§9.2 要求 180~260 / 260~420） | 全局无 resize 逻辑 |
| 8 | 设置/用户中心多为骨架：清除数据、检查更新、全部退出、删除账号 → 都是"规划中" toast | `SettingsView.tsx:75`、`UserView.tsx:25-51` |
| 9 | 空状态缺失：无产物、无会话、索引中、资产离线等 §9.18 状态矩阵基本没做 | 各视图 |
| 10 | 侧栏会话条目的 `⋯` 只是 span，无菜单（重命名/删除只在会话头部有） | `Sidebar.tsx:71` |
| 11 | 助手正文不支持 Markdown / 代码块（纯 `<p>`），代码高亮是自研正则而非 Shiki | `ChatView.tsx:201-206`；§10.2 |
| 12 | `newConversation` 硬编码 `workspaceId:'w-ops'`，在 w-data 下新建会话会落到生产运维 | `store.tsx:317` |
| 13 | 文件树按**文件名**匹配跳转，重名文件会跳错；`/files/tree` 忽略 path 参数 | `CodeDetail.tsx:305`、`routes/index.ts:717-720` |
| 14 | SQL Guard 把 `REPLACE` 列为禁用词，`SELECT REPLACE(name,'a','b')` 会被误杀（误报） | `sql-guard.ts:17-21` |
| 15 | **冒烟测试污染运行库**：94 项测试直接写 `server/data/devwork.sqlite`，累积 11 条 `qa-cn` 成员、295 条消息、40 个 artifact，席位显示 23/20 溢出 | `tests/smoke.mjs` |

---

## 5. 文档有、实现完全没有（功能矩阵）

按设计章节点名，标注是否落地：

| 章节 | 能力 | 状态 |
|---|---|---|
| §3.1-3.2 | Plan-and-Execute + ReAct、任务状态机（CLARIFY/STEP_FAILED/REPLANNING/PARTIAL） | ❌ 只有 routing→模板 |
| §3.3 | 上下文预算管理器（65% 动态分配、四层压缩策略） | ❌ 无 |
| §3.4 | 工具注册表（riskLevel/sideEffects/reversible）+ 工作区/阶段裁剪 + 30 个上限 | ❌ 3 个工具写死在代码里 |
| §3.5 | 反思与自校验（acceptance criteria、空结果不等于没 bug） | ❌ 无 |
| §4.1-4.2 | BM25 + 向量 + 符号三路 RRF、AST 语义分块、增量索引 | ❌ 仅 FTS5+LIKE；40 行硬切；每次全量重建 |
| §4.3 | DB schema 元数据 + 枚举值注入 + 按需采样 | ⚠️ 有 `sql_table_meta` + PRAGMA，但无采样注入、无枚举值 |
| §4.4-4.5 | ContextPack 组装、四级记忆（工作/情节/语义/画像） | ❌ 无 |
| §5.1-5.6 | 五个 WorkflowDef（含 acceptance、stages） | ❌ 只有 3 个意图模板 |
| §5.5 | 日志聚合/突增检测/模板挖掘 Drain/PII 脱敏 | ❌ 无 |
| §6 | Skill 规范、manifest、生命周期、脚手架、调试面板 | ❌ 无 |
| §7 | MCP 客户端（stdio/HTTP）、OAuth PKCE、工具投毒防护 | ❌ 无 |
| §8.1 | Capability 约束（env/pathPrefix/maxRows/timeWindow）、速率与预算检查 | ❌ 仅 granted/approval 两字段 |
| §8.3 | SQLCipher、PII 检测、留存期、一键清除 | ❌ 无 |
| §9.6 | 文件夹手工树 + 自动分组 + 搜索兜底 + 拖拽排序 + 折叠持久化 | ⚠️ 仅"读 + 折叠" |
| §9.7 | 多项目切换的完整副作用（含"运行中任务不中断"） | ⚠️ 切了 id，数据没换 |
| §9.14 | 知识库/日志检索型详情页 | ❌ 无 |
| §10.2 | Tailwind+Radix、Zustand+TanStack Query、TanStack Virtual、CodeMirror、xterm.js、tree-sitter、LSP、pino、Vitest/Playwright | ⚠️ 除 Electron/React/Vite 外全部自研或替换（可接受，但文档需同步） |
| §11 M1 | Secret Vault（OS Keychain）✅、凭据复用 label ❌、到期提醒 ❌、撤销 ✅ | 部分 |
| §11 M2 | MCP / Skill / 生成文档 / 记忆 / 远程策略 / 私有模型 | ❌ 全部 |

**说明**：M2/M3 未做是符合路线图的，不算缺陷；**问题在于文档没有标注"当前实现到哪一期"**，评审时容易把"设计意图"误读成"已交付能力"。建议在文档头部加一张"实现进度对照表"。

---

## 6. 逻辑缺陷（代码级，可直接修）

1. **`hydrateFromRest` 的会话键写死**：`App.tsx:233-236` 忽略 `bootstrap.currentConversationId`，一律用 `'c-gmv'`。应改成 `{ [payload.currentConversationId]: cards }`。
2. **右栏请求结果被丢弃**：`ContextPanel.tsx:32-35` 拿到 envelope 只 `setTabRevision(+1)`，渲染仍读 `useLiveData()` 的 c-gmv 快照。要么把数据落到 store，要么装配层按 activeConversationId 重拉。
3. **`usage_stat` 先 UPDATE 后判存在**：`conversation.ts:362-372` 顺序反了，首轮 UPDATE 命中 0 行再 INSERT 硬编码值；后续永不计真实 token。
4. **工具状态与结果脱钩**：`conversation.ts:291-300`（见 P0-3）。
5. **`serviceCheck` 写死资产与角色**：`conversation.ts:64-73` 恒 `assetId:'a-order-db-prod'`、`role:'admin'`；`makeToolExecutor` 里 `requireCredential` 也硬编码 `name:'黎忠芳'`。权限内核在此处退化成"必过"。应传真实 identity + 工具所属 assetId。
6. **`respondApproval` 不做任何执行也不校验会话归属**：`conversation.ts:433-450` 只根据 messageId 查 payload 再插一条文本。审批语义（§8.2）完全落空。
7. **`builtinDispatch` 用 `REPO_ROOT` 而非会话 cwd**：`command-executor.ts:610`（见 P1-2）。
8. **`sanitizedEnv` 的白名单逻辑是死代码**：`:59-65` 遍历 `process.env` 后 `void upper`，实际什么都没剔除——真正的过滤靠"只从 SAFE_ENV_KEYS 取值"，遍历块可删。
9. **`ensureSession` 上限判断有 TOCTOU**：`:448-458` 先查存在再查计数再插入，非事务；并发新建可能突破 5 个上限。
10. **`E_SQL_REJECTED` 一码多用**：guard 拒绝与 SQL 执行失败共用（`sql-query.ts:143`），前端无法区分"被拦"和"写错了"，而这两件事的用户动作完全不同。
11. **`isWriteAction` 用词元正则**：`/\b(write|ddl|restart|delete|apply|truncate|drop)\b/i` 会误判 `db.schema.describe_drop_index` 之类的读动作；建议改成显式白名单表（文档 §2.3 的能力矩阵本就是枚举）。
12. **`fileTree` 递归无深度与数量上限**（`repositories.ts:420-443`），大仓库会把整棵树塞进一次响应。
13. **`GET /api/assets/:id/sql/schema` 忽略 assetId**（:645-652），所有库共用 `sql_table_meta`——多库资产只是摆设。

---

## 7. 验证记录（可复现）

```
npm run typecheck   → 前端 + 后端 0 error
node tests/smoke.mjs → Total 94 | Passed 94 | Failed 0
布局实测            → .topbar 44 / .side 208 / .ctx 300 / .sbar 30 ✅
默认 SQL            → 422 E_SQL_REJECTED（PG 语法 vs SQLite）
任意提问            → intent=general，结论+引用与问题无关（P0-1）
kb_search           → 需绑定凭据（P0-4）
pwd                 → sandbox/repos/order-service（应为会话 cwd）
DELETE 唯一管理员   → 200 removed:true（应为 409）
usage 两次查询      → 106496 → 108544（固定 +2048）
```

> 注：审查过程中为验证组织约束删除过 m01/m02 两条成员记录，已按原值恢复（`m01 黎忠芳 管理员` / `m02 张伟 成员`）。测试期间后端进程已停止，未改动业务代码。

---

## 8. 建议的修复顺序

**第一步（先保住"可信"，1~2 天）**
1. mock 轨迹禁止产出 conclusion / citation（P0-1）
2. 修 P0-3 工具状态、P0-4 凭据错绑
3. 把两篇 GMV 文档真实写入沙箱仓库，让引用可点开（P0-2）
4. 修默认 SQL 与错误码语义（P1-1）

**第二步（补 M0/M1 的形状，1~2 周）**
5. 右栏按会话装配 + 切工作区加载消息 + `hydrateFromRest` 键修正（P1-4/5）
6. 组织两条硬约束（P1-3）、终端会话 cwd（P1-2）
7. 文件夹写链路接通（新建/改名/移动/拖拽/折叠持久化）+ depth≤2 校验（P1-6）
8. 资产接入向导（P1-7）、知识库详情页（P1-8）
9. 真实 token 计量（P1-10）

**第三步（对齐架构承诺，按 M2 排期）**
10. 工具注册表 + 上下文预算管理器 + 检索重排（§3.3-3.4、§4.1）
11. WorkflowDef 抽象（把 3 个模板替换成声明式流程）
12. Skill / MCP（M2）

---

## 9. 给设计文档的两条修订建议

1. **加"实现进度"标注**：每章标题后挂 `[已实现 / 部分 / 未开始]`，否则评审时无法区分"设计意图"和"交付承诺"。
2. **同步技术选型**：文档 §10.2 列的 Tailwind/Radix/Zustand/CodeMirror/xterm/tree-sitter/better-sqlite3/sqlite-vec/pino/Vitest 实际全部未采用，现实现是「纯 CSS + 自研 store + contentEditable + node:sqlite + 自研测试脚本」。要么改文档，要么改代码——但不能让新人照着文档去找依赖。

---

---

## 10. 修复记录（2026-11-13，逐条闭环）

> 依据本报告 §2–§6 清单逐条修复，**不跳过、不合并**。验证口径：前后端 `tsc --noEmit` 0 error、
> `tests/smoke.mjs` 隔离实例 **123/123 通过**、`tests/markdown.mjs` **8/8 通过**、`vite build` 成功。

### 10.1 P0（4 条，全部关闭）

| # | 原问题 | 现状 | 关键改动 |
|---|---|---|---|
| P0-1 | 未配 Key 时任意提问返回预制结论 | **已修**：未配 Key 时结论卡显式标注"模型未接入 · 以下为规则化轨迹"，不再伪装成模型回答 | `llm-gateway.ts`（MockGateway 语义 + `modelName='未接入模型'`） |
| P0-2 | 引用落点不存在 | **已修**：引用带 `path/startLine/endLine`，点开按行渲染并高亮命中行 | `routes/index.ts`（`/assets/:id/search`）、`KbDetail.tsx`、`ChatView.tsx` |
| P0-3 | 工具失败仍显示"已自动放行" | **已修**：卡片状态由真实执行结果驱动（`已执行 / 已拦截 / 待审批 / 失败`） | `conversation.ts` + `config/tools.ts` 单一事实来源 |
| P0-4 | kb_search 被 DB 凭据错绑 | **已修**：工具→资产→凭据三级显式登记，kb 工具不再要求 DB 凭据 | `config/tools.ts`（`TOOL_REGISTRY`） |

### 10.2 P1（10 条，全部关闭）

| # | 原问题 | 现状 | 验证 |
|---|---|---|---|
| P1-1 | 默认 SQL 用 PG 语法必然报错 | **已修**：默认语句改为 SQLite 语法，且语法错误与安全拦截返回不同错误码（`E_SQL_SYNTAX` 400 / `E_SQL_REJECTED` 422） | 冒烟 D/E 段 |
| P1-2 | 终端多会话 cwd 隔离失效 | **已修**：内置命令落本会话 cwd | 冒烟 G 段 |
| P1-3 | 组织两条硬约束缺失 | **已修**：删最后一个管理员 409 `E_LAST_ADMIN`；删成员必须指定接收人，`transferredAssets` 返回真实计数 | 冒烟 I 段 |
| P1-4 | 右栏 3 Tab 永远 c-gmv | **已修**：装配层按 `activeConversationId` 重拉，丢弃结果的分支删除 | 手动 + 冒烟 |
| P1-5 | 切工作区不加载会话 | **已修**：`hydrateFromRest` 用 `bootstrap.currentConversationId`，不再写死 `c-gmv` | 冒烟 B 段 |
| P1-6 | 文件夹只做了折叠 | **已修**：新建 / 重命名 / 删除 / 移动 / 新建子文件夹 / 折叠落库全部走真实 API；服务端强制 `depth ≤ 2`；删除时子目录与条目**上提到父级**而非级联删除 | 冒烟 O 段（10 例） |
| P1-7 | 资产接入向导缺失 | **已修**：4 步向导（类型 → 基本信息 → 连接参数 → 确认），创建后 `GET /assets/:id` 回读校验；新资产 `status='idle'`、`index_progress=0`、`credential_bound=0`，**不谎报 online/100%** | 冒烟 O 段 |
| P1-8 | 知识库详情页缺失 | **已修**：新增 `detail-kb` 视图，文档清单来自 `index_chunk` 真实统计 + 磁盘行数，原文按行渲染、命中行高亮可滚动 | 冒烟 O 段 |
| P1-9 | 审批卡不可达 | **已修**：`risk==='high' ‖ cap.approval==='ask'` → `ask`（`executable=false`）；裁决写 `approval.decide` 审计、重复裁决 409 `E_ALREADY_RESOLVED`、响应明确 `executed:false / diskChanged:false` | 冒烟 P 段（8 例） |
| P1-10 | 用量/费用是假数 | **已修**：直连分支请求 `stream_options.include_usage` 并解析 `chunk.usage`；无单价时 `costCny` 恒 0；结论置信度未提供时显示"未提供"而非编造 `0.90` | 冒烟 P 段 |

### 10.3 P2（15 条，13 条关闭 / 2 条降级说明）

| # | 原问题 | 现状 |
|---|---|---|
| 1 | 计划卡未渲染 | **已修**：`plan` 渲染为独立计划卡（步骤列表 + 当前步） |
| 2 | 产物展开是全局布尔 | **已修**：改按 `message.id` 记录；内联预览改为诚实文案（沙箱不渲染二进制） |
| 3 | 状态栏 / SQL 结果条恒为假数 | **已修**：全部来自 `/status-bar` 与真实执行结果 |
| 4 | 审计筛选只做前端分类 | **已修**：分类下沉服务端（`auditCategoryCondition`），**兜底桶"其他"用排除法**、分页下沉 SQL、导出复用同一条件并回报 `exported/total` |
| 5 | 策略影响面用种子文案 | **已修**：`/org/policies` 与 `/org/policies/impact` 共用 `orgImpactCounts()` 实时计数（实测 38 名成员 / 14 个资产 / 4 个 prod，替换原假的 12/7/3） |
| 6 | 无深色模式 | **已修**：`[data-theme="dark"]` 独立配色（非反色）+ 跟随系统实时切换 + 偏好落 localStorage；设置页「主题」下拉真正生效 |
| 7 | 左右栏宽度不可拖拽 | **已修**：`usePanelWidth` + 6px 手柄，左 180~260 / 右 260~420，双击复位，宽度落 localStorage |
| 8 | 设置/用户中心多为骨架 | **部分修复**：「清除数据」改为真实 `POST /maintenance/clear-cache`（只删上下文快照与用量，会话/产物/审计/索引保留并写审计）；「检查更新」改为真实比对前后端版本；「删除账号 / 全部退出」**改为说明型弹窗**——没有账号服务时给"确认删除"按钮本身就是骗人 |
| 9 | 空状态缺失 | **已修**：右栏四类空状态（无挂载资产 / 无检索命中 / 无执行步骤 / 无产物）+ 侧栏无资产 / 无会话，均给出下一步动作 |
| 10 | 会话条目 `⋯` 无菜单 | **已修**：行内菜单（重命名 / 移动 / 删除），`fixed` 定位避免被滚动容器裁切 |
| 11 | 不支持 Markdown / 代码块 | **已修**：自研轻量 Markdown（围栏代码块 / 标题 / 有序无序列表 / 引用 / 行内 `code` 与 **加粗**），全程 React 文本节点不渲染 raw HTML；新增 `npm run test:md`（8 例） |
| 12 | `newConversation` 硬编码 w-ops | **已修**：取当前 `workspaceId` |
| 13 | 文件树按文件名匹配 | **已修**：节点改 `path`，`/files/tree` 支持 `path` 参数，递归加 `TREE_MAX_DEPTH=8 / TREE_MAX_ENTRIES=2000` |
| 14 | SQL Guard 误杀 `REPLACE` | **已修**：函数名不计入禁用词判定 |
| 15 | 冒烟测试污染运行库 | **已修**：`DEVWORK_DATA_DIR / DEVWORK_SANDBOX_DIR / DEVWORK_PORT` 环境变量隔离，`npm run test:smoke` 起临时实例（端口 3011），测试后保留目录并打印路径 |

**未完全闭合的两项，如实标注：**

- **P2-8 的「删除账号 / 全部退出」**：没有账号服务就不存在可删除的云端账号，也没有"其它设备"。当前实现是**说明型弹窗**（讲清为什么不可用、能做什么替代），而不是假确认框 → 假 toast。要做真功能必须先有账号后端，属独立项目。
- **P2-9 的「索引中 / 资产离线」状态**：索引进度已有（`index_progress` + 重建按钮），但"资产离线"需要真实连通性探测，沙箱内不伪造探测结果，因此未加。

### 10.4 代码级缺陷（13 条）

| # | 缺陷 | 现状 |
|---|---|---|
| 1 | `hydrateFromRest` 会话键写死 `c-gmv` | 已修 |
| 2 | 右栏请求结果被丢弃 | 已修（删除重复请求，统一由装配层负责） |
| 3 | `usage_stat` 先 UPDATE 后判存在 | 已修（先 SELECT 再 UPDATE/INSERT） |
| 4 | 工具状态与结果脱钩 | 已修 |
| 5 | `serviceCheck` 写死资产与角色 | 已修（传真实 identity + 工具所属 assetId） |
| 6 | `respondApproval` 不执行不校验归属 | 已修（校验 `kind`/会话归属，写审计，标 `resolved`） |
| 7 | `builtinDispatch` 用 `REPO_ROOT` | 已修（落会话 cwd） |
| 8 | `sanitizedEnv` 白名单逻辑是死代码 | 已修（删掉空转的遍历块，明确"白名单即过滤"） |
| 9 | `ensureSession` 上限判断 TOCTOU | 已修（`tx()` 事务 + 条件 INSERT 双重兜底） |
| 10 | `E_SQL_REJECTED` 一码多用 | 已修（拆出 `E_SQL_SYNTAX`） |
| 11 | `isWriteAction` 用词元正则 | 已修（改显式登记表 `TOOL_REGISTRY`） |
| 12 | `fileTree` 递归无上限 | 已修（深度 8 / 条目 2000） |
| 13 | `sql/schema` 忽略 assetId | 已修（校验资产存在 + 类型；非 db 资产 422 `E_ASSET_NOT_DB`；响应带 `dbLabel / sharedWith` 说明沙箱共用演示库） |

### 10.5 修复过程中新发现的问题（原报告未覆盖）

1. **错误码未登记 → 一律 500**：`E_ASSET_NOT_DB`、`E_GIT_UNAVAILABLE` 不在 `ERROR_STATUS` 映射里，`ApiFailure` 被兜底成 500。已补映射（422 / 503），并留了 `comm` 对比脚本核对"使用但未映射"的码。
2. **审计分类的兜底桶恒空**：按前缀查"其他"等价于 `1=0`，用户筛"其他"永远是空列表。改为排除法。
3. **审计 `total` 是截断后的行数**：`LIMIT 500` 之后 `total = rows.length`，超过 500 条时页码在说谎，且前端 `slice` 翻到第 26 页起恒空。改为 SQL 层 `COUNT(*)` + `LIMIT/OFFSET`。
4. **导出口径与筛选不一致**：`exported` 数了元信息行，出现"导出 206 条 / 共命中 205 条"。改为只数命中记录。
5. **Markdown 围栏代码块首尾多空行**：服务端按 `\n\n` 切段，围栏边界被当成代码空行。已修并补 8 条单元测试。
6. **`--gray-700` 变量不存在**：`.appr.sugg .txt code` 引用了未定义的灰阶，颜色静默失效。已改为已定义变量。

### 10.6 复现命令

```bash
cd devwork-app
npm run typecheck      # 前后端 tsc，0 error
npm run test:md        # Markdown 解析 8/8
npm run test:smoke     # 隔离实例 123/123（临时目录保留并打印路径）
npx vite build         # 产物构建
```

> 结论修订：原判断"演示态与真实态没有分界线"在当时成立；本轮修复的主线正是**把这条线画出来**——
> 不可用就明说不可用，未探测就不显示"在线"，没有单价就 `cost=0`，共用的库就在响应里写明共用。


