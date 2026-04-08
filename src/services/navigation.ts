import { useProjectStore } from '../store/projectStore';
import { ValidationIssue } from '../types';

export async function openPrototypeByKey(key: string, field?: string | null) {
  const store = useProjectStore.getState();
  store.setSelectedRsiPath(null);
  store.setSelectedRsi(null);
  store.setHighlightedRsiState(null);
  store.setSelectedPrototypeId(key);
  store.setSelectedPrototype(null);
  store.setSelectedEditorTab('raw');
  store.setEditorJumpQuery(field ?? null);
  const detail = await window.prototypeStudio.getPrototype(key);
  store.setSelectedPrototype(detail);
}

export async function openRsiByPath(path: string, stateName?: string | null) {
  const store = useProjectStore.getState();
  store.setSelectedPrototypeId(null);
  store.setSelectedPrototype(null);
  store.setSelectedRsiPath(path);
  store.setSelectedRsi(null);
  store.setHighlightedRsiState(stateName ?? null);
  const detail = await window.prototypeStudio.getRsiAsset(path);
  store.setSelectedRsi(detail);
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
