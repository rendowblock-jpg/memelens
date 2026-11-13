// The smallest Electron app there is: one empty window and a DevTools port. scripts/audit-states.mjs drives it over the
// Chrome DevTools protocol and points it at the preview build, so every screen state can be measured in a real Chromium
// without the engine, the network or the installer. It is never packaged and has no preload, no IPC and no access to the app.
const { app, BrowserWindow } = require("electron");

const port = process.env.AUDIT_PORT;
if (!port) throw new Error("AUDIT_PORT is not set");
app.commandLine.appendSwitch("remote-debugging-port", port);
app.commandLine.appendSwitch("remote-allow-origins", "*");

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1400, height: 900, webPreferences: { sandbox: true, contextIsolation: true } });
  win.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
