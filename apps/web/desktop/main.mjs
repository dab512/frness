import { fork } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { providerModes } from "../../../plugins/agent-runtime/adapters/modes.mjs";

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
  pluginBusy: false,
  pluginRevision: "",
  assembly: null,
  phase: "Готов",
  messages: [],
  hasSession: false,
  providerModes,
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
async function plugins(source) {
  if (state.busy || state.pluginBusy) throw new Error("Дождитесь завершения запуска");
  state.pluginBusy = true;
  state.phase = "Проверка плагинов";
  publish();
  await new Promise((resolve) => {
    const child = fork(join(directory, "plugin-worker.ts"), [], {
      cwd: root,
      execPath: process.env.FRNESS_NODE,
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let success = false;
    child.on("message", (message) => {
      if (message.kind === "plugins") {
        state.extension = message.source;
        state.pluginRevision = message.revision;
        state.assembly = message.assembly;
        success = true;
      } else if (message.kind === "error") state.phase = `Плагин не подключён: ${message.message}`;
    });
    child.on("error", (error) => {
      state.phase = error.message;
    });
    child.on("close", () => {
      state.pluginBusy = false;
      if (success) state.phase = "Плагины готовы";
      publish();
      if (quitting) app.quit();
      resolve();
    });
    child.send({
      workspace: state.workspace,
      ...(source ? { source } : {}),
      ...(process.env.FRNESS_AGENT_EXECUTABLE
        ? { executable: process.env.FRNESS_AGENT_EXECUTABLE }
        : {}),
    });
  });
}
handle("plugin", async () => {
  if (state.busy || state.pluginBusy) throw new Error("Дождитесь завершения запуска");
  const result = await dialog.showOpenDialog(window, {
    properties: ["openFile"],
    filters: [{ name: "FRNESS extension", extensions: ["ts", "mjs", "js"] }],
  });
  if (!result.canceled && result.filePaths[0]) await plugins(result.filePaths[0]);
});
handle("reload", async () => {
  if (!state.extension) throw new Error("Сначала подключите extension.ts");
  await plugins(state.extension);
});
handle("workspace", async () => {
  if (state.busy || state.pluginBusy) throw new Error("Дождитесь завершения запуска");
  const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
  if (!result.canceled && result.filePaths[0]) {
    state.workspace = result.filePaths[0];
    session = undefined;
    state.hasSession = false;
    state.messages = [];
    state.extension = "";
    state.pluginRevision = "";
    state.assembly = null;
    await plugins();
    publish();
  }
  return state;
});
handle("new", () => {
  if (state.busy || state.pluginBusy) throw new Error("Дождитесь завершения запуска");
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
  if (state.busy || state.pluginBusy) throw new Error("Уже выполняется запрос");
  if (
    !input ||
    typeof input.prompt !== "string" ||
    !input.prompt.trim() ||
    Buffer.byteLength(input.prompt) > 1024 * 1024 ||
    !["codex", "claude"].includes(input.provider) ||
    (input.mode !== undefined &&
      !providerModes[input.provider]?.some((mode) => mode.id === input.mode))
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
      const update = message.result.pluginUpdate;
      if (update?.ok) {
        state.pluginRevision = update.revision;
        state.extension = update.source;
        state.assembly = update.assembly;
      }
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
      if (update && !update.ok) outcome += `; плагин не подключён: ${update.message}`;
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
    extension: state.pluginRevision ? "" : state.extension,
    prompt: input.prompt,
    provider: input.provider,
    ...(input.mode ? { mode: input.mode } : {}),
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
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.loadURL(page);
}
app.on("before-quit", (event) => {
  quitting = true;
  if (state.busy || state.pluginBusy) {
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
  plugins().catch((error) => {
    state.phase = error.message;
    publish();
  });
  app.on("activate", () => {
    if (!window || window.isDestroyed()) createWindow();
    else window.show();
  });
});
