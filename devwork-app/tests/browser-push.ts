/**
 * 测试辅助：让 Agent 真的导航内置浏览器（走真实的 browser(mode=navigate) 工具链）。
 *
 * 用法：node_modules/.bin/tsx tests/browser-push.ts <conversationId> <url>
 * 与服务进程共享同一个 SQLite 库（WAL 模式支持并发读写）。
 */
import { initDatabase } from '../backend/src/db/database';
import { deriveToolFace } from '../backend/src/config/tool-catalog';
import { executeAgentTool } from '../backend/src/services/agent-tools';

const conversationId = process.argv[2] ?? 'c-gmv';
const url = process.argv[3] ?? 'http://127.0.0.1:3001/api/health';

/* 自托管 / 自动化测试场景：Agent 允许访问私有网段（默认禁止）。
 * 读取在函数体内求值，所以这里设置 env 后立即生效。 */
process.env.DEVWORK_BROWSER_ALLOW_PRIVATE = '1';

/* seed 传空函数：数据已由服务进程播种，这里只是拿到同一个库连接。 */
initDatabase(() => undefined);

const face = deriveToolFace('w-ops');
const tool = face.all.find((item) => item.name === 'browser');
const result = await executeAgentTool('browser', { mode: 'navigate', url }, tool, {
  assetId: 'w-ops',
  workspaceId: 'w-ops',
  conversationId,
  identity: { name: '测试员', role: 'admin', org: 'DevWork', actor: 'user', source: 'user' },
});

if (!result.ok) {
  console.error('[browser-push] 失败：', result.result);
  process.exit(1);
}
console.log('[browser-push] 已导航：', url);
