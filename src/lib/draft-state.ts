/** Isolated, deterministic draft logic. Source text remains authoritative. */
export function dirtyDocumentPaths(
  drafts: Readonly<Record<string, string>>,
  loaded: ReadonlyMap<string, { content: string }>,
): string[] {
  return Object.entries(drafts)
    .filter(([path, text]) => loaded.has(path) && loaded.get(path)?.content !== text)
    .map(([path]) => path);
}

/** Do not clobber additional keystrokes if a save completed after a new edit. */
export function reconcileSavedDraft(
  current: string | undefined,
  submitted: string,
  saved: string,
): string {
  return current === submitted ? saved : (current ?? saved);
}

/** A pending append must not discard edits or an unloaded recovery draft. */
export function hasUnprotectedDraft(path: string, drafts: Readonly<Record<string, string>>,
  loaded: ReadonlyMap<string, { content: string }>, bases: Readonly<Record<string, unknown>>): boolean {
  return bases[path] !== undefined || (drafts[path] !== undefined &&
    (!loaded.has(path) || drafts[path] !== loaded.get(path)?.content));
}
