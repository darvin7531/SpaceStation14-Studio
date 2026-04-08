const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("prototypeStudio", {
  selectProject: () => ipcRenderer.invoke("project:select"),
  restoreLastProject: () => ipcRenderer.invoke("project:restore-last"),
  scanProject: (projectRoot) => ipcRenderer.invoke("project:scan", projectRoot),
  listPrototypes: (request) => ipcRenderer.invoke("project:list-prototypes", request),
  getPrototype: (key) => ipcRenderer.invoke("project:get-prototype", key),
  autocomplete: (request) => ipcRenderer.invoke("project:autocomplete", request),
  componentInfo: (name) => ipcRenderer.invoke("project:component-info", name),
  resourceTree: () => ipcRenderer.invoke("project:resource-tree"),
  validatePrototypeYaml: (request) => ipcRenderer.invoke("project:validate-prototype-yaml", request),
  createOptions: () => ipcRenderer.invoke("project:create-options"),
  validateDraft: (draft) => ipcRenderer.invoke("project:validate-draft", draft),
  createFromDraft: (draft) => ipcRenderer.invoke("project:create-from-draft", draft),
  onScanProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("scan:progress", listener);
    return () => ipcRenderer.removeListener("scan:progress", listener);
  },
  readPrototype: (request) => ipcRenderer.invoke("prototype:read", request),
  savePrototype: (request) => ipcRenderer.invoke("prototype:save", request),
  createPrototype: (request) => ipcRenderer.invoke("prototype:create", request),
  saveWorkspaceUiState: (patch) => ipcRenderer.invoke("workspace:save-ui-state", patch),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
});
