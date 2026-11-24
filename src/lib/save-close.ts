import { closeTab, type TabState } from './tabs';

export function closeCurrentTab(current: () => TabState, id: string): TabState {
  return closeTab(current(), id);
}

export async function saveAndClose(request: {
  current: () => boolean;
  save: () => Promise<void>;
  cleanup: () => Promise<void>;
  close: () => void;
}): Promise<void> {
  const check = () => { if (!request.current()) throw new Error('Документ или проект изменился во время сохранения.'); };
  check();
  await request.save();
  check();
  await request.cleanup();
  check();
  request.close();
}

/** A deletion may already be in flight when an asynchronous edit arrives. */
export async function deleteDraftPreservingChanges(
  remove: () => Promise<unknown>,
  latest: () => string | undefined,
  submitted: string,
  persist: (content: string) => Promise<unknown>,
): Promise<void> {
  try {
    await remove();
  } finally {
    let content = latest();
    if (content !== submitted) {
      while (content !== undefined) {
        if (content === submitted) await remove();
        else await persist(content);
        const next = latest();
        if (next === content) break;
        content = next;
      }
    }
  }
}
