# 变更记录

本文件记录 DevWork 桌面端的对外变更。版本号只有一处来源：`devwork-app/package.json`
（后端 `backend/src/config/version.ts` 与前端 `__APP_VERSION__` 均派生自它）。

---

## 未发布 — 打包基础设施：依赖与二进制走国产镜像

- **依赖源、二进制源统一走 npmmirror**：新增 `devwork-app/.npmrc`
  （`registry` / `electron_mirror` / `electron_builder_binaries_mirror`）与
  `devwork-app/scripts/lib/mirrors.mjs`（镜像地址的单一来源 + 向子进程注入
  `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`）。国内网络下
  `npm install` 与 `npm run dist` 不再卡在 `registry.npmjs.org` 和 GitHub releases：
  electron 二进制（`electron-v<版本>-win32-x64.zip`）、electron-builder 的
  nsis / winCodeSign / app-builder 全部从镜像取。
  换源用 `DEVWORK_NPM_REGISTRY` / `DEVWORK_ELECTRON_MIRROR` /
  `DEVWORK_ELECTRON_BUILDER_MIRROR`，回官方源用 `DEVWORK_MIRROR=off`。
- **装依赖顺带提速**：脚本内 `npm ci / npm install` 显式带
  `--registry <镜像> --no-audit --no-fund --prefer-offline`，省掉安全审计与赞助横幅的往返，
  命中本地缓存时不回源。
- **打包日志自证镜像**：`npm run dist` 首行与 electron-builder 之前各打一行当前镜像，
  「到底走没走镜像 / 卡在哪个下载」不再靠猜。
- **`pack:*` 与 `dist:*` 对齐**：原先只有 `pack` / `pack:dir`，敲 `npm run pack:all`
  会报 `Missing script`。现在补齐 `pack:zip` / `pack:installer` / `pack:portable` /
  `pack:all`，两套前缀等价，记住哪套都能用。
- **端到端实测**：`npm run pack:all` 跑通，zip / nsis 安装包 / portable 三种产物齐出；
  electron-builder 从镜像取二进制（nsis 1.3 MB 547 ms、nsis-resources 731 kB 1.08 s）。

## 未发布 — 一键打包脚本完善（`scripts/package.mjs`）

- **打包前环境门禁**：`package.mjs` 新增第 ⓪ 步 `checkEnvDeps`。先前它只在 `npm run dev`
  路径上跑，直接打包时 Node 版本不够 / `node_modules` 缺失会以「tsc 或 vite 找不到」
  的形式炸出来，和真的代码错误长得一样。现在缺依赖就自动 `npm ci`（走国产镜像），
  Node < 22 一句话说清。**全新克隆的仓库双击 `scripts\package.bat` 也能一次跑通。**
- **分步耗时**：每一步结束打一行耗时，收尾汇总「总耗时 + 分步耗时 + 产物目录」。
  打包慢的时候第一个问题永远是「慢在哪一步」，此前只能回滚屏幕去数 builder 的日志。
- **参数写错不再静默**：新增参数白名单。此前 `--alll` / `--zip2` 会被 `args.has()`
  当成没写，静默退化成默认目标（只出 zip）—— 跑几分钟最后少两个产物，不看日志发现不了。
  现在直接报「未知参数」并退出。
- **`--help` / `-h`**：打印全部参数（目标 / 速度 / 其它 / 环境变量），排在环境门禁之前，
  依赖没装也能立刻看到用法。
- **`--no-open`，并收紧自动打开条件**：自动打开产物目录原先在 Windows 上恒为开，
  `explorer` 会把窗口抢到前台，CI 与远程终端里纯属干扰。现在默认条件是
  「Windows + 交互终端 + 非 `CI`」，`--open` 可强制、`--no-open` 可否决。
- **标题跟着目标走**：`--all` 时标题从「zip 压缩包」改成「zip + 安装包 + 便携版」，
  不再与实际产物不符。
- **`scripts\package.bat` 同步修正**：注释里「生成安装包 / `release\DevWork Setup *.exe`」
  早已过期（默认产物是 zip，实际路径是 `release\build`）；补 `--all` / `--help` 用法，
  加 Node 缺失的前置检查（双击时给出国内镜像下载入口，而不是 `node is not recognized`），
  结尾提示产物目录。`scripts/package.sh` 补齐各目标用法注释。
- 已知噪音：npm 会对 `.npmrc` 里的 `electron_mirror` / `electron_builder_binaries_mirror`
  打 `Unknown project config ...`；这两个键又被导出成 `npm_config_*` 传给子进程，子进程里的
  `npm exec` 再打一句 `Unknown env config "electron-mirror"`。两句都是预期行为，
  `@electron/get` 与 `app-builder-lib` 正是按这些变量取地址。

---

## 1.0.0 — 2026-11-14

首个对外正式版。定位：**只读为主 + 写操作逐次人工批准的可回滚受控写（实验性）**。
这是「能力面」的正式版，不等于功能大而全 —— 下面「已知限制」请先读。

### 新增

- **打包产物内置 Node 22 运行时**：目标机不需要预装 Node（后端依赖 `node:sqlite`，
  Electron 自带的 Node 20 没有它）。zip / portable 解压即用。
- **首启自洽**：干净环境启动只有一个空工作区，不播种演示资产、演示会话与演示消息；
  没有配置模型时如实降级为「演示轨迹 · 未接入模型」，**不产出结论、不产出引用**。
- **受控写（实验性）通道**：预检 → 备份 → 执行 → 校验 → 可回滚；默认只读模式开、
  Agent 中低风险写直接拒绝并转建议、prod 资产默认只读，只有显式批准的 plan 才真写盘。
- **证据链**：回答里的引用带 `path:line` 可点开回原文；审计记录覆盖只读查询、写执行、
  审批裁决与导出（导出条数 = 命中条数）。
- **影子链路**：事件 → 研判 → 授权草案 / 工单 → 派工 → 单轮执行 → 收件箱扇出；
  只读动作可自动签发，写权限需显式放行。
- **任务清单卡与上下文压缩**：长任务按步回传清单（原位更新、不刷屏），上下文按预算测量并可
  手动压缩 —— 压缩只改"发给模型的内容"，时间线里的原始消息一条不删。
- **发布门禁脚本**：`npm run preflight:release`（类型 / 版本单源 / 运行时依赖 / 契约导入）、
  `npm run test:all`（含写执行层、浏览器链路、数据完整性）、打包产物冒烟改为**在仓库外临时目录启动**。
- README / CHANGELOG / LICENSE 三件发布物料齐备（闭源私有）。

### 修复

- **打包产物缺 `zod` 导致装机必崩**：后端经 `shared/contracts` 运行期依赖 zod，
  而运行时暂存只带了 `express / cors / tsx`；产物自带 72 个包却没有 zod，
  加上冒烟是在仓库内启动（向上命中 `node_modules/zod`），缺陷被假通过掩盖。
  现在依赖清单补 zod、`stage-runtime` 与 `package.mjs` 自检都点名五个运行时依赖、
  冒烟改到系统临时目录启动并用 `/api/bootstrap`（`/api/health` 不过 zod 校验链，探不到缺包）。
- **版本号单源**：`/api/health`、`setting.about`、前端 mock 三处硬编码的旧版本号收敛到
  "后端 `config/version.ts` + 前端 `__APP_VERSION__`"；老库升级时 `setting.about` 会被覆盖为当前版本；
  `check:version` 新增「源码里不得残留旧版本号字面量」断言（剥注释后再扫，不误伤历史说明）。
- **切工作区后右栏/文件树/SQL 表仍是上一个工作区的**：全量装配的依赖从 `[tick]` 改为
  `[tick, workspaceId]`，工作区 id 直传，去掉只读不触发重算的 ref。
- **从"有资产会话"切到空会话会串味**：会话级切片（上下文/执行/产物/引用）先清空再叠加非空结果，
  空会话如实显示空态。
- **代码大纲 / 文件树 / 仓库状态必超时**：这三个接口后端是同步遍历整仓，前端默认 2.5s 超时不够，
  现显式放宽到 20s。
- **后端崩溃后无人管**：非关停状态下先退避 2s 自动重启一次，仍失败则把窗口切到错误页并给「重试」；
  关停时清掉退避定时器，避免关窗后又冒出一个抱着 3001 的孤儿进程。
- **首启超时不再是一次性死页面**：15s 未探到 health 时错误页给「重试」，
  后端稍后就绪时点一下就进首屏（慢机器首启要建库建索引，15s 确实可能不够）。
- **打包态误连别人的 3001**：spawn 之前先探活，端口已被占用就如实报错，**不接管**他人的后端
  （否则读的是别人的数据目录）。
- **审批档位在设置页多了一个内核不支持的选项**：「本会话内记住」在 1.0 没有对应语义
  （内核只把它当"非每次询问"处理，等价于按风险分级）。前端已删除该选项，后端启动时一次性迁移
  `migratePermScopeMemory@1` 把老库的存量值归一为「按风险分级」（幂等，二次启动跳过）。
  两端必须同版本发布：只发前端会让老库短暂出现空选中项。
- `DEVWORK_PORT` 真正全程生效：vite proxy 与 `scripts/start.mjs` 都跟着环境变量走，
  不再出现"后端在 3031、前端仍代理 3001 → 全站 404"。
- **审计归属不再写死默认工作区**：全局动作（LLM Key、清缓存、审计导出）记
  `workspaceId=global`，资产/会话动作按真实归属记 —— 此前审计页"按工作区筛选"筛不到这些记录。
  审计页的筛选里出现 `global` 这一档是预期行为。
- 前端未使用导入清理（`tsc --noUnusedLocals` 0 error）；后端崩溃日志的排版错误修正。
- 仓库卫生：移除被误提交的 Vite 临时配置（`vite.config.ts.timestamp-*.mjs`）并加入忽略规则。

### 安全

- 路径越界校验补齐分隔符判定（`safeJoin` 原先用前缀匹配，同名前缀的兄弟目录能穿透）。
- 克隆私有仓库的凭据不再持久化写进 `.git/config`。
- grep / cat / head / tail 增加输入长度与文件大小上限（防灾难性回溯正则与大文件入内存）。
- 审计事件的 `workspaceId` 改为必传并从资产/会话推导（原先硬编码，按工作区筛不到）。
- 渲染进程仍然只能通过 contextBridge 白名单拿到最小能力集；新增的「重试」也只暴露一个
  无参数的恢复动作。

### 已知限制

> 对外口径以 README 的「**已知限制（6 条）**」为准（账号类操作 / 资产离线不探测 /
> 深色与拖拽调宽缺视觉回归 / 写执行实验性 / 内网访问需环境变量 / 升级库保留示例资产）。
> 本节在此基础上补充**发布形态与运维层面**的条目，两者不重叠计数。

1. **账号类操作没有后端**：删除账号 / 多设备退出只弹说明型窗口，不做实际动作（本程序无账号体系）。
2. **资产离线不做真实探测**：界面不显示"在线"状态，宁可不给也不伪造。
3. **深色主题与拖拽调宽缺自动截图回归**：需人工确认。
4. **写执行属实验性**：建议只在克隆出来的仓库上试。
5. **内网访问默认关闭，只能通过 `DEVWORK_BROWSER_ALLOW_PRIVATE=1` 开启**：
   开启后 Agent 的内置浏览器可访问本机无鉴权服务（Jupyter / Ollama / admin 面板）与内网地址；
   删除该变量即恢复默认拒绝。开启状态在「设置 → 权限」显示一行只读状态
   （数据来自 `/api/health.browserAllowPrivate`），启动日志另有一条 WARN 级记录。
   这条只影响内置浏览器能访问哪些地址，不改变 3001 端口门禁。
6. **自动更新为「预留，未接真实 feed」**：`publish.url` 仍是占位地址，检查更新只做本地版本比对，
   不下载、不安装。
7. **NSIS 安装流程未作为发布闸门**：只保证"能生成安装包"；本机已关闭 rcedit 与签名，
   杀软可能拦截，安装流程结果以发布说明为准。平台仅 Windows x64。
8. **审计库随使用增长**（设计如此，append-only）：需要归档请导出 CSV 后自行清理历史库。
