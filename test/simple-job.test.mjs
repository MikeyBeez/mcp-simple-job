// The check layer is the whole point of this server, so it is what gets tested.
// The ornith call itself is exercised separately (it needs pop reachable); these run offline.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { runCheck, CHECK_TYPES } from '../checks.js';

describe('a job without a check is refused', () => {
  test('no check at all fails, and says why', () => {
    const r = runCheck(undefined, 'anything');
    assert.equal(r.passed, false);
    assert.match(r.why, /refuses unverifiable work/);
  });
  test('a check with no type fails', () => {
    assert.equal(runCheck({}, 'x').passed, false);
  });
  test('an unknown check type fails and lists the real ones', () => {
    const r = runCheck({ type: 'vibes' }, 'x');
    assert.equal(r.passed, false);
    for (const t of CHECK_TYPES) assert.ok(r.why.includes(t), `should offer ${t}`);
  });
});

describe('nonempty catches the silent success', () => {
  test('an empty answer fails', () => {
    // The exact failure this server exists for: HTTP 200, nothing in it.
    const r = runCheck({ type: 'nonempty' }, '   \n  ');
    assert.equal(r.passed, false);
    assert.match(r.why, /returned nothing/);
  });
  test('real content passes', () => {
    assert.equal(runCheck({ type: 'nonempty' }, 'READY').passed, true);
  });
});

describe('the substantive checks', () => {
  test('contains, case-insensitive by default', () => {
    assert.equal(runCheck({ type: 'contains', text: 'ready' }, 'READY').passed, true);
    assert.equal(runCheck({ type: 'contains', text: 'ready', case_sensitive: true }, 'READY').passed, false);
    assert.equal(runCheck({ type: 'contains', text: 'nope' }, 'READY').passed, false);
  });
  test('regex', () => {
    assert.equal(runCheck({ type: 'regex', pattern: '^\\d+(, ?\\d+)*$' }, '2, 3, 5, 7').passed, true);
    assert.equal(runCheck({ type: 'regex', pattern: '^\\d+$' }, 'two three').passed, false);
  });
  test('json_keys, including through a code fence', () => {
    const ok = runCheck({ type: 'json_keys', required: ['name', 'age'] }, '{"name":"a","age":1}');
    assert.equal(ok.passed, true);
    assert.deepEqual(ok.parsed, { name: 'a', age: 1 });
    const fenced = runCheck({ type: 'json_keys', required: ['name'] }, '```json\n{"name":"a"}\n```');
    assert.equal(fenced.passed, true, 'models fence their JSON; the check must cope');
    const missing = runCheck({ type: 'json_keys', required: ['name', 'age'] }, '{"name":"a"}');
    assert.equal(missing.passed, false);
    assert.match(missing.why, /missing: age/);
    assert.equal(runCheck({ type: 'json_keys', required: [] }, 'not json').passed, false);
  });
  test('line_count', () => {
    assert.equal(runCheck({ type: 'line_count', min: 3, max: 3 }, 'a\nb\nc').passed, true);
    assert.equal(runCheck({ type: 'line_count', min: 5 }, 'a\nb').passed, false);
  });
  test('shell — exit 0 passes, nonzero fails, and the output is piped in', () => {
    assert.equal(runCheck({ type: 'shell', command: ['node', '-e',
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(s.trim()==="42"?0:1))'] }, '42').passed, true);
    assert.equal(runCheck({ type: 'shell', command: ['node', '-e',
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(s.trim()==="42"?0:1))'] }, '41').passed, false);
  });
  test('a malformed shell check fails rather than passing by default', () => {
    assert.equal(runCheck({ type: 'shell' }, 'x').passed, false);
    assert.equal(runCheck({ type: 'shell', command: ['definitely-not-a-real-binary-xyz'] }, 'x').passed, false);
  });
});

describe('a broken check never reads as a pass', () => {
  test('an invalid regex fails closed', () => {
    const r = runCheck({ type: 'regex', pattern: '([unclosed' }, 'anything');
    assert.equal(r.passed, false);
    assert.match(r.why, /errored/);
  });
});
