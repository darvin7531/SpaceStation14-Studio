/** Sequenced journal operations. Deletion must wait for older autosaves.
 * Otherwise a slow save could resurrect a draft after explicit discard.
 */
export class DraftWriteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const value = previous.catch(() => undefined).then(operation);
    const tail = value.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return value;
  }
}

export function journalKey(projectRoot: string, path: string): string {
  return JSON.stringify([projectRoot, path]);
}
