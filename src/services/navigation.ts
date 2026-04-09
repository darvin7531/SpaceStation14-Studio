import { useProjectStore } from '../store/projectStore';
import { ValidationIssue } from '../types';

export async function openPrototypeByKey(key: string, field?: string | null) {
  const store = useProjectStore.getState();
  const detail = await window.prototypeStudio.getPrototype(key);
  store.openPrototypeTab(key, detail, { editorTab: 'raw', jumpQuery: field ?? null });
}

export async function openRsiByPath(path: string, stateName?: string | null) {
  const store = useProjectStore.getState();
  const detail = await window.prototypeStudio.getRsiAsset(path);
  store.openRsiTab(detail?.path ?? path, detail, { highlightedState: stateName ?? null });
}

export async function navigateToIssue(issue: ValidationIssue) {
  if (issue.prototypeKey) {
    await openPrototypeByKey(issue.prototypeKey, issue.field);
    return;
  }
  if (issue.rsiPath) {
    await openRsiByPath(issue.rsiPath, issue.stateName);
  }
}
