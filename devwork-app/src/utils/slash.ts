/**
 * 斜杠命令表 —— 输入框「/」菜单里的**客户端**命令。
 *
 * 只登记真的能执行的命令：每一条都对应一个真实动作（新建会话 / 导出 / 切模型）。
 * 不放「敬请期待」之类的占位项 —— 点了没反应的命令比没有更让人失望。
 *
 * 技能不在这里：技能由服务端登记表（/api/skills）提供，前端不另写一份。
 */

export interface SlashCommandSpec {
  id: string;
  label: string;
  desc: string;
  /** 过滤关键字：中英文都留一份，用户按拼音或英文都能搜到。 */
  keywords: string[];
}

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { id: 'model', label: '/模型', desc: '切换本次会话使用的模型', keywords: ['model', '模型', '切换'] },
  { id: 'skills', label: '/技能清单', desc: '查看服务端登记的全部技能', keywords: ['skill', 'skills', '技能', '清单'] },
  { id: 'assets', label: '/引用资产', desc: '列出可以被 @ 引用的资产', keywords: ['asset', 'assets', '资产', '引用'] },
  { id: 'new', label: '/新会话', desc: '新建一个会话', keywords: ['new', '新', '会话'] },
  { id: 'export', label: '/导出会话', desc: '把当前会话导出为 Markdown 文件', keywords: ['export', '导出'] },
  { id: 'clear', label: '/清空输入', desc: '清空当前输入框', keywords: ['clear', '清空'] },
  { id: 'help', label: '/快捷键', desc: '查看全局快捷键速查', keywords: ['help', '快捷键', '帮助'] },
];

/** 按关键字过滤命令（名称 + 关键字 + 描述都参与匹配）。 */
export function filterSlashCommands(items: SlashCommandSpec[], query: string): SlashCommandSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q)
      || item.desc.toLowerCase().includes(q)
      || item.keywords.some((keyword) => keyword.toLowerCase().includes(q)),
  );
}
