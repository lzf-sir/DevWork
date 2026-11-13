const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();
console.log('[probe5] loaded');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, webviewTag: true,
  }});
  await win.loadURL('http://127.0.0.1:3001/');
  console.log('[probe5] loaded ok');
  app.exit(0);
});
