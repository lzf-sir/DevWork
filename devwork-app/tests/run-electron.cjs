/**
 * Electron 测试包装器。
 *
 * 为什么需要它：直接 `npm run test:db:visual` 时，npm 会给子进程注入
 * ELECTRON_RUN_AS_NODE=1，Electron 于是以纯 Node 模式启动，
 * `require('electron')` 拿到的是模块路径字符串而不是 API 对象，
 * 脚本会静默挂住。
 *
 * 这个包装器显式清掉该变量再拉起 Electron，并透传退出码，
 * 让 CI / npm 脚本和命令行直接跑的行为一致。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const script = process.argv[2];
if (!script) {
  console.error('用法: node tests/run-electron.cjs <script.cjs>');
  process.exit(2);
}

const electronBin = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'electron.exe',
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, [path.resolve(__dirname, script)], {
  cwd: path.join(__dirname, '..'),
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (error) => {
  console.error('[run-electron] 启动失败:', error);
  process.exit(1);
});
