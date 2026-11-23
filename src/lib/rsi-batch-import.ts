import { uiText, type Language } from './ui-language';
import { studio } from './api';
import { normalizeStudioError } from './errors';
import type { RsiMetadata } from './rsi-layout';
import { planRsiBatch, pngHeaderSize } from './rsi-batch-plan';

export async function importRsiBatch({ projectRoot, path, revision, inspection, files, directions, delay,
  replaceExisting, readPng, refresh, onProgress, language = 'ru' }: {
  language?: Language; projectRoot: string; path: string; revision: string; inspection: RsiMetadata; files: File[];
  directions: 1 | 4 | 8; delay: number; replaceExisting: boolean;
  readPng: (file: File) => Promise<string>; refresh: (projectRoot: string) => Promise<void>;
  onProgress: (message: string) => void;
}): Promise<{ attempted: boolean; outcome: string }> {
  let attempted = false;
  let outcome = '';
  let imported = 0;
  const warnings: string[] = [];
  const archives: string[] = [];
  try {
    if (!inspection.size || inspection.errors.length) {
      throw new Error(uiText(language, 'rsi.bulk.invalidMeta'));
    }
    const headers = await Promise.all(files.map(async (file) => {
      const head = new Uint8Array(await file.slice(0, 24).arrayBuffer());
      const dimensions = pngHeaderSize(head);
      if (!dimensions) throw new Error(uiText(language, 'rsi.bulk.invalidHeader', { name: file.name }));
      return {
        name: file.name, bytes: file.size,
        width: dimensions.width, height: dimensions.height,
      };
    }));
    const plan = planRsiBatch(
      headers, inspection.size, directions,
      new Set(inspection.states.map((state) => state.name)),
      language, replaceExisting,
    );
    if (!Number.isFinite(delay) || delay < 0.01 || delay > 60) {
      throw new Error(uiText(language, 'rsi.bulk.invalidDelay'));
    }
    // Snapshot every old sheet before writing; Rust checks both revisions.
    const pngRevisions = new Map<string, string>();
    for (const item of plan) {
      if (inspection.states.some((state) => state.name === item.name)) {
        const sheet = await studio.readRsiSheet(path, item.name + '.png', projectRoot);
        if (!sheet.revision) throw new Error(uiText(language, 'rsi.bulk.missingRevision', { name: item.name }));
        pngRevisions.set(item.name, sheet.revision);
      }
    }
    let expectedRevision = revision;
    for (let i = 0; i < plan.length; i++) {
      const item = plan[i];
      onProgress(uiText(language, 'rsi.bulk.progress', { current: i + 1, total: plan.length, name: item.name }));
      const data_url = await readPng(files[i]);
      const oldState = inspection.states.find((state) => state.name === item.name);
      const preserveDelays = oldState && item.directions === oldState.directions
        && oldState.delays.length === item.directions
        && oldState.delays.every((items) => items.length === item.frames);
      const request = {
        path,
        expected_revision: expectedRevision,
        name: item.name,
        directions: item.directions,
        frames_per_direction: item.frames,
        delay_seconds: delay,
        data_url,
        ...(oldState ? { expected_png_revision: pngRevisions.get(item.name) } : {}),
        ...(preserveDelays && oldState ? { delays: oldState.delays } : {}),
      };
      attempted = true;
      const result = oldState
        ? await studio.replaceRsiState(request, projectRoot)
        : await studio.importRsiState(request, projectRoot);
      if (result.warning) warnings.push(item.name + ': ' + result.warning);
      expectedRevision = result.revision;
      if (result.archive_path) archives.push(item.name + ': ' + result.archive_path);
      imported++;
    }
    outcome = uiText(language, 'rsi.bulk.batchSuccess', { count: imported, total: files.length, path });
  } catch (error) {
    const normalized = normalizeStudioError(error);
    const detail = [normalized.message, normalized.hint, normalized.code, normalized.details]
      .filter(Boolean).join(' ');
    outcome = uiText(language, 'rsi.bulk.partial', { count: imported, total: files.length, detail });
  } finally {
    if (attempted) {
      try {
        await refresh(projectRoot);
      } catch (error) {
        const refreshError = normalizeStudioError(error);
        outcome += ' ' + uiText(language, 'rsi.bulk.refreshFailed') + ' '
          + [refreshError.message, refreshError.hint, refreshError.code, refreshError.details]
            .filter(Boolean).join(' ');
      }
    }
    if (archives.length) outcome += ' ' + uiText(language, 'rsi.bulk.archives') + ' ' + archives.join('; ');
    if (warnings.length) outcome += ' ' + uiText(language, 'rsi.bulk.warnings') + ' ' + warnings.join(' ');
  }
  return { attempted, outcome };
}

export function publishBatchOutcome(origin: string, active: string | null, message: string, publish: (message: string) => void) {
  if (origin === active) publish(message);
}
