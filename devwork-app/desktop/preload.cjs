/**
 * 预加载桥：contextIsolation + sandbox 下仍可用 ipcRenderer / contextBridge。
 * 只暴露白名单 IPC，渲染进程拿不到 Node / fs / 进程对象。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  close: () => ipcRenderer.invoke('win:close'),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximize: () => ipcRenderer.invoke('win:maximize'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximizeChange: (callback) => {
    const listener = (_event, value) => {
      if (typeof callback === 'function') callback(Boolean(value));
    };
    ipcRenderer.on('win:maximize-changed', listener);
    return () => ipcRenderer.removeListener('win:maximize-changed', listener);
  },
  platform: () => ipcRenderer.invoke('app:platform'),
  /**
   * 待人状态推给桌面壳：窗口标题前缀 + 任务栏/Dock 徽标 + 托盘提示。
   *
   * 由渲染进程单向推送（主进程不反查）：待人清单的口径在服务端，
   * 主进程再拉一次就会出现两套账 —— 界面显示 3、任务栏显示 4。
   * payload: { count: number, level: 'answer' | 'stuck' | 'review' }
   */
  setAttention: (payload) => ipcRenderer.invoke('win:attention', payload),
  versions: () => ipcRenderer.invoke('app:versions'),
  apiBase: () => ipcRenderer.invoke('app:api-base'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openLogs: () => ipcRenderer.invoke('shell:open-logs'),
  /**
   * 系统日志目录的真实路径（app.getPath('logs')）。
   * 设置页要显示这个路径，原先写死 '~/Library/Logs/DevWork' 是 macOS 的路径，
   * 在 Windows 上等于给了一个点不开的假地址。
   */
  logsPath: () => ipcRenderer.invoke('app:logs-path'),
  pickDirectory: (options) => ipcRenderer.invoke('dialog:pick-directory', options),
  /**
   * 是否为打包态。
   *
   * 打包态下前端**不做 mock 降级**：后端不通就如实报错，
   * 而不是拿演示数据糊一层假的「一切正常」。开发态返回 false，
   * 离线兜底照旧（本地开发时后端没起也能看界面）。
   */
  isPackaged: () => ipcRenderer.invoke('app:is-packaged'),
  /**
   * 启动失败页的「重试」按钮。
   *
   * 错误页是主进程 loadURL 的 data:text/html 静态页，它唯一能做的事就是
   * 请求主进程「再试一次」：主进程会重新探活 3001，必要时重启后端子进程，
   * 就绪后把窗口切回真实页面。渲染进程拿不到任何进程/文件能力，只有这一条授权动作。
   */
  restartBackend: () => ipcRenderer.invoke('app:restart-backend'),
  /**
   * 开发者模式：切换 DevTools（停靠右侧）。
   * 返回切换后的状态（true=已打开），与 devtools-opened/closed 事件保持一致。
   */
  toggleDevTools: () => ipcRenderer.invoke('dev:toggle-devtools'),
  /** 当前 DevTools 是否打开（挂载时同步按钮高亮用）。 */
  isDevToolsOpen: () => ipcRenderer.invoke('dev:devtools-open'),
  /** 订阅 DevTools 开关状态（含 F12 等外部触发），返回退订函数。 */
  onDevToolsChange: (callback) => {
    const listener = (_event, value) => {
      if (typeof callback === 'function') callback(Boolean(value));
    };
    ipcRenderer.on('dev:devtools-changed', listener);
    return () => ipcRenderer.removeListener('dev:devtools-changed', listener);
  },
});
