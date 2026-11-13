const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();
console.log('[probe4] loaded');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: false,
    preload: path.join(__dirname, '..', 'tmp', 'mini-preload.cjs'),
  }});
  await win.loadURL('http://127.0.0.1:3001/');
  console.log('[probe4] loaded ok');
  const has = await win.webContents.executeJavaScript('!!window.mini');
  console.log('[probe4] window.mini =', has);
  app.exit(0);
});
