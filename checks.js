// checks.js — the verdict layer. A job's result is only as good as its check.

import { execFileSync } from 'node:child_process';

export const CHECK_TYPES = ['contains', 'regex', 'json_keys', 'shell', 'nonempty', 'line_count', 'summary_of'];

/**
 * Run `check` against ornith's `output`. Returns { passed, why }.
 * Never throws — a broken check reports itself as failed, because a check that
 * errors must not read as a pass.
 */
export function runCheck(check, output) {
  if (!check || typeof check !== 'object' || !check.type)
    return { passed: false, why: 'no check supplied — simple_job refuses unverifiable work' };
  const text = String(output ?? '');
  try {
    switch (check.type) {
      case 'nonempty': {
        const n = text.trim().length;
        // The weakest real check, and the one that catches the failure this server
        // was built around: a model that returns HTTP 200 and says nothing.
        return { passed: n > 0, why: n > 0 ? `${n} characters returned` : 'the model returned nothing' };
      }
      case 'contains': {
        if (typeof check.text !== 'string' || !check.text)
          return { passed: false, why: 'contains needs a non-empty `text`' };
        const hit = check.case_sensitive
          ? text.includes(check.text)
          : text.toLowerCase().includes(check.text.toLowerCase());
        return { passed: hit, why: hit ? `found "${check.text}"` : `"${check.text}" is not in the output` };
      }
      case 'regex': {
        if (!check.pattern) return { passed: false, why: 'regex needs a `pattern`' };
        const re = new RegExp(check.pattern, check.flags || '');
        const m = text.match(re);
        return { passed: !!m, why: m ? `matched: ${String(m[0]).slice(0, 80)}` : `no match for /${check.pattern}/` };
      }
      case 'json_keys': {
        let parsed;
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        try { parsed = JSON.parse(fenced ? fenced[1] : text); }
        catch (e) { return { passed: false, why: `output is not JSON: ${e.message}` }; }
        const want = check.required || [];
        const missing = want.filter(k => !(k in (parsed || {})));
        return { passed: missing.length === 0,
                 why: missing.length ? `JSON is missing: ${missing.join(', ')}` : `JSON has all of: ${want.join(', ') || '(no keys required)'}`,
                 parsed };
      }
      case 'line_count': {
        const n = text.trim() ? text.trim().split('\n').length : 0;
        const { min = 0, max = Infinity } = check;
        const ok = n >= min && n <= max;
        return { passed: ok, why: `${n} lines (wanted ${min}..${max === Infinity ? '∞' : max})` };
      }
      case 'summary_of': {
        // The default check for summarising, and a real one rather than a polite one.
        // A summary has two failure modes a `nonempty` check waves straight through:
        // the model hands back the source (or a chunk of it) instead of summarising,
        // and the model emits a token or two and stops. Both return HTTP 200 and look
        // like success. This catches both, cheaply, with no second model call.
        const src = String(check.source ?? '');
        if (!src) return { passed: false, why: 'summary_of needs the `source` it should be a summary of' };
        const out = text.trim();
        if (!out) return { passed: false, why: 'the model returned nothing' };
        const ratio = out.length / src.length;
        // THE LIMIT SCALES WITH THE SOURCE, because compressibility does. A flat 60%
        // was tried first and rejected a perfectly good summary of this repo's own
        // README: 1,570 dense characters in, ~960 out, 62%. There is not much fat in a
        // short document to remove. A 100 KB page is a different matter entirely.
        const max = check.max_ratio ?? (src.length < 2000 ? 0.85
                                      : src.length < 10000 ? 0.6
                                      : 0.35);
        const min = check.min_chars ?? 80;
        if (out.length < min && src.length > min * 4)
          return { passed: false, why: `only ${out.length} characters back from ${src.length} — too short to be a summary` };
        if (ratio > max)
          return { passed: false, why: `output is ${Math.round(ratio * 100)}% the length of the source (limit ${Math.round(max * 100)}%) — it was probably copied, not summarised` };
        // A verbatim run of a couple of sentences means it is quoting, not summarising.
        const probe = src.replace(/\s+/g, ' ').trim().slice(0, 240);
        if (probe.length > 120 && out.replace(/\s+/g, ' ').includes(probe))
          return { passed: false, why: 'the output repeats the opening of the source verbatim' };
        return { passed: true,
                 why: `${out.length} characters from ${src.length} (${Math.round(ratio * 100)}% of the source, limit ${Math.round(max * 100)}%)` };
      }
      case 'shell': {
        // The strongest check: a real command, exit 0 is a pass. Never through a shell.
        if (!Array.isArray(check.command) || !check.command.length)
          return { passed: false, why: 'shell needs a `command` argv array, e.g. ["node","-e","..."]' };
        try {
          const out = execFileSync(check.command[0], check.command.slice(1), {
            encoding: 'utf8', timeout: check.timeout_ms || 30000,
            input: text, stdio: ['pipe', 'pipe', 'pipe'],
          });
          return { passed: true, why: `command exited 0${out.trim() ? `: ${out.trim().slice(0, 120)}` : ''}` };
        } catch (e) {
          return { passed: false, why: `command failed (exit ${e.status ?? '?'}): ${String(e.stderr || e.message).slice(0, 160)}` };
        }
      }
      default:
        return { passed: false, why: `unknown check type "${check.type}" — use one of: ${CHECK_TYPES.join(', ')}` };
    }
  } catch (e) {
    return { passed: false, why: `the check itself errored: ${e.message}` };
  }
}
