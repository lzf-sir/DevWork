/**
 * 资产快捷操作 —— 资产详情页会话坞里的一排快捷入口。
 *
 * 每一条都是**可以直接发给 Agent 的提问**，不是装饰按钮：
 * 点一下就以当前绑定的资产发起一轮对话，服务端的只读工具自动生效。
 *
 * 提问文本里显式带上资产名：模型看到的上下文更明确，
 * 也让用户在消息气泡里一眼知道这轮是冲着哪个资产去的。
 */
export interface AssetQuickAction {
  id: string;
  /** 按钮文案（短，能一眼扫完）。 */
  label: string;
  /** 点击后直接发送的提问。 */
  prompt: string;
}

function make(
  id: string,
  label: string,
  template: string,
  assetName: string,
): AssetQuickAction {
  return { id, label, prompt: template.replace('{asset}', assetName) };
}

/** 按资产类型给出快捷操作。 */
export function assetQuickActions(assetType: string, assetName: string): AssetQuickAction[] {
  switch (assetType) {
    case 'code':
      return [
        make('code-tree', '目录概览', '请概览「{asset}」的目录结构与各模块职责，只读即可。', assetName),
        make('code-todo', '找 TODO', '扫描「{asset}」里的 TODO / FIXME / HACK，列出最值得处理的 10 处并说明原因。', assetName),
        make('code-commit', '最近提交', '查看「{asset}」最近的提交记录，总结最近的改动方向与风险点。', assetName),
        make('code-retry', '排查重试', '在「{asset}」里找失败重试与超时处理逻辑，指出关键位置和风险。', assetName),
      ];
    case 'db':
      return [
        make('db-schema', '表结构概览', '列出「{asset}」的主要表、行数与关键外键关系。', assetName),
        make('db-slow', '慢查询排查', '找出「{asset}」里最可能拖慢查询的表或字段，给出索引建议（只读，不做任何改动）。', assetName),
        make('db-profile', '数据画像', '对「{asset}」的核心表做一次只读数据画像：状态分布、时间范围、异常值。', assetName),
        make('db-health', '体检 SQL', '为「{asset}」生成一份上线前的只读体检 SQL 清单。', assetName),
      ];
    case 'server':
      return [
        make('srv-status', '服务状态', '查看「{asset}」的服务状态、进程与端口占用情况。', assetName),
        make('srv-log', '日志尾部', '拉取「{asset}」最近的日志尾部，归纳异常与告警。', assetName),
        make('srv-disk', '磁盘与内存', '检查「{asset}」的磁盘与内存占用，指出风险点。', assetName),
        make('srv-cmd', '只读命令建议', '针对「{asset}」当前的告警，给我一组只读排查命令，不要执行写操作。', assetName),
      ];
    case 'kb':
      return [
        make('kb-search', '检索资料', '在「{asset}」里检索与当前问题相关的资料并给出摘要。', assetName),
        make('kb-summary', '内容概览', '概览「{asset}」覆盖的主要内容与更新情况。', assetName),
      ];
    default:
      return [
        make('asset-summary', '概览资产', '概览「{asset}」的主要内容与当前状态。', assetName),
        make('asset-risk', '风险清单', '基于「{asset}」列出当前最需要关注的风险点。', assetName),
      ];
  }
}

/** 资产类型 → 中文名（会话坞标题栏与提示文案用）。 */
export const ASSET_TYPE_LABEL: Record<string, string> = {
  code: '代码库',
  db: '数据库',
  server: '服务器',
  kb: '知识库',
};
