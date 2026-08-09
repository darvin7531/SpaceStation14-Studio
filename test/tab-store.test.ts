import assert from 'node:assert/strict';
import test from 'node:test';
import { useProjectStore } from '../src/store/projectStore';

const project = {
  projectRoot: 'C:/tab-test',
  counts: { prototypes: 0, rsis: 0, locales: 0, components: 0, prototypeKinds: 0, issues: 0 },
  issues: [],
};

test('tab order keeps a valid active tab while reordering and closing', () => {
  const store = useProjectStore.getState();
  store.setProject(project);
  store.openPrototypeTab('entity:A', null);
  store.openPrototypeTab('entity:B', null);
  store.openPrototypeTab('entity:C', null);
  store.reorderTab('prototype:entity:A', 2);

  let state = useProjectStore.getState();
  assert.deepEqual(state.tabOrder, ['prototype:entity:B', 'prototype:entity:C', 'prototype:entity:A']);
  assert.equal(state.activeTabId, 'prototype:entity:C');

  state.closeTab('prototype:entity:C');
  state = useProjectStore.getState();
  assert.equal(state.activeTabId, 'prototype:entity:A');
  assert.deepEqual(state.tabOrder, ['prototype:entity:B', 'prototype:entity:A']);

  state.setProject({ ...project, projectRoot: 'C:/other-tab-test' });
});
