# DevWork

**本地研发工作台：只读为主 + 写操作逐次人工批准的可回滚受控写（实验性）。**

DevWork 是一个 **Windows x64 桌面程序**。它把你的代码库、数据库、服务器接进一个本地工作台，
让 Agent 在这些真实资产上**只读地**干活（检索代码、查库、读文件、看网页），
把每次动作写进审计；需要落盘时走「受控写」通道——默认只读、逐次批准、批准后可回滚。

> 1.0.0 是「能力面」的正式版，**不是功能齐全版**。哪些是真做的、哪些只是预留，
> 见下面的「能力边界」与「已知限制」，看完再决定要不要接真实仓库。

---

## 安装

三种形态，任选其一。**都不需要预装 Node**（程序自带 Node 22 运行时）。

| 形态 | 文件 | 怎么用 |
|---|---|---|
| 压缩包（推荐） | `DevWork-1.0.0-win-x64.zip` | 解压到任意目录 → 双击 `DevWork.exe` |
| 便携单文件 | `DevWork-1.0.0-win-x64-portable.exe` | 双击即用，数据在 exe 同级 `DevWorkData\` |
| 安装包 | `DevWork-Setup-1.0.0-win-x64.exe` | NSIS 安装包（**当前只保证"能生成安装包"**，安装流程未作为发布闸门，见「已知限制」） |

- 压缩包是默认分发形态：它只解压、不执行自解压逻辑，安全软件不会拦。
- 若安全软件仍拦 `DevWork.exe`，把该目录加入信任即可。
- 平台只有 **Windows x64**；macOS / Linux 无产物。

## 环境要求

- Windows 10 / 11 x64。
- **不需要装 Node**：后端是独立进程，依赖 `node:sqlite`，所以包里自带一份 Node 22
  （`resources/runtime/node.exe`）。目标机上的系统 Node 与本程序无关。
- 不需要模型 Key 也能启动：没有 Key 时，提问会得到「演示轨迹 · 未接入模型」的降级卡，
  **不产出结论、不产出引用**。接自己的 OpenAI 兼容端点在「设置 → 模型配置」。

## 启动与数据目录

双击 exe 后，桌面壳会自动拉起后端子进程（`127.0.0.1:3001`）并打开工作台。

数据**不写在程序目录里**：

- 安装版 / 压缩包版：`%APPDATA%\DevWork`（用户数据目录，卸载或删程序目录都不会带走数据）
- 便携版：exe 同级的 `DevWorkData\`（拷走 exe 就拷走数据）
- 便携版所在目录不可写时（例如放在 `Program Files`），退回 `%APPDATA%\DevWork`

库文件是 `data\devwork.sqlite`，启用 WAL。备份只需在程序退出后复制整个数据目录。

启动异常时窗口会停在一张说明页，并提供「重试」按钮。两种常见情况：

- **3001 被占用**：多半是上一次的残留进程，或正在本机跑 `npm run dev`。打包版**不会**
  接管别人的后端（那会读到别人的数据目录），请先结束占用再点「重试」。
- **后端异常退出**：会自动重启一次；仍失败则给出错误页与「重试」，日志在数据目录的 `logs\` 下。

## 能力边界（以代码事实为准）

| 维度 | 1.0.0 的真实状态 |
|---|---|
| 读 | **真执行**：代码检索、知识库检索、只读 SQL、文件读、网页读。「被拦截」与「执行失败」是两种不同提示。 |
| 写 | **受控写（实验性）**：默认 `readOnlyMode=true`；Agent 的中低风险写在权限内核里直接被拒绝并转成建议；只有你**显式批准**的那张写卡才会真的落盘（预检 → 备份 → 执行 → 校验），并可一键回滚。prod 资产默认只读。 |
| 自动化 | 影子链路 → 授权草案 → 工单 → 派工 → 单轮执行 → 收件箱扇出。只读动作可自动签发，写权限必须显式放行。 |
| 审计 | 只读查询、写执行、审批裁决、导出都有记录，可按条件筛选并导出 CSV（导出条数 = 命中条数）。全局动作（改模型 Key、清缓存、导出审计）记在工作区 `global` 下，按工作区筛选时会出现这一档。 |
| 明确没有 | MCP 客户端、Skill 运行时（现为提示词级登记表）、记忆系统、远程策略下发、多用户 / 账号体系、账号类操作。 |

### 受控写（实验性）的三条纪律

1. 默认档位钉死：只读模式默认开、中低风险写默认拒、prod 资产默认只读。
2. 只有「你批准的 plan」才写盘，未批准的路径零磁盘变更。
3. 每次写都有快照，可回滚；回滚同样写审计。

## 已知限制（6 条，对外口径以本节为准）

1. **账号类操作没有后端**：删除账号、多设备退出这类入口只弹说明型窗口，不做任何实际动作。
   本程序没有账号体系，也就没有可删的对象。
2. **资产离线不做真实探测**：界面上**不显示"在线"绿点**。宁可不给这个状态，也不伪造它 ——
   当前没有对资产做连通性探测。
3. **深色主题与拖拽调宽缺自动截图回归**：这两个形态目前没有被自动化视觉测试覆盖，
   改样式后需要人工看一眼。
4. **写执行属实验性**：建议只在**克隆出来的仓库**上试，别直接对着生产分支批准写卡。
5. **内网访问默认关闭，只能通过环境变量开启**：Agent 的内置浏览器默认拒绝访问
   127 / 10 / 172.16 / 192.168 与本机服务。设 `DEVWORK_BROWSER_ALLOW_PRIVATE=1` 后才会放行 ——
   开启后 Agent 的浏览器工具可以访问**本机无鉴权的服务**（Jupyter / Ollama / 各类 admin 面板）
   与内网地址；删掉该变量即恢复默认拒绝。开启状态会在「设置 → 权限」显示一行只读状态
   （`/api/health` 的 `browserAllowPrivate`），启动日志里也会有一条 WARN 级记录。
   > 注意：这条只影响**内置浏览器**能访问哪些地址，不改变 3001 端口的门禁 ——
   > 内置浏览器用独立 partition，拿不到桌面壳注入的 `X-DevWork-Token`。
6. **从旧版本升级的数据目录会保留原有示例资产与会话**：干净环境只在**首次启动**时生效
   （`CLEAN` 只挡首启播种，对非空库不再清理）。从 0.4.2 升级上来的用户会看到当时留下的
   示例工作区 / 资产 / 会话。**如需干净环境**：先退出程序，删除数据目录（`%APPDATA%\DevWork`，
   便携版是 exe 同级的 `DevWorkData\`）后重启即可。

## 自动更新：预留，未接真实 feed

程序里保留了更新检查的代码路径（安装版才启用），但 1.0.0 **没有发布真实的更新源**
（`publish.url` 仍是占位地址）。因此：

- 「检查更新」只做本地版本比对，并如实说明拿不到更新源；
- 不会下载、不会安装任何更新；
- 压缩包 / 便携版本来就没有更新器（zip 没有 `app-update.yml`，portable 无稳定安装位置）。

## 审计库会随使用增长

审计表是 **append-only**（审计证据不允许被自动清理），所以 `devwork.sqlite` 会随使用变大。
这不是缺陷，是设计取舍：需要归档时在「审计」页按条件筛选后**导出 CSV**，再按需清理历史库。
另外有两处会自动收敛：影子账本留存 30 天（`pruneShadowLedger`），写执行快照按配置保留。

## 开发 / 构建

```bash
npm install            # 依赖（Node 22+，后端需要 node:sqlite）

npm run dev            # 开发：后端 3001 + 前端 5173 + Electron 窗口
npm run typecheck      # 前端 + 后端 tsc 双份，必须 0 error
npm run test           # 单元基线 + 影子核心 + 隔离冒烟（七阶段）
npm run test:all       # 发布闸门：上面 + 写执行层 + 浏览器链路 + 数据完整性
npm run preflight:release  # 静态发布门禁（类型 / 版本单源 / 运行时依赖 / 契约导入）

npm run build          # typecheck + vite build → dist/
npm run pack           # 默认出 zip 压缩包（含运行时暂存 + 产物冒烟 + 自检）
npm run pack:dir       # 只出免安装目录 release/build/win-unpacked（自测最快）
npm run pack:all       # zip + NSIS 安装包 + 便携版三种全出
npm run pack -- --help # 全部参数（--fast / --no-smoke / --force / --no-open）
```

依赖与二进制默认走**国产镜像（npmmirror）**，国内网络下 `npm install` / `npm run dist` 不用额外配置，
也不会卡在 `registry.npmjs.org` 或 GitHub releases：

- `devwork-app/.npmrc`：装包源 `registry` + electron 二进制 `electron_mirror` +
  electron-builder 的 nsis / winCodeSign `electron_builder_binaries_mirror`（管 `npm install` 这条路径）；
- `devwork-app/scripts/lib/mirrors.mjs`：同一份地址的单一来源，向打包脚本 spawn 出的子进程注入
  `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（管 electron-builder 自己下二进制）；
- 换源：`DEVWORK_NPM_REGISTRY` / `DEVWORK_ELECTRON_MIRROR` / `DEVWORK_ELECTRON_BUILDER_MIRROR`；
  境外网络想回官方源：`DEVWORK_MIRROR=off`，**同时**把 `.npmrc` 里两条 `*_mirror` 注释掉
  （npm 仍会把 `.npmrc` 导出成 `npm_config_*` 交给子进程，只关脚本那层关不干净）；
- npm 会对 `.npmrc` 里的 `electron_mirror` 打 `Unknown project config`，又会因为 npm 把这两个键
  导出成 `npm_config_*` 交给子进程、子进程里的 `npm exec` 再打一句 `Unknown env config` ——
  两句都是预期噪音，这两个键是 electron 生态的约定，@electron/get 与 app-builder-lib 照旧按
  `npm_config_*` 取值（实测 nsis 从镜像下载 547ms、nsis-resources 1.08s）。
- `pack:*` 与 `dist:*` 等价（`pack:all` = `dist:all` = zip + 安装包 + 便携版三种产物）。

**一键打包（双击即可）**

Windows 直接双击 `scripts\package.bat`（等价于 `npm run pack`，参数原样透传，如
`scripts\package.bat --all`）。它是一层很薄的包装，真正干活的是 `scripts/package.mjs`：

- 开头先做环境门禁：Node < 22 一句话说清，`node_modules` 缺失时自动 `npm ci` 并走国产镜像 ——
  全新克隆的仓库双击也能一次跑通，不会糊一层「tsc 找不到」的假报错；
- 每一步打印耗时，结束汇总总耗时 + 分步耗时 + 产物目录，慢在哪一步不用回滚屏幕去数；
- 参数写错（`--alll`）直接报「未知参数」退出，不会悄悄退化成「只出 zip」；
- `--help` 打印全部参数，不打包；
- 自动打开产物目录只在「Windows + 交互终端 + 非 CI」时触发（`explorer` 抢焦点很烦），
  `--open` 强制开、`--no-open` 强制不开。

调试要点：

- 端口可用 `DEVWORK_PORT`（后端）/ `DEVWORK_VITE_PORT`（前端）覆盖，vite proxy 会跟着走。
- `npm run check:version` 拦住版本回退；版本号只有 `package.json` 与
  `backend/src/config/version.ts` 两处，必须相等（前端经 `__APP_VERSION__` 注入）。
- 打包链路的三处同步：`desktop/main.cjs` + `scripts/lib/stage-runtime.mjs`（含 `scripts/package.mjs` 自检）
  + `electron-builder.yml` 的 `extraResources`。后端运行时依赖是
  `express / cors / tsx (+esbuild) / zod`，少一个装到仓库外就会 `ERR_MODULE_NOT_FOUND`。

## 许可

**Proprietary（闭源私有）**，版权归权利人所有。禁止再分发与反编译，无任何担保。
完整条款见 [LICENSE](LICENSE)。
