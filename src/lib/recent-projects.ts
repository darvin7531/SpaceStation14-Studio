/** Recently opened canonical source roots. Only paths, never project data. */
export const RECENT_PROJECTS_KEY = 'ss14-studio-rust.recent-projects';
export const MAX_RECENT_PROJECTS = 8;

export function validProjectPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || value.trim() !== value || /[\u0000-\u001f]/.test(value)) return false;
  // Linux/macOS, Windows drives and UNC paths. ProjectIndex performs the real
  // canonicalization and permission checks on every open.
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
    || value.startsWith('\\\\');
}

export function rememberRecentProject(paths: readonly string[], projectRoot: string): string[] {
  if (!validProjectPath(projectRoot)) return [...paths].slice(0, MAX_RECENT_PROJECTS);
  const unique = new Set<string>();
  return [projectRoot, ...paths].filter((path) => {
    if (!validProjectPath(path) || unique.has(path)) return false;
    unique.add(path);
    return true;
  }).slice(0, MAX_RECENT_PROJECTS);
}

export function readRecentProjects(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const raw = storage.getItem(RECENT_PROJECTS_KEY);
    if (!raw || raw.length > 50_000) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(validProjectPath);
    return valid.reduce<string[]>((result, path) =>
      rememberRecentProject(result, path).reverse(), []).reverse().slice(0, MAX_RECENT_PROJECTS);
  } catch { return []; }
}

export function writeRecentProjects(
  storage: Pick<Storage, 'setItem'>, paths: readonly string[],
): void {
  storage.setItem(RECENT_PROJECTS_KEY,
    JSON.stringify(paths.filter(validProjectPath).slice(0, MAX_RECENT_PROJECTS)));
}
