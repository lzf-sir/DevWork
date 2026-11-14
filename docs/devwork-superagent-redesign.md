# DevWork Super-agent 重构设计

> 参考对象：DeepSeek Harness 团队 2026-10-31 开源的 `dsh-superagent-prototype`（MIT）及其
> 《Super-agent 设计探索》。本文只借它的**结构**，不借它的**安全姿态**——它面向"一个 GitHub
> 仓库 + 操作者自己的 OS 账号"，DevWork 面向"生产库 + 生产服务器"，红线不同。
>
> 现状基线见 `devwork-architecture.md`；本文承接 `devwork-design.md` §3 的任务编排章节。

---

## 0. 五条判断（先给结论）

| # | 判断 | 直接影响 |
|---|---|---|
| 1 | **瓶颈不是模型，是你的注意力。** 单任务上限由模型决定，多任务上限由"人能盯几个会话"决定（3~5 个就滑）。 | 优化目标从"通过率"改成"每张工单打扰人几次" |
| 2 | **要换的是执行单元，不是模型。** `conversation` 现在既是通道又是执行单元，所以一个会话同时只能干一件事。 | 新增 `ticket` 作为执行单元，`conversation` 降级为 Channel |
| 3 | **Router 必须无手。** 给它写工具，它一定会亲自干活，路由就退化成"一个更慢的单会话"。 | Router 工具面只有 4 个决策动作，无 shell、无写、无文件读 |
| 4 | **权限跟工单走，不跟对话走。** 授权一次定死，后续讨论只送上下文不送权限，堵死"聊着聊着范围就变大"。 | 新原语 `Mandate`；现有 `permission.check` 原样保留为每动作闸门 |
| 5 | **不要引入 Redis / BullMQ。** 这套架构的灵魂是"评估无状态"，而 SQLite 表 + 定时 tick 天然无状态。 | 不新增中间件，重启即恢复 |

一句话概括这次重构：**把执行单元从「会话」换成「工单」，把调度从「用户下一句」换成「事件循环」。**

---

## 1. 现状诊断：为什么现在的 Agent 到顶了

现在 `sendMessage()` 是一个**同步事务**：一次提问 → 建网关 → 循环 `gateway.generate()` →
逐事件落库（message / tool_call / citation / artifact）→ 写面板快照 → 返回。这条链路本身写得
很干净（审计闭环、写操作三层防线、反幻觉三条），但它把三件事焊死在一起：

| 焊死的地方 | 代码位置 | 后果 |
|---|---|---|
| 一轮 = 一个 `await` 到底 | `services/conversation.ts:276` | 任务必须在这个 HTTP 请求的生命周期里跑完。切页面、关窗口、跑 20 分钟 = 断 |
| 会话 = 执行单元 | `conversation` 表 + `buildHistory()` 只读本会话 | 一个会话同时只能推进一件事；两个不相干任务放进同一会话，上下文互相污染 |
| 审批卡 = 会话流里的消息 | `insertCard(kind:'approval_card')` | 3 个会话并行就有 3 张卡沉在历史里，没人知道哪张还悬着（`pendingApprovals` 只是右栏一个快照数组） |
| 只能人发起 | 无 trigger 概念 | 慢查询、CI 失败、日志报错、定时巡检，全都得人先看到再说 |
| 无租约 | 无 assignment / heartbeat | 进程重启后"正在执行"的工单变成幽灵，没人知道它断在哪 |
| Mock 模板冒充路由 | `TEMPLATES` + `detectIntent()` 正则 | 没配模型时，正则决定"意图"，界面看起来像在思考——这是最贵的一种假象 |

**注意**：这五条不是代码质量问题，是**结构**问题。在 `sendMessage` 里加 `setInterval`、
加 `Promise` 池，只会得到一堆互相踩上下文的半成品。所以要动的是领域模型。

---

## 2. 借鉴 / 不借鉴

| 它的做法 | 抄不抄 | 理由 |
|---|---|---|
| Router + Worker 双层，Router 不做具体活 | ✅ 抄 | 这是整套设计的支点 |
| 七原语（Source/Trigger/Thread/Eval/Mandate/Ticket/Assignment/Subscription） | ✅ 抄，改造后落地 | 概念少，且每个都对应一个真实的失效模式 |
| 评估无状态（不存队列、不存定时器） | ✅ 抄 | 重启安全；本项目是单机 SQLite，天然契合 |
| 两层评估：Gate（程序规则）+ Assessment（模型语义） | ✅ 抄 | 300 条消息约 20 条是真活，Gate 省的就是那 280 次模型调用 |
| 授权不可变，越界回传 | ✅ 抄 | 直接堵死"对话漂移" |
| 订阅扇出：送上下文不提权 | ✅ 抄 | 这是"工单能持续跟进"的关键，也是提权漏洞的堵点 |
| 注意力预算：结构化提问 + 每工单每小时上限 | ✅ **最该抄的一条** | 成本最低、收益最高；可脱离其余架构单独上线 |
| 三档准入 off / observe / auto，默认 observe | ✅ 抄 | `observe` = 影子模式，让我们能零风险验证 Gate 噪音 |
| 策略变更投递通知而非直接 kill | ✅ 抄 | 直接 kill 会留下半成品目录和未提交修改 |
| Worker 在 `git worktree` 里，5 秒转后台，30 分钟硬杀 | ⚠️ 改造 | worktree 只对 git 资产有意义；SQL / 服务器资产要各自的隔离面 |
| **Worker 以操作者 OS 身份无审批执行 shell** | ❌ **不抄** | DevWork 的工具面直连生产库和生产服务器。这条一抄，现有三层防线全废 |
| 单仓库、GitHub/飞书绑定 | ❌ 不抄 | DevWork 是"工作区 × 资产"，源要多得多 |
| 用正则/模板扮演"意图识别" | ❌ 加固 | 无模型就如实 `unavailable`，不许假装判断 |

**一句话**：抄它的调度骨架，保留我们的安全骨骼。

---

## 3. 领域模型（DevWork 版）

```
用户消息 ─┐
终端命令结束 ─┤
日志阈值 ─┼──► Source ──► Trigger（不可变） ──► Thread（按线程聚线）
git 变更 ─┤                                        │
SQL 慢查询 ─┤                            ┌──────────┴──────────┐
定时巡检 ─┘                              ▼                     ▼
                                   Gate（程序规则）      Subscription 扇出
                                         │                     │
                                         ▼                     ▼
                                   Assessment（模型）    ──► Ticket（已有工单，只送上下文）
                                         │                     ▲
                                         ▼                     │
                                    Decision ──accept──► Ticket + Mandate
                                         │                     │
                                    ignore/stop                ▼
                                                          Assignment
                                                               │
                                                               ▼
                                                       Worker（会话 + 隔离目录）
                                                               │
                                                               └──► Channel（回写到来源）
```

### 3.1 八个概念，各自的"不许"

| 概念 | DevWork 实现 | 不许（不变量） |
|---|---|---|
| **Source** 事件源 | `source` 表：`user` / `terminal` / `git` / `sql` / `log` / `schedule` / `ci` | 必须持有读位点（`read_position`），重启不许重放 |
| **Trigger** 触发 | `trigger` 表一行，`(source_id, idem_key)` 唯一 | 不可变；同一事件接两次只生成一张工单 |
| **Thread** 线程 | `thread` 表，键 = 源内稳定键（`issue#12` / `app.log` / `conv-xxx`） | 同一线程同时只允许一个 Eval 在跑，其余合并进下一批 |
| **Eval** 评估 | `gate()` + `assess()`，输入批次 + 线程快照 + 活跃工单列表 + 当前策略 | **不持有任何内存状态**；不许自己排定时器（要等就新增一个 Source） |
| **Decision** 决定 | `decision` 表，`accept/attach/stop/ignore/unavailable` | 只有 Eval 能写；Worker 不许宣布"用户让我停" |
| **Mandate** 授权 | `mandate` 表，绑在 ticket 上 | 不可变；要更大范围 = 开新工单；只有"人叫停"或"复核失败"能让它失效 |
| **Ticket** 工单 | `ticket` 表，`open → ended`，自带 8 个 stage | 只有 Eval 能创建；状态不跟随 Worker 会话（Worker 可换、可重派） |
| **Assignment** 派工 | `assignment` 表，ticket × worker 会话 × 目录 × 租约 | 一个工单可有多条派工历史；只有最后一条的报告能结单 |

外加一个**不单独建表**的关系：**Subscription**（`subscription` 表，多对多）。
它是"上下文扇出"通道——工单订阅它所在的线程，后续评论直接进 Worker，
**但权限不跟着涨**。越界的评论只能 `handBack()` 回 Router，不许自己升级。

### 3.2 状态机：从"会话状态"改成"工单 stage"

DeepWork 现有设计文档 §3.2 的 `IDLE/ROUTING/PLANNING/AWAIT_APPROVAL/...` 是**一个会话内的
推理状态**，它必须留在 Worker 里（那才是"当前这一步在干什么"）。工单对外只暴露 stage：

| stage | 条件 | 面板文案 | 是否等人 |
|---|---|---|---|
| `queued` | 无派工，或派工 pending | 排队中 | 否 |
| `working` | 其余 | 执行中 | 否 |
| `person/answer` | 有未回答的 attention | 等你回答 | ✅ |
| `person/review` | 最新报告 `ready` | 待你验收 | ✅ |
| `person/blocked` | 最新报告 `blocked` 且之后没有人的消息 | 受阻 | ✅ |
| `person/failed` | 最新报告 `failed`，或租约过期被回收 | 失败 | ✅ |
| `delivery` | 输入投递失败（指数退避重试中） | 投递中 | 否 |
| `idle` | 报告 `waiting`，或派工已 end | 等新事件 | 否 |

**规则**：从上往下第一个命中的生效。`person/*` 一律释放 worker slot——等人不占并发。
新的人工消息把 `blocked/failed` 拉回 `working`。

---

## 4. Router / Worker 双层

| 维度 | Router（主 Session，常驻） | Worker（每工单一个） |
|---|---|---|
| 生命周期 | 进程级，从启动跑到退出 | 工单级，`worker-<ticket>` |
| 职责 | 收事件、做决定、回复人 | 干活、交报告 |
| 工具面 | **只有 4 个**：`route_accept` / `route_attach` / `route_stop` / `route_ignore` | 现有派生工具面（只读）+ 写执行器（受 Mandate 约束） |
| 禁止 | 无 shell、无文件读、无写工具、无 SQL | 越过 Mandate 范围的动作为非法 |
| 模型档 | 便宜的（`deepseek-chat` / `glm-4-flash` / `qwen-turbo`） | 强的（用户选的档案） |
| 单次预算 | 一次评估 ≤ 4k token | 单工单 ≤ 80 步 / 可配 token 上限 |
| 产出 | 一条 Decision | 一条 Report（`progress/waiting/ready/blocked/failed/dropped`） |

**为什么 Router 不给 shell**：给了就一定自己上手。它的上下文里带着"这个任务很简单"的
判断，动手的诱惑无法用 prompt 压住。物理断手比写十句"不要自己动手"有效。

**Router 的 prompt 结构**（三段，每段都有明确输入）：
1. 策略段：启用的规则（每条一句话）+ 准入模式 + 当前源的白名单
2. 现场段：这批 Trigger + 线程快照 + 该线程上已有的工单（含已结束的）
3. 输出约束：一次可给多条决定；每条独立处理，一条被拒不阻塞其余

---

## 5. 授权：Mandate + Kernel 双闸

这是全文最需要评审的一节，因为它碰现有红线。

### 5.1 现有红线

`kernel/permission.ts` 的规则是：`actor=agent` 的写动作 → 高风险一律 `ask`（生成审批卡，不执行），
中低风险 `deny` 转建议。这条红线的初衷是"模型不能自己给自己授权"。

### 5.2 双闸怎么既保留红线又去掉卡洪水

```
Mandate（人给的，工单级，不可变）
   │  scope: { assets, paths, actions, riskCeiling, maxWrites }
   ▼
permission.check()（每个动作一次，原样保留）
   │  ├─ 动作 ⊄ Mandate.scope      → deny + handBack（不是 ask）
   │  ├─ 动作 ⊆ Mandate.scope      → allow（带 mandateId 入审计）
   │  └─ Mandate 复核失败 / 已撤销  → deny
   ▼
write-executor（precheck → 执行 → 校验 → 回滚就绪，一行不改）
```

**关键论证**：审批从"每个动作一张卡"变成"每个工单一张授权"。人并没有少批一次——
他只是**在正确的时机批了正确的东西**：拿到的是一份范围声明（改哪个文件、跑哪条命令、
最多几次），而不是第 7 张写着 `code_edit src/x.ts` 的卡。

三条硬约束，缺一不可：
1. **Mandate 只能由人产生**（批准工单时），或被 `observe → auto` 显式切换后的规则产生；
   Eval 不能凭空签发。
2. **Mandate 是上限不是免死金牌**。`permission.check()` 仍是每个动作的闸门，
   `asset_capability`、`readOnlyMode`、`prod 策略`、凭据绑定照旧生效。
3. **越界不是 ask，是 handBack**。Worker 想要范围外的动作 → 结束本轮 → 把消息交回 Router
   → Router 决定 `attach` 到别的工单，还是 `accept` 一张新的。**绝不允许就地扩权**——
   这条是防"对话漂移"的唯一有效机制。

### 5.3 Mandate 字段

```ts
interface Mandate {
  ticketId: string;
  strength: 'explicit' | 'inferred';   // 人明确要求 / 规则推断出来的候选
  policyVersion: string;               // 依赖哪一版策略
  requester: string;                   // 谁要的（源内身份，不做跨源映射）
  scope: {
    assetIds: string[];                // 允许碰的资产
    paths: string[];                   // 允许写的路径前缀（代码类）
    actions: string[];                 // 允许的动作名（sql.query.read / terminal.exec ...）
    riskCeiling: 'low' | 'medium' | 'high';
    maxWrites: number;                 // 写动作总次数上限
  };
  matchedRules: string[];              // 命中的主动规则（auto 模式）
  attentionBudget: number;             // 每小时可提问次数，默认 1
  expiresAt?: string;
}
```

**resume 前必须复核（revalidate）**：源还在监听该线程、请求人仍在白名单、
`inferred` 的工单要求当前仍是 `auto` 且命中规则仍启用。复核失败 → 工单保持 ended，
消息回到 Eval。这条防的是"三天后回来接着干，但权限早变了"。

---

### 5.4 范围从哪来（P2 前置跑出来的第一个问题）

影子草案一上线就暴露：**绝大多数草案的 `assets` 是空的**，面板上写着「范围未定」，
而范围未定的草案不允许「认可」——因为批准一份空范围，等于批准「什么都能做」。

原因很具体：`conversation.asset_id` 默认是 NULL，只有从代码库 / 数据库页发起的会话才绑资产。
而人平时就是直接开个会话问一句。

三条可选解法，各带代价：

| 方案 | 做法 | 代价 |
|---|---|---|
| 会话强制绑资产 | 开聊前先选资产 | 打断「先问一句」的轻量用法，人会绕过它 |
| 工作区级授权 | `scope.assets` 换成 workspace + assetTypes 白名单 | 范围变大，审批的意义被稀释 |
| 触发时猜资产 | 从工具面 / 关键词推断 | 猜错就是**过度授权**，比「未定」更危险 |

**已按第二条落地（P1.7）：默认工作区级 + 命中具体资产时自动收窄。**

```
scope.level = 'asset'     事件挂到了具体资产 → 范围收窄到那一个
scope.level = 'workspace' 没挂资产 → 退到工作区级，但必须带 assetTypes 白名单
```

三条实现约束：

1. **工作区级没有 `assetTypes` 就拒签**。不带白名单的「工作区级」等于整个工作区任意资产，
   那不是「范围较宽」，是「没有范围」，只是穿了一件好看的外衣。
2. **两种粒度在面板上必须长得不一样**：`1 资产 · 3 动作` vs `工作区级 db/kb · 3 动作`。
   否则人分不清自己在批一个具体对象，还是在批一类对象。
3. **「范围不足」只留一个出口**：既没挂资产、规则也没给类型。这时不给「认可」按钮——
   批准一份无边界的范围，比拒绝它危险得多。

落地效果（同一批事件）：「范围未定」从常态（5/5）降到 0，粒度分布变成
`asset` 2 份 / `workspace` 3 份。**这才是 P2 能开工的状态**——范围不再算不出来，
只是宽窄不同，而宽窄是人一眼能看见的。

---

## 6. 注意力预算（最该先做的一块）

### 6.1 结构化提问，取代自由文本

现在的 `approval_card` 是"Agent 想做什么 + 原因 + 命令"，人得读三段才能判断。
新模型下，**提问是一个有 schema 的对象**：

```ts
interface Attention {
  ticketId: string;
  question: string;              // 一个具体问题，一句话
  options: { label: string; effect: string }[];  // 2~4 个选项，各带后果
  blocking: boolean;            // true = 工单停下等人
  impact: string;               // 影响面：改什么、能不能回滚
  askedAt: string;
}
```

规则（直接抄它的哲学）：
- **一次只问一个具体问题**，不给"你看下这个报告然后告诉我怎么办"。
- **能自己决定的绝不问**：低风险只读、范围内写、可回滚的试验，都不许问。
- **报结果要短**：确认收到一次（说清要干什么），干完再说一次。中间不说话。
- **按影响停，不按工作量停**：本地改动做到"可评审"为止；需要设计决策的，带一个问题停下。

### 6.2 硬上限

| 层级 | 默认 | 超了怎么办 |
|---|---|---|
| 单工单 / 小时 | 1 次（可配 1~3） | 不再提问，落 checkpoint，工单进 `idle` 等人来 |
| 全局 / 小时 | 4 次 | Router 只允许 `stop` 与 `ignore`，不许新开需要人的工单 |
| 同时待人 | 3 张 | 新工单排队，不许再产生 attention |

### 6.3 面板

右栏从 3 个 Tab 扩到 4 个，新增**「待人」**：只列 `person/*` 的工单，按等待时长排序，
每条一行 + 一个动作按钮。**健康的工单不出现在这里**——这是"少打扰"最直接的体现。

---

## 7. 执行与恢复

### 7.1 隔离面（按资产类型分开，不是一套 worktree）

| 资产类型 | 隔离方式 | 为什么 |
|---|---|---|
| `code`（git 仓库） | `git worktree` 到 `sandbox/tickets/<short>`，分支 `agent/<short>` | 直接抄它最成熟的一块 |
| `db` | 只读连接 + 每次写前生成回滚脚本（现有 `write-executor` 能力） | 数据库没有 worktree，回滚就绪就是隔离 |
| `server` | 现有 shell-gate + 命令白/黑名单，工单级临时放行集 | 命令级而不是目录级 |
| `kb` / `log` | 无隔离（只读） | 不产生副作用 |

`short` 用 ticket id 后 6 位 + 语义前缀（`fix-timeout-a3f9c1`），人能在目录里看懂。

### 7.2 后台与硬顶

- 前台命令 > **5 秒** → 自动转后台作业，Worker 继续处理新消息（抄）。
- 后台作业硬顶 **30 分钟**，到点杀进程，输出落审计，工单报 `waiting`（抄）。
- 一轮结束时仍有后台作业 → **保留 slot**，不报 waiting（抄）。这条容易被忽略，
  但它是"安装依赖 / 跑测试不阻塞收消息"能成立的前提。

### 7.3 并发与槽位

| 项 | 默认 | 说明 |
|---|---|---|
| worker slot | 2（可配 1~4） | 上限受 SQLite 单写锁约束，不要盲目调大 |
| 人工唤醒额外 slot | +1 | 保证"人想继续自己的工单"永远不被新任务挤掉（抄） |
| tick 间隔 | 800ms | 单机足够；批量评估要在同一 tick 内合并 |

### 7.4 崩溃恢复：租约

```ts
// 派工时
assignment.state = 'running'
assignment.lease_until = now + 90s
// worker 每完成一步
heartbeat(assignment.id)  // lease_until = now + 90s

// 启动时（index.ts，initDatabase 之后）
reapExpiredAssignments()  // running 且 lease_until < now → 标 failed
                          // → ticket 进 person/failed → 生成一条 attention
```

没有租约，"重启后谁在跑"这个问题只能靠猜。这是现有架构最大的隐蔽缺口。

### 7.5 策略变更：投递，不 kill

策略改了（规则变了 / 准入模式降级 / 请求人被移出白名单）：
- 不立即撤销活跃 Mandate，不 kill Worker（kill 会留下半成品目录和未提交修改）
- 给受影响的 assignment 投递一条 `policy_changed` Input，说清"哪条规则变了 / 你还能不能继续"
- 下轮 resume 时统一 revalidate

---

### 7.6 定时源：把时钟放进表里

主动源里最容易做错的是 `schedule`。用 `setInterval` 是最自然的写法，也是最坏的一种：
进程一重启，定时器就失忆——关一次软件，今天的巡检就没了。

所以它的状态和别的一样，**存表**：

```
source.next_fire_at   ← 下次到点（UTC 存，本地时区算）
每个 tick 检查一次     ← 到点则投递 Trigger + 推进 next_fire_at
```

四条规则，每条都在防一个具体的错：

| 规则 | 防的是什么 |
|---|---|
| 下次到点存 `source.next_fire_at` | 重启失忆：关了软件再开，本该跑的那次还得跑得到 |
| 错过多次只补一次 | 关机三天后开机，不该连着炸出三条巡检 |
| 手动「立即巡检」不推进排期 | 手动跑一次把明天的巡检挪走，是最难解释的那种 bug |
| 启用时重排、重启时补发 | 手动开关的语义是「从下一次开始」，进程重启的语义是「该跑的要跑」 |

还有一条边界必须守住：**定时器不是后门**。定时源投递的 Trigger 走的是完全一样的
`ingestTrigger → Gate → 规则匹配` 路径，身份是 `system`，所以它**只能产生 inferred 候选**，
一样要过频控、一样要在 `off` 模式下被挡掉。如果定时器能绕过准入，它就变成了"系统自己
给自己授权"的通道，整套 Mandate 设计从第一天就漏了。

实测里这条链路是自证的：默认提示语不命中任何规则 → `would_accept=0`；
把提示语改成「巡检：排查最近的超时与报错」→ 命中 `rule-incident` → `would_accept=1`。
**同一条定时任务，改一句话就从"会接"变成"不会接"** —— 这说明规则真的在起作用，
而不是"只要是定时的就都接"。

---

## 8. 数据模型

### 8.1 新增 8 张表

```sql
-- 事件源
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- user | terminal | git | sql | log | schedule | ci
  config TEXT NOT NULL DEFAULT '{}',        -- 监听什么（路径 / 阈值 / cron）
  enabled INTEGER NOT NULL DEFAULT 1,
  read_position TEXT NOT NULL DEFAULT '',   -- 恢复位点，重启不重放
  next_fire_at TEXT NOT NULL DEFAULT '',    -- 定时源的下次到点（本地时区算，存 UTC）
  last_seen_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, kind)
);

-- 线程（事件聚线）
CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  asset_id TEXT,
  thread_key TEXT NOT NULL,                 -- 源内稳定键
  title TEXT NOT NULL DEFAULT '',
  eval_running INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, thread_key)
);

-- 触发（不可变）
CREATE TABLE IF NOT EXISTS trigger (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES thread(id),
  source_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  actor_kind TEXT NOT NULL DEFAULT 'person',   -- person | bot | system
  addressed INTEGER NOT NULL DEFAULT 0,        -- 是否点名 Agent（决定 explicit / inferred）
  body TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  idem_key TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'pending', -- pending | fanned | evaluated | ignored | unavailable
  decision_id TEXT,
  received_at TEXT NOT NULL,
  UNIQUE(source_id, idem_key)
);

-- 决策
CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,                 -- 一条决策对应一条触发（P1 实测后补）
  kind TEXT NOT NULL,                       -- accept | attach | stop | ignore | unavailable
  strength TEXT NOT NULL,                   -- explicit | inferred
  would_accept INTEGER NOT NULL DEFAULT 0,  -- 影子期唯一有信息量的列（P1 实测后补）
  reason_code TEXT NOT NULL DEFAULT '',     -- 可聚合的原因码，如 E_THREAD_RATE_LIMIT
  reason TEXT NOT NULL DEFAULT '',          -- 人读的解释
  matched_rules TEXT NOT NULL DEFAULT '[]',
  policy_version TEXT NOT NULL DEFAULT '',
  ticket_id TEXT,
  eval_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 工单
CREATE TABLE IF NOT EXISTS ticket (
  id TEXT PRIMARY KEY,
  short_name TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',       -- open | ended
  stage TEXT NOT NULL DEFAULT 'queued',
  ended_reason TEXT NOT NULL DEFAULT '',    -- done | stopped_by_person | revoked
  conversation_id TEXT,                     -- 起源会话（Channel），可空
  created_at TEXT NOT NULL,
  ended_at TEXT
);

-- 授权（不可变）
CREATE TABLE IF NOT EXISTS mandate (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,                 -- 由哪条决策产生（影子期唯一入口）
  ticket_id TEXT,                            -- P2 才有值；影子期恒 NULL
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | accepted | narrowed | rejected
  strength TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  requester TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '{}',          -- {assets,assetTypes,actions,riskCeiling,maxWrites}
  matched_rules TEXT NOT NULL DEFAULT '[]',
  attention_budget INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',             -- 人的表态说明（收窄理由）
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

-- 派工（带租约）
CREATE TABLE IF NOT EXISTS assignment (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  worker_session TEXT NOT NULL,
  workdir TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',    -- pending | running | ended
  lease_until TEXT NOT NULL DEFAULT '',
  heartbeat_at TEXT NOT NULL DEFAULT '',
  report TEXT NOT NULL DEFAULT '',          -- progress | waiting | ready | blocked | failed | dropped
  report_note TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

-- 订阅（上下文扇出）
CREATE TABLE IF NOT EXISTS subscription (
  ticket_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'own',         -- own | context
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, thread_id)
);

-- 待人工决定
CREATE TABLE IF NOT EXISTS attention (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  impact TEXT NOT NULL DEFAULT '',
  blocking INTEGER NOT NULL DEFAULT 1,
  asked_at TEXT NOT NULL,
  answered_at TEXT,
  answer TEXT
);
```

### 8.2 现有表怎么动（只加列，不改语义）

| 表 | 变化 | 理由 |
|---|---|---|
| `conversation` | 语义降级为 Channel，加 `ticket_id`（可空） | 老数据零迁移；新工单也能开自己的会话窗口 |
| `message` | 加 `ticket_id`（可空） | 会话流里能聚合"这个会话派生出的所有工单事件" |
| `tool_call` | 加 `ticket_id`、`mandate_id` | 审计要能回答"这个动作凭哪份授权干的" |
| `audit_event` | 加 `ticket_id`（仍 append-only） | 黑匣子不能重写，只能扩列 |
| `session-approvals` | 升级为 `mandate` 的兼容层，保留旧表一个版本周期 | 回滚通道 |
| `usage_stat` | 加 `ticket_id` | 成本要能按工单归集（缓存读放大会是主要成本项） |

**新增表一律走 `schema.sql` + `CREATE TABLE IF NOT EXISTS`，加列走 `ensureColumn`**
（`index.ts` 已有的模式），不要写迁移脚本。

### 8.3 P1 落地现状（2026-11-13 夜 → 11-14 凌晨）

P1 只建了前四张表，后五张（`ticket` / `mandate` / `assignment` / `subscription` / `attention`）
留到 P2 —— 先建空表会诱导人写「没有语义的写入」，等真执行时再建反而更干净。

| 项 | 状态 | 落点 |
|---|---|---|
| `source` / `thread` / `trigger` / `decision` | ✅ 已建（含 4 个索引） | `backend/src/db/schema.sql` |
| Gate（七档判定，纯函数） | ✅ 已实现 | `backend/src/services/shadow-gate.ts` |
| tick（800ms，批量 20，线程锁 + 启动抹平） | ✅ 已实现 | `backend/src/services/shadow-scheduler.ts` |
| 事件 / 决策 / 草案 / 策略 / 统计 / 开关 / 定时触发 API（11 条） | ✅ 已实现 | `backend/src/routes/shadow.ts` |
| 写入契约 | ✅ 已实现 | `shared/contracts/shadow.ts` |
| 真人对话取料（P1.5） | ✅ 已接 | `conversation.ts` 里一行 `ingestUserTurn(...)`，fire-and-forget |
| 影子决策页（前端） | ✅ 已实现 | `frontend/src/views/ShadowView.tsx`（侧栏「影子决策」/ 命令面板） |
| 定时源（到点触发 / 补发只补一次 / 幂等） | ✅ 已实现 | `shadow-scheduler.ts` 的 `fireDueSchedules()` |
| 授权名单编辑（白名单 / 机器人 / 频控上限） | ✅ 已实现 | 影子决策页「白名单」行 |
| `mandate` 表 + 授权草案（decision → draft） | ✅ 已实现（P1.6 / P2 前置） | `shadow-scheduler.ts` 的 `createDraftMandate()` |
| 草案人审（认可 / 收窄 / 否决） | ✅ 已实现 | `reviewMandate()` + 面板「授权草案」 |
| 授权粒度 `level`（asset / workspace + 类型白名单） | ✅ 已实现（P1.7） | `buildMandateScope()` |
| 测试 | ✅ 81 项（含草案、人审、粒度） | `tests/shadow.mjs`（`npm run test:shadow`） |
| 定时源核心测试 | ✅ 14 项（进程内拨时钟） | `tests/shadow-core.ts`（`npm run test:shadow:core`） |
| 视觉验收 | ✅ 20 项 | `tests/shadow-visual.mjs`（`npm run test:shadow:visual`） |
| `ticket` / `assignment` / `subscription` / `attention` | ✅ 已建（P2） | `schema.sql` |
| Router / 派工 / Worker / 注意力 / 循环 | ✅ 已实现（P2） | `tickets.ts` / `worker-runtime.ts` / `agent-loop.ts` |
| 采集器（log / git / terminal / sql） | ✅ 已实现 | `shadow-collectors.ts` |
| 订阅扇出 | ✅ 已实现（P3） | `subscription.ts` |
| `auto` 签发（四道闸） | ✅ 已实现（P3） | `maybeAutoIssue()` |
| 总开关入设置 + 账本导出 | ✅ 已实现 | `PATCH /shadow/enabled` · `GET /shadow/export` |

对上面 DDL 的两处实测修正，已在 §8.1 同步：

- `decision` 增 `trigger_id`：一条决策必须能回答「研判的是哪条事件」，否则影子账本无法回放。
- `gate_reason` 拆成 `reason_code` + `reason`：统计要按原因码 GROUP BY（如「一天被频控挡掉多少」），
  原因码必须是可聚合的枚举值，不能和解释文本挤在一列。

**接真实负载后改掉的一条判定**（P1.5 的意外收获）：

频控原本对所有人一视同仁，接上真实对话才暴露问题——`threadKey = 会话 id`，
而一个会话会持续几小时，于是「一小时内只研判一次」等于把同一个会话的后续请求全挡掉，
`estimatedDailyAccept` 会系统性偏低。现已改为**只约束自动化事件**（机器人 / 系统）：
人在一小时里问五件事是五件事，不是噪音。日志源一报错几百条才是噪音，那才是频控该管的对象。

**留存**：账本保留 30 天（`pruneShadowLedger`，随 6h 清理一起跑）。P1.5 之后每条消息都落一行，
不设保留期就是让桌面端一年攒几十万行 —— 观测数据该有保质期。

**关停开关**：设置页那个开关与 `DEVWORK_SUPERAGENT=off` 等效（env 优先级更高，供运维止血）。

---

### 8.4 P2 落地现状（2026-11-14）

九张表全部建好，执行链路通了。真正跑起来的部分：

| 环节 | 实现 | 关键约束 |
|---|---|---|
| Router | `routeAcceptedDecisions()` | **只消费 accepted 的授权**：草案不建工单 |
| 工单 | `ticket` + `stage` 推导 | stage 由「报告 / 注意力 / 派工 / 授权」推导，不手工赋值 |
| 派工 | `dispatchQueued()` + 租约 | 并发上限 1~4；启动时回收过期租约 |
| 执行 | `runAssignment()` 单轮 | 工具面按 Mandate 裁剪；写操作仍走内核审批 |
| 注意力 | `askAttention()` 硬预算 | 每工单每小时 1 次，超了不打扰、落 checkpoint |
| 循环 | `agent-loop.ts` 1s | 研判 / 派单 / 执行 / 回收；关停只空转 |
| 采集 | log / git / terminal / sql | 位点存库，一轮最多一条；sql 读 `sql_trace`（埋点在 500ms，采集按 1500ms 筛） |
| 扇出 | `fanoutPendingTriggers()` | 只投 `would_accept=1`；Worker 收工前复查收件箱 |
| auto | `maybeAutoIssue()` | 只读自动签、写权限需显式放行、每小时预算、范围不足不签 |

**P2.5 隔离已落地（2026-11-14）**

```
工单目录   <sandbox>/tickets/<short>/
代码资产   git worktree → <工单目录>/<assetId>   分支 agent/<short>
执行期      AsyncLocalStorage 覆盖 resolveRepoRoot(assetId)
```

三条关键取舍：

| 决定 | 理由 |
|---|---|
| **只读工单不建工作树** | 只读不产生冲突，建树纯浪费；一旦 `maxWrites > 0` 才必须隔离 |
| **建不出隔离就 blocked** | 绝不降级成共享目录：两人抢同一工作区的后果是**静默覆盖** |
| **脏工作树不删** | `worktree remove --force` 会连改动一起删；有未提交改动就留着 |

为什么用 `AsyncLocalStorage` 而不是一路传参：工具执行链路有 5 层
（worker → gateway → executeTool → write-executor → file-service），
一路加参数一定会漏在某个忘记传的地方，而**漏一次等于没隔离**。

另外补了一条互斥：**写权限工单同时只跑一张**。工作树隔离了文件，
但「同时改同一条分支」的合并策略还没设计——没想清楚之前，串行是唯一诚实的做法。

### 8.5 P3 收口：扇出、auto、慢查询（2026-11-14）

上一节留的两条，加上原先跳过的 sql 源，这一轮全部落地。

**① 订阅扇出（`subscription.ts`）**

工单跟着线程走，而不是干完一件就断线。三步：

```
新事件 → Gate 判 would_accept？→ 否：打位点，不投
                              → 是：投给该线程的 open 工单 → 唤醒 idle / 让人验收前的 ready 回 queued
```

四条约束，每条防一个具体的坑：

| 约束 | 防的是什么 |
|---|---|
| 只投 `would_accept=1` | 被 Gate 拒掉的事件若也投给工单，就是绕过准入的侧门 |
| `fanout_at` 位点 | 没有它，「无工单可投」的事件每轮都被重扫一遍 |
| 排除自身起始事件 | 否则模型会以为人把同一句话说了两次 |
| Worker 收工前复查收件箱 | 一轮跑完就收工，期间到的消息全漏，且**不会报错** |

**为什么收工检查是必须的**：Worker 读完上下文就不再读了。只做「开头读收件箱」，
那跑的过程中插进来的消息就永远没人看。所以本轮 `started_at` 之后还有新投递时，
报告写 `waiting` 而不是 `ready` —— 继续处理，而不是把人叫来看一份已经过时的产出。

**② auto 模式（`maybeAutoIssue`）**

`acceptMode=auto` 现在真的会签发授权，但带四道闸：

| 闸 | 规则 | 理由 |
|---|---|---|
| ① 模式 | 只有 auto 才走 | observe 下永远是草案 |
| ② 写权限 | `maxWrites > 0` 默认**不签**，要显式开 `autoAllowWrites` | 只读签错是多查几次库；写签错是代码被改，两者不该享受同一默认值 |
| ③ 预算 | 每小时 ≤ `autoMaxPerHour`（默认 3，可设 0） | 一个刷屏的日志源能在一小时内签出几十张授权、建出几十张工单 |
| ④ 范围 | `scopeUndefined` 一律不签 | 批准一份无边界的范围，比拒绝它危险得多 |

**③ sql 采集器**

埋点在 `sql-query` 执行处（≥500ms 落一行 `sql_trace`），采集器再按阈值（默认 1500ms）筛。
两层阈值分开，是为了让「多慢算慢」可以事后调，不用改埋点重发版。
首次只记位点不投递 —— 与 git / terminal 一致，否则刚打开这个源就会把历史慢查询
当成「现在发生的事」报上来。

**仍然没有的**：多 Worker 并行（现在写权限工单互斥、串行执行）。
这不是遗漏，是顺序：并行要求合并策略先想清楚，而现在连一条写工单都还没被真实跑过。

---

### 8.6 前端配套：从「仪表盘」到「执行中心」（2026-11-14）

P1 时这一页只有一个问题——「它本来会接哪些单」，所以一屏拉到底正好。
P3 之后它同时是执行台和策略台，继续堆在一页的代价很具体：
**「有单在等人」被压在第 8 个面板下面**，而那是唯一需要立刻响应的东西。

**① 三分区：按「问题」切，不按「页面」切**

| 分区 | 回答的问题 | 内容 |
|---|---|---|
| 工单 | 它现在在干什么？我该做什么？ | 待人 → 在跑 → 已结束（不按时间倒序） |
| 准入 | 谁能让它干活、能动多大范围？ | 模式 / auto 刹车 / 白名单 / 源 / 规则范围 |
| 账本 | 它为什么接 / 为什么不接？ | 授权草案 / 决策表 / 原因分布 |

数据层 `useShadowData` 一次加载、三区共用：KPI 说「5 张待研判」而列表只有 3 张，
这种自相矛盾就是各自拉数据造成的。

**② 工单详情：一次请求给齐全部事实**

会话里记录的是「模型说了什么、调了什么」，而人判断一张单跑得对不对需要另一组事实：
第几轮、每轮多久、累计多少 token、哪轮失败过、授权范围是什么、期间收到过什么。
这些散在四张表里，服务端合成一次（`GET /tickets/:id`），前端不串接口 ——
串了之后时间线对不齐，人也看不出「第 3 轮开始变慢」。

详情返回**扁平化**（工单字段在顶层，附加字段在外层），旧调用方不受影响。

**③ 待办要能被看见，而不是被找到**

侧栏徽标直接显示待人数量（30s 拉一次）。「藏在页面里的待办等于没有待办」——
这个数字是主动型 Agent 的必要反馈，否则人根本不知道有事发生。

**④ auto 必须有水位**

开了 auto 之后人最先问的是「它这一个小时自己签了几张」。
只给总数不够：**预算是否用满，决定「没接单」是因为不该接还是因为被刹车挡住**。
准入区用格子显示 `已用 / 上限`，用满时明确提示「本小时剩余事件只产草案，等人批」。

**顺手修掉三处过时文案**（P3 之后它们全错了）：

| 位置 | 原文 | 现在 |
|---|---|---|
| 页脚 | 「这一页没有执行能力」 | 按分区说明它到底会不会动手 |
| 标题 | 「P1 · 只记录不执行」 | 「智能体」+ 三分区 |
| auto 提示 | 「P1 与 observe 等价；真接单在 P3」 | 「命中规则即签发授权并建单；只读自动签」 |

**⑤ 一个自己踩的坑**

`api/client.ts` 顶部有 `export type { } from './types'`，那是**再导出**，不产生本地绑定。
我一度把它当成 import 块，删了真正的 `import type` 行，结果 8 个类型全部报「找不到」。
「大块在上面」不等于「类型已引入」—— 这类错误只在编译期暴露，运行时一片正常。

### 8.7 会话层：多 tabs、上下文面板、协作流（2026-11-14）

§8.6 解决的是「它现在在干什么」；这一节解决的是**人同时盯好几件事时，
怎么在同一个窗口里不丢线索**。三个改动共用一条判断：
**并行度上来了，界面就必须能表达「哪条在跑、跑到第几步、哪步在等我」，
否则多开会话等于把状态藏起来。**

**① 会话窗口改成浏览器式 tabs**

| 决定 | 理由 |
|---|---|
| tab 只装会话，不装页面（详情页/设置页仍是单页切换） | 页面是「去哪」，会话是「盯谁」；混在一排会把两种语义搅在一起 |
| `sessionTabs`（开了哪些）+ `activeConversationId`（在看哪个）分离 | 所有读 active 的旧代码零改动就能工作，tab 只是加法 |
| 草稿 / @ 选中 / 待发附件按 conversationId 存**模块级缓存** | 进 store 会让每个按键触发全局重渲染，Markdown 长列表跟着重绘 |
| 流式文本进 store（`streams[conversationId]`） | 切走后还得知道「那条还在跑」——tab 上的蓝点就是它的投影 |
| AbortController 按会话分桶 | 单个 ref 时，在 B 会话按 Esc 会把 A 的流停掉，而 B 毫发无伤 |
| 中键关 / 双击改名 / ⌘1..⌘9 切换 | 与桌面浏览器对齐，不发明新操作 |
| **关 tab ≠ 删会话** | 会话还在侧栏；关完最后一 tab 时显式提示，不偷偷替你切到别的会话 |

状态点只有两个，都不是装饰：**蓝点 = 正在生成**（多 tab 并行的唯一可见证据）、
**橙点 = 这一步需要人**（会话里的审批卡，或这条会话的工单停在 `person/*` ——
Agent 已经停下来在等你。两条来源缺一条，就会出现「人在别的 tab 等你」）。

两个自己踩的坑，都写进了代码注释：

- 初始那条 tab 只是占位。开发态它是演示会话 `c-gmv`，bootstrap 回来后如果
  只是「追加」真实会话，标签栏会同时挂着演示会话和真实会话，点前者是一条
  永远拉不到消息的空会话。**占位的必须被顶掉，不是被追加。**
- `c-new-*` / `c-asset-*` 是还没落库的本地临时 id。把它们持久化，重启后就是
  一排点开是空的幽灵标签页。持久化时按前缀过滤，拿到真 id 后会再存一次。

**② 上下文面板：从「气泡」变成「工作区里的一个 tab」**

最终形态不是「右栏固定第 4 个 tab」，也不是原来的气泡，而是**入口坞 → 工作区 tab**：

| | 旧：会话右缘气泡 | 新：工作区 tab |
|---|---|---|
| 形态 | 浮在会话上的临时层，同时只能看一个 | 右侧工作区里的一格，可多开、可并排、可关 |
| 进 / 出 | 点开、Esc 收 | 点会话右缘的图标放进去；× 或中键关掉 |
| 问题 | 刚才那轮到底怎么回事（追问） | 这条会话现在走到第几步、哪步在等人（常驻仪表盘） |

为什么最后否掉了「固定栏位」：固定 tab 等于把栏位当目录，用户查上下文得先挑栏位再找内容；
而工作区本来就该是「点了什么就显示什么」，tab 只是这些内容的堆叠顺序。

内容分两段，对应「过程」和「原料」：

- **每一步**（过程）：把消息流折叠成「轮次 → 步骤」（`utils/contextSteps.ts`）。
  每步一行：状态点 + 工具名 / 命令首行 + 状态与耗时。工具耗时按轮累计，
  所以「第 3 轮开始变慢」是看出来的，不是猜出来的。
- **已挂载 / 检索命中 / 上下文构成**（原料）：沿用既有 `CTX_*` 切片。

口径上一条硬规矩：**token 只显示真值**。只有服务端在轮末卡片带了 `usage` 才算数，
其余显示「—」。拿字符数估一个好看的数，比留空更坏 —— 人会拿它做判断。

**③ 协作流视图（主区域宽视图）**

从 tab 栏右侧进入，是**当前会话的另一种看法**，不是一条新会话 tab。

为什么不做成右栏一格：它的信息形状是**两条并排的时间线**（左边「我问了什么」，
右边「谁在做、做到哪」）。并排才看得出「这次提问根本没触发派工」或
「第 3 轮开始变慢」；塞进 300px 只能垂直堆叠，那就退化成两份列表。

数据只有一个入口：`GET /api/conversations/:id/tickets`
（`services/tickets.ts::listTicketsByConversation` → 复用 `getTicketDetail`）。
按 `ticket.conversation_id` 反查，而不是让前端串 N 个 `/tickets/:id` ——
串出来的时间线对不齐。

右列每张工单卡给的是**人判断「跑得对不对」需要的事实**：
阶段徽标、授权范围（收窄过就显示收窄后的）、逐轮状态/耗时/重试/tokens、
它问过人的问题与回答、期间收到的事件、以及起止时间。
未结束的工单每 5 秒静默刷新一次（不闪 loading 骨架），页头写明「实时刷新 / 已静止」。

空态要解释清楚**为什么空**：协作流只记录「它自己决定去做」之后的过程，
单纯问答不建单。否则一个空白面板会让人以为功能坏了。

**④ 「待人」状态：一张表接到所有看得见的地方**

「待人」不是一种界面状态，是四种事实：`person/answer`（等你回答）、`person/review`
（待你验收）、`person/blocked`（受阻待决）、`person/failed`（失败待处理）。
原来它只活在工单页里：Agent 停下来等人，而人在会话里看不到任何痕迹。

三层显示，同一份数据：

| 位置 | 显示什么 | 依据 |
|---|---|---|
| 侧栏「智能体」徽标 | 全局待人张数，三级配色 | 有 `answer` → 红（呼吸光晕）；只有 blocked/failed → 橙；只有 review → 蓝 |
| 会话 tab 橙点 | 这条会话有没有单在等人 | `waiting[].conversationId === tab.id`，tooltip 直接写「等你回答」/「3 张单等你处理」 |
| 协作流 / 工单页 | 明细与操作入口 | 既有 `GET /api/tickets` 与 `GET /api/tickets/waiting` |
| 窗口标题 / 任务栏 | 应用在后台时的唯一痕迹 | 标题 `(4) DevWork` + 任务栏覆盖点（见 ⑤） |

数据只有一个入口：`GET /api/tickets/waiting`（`services/tickets.ts::waitingTickets`）。
口径与 `ticketStats().waitingHuman` **严格一致**（`state='open' AND stage LIKE 'person/%'`）：
侧栏那个数字点开，必须正好是这几条。`grant` 不并进来 —— 待授权是「还没被放行的活」，
属于准入/账本区。两件事合成一个数字，侧栏就会和工单页对不上账，
而人一旦发现数字对不上，就再也不信它。

排序即优先级：`answer → blocked → failed → review`，同类按创建时间正序（等最久的在前），
免得点开一看全是等待、却不知道先救谁。

刷新三处，都很便宜：

- **全局 10 秒一次**。原先侧栏自己 30 秒拉一次 `stats`，对阻塞态太慢：
  Agent 停下来等人，半分钟后界面才动一下，人会先怀疑界面坏了，再怀疑任务死了。
- **窗口重新聚焦立刻一次** —— 离开一阵再回来，第一眼必须是最新状态。
- **回答 / 停止 / 重派之后立刻复核一次** —— 刚答完还盯着红点，会以为没提交成功。

失败**保留上一次结果**：网络抖一下就把红点清掉，比不显示更危险。

点击行为分两种，都不偷偷切会话：当前会话就有单在等你 → 直接开它的协作流；
否则 → 进工单页看全量。你正在写的那句话，比省一次点击值钱。

**⑤ 窗口标题与任务栏：界面之外也得留痕**

最小化、被别的窗口盖住、收进托盘时，界面里画的任何红点都看不见 ——
而「Agent 停下来等你」恰恰是最该被余光捕捉到的状态。所以待人状态还要往系统层落一层。

通路是单向的：渲染进程把 `{ count, level }` 推给主进程（IPC `win:attention`），
主进程不再自己拉接口。它拿不到登录态，也不该有第二套口径 ——
两套账的结果就是界面显示 3、任务栏显示 4。

| 位置 | 显示 | 为什么不这么做 |
|---|---|---|
| 窗口标题 | `(4) DevWork` | 数字放最前：任务栏与 Alt+Tab 从右边截断，`DevWork (4)` 先丢的正好是要紧的数字 |
| Windows 任务栏 | 覆盖图标：按紧急度着色的**实心点** | 不写数字 —— 覆盖图标实际只有 16×16，3×5 点阵缩一半会糊成「既不像 4 也不像别的」的白块，看着像错字比不写字更糟 |
| macOS Dock | 角标数字（系统矢量字） | 系统画的，清晰，没有栅格化问题 |
| 托盘提示 | `DevWork · 3 张工单受阻待决` | 窗口收进托盘后，这是唯一还看得见的一行字 |

只在**数量上升且窗口不在前台**时闪任务栏，获得焦点立刻停 —— 每次轮询都闪等于没闪，
人会把闪烁归到噪音里；已经看到了还继续闪，就是在催人。

IPC 只在「数字或等级真的变了」时发：10 秒一次的轮询不该反复重画任务栏图标。

**⑥ 就地回答：别让最后一跳毁掉整条链路**

待人清单会把人从任务栏一路引到协作流的工单卡上；到了这里还要再跳一次工单页
才能说一句话 —— 那条路径上每一次跳转都是一次流失。

- **提问型**（`person/answer`）：问题下面直接给候选项 chip（Agent 给了选项就别让人重打字）、
  输入框、`回答` 按钮，回车提交，并写明「这句话会影响什么」。
- **非提问型**（`review` / `blocked` / `failed`）：同样就地给出口 ——
  `验收通过`（结束这张单）、`重新排队`（再跑一轮）、`停止`。文案保持原语义，不发明新动作。
- 提交成功后**立刻**刷新待人快照，而不是等下一轮 10 秒轮询：
  刚答完还盯着没消掉的数字，人会以为自己没提交成功。



---

## 9. 事件循环（核心 30 行）

```ts
// backend/src/services/scheduler.ts —— 单进程、单 tick、无内存状态
let ticking = false;

export async function tick(): Promise<void> {
  if (ticking) return;              // 上一轮没跑完就跳过，绝不并发 tick
  ticking = true;
  try {
    // ① 取一批待处置 Trigger（按线程分组，同线程串行）
    const batch = pickPendingTriggers({ limit: 20 });
    if (batch.length === 0) return;

    // ② Gate：程序规则，零成本挡掉
    const admitted = batch.filter((t) => gate(t).admitted);
    recordDispositions(batch, admitted);

    // ③ 同线程合并：线程上有 Eval 在跑 → 塞回队列，不并发
    const groups = groupByThread(admitted).filter((g) => !threadEvalRunning(g.threadId));

    for (const group of groups) {
      markEvalRunning(group.threadId, true);
      try {
        // ④ Assessment：有模型走模型；没有 → unavailable（不假装判断）
        const decision = await assess(group);
        applyDecision(decision);        // accept → 建 Ticket + Mandate + 入队派工
      } finally {
        markEvalRunning(group.threadId, false);
      }
    }

    // ⑤ 派工 + 回收
    dispatchQueued();               // 有空槽且工单 queued → 起 Worker
    reapExpiredAssignments();       // 租约过期 → person/failed
  } finally {
    ticking = false;
  }
}

// index.ts 里：initDatabase() 之后
setInterval(() => { void tick(); }, 800);
```

**为什么不做成队列服务**：状态全在表里，`trigger.disposition` 就是游标，
`thread.eval_running` 就是锁，`assignment.lease_until` 就是心跳。
进程重启后 tick 从表里接着跑，没有任何"内存里的待办"会丢。这正是它"评估无状态"的
真正含义——不是不存状态，是**状态只存一份，且存在可恢复的地方**。

---

## 10. 复用清单：这次改造大部分是**加法**

| 现有模块 | 新角色 | 改动量 |
|---|---|---|
| `llm-gateway.generate()` | Worker 的推理循环，**协议不动** | 加 `ticketId` / `mandate` 入参 |
| `makeToolExecutor()` | Worker 工具执行器 | 加 Mandate 范围判定 + handBack |
| `permission.check()` | 每动作闸门，**判定顺序不动** | 加 `ticketId` / `mandateId`，落审计 |
| `write-executor` | 写执行三层防线 | **零改动** |
| `deriveToolFace()` | 分别派生 Router 面 / Worker 面 | 加一个 `role` 参数 |
| `audit_event` | 唯一黑匣子 | 加列 `ticket_id` |
| `conversation` / `message` | Channel | 加列 |
| `session-approvals` | Mandate 兼容层 | 一个版本周期后删 |
| `detectIntent` + `TEMPLATES` | 降级为"无模型时的只读探索"，**不参与路由** | 移除 Router 决策路径上的调用 |

---

## 11. 迁移路线（三步，每步可独立上线、可回滚）

| 阶段 | 范围 | 状态 | 验收 |
|---|---|---|---|
| **P1 影子（observe）** | 建 `source/thread/trigger/decision`，只记录 "would accept"，不执行 | ✅ **已完成**（含定时源、真人取料、账本导出） | Gate 误判率；一天会接几张单 |
| **P1.5 授权草案** | `mandate` 草案 + 人审 + 粒度（asset / workspace） | ✅ **已完成** | 范围是否算得出来；人认可比例 |
| **P2 单 Worker** | ticket / assignment / 注意力 / 派工 / 执行 | ✅ **已完成**（串行，工具面受 Mandate 约束） | 打扰密度 ≤1.5；越权 0 漏网 |
| **P2.5 隔离** | worktree / 独立目录、写互斥 | ✅ **已完成** | 两单并发不互相覆盖 |
| **P3 主动源 + 扇出 + auto** | log/git/terminal/sql 四类源、订阅扇出、auto 签发 | ✅ **已完成** | 一次写入不丢失；auto 签发受预算约束 |
| **P4 并行** | slot 2~4 真正并行、合并策略 | ⏳ **未做**（写权限仍互斥） | p50 完成时长；无覆盖冲突 |

**P1 必须先做的原因**：Gate 的误判是这套架构唯一的新增噪音源。影子期能算出"这套规则
一天会主动接 30 单还是 3 单"——这个数字决定 `auto` 到底能不能开。

---

## 12. 指标（上线就要能看，否则等于没做）

| 指标 | 定义 | 目标 |
|---|---|---|
| 打扰密度 | attention 条数 / 已结束工单数 | ≤ 1.5 |
| 一次通过率 | `ready` 报告被直接验收（无返工）/ 总工单 | ≥ 70% |
| 越权拦截 | `handBack` 次数 / 工单数 | 0.3~0.8（太低说明 Mandate 太宽，太高说明太窄） |
| 审批卡替代率 | (旧审批卡数 − 新 attention 数) / 旧审批卡数 | ≥ 60% |
| Router 成本占比 | Router token / 总 token | ≤ 15% |
| 幽灵率 | 租约回收数 / 派工数 | ≤ 2% |
| p50 / p95 完成时长 | 工单 open → ended | 参照 12.4 / 15.7 分钟（它的内部数据，仅作量级参考） |

---

## 13. 风险与对策

| # | 风险 | 现实后果 | 对策 |
|---|---|---|---|
| 1 | 缓存读放大（它实测 +37%） | 多会话各自持上下文，成本上升 | Router 用便宜模型 + 批处理；Worker 上下文按工单裁剪；成本按 `ticket_id` 归集后在面板可见 |
| 2 | SQLite 单写锁 | 多 Worker 并发写库争锁 | 所有写库走主进程串行队列；Worker 只读；slot 上限 4 |
| 3 | 并发改同一文件 | 两个工单互相覆盖 | accept 前查"同 asset 同 path 的 open 工单"→ 已存在则改成 `attach` |
| 4 | 审批疲劳没治好，只是换了个地方 | attention 变成新的洪水 | 硬上限（§6.2）＋ 面板只显待人 ＋ 默认 1 次/工单/小时 |
| 5 | Mandate 被当成"免审批通行证" | 安全红线被侵蚀 | §5.2 三条硬约束；`permission.check()` 一行不改 |
| 6 | Router 判断漂移 | 简单任务自己上手 / 该接的不接 | 物理断手；影子期量化误判率；策略写成可读规则而非自由发挥 |
| 7 | 主动源噪音 | 日志报错刷出 200 张工单 | Gate 必须带频控（同 thread 每小时 ≤1、同指纹去重）；默认全源 `off` |
| 8 | 跨会话记忆幻觉 | Agent 记住不存在的上下文 | 记忆只来自 `thread.messages` + `ticket` 报告，不来自模型自述 |

---

## 14. 明确不做

- ❌ **不做无审批的 shell 执行**（它做了，我们不跟。这是产品定位差异，不是保守）
- ❌ 不做多用户 / 账号 / 角色（现有架构已整体移除，别为了"团队协作"回填）
- ❌ 不做跨源身份映射（同一个人在不同源是两条身份，需要时写进 prompt，不做实体）
- ❌ 不做 Eval 内部定时器（要等就新增 Source）
- ❌ 不做"Worker 自己宣布用户叫停"（只有 Eval 能判 stop）
- ❌ 不做策略变更即时 kill（投递通知 + 下轮复核）
- ❌ 不做自由文本推断"是否在等人"（必须走结构化 `attention`）

---

## 附录：和 DeepSeek 原版的差异一览

| 维度 | 原版 | DevWork |
|---|---|---|
| 隔离 | 每工单一个目录（`git worktree`） | 按资产类型分四种隔离面（worktree / 回滚脚本 / 命令白名单 / 无） |
| 权限 | Mandate 即授权，Worker 无审批执行 | Mandate 是上限，`permission.check()` 仍是每动作闸门 |
| 源 | GitHub + 飞书 | 7 类：user / terminal / git / sql / log / schedule / ci |
| 默认准入 | `observe` | `observe`，且主动源默认 `off` |
| 无模型时 | 不存在这个状态 | 明确 `unavailable`，由人接管，不假装判断 |
| 成本 | 未披露 | 按工单归集，面板可见，缓存读单独一行 |
