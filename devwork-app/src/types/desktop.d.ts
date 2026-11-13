/** Electron 桌面外壳注入的只读桥；Web 模式下 window.desktop 不存在，调用方一律用可选链。 */
export interface DesktopVersions {
  electron: string;
  node: string;
  chrome: string;
}

export interface DesktopApi {
  close(): Promise<void>;
  minimize(): Promise<void>;
  maximize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onMaximizeChange(callback: (value: boolean) => void): () => void;
  platform(): Promise<'win32' | 'darwin' | 'linux'>;
  versions(): Promise<DesktopVersions>;
  apiBase(): Promise<string>;
  openExternal(url: string): Promise<void>;
  /** 打开系统日志目录（Electron app.getPath('logs')）。Web 模式下 window.desktop 不存在。 */
  openLogs(): Promise<boolean>;
  /** 系统日志目录的真实路径。Web 模式下 window.desktop 不存在。 */
  logsPath(): Promise<string>;
  pickDirectory(options?: { defaultPath?: string }): Promise<string | null>;
  /** 切换开发者工具（停靠窗口右侧），返回切换后是否打开。 */
  toggleDevTools(): Promise<boolean>;
  /** 开发者工具当前是否打开。 */
  isDevToolsOpen(): Promise<boolean>;
  /** 订阅开发者工具开关状态（F12 等外部触发也会推送），返回退订函数。 */
  onDevToolsChange(callback: (open: boolean) => void): () => void;
}

declare global {
  interface Window {
    desktop?: DesktopApi;
  }
}

export {};
