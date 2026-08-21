// hands.js — where work physically happens, and the one place that rations search.
//
// Mikey, 2026-08-21: "I don't want all the servers/tools unless they are running on pop.
// Therefore we shouldn't need to spin up servers." Correct, and it deleted a whole
// subsystem: searching, fetching and downloading are curl and a parser, so they run as
// one small python file (pop_agent.py) on whichever machine should do the work. No MCP
// bridge, no spawned servers, no second copy of this server spawning itself.
//
// pop_agent.py is SHIPPED OVER SSH STDIN ON EVERY CALL. Slightly wasteful, deliberately:
// there is then no installed copy on pop that can drift from this repo, which is exactly
// how the stale-server problem of 2026-08-20 happened.
//
// The other half of this file exists because of a measurement. DuckDuckGo rate-limits
// hard and lies about it: a served query returns ~28 KB with ten results, a throttled one
// returns ~14.2 KB with zero, and BOTH are HTTP 200 with no error field. So search is
// rationed here, and a throttle is never reported as "nothing found".

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, 'pop_agent.py');

// Absolute paths, per the shell-out hardening rule: a server spawned by the desktop app
// inherits a minimal PATH, and a bare `ssh` or `python3` resolves in a terminal and then
// silently fails to launch after a restart.
const SSH = '/usr/bin/ssh';
const PY  = '/usr/bin/python3';
const POP = process.env.POP_HOST || 'pop-os';

const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Run one op of pop_agent.py. host is 'pop' or 'mac'. Never throws; a failure comes back
 * as {ok:false, error} so a caller can never mistake a crash for an empty result.
 */
export function hands(host, job, { timeout_ms = 180000 } = {}) {
  const payload = JSON.stringify(job);
  let out;
  try {
    out = host === 'mac'
      ? execFileSync(PY, [AGENT, payload],
          { encoding: 'utf8', timeout: timeout_ms, maxBuffer: 64 * 1024 * 1024 })
      : execFileSync(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', POP,
                           `python3 - ${shq(payload)}`],
          { input: fs.readFileSync(AGENT), encoding: 'utf8',
            timeout: timeout_ms, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const why = (e.stderr || '').toString().trim().slice(-300) || e.message;
    return { ok: false, host, error: `${job.op} could not run on ${host}: ${why}` };
  }
  const last = String(out).trim().split('\n').filter(Boolean).pop();
  // host goes AFTER the spread: this side knows which machine it ran on, the agent
  // does not, and a spread in the wrong order is how a label quietly becomes a lie.
  try { return { ...JSON.parse(last), host }; }
  catch { return { ok: false, host, error: `${host} returned something that is not JSON: ${String(out).slice(0, 300)}` }; }
}

// ---- search rationing --------------------------------------------------------------
// Two machines means two IPs means two independent rate budgets — Mikey's point, first
// made 2026-08-19 about splitting two searches across two machines, and it applies here
// for a second reason: alternating halves the request rate each IP sees.
//
// Defaults are measured, not guessed (2026-08-21, and they are conservative on purpose —
// a block costs minutes, a wait costs seconds):
//   back-to-back queries from one IP: the second is throttled, every time.
//   polling every 5s during a block: still blocked after 162 seconds. Retrying feeds it.
const STATE_FILE = process.env.SIMPLE_JOB_STATE || path.join(HERE, '.search_state.json');
const GAP_MS   = Number(process.env.SEARCH_GAP_MS   || 30000);  // per host, between searches
const BLOCK_MS = Number(process.env.SEARCH_BLOCK_MS || 300000); // sit out this long after a throttle
const MAX_WAIT_MS = Number(process.env.SEARCH_MAX_WAIT_MS || 45000);

const HOSTS = ['mac', 'pop'];
const now = () => Date.now();

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const h of HOSTS) s[h] = s[h] || { last: 0, blocked_until: 0 };
    return s;
  } catch { return { mac: { last: 0, blocked_until: 0 }, pop: { last: 0, blocked_until: 0 } }; }
}
// State lives in a FILE, not a variable: the spacing has to survive a restart of this
// server, or the first search after every restart walks straight into a block.
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} }

const sleep = ms => { if (ms > 0) execFileSync('/bin/sleep', [(ms / 1000).toFixed(2)]); };

/** When could this host next search, in ms from now? */
const readyIn = (st, h) => Math.max(0, Math.max(st[h].blocked_until, st[h].last + GAP_MS) - now());

/**
 * One search, rationed. Alternates machines, waits out the gap rather than firing early,
 * and on a throttle sits the offending machine down and tries the other one.
 *
 * Returns the agent's own result plus {host, waited_ms, throttles}. A throttle that
 * cannot be worked around comes back ok:false with throttled:true — never as an empty
 * result list, because those two mean completely different things to a caller.
 */
export function search(query, { count = 5, timeout_ms = 60000 } = {}) {
  const st = loadState();
  const throttles = [];
  let waited = 0;

  // Prefer the machine that has been idle longest — that is what makes it alternate
  // without needing to remember whose turn it is.
  const order = [...HOSTS].sort((a, b) => (st[a].last - st[b].last));

  for (let attempt = 0; attempt < HOSTS.length; attempt++) {
    // among hosts still worth trying, take whichever is available soonest
    const candidates = order.filter(h => !throttles.some(t => t.host === h));
    if (!candidates.length) break;
    const host = candidates.reduce((a, b) => (readyIn(st, a) <= readyIn(st, b) ? a : b));

    const wait = readyIn(st, host);
    if (wait > MAX_WAIT_MS) {
      // Waiting minutes inside a tool call is worse than saying so plainly.
      return { ok: false, throttled: true, host,
        error: `both machines are inside their search cooldown; ${host} is free in ${Math.ceil(wait / 1000)}s. ` +
               `Search is rate-limited by duckduckgo, not by us — retry then.`,
        waited_ms: waited, throttles };
    }
    if (wait) { sleep(wait); waited += wait; }

    st[host].last = now(); saveState(st);
    const r = hands(host, { op: 'search', query, count }, { timeout_ms });

    if (r.ok) { saveState(st); return { ...r, waited_ms: waited, ...(throttles.length ? { throttles } : {}) }; }
    if (r.throttled) {
      st[host].blocked_until = now() + BLOCK_MS; saveState(st);
      throttles.push({ host, sitting_out_s: BLOCK_MS / 1000 });
      continue;                       // the other machine has its own budget
    }
    return { ...r, waited_ms: waited };   // a real failure, not a throttle
  }

  return { ok: false, throttled: true, waited_ms: waited, throttles,
    error: `duckduckgo throttled both machines. Each is sitting out ${BLOCK_MS / 1000}s. ` +
           `Retrying sooner tends to extend the block rather than clear it (measured 2026-08-21).` };
}

export const SEARCH_POLICY = { GAP_MS, BLOCK_MS, MAX_WAIT_MS, STATE_FILE, HOSTS };
