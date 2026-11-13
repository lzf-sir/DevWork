const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();
console.log('[probe2] loaded');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  await win.loadURL('http://127.0.0.1:3001/');
  console.log('[probe2] loaded ok');
  await new Promise((r) => setTimeout(r, 1500));
  app.exit(0);
});
