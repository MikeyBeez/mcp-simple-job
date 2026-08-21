// ornith.js — the call to pop. One function, deliberately small.

import { execFileSync } from 'node:child_process';

export const ENDPOINT = process.env.ORNITH_URL || 'http://127.0.0.1:8081/v1/chat/completions';
export const MODEL    = process.env.ORNITH_MODEL || 'ornith:35b';

// Ornith is a REASONING model: it fills `reasoning_content` before `content`. A tight
// max_tokens gets eaten by the thinking and the answer comes back empty with HTTP 200 —
// which is precisely the silent success this server exists to catch. Budget generously.
export const DEFAULT_MAX_TOKENS = 2048;   // ample once thinking is off; see ask()

const SYSTEM = (
  'You are handling a delegated subtask. Do exactly what is asked and nothing more. ' +
  'Answer with the result only — no preamble, no explanation, no restating the question. ' +
  'If the task specifies a format, obey it exactly. If you cannot do the task, say so ' +
  'in one line beginning with CANNOT: rather than guessing.'
);

/** Returns { ok, content, reasoning, tokens, tps, error }. Never throws. */
export function ask(task, { context = '', max_tokens = DEFAULT_MAX_TOKENS, temperature = 0.2,
                            model = MODEL, timeout_ms = 180000, think = false } = {}) {
  const user = context ? `${task}\n\n--- material ---\n${context}` : task;
  // THINKING IS OFF BY DEFAULT, and that is a measurement, not a preference.
  // Measured 2026-08-21 on a 1,570-character summarise job, three identical runs:
  //   thinking on  -> 2 of 3 produced 5,500-6,000 characters of reasoning, hit the
  //                   token ceiling, and returned an EMPTY answer with HTTP 200.
  //   thinking off -> a clean 991-character answer in 258 tokens, finish_reason stop.
  // A two-in-three silent-empty rate is not a budget problem to tune around; the
  // thinking is simply not wanted for mechanical work. Every job this server accepts is
  // mechanical by definition -- it has to carry a check -- so off is the right default.
  // `reasoning_effort:"low"` and a "/no_think" system tag were both tried and neither
  // stopped it: 843 and 907 characters of reasoning respectively. Only the template
  // switch actually turns it off.
  const body = JSON.stringify({
    model, temperature, max_tokens,
    ...(think ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
  });
  let raw;
  try {
    // curl rather than fetch: this runs inside an MCP server spawned by the desktop app,
    // whose environment and DNS cannot be relied on. The same reasoning that puts an
    // absolute sqlite3 path in ledger_log.mjs.
    raw = execFileSync('/usr/bin/curl', [
      '-s', '--max-time', String(Math.ceil(timeout_ms / 1000)),
      '-X', 'POST', ENDPOINT, '-H', 'Content-Type: application/json', '-d', body,
    ], { encoding: 'utf8', timeout: timeout_ms + 5000, maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    return { ok: false, error: `could not reach ornith at ${ENDPOINT}: ${e.message}. Is the ssh tunnel up and llama-server running on pop?` };
  }
  let j;
  try { j = JSON.parse(raw); }
  catch { return { ok: false, error: `ornith returned something that is not JSON: ${String(raw).slice(0, 300)}` }; }
  if (j.error) return { ok: false, error: `ornith error: ${JSON.stringify(j.error).slice(0, 300)}` };

  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const content = (msg.content || '').trim();
  const reasoning = (msg.reasoning_content || '').trim();
  const t = j.timings || {}, u = j.usage || {};

  if (!content) {
    return { ok: false, reasoning,
      error: reasoning
        ? `ornith produced ${u.completion_tokens || '?'} tokens of reasoning but no answer — raise max_tokens (currently ${max_tokens})`
        : 'ornith returned an empty response with no reasoning',
      tokens: u.completion_tokens, finish_reason: (j.choices?.[0] || {}).finish_reason };
  }
  return { ok: true, content, reasoning,
           tokens: u.completion_tokens, tps: t.predicted_per_second,
           finish_reason: (j.choices?.[0] || {}).finish_reason };
}
