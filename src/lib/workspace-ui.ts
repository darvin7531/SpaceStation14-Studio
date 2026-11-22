import type { ResourceKind } from './api';
import { validProjectPath } from './recent-projects';

/** Electron's workspace:save-ui-state parity, scoped per project. No file
 * contents, unpublished drafts or absolute paths beyond the project key.
 */
export const WORKSPACE_UI_PREFIX = 'ss14-studio-rust.workspace-ui:';
export const LAST_PROJECT_KEY = 'ss14-studio-rust.last-project-root';

export interface WorkspaceUiState {
  query: string;
  kind: ResourceKind;
  fileView: 'search' | 'folders';
  explorerMode: 'files' | 'prototypes';
}
export const DEFAULT_WORKSPACE_UI: WorkspaceUiState = {
  query: '', kind: 'all', fileView: 'search', explorerMode: 'files',
};

export function readLastProject(storage: Pick<Storage, 'getItem'>): string | null {
  try {
    const candidate = storage.getItem(LAST_PROJECT_KEY);
    return validProjectPath(candidate) ? candidate : null;
  } catch { return null; }
}

function validKind(value: unknown): value is ResourceKind {
  return value === 'all' || value === 'yaml' || value === 'ftl' || value === 'rsi';
}
export function workspaceUiKey(projectRoot: string): string {
  return WORKSPACE_UI_PREFIX + projectRoot;
}
export function sanitizeWorkspaceUi(input: unknown): WorkspaceUiState {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ...DEFAULT_WORKSPACE_UI };
  const item = input as Record<string, unknown>;
  return {
    query: typeof item.query === 'string' && item.query.length <= 256
      && !/[\u0000-\u001f\u007f]/.test(item.query) ? item.query : '',
    kind: validKind(item.kind) ? item.kind : 'all',
    fileView: item.fileView === 'folders' ? 'folders' : 'search',
    explorerMode: item.explorerMode === 'prototypes' ? 'prototypes' : 'files',
  };
}

export function readWorkspaceUi(storage: Pick<Storage, 'getItem'>, root: string): WorkspaceUiState {
  if (!validProjectPath(root)) return { ...DEFAULT_WORKSPACE_UI };
  try {
    const raw = storage.getItem(workspaceUiKey(root));
    if (!raw || raw.length > 4096) return { ...DEFAULT_WORKSPACE_UI };
    return sanitizeWorkspaceUi(JSON.parse(raw) as unknown);
  } catch { return { ...DEFAULT_WORKSPACE_UI }; }
}

export function writeWorkspaceUi(
  storage: Pick<Storage, 'setItem'>, root: string, state: WorkspaceUiState,
): void {
  if (!validProjectPath(root)) return;
  storage.setItem(workspaceUiKey(root), JSON.stringify(sanitizeWorkspaceUi(state)));
}
