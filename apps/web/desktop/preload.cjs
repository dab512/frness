const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("frness", {
  state: () => ipcRenderer.invoke("frness:state"),
  workspace: () => ipcRenderer.invoke("frness:workspace"),
  newSession: () => ipcRenderer.invoke("frness:new"),
  run: (input) => ipcRenderer.invoke("frness:run", input),
  stop: () => ipcRenderer.invoke("frness:stop"),
  observe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("frness:state", listener);
    return () => ipcRenderer.removeListener("frness:state", listener);
  },
});
