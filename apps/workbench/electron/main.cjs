const { app, BrowserWindow, shell } = require("electron");

const WORKBENCH_URL = process.env.FREE_WORKBENCH_URL || "http://127.0.0.1:8790";

function createWindow() {
  const window = new BrowserWindow({
    backgroundColor: "#FFFDF7",
    height: 900,
    minHeight: 700,
    minWidth: 1024,
    title: "Free Workbench",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
    width: 1280,
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  void window.loadURL(WORKBENCH_URL);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
