const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();
console.log('[probe3] loaded');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false,
    preload: path.join(ROOT, 'electron', 'preload.cjs'),
  }});
  await win.loadURL('http://127.0.0.1:3001/');
  console.log('[probe3] loaded ok');
  const has = await win.webContents.executeJavaScript('!!window.desktop');
  console.log('[probe3] window.desktop =', has);
  app.exit(0);
});
