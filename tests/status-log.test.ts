import assert from 'node:assert/strict';
import test from 'node:test';
import { appendStatusRecord, type StatusRecord } from '../src/lib/status-log';

test('status history puts the most recent Electron-style event first and caps at 80', () => {
  let items: StatusRecord[] = [];
  for (let i = 0; i < 150; i += 1) {
    items = appendStatusRecord(items, { id: i, at: '12:00', message: String(i), kind: 'info' });
  }
  assert.equal(items.length, 80);
  assert.equal(items[0].message, '149');
  assert.equal(items[79].message, '70');
});

test('a status error remains distinct from a normal activity message', () => {
  const items = appendStatusRecord([{ id: 1, at: '12:00', message: 'ready', kind: 'info' }],
    { id: 2, at: '12:01', message: 'permission denied', kind: 'error' });
  assert.equal(items[0].kind, 'error');
  assert.equal(items[1].kind, 'info');
});
