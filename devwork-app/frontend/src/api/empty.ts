/**
 * 空态快照 —— 打包态的「真实空数据」底板。
 *
 * 为什么需要它：
 * src/data/mock.ts 里的常量一肩挑两担 ——
 *   ① **结构定义**：设置页控件骨架、命令黑白名单、快捷键表。
 *      这些描述 UI 长什么样，不是业务数据，必须保留。
 *   ② **演示素材**：3 个项目、GMV 归因会话、假资产指标、假 SQL 结果、假文件树。
 *      这些是开发期的原型样本，交付给用户的程序里不该出现。
 *
 * 直接删掉 mock.ts 会砸掉 ①，让设置页渲染不出来；
 * 原样保留又会让 ② 漏到界面上（后端某个接口一失败，演示数据就顶上来了）。
 *
 * 所以这里产出第三种东西：**保留 ① 的结构，把 ② 清空**。
 * 打包态（__PACKAGED__）下，live.tsx 用它做底板 —— 后端返回什么就显示什么，
 * 没返回的就诚实地空着，而不是拿演示数据糊。
 */
import { MOCK_SNAPSHOT } from './mock';
import type { ViewSnapshot } from './snapshot';

/**
 * 构造空态快照。
 *
 * 逐字段决定「留结构」还是「清内容」：
 *   - 留：设置分区、审计筛选项、快捷键、资产选择器、引用跳转链、
 *         命令黑白名单、默认 SQL 文本。
 *   - 清：项目列表、会话消息、引用实体、上下文/执行/产物面板、服务器与数据库
 *         与代码的各项指标、活动、能力、SQL 结果与浏览数据、文件树、终端历史。
 */
export function emptySnapshot(): ViewSnapshot {
  const base = MOCK_SNAPSHOT;
  return {
    ...base,

    /* ---- 会话 / 业务数据：全清 ---- */
    PROJECTS: [],
    INITIAL_THREADS: {},
    CITATIONS: {},
    CTX_MOUNTED: [],
    CTX_HITS: [],
    CTX_BARS: [],
    RUN_TOOLS: [],
    RUN_BARS: [],
    OUTPUT_FILES: [],

    /* ---- 服务器视图：清（对应资产不存在） ---- */
    SERVER_METRICS: [],
    SERVER_CONN_KV: [],
    SERVER_ACTIVITY_KV: [],
    CAPS_SERVER: [],
    TERMINAL_INITIAL: [],
    TERMINAL_HISTORY: [],

    /* ---- 数据库视图：清 ---- */
    DB_METRICS: [],
    DB_CONN_KV: [],
    DB_ACTIVITY_KV: [],
    CAPS_DB: [],
    DB_TABLES_SQL: [],
    DB_TABLES_BROWSE: [],
    SQL_RESULT_COLUMNS: [],
    SQL_RESULT_ROWS: [],
    BROWSE_COLUMNS: [],
    BROWSE_ROWS: [],
    BROWSE_INDEXES: [],
    BROWSE_FKS: [],
    BROWSE_STRUCTURE: [],

    /* ---- 代码视图：清 ---- */
    CODE_METRICS: [],
    CODE_REPO_KV: [],
    CODE_ACTIVITY_KV: [],
    CAPS_CODE: [],
    CODE_FILES: [],
    CODE_TREE: [],
    CODE_DIFF: '',
    CODE_PATCH: '',

    /* ---- 审计：清空（形状保留） ---- */
    ORG_AUDIT: [],

    /* ---- SQL 高亮：跟随默认 SQL 文本重新生成，不沿用演示结果 ---- */
    SQL_HIGHLIGHTED: base.DEFAULT_SQL_TEXT ? base.highlightSql(base.DEFAULT_SQL_TEXT) : base.SQL_HIGHLIGHTED,
  };
}

/**
 * 按当前模式取底板。
 * 打包态用空态（不掺演示数据），开发态保持原型快照（离线也能看完整界面）。
 */
export function baseSnapshot(): ViewSnapshot {
  return __PACKAGED__ ? emptySnapshot() : MOCK_SNAPSHOT;
}
