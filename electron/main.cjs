const { app, BrowserWindow, dialog, ipcMain, Menu } = require("electron");
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const YAML = require("yaml");
const { readLatestProjectCache, readPrototypeBlock, savePrototypeBlock, createPrototype } = require("./scanner.cjs");

Menu.setApplicationMenu(null);
let activeIndex = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    titleBarStyle: "hidden",
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
ipcMain.handle("project:validate-prototype-yaml", async (_event, request = {}) => validatePrototypeYaml(request));
ipcMain.handle("project:create-options", async () => createOptions());
ipcMain.handle("project:validate-draft", async (_event, draft = {}) => validateDraft(draft));
ipcMain.handle("project:create-from-draft", async (_event, draft = {}) => createFromDraft(draft));
ipcMain.handle("workspace:save-ui-state", async (_event, patch = {}) => {
  writeWorkspaceState({ ...readWorkspaceState(), ...patch });
});
ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
ipcMain.handle("window:toggle-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());

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
  const issues = activeIndex.issues.filter((issue) => issue.prototypeKey === key);
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
  if (draft.type == null) issues.push({ level: "error", field: "type", message: "type is required", prototypeKey: key });
  if (draft.id == null) issues.push({ level: "error", field: "id", message: "id is required", prototypeKey: key });
  const nextKey = `${String(draft.type)}:${String(draft.id)}`;
  if (nextKey !== key && activeIndex.prototypes[nextKey]) {
    issues.push({ level: "error", field: "id", message: `prototype ${nextKey} already exists`, prototypeKey: key });
  }

  const parents = Array.isArray(draft.parent) ? draft.parent : draft.parent ? [draft.parent] : [];
  for (const parent of parents) {
    if (!findPrototypeKey(parent, draft.type)) {
      issues.push({ level: "warning", field: "parent", message: `parent '${parent}' was not found`, prototypeKey: key });
    }
  }

  const resolved = resolvePrototypeWithOverride(key, draft);
  const spriteComponent = resolved?.components?.find?.((component) => component?.type === "Sprite");
  const sprite = spriteComponent?.sprite;
  const preferredState = spriteComponent?.state || spriteComponent?.layers?.find?.((layer) => layer?.state)?.state;
  const rsi = sprite ? findRsi(sprite, preferredState) : null;
  if (sprite && !rsi) issues.push({ level: "warning", field: "Sprite.sprite", message: `sprite '${sprite}' was not found`, prototypeKey: key });

  return { prototype: draft, resolved, issues, rsi, kind: activeIndex.prototypeKinds[String(draft.type)] ?? null };
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

function ensureIndex() {
  if (!activeIndex) throw new Error("Project index is not loaded.");
}

function scanCacheDir() {
  return path.join(app.getPath("userData"), "scan-cache");
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
