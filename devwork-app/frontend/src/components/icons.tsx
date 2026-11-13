/**
 * 统一图标库 —— 全站唯一的线性 SVG 图标来源。
 *
 * 为什么不用 emoji / Unicode 几何字符：
 *  - emoji 在 Windows 上由 Segoe UI Emoji 渲染，是彩色位图，和周围的线性图标
 *    放在一起会明显「跳出来」，而且不同机器上的字形不一致；
 *  - ▤▣▥▧▦◫⌗ 这类字符依赖系统字体是否收录，缺字时退化成豆腐块，
 *    且它们没有语义（▣ 到底是代码库还是服务器？只能靠约定猜）。
 *
 * 统一规范：
 *  - 网格 16×16，描边 1.4px，currentColor 继承，线帽线角一律 round；
 *  - 视觉重心居中，图标在 12/14/15/16px 下都不糊；
 *  - 默认 aria-hidden，图标本身不承载语义（语义由旁边的文字 / title 承担）。
 */

import React from 'react';

export interface IconProps {
  /** 像素尺寸，默认 15（与既有内联图标一致）。 */
  size?: number;
  /** 描边宽度，默认 1.4。 */
  strokeWidth?: number;
  className?: string;
}

/** 所有图标的公共骨架：统一尺寸、统一描边、统一 currentColor。 */
function Svg({
  size = 15,
  strokeWidth = 1.4,
  className,
  children,
  fill = 'none',
}: IconProps & {
  children: React.ReactNode;
  fill?: string;
}): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={fill}
      stroke={fill === 'none' ? 'currentColor' : 'none'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* ===================== 基础动作 ===================== */

/** 放大镜：全局搜索、过滤。 */
export function SearchIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <circle cx="7.2" cy="7.2" r="4.3" />
      <path d="M10.4 10.4L13.6 13.6" />
    </Svg>
  );
}

/** 加号：新建。 */
export function PlusIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </Svg>
  );
}

/** 减号：移除。 */
export function MinusIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M3.4 8h9.2" />
    </Svg>
  );
}

/** 三点：更多操作。 */
export function DotsIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className} fill="currentColor">
      <circle cx="3.4" cy="8" r="1.15" />
      <circle cx="8" cy="8" r="1.15" />
      <circle cx="12.6" cy="8" r="1.15" />
    </Svg>
  );
}

/** 叉：关闭。 */
export function CloseIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

/** 对勾：成功 / 已完成。 */
export function CheckIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M3.4 8.4l3.1 3.1 6.1-7" />
    </Svg>
  );
}

/** 感叹号三角：警告 / 需注意。 */
export function WarningIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M8 2.6l5.9 10.2H2.1L8 2.6z" />
      <path d="M8 6.7v2.9" />
      <circle cx="8" cy="11.3" r=".72" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 感叹号圆：阻断 / 失败。 */
export function ErrorIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <circle cx="8" cy="8" r="5.9" />
      <path d="M8 4.8v3.6" />
      <circle cx="8" cy="11" r=".72" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 圆圈问号：提示 / 帮助。 */
export function InfoIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <circle cx="8" cy="8" r="5.9" />
      <path d="M6.4 6.3a1.7 1.7 0 113.1 1.2c-.5.5-1.5.9-1.5 1.9" />
      <circle cx="8" cy="11.4" r=".72" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/* ===================== 方向与箭头 ===================== */

/** 箭头方向：left / right / up / down。 */
export function ArrowIcon({
  dir = 'down',
  size,
  strokeWidth,
  className,
}: IconProps & { dir?: 'left' | 'right' | 'up' | 'down' }): React.ReactElement {
  const paths = {
    down: 'M3.8 6.2L8 10.4l4.2-4.2',
    up: 'M3.8 9.8L8 5.6l4.2 4.2',
    left: 'M9.8 3.8L6.2 8l3.6 4.2',
    right: 'M6.2 3.8L9.8 8l-3.6 4.2',
  };
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d={paths[dir]} />
    </Svg>
  );
}

/** 折叠箭头：向下三角（可旋转）。 */
export function CaretIcon({
  dir = 'down',
  size,
  strokeWidth,
  className,
}: IconProps & { dir?: 'down' | 'right' }): React.ReactElement {
  const d = dir === 'down' ? 'M4.2 6.3L8 10l3.8-3.7' : 'M6.3 4.2L10 8l-3.7 3.8';
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d={d} />
    </Svg>
  );
}

/** 双箭头（上下）：排序 - 升序。 */
export function SortAscIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M8 12.4V4.2M5.2 7L8 4.2 10.8 7" />
    </Svg>
  );
}

/** 双箭头（上下）：排序 - 降序。 */
export function SortDescIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M8 3.6v8.2M5.2 9l2.8 2.8L10.8 9" />
    </Svg>
  );
}

/** 上下双向箭头：可排序（未激活）。 */
export function SortIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M5.4 6.2L6.9 4.6l1.5 1.6M6.9 4.8v6.6M10.6 9.8L9.1 11.4l-1.5-1.6M9.1 11.2V4.6" />
    </Svg>
  );
}

/* ===================== 资源类型 ===================== */

/** 数据库：圆柱 + 底线。 */
export function DatabaseIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <ellipse cx="8" cy="4.1" rx="4.6" ry="1.8" />
      <path d="M3.4 4.1v7.8c0 1 2.05 1.8 4.6 1.8s4.6-.8 4.6-1.8V4.1" />
      <path d="M3.4 8c0 1 2.05 1.8 4.6 1.8s4.6-.8 4.6-1.8" />
    </Svg>
  );
}

/** 代码库：代码括号。 */
export function CodeIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M5.6 4.6L2.6 8l3 3.4M10.4 4.6L13.4 8l-3 3.4" />
      <path d="M9.2 2.8l-2.4 10.4" />
    </Svg>
  );
}

/** 服务器：机架。 */
export function ServerIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="2.6" y="2.8" width="10.8" height="4.2" rx="1.3" />
      <rect x="2.6" y="9" width="10.8" height="4.2" rx="1.3" />
      <path d="M5.1 4.9h.02M5.1 11.1h.02" />
    </Svg>
  );
}

/** 知识库：书本。 */
export function BookIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M2.8 3.6h4.1c.6 0 1.1.5 1.1 1.1v7.7c0-.6-.5-1.1-1.1-1.1H2.8V3.6z" />
      <path d="M13.2 3.6H9.1c-.6 0-1.1.5-1.1 1.1v7.7c0-.6.5-1.1 1.1-1.1h4.1V3.6z" />
    </Svg>
  );
}

/** 表格：网格。 */
export function TableIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
      <path d="M2.5 6.5h11M2.5 10h11M6.6 6.5V13" />
    </Svg>
  );
}

/** 视图：双层叠放的表格。 */
export function ViewIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="2.5" y="2.8" width="8.6" height="8" rx="1.3" />
      <path d="M5.4 13.2h6.8a1.3 1.3 0 001.3-1.3V5.1" />
    </Svg>
  );
}

/** 索引：钥匙 / 索引条目。 */
export function IndexIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M2.9 4.2h10.2M2.9 7.5h10.2M2.9 10.8h6.4" />
      <circle cx="12" cy="10.8" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 终端：命令行窗口。 */
export function TerminalIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="1.9" y="2.9" width="12.2" height="10.2" rx="1.6" />
      <path d="M4.4 6.3l2 1.9-2 1.9M8.2 10.6h3.4" />
    </Svg>
  );
}

/** 模型 / 芯片。 */
export function ModelIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="3.4" y="3.4" width="9.2" height="9.2" rx="2" />
      <circle cx="8" cy="8" r="1.9" />
      <path d="M8 1.5v1.9M8 12.6v1.9M1.5 8h1.9M12.6 8h1.9" />
    </Svg>
  );
}

/** 技能：闪电。 */
export function SkillIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M9 1.6L3.4 8.6h3.3L6.4 14.4l6.1-7.5H9.2L9 1.6z" />
    </Svg>
  );
}

/** @ 引用。 */
export function AtIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M10.5 8v1.5a1.4 1.4 0 002.8 0V8a5.3 5.3 0 10-2.9 4.7" />
    </Svg>
  );
}

/** 回形针：附件。 */
export function ClipIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M10.6 4.4L5.7 9.3a1.75 1.75 0 002.5 2.5l4.8-4.8a2.9 2.9 0 10-4.1-4.1L4 8.3a4.3 4.3 0 106.1 6.1" />
    </Svg>
  );
}

/** 文件：通用文档。 */
export function FileIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M9.2 2.4H4.6a1.4 1.4 0 00-1.4 1.4v8.4a1.4 1.4 0 001.4 1.4h6.8a1.4 1.4 0 001.4-1.4V6l-3.6-3.6z" />
      <path d="M9.2 2.4V6h3.6" />
    </Svg>
  );
}

/** 文件夹。 */
export function FolderIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M2.6 4.6a1.3 1.3 0 011.3-1.3h2.4l1.5 1.8h4.3a1.3 1.3 0 011.3 1.3v6.1a1.3 1.3 0 01-1.3 1.3H3.9a1.3 1.3 0 01-1.3-1.3V4.6z" />
    </Svg>
  );
}

/** 铅笔：编辑 / 新建查询。 */
export function EditIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M11.2 2.6l2.2 2.2-7.4 7.4-2.9.7.7-2.9 7.4-7.4z" />
      <path d="M9.8 4l2.2 2.2" />
    </Svg>
  );
}

/* ===================== 状态与动作 ===================== */

/** 锁：只读。 */
export function LockIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.6" />
      <path d="M5.6 7V5.4a2.4 2.4 0 014.8 0V7" />
    </Svg>
  );
}

/** 开锁：读写。 */
export function UnlockIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="3.4" y="7" width="9.2" height="6.4" rx="1.6" />
      <path d="M5.6 7V5.4a2.4 2.4 0 014.8 0" />
    </Svg>
  );
}

/** 齿轮：设置。 */
export function GearIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.9v1.8M8 12.3v1.8M1.9 8h1.8M12.3 8h1.8M3.8 3.8l1.3 1.3M10.9 10.9l1.3 1.3M12.2 3.8l-1.3 1.3M5.1 10.9l-1.3 1.3" />
    </Svg>
  );
}

/** 下载箭头：产物下载。 */
export function DownloadIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M8 2.6v7.2M5.2 7l2.8 2.8L10.8 7M3.4 13h9.2" />
    </Svg>
  );
}

/** 发送：纸飞机（与既有上箭头不同，语义更准）。 */
export function SendIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M14 2L7.2 8.9M14 2l-4.6 12-2.2-5.1L2 6.7 14 2z" />
    </Svg>
  );
}

/** 播放：执行。 */
export function PlayIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className} fill="currentColor">
      <path d="M5.2 3.4l7.2 4.6-7.2 4.6V3.4z" />
    </Svg>
  );
}

/** 图表：用量分析。 */
export function ChartIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="2.4" y="2.9" width="11.2" height="10.2" rx="1.6" />
      <path d="M4.6 10.6l2.6-2.7 1.9 1.7 2.3-2.9" />
    </Svg>
  );
}

/** 侧栏面板：左 / 右。 */
export function PanelIcon({
  side = 'left',
  size,
  strokeWidth,
  className,
}: IconProps & { side?: 'left' | 'right' }): React.ReactElement {
  const divider = side === 'left' ? 'M6.2 3.1v9.8' : 'M9.8 3.1v9.8';
  const fill = side === 'left' ? 'M3.7 4.7h1.9v6.6H3.7z' : 'M10.4 4.7h1.9v6.6h-1.9z';
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="2.4" y="2.9" width="11.2" height="10.2" rx="2.1" />
      <path d={divider} />
      <path d={fill} fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 刷新 / 重建。 */
export function RefreshIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M13.2 7.2A5.3 5.3 0 003.4 5.1M2.8 8.8a5.3 5.3 0 009.8 2.1" />
      <path d="M12.4 2.9v3.4H9M3.6 13.1V9.7H7" />
    </Svg>
  );
}

/** 在外部打开：跳出当前应用。 */
export function ExternalIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M9.4 2.6h4v4" />
      <path d="M13.4 2.6L7.8 8.2" />
      <path d="M11.6 9.6v2.8a1.4 1.4 0 01-1.4 1.4H3.9a1.4 1.4 0 01-1.4-1.4V6.1a1.4 1.4 0 011.4-1.4h2.8" />
    </Svg>
  );
}

/** 复制。 */
export function CopyIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="5.6" y="5.6" width="7.8" height="7.8" rx="1.4" />
      <path d="M10.4 5.6V4a1.4 1.4 0 00-1.4-1.4H4a1.4 1.4 0 00-1.4 1.4v5a1.4 1.4 0 001.4 1.4h1.6" />
    </Svg>
  );
}

/** 眼睛：显隐切换。 */
export function EyeIcon({
  off = false,
  size,
  strokeWidth,
  className,
}: IconProps & { off?: boolean }): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M1.8 8s2.4-4 6.2-4 6.2 4 6.2 4-2.4 4-6.2 4-6.2-4-6.2-4z" />
      <circle cx="8" cy="8" r="1.8" />
      {off ? <path d="M3 13L13 3" /> : null}
    </Svg>
  );
}

/** 筛选：漏斗。 */
export function FilterIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M2.6 3.4h10.8l-4.2 5v4.4l-2.4 1.4V8.4l-4.2-5z" />
    </Svg>
  );
}

/** 用户：成员。 */
export function UserIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <circle cx="8" cy="5.6" r="2.7" />
      <path d="M3 13.4a5 5 0 0110 0" />
    </Svg>
  );
}

/** 组织：多人。 */
export function OrgIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <circle cx="6" cy="5.8" r="2.4" />
      <path d="M1.9 13.2a4.1 4.1 0 018.2 0" />
      <path d="M10.8 3.7a2.4 2.4 0 010 4.6M12 9.6a4 4 0 012 3.6" />
    </Svg>
  );
}

/** 项目：网格。 */
export function ProjectIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="2.5" y="2.5" width="4.8" height="4.8" rx="1.2" />
      <rect x="8.7" y="2.5" width="4.8" height="4.8" rx="1.2" />
      <rect x="2.5" y="8.7" width="4.8" height="4.8" rx="1.2" />
      <rect x="8.7" y="8.7" width="4.8" height="4.8" rx="1.2" />
    </Svg>
  );
}

/** 盾牌：权限 / 隐私。 */
export function ShieldIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M8 1.9l5 2v4c0 3-2.1 5.2-5 6.2-2.9-1-5-3.2-5-6.2v-4l5-2z" />
      <path d="M6.1 7.9l1.4 1.4 2.6-2.8" />
    </Svg>
  );
}

/** 调色板：外观。 */
export function PaletteIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M8 13.8a5.8 5.8 0 110-11.6c3.2 0 5.8 2 5.8 4.4 0 1.5-1.2 2.4-2.6 2.4h-1.3c-1 0-1.7.7-1.7 1.6 0 .4.2.7.4 1 .2.3.4.6.4 1 0 .7-.5 1.2-1 1.2z" />
      <circle cx="5.6" cy="6.4" r=".9" fill="currentColor" stroke="none" />
      <circle cx="8.6" cy="4.8" r=".9" fill="currentColor" stroke="none" />
      <circle cx="11.3" cy="6.6" r=".9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** 会话：对话气泡。 */
export function ChatIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M13.6 8.9c0 2.5-2.5 4.5-5.6 4.5-.8 0-1.6-.14-2.3-.4l-3.1 1 1-2.6A4.2 4.2 0 012.4 8.9c0-2.5 2.5-4.5 5.6-4.5s5.6 2 5.6 4.5z" />
    </Svg>
  );
}

/* ===================== 类型 → 图标 映射 ===================== */

/** 资产类型 → 图标组件。 */
const TYPE_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  db: DatabaseIcon,
  code: CodeIcon,
  server: ServerIcon,
  kb: BookIcon,
};

/** 按资产类型渲染图标；type 为空时回落到默认的代码库图标。 */
export function AssetTypeIcon({
  type,
  size = 14,
  strokeWidth,
  className,
}: IconProps & { type?: string }): React.ReactElement {
  const Cmp = (type && TYPE_ICONS[type]) || CodeIcon;
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} />;
}

/** 归档箱：设置页「会话归档」分区图标。 */
export function ArchiveIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <rect x="2.2" y="3" width="11.6" height="3.2" rx="0.9" />
      <path d="M3.4 6.2v6.3a1 1 0 0 0 1 1h7.2a1 1 0 0 0 1-1V6.2" />
      <path d="M6.5 9.1h3" />
    </Svg>
  );
}

/* ===================== 文件类型图标 ===================== */

/** Java：咖啡杯。 */
export function JavaFileIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M3.8 6.6h7.2v4.6a2.1 2.1 0 01-2.1 2.1H5.9a2.1 2.1 0 01-2.1-2.1V6.6z" />
      <path d="M11 7.8h1.2a1.7 1.7 0 010 3.4h-.6" />
      <path d="M5.8 2.4c0 .8-.9.8-.9 1.7M8 2c0 .8-.9.8-.9 1.7M10.2 2.4c0 .8-.9.8-.9 1.7" />
    </Svg>
  );
}

/** JSON / 配置结构：花括号。 */
export function JsonFileIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M6.2 2.6c-1.2 0-1.9.7-1.9 1.9v1.7c0 1-.6 1.7-1.6 1.7 1 0 1.6.7 1.6 1.7v1.7c0 1.2.7 1.9 1.9 1.9" />
      <path d="M9.8 2.6c1.2 0 1.9.7 1.9 1.9v1.7c0 1 .6 1.7 1.6 1.7-1 0-1.6.7-1.6 1.7v1.7c0 1.2-.7 1.9-1.9 1.9" />
    </Svg>
  );
}

/** YAML / 配置文件：调节滑块。 */
export function ConfigFileIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M2.4 5.2h11.2M2.4 8h11.2M2.4 10.8h11.2" />
      <circle cx="5.6" cy="5.2" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="7.2" cy="10.8" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Markdown：M 形 + 下箭头。 */
export function MarkdownFileIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M2.2 12.4V3.6h2l2.8 5 2.8-5h2v8.8" />
      <path d="M12.6 3.6v6.4M10.8 8.2l1.8 1.8 1.8-1.8" />
    </Svg>
  );
}

/** CSS / 样式：井号。 */
export function StyleFileIcon({ size, strokeWidth, className }: IconProps): React.ReactElement {
  return (
    <Svg size={size} strokeWidth={strokeWidth} className={className}>
      <path d="M5.4 2.8L4 13.2M11.6 2.8L10.2 13.2M2.8 5.8h10.4M2.4 10.2h10.4" />
    </Svg>
  );
}

/* ---------- 扩展名 → 图标 / 颜色 映射 ---------- */

const EXT_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  java: JavaFileIcon,
  json: JsonFileIcon,
  yml: ConfigFileIcon, yaml: ConfigFileIcon, toml: ConfigFileIcon,
  ini: ConfigFileIcon, conf: ConfigFileIcon, cfg: ConfigFileIcon, env: ConfigFileIcon,
  md: MarkdownFileIcon, markdown: MarkdownFileIcon,
  css: StyleFileIcon, scss: StyleFileIcon, sass: StyleFileIcon, less: StyleFileIcon,
  js: CodeIcon, jsx: CodeIcon, mjs: CodeIcon, cjs: CodeIcon,
  ts: CodeIcon, tsx: CodeIcon,
  xml: CodeIcon, html: CodeIcon, htm: CodeIcon, svg: CodeIcon,
  sh: TerminalIcon, bash: TerminalIcon, zsh: TerminalIcon, bat: TerminalIcon, ps1: TerminalIcon,
};

/** 扩展名 → 语义配色（与图标形配合，让树一眼可扫）。 */
const EXT_COLORS: Record<string, string> = {
  java: '#e76f00', kt: '#a97bff',
  js: '#b8a13a', jsx: '#61dafb', mjs: '#b8a13a', cjs: '#b8a13a',
  ts: '#3178c6', tsx: '#3178c6',
  json: '#8cb43e', yml: '#d4722a', yaml: '#d4722a', toml: '#d4722a',
  ini: '#8b93a1', conf: '#8b93a1', cfg: '#8b93a1', env: '#8b93a1',
  md: '#519aba', markdown: '#519aba',
  css: '#6a9fb5', scss: '#c6538c', sass: '#c6538c', less: '#6a9fb5',
  xml: '#e76f00', html: '#e76f00', htm: '#e76f00', svg: '#d4a017',
  sh: '#89e051', bash: '#89e051', zsh: '#89e051', bat: '#89e051', ps1: '#4f8bd4',
  sql: '#e38c00', py: '#3572a5', go: '#00add8', rs: '#dea584',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', webp: '#a074c4',
  pdf: '#e05c5c', doc: '#4f8bd4', docx: '#4f8bd4', xls: '#3eaf6f', xlsx: '#3eaf6f',
  zip: '#c9a227', tar: '#c9a227', gz: '#c9a227',
  lock: '#c9a227', log: '#8b93a1',
};

/**
 * 文件类型图标：按扩展名返回专属图标 + 语义配色。
 * 目录请配合 FolderIcon 使用；未知扩展名回落通用 FileIcon + 灰色。
 */
export function FileTypeIcon({
  name,
  size = 13,
  strokeWidth,
  className,
}: IconProps & { name: string }): React.ReactElement {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  const Cmp = EXT_ICONS[ext] || FileIcon;
  const color = EXT_COLORS[ext] || 'var(--gray-400)';
  return (
    <span style={{ color, display: 'inline-flex', flex: '0 0 auto' }} aria-hidden="true">
      <Cmp size={size} strokeWidth={strokeWidth} className={className} />
    </span>
  );
}

/** 旧的 Unicode 字符 → 图标组件（数据侧仍下发字符，渲染侧按字符兜底）。 */
const GLYPH_ICONS: Record<string, (props: IconProps) => React.ReactElement> = {
  '▤': DatabaseIcon,
  '▣': CodeIcon,
  '▥': ServerIcon,
  '▧': BookIcon,
  '▦': TableIcon,
  '◫': ViewIcon,
  '⌗': IndexIcon,
};

/**
 * 按「类型优先、字符兜底」渲染资产图标。
 *
 * 数据侧下发的是字符（'▤'）而非类型时（离线兜底表就是如此），仍要能画出正确图标。
 */
export function AssetIcon({
  type,
  glyph,
  size = 14,
  strokeWidth,
  className,
}: IconProps & { type?: string; glyph?: string }): React.ReactElement {
  if (type && TYPE_ICONS[type]) {
    const Cmp = TYPE_ICONS[type];
    return <Cmp size={size} strokeWidth={strokeWidth} className={className} />;
  }
  const Cmp = (glyph ? GLYPH_ICONS[glyph] : undefined) || CodeIcon;
  return <Cmp size={size} strokeWidth={strokeWidth} className={className} />;
}
