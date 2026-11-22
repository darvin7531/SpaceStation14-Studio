/** The OS folder dialog returns absolute paths. Convert only a validated
 * in-project directory to the relative paths accepted by existing Rust writes.
 * The native creation command still canonicalizes paths (including symlinks).
 */
export type ProjectFolderKind = 'prototype' | 'fluent' | 'rsi';

const BASE: Record<ProjectFolderKind, readonly string[]> = {
  prototype: ['Resources', 'Prototypes'],
  fluent: ['Resources', 'Locale'],
  rsi: ['Resources', 'Textures'],
};

export function projectFolderDefaultPath(projectRoot: string, kind: ProjectFolderKind): string {
  return projectRoot.replace(/[/\\]+$/, '') + '/' + BASE[kind].join('/');
}

export function relativeProjectFolder(
  projectRoot: string,
  selectedFolder: string,
  kind: ProjectFolderKind,
): string | null {
  if (!projectRoot || !selectedFolder) return null;
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const selected = selectedFolder.replace(/\\/g, '/').replace(/\/+$/, '');
  // Drive paths are case-insensitive on Windows, POSIX roots are not.
  const win = /^[A-Za-z]:\//.test(root);
  const rootCompare = win ? root.toLowerCase() : root;
  const selectedCompare = win ? selected.toLowerCase() : selected;
  if (!selectedCompare.startsWith(rootCompare + '/')) return null;
  const rel = selected.slice(root.length + 1);
  const parts = rel.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' ||
    part.endsWith('.') || part.endsWith(' ') ||
    /[\\:*?"<>|\x00-\x1f]/.test(part))) return null;
  const base = BASE[kind];
  if (parts.length < base.length || base.some((part, i) => parts[i] !== part)) return null;
  if (kind === 'fluent' && parts.length < 3) return null; // Need a specific game locale.
  return parts.join('/');
}
