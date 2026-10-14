import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";

const directory = dirname(fileURLToPath(import.meta.url));
const root = join(directory, "../../..");
if (process.env.FRNESS_DESKTOP_DATA) app.setPath("userData", process.env.FRNESS_DESKTOP_DATA);
const page = new URL("../client/index.html", import.meta.url).href;
let window;
let worker;
let quitting = false;
let session;
let sessionProvider;
const state = {
  workspace: process.env.FRNESS_WORKSPACE ?? root,
  extension: process.env.FRNESS_EXTENSION ?? "",
  busy: false,
  phase: "Готов",
  messages: [],
  hasSession: false,
};
function publish() {
  if (window && !window.isDestroyed()) window.webContents.send("frness:state", state);
}
function authorize(event) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== page
  )
    throw new Error("IPC sender rejected");
}
function handle(name, action) {
  ipcMain.handle(`frness:${name}`, (event, ...args) => {
    authorize(event);
    return action(...args);
  });
}
function finish(phase) {
  state.busy = false;
  state.phase = phase;
  worker = undefined;
  publish();
  if (quitting) app.quit();
}
handle("state", () => state);
handle("workspace", async () => {
  if (state.busy) throw new Error("Дождитесь завершения запуска");
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
  if (!result.canceled && result.filePaths[0]) {
    state.workspace = result.filePaths[0];
    session = undefined;
    state.hasSession = false;
    state.messages = [];
    publish();
  }
  return state;
});
handle("new", () => {
  if (state.busy) throw new Error("Дождитесь завершения запуска");
  session = undefined;
  state.hasSession = false;
  state.messages = [];
  state.phase = "Готов";
  publish();
});
handle("stop", () => {
  if (state.busy && worker?.connected) worker.send({ kind: "stop" });
});
handle("run", (input) => {
  if (state.busy) throw new Error("Уже выполняется запрос");
  if (
    !input ||
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    Buffer.byteLength(input.prompt) > 1024 * 1024 ||
    !["codex", "claude"].includes(input.provider)
  )
    throw new Error("Проверьте запрос и выбранного агента");
  if (sessionProvider !== input.provider) {
    session = undefined;
    state.hasSession = false;
  }
  sessionProvider = input.provider;
  const answer = { role: "agent", text: "" };
  state.messages.push({ role: "user", text: input.prompt }, answer);
  state.busy = true;
  state.phase = "Агент работает";
  publish();
  const child = fork(join(directory, "worker.ts"), [], {
    cwd: root,
    execPath: process.env.FRNESS_NODE,
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  worker = child;
  let outcome;
  child.on("message", (message) => {
    if (message.kind === "text" && typeof message.text === "string") {
      answer.text += message.text;
      publish();
    }
    if (message.kind === "done") {
      session = message.result.session;
      state.hasSession = true;
      answer.text = message.result.text || answer.text;
      outcome =
        {
          completed: "Завершено",
          cancelled: "Остановлено",
          failed: "Ошибка агента",
          unknown: "Результат неизвестен. Проверьте состояние перед повтором",
        }[message.result.phase] ?? "Ошибка агента";
    }
    if (message.kind === "error") {
      outcome = message.cancelled ? "Остановлено" : `Ошибка: ${message.message}`;
    }
  });
  child.on("error", (error) => {
    outcome = `Не удалось запустить Node: ${error.message}`;
  });
  child.on("close", () =>
    finish(outcome ?? "Процесс завершился без результата. Автоматического повтора нет"),
  );
  child.send({
    kind: "run",
    workspace: state.workspace,
    extension: state.extension,
    prompt: input.prompt,
    provider: input.provider,
    ...(session ? { session } : {}),
    ...(process.env.FRNESS_AGENT_EXECUTABLE
      ? { executable: process.env.FRNESS_AGENT_EXECUTABLE }
      : {}),
  });
});
function createWindow() {
  window = new BrowserWindow({
    width: 1040,
    height: 780,
    minWidth: 620,
    minHeight: 520,
    title: "FRNESS",
    backgroundColor: "#f7f8fb",
    webPreferences: {
      preload: join(directory, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.loadURL(page);
}
app.on("before-quit", (event) => {
  if (state.busy) {
    event.preventDefault();
    quitting = true;
    if (window && !window.isDestroyed()) window.hide();
  }
});
app.on("window-all-closed", () => {});
app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "FRNESS", submenu: [{ role: "about" }, { role: "quit" }] },
      { role: "editMenu" },
      { role: "windowMenu" },
    ]),
  );
  createWindow();
  app.on("activate", () => {
    if (!window || window.isDestroyed()) createWindow();
    else window.show();
  });
});
