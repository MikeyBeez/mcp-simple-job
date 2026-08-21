// checks.js — the verdict layer. A job's result is only as good as its check.

import { execFileSync } from 'node:child_process';

export const CHECK_TYPES = ['contains', 'regex', 'json_keys', 'shell', 'nonempty', 'line_count'];

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
