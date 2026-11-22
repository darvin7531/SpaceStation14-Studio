import { DraftWriteQueue, journalKey } from './draft-queue';
import type { ResourceDocument } from './api';

interface ExitRecoveryRequest {
  root: string;
  paths: readonly string[];
  documents: ReadonlyMap<string, ResourceDocument>;
  drafts: Readonly<Record<string, string>>;
  bases: Readonly<Record<string, string>>;
  queue: DraftWriteQueue;
  persist: (path: string, baseRevision: string, content: string) => Promise<{ durability_warning?: string | null }>;
}

/** Wait for older journal writes and then persist the latest text before exiting.
 * Never write an in-memory draft to the SS14 project itself.
 */
export async function persistExitRecovery(request: ExitRecoveryRequest): Promise<void> {
  await Promise.all(request.paths.map((path) => {
    const document = request.documents.get(path);
    const content = request.drafts[path];
    if (!document || content === undefined) {
      throw new Error('Невозможно завершить выход: текст или исходная ревизия черновика недоступны: ' + path);
    }
    const base = request.bases[path] ?? document.revision;
    return request.queue.run(journalKey(request.root, path), async () => {
      const saved = await request.persist(path, base, content);
      if (saved.durability_warning) throw new Error(saved.durability_warning);
    });
  }));
}
