import assert from 'node:assert/strict';
import test from 'node:test';
import { resourceBreadcrumbs } from '../src/lib/resource-breadcrumbs';

test('resource folder breadcrumbs link back to each indexed ancestor', () => {
  assert.deepEqual(resourceBreadcrumbs('Resources/Prototypes/Entities'), [
    { name: 'Resources', path: 'Resources' },
    { name: 'Prototypes', path: 'Resources/Prototypes' },
    { name: 'Entities', path: 'Resources/Prototypes/Entities' },
  ]);
  assert.deepEqual(resourceBreadcrumbs('Resources'), [
    { name: 'Resources', path: 'Resources' },
  ]);
});
