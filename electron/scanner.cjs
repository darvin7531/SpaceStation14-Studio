const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const YAML = require("yaml");

const TEXT_EXTENSIONS = new Set([".yml", ".yaml", ".cs", ".json"]);
const CACHE_VERSION = 5;

function scanProject(projectRoot, onProgress = null, options = {}) {
  const root = path.resolve(projectRoot || "");
  const prototypeRoot = path.join(root, "Resources", "Prototypes");
  const textureRoot = path.join(root, "Resources", "Textures");
  if (!fs.existsSync(prototypeRoot)) {
    throw new Error("Resources/Prototypes was not found in selected folder.");
  }

  const prototypes = {};
  const rsis = {};
  const components = {};
  const prototypeKinds = {};
  onProgress?.({ stage: "cache", message: "Checking project file fingerprint", processed: 0 });
  const files = collectProjectFiles(root, onProgress);
  const cacheKey = projectCacheKey(root, files);
  const cachePath = options.cacheDir ? path.join(options.cacheDir, `${cacheKey}.json.gz`) : null;
  const cached = cachePath ? readScanCache(cachePath, root) : null;
  if (cached) {
    onProgress?.({ stage: "cache", message: "Loaded scan index from cache", processed: files.length });
    return { ...cached, cache: { hit: true, key: cacheKey, fileCount: files.length } };
  }

  onProgress?.({ stage: "cache", message: "Cache miss; parsing project files", processed: files.length });
  let processed = 0;

  for (const item of files) {
    const file = item.path;
    processed += 1;
    if (processed % 250 === 0) onProgress?.({ stage: "scan", message: relative(root, file), processed });

    if (file.endsWith(".cs")) {
      scanCSharp(root, file, components, prototypeKinds);
      continue;
    }

    if ((file.endsWith(".yml") || file.endsWith(".yaml")) && file.startsWith(prototypeRoot)) {
      scanYaml(root, file, prototypes);
      continue;
    }

    if (path.basename(file) === "meta.json" && path.dirname(file).endsWith(".rsi") && file.startsWith(textureRoot)) {
      scanRsi(root, file, rsis);
    }
  }

  onProgress?.({ stage: "validate", message: "Validating parent and sprite references", processed });
  const result = { projectRoot: root, prototypes, rsis, components, prototypeKinds, issues: validate(prototypes, rsis) };
  if (cachePath) {
    onProgress?.({ stage: "cache", message: "Writing scan cache", processed });
    writeScanCache(cachePath, result, options.cacheDir, cacheKey, files.length);
  }
  return { ...result, cache: { hit: false, key: cacheKey, fileCount: files.length } };
}

function readLatestProjectCache(cacheDir, projectRoot) {
  const root = path.resolve(projectRoot || "");
  const manifestPath = latestManifestPath(cacheDir, root);
  try {
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.version !== CACHE_VERSION || manifest.projectRoot !== root || !manifest.cacheFile) return null;
    const cachePath = path.join(cacheDir, manifest.cacheFile);
    const result = readScanCache(cachePath, root);
    if (!result) return null;
    return {
      ...result,
      cache: {
        hit: true,
        restored: true,
        unchecked: true,
        key: manifest.cacheKey,
        fileCount: manifest.fileCount ?? 0,
      },
    };
  } catch {
    return null;
  }
}

function scanCSharp(root, file, components, prototypeKinds) {
  const text = readText(file);
  const rel = relative(root, file);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    if (/\[RegisterComponent\b/.test(lines[i])) {
      const classInfo = nextClass(lines, i);
      if (!classInfo) continue;
      const override = componentOverride(lines, i, classInfo.line - 1);
      const name = override || componentName(classInfo.name);
      components[name] = { name, className: classInfo.name, path: rel, line: classInfo.line, description: xmlSummaryBefore(lines, i) || xmlSummaryBefore(lines, classInfo.line - 1), fields: dataFieldsNear(lines, classInfo.line - 1) };
    }

    const protoMatch = lines[i].match(/\[(?:Prototype|PrototypeRecord)(?:\(([^\)]*)\))?\]/);
    if (protoMatch) {
      const classInfo = nextClass(lines, i);
      if (!classInfo) continue;
      const type = prototypeType(protoMatch[1] || "", classInfo.name);
      prototypeKinds[type] = { type, className: classInfo.name, path: rel, line: classInfo.line, description: xmlSummaryBefore(lines, i) || xmlSummaryBefore(lines, classInfo.line - 1), fields: dataFieldsNear(lines, classInfo.line - 1) };
    }
  }
}

function scanYaml(root, file, prototypes) {
  const text = readText(file);
  let parsed;
  try {
    parsed = YAML.parse(text, { logLevel: "silent" });
  } catch {
    parsed = null;
  }

  if (!Array.isArray(parsed)) {
    return;
  }

  const lines = text.split(/\r?\n/);
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s*type:\s*\S+/.test(lines[i])) {
      starts.push(i + 1);
    }
  }

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!item || typeof item !== "object" || item.type == null || item.id == null) {
      continue;
    }
    const key = `${String(item.type)}:${String(item.id)}`;
    prototypes[key] = {
      ...item,
      _key: key,
      _filePath: relative(root, file),
      _line: starts[i] || 1,
      _rawYaml: blockText(lines, starts[i] || 1),
    };
  }
}

function scanRsi(root, metaFile, rsis) {
  try {
    const meta = JSON.parse(readText(metaFile));
    const dir = path.dirname(metaFile);
    const rel = relative(root, dir);
    rsis[rel] = { path: rel, meta, images: {}, dirPath: dir };
  } catch {
    // Broken RSI should not block the editor from opening the project.
  }
}

function readPrototypeBlock({ projectRoot, filePath, line }) {
  const file = safeProjectPath(projectRoot, filePath);
  const lines = readText(file).split(/\r?\n/);
  return { filePath: relative(projectRoot, file), line, text: blockText(lines, line) };
}

function savePrototypeBlock({ projectRoot, filePath, line, text }) {
  if (!String(text || "").trimStart().startsWith("- type:")) {
    throw new Error("Prototype block must start with '- type:'.");
  }
  const file = safeProjectPath(projectRoot, filePath);
  const original = readText(file).split(/\r?\n/);
  const [start, end] = blockRange(original, line);
  const replacement = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");
  const updated = [...original.slice(0, start), ...replacement, ...original.slice(end)];
  fs.writeFileSync(file, `${updated.join("\n").replace(/\n+$/, "")}\n`, "utf8");
  return readPrototypeBlock({ projectRoot, filePath, line: start + 1 });
}

function createPrototype({ projectRoot, type, id, parent, name, filePath, yaml }) {
  if (!type || !id) {
    throw new Error("type and id are required.");
  }
  const rel = filePath || `Resources/Prototypes/_PrototypeStudio/${type}.yml`;
  if (!rel.replace(/\\/g, "/").startsWith("Resources/Prototypes/")) {
    throw new Error("filePath must be inside Resources/Prototypes.");
  }
  const file = safeProjectPath(projectRoot, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? readText(file) : "";
  if (new RegExp(`^\\s*id:\\s*${escapeRegExp(id)}\\s*$`, "m").test(existing)) {
    throw new Error(`Prototype id '${id}' already exists in this file.`);
  }
  const lines = ["", `- type: ${type}`, `  id: ${id}`];
  if (parent) lines.push(`  parent: ${parent}`);
  if (name) lines.push(`  name: ${name}`);
  if (type === "entity") lines.push("  components:", "  - type: Sprite", "    sprite: PLACEHOLDER.rsi");
  const block = yaml ? String(yaml).trimEnd() : lines.slice(1).join("\n");
  fs.appendFileSync(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${block}\n`, "utf8");
  return { filePath: relative(projectRoot, file), line: Math.max(1, existing.split(/\r?\n/).length), text: block };
}

function validate(prototypes, rsis) {
  const issues = [];
  const byId = new Set(Object.values(prototypes).map((proto) => String(proto.id)));
  const rsiPaths = new Set(Object.keys(rsis).map((value) => value.toLowerCase()));

  for (const proto of Object.values(prototypes)) {
    const parents = Array.isArray(proto.parent) ? proto.parent : proto.parent ? [proto.parent] : [];
    for (const parent of parents) {
      if (parent && !byId.has(String(parent))) {
        issues.push({ level: "error", message: `Missing parent '${parent}'`, prototypeKey: proto._key, field: "parent" });
      }
    }

    const sprite = proto.components?.find?.((component) => component?.type === "Sprite")?.sprite;
    if (sprite) {
      const normalized = normalizeSpritePath(sprite);
      if (!rsiPaths.has(normalized.toLowerCase())) {
        issues.push({ level: "warning", message: `Sprite RSI not found: ${sprite}`, prototypeKey: proto._key, field: "Sprite.sprite" });
      }
    }
  }
  return issues.slice(0, 500);
}

function collectProjectFiles(root, onProgress = null) {
  const files = [];
  let processed = 0;
  for (const file of walk(root)) {
    processed += 1;
    if (processed % 1000 === 0) {
      onProgress?.({ stage: "cache", message: `Fingerprinting ${processed} files`, processed });
    }

    const stat = fs.statSync(file);
    files.push({
      path: file,
      rel: relative(root, file),
      size: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
    });
  }
  return files;
}

function projectCacheKey(root, files) {
  const hash = crypto.createHash("sha256");
  hash.update(String(CACHE_VERSION));
  hash.update("\0");
  hash.update(root.toLowerCase());
  hash.update("\0");
  for (const file of files) {
    hash.update(file.rel);
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    hash.update(String(file.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readScanCache(cachePath, root) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const cached = JSON.parse(zlib.gunzipSync(fs.readFileSync(cachePath)).toString("utf8"));
    if (cached.version !== CACHE_VERSION || cached.projectRoot !== root) return null;
    return cached.result;
  } catch {
    return null;
  }
}

function writeScanCache(cachePath, result, cacheDir, cacheKey, fileCount = 0) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const payload = JSON.stringify({ version: CACHE_VERSION, projectRoot: result.projectRoot, createdAt: Date.now(), result });
    fs.writeFileSync(cachePath, zlib.gzipSync(payload, { level: 4 }));
    if (cacheDir) {
      fs.writeFileSync(
        latestManifestPath(cacheDir, result.projectRoot),
        JSON.stringify({
          version: CACHE_VERSION,
          projectRoot: result.projectRoot,
          cacheFile: path.basename(cachePath),
          cacheKey,
          fileCount,
          createdAt: Date.now(),
        }, null, 2),
        "utf8",
      );
    }
  } catch {
    // Cache failures should never break editing.
  }
}

function latestManifestPath(cacheDir, root) {
  const hash = crypto.createHash("sha1").update(path.resolve(root).toLowerCase()).digest("hex");
  return path.join(cacheDir, `latest-${hash}.json`);
}

function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "bin" || entry.name === "obj" || entry.name === "node_modules") {
          continue;
        }
        stack.push(full);
      } else if (entry.isFile() && (TEXT_EXTENSIONS.has(path.extname(entry.name)) || entry.name === "meta.json")) {
        yield full;
      }
    }
  }
}

function nextClass(lines, start) {
  for (let i = start; i < Math.min(lines.length, start + 12); i++) {
    const match = lines[i].match(/\b(?:public|internal|private|protected)?\s*(?:sealed\s+|abstract\s+|partial\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (match) return { name: match[1], line: i + 1 };
  }
  return null;
}

function dataFieldsNear(lines, classIndex) {
  const fields = [];
  for (let i = classIndex + 1; i < Math.min(lines.length, classIndex + 260); i++) {
    const attr = lines[i].match(/\[DataField(?:\(([^\)]*)\))?(?:\]|,)/);
    if (!attr) continue;
    const member = nextMember(lines, i);
    if (!member) continue;
    const args = attr[1] || "";
    fields.push({ name: dataFieldName(args, member.name), member: member.name, type: member.type, line: member.line, required: /required\s*[:=]\s*true/.test(args), description: xmlSummaryBefore(lines, i) });
  }
  return fields.slice(0, 80);
}

function xmlSummaryBefore(lines, anchorIndex) {
  const block = [];
  for (let i = anchorIndex - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      if (block.length === 0) continue;
      break;
    }
    if (!trimmed.startsWith("///")) break;
    block.unshift(trimmed.replace(/^\/\/\/\s?/, ""));
  }

  const text = block.join(" ")
    .replace(/<summary>/g, "")
    .replace(/<\/summary>/g, "")
    .replace(/<see\s+cref="([^"]+)"\s*\/>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || "";
}

function nextMember(lines, start) {
  for (let i = start + 1; i < Math.min(lines.length, start + 5); i++) {
    const match = lines[i].trim().match(/\b(?:public|private|protected|internal)\s+([A-Za-z0-9_<>,\.\?\[\]\s]+?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[=;{])/);
    if (match) return { type: match[1].replace(/\s+/g, " "), name: match[2], line: i + 1 };
  }
  return null;
}

function prototypeType(args, className) {
  const match = args.match(/"([^"]+)"/);
  if (match) return match[1];
  if (className === "EntityPrototype") return "entity";
  const trimmed = className.endsWith("Prototype") ? className.slice(0, -"Prototype".length) : className;
  return trimmed.slice(0, 1).toLowerCase() + trimmed.slice(1);
}

function componentName(className) {
  for (const prefix of ["Client", "Server", "Shared"]) {
    if (className.startsWith(prefix)) className = className.slice(prefix.length);
  }
  return className.endsWith("Component") ? className.slice(0, -"Component".length) : className;
}

function componentOverride(lines, attrIndex, classIndex) {
  for (let i = Math.max(0, attrIndex - 6); i <= classIndex; i++) {
    const match = lines[i].match(/\[ComponentProtoName\("([^"]+)"\)\]/);
    if (match) return match[1];
  }
  return "";
}

function dataFieldName(args, memberName) {
  const match = args.match(/"([^"]+)"/);
  return match ? match[1] : memberName.slice(0, 1).toLowerCase() + memberName.slice(1);
}

function blockText(lines, line) {
  const [start, end] = blockRange(lines, line);
  return lines.slice(start, end).join("\n");
}

function blockRange(lines, line) {
  let start = Math.min(Math.max(0, Number(line || 1) - 1), Math.max(0, lines.length - 1));
  while (start > 0 && !lines[start].startsWith("- type:")) start--;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("- type:")) end++;
  return [start, end];
}

function normalizeSpritePath(sprite) {
  let normalized = String(sprite).replace(/\\/g, "/");
  if (normalized.startsWith("/Textures/")) normalized = `Resources${normalized}`;
  else if (normalized.startsWith("Textures/")) normalized = `Resources/${normalized}`;
  else if (!normalized.startsWith("Resources/Textures/")) normalized = `Resources/Textures/${normalized}`;
  if (!normalized.endsWith(".rsi")) normalized += ".rsi";
  return normalized;
}

function safeProjectPath(projectRoot, relPath) {
  const root = path.resolve(projectRoot);
  const full = path.resolve(root, relPath);
  if (!full.startsWith(root)) {
    throw new Error("Path escapes project root.");
  }
  return full;
}

function relative(root, file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function readText(file) {
  return fs.readFileSync(file, "utf8");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { scanProject, readLatestProjectCache, readPrototypeBlock, savePrototypeBlock, createPrototype };
