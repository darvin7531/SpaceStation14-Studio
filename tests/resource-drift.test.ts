import assert from 'node:assert/strict';
import test from 'node:test';
import { retainCurrentDrifts } from '../src/lib/resource-drift';
import type { OpenRevision, ResourceDocument, ResourceDriftReport } from '../src/lib/api';

test('late disk checks do not report changes after local saves or tab closure', () => {
  const requested: OpenRevision[] = [
    { path: 'Resources/Prototypes/one.yml', expected_revision: 'before' },
    { path: 'Resources/Locale/en-US/a.ftl', expected_revision: 'ftl-before' },
  ];
  const probe: ResourceDriftReport = {
    checked: 2, skipped: 0,
    items: [
      { path: requested[0].path, status: 'changed', error_code: null },
      { path: requested[1].path, status: 'unavailable', error_code: 'RESOURCE_READ_FAILED' },
    ],
  };
  const baselines = new Map<string, ResourceDocument>([
    [requested[0].path, {
      path: requested[0].path, revision: 'after', content: 'updated', bytes: 7,
    }],
  ]);
  assert.deepEqual(retainCurrentDrifts(probe, requested, baselines).items, []);
  baselines.set(requested[0].path, {
    path: requested[0].path, revision: 'before', content: 'old', bytes: 3,
  });
  assert.deepEqual(retainCurrentDrifts(probe, requested, baselines).items, [probe.items[0]]);
  assert.equal(probe.items.length, 2);
});
