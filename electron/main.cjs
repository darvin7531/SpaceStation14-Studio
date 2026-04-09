const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const YAML = require("yaml");
const { autoUpdater } = require("electron-updater");
const { readLatestProjectCache, readPrototypeBlock, savePrototypeBlock, createPrototype } = require("./scanner.cjs");
const appPackage = require("../package.json");

const DEFAULT_APP_SETTINGS = {
  useHardwareAcceleration: true,
};

const bootAppSettings = readAppSettings();
if (!bootAppSettings.useHardwareAcceleration) {
  app.disableHardwareAcceleration();
}

Menu.setApplicationMenu(null);
let activeIndex = null;
let mainWindow = null;
let updateState = {
  status: "idle",
  message: "Ready to check for updates.",
  version: app.getVersion(),
  progress: null,
  downloadedVersion: null,
};
let splashWindow = null;

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0a0a0a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!process.env.ELECTRON_RENDERER_URL) {
    splashWindow = createSplashWindow();
  }

  mainWindow = win;

  const finishShow = () => {
    if (!win.isDestroyed()) win.show();
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
  };

  win.once("ready-to-show", finishShow);
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    splashWindow = null;
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const distIndex = path.join(__dirname, "..", "dist", "index.html");
  if (rendererUrl) {
    win.loadURL(rendererUrl);
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  if (fs.existsSync(distIndex)) {
    win.loadFile(distIndex);
    return;
  }

  win.loadURL("http://127.0.0.1:3000");
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 640,
    height: 360,
    frame: false,
    transparent: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    center: true,
    show: true,
    backgroundColor: "#090909",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splash.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(renderSplashHtml())}`);
  return splash;
}

function renderSplashHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SS14 Studio</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background:
          radial-gradient(circle at top, rgba(37,99,235,0.16), transparent 36%),
          radial-gradient(circle at bottom right, rgba(16,185,129,0.1), transparent 28%),
          #090909;
        color: #e5e5e5;
        font-family: "Segoe UI", system-ui, sans-serif;
      }
      .shell {
        display: grid;
        place-items: center;
        width: 100%;
        height: 100%;
        padding: 24px;
        box-sizing: border-box;
      }
      .card {
        position: relative;
        overflow: hidden;
        width: min(560px, 100%);
        border-radius: 24px;
        border: 1px solid #262626;
        background: linear-gradient(180deg, rgba(10,10,10,0.98), rgba(18,18,18,0.92));
        box-shadow: 0 24px 70px rgba(0,0,0,0.48);
        padding: 28px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        border: 1px solid #2b2b2b;
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #93c5fd;
        background: rgba(17,24,39,0.72);
      }
      .row {
        display: grid;
        grid-template-columns: 84px minmax(0, 1fr);
        gap: 16px;
        align-items: center;
        margin-top: 18px;
      }
      .orbit {
        position: relative;
        width: 72px;
        height: 72px;
        border-radius: 999px;
        border: 1px solid rgba(96,165,250,0.2);
        background: radial-gradient(circle, rgba(59,130,246,0.18), rgba(59,130,246,0.03) 58%, transparent 60%);
      }
      .orbit span {
        position: absolute;
        inset: 0;
        border-radius: inherit;
        border: 1px solid rgba(96,165,250,0.18);
        animation: ring 1.6s ease-in-out infinite;
      }
      .orbit span:nth-child(2) { inset: 8px; animation-delay: 0.2s; }
      .orbit span:nth-child(3) { inset: 16px; animation-delay: 0.4s; }
      h1 {
        margin: 0;
        font-size: 28px;
        line-height: 1.1;
        letter-spacing: -0.03em;
      }
      p {
        margin: 10px 0 0;
        color: #9ca3af;
        font-size: 14px;
        line-height: 1.6;
      }
      .dots {
        display: flex;
        gap: 6px;
        margin-top: 18px;
      }
      .dots span {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: #60a5fa;
        opacity: 0.35;
        animation: dot 0.95s ease-in-out infinite;
      }
      .dots span:nth-child(2) { animation-delay: 0.12s; }
      .dots span:nth-child(3) { animation-delay: 0.24s; }
      @keyframes ring {
        0%,100% { transform: scale(0.92); opacity: 0.55; }
        50% { transform: scale(1.08); opacity: 1; }
      }
      @keyframes dot {
        0%,100% { transform: translateY(0); opacity: 0.35; }
        50% { transform: translateY(-5px); opacity: 1; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="card">
        <div class="badge">SS14 Studio</div>
        <div class="row">
          <div class="orbit"><span></span><span></span><span></span></div>
          <div>
            <h1>Loading application</h1>
            <p>Preparing the editor, UI bundle and local project services.</p>
            <div class="dots"><span></span><span></span><span></span></div>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

ipcMain.handle("project:select", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select SS14 project root",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("project:restore-last", async () => {
  const workspace = readWorkspaceState();
  if (!workspace?.lastProjectRoot) return null;

  const restored = readLatestProjectCache(scanCacheDir(), workspace.lastProjectRoot);
  if (!restored) return null;

  activeIndex = restored;
  return {
    ...summarizeIndex(activeIndex),
    selectedPrototypeId: workspace.selectedPrototypeId ?? null,
    searchQuery: workspace.searchQuery ?? "",
  };
});

ipcMain.handle("project:scan", async (event, projectRoot) => {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "scanner-worker.cjs"), {
      workerData: {
        projectRoot,
        cacheDir: scanCacheDir(),
      },
    });

    worker.on("message", (message) => {
      if (message.type === "progress") {
        event.sender.send("scan:progress", message.progress);
        return;
      }

      if (message.type === "done") {
        activeIndex = message.result;
        writeWorkspaceState({ lastProjectRoot: activeIndex.projectRoot });
        resolve(summarizeIndex(activeIndex));
        return;
      }

      if (message.type === "error") {
        reject(new Error(message.error));
      }
    });

    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Scanner worker exited with code ${code}`));
      }
    });
  });
});
ipcMain.handle("prototype:read", async (_event, request) => readPrototypeBlock(request));
ipcMain.handle("prototype:save", async (_event, request) => savePrototypeBlock(request));
ipcMain.handle("prototype:create", async (_event, request) => createPrototype(request));
ipcMain.handle("project:list-prototypes", async (_event, request = {}) => listPrototypes(request));
ipcMain.handle("project:get-prototype", async (_event, key) => getPrototype(key));
ipcMain.handle("project:autocomplete", async (_event, request = {}) => autocomplete(request));
ipcMain.handle("project:component-info", async (_event, name) => componentInfo(name));
ipcMain.handle("project:resource-tree", async () => resourceTree());
ipcMain.handle("project:pick-folder", async (_event, request = {}) => pickProjectFolder(request));
ipcMain.handle("asset:get-rsi", async (_event, rsiPath) => getRsiAsset(rsiPath));
ipcMain.handle("asset:save-rsi", async (_event, request = {}) => saveRsiAsset(request));
ipcMain.handle("asset:import-rsi-images", async (_event, request = {}) => importRsiImages(request));
ipcMain.handle("asset:create-rsi", async (_event, draft = {}) => createRsiAsset(draft));
ipcMain.handle("project:validate-prototype-yaml", async (_event, request = {}) => validatePrototypeYaml(request));
ipcMain.handle("project:create-options", async () => createOptions());
ipcMain.handle("project:validate-draft", async (_event, draft = {}) => validateDraft(draft));
ipcMain.handle("project:create-from-draft", async (_event, draft = {}) => createFromDraft(draft));
ipcMain.handle("workspace:save-ui-state", async (_event, patch = {}) => {
  writeWorkspaceState({ ...readWorkspaceState(), ...patch });
});
ipcMain.handle("workspace:get-recent-projects", async () => {
  const workspace = readWorkspaceState();
  const lastProjectRoot = typeof workspace?.lastProjectRoot === "string" && workspace.lastProjectRoot ? workspace.lastProjectRoot : null;
  return lastProjectRoot ? [lastProjectRoot] : [];
});
ipcMain.handle("update:get-state", async () => updateState);
ipcMain.handle("update:check", async () => checkForAppUpdates("manual"));
ipcMain.handle("update:install", async () => {
  if (updateState.status !== "downloaded") return false;
  setUpdateState({
    status: "installing",
    message: "Installing update and restarting SS14 Studio...",
    downloadedVersion: updateState.downloadedVersion ?? null,
  });
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
});
ipcMain.handle("app:get-info", async () => ({
  name: appPackage.build?.productName || appPackage.name || "SS14 Studio",
  version: app.getVersion(),
  author: appPackage.author || "darvin7531",
  license: appPackage.license || "AGPL-3.0-or-later",
  repositoryUrl: `https://github.com/${appPackage.build?.publish?.[0]?.owner || "darvin7531"}/${appPackage.build?.publish?.[0]?.repo || "SpaceStation14-Studio"}`,
}));
ipcMain.handle("app:get-settings", async () => ({
  useHardwareAcceleration: readAppSettings().useHardwareAcceleration,
  appliedUseHardwareAcceleration: bootAppSettings.useHardwareAcceleration,
}));
ipcMain.handle("app:update-settings", async (_event, patch = {}) => {
  const next = {
    ...readAppSettings(),
    ...(patch && typeof patch === "object" ? patch : {}),
  };
  writeAppSettings(next);
  return {
    useHardwareAcceleration: next.useHardwareAcceleration,
    appliedUseHardwareAcceleration: bootAppSettings.useHardwareAcceleration,
  };
});
ipcMain.handle("app:open-external", async (_event, url) => {
  if (!url || typeof url !== "string") return false;
  await shell.openExternal(url);
  return true;
});
ipcMain.handle("app:restart", async () => {
  app.relaunch();
  app.exit(0);
  return true;
});
ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.handle("window:toggle-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());

app.whenReady().then(async () => {
  configureAutoUpdater();
  createWindow();
  if (app.isPackaged) {
    setTimeout(() => {
      void checkForAppUpdates("startup");
    }, 3500);
  } else {
    setUpdateState({
      status: "disabled",
      message: "Auto-update works in the installed build. Use release installer or packaged app to test it.",
    });
  }
});

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

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
});

function summarizeIndex(index) {
  return {
    projectRoot: index.projectRoot,
    counts: {
      prototypes: Object.keys(index.prototypes).length,
      rsis: Object.keys(index.rsis).length,
      components: Object.keys(index.components).length,
      prototypeKinds: Object.keys(index.prototypeKinds).length,
      issues: index.issues.length,
    },
    issues: index.issues.slice(0, 500),
    cache: index.cache,
  };
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({
      status: "checking",
      message: "Checking GitHub releases for a newer build...",
      progress: null,
      downloadedVersion: null,
    });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdateState({
      status: "available",
      message: `Update ${info.version} found. Downloading in background...`,
      downloadedVersion: info.version ?? null,
      progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    setUpdateState({
      status: "unavailable",
      message: `SS14 Studio is up to date${info?.version ? ` (${info.version})` : ""}.`,
      progress: null,
      downloadedVersion: null,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setUpdateState({
      status: "downloading",
      message: `Downloading update${updateState.downloadedVersion ? ` ${updateState.downloadedVersion}` : ""}... ${Math.round(progress.percent || 0)}%`,
      progress: {
        percent: Number(progress.percent || 0),
        bytesPerSecond: Number(progress.bytesPerSecond || 0),
        transferred: Number(progress.transferred || 0),
        total: Number(progress.total || 0),
      },
      downloadedVersion: updateState.downloadedVersion ?? null,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({
      status: "downloaded",
      message: `Update ${info.version} is ready. Restart SS14 Studio to install it.`,
      progress: { percent: 100, bytesPerSecond: 0, transferred: 0, total: 0 },
      downloadedVersion: info.version ?? null,
    });
  });

  autoUpdater.on("error", (error) => {
    setUpdateState({
      status: "error",
      message: error?.message ? `Update error: ${error.message}` : "Update check failed.",
      progress: null,
      downloadedVersion: null,
    });
  });
}

async function checkForAppUpdates(reason = "manual") {
  if (!app.isPackaged) {
    setUpdateState({
      status: "disabled",
      message: "Auto-update works in the installed build. Build and install SS14 Studio first.",
      progress: null,
      downloadedVersion: null,
    });
    return updateState;
  }

  try {
    if (reason === "manual") {
      setUpdateState({
        status: "checking",
        message: "Checking GitHub releases for a newer build...",
        progress: null,
        downloadedVersion: null,
      });
    }
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateState({
      status: "error",
      message: error?.message ? `Update error: ${error.message}` : "Update check failed.",
      progress: null,
      downloadedVersion: null,
    });
  }
  return updateState;
}

function setUpdateState(patch) {
  updateState = {
    ...updateState,
    ...patch,
    version: app.getVersion(),
  };
  broadcastUpdateState();
}

function broadcastUpdateState() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("update:status", updateState);
    }
  }
}

function listPrototypes({ query = "", offset = 0, limit = 250 }) {
  ensureIndex();
  const normalized = String(query).trim().toLowerCase();
  const items = Object.values(activeIndex.prototypes)
    .filter((prototype) => {
      if (!normalized) return true;
      return [
        prototype.id,
        prototype.type,
        prototype.name,
        prototype._filePath,
      ].some((value) => String(value ?? "").toLowerCase().includes(normalized));
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(lightPrototype);

  return {
    total: items.length,
    items: items.slice(Number(offset), Number(offset) + Number(limit)),
  };
}

function getPrototype(key) {
  ensureIndex();
  const prototype = activeIndex.prototypes[key];
  if (!prototype) return null;
  const resolved = resolvePrototype(key);
  const issues = collectPrototypeIssues({ key, draft: prototype, resolved });
  const spriteComponent = resolved?.components?.find?.((component) => component?.type === "Sprite");
  const sprite = spriteComponent?.sprite;
  const preferredState = spriteComponent?.state || spriteComponent?.layers?.find?.((layer) => layer?.state)?.state;
  const rsi = sprite ? findRsi(sprite, preferredState) : null;
  const kind = activeIndex.prototypeKinds[String(prototype.type)] ?? null;
  return { prototype, resolved, issues, rsi, kind };
}

function validatePrototypeYaml({ key, text }) {
  ensureIndex();
  const base = activeIndex.prototypes[key];
  if (!base) return null;
  const issues = [];
  let parsed = null;
  try {
    const yaml = YAML.parse(String(text ?? ""), { logLevel: "silent" });
    parsed = Array.isArray(yaml) ? yaml[0] : yaml;
  } catch (error) {
    issues.push({ level: "error", field: "yaml", message: error instanceof Error ? error.message : "YAML parse failed", prototypeKey: key });
  }

  if (!parsed || typeof parsed !== "object") {
    issues.push({ level: "error", field: "yaml", message: "Prototype block must be a YAML object", prototypeKey: key });
    return { prototype: { ...base, _rawYaml: String(text ?? "") }, resolved: base, issues, rsi: null, kind: activeIndex.prototypeKinds[String(base.type)] ?? null };
  }

  const draft = { ...base, ...parsed, _key: key, _filePath: base._filePath, _line: base._line, _rawYaml: String(text ?? "") };
  const resolved = resolvePrototypeWithOverride(key, draft);
  issues.push(...collectPrototypeIssues({ key, draft, resolved, includeDuplicateCheck: true }));
  const spriteComponent = resolved?.components?.find?.((component) => component?.type === "Sprite");
  const sprite = spriteComponent?.sprite;
  const preferredState = spriteComponent?.state || spriteComponent?.layers?.find?.((layer) => layer?.state)?.state;
  const rsi = sprite ? findRsi(sprite, preferredState) : null;
  return { prototype: draft, resolved, issues: dedupeIssues(issues), rsi, kind: activeIndex.prototypeKinds[String(draft.type)] ?? null };
}

function collectPrototypeIssues({ key, draft, resolved, includeDuplicateCheck = false }) {
  const issues = [];
  if (draft?.type == null) issues.push({ level: "error", field: "type", message: "type is required", prototypeKey: key });
  if (draft?.id == null) issues.push({ level: "error", field: "id", message: "id is required", prototypeKey: key });

  if (includeDuplicateCheck && draft?.type != null && draft?.id != null) {
    const nextKey = `${String(draft.type)}:${String(draft.id)}`;
    if (nextKey !== key && activeIndex.prototypes[nextKey]) {
      issues.push({ level: "error", field: "id", message: `prototype ${nextKey} already exists`, prototypeKey: key });
    }
  }

  const parents = Array.isArray(draft?.parent) ? draft.parent : draft?.parent ? [draft.parent] : [];
  for (const parent of parents) {
    if (!findPrototypeKey(parent, draft?.type)) {
      issues.push({ level: "warning", field: "parent", message: `parent '${parent}' was not found`, prototypeKey: key });
    }
  }

  if (!resolved?.components) return issues;

  for (const component of resolved.components) {
    if (!component || typeof component !== "object") continue;
    const componentType = String(component.type ?? "");
    if (componentType === "Sprite" || componentType === "Clothing") {
      if (Object.prototype.hasOwnProperty.call(component, "sprite")) {
        const spriteValue = component.sprite;
        if (spriteValue == null || String(spriteValue).trim() === "") {
          issues.push({
            level: "warning",
            field: `${componentType}.sprite`,
            message: `${componentType}.sprite is empty`,
            prototypeKey: key,
          });
          continue;
        }

        const preferredState = component.state || component.layers?.find?.((layer) => layer?.state)?.state;
        const rsi = findRsi(spriteValue, preferredState);
        if (!rsi) {
          issues.push({
            level: "warning",
            field: `${componentType}.sprite`,
            message: `${componentType}.sprite '${spriteValue}' was not found`,
            prototypeKey: key,
            rsiPath: normalizeSpritePath(spriteValue),
          });
        }
      }
    }
  }

  return dedupeIssues(issues);
}

function dedupeIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = [
      issue.level,
      issue.field,
      issue.message,
      issue.prototypeKey,
      issue.rsiPath,
      issue.stateName,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function autocomplete({ query = "", limit = 150, context = "any", componentType = "" }) {
  ensureIndex();
  const normalized = String(query).trim().toLowerCase();
  if (context === "componentEntryStart") {
    return [{
      label: "type",
      kind: "field",
      insertText: "type: ",
      detail: "component type marker",
      documentation: "Starts a component block, for example '- type: Armor'.",
    }];
  }

  if (context === "componentField") {
    const component = activeIndex.components[String(componentType)] ?? null;
    if (!component) return [];
    return component.fields
      .filter((field) => !normalized || field.name.toLowerCase().includes(normalized))
      .sort((a, b) => suggestionRank(a.name, normalized) - suggestionRank(b.name, normalized) || a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((field) => ({
        label: field.name,
        kind: "field",
        insertText: `${field.name}: `,
        detail: `${field.type}${field.required ? " required" : ""}`,
        documentation: field.description
          ? `${component.className} / ${field.member}\n\n${field.description}`
          : `${component.className} / ${field.member}`,
      }));
  }

  if (context === "rsiPath") {
    return Object.values(activeIndex.rsis)
      .map((rsi) => {
        const shortPath = displaySpritePath(rsi.path);
        const basename = path.posix.basename(shortPath, ".rsi");
        return {
          rsi,
          shortPath,
          basename,
          states: rsi.meta?.states?.length ?? 0,
        };
      })
      .filter((item) => {
        if (!normalized) return true;
        const full = item.rsi.path.toLowerCase();
        const short = item.shortPath.toLowerCase();
        const basename = item.basename.toLowerCase();
        return full.includes(normalized) || short.includes(normalized) || basename.includes(normalized);
      })
      .sort((a, b) =>
        spriteSuggestionRank(a, normalized) - spriteSuggestionRank(b, normalized) ||
        a.shortPath.localeCompare(b.shortPath))
      .slice(0, limit)
      .map((item) => ({
        label: item.shortPath,
        kind: "field",
        insertText: item.shortPath,
        detail: `${item.states} states`,
        documentation: [
          `### ${item.basename}.rsi`,
          "",
          `Path: \`${item.shortPath}\``,
          `Project path: \`${item.rsi.path}\``,
          `States: ${item.states}`,
        ].join("\n"),
      }));
  }

  const componentSuggestions = Object.values(activeIndex.components)
    .filter((component) => !normalized || component.name.toLowerCase().includes(normalized))
    .sort((a, b) => suggestionRank(a.name, normalized) - suggestionRank(b.name, normalized) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((component) => ({
      label: component.name,
      kind: "component",
      insertText: context === "componentType" ? component.name : `- type: ${component.name}`,
      detail: component.className,
      documentation: componentDocumentation(component),
    }));

  const fieldSuggestions = [];
  if (context !== "componentType") {
    for (const kind of Object.values(activeIndex.prototypeKinds)) {
      for (const field of kind.fields) {
        if (normalized && !field.name.toLowerCase().includes(normalized)) continue;
        fieldSuggestions.push({
          label: field.name,
          kind: "field",
          insertText: `${field.name}: `,
          detail: `${field.type}${field.required ? " required" : ""}`,
          documentation: `${kind.className} / ${field.member}`,
        });
        if (fieldSuggestions.length >= limit) break;
      }
      if (fieldSuggestions.length >= limit) break;
    }
  }

  return [...componentSuggestions, ...fieldSuggestions].slice(0, limit);
}

function suggestionRank(label, normalizedQuery) {
  if (!normalizedQuery) return 0;
  const value = String(label).toLowerCase();
  if (value === normalizedQuery) return 0;
  if (value.startsWith(normalizedQuery)) return 10 + value.length;
  const index = value.indexOf(normalizedQuery);
  return index >= 0 ? 100 + index + value.length : 1000 + value.length;
}

function spriteSuggestionRank(item, normalizedQuery) {
  if (!normalizedQuery) return item.shortPath.length;
  const short = item.shortPath.toLowerCase();
  const full = item.rsi.path.toLowerCase();
  const basename = item.basename.toLowerCase();
  if (short === normalizedQuery || basename === normalizedQuery) return 0;
  if (short.startsWith(normalizedQuery)) return 10 + short.length;
  if (basename.startsWith(normalizedQuery)) return 20 + basename.length;
  const shortIndex = short.indexOf(normalizedQuery);
  if (shortIndex >= 0) return 100 + shortIndex + short.length;
  const baseIndex = basename.indexOf(normalizedQuery);
  if (baseIndex >= 0) return 200 + baseIndex + basename.length;
  const fullIndex = full.indexOf(normalizedQuery);
  return fullIndex >= 0 ? 300 + fullIndex + full.length : 1000 + short.length;
}

function componentInfo(name) {
  ensureIndex();
  return activeIndex.components[String(name)] ?? null;
}

function componentDocumentation(component) {
  const fields = component.fields ?? [];
  const lines = [
    `### ${component.name}`,
    `\`${component.className}\``,
  ];
  if (component.description) lines.push("", component.description);
  lines.push("", `Source: \`${component.path}:${component.line}\``);
  if (fields.length > 0) {
    lines.push("", "**Fields**");
    for (const field of fields.slice(0, 16)) {
      const required = field.required ? " required" : "";
      const description = field.description ? ` - ${field.description}` : "";
      lines.push(`- \`${field.name}\`: \`${field.type}\`${required}${description}`);
    }
  }
  lines.push("", "**Example**", "```yaml", componentExampleYaml(component), "```");
  return lines.join("\n");
}

function componentExampleYaml(component) {
  const lines = [`- type: ${component.name}`];
  for (const field of (component.fields ?? []).slice(0, 8)) {
    if (!field.required && lines.length >= 4) continue;
    const sample = sampleYamlValue(field);
    if (sample.includes("\n")) {
      lines.push(`  ${field.name}:`);
      for (const nested of sample.split("\n")) lines.push(`    ${nested}`);
    } else {
      lines.push(`  ${field.name}: ${sample}`);
    }
  }
  return lines.join("\n");
}

function sampleYamlValue(field) {
  const name = String(field.name).toLowerCase();
  const type = String(field.type).toLowerCase();
  if (name === "modifiers" || type.includes("damagemodifierset")) {
    return [
      "coefficients:",
      "  Blunt: 0.6",
      "  Slash: 0.6",
      "  Piercing: 0.6",
      "  Heat: 0.8",
    ].join("\n");
  }
  if (name.includes("sprite")) return "_Example/Path/example.rsi";
  if (name.includes("state")) return "icon";
  if (type.includes("bool")) return "true";
  if (type.includes("float") || type.includes("double")) return "1.0";
  if (type.includes("int")) return "1";
  if (type.includes("list") || type.includes("array") || type.includes("hashset")) return "[]";
  if (type.includes("dictionary") || type.includes("damage")) return "{}";
  return "TODO";
}

function resourceTree() {
  ensureIndex();
  const root = { name: "Resources", path: "Resources", kind: "folder", children: [], prototypeCount: 0, rsiCount: 0 };
  for (const prototype of Object.values(activeIndex.prototypes)) {
    if (!String(prototype._filePath).startsWith("Resources/")) continue;
    insertResourcePath(root, prototype._filePath.split("/").slice(1), {
      name: `${prototype.id}`,
      path: prototype._filePath,
      kind: "prototype",
      prototypeKey: prototype._key,
      prototypeType: prototype.type,
    });
  }
  for (const rsi of Object.values(activeIndex.rsis)) {
    if (!String(rsi.path).startsWith("Resources/")) continue;
    insertResourcePath(root, rsi.path.split("/").slice(1), {
      name: path.posix.basename(rsi.path),
      path: rsi.path,
      kind: "rsi",
      stateCount: rsi.meta?.states?.length ?? 0,
    });
  }
  sortTree(root);
  return root;
}

async function pickProjectFolder({ scope = "prototypes", currentPath = "" }) {
  ensureIndex();
  const root = activeIndex.projectRoot;
  const baseRel = scope === "textures" ? "Resources/Textures" : "Resources/Prototypes";
  const normalizedCurrent = String(currentPath || "").replace(/\\/g, "/");
  const defaultRel = normalizedCurrent && isUnderProjectFolder(normalizedCurrent, baseRel) ? normalizedCurrent : baseRel;
  const result = await dialog.showOpenDialog({
    title: scope === "textures" ? "Select folder in Resources/Textures" : "Select folder in Resources/Prototypes",
    defaultPath: safeProjectPath(root, defaultRel),
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const relative = path.relative(root, result.filePaths[0]).replace(/\\/g, "/");
  if (!isUnderProjectFolder(relative, baseRel)) {
    throw new Error(`Selected folder must stay inside ${baseRel}.`);
  }
  return relative;
}

function getRsiAsset(rsiPath) {
  ensureIndex();
  const key = resolveRsiKey(rsiPath);
  const rsi = activeIndex.rsis[key];
  if (!rsi) return null;
  return formatRsiAsset(rsi);
}

function saveRsiAsset({ path: rsiPath, meta }) {
  ensureIndex();
  const key = normalizeRsiKey(rsiPath);
  const rsi = activeIndex.rsis[key];
  if (!rsi) return null;
  const nextMeta = sanitizeRsiMeta(meta);
  fs.writeFileSync(path.join(rsi.dirPath, "meta.json"), `${JSON.stringify(nextMeta, null, 2)}\n`, "utf8");
  rsi.meta = nextMeta;
  return formatRsiAsset(rsi);
}

function importRsiImages({ path: rsiPath, files = [] }) {
  ensureIndex();
  const key = normalizeRsiKey(rsiPath);
  const rsi = activeIndex.rsis[key];
  if (!rsi) return null;
  const known = new Set((rsi.meta?.states ?? []).map((state) => state.name));
  for (const file of files) {
    const stateName = safeStateName(file.name);
    const dataUrl = String(file.dataUrl ?? "");
    const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!match) continue;
    fs.writeFileSync(path.join(rsi.dirPath, `${stateName}.png`), Buffer.from(match[1], "base64"));
    if (!known.has(stateName)) {
      rsi.meta.states.push({ name: stateName });
      known.add(stateName);
    }
  }
  rsi.meta = sanitizeRsiMeta(rsi.meta);
  fs.writeFileSync(path.join(rsi.dirPath, "meta.json"), `${JSON.stringify(rsi.meta, null, 2)}\n`, "utf8");
  return formatRsiAsset(rsi);
}

function createRsiAsset(draft) {
  ensureIndex();
  const root = activeIndex.projectRoot;
  const relDir = normalizeTextureDirectory(draft.directory);
  const name = safeRsiFolderName(draft.name);
  const rsiPath = `${relDir}/${name}.rsi`;
  const fullDir = safeProjectPath(root, rsiPath);
  fs.mkdirSync(fullDir, { recursive: true });
  const meta = sanitizeRsiMeta({
    version: 1,
    license: String(draft.license || "CC-BY-SA-3.0"),
    copyright: String(draft.copyright || ""),
    size: {
      x: Math.max(1, Number(draft.sizeX || 32)),
      y: Math.max(1, Number(draft.sizeY || 32)),
    },
    states: [{ name: "icon" }],
  });
  fs.writeFileSync(path.join(fullDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  const entry = { path: rsiPath, meta, images: {}, dirPath: fullDir };
  activeIndex.rsis[rsiPath] = entry;
  return formatRsiAsset(entry);
}

function insertResourcePath(root, parts, leaf) {
  let current = root;
  const ancestors = [root];
  const folderParts = parts.slice(0, -1);
  for (const part of folderParts) {
    let child = current.children.find((item) => item.kind === "folder" && item.name === part);
    if (!child) {
      child = { name: part, path: `${current.path}/${part}`, kind: "folder", children: [], prototypeCount: 0, rsiCount: 0 };
      current.children.push(child);
    }
    current = child;
    ancestors.push(current);
  }

  let file = current.children.find((item) => item.path === leaf.path && (item.kind === "file" || item.kind === "rsi"));
  if (!file && leaf.kind === "prototype") {
    file = { name: parts.at(-1), path: leaf.path, kind: "file", children: [], prototypeCount: 0, rsiCount: 0 };
    current.children.push(file);
  }

  if (leaf.kind === "prototype") {
    file.children.push(leaf);
    for (const node of [...ancestors, file]) node.prototypeCount = (node.prototypeCount ?? 0) + 1;
  } else if (!file) {
    current.children.push(leaf);
    for (const node of ancestors) node.rsiCount = (node.rsiCount ?? 0) + 1;
  }
}

function sortTree(node) {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.kind === "folder" && b.kind !== "folder") return -1;
    if (a.kind !== "folder" && b.kind === "folder") return 1;
    return String(a.name).localeCompare(String(b.name));
  });
  for (const child of node.children) sortTree(child);
}

function createOptions() {
  ensureIndex();
  const types = new Set([
    ...Object.keys(activeIndex.prototypeKinds),
    ...Object.values(activeIndex.prototypes).map((prototype) => String(prototype.type)),
  ]);
  const files = Array.from(new Set(Object.values(activeIndex.prototypes).map((prototype) => prototype._filePath))).sort();
  return {
    types: Array.from(types).sort(),
    files,
    defaultFile: "Resources/Prototypes/_PrototypeStudio/entity.yml",
  };
}

function validateDraft(draft) {
  ensureIndex();
  const normalized = normalizeDraft(draft);
  const issues = [];
  if (!normalized.type) issues.push({ level: "error", field: "type", message: "type is required" });
  if (!normalized.id) issues.push({ level: "error", field: "id", message: "id is required" });
  if (normalized.id && activeIndex.prototypes[`${normalized.type}:${normalized.id}`]) {
    issues.push({ level: "error", field: "id", message: `prototype ${normalized.type}:${normalized.id} already exists` });
  }
  if (!normalized.filePath.startsWith("Resources/Prototypes/")) {
    issues.push({ level: "error", field: "filePath", message: "file must be inside Resources/Prototypes" });
  }
  if (!normalized.filePath.endsWith(".yml") && !normalized.filePath.endsWith(".yaml")) {
    issues.push({ level: "error", field: "filePath", message: "file must be .yml or .yaml" });
  }
  if (normalized.mode === "append" && !createOptions().files.includes(normalized.filePath)) {
    issues.push({ level: "warning", field: "filePath", message: "selected file is not in the current index; it will be created if missing" });
  }
  if (normalized.parent && !findPrototypeKey(normalized.parent, normalized.type)) {
    issues.push({ level: "warning", field: "parent", message: `parent '${normalized.parent}' was not found` });
  }
  if (normalized.sprite && !findRsi(normalized.sprite, normalized.spriteState)) {
    issues.push({ level: "warning", field: "sprite", message: `sprite '${normalized.sprite}' was not found` });
  }

  return {
    ok: !issues.some((issue) => issue.level === "error"),
    issues,
    yaml: draftYaml(normalized),
    filePath: normalized.filePath,
  };
}

function createFromDraft(draft) {
  const validation = validateDraft(draft);
  if (!validation.ok) {
    throw new Error(validation.issues.find((issue) => issue.level === "error")?.message ?? "draft is invalid");
  }
  const normalized = normalizeDraft(draft);
  createPrototype({
    projectRoot: activeIndex.projectRoot,
    type: normalized.type,
    id: normalized.id,
    filePath: normalized.filePath,
    yaml: validation.yaml,
  });
  return { key: `${normalized.type}:${normalized.id}`, filePath: normalized.filePath, yaml: validation.yaml };
}

function normalizeDraft(draft) {
  const type = String(draft.type ?? "entity").trim();
  const filePath = String(draft.filePath || `Resources/Prototypes/_PrototypeStudio/${type || "entity"}.yml`).replace(/\\/g, "/").trim();
  return {
    mode: draft.mode === "new" ? "new" : "append",
    type,
    id: String(draft.id ?? "").trim(),
    name: String(draft.name ?? "").trim(),
    description: String(draft.description ?? "").trim(),
    suffix: String(draft.suffix ?? "").trim(),
    parent: String(draft.parent ?? "").trim(),
    abstract: Boolean(draft.abstract),
    filePath,
    includeSprite: Boolean(draft.includeSprite),
    sprite: String(draft.sprite ?? "").trim(),
    spriteState: String(draft.spriteState ?? "").trim(),
    includeItem: Boolean(draft.includeItem),
    includePhysics: Boolean(draft.includePhysics),
    includeAppearance: Boolean(draft.includeAppearance),
  };
}

function draftYaml(draft) {
  const lines = [`- type: ${draft.type}`, `  id: ${draft.id}`];
  if (draft.parent) lines.push(`  parent: ${draft.parent}`);
  if (draft.abstract) lines.push("  abstract: true");
  if (draft.name) lines.push(`  name: ${quoteYaml(draft.name)}`);
  if (draft.description) lines.push(`  description: ${quoteYaml(draft.description)}`);
  if (draft.suffix) lines.push(`  suffix: ${quoteYaml(draft.suffix)}`);

  if (draft.type === "entity") {
    const components = [];
    if (draft.includeSprite || draft.sprite) {
      components.push(["  - type: Sprite", draft.sprite ? `    sprite: ${draft.sprite}` : "", draft.spriteState ? `    state: ${draft.spriteState}` : ""].filter(Boolean));
    }
    if (draft.includeItem) components.push(["  - type: Item"]);
    if (draft.includePhysics) components.push(["  - type: Physics"]);
    if (draft.includeAppearance) components.push(["  - type: Appearance"]);
    if (components.length > 0) {
      lines.push("  components:");
      for (const component of components) lines.push(...component);
    }
  }
  return `${lines.join("\n")}\n`;
}

function quoteYaml(value) {
  if (/^[A-Za-z0-9 _.,:;!?()'\-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function lightPrototype(prototype) {
  return {
    _key: prototype._key,
    id: prototype.id,
    type: prototype.type,
    name: prototype.name,
    parent: prototype.parent,
    abstract: prototype.abstract,
    _filePath: prototype._filePath,
    _line: prototype._line,
  };
}

function resolvePrototype(key, visited = new Set()) {
  const prototype = activeIndex.prototypes[key];
  if (!prototype) return null;
  if (visited.has(key)) return { ...prototype, _cyclic: true };
  visited.add(key);
  let resolved = { ...prototype };
  const parents = Array.isArray(prototype.parent) ? prototype.parent : prototype.parent ? [prototype.parent] : [];
  for (const parentId of parents) {
    const parentKey = findPrototypeKey(parentId, prototype.type);
    const parent = parentKey ? resolvePrototype(parentKey, new Set(visited)) : null;
    if (parent) resolved = mergePrototypes(parent, resolved);
  }
  return resolved;
}

function resolvePrototypeWithOverride(key, override, visited = new Set()) {
  const original = activeIndex.prototypes[key];
  activeIndex.prototypes[key] = override;
  try {
    return resolvePrototype(key, visited);
  } finally {
    activeIndex.prototypes[key] = original;
  }
}

function findPrototypeKey(id, type) {
  const exact = `${type}:${id}`;
  if (activeIndex.prototypes[exact]) return exact;
  return Object.values(activeIndex.prototypes).find((prototype) => String(prototype.id) === String(id))?._key ?? null;
}

function mergePrototypes(parent, child) {
  const merged = { ...parent, ...child };
  if (parent.components || child.components) {
    const components = new Map();
    for (const component of parent.components ?? []) {
      if (!component || typeof component !== "object" || component.type == null) continue;
      components.set(component.type, { ...component, _source: parent.id });
    }
    for (const component of child.components ?? []) {
      if (!component || typeof component !== "object" || component.type == null) continue;
      components.set(component.type, { ...(components.get(component.type) ?? {}), ...component, _source: child.id });
    }
    merged.components = Array.from(components.values());
  }
  return merged;
}

function findRsi(sprite, preferredState = null) {
  const normalized = normalizeSpritePath(sprite).toLowerCase();
  const key = Object.keys(activeIndex.rsis).find((item) => item.toLowerCase().endsWith(normalized));
  if (!key) return null;
  const rsi = activeIndex.rsis[key];
  const states = (rsi.meta?.states ?? []).map((state) => state.name);
  const state = preferredState && states.includes(preferredState) ? preferredState : states[0];
  const previewDataUrl = state ? readRsiStateDataUrl(rsi.dirPath, state) : null;
  return {
    path: rsi.path,
    stateCount: rsi.meta?.states?.length ?? 0,
    size: rsi.meta?.size,
    states,
    previewState: state ?? null,
    previewDataUrl,
  };
}

function formatRsiAsset(rsi) {
  const states = (rsi.meta?.states ?? []).map((state) => ({
    ...state,
    previewDataUrl: readRsiStateDataUrl(rsi.dirPath, state.name),
  }));
  const knownFiles = new Set(states.map((state) => `${state.name}.png`.toLowerCase()));
  const issues = [];
  for (const state of states) {
    if (!state.previewDataUrl) {
      issues.push({ level: "warning", field: "state", message: `PNG for state '${state.name}' is missing`, rsiPath: rsi.path, stateName: state.name });
    }
  }
  for (const file of fs.readdirSync(rsi.dirPath)) {
    if (!file.toLowerCase().endsWith(".png")) continue;
    if (!knownFiles.has(file.toLowerCase())) {
      issues.push({ level: "info", field: "png", message: `PNG '${file}' exists but is not listed in meta.json`, rsiPath: rsi.path, stateName: file.replace(/\.png$/i, "") });
    }
  }
  return {
    path: rsi.path,
    dirPath: rsi.dirPath,
    meta: rsi.meta,
    states,
    issues,
  };
}

function sanitizeRsiMeta(meta) {
  const sizeX = Math.max(1, Number(meta?.size?.x || 32));
  const sizeY = Math.max(1, Number(meta?.size?.y || 32));
  const states = [];
  const seen = new Set();
  for (const state of meta?.states ?? []) {
    const name = safeStateName(state?.name ?? "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const next = { name };
    if (state?.directions && Number(state.directions) > 1) next.directions = Number(state.directions);
    if (state?.delays) next.delays = state.delays;
    if (state?.flags) next.flags = state.flags;
    states.push(next);
  }
  if (states.length === 0) states.push({ name: "icon" });
  return {
    version: 1,
    license: String(meta?.license || "CC-BY-SA-3.0"),
    copyright: String(meta?.copyright || ""),
    size: { x: sizeX, y: sizeY },
    states,
  };
}

function normalizeRsiKey(value) {
  return String(value || "").replace(/\\/g, "/");
}

function resolveRsiKey(value) {
  const direct = normalizeRsiKey(value);
  if (activeIndex.rsis[direct]) return direct;
  const normalizedSprite = normalizeSpritePath(value);
  if (activeIndex.rsis[normalizedSprite]) return normalizedSprite;
  const normalizedLower = normalizedSprite.toLowerCase();
  return Object.keys(activeIndex.rsis).find((key) => key.toLowerCase() === normalizedLower) ?? direct;
}

function normalizeTextureDirectory(value) {
  let normalized = String(value || "Resources/Textures/_Studio").replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.startsWith("Resources/Textures")) normalized = `Resources/Textures/${normalized.replace(/^\/+/, "")}`;
  return normalized;
}

function isUnderProjectFolder(value, baseRel) {
  const normalized = String(value || "").replace(/\\/g, "/");
  return normalized === baseRel || normalized.startsWith(`${baseRel}/`);
}

function safeRsiFolderName(value) {
  const normalized = String(value || "new-rsi").trim().replace(/\.rsi$/i, "").replace(/[^A-Za-z0-9_\-]/g, "-");
  return normalized || "new-rsi";
}

function safeStateName(value) {
  return String(value || "")
    .replace(/\.png$/i, "")
    .trim()
    .replace(/[^A-Za-z0-9_\-]/g, "-");
}

function safeProjectPath(projectRoot, relPath) {
  const root = path.resolve(projectRoot);
  const full = path.resolve(root, relPath);
  if (!full.startsWith(root)) throw new Error("Path escapes project root.");
  return full;
}

function readRsiStateDataUrl(dirPath, state) {
  const file = path.join(dirPath, `${state}.png`);
  try {
    if (!fs.existsSync(file)) return null;
    return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  } catch {
    return null;
  }
}

function normalizeSpritePath(sprite) {
  let normalized = String(sprite).replace(/\\/g, "/");
  if (normalized.startsWith("/Textures/")) normalized = `Resources${normalized}`;
  else if (normalized.startsWith("Textures/")) normalized = `Resources/${normalized}`;
  else if (!normalized.startsWith("Resources/Textures/")) normalized = `Resources/Textures/${normalized}`;
  if (!normalized.endsWith(".rsi")) normalized += ".rsi";
  return normalized;
}

function displaySpritePath(sprite) {
  const normalized = normalizeSpritePath(sprite);
  return normalized.startsWith("Resources/Textures/")
    ? normalized.slice("Resources/Textures/".length)
    : normalized;
}

function ensureIndex() {
  if (!activeIndex) throw new Error("Project index is not loaded.");
}

function scanCacheDir() {
  return path.join(app.getPath("userData"), "scan-cache");
}

function appSettingsPath() {
  return path.join(app.getPath("userData"), "app-settings.json");
}

function workspaceStatePath() {
  return path.join(app.getPath("userData"), "workspace-state.json");
}

function readWorkspaceState() {
  try {
    const file = workspaceStatePath();
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeWorkspaceState(patch) {
  try {
    const next = { ...readWorkspaceState(), ...patch, updatedAt: Date.now() };
    fs.mkdirSync(path.dirname(workspaceStatePath()), { recursive: true });
    fs.writeFileSync(workspaceStatePath(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // Workspace restore is a performance optimization, not critical project data.
  }
}

function readAppSettings() {
  try {
    const file = appSettingsPath();
    if (!fs.existsSync(file)) return { ...DEFAULT_APP_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...DEFAULT_APP_SETTINGS,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      useHardwareAcceleration: parsed?.useHardwareAcceleration !== false,
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function writeAppSettings(patch) {
  const next = {
    ...DEFAULT_APP_SETTINGS,
    ...(patch && typeof patch === "object" ? patch : {}),
    useHardwareAcceleration: patch?.useHardwareAcceleration !== false,
  };
  fs.mkdirSync(path.dirname(appSettingsPath()), { recursive: true });
  fs.writeFileSync(appSettingsPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}
