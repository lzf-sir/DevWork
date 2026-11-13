# DevWork 资产驱动的内置工具、Skill 工作流与权限边界设计

> 版本 v0.1 · 2026-11-13 · 状态：设计评审 Draft
> 定位：伴随 `devwork-design.md`（v0.1）第 2/3/6/8 章的「落地视图」——回答一个问题：
> **给定一个工作区里的资产集合，Agent 实际能看到什么工具、能跑哪些 Skill、权限边界画在哪。**

---

## 0. 先给结论：三条决定本章走向的判断

**判断一：工具不是写死的清单，是从资产「派生」出来的。**

Agent 看到的工具面 = `f(工作区资产集合 × 资产能力声明 × 任务阶段 × 信任级别)`。
静态全量工具清单有两个致命问题：工作区没有数据库资产时，模型会幻觉调用 `db.*` 并编造连接参数；权限判定与真实资产脱节——审批通过了，资产却被移除了。所以工具必须在**派生管线**里动态生成：资产增删、连接切换（测试↔生产）、任务阶段切换时都重算。

**判断二：权限边界跟着「能力」走，不跟着「资产」走，也不跟着「工具」走。**

工具是能力的皮，能力才是权限判定的原子。同一个 `db.query` 工具，落在测试库实例上 riskLevel=low，落在生产库实例上就是 high。如果把权限写在工具实现里，这个区分就做不了。资产实例化 Capability 时**同时实例化约束**（maxRows、timeout、env、readOnly），权限内核只认这套带约束的能力。

**判断三：Skill 是流程约束，不是能力来源——Skill 只能收窄权限，不能放大。**

Skill 的可用工具面 = `Skill 声明的工具白名单 ∩ 用户已授权能力集 ∩ 当前派生工具面`。
一个审查 Skill 即使 manifest 里写了 `exec`，如果用户没给工作区授 `exec.run` 能力，它也拿不到。方向只能往下收。这样 Skill 安装审查时只需要看它声明了什么，不需要担心它"偷偷"拿到别的东西——因为根本不存在"偷偷"的通道。

---

## 1. 派生链路总览

```
┌────────────┐  AssetAdapter   ┌──────────────────┐  ToolFactory   ┌──────────────────┐
│ Asset 实例  │ ──────────────► │ Capability 实例化  │ ──────────────► │ ToolDescriptor[] │
│ (含连接/凭据)│                 │ (能力 + 约束)      │                │ (裁剪后的工具面)   │
└────────────┘                 └──────────────────┘                └────────┬─────────┘
                                                                            │ 每次调用
                                                                            ▼
                                                                  ┌──────────────────┐
                                                                  │ Permission Kernel │
                                                                  │ 判定 → 注入凭据 →  │
                                                                  │ 执行 → 审计        │
                                                                  └──────────────────┘
```

| 步骤 | 触发时机 | 输入 | 输出 |
|---|---|---|---|
| ① 能力实例化 | 资产注册 / 连接变更 / 索引完成 | Asset + AssetConnection | Capability[]（带 constraints） |
| ② 工具派生 | 步骤①后 / 任务阶段切换 | Capability[] × 阶段 × trust_level | ToolDescriptor[]（喂给模型的工具面） |
| ③ 权限判定 | 每次工具调用 | tool_call(name, args) | Allow / Ask / Deny（沿 8.1 六步流程） |

**为什么分两步（②和③）而不是一步到位？** ②解决"模型不该看见的就不给"，省 token、降幻觉；③解决"看见了也不该调"的最后一道闸。两道闸职责不同，不能合并——合并后一旦派生逻辑有 bug 就直接漏到执行层。

---

## 2. 内置工具全景清单

风险级别沿用 8.2 的五级（safe / low / medium / high / critical）。V1 全局只读模式下，medium 及以上不进审批，直接转「建议模式」。

### 2.1 跨资产通用工具（workspace 级，不依赖具体资产）

| 工具 | 作用 | riskLevel | sideEffects | V1 | 关键约束 |
|---|---|---|---|---|---|
| `ws.list_assets` | 列出当前工作区资产与状态 | safe | read | ✅ | 只暴露 name/type/status，不暴露凭据 |
| `ws.get_asset_detail` | 资产详情（能力、索引状态、连接健康） | safe | read | ✅ | 凭据字段一律返回 `<ref>` 占位符 |
| `fs.read_file` | 读工作区内文件 | low | read | ✅ | pathPrefix 限工作区；敏感文件（`.env`、`*.pem`、`*secret*`）内容打码，只报告"存在敏感文件 X" |
| `fs.search_files` | 按文件名/glob 检索 | safe | read | ✅ | 同上过滤 |
| `search.global` | 跨资产混合检索（代码+文档+日志统一入口） | low | read | ✅ | 返回带资产来源标注，供 Citation 溯源 |
| `report.generate` | 生成报告/建议卡（进会话，不落盘） | safe | read | ✅ | V1 没有"写文件"这个动作，产出只进会话视图 |

> **为什么 `fs.read_file` 不叫 `code.read`？** 前者是通用文件访问（有敏感文件风险），后者是走代码索引的语义读取（走 AST/符号，天然过滤了二进制和敏感文件）。Skill 里应优先引导用 `code.read`，`fs.read_file` 是兜底。

### 2.2 codebase 资产 → 代码工具组

| 工具 | 作用 | riskLevel | sideEffects | V1 | 关键约束 |
|---|---|---|---|---|---|
| `code.search` | AST + 语义混合检索 | safe | read | ✅ | 返回片段 ≤50 行/条，总条数上限 |
| `code.read` | 经索引读文件/符号 | low | read | ✅ | 敏感文件过滤；大文件分页 |
| `symbol.lookup` | 定义/引用/继承跳转 | safe | read | ✅ | — |
| `diff.inspect` | 查看 diff（工作区变更 / 指定 commit） | low | read | ✅ | — |
| `git.history` / `git.blame` | 历史与归属 | low | read | ✅ | — |
| `code.edit` | 修改源文件 | — | write | ❌ V2 | medium（dev 工作区）/ high（prod）；必须 diff 预览 + 可回滚（git） |

### 2.3 database 资产 → 数据库工具组

| 工具 | 作用 | riskLevel | sideEffects | V1 | 关键约束 |
|---|---|---|---|---|---|
| `db.schema.read` | 读表结构/索引/注释 | low | read | ✅ | — |
| `db.query.read` | 执行只读查询 | low（prod 实例升级为 medium） | read | ✅ | 单语句（SQL 解析器校验，禁止 `;` 多语句）；maxRows（默认 200）；timeout（默认 5s）；语句含 `FOR UPDATE`/锁表 hints → Deny |
| `db.query.write` | DML | high | write | ❌ V2 | ask 每次确认；事务包裹；影响行数预估先行 |
| `db.ddl.execute` | DDL | critical | write | ❌ V3 | 默认 deny，需设置里显式开启 + 输入确认词 |

**生产库的额外硬约束（trust_level=prod 的工作区）：** 连接凭据必须是只读账号（AssetConnection 层校验，Agent 侧不可见）；`db.query.read` 的 maxRows/timeout 减半；连续 3 次查询超时自动熔断该资产 10 分钟。

### 2.4 server 资产 → 服务器工具组

| 工具 | 作用 | riskLevel | sideEffects | V1 | 关键约束 |
|---|---|---|---|---|---|
| `srv.status` | 服务/进程/端口/资源状态 | low | read | ✅ | — |
| `srv.log.tail` | 实时拉取日志尾部 | low | read | ✅ | 行数上限 + 时间窗 |
| `srv.file.read` | 读服务器文件（配置、日志） | low | read | ✅ | pathPrefix 白名单（如 `/var/log/<svc>/`）；含密钥的配置打码 |
| `srv.exec` | 执行命令 | — | exec | ❌ V2 | **意图导向**（`{action, target}` 走命令模板库，见判断四）；high（dev）/ critical（prod）；模板自带回滚步骤 |
| `srv.file.write` | 写服务器文件 | — | write | ❌ V2 | high；先备份原文件到 `<path>.bak-<ts>` |

### 2.5 knowledge 资产 → 知识库工具组

| 工具 | 作用 | riskLevel | sideEffects | V1 | 关键约束 |
|---|---|---|---|---|---|
| `kb.search` | 分块语义检索 | low | read | ✅ | — |
| `kb.read` | 读完整文档 | low | read | ✅ | 引用必须带出处（docId + 章节），否则视为幻觉 |

**风险点在数据流向而非工具本身：** 内部机密文档会进入模型上下文。对策：knowledge 资产带 `sensitivity` 标记，`confidential` 级文档默认不进派生工具面，需管理员显式开启；审计日志记录每次 kb 读取。

### 2.6 log 资产 → 日志工具组

| 工具 | 作用 | riskLevel | sideEffects | V1 | 关键约束 |
|---|---|---|---|---|---|
| `log.query` | 条件检索日志 | low | read | ✅ | 必须带时间窗（默认 ≤1h）；返回条数上限；超阈值强制走 aggregate |
| `log.tail` | 实时跟踪 | low | read | ✅ | — |
| `log.aggregate` | 分组聚合（count/distinct） | low | read | ✅ | 预聚合防全量扫描，是大数据量下的唯一入口 |

### 2.7 api 资产 → API 工具组（由 OpenAPI 动态生成）

| 工具 | 作用 | riskLevel | sideEffects | V1 | 关键约束 |
|---|---|---|---|---|---|
| `api.spec.read` | 读 OpenAPI 规范、列 endpoints | safe | read | ✅ | — |
| `api.call.read` | 调 GET/HEAD/类只读接口 | low | network | ✅ | OpenAPI 标注了 sideEffects 的接口被排除；超时与重试上限 |
| `api.call.write` | 调 POST/PUT/DELETE 等副作用接口 | — | network | ❌ V2 | high；ask 每次确认；展示目标 URL + 请求体 |

> OpenAPI 的 operationId 直接映射为工具名（`api__createOrder`），schema 直接映射 inputSchema——这是"派生"思想最纯粹的体现：**没有人为 API 资产写工具，工具从规范里长出来。**

### 2.8 mcp 资产 → 第三方工具组

MCP 工具**不参与派生管线的能力收窄逻辑**——它们是第三方进程暴露的通道，信任模型完全不同（见判断三，原设计文档）。规则：

- 发现即注册，但默认 riskLevel=medium、approval=ask；
- 安装时人工审查工具清单，逐个标记 riskLevel；
- 命名强制加命名空间 `mcp__<server>__<tool>`，与内置工具冲突时内置优先；
- MCP 返回内容视为**不可信输入**（可能含提示注入），不直接进 system prompt。

---

## 3. 工具裁剪规则（派生管线的过滤条件）

继承 3.4 的三条规则，补充四条：

| # | 规则 | 说明 |
|---|---|---|
| 1 | 按资产裁剪 | 工作区没有该类型资产 → 对应工具组整组不进工具面 |
| 2 | 按阶段裁剪 | plan 阶段只给探查型（read/search/list）；execute 阶段才放开变更型。**先看清楚再动手** |
| 3 | 数量上限 ~30 | 超出做二级路由（先选组，再选工具） |
| 4 | 按信任级别剪枝 | trust_level=prod 的工作区：write/exec 组直接不进派生结果（不是 ask，是**不存在**），想开必须换工作区 |
| 5 | 敏感面打码 | `.env`、密钥、连接串在工具返回前统一打码；打码事件记审计 |
| 6 | 熔断降载 | 某资产连续超时/报错 → 该资产工具组临时移出工具面并告知模型，防循环重试烧预算 |
| 7 | Skill 收窄 | 进入 Skill 流程后，工具面 = Skill 白名单 ∩ 当前工具面（见 5.3） |

---

## 4. 预置 Skill 工作流

对应第 5 章五大场景 + 一个数据库场景。每个 Skill 给出：触发、依赖资产/能力（不满足则禁用）、阶段流程、工具白名单（相对当前工具面只收不放）、预算。

### 4.1 `bug-locator`（定位 Bug）

- **触发**：用户报障类意图（"报错"、"QPS 掉了"、"接口 500"）
- **requires**：assets ≥ `codebase`；可选 `log`、`database`（缺了不阻塞，降级流程提示信息不足）
- **阶段**：collect（症状澄清 + 拉日志）→ locate（日志→代码→数据三层收敛）→ verify（复现/证据链）→ report（结论 + 修复建议 patch，不自动应用）
- **工具白名单**：`log.query/aggregate`、`code.search/read/symbol.lookup`、`db.query.read`、`srv.log.tail`、`report.generate`
- **权限上限**：纯只读；产出是 patch 建议 + 命令建议（不执行）
- **budget**：60K tokens / 40 次工具调用

### 4.2 `cmd-advisor`（执行命令 → 命令顾问）

- **触发**：用户要求执行运维操作
- **requires**：assets ≥ `server`（无则纯建议模式）
- **阶段**：intent（澄清意图 + 影响面评估）→ draft（命令模板库匹配，给出命令 + 回滚命令）→ present（建议卡：命令、影响面、回滚，三选一按钮）
- **工具白名单**：`srv.status`、`srv.log.tail`、`srv.file.read`、`report.generate`；V2 追加 `srv.exec`（high）
- **设计要点**：V1 的核心产出是**带影响面分析的命令建议**，执行是人的决定。这是"意图导向"在产品层的落点。

### 4.3 `code-reviewer`（审查代码）

- **触发**："审查"、"review"、PR 关联
- **requires**：assets ≥ `codebase`
- **阶段**：scope（确定审查范围：diff/文件/PR）→ review（按 checklist 分维度过）→ report（分级问题清单：blocker/warning/nit，附代码位置）
- **工具白名单**：`code.search/read/symbol.lookup/diff.inspect/git.history`、`report.generate`
- **领域知识**：团队规范 checklist 放 `resources/checklist.md`，语言维度由 manifest 的 filePatterns 决定（如 `**/*.java` 走 Java 版清单）

### 4.4 `log-investigator`（排查日志）

- **触发**：日志排查类意图
- **requires**：assets ≥ `log`
- **阶段**：frame（时间窗 + 服务范围 + 关键词假设）→ query（先 aggregate 摸量，再 query 取样）→ correlate（跨服务/traceId 关联）→ report（时间线 + 根因假设）
- **工具白名单**：`log.query/tail/aggregate`、`srv.status`、`code.read`（对照代码位置）
- **防呆**：aggregate 先行是硬规则——直接全量 query 超阈值会被熔断，Skill 提示词里写明这个顺序，避免浪费工具调用次数

### 4.5 `doc-generator`（生成文档）

- **触发**："写文档"、"补 README"、接口文档
- **requires**：assets ≥ `codebase`；可选 `knowledge`
- **阶段**：collect（读代码 + 已有文档 + git 历史）→ draft（按模板生成）→ validate（校验器脚本核对：引用的接口/参数是否真实存在）→ present
- **工具白名单**：`code.read/search/symbol.lookup`、`kb.search/read`、`fs.read_file`、`report.generate`
- **特殊约束**：`resources/templates/` 提供文档模板；validator 必须存在——文档幻觉（写了不存在的接口）比代码幻觉更隐蔽

### 4.6 `sql-analyst`（慢查询/数据分析）

- **触发**："慢 SQL"、"这条 SQL 为什么慢"、"统计一下"
- **requires**：assets ≥ `database`
- **阶段**：read（读 schema + 执行计划 `EXPLAIN`）→ analyze（索引缺失/扫描量/关联膨胀）→ report（优化建议 + 建议 DDL **以文本产出，不执行**）
- **工具白名单**：`db.schema.read`、`db.query.read`（含 EXPLAIN）、`report.generate`
- **边界**：建议 DDL 属于 critical，V1 永远只是文本建议——由人拿去工单流程

### Skill 与资产的绑定校验

启用 Skill 时（SkillBinding），运行时校验：`manifest.requires.assets` ⊆ 工作区资产类型，且 `capabilities` ⊆ 派生能力集。不满足 → Skill 显示为「不可用（缺少 xx 资产）」而非隐藏——用户知道装了什么、为什么用不了，比静默消失体验好。

---

## 5. 权限边界汇总

### 5.1 总表：资产 × 能力 × V1 策略

| 资产 | 能力 | riskLevel | V1 策略 | V2+ 策略 |
|---|---|---|---|---|
| codebase | code.search / code.read / symbol.lookup | safe/low | auto | 不变 |
| codebase | code.edit（V2） | medium/high | — | dev: ask；prod: 不进派生 |
| database | schema.read / query.read | low（prod: medium） | auto | 不变 |
| database | query.write | high | — | ask 每次 |
| database | ddl.execute | critical | — | 默认 deny |
| server | status / log.tail / file.read | low | auto | 不变 |
| server | exec.run | high/critical | — | dev: ask；prod: critical 流程 |
| knowledge | doc.search / doc.read | low | auto（confidential 级需显式开启） | 不变 |
| log | log.query / tail / aggregate | low | auto | 不变 |
| api | spec.read / call.read | safe/low | auto | 不变 |
| api | call.write | high | — | ask 每次 |
| mcp | 第三方 tools | medium（人工标记） | ask | 逐工具标记后可调 |
| workspace | fs.read_file | low | auto（敏感文件打码） | 不变 |
| workspace | fs.write_file | medium | — | dev: ask 可记住 |

### 5.2 只读模式的压制规则（V1 全局生效）

```
readOnlyMode = true：
  safe / low            → 正常放行
  medium 及以上的能力    → 不进派生工具面（比 8.2 的"转建议模式"更彻底）
  Agent 的写意图         → 统一由 report.generate 产出「建议卡」（内容 + 为什么没执行）
```

### 5.3 Skill 的权限收窄公式

```
Skill 实际工具面 = Skill 白名单 ∩ 当前派生工具面 ∩ 已授权能力集
Skill 实际约束   = max(Skill 声明约束, 能力自带约束)     ← 约束取更严的那个
```

禁止"Skill 请求临时提权"。如果 Skill 流程确实需要更高能力（如 sql-analyst 要写库），正确做法是停下来产出建议卡，而不是弹审批——**Agent 主动发起的提权请求一律拒绝**（8.1 补充规则）。

### 5.4 Deny 之后 Agent 该做什么

这是实操里最容易做错的地方：被拒绝后反复换姿势重试，等于变相越权。统一降级路径：

1. Deny → 当步终止，不重试同一能力的变体调用（内核对连续 3 次 Deny 直接熔断本轮任务）；
2. 向用户说明：想做什么、被哪条策略挡了、差什么授权；
3. 有替代路径的走建议模式（产出可复制的内容）；
4. 全部记审计：越权尝试本身是有价值的信号（Skill 提示词质量差 or 真有恶意）。

---

## 6. V2 写能力层完整设计

> V1 用只读换信任，V2 把信任兑换成能力。这一章把前文所有标 V2 的项补成可开工的规格——**写能力的开放不是"解除限制"，而是换一套更重的执行管线**。

### 6.0 开闸判据：V2 不是时间表驱动的，是数据驱动的

V1 运行期间持续收集三个指标，全部达标才开 V2（按工具组分批开，不是一刀切）：

| 指标 | 定义 | 参考阈值 |
|---|---|---|
| 建议采纳率 | 建议卡内容被用户复制/手动执行的比例 | ≥ 60% 且样本 ≥ 500 |
| Deny 质量 | 越权尝试中"提示词缺陷"与"真实越权"的比例 | 后者 ≈ 0 |
| 熔断率 | 任务因连续 Deny/超时被熔断的比例 | ≤ 5% |

**为什么用采纳率当主判据？** 它同时检验三件事：Skill 提示词质量（建议是否切中要害）、影响面分析是否可信（用户敢不敢照做）、以及用户对 Agent 的信任水位。采纳率低就开写能力，等于让一个经常给错答案的人拿手术刀。

### 6.1 写能力的三层防线

写操作与读操作的根本差异：**读错了可以重查，写错了要回滚**。所以 V2 的执行管线在权限判定之外增加两道：

```
派生层：write/exec 工具组按 trust_level 进入工具面（prod 工作区仍然"不存在"）
   ↓
判定层：Capability approval 策略（ask / critical deny）——沿 8.1 六步流程
   ↓
执行层（V2 新增）：
   ├─ 预检：影响面评估 + 前置条件检查（模板自带 precheck）
   ├─ 执行：模板化执行（非裸命令）+ 事务/备份包裹
   └─ 事后：回滚就绪确认 + 结果校验 + 审计（含回滚路径）
```

**审批通过 ≠ 执行无条件放行**。precheck 失败（如目标服务已不在预期状态、影响行数超出预估 10 倍）时，即使审批已通过也要中止并重新审批——审批针对的是"意图"，precheck 针对"此刻的现实"，现实变了就必须重新确认。

### 6.2 各写工具的完整规格

| 工具 | riskLevel | 前置（precheck） | 执行包裹 | 回滚手段 | 回滚形态 |
|---|---|---|---|---|---|
| `code.edit` | medium（dev）/ high（prod，默认不派生） | 重新读取目标文件确认基线未变（防覆盖他人改动） | 编辑前自动 `git stash create` 快照 | git revert / 恢复快照 | **auto**（一键回滚按钮，10 分钟内有效） |
| `db.query.write` | high | `EXPLAIN` 影响行数预估 + 预估与用户确认值一致 | 显式事务包裹，执行后展示实际影响行数再 commit | 事务内反转 SQL（模板生成 UPDATE 回写） | ask（回滚 SQL 预览后执行） |
| `srv.exec` | high（dev）/ critical（prod） | 模板自带 precheck（服务状态、磁盘、连接数） | 模板执行器（见 6.3），非裸 shell | 模板自带 rollback 命令 | ask（回滚命令预览） |
| `srv.file.write` | high | 目录存在、磁盘余量、文件归属服务确认 | 先备份 `<path>.bak-<ts>` | 恢复备份文件 | auto |
| `api.call.write` | high | 幂等性检查（OpenAPI 标注）、重复调用检测 | 幂等键注入（接口支持时） | 视接口而定，无通用回滚 → **卡片上必须明示"此操作不可回滚"** | 无（靠确认前置） |
| `fs.write_file` | medium（仅 dev 工作区） | 路径在 pathPrefix 内 | 原内容快照 | 恢复快照 | auto |

### 6.3 意图导向命令模板库（判断四的落地规格）

`srv.exec` 是整个 V2 里风险最高的工具，它没有"事务"可依赖，唯一的安全阀是**模板化**：Agent 不吐 shell，吐意图。

**模板 schema：**

```jsonc
{
  "id": "restart-service",
  "version": "1.3.0",
  "intent": "重启指定服务",
  "match": { "action": "restart_service", "targetType": "service" },
  "params": {
    "service": { "type": "enum", "enumFromAsset": "server.services" },  // 参数从资产状态取值，不接受自由文本
    "graceSec": { "type": "int", "default": 10, "max": 60 }
  },
  "precheck": [
    { "cmd": "systemctl is-active {{service}}", "expect": "active" },
    { "cmd": "ss -tln | grep {{service}}", "expectNote": "记录当前连接数，写入审计" }
  ],
  "exec": "systemctl restart {{service}}",
  "verify": { "cmd": "systemctl is-active {{service}}", "expect": "active", "timeoutSec": 30 },
  "rollback": "systemctl start {{service}}",
  "risk": { "level": "high", "impact": "中断当前活跃连接，上游重试可覆盖 <10s" }
}
```

**三个硬规则：**

1. **参数白名单化**：`service` 的合法值从资产实时状态取（`enumFromAsset`），模型只能选不能造——杜绝"模型幻觉出一个服务名然后 restart 了别的东西"。
2. **无模板 = 拒绝执行**：意图匹配不到模板（相似度阈值以下）时，不 fallback 到裸 shell，直接转建议模式。模板库覆盖不到的操作，就是产品明确不支持的操作。
3. **模板即治理单元**：模板版本化、变更走评审（谁有权新增：管理员；模板变更记审计并通知使用过该模板的成员）。

**模板库冷启动**：V1 期间建议卡被采纳的命令分布，就是模板需求清单——按采纳频次排优先级，高频操作先做成模板。这是"只读半年"换来的第二样资产（第一样是信任数据）。

### 6.4 审批卡 V2 完整规格

结构沿用 8.2 的卡片骨架，补齐行为语义：

| 元素 | 规格 |
|---|---|
| 必含字段 | 操作（意图化描述）、目标资产+环境、实际将执行的命令/SQL/diff、影响面（precheck 产出）、回滚手段、超时倒计时 |
| 超时 | 5 分钟无响应 = 自动 Deny（记审计），Agent 转建议模式继续 |
| 「仅本次允许」 | 授权一次调用，不记忆 |
| 「本会话内允许此类操作」 | 记忆键 = `intent + targetType + riskLevel` 三元组，**不含具体参数**（restart order-api 记住了，restart payment-api 不继承）；会话结束即失效，不落盘 |
| 卡片上的 diff | code.edit 展示统一 diff；db.query.write 展示 SQL + 预估影响行数；srv.exec 展示命令 + precheck 实测值 |
| 不可回滚的操作 | 卡片顶部红色横幅明示，且不提供「本会话内允许」按钮（每次都问） |

**为什么「本会话内允许」不含具体参数？** 因为烦的来源是"同一类操作反复问"，而危险的来源是"不同目标被一视同仁"。按类记住、按实例拦截，正好把两边都压住。

### 6.5 V2 权限边界总表（相对 V1 的全部变化）

| 维度 | V1 | V2 |
|---|---|---|
| 派生管线 | write/exec 组不进工具面 | dev 工作区按 6.2 表派生；prod 工作区 write/exec 组**仍然不存在** |
| 审批策略 | 全部转建议卡 | safe/low auto；medium ask（可记会话）；high ask（每次）；critical 默认 deny |
| 只读开关 | 全局默认开 | 保留，变为**按工作区**的管控开关（生产工作区永久锁定开） |
| Skill 权限 | 白名单 ∩ 只读面 | 白名单 ∩ V2 工具面——Skill 仍只收窄，但各 Skill 解锁升级（见 6.6） |
| Deny 降级 | 建议模式 | 不变：Deny 后同样走 5.4 降级路径，写场景下的"建议模式"内容物变成 diff/SQL 文本 |
| 审计 | 记录调用 | 额外记录：审批人、审批耗时、precheck 实测值、执行结果、回滚是否就绪 |

### 6.6 Skill 在 V2 的能力升级

| Skill | V1 产出 | V2 升级 | 仍然禁止 |
|---|---|---|---|
| cmd-advisor | 命令建议卡 | 命令可走审批卡执行（仅限模板库覆盖的意图） | 模板外的裸命令 |
| bug-locator | patch 建议卡 | patch 可申请应用（`code.edit` 走审批，自动验证 git 状态） | 自动应用、直接 commit/push |
| sql-analyst | 优化建议 + DDL 文本 | `db.query.write` 可申请执行（如加索引前的验证性写入）；DDL 仍 critical | DDL 自动执行 |
| doc-generator | 文档产出进会话 | 可写文件到工作区（`fs.write_file`，medium） | 覆盖已有文档（改为产出 diff 建议卡） |
| log-investigator / code-reviewer | 纯只读 | 无升级（本来就该只读） | — |

**M3 可预置的新 Skill**：`deploy-assistant`（staging 部署，high，整合 srv.exec 模板 + api.call.write），作为 V2 管线成熟度的验收场景——它串起了审批卡、模板执行、回滚三层。

### 6.7 分阶段开闸（M3 细化）

| 阶段 | 开放内容 | 数据门槛 |
|---|---|---|
| V2.0 | dev 工作区：fs.write_file、srv.exec（模板库首批 10 个高频模板） | V1 指标全达标 |
| V2.1 | code.edit + bug-locator 的 patch 应用；db.query.write（仅 dev/test 库） | V2.0 运行 4 周，回滚使用率与事故率达标 |
| V2.2 | api.call.write、deploy-assistant、staging 环境写操作 | V2.1 无 P0 事故 |
| prod | 永远停在 critical：默认 deny，逐能力显式开启 + 确认词 | 不设自动开闸 |

---

## 7. 落地优先级映射

| 里程碑 | 本设计涉及内容 |
|---|---|
| M0（只读主干） | 通用工具组 + codebase/log/knowledge 工具组；派生管线①②；只读压制；bug-locator / code-reviewer / doc-generator 三个 Skill |
| M1（只读做深） | database/server/api 工具组；cmd-advisor / log-investigator / sql-analyst；敏感打码 + 熔断；Skill-资产绑定校验 |
| M2（生态） | mcp 资产组的审查标记流程；Skill 市场化安装审查；审计导出 |
| M3（写能力） | 第 6 章全部内容：开闸判据 → V2.0/V2.1/V2.2 分阶段开放（6.7）；三层防线执行管线（6.1）；六个写工具规格（6.2）；命令模板库（6.3）；审批卡完整规格（6.4） |

---

## 结语：三个值得在评审上追问的问题

1. **派生管线的重算成本**：资产增删触发全量重算够快吗？还是需要增量？工具面缓存失效的粒度是什么？
2. **"建议卡"的信息密度**（已决策，2026-11-13）：**不做**"一键在终端里跑这条（仍记审计）"的折中入口。建议卡保持纯复制路径，复制后的执行脱离审计是**接受的已知取舍**——理由：折中入口等于产品替用户执行命令，与"只读约束的对象是 Agent 不是用户"的边界冲突；用户自己粘贴执行，责任在人。cmd-advisor 的价值只到"给出带影响面分析的命令"为止。
3. **MCP 工具的人工标记会不会没人做**：默认全 ask 是安全但烦，烦的终点是全放行。是否引入按 MCP server 的信任评级（自研 > 官方认证 > 社区）来批量定级？
