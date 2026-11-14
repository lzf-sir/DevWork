-- DevWork 业务库（node:sqlite / WAL）。纯本地工具，无账号 / 成员 / 角色表。
-- 全部由 seedIfEmpty 幂等填充。
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspace (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  index_progress INTEGER NOT NULL DEFAULT 0,
  assets_count INTEGER NOT NULL DEFAULT 0,
  conversations_count INTEGER NOT NULL DEFAULT 0,
  owner_label TEXT NOT NULL DEFAULT '仅我',
  recent_label TEXT NOT NULL DEFAULT '',
  trust_level TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS folder (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  kind TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  collapsed INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  folder_id TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  index_progress INTEGER NOT NULL DEFAULT 100,
  credential_bound INTEGER NOT NULL DEFAULT 0,
  subtitle TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS asset_connection (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES asset(id),
  env TEXT NOT NULL DEFAULT 'prod',
  endpoint TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS credential_binding (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES asset(id),
  user_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'unbound',
  label TEXT NOT NULL DEFAULT '',
  secret_ref TEXT NOT NULL DEFAULT '',
  last_used_label TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  auth_method TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS asset_capability (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES asset(id),
  capability TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1,
  approval TEXT NOT NULL DEFAULT 'auto',
  locked INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS index_chunk (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES asset(id),
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'code',
  path TEXT NOT NULL DEFAULT '',
  symbol TEXT NOT NULL DEFAULT '',
  start_line INTEGER NOT NULL DEFAULT 0,
  end_line INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS conversation (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  folder_id TEXT,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  /* 资产绑定：从代码库 / 数据 / 终端页唤起的会话默认挂在这个资产上。
   * 服务端每轮把它并入 assetIds —— 绑定是服务端事实，不只停留在界面上。 */
  asset_id TEXT,
  asset_type TEXT,
  /* 归档时间：NULL = 活跃会话（出现在侧栏）；非 NULL = 已归档（设置页管理，可恢复 / 彻底删除）。 */
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_call (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '',
  permission TEXT NOT NULL DEFAULT 'allow',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  audit_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS citation (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  locator TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '',
  /* 源文件定位：前端「打开」据此跳到编辑器对应行；无源文件时为空（不再有假引用） */
  path TEXT,
  start_line INTEGER,
  end_line INTEGER
);

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'w-ops',
  conversation_id TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '放行',
  severity TEXT NOT NULL DEFAULT 'info',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_at_label TEXT NOT NULL DEFAULT ''
);

CREATE TRIGGER IF NOT EXISTS audit_event_no_update
BEFORE UPDATE ON audit_event BEGIN SELECT RAISE(ABORT, 'append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_event_no_delete
BEFORE DELETE ON audit_event BEGIN SELECT RAISE(ABORT, 'append-only'); END;

CREATE TABLE IF NOT EXISTS terminal_session (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_history (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  command TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_whitelist (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  dispatcher TEXT NOT NULL DEFAULT 'builtin'
);

CREATE TABLE IF NOT EXISTS command_blacklist_rule (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT 'all'
);

CREATE TABLE IF NOT EXISTS command_suggestion (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  command TEXT NOT NULL,
  executable INTEGER NOT NULL DEFAULT 0,
  audit_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setting (
  section TEXT PRIMARY KEY,
  raw TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS context_snapshot (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_stat (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  context_used INTEGER NOT NULL DEFAULT 32768,
  context_budget INTEGER NOT NULL DEFAULT 204800,
  cost_cny REAL NOT NULL DEFAULT 0.42,
  model TEXT NOT NULL DEFAULT 'Claude-Sonnet'
);

CREATE TABLE IF NOT EXISTS sql_table_meta (
  name TEXT PRIMARY KEY,
  schema_name TEXT NOT NULL DEFAULT 'public',
  rows_label TEXT NOT NULL DEFAULT '',
  total_rows INTEGER NOT NULL DEFAULT 0,
  page_label TEXT NOT NULL DEFAULT '第 1 / 1,205 页'
);

/* ============================================================================
 * Super-agent 影子链路（P1）
 *
 * 这四张表只做「记录」，不改执行链路：事件进来 → Gate 判 → 写 decision。
 * 没有 ticket / mandate / assignment，因为 P1 不接单、不派工、不执行。
 *
 * 为什么先建这四张：Gate 的误判率是整套架构唯一的新增噪音源，
 * 在写第一行业务代码之前必须先量出来（docs/devwork-superagent-redesign.md §11）。
 * ========================================================================== */

/* 事件源：一类事件流 + 一份实例配置。read_position 是重启不重放的依据。 */
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- user | terminal | git | sql | log | schedule | ci
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  /* 采集器位点：log = 字节偏移，git = HEAD，terminal / sql = ISO 时间戳。
   * 只归采集器自己推进 —— 事件收讫（ingest）不得写这一列，
   * 否则采集器刚记下的位点会被幂等键覆盖，导致重复重扫或永久漏采。 */
  read_position TEXT NOT NULL DEFAULT '',
  /* 定时源的下次触发时刻（ISO）。存表而不是存内存定时器：
   * 进程重启后「本该 09:30 跑的那次」还得算得回来，否则关了软件一整天就不巡检了。 */
  next_fire_at TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, kind)
);

/* 线程：事件的聚线。同一线程同时只跑一个 Eval（eval_running 就是那把锁）。 */
CREATE TABLE IF NOT EXISTS thread (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id),
  asset_id TEXT,
  thread_key TEXT NOT NULL,                 -- 源内稳定键：会话 id / 文件路径 / issue 号
  title TEXT NOT NULL DEFAULT '',
  eval_running INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(source_id, thread_key)
);

/* 触发：不可变事件。(source_id, idem_key) 唯一 —— 同一事件接两次只留一条。 */
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
  disposition TEXT NOT NULL DEFAULT 'pending', -- pending | evaluated | ignored | unavailable
  decision_id TEXT,
  delivered_ticket_id TEXT,                    -- 扇出投给了哪张工单（空 = 没投）
  fanout_at TEXT,                              -- 扇出处理位点（空 = 还没判断过）
  received_at TEXT NOT NULL,
  UNIQUE(source_id, idem_key)
);

/* 决策：Eval 的产物。
 * P1 只会写 kind='ignore' 但 would_accept=1（影子接单），或 kind='unavailable'。
 * 这与 DeepSeek 原版一致：影子期记录「我本来会接」，但不建工单。 */
CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- ignore | unavailable（accept/attach/stop 留待 P2）
  strength TEXT NOT NULL,                      -- explicit | inferred
  would_accept INTEGER NOT NULL DEFAULT 0,     -- 影子期唯一有信息量的列
  reason_code TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  matched_rules TEXT NOT NULL DEFAULT '[]',
  policy_version TEXT NOT NULL DEFAULT '',
  ticket_id TEXT,                              -- P2 起才有值
  eval_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trigger_pending ON trigger(disposition, received_at);
CREATE INDEX IF NOT EXISTS idx_trigger_thread ON trigger(thread_id, received_at);
CREATE INDEX IF NOT EXISTS idx_decision_thread ON decision(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decision_created ON decision(created_at);

/* 授权草案（P1.6 / P2 前置）。
 *
 * 为什么先只建这一张、不建 ticket：Mandate 是「这一单允许动多大范围」，
 * 而它的上游（工单）还没有。先让 Range 长出来，才能回答
 * 「规则里写的关键词，能不能推出一个说得清的范围」——这是 P2 第一个会踩的坑。
 *
 * 与设计文档 §8.1 的差异（实测修正）：ticket_id 允许为空、新增 decision_id 与 status。
 * 理由：影子期一份授权由一条决策产生，还没有工单可挂。 */
CREATE TABLE IF NOT EXISTS mandate (
  id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,                    -- 由哪条决策产生
  ticket_id TEXT,                               -- P2 才有值；影子期恒 NULL
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | accepted | narrowed | rejected
  strength TEXT NOT NULL,                       -- explicit | inferred
  policy_version TEXT NOT NULL DEFAULT '',
  requester TEXT NOT NULL DEFAULT '',
  /* { assets: string[], actions: string[], assetTypes: string[],
   *   riskCeiling: 'low'|'medium'|'high', maxWrites: number } */
  scope TEXT NOT NULL DEFAULT '{}',
  matched_rules TEXT NOT NULL DEFAULT '[]',
  attention_budget INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',                -- 人的表态说明（收窄理由）
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mandate_decision ON mandate(decision_id);
CREATE INDEX IF NOT EXISTS idx_mandate_status ON mandate(status, created_at);

/* 工单（P2）。执行单元从 conversation 换成 ticket —— 会话降级为 Channel。
 * conversation_id 让执行落在一个真实会话里：message / tool_call / 审计 / 审批卡
 * 全部复用既有链路，不需要为 Worker 再造一套持久化。 */
CREATE TABLE IF NOT EXISTS ticket (
  id TEXT PRIMARY KEY,
  short_name TEXT NOT NULL,                    -- Worker 目录名 / 分支名
  workspace_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',          -- open | ended
  stage TEXT NOT NULL DEFAULT 'queued',        -- queued|working|idle|delivery|person/*
  ended_reason TEXT NOT NULL DEFAULT '',       -- done | stopped_by_person | revoked
  conversation_id TEXT,                        -- Channel：执行轨迹落在这里
  mandate_id TEXT,
  trigger_id TEXT,                             -- 起始事件
  created_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS assignment (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  worker_session TEXT NOT NULL,
  workdir TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',       -- pending | running | ended
  lease_until TEXT NOT NULL DEFAULT '',        -- 租约：进程死了也不会永远「执行中」
  heartbeat_at TEXT NOT NULL DEFAULT '',
  report TEXT NOT NULL DEFAULT '',             -- progress|waiting|ready|blocked|failed|dropped
  report_note TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

/* 订阅：上下文扇出。送上下文，不送权限 —— Mandate 才是权限。 */
CREATE TABLE IF NOT EXISTS subscription (
  ticket_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'own',            -- own | context
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, thread_id)
);

/* 待人工决定。结构化提问，不是「请看下这份报告」。 */
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

CREATE INDEX IF NOT EXISTS idx_ticket_stage ON ticket(stage, created_at);
CREATE INDEX IF NOT EXISTS idx_ticket_thread ON ticket(thread_id, state);
CREATE INDEX IF NOT EXISTS idx_assignment_ticket ON assignment(ticket_id, state);
CREATE INDEX IF NOT EXISTS idx_assignment_lease ON assignment(state, lease_until);
CREATE INDEX IF NOT EXISTS idx_attention_open ON attention(answered_at, asked_at);

/* 慢查询留痕（SQL 采集器的唯一数据源）。
 * 只在超过阈值时写一行 —— 每条查询都落库会把这张表变成第二个审计日志，
 * 而巡检只需要看「慢的那些」。 */
CREATE TABLE IF NOT EXISTS sql_trace (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  statement TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sql_trace_time ON sql_trace(created_at);

/* 内置浏览器的会话级状态。
   Agent 的 browser_navigate 工具写这里，前端浏览器 Tab 轮询后跳转 ——
   「Agent 能控制浏览器」要有一份双方都认的状态，否则只是文案。
   page_* 三列是页面快照：前端把当前页标题与正文回传，Agent 才能"看过"这页。 */
CREATE TABLE IF NOT EXISTS browser_state (
  conversation_id TEXT PRIMARY KEY,
  url TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT 'none',
  updated_at TEXT NOT NULL DEFAULT '',
  page_title TEXT NOT NULL DEFAULT '',
  page_text TEXT NOT NULL DEFAULT '',
  page_captured_at TEXT NOT NULL DEFAULT ''
);
