import type { ResourceDocument, ResourceEntry } from './api';

/** The native index can change while editor tabs have unsaved source text.
 * Reconcile reads without ever accepting a new disk revision for a dirty tab.
 */
export interface RefreshedTabRead {
  path: string;
  document: ResourceDocument | null;
}

export interface WorkspaceRefreshResult {
  documents: Map<string, ResourceDocument>;
  drafts: Record<string, string>;
  draftBases: Record<string, string>;
  reloaded: string[];
  conflicting: string[];
  unavailable: string[];
}

export function reconcileWorkspaceRefresh(
  tabs: ResourceEntry[],
  previousDocuments: ReadonlyMap<string, ResourceDocument>,
  previousDrafts: Readonly<Record<string, string>>,
  previousBases: Readonly<Record<string, string>>,
  reads: RefreshedTabRead[],
): WorkspaceRefreshResult {
  const documents = new Map(previousDocuments);
  const drafts = { ...previousDrafts };
  const draftBases = { ...previousBases };
  const currentPaths = new Set(tabs.map((tab) => tab.path));
  const reloaded: string[] = [];
  const conflicting: string[] = [];
  const unavailable: string[] = [];

  for (const { path, document: incoming } of reads) {
    if (!currentPaths.has(path)) continue;
    if (!incoming) {
      unavailable.push(path);
      continue;
    }
    const old = documents.get(path);
    if (!old) {
      documents.set(path, incoming);
      if (drafts[path] === undefined) drafts[path] = incoming.content;
      // A restored draft can exist before the source file is first opened.
      if (drafts[path] !== incoming.content
        && draftBases[path] !== undefined
        && draftBases[path] !== incoming.revision) {
        conflicting.push(path);
      }
      continue;
    }
    const changed = old.revision !== incoming.revision;
    const text = drafts[path] ?? old.content;
    const dirty = text !== old.content;
    if (dirty) {
      // Do not silently move the optimistic-save baseline for a dirty file.
      if (changed) conflicting.push(path);
      continue;
    }

    if (changed) reloaded.push(path);
    documents.set(path, incoming);
    drafts[path] = incoming.content;
    delete draftBases[path];
  }
  return { documents, drafts, draftBases, reloaded, conflicting, unavailable };
}
