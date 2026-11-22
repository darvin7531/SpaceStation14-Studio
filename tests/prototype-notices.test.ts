import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { prototypeNotice } from '../src/lib/prototype-notices';

test('localizes known codes and preserves unknown or incomplete diagnostics', () => {
  const notice = { code: 'INHERIT_MULTIPLE_PARENTS', message: 'original', params: { id: 'A', count: 2 } };
  assert.match(prototypeNotice('en', notice), /A: 2 parents/);
  assert.match(prototypeNotice('ru', notice), /A: 2 родителя/);
  assert.equal(prototypeNotice('en', { ...notice, params: { id: 'A' } }), 'original');
  assert.equal(prototypeNotice('en', { code: 'FUTURE_CODE', message: 'unchanged', params: {} }), 'unchanged');
  assert.equal(prototypeNotice('en', 'arbitrary backend text'), 'arbitrary backend text');
});
