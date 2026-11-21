import type { OpenRevision, ResourceDocument, ResourceDriftReport } from './api';

/** Ignore stale disk checks after local saves, tab closes or reloads. */
export function retainCurrentDrifts(
  result: ResourceDriftReport,
  submitted: OpenRevision[],
  baselines: ReadonlyMap<string, ResourceDocument>,
): ResourceDriftReport {
  const expected = new Map(submitted.map((item) => [item.path, item.expected_revision]));
  return {
    ...result,
    items: result.items.filter((item) =>
      baselines.has(item.path) && expected.get(item.path) === baselines.get(item.path)?.revision),
  };
}
