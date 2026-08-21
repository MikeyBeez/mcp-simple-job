// Drives the REAL server over stdio JSON-RPC, spawned the way Claude Desktop spawns it,
// against a THROWAWAY ledger. An in-process test of these functions would not catch a
// PATH or environment bug, and those are the ones that only appear after a restart.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const DB = '/tmp/sj_test.db';
fs.rmSync(DB, { force: true });
const srv = spawn(process.execPath, ['index.js'], {
  cwd: import.meta.dirname,
  env: { ...process.env, HARNESS_LEDGER: DB, SIMPLE_JOB_STATE: '/tmp/sj_test_state.json' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buf = '';
const waiters = new Map();
srv.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } } catch {}
  }
});
let id = 0;
const rpc = (method, params) => new Promise((res, rej) => {
  const myId = ++id;
  waiters.set(myId, res);
  srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  setTimeout(() => rej(new Error(`${method} timed out`)), 900000);
});

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
};
const call = async (tool, args) => JSON.parse((await rpc('tools/call', { name: tool, arguments: args })).result.content[0].text);

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
const list = await rpc('tools/list', {});
const names = list.result.tools.map(t => t.name);
check('tools/list has all five', names.length === 5, names.join(', '));

console.log('\n-- the check rule still bites --');
const refused = await call('simple_job', { task: 'say hi' });
check('a job with no check is refused', refused.ok === false && /check is required/i.test(refused.error));

console.log('\n-- simple_job --');
const sj = await call('simple_job', {
  task: 'Return ONLY the JSON object {"colour":"blue","n":7}. No other text.',
  check: { type: 'json_keys', required: ['colour', 'n'] } });
check('simple_job passes its check', sj.ok === true, sj.check && sj.check.why);
check('simple_job reports tokens/sec', typeof sj.tokens_per_second === 'number', `${sj.tokens_per_second} tok/s, ${sj.ms} ms`);

console.log('\n-- summarize (text) --');
const src = fs.readFileSync('README.md', 'utf8');
const sm = await call('summarize', { text: src, max_words: 60 });
check('summarize passes summary_of', sm.ok === true, (sm.check && sm.check.why) || sm.error);
check('summary is genuinely shorter', (sm.output || '').length < src.length, `${(sm.output || '').length} vs ${src.length} chars`);

console.log('\n-- summarize (url, fetched on pop) --');
const su = await call('summarize', { url: 'https://ollama.com/library/qwen3', max_words: 50 });
check('url summarize works', su.ok === true, (su.check && su.check.why) || su.error);
check('it says what it read', !!su.fetched && su.fetched.pages.length === 1, su.fetched && su.fetched.pages[0] ? `${su.fetched.pages[0].chars} chars from ${su.fetched.pages[0].url}` : 'nothing fetched');
const big = await call('summarize', { url: 'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)', max_words: 120 });
check('summarize a big page', big.ok === true, (big.check && big.check.why) || big.error);

console.log('\n-- download to mac and to pop, verified by sha --');
const dm = await call('download', { url: 'https://speed.cloudflare.com/__down?bytes=2000000', host: 'mac', dest: '/tmp/sjdl', filename: 'a.bin', overwrite: true });
check('download to mac ok', dm.ok === true, dm.ok ? `${dm.bytes} B @ ${dm.mb_per_second} MB/s -> ${dm.path}` : dm.error);
check('the file really is on the mac', fs.existsSync('/tmp/sjdl/a.bin') && fs.statSync('/tmp/sjdl/a.bin').size === 2000000);
const dp = await call('download', { url: 'https://speed.cloudflare.com/__down?bytes=2000000', host: 'pop', dest: '/tmp/sjdl', filename: 'a.bin', overwrite: true });
check('download to pop ok', dp.ok === true, dp.ok ? `${dp.bytes} B @ ${dp.mb_per_second} MB/s on pop` : dp.error);
check('both machines got identical bytes', !!dm.sha256 && dm.sha256 === dp.sha256, String(dm.sha256).slice(0, 16));
const bad = await call('download', { url: 'https://speed.cloudflare.com/__down?bytes=1000', host: 'mac', dest: '/tmp/sjdl', filename: 'b.bin', overwrite: true, expect_sha256: 'deadbeef' });
check('a wrong sha is a failure, not a pass', bad.ok === false && /mismatch/.test(bad.error));
const exists = await call('download', { url: 'https://speed.cloudflare.com/__down?bytes=1000', host: 'mac', dest: '/tmp/sjdl', filename: 'a.bin' });
check('an existing file is not silently clobbered', exists.ok === false && /already exists/.test(exists.error));

console.log('\n-- ledger --');
const stats = await call('simple_job_stats', {});
check('rows landed in the throwaway ledger', stats.jobs >= 5, `${stats.jobs} jobs: ` + stats.by_kind.map(k => `${k.kind}=${k.jobs}`).join(' '));
check('kinds are recorded separately', stats.by_kind.some(k => k.kind === 'summarize') && stats.by_kind.some(k => k.kind === 'download'));

srv.kill();
fs.rmSync('/tmp/sjdl', { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
