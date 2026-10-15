const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("frness", {
  plugin: () => ipcRenderer.invoke("frness:plugin"),
  reload: () => ipcRenderer.invoke("frness:reload"),
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
