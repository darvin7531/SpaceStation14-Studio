/** Stable folder breadcrumbs; no filesystem access is required in the renderer. */
export function resourceBreadcrumbs(directory: string): Array<{ name: string; path: string }> {
  const parts = directory.split('/').filter(Boolean);
  return parts.map((name, i) => ({
    name, path: parts.slice(0, i + 1).join('/'),
  }));
}
