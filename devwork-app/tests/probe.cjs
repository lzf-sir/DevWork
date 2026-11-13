const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();
console.log('[probe] script loaded');
app.whenReady().then(async () => {
  console.log('[probe] ready');
  const win = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, webviewTag: true,
      preload: path.join(ROOT, 'electron', 'preload.cjs'),
    },
  });
  console.log('[probe] window created');
  await win.loadURL('http://127.0.0.1:3001/');
  console.log('[probe] loaded');
  await new Promise((r) => setTimeout(r, 2000));
  const has = await win.webContents.executeJavaScript('!!window.desktop');
  console.log('[probe] window.desktop =', has);
  app.exit(0);
});
