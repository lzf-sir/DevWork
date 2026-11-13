/**
 * 命令白名单 / 黑名单 / 敏感文件规则。
 * 判定归属在服务端：前端只展示「放行 / 拦截 / 转建议」。
 */

export interface WhitelistRule {
  id: string;
  pattern: string;
  description: string;
  dispatcher: 'builtin' | 'spawn';
}

export interface BlacklistDef {
  id: string;
  pattern: string;
  description: string;
  platform: 'all' | 'win32' | 'unix';
}

export interface SensitiveDef {
  id: string;
  pattern: string;
  description: string;
}

/** 42 条只读命令白名单：24 条 Node 内置真实输出 + 18 条 spawn 真实进程。 */
export const COMMAND_WHITELIST: WhitelistRule[] = [
  { id: 'w01', pattern: 'ls', description: '列目录（fs 真实读取）', dispatcher: 'builtin' },
  { id: 'w02', pattern: 'cat', description: '读取文件（fs）', dispatcher: 'builtin' },
  { id: 'w03', pattern: 'head', description: '文件前 N 行（fs）', dispatcher: 'builtin' },
  { id: 'w04', pattern: 'tail', description: '文件后 N 行（fs）', dispatcher: 'builtin' },
  { id: 'w05', pattern: 'grep', description: '文本匹配（fs）', dispatcher: 'builtin' },
  { id: 'w06', pattern: 'find', description: '查找文件（fs）', dispatcher: 'builtin' },
  { id: 'w07', pattern: 'wc', description: '行数 / 字节统计（fs）', dispatcher: 'builtin' },
  { id: 'w08', pattern: 'stat', description: '文件元信息（fs.statSync）', dispatcher: 'builtin' },
  { id: 'w09', pattern: 'du', description: '目录体积（fs 递归）', dispatcher: 'builtin' },
  { id: 'w10', pattern: 'df', description: '磁盘容量（fs.statfsSync）', dispatcher: 'builtin' },
  { id: 'w11', pattern: 'uname', description: '系统信息（os）', dispatcher: 'builtin' },
  { id: 'w12', pattern: 'sha256sum', description: '文件摘要（crypto）', dispatcher: 'builtin' },
  { id: 'w13', pattern: 'pwd', description: '当前工作目录（process.cwd）', dispatcher: 'builtin' },
  { id: 'w14', pattern: 'date', description: '当前时间（Date）', dispatcher: 'builtin' },
  { id: 'w15', pattern: 'whoami', description: '当前用户（os.userInfo）', dispatcher: 'builtin' },
  { id: 'w16', pattern: 'echo', description: '回显参数（无 shell）', dispatcher: 'builtin' },
  { id: 'w17', pattern: 'sort', description: '排序输入行', dispatcher: 'builtin' },
  { id: 'w18', pattern: 'uniq', description: '去重相邻行', dispatcher: 'builtin' },
  { id: 'w19', pattern: 'cut', description: '按分隔符取列', dispatcher: 'builtin' },
  { id: 'w20', pattern: 'diff', description: '两文件差异', dispatcher: 'builtin' },
  { id: 'w21', pattern: 'free', description: '内存概览（os.totalmem/freemem）', dispatcher: 'builtin' },
  { id: 'w22', pattern: 'uptime', description: '运行时长（os.uptime）', dispatcher: 'builtin' },
  { id: 'w23', pattern: 'ps', description: '进程列表（win32: tasklist /FO CSV /NH）', dispatcher: 'spawn' },
  { id: 'w24', pattern: 'id', description: '用户标识（os.userInfo）', dispatcher: 'builtin' },
  { id: 'w25', pattern: 'hostname', description: '主机名（os.hostname）', dispatcher: 'builtin' },
  { id: 'w26', pattern: 'git log', description: 'git 只读日志', dispatcher: 'spawn' },
  { id: 'w27', pattern: 'git status', description: 'git 工作区状态', dispatcher: 'spawn' },
  { id: 'w28', pattern: 'git show', description: 'git 对象查看', dispatcher: 'spawn' },
  { id: 'w29', pattern: 'git diff', description: 'git 差异', dispatcher: 'spawn' },
  { id: 'w30', pattern: 'git branch', description: 'git 分支列表（只读）', dispatcher: 'spawn' },
  { id: 'w31', pattern: 'git rev-parse', description: 'git 引用解析', dispatcher: 'spawn' },
  { id: 'w32', pattern: 'git ls-files', description: 'git 已跟踪文件', dispatcher: 'spawn' },
  { id: 'w33', pattern: 'git tag', description: 'git 标签列表', dispatcher: 'spawn' },
  { id: 'w34', pattern: 'git blame', description: 'git 逐行溯源', dispatcher: 'spawn' },
  { id: 'w35', pattern: 'docker ps', description: '容器列表（缺失时 127 降级）', dispatcher: 'spawn' },
  { id: 'w36', pattern: 'docker images', description: '镜像列表', dispatcher: 'spawn' },
  { id: 'w37', pattern: 'docker logs', description: '容器日志', dispatcher: 'spawn' },
  { id: 'w38', pattern: 'docker inspect', description: '容器元数据', dispatcher: 'spawn' },
  { id: 'w39', pattern: 'kubectl get', description: 'k8s 资源列表', dispatcher: 'spawn' },
  { id: 'w40', pattern: 'kubectl describe', description: 'k8s 资源描述', dispatcher: 'spawn' },
  { id: 'w41', pattern: 'systemctl status', description: '服务状态', dispatcher: 'spawn' },
  { id: 'w42', pattern: 'journalctl', description: '系统日志（只读参数）', dispatcher: 'spawn' },
];

/** 危险命令黑名单：全串 + 逐段双重检测，命中即 0 spawn、0 副作用。 */
export const COMMAND_BLACKLIST: BlacklistDef[] = [
  { id: 'b01', pattern: 'rm -rf', description: '递归强制删除', platform: 'all' },
  { id: 'b02', pattern: 'rm -fr', description: '递归强制删除（变体）', platform: 'all' },
  { id: 'b03', pattern: 'mkfs', description: '格式化文件系统', platform: 'all' },
  { id: 'b04', pattern: 'fdisk', description: '磁盘分区表写入', platform: 'all' },
  { id: 'b05', pattern: 'dd if=', description: '裸设备块拷贝', platform: 'all' },
  { id: 'b06', pattern: ':(){', description: 'fork bomb', platform: 'all' },
  { id: 'b07', pattern: '/dev/sd', description: '裸设备写入', platform: 'all' },
  { id: 'b08', pattern: 'shutdown', description: '关机', platform: 'all' },
  { id: 'b09', pattern: 'reboot', description: '重启', platform: 'all' },
  { id: 'b10', pattern: 'halt', description: '停机', platform: 'all' },
  { id: 'b11', pattern: 'init 0', description: '切换运行级别停机', platform: 'all' },
  { id: 'b12', pattern: 'chmod 777', description: '全开放权限', platform: 'all' },
  { id: 'b13', pattern: 'chmod -R 777', description: '递归全开放权限', platform: 'all' },
  { id: 'b14', pattern: 'git push --force', description: '强制推送覆盖远端', platform: 'all' },
  { id: 'b15', pattern: 'sudo', description: '提权执行', platform: 'all' },
  { id: 'b16', pattern: 'kill -9', description: '强制杀进程', platform: 'all' },
  { id: 'b17', pattern: 'curl | sh', description: 'curl 管道到 sh', platform: 'all' },
  { id: 'b18', pattern: 'wget | sh', description: 'wget 管道到 sh', platform: 'all' },
  { id: 'b19', pattern: 'remove-item', description: 'Windows 删除', platform: 'win32' },
  { id: 'b20', pattern: 'set-content', description: 'Windows 写入', platform: 'win32' },
  { id: 'b21', pattern: 'out-file', description: 'Windows 写入', platform: 'win32' },
  { id: 'b22', pattern: 'rd /s', description: 'Windows 递归删除', platform: 'win32' },
  { id: 'b23', pattern: 'del /f', description: 'Windows 强制删除', platform: 'win32' },
  { id: 'b24', pattern: 'reg add', description: 'Windows 注册表写入', platform: 'win32' },
  { id: 'b25', pattern: 'net user', description: 'Windows 账户变更', platform: 'win32' },
  { id: 'b26', pattern: 'sc delete', description: 'Windows 服务删除', platform: 'win32' },
  { id: 'b27', pattern: 'invoke-expression', description: '动态代码执行', platform: 'win32' },
  { id: 'b28', pattern: 'powershell -enc', description: '编码命令绕过', platform: 'win32' },
];

/** 12 条敏感文件排除规则：命中者不进索引、不进上下文、不可读不可写。 */
export const SENSITIVE_RULES: SensitiveDef[] = [
  { id: 'sr01', pattern: '.env', description: '环境变量文件' },
  { id: 'sr02', pattern: '.env.*', description: '环境变量文件变体' },
  { id: 'sr03', pattern: '*.pem', description: 'PEM 私钥 / 证书' },
  { id: 'sr04', pattern: 'id_rsa', description: 'SSH 私钥' },
  { id: 'sr05', pattern: 'id_rsa.*', description: 'SSH 私钥变体' },
  { id: 'sr06', pattern: '*.key', description: '通用密钥文件' },
  { id: 'sr07', pattern: 'secrets/', description: '密钥目录' },
  { id: 'sr08', pattern: 'credentials', description: '凭据文件' },
  { id: 'sr09', pattern: '*.p12', description: 'PKCS#12 证书' },
  { id: 'sr10', pattern: '*.pfx', description: 'PFX 证书' },
  { id: 'sr11', pattern: '*.jks', description: 'Java KeyStore' },
  { id: 'sr12', pattern: '*.keystore', description: '通用 Keystore' },
];

/** 只要出现即拒绝的 shell 元字符（引号感知拆段后仍再校验一次）。 */
export const SHELL_META = ['>', '>>', '<', '2>', '`', '$(', '|', '||', '&&', ';', '\n'];

export function isWriteAction(action: string): boolean {
  return /^(file\.write|sql\.query\.write|sql\.ddl|exec\.write|git\.write|patch\.apply|service\.restart)$/.test(action)
    || /\b(write|ddl|restart|delete|apply|truncate|drop)\b/i.test(action);
}
