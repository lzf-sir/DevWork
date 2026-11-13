const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();
console.log('[probe6] loaded');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 600, show: false });
  try {
    await win.loadURL('https://example.com');
    console.log('[probe6] external loaded ok');
  } catch (e) {
    console.log('[probe6] external failed:', e.message);
  }
  app.exit(0);
});
