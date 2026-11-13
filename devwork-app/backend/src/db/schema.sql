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
