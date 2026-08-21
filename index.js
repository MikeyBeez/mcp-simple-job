#!/usr/bin/env node
// mcp-simple-job — hand a CHECKABLE subtask to ornith on pop.
//
// Built 2026-08-19 at Mikey's suggestion. This is the delegation half of `elvis`,
// retired earlier the same evening because side jobs started going to pop directly.
// Two things are different: ornith now reaches every one of Mikey's MCP servers, so it
// can act rather than only answer — and this version REFUSES work it cannot verify.
//
// The rule: a job must carry its own check. Not because ornith is unreliable, but
// because the caller cannot tell. Delegating without a check adds a second place where
// a green light means nothing, and removing those is what the whole day was about.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ask, MODEL, DEFAULT_MAX_TOKENS } from './ornith.js';
import { runCheck, CHECK_TYPES } from './checks.js';

// ---- ledger: so "did delegation earn its place?" is answerable from data ----------
const DB = process.env.HARNESS_LEDGER || '/Users/bard/Code/harness/ledger.db';
const SQLITE = ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3']
  .find(p => { try { return fs.existsSync(p); } catch { return false; } }) || 'sqlite3';
const q = s => `'${String(s ?? '').replace(/'/g, "''")}'`;
function sql(text) {
  try { execFileSync(SQLITE, ['-batch', DB, 'PRAGMA busy_timeout=3000; ' + text],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'ignore', 'pipe'] }); return true; }
  catch { return false; }   // logging must never break a job
}
sql(`CREATE TABLE IF NOT EXISTS delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  task TEXT, check_type TEXT, model TEXT,
  reached INTEGER, check_passed INTEGER, why TEXT,
  tokens INTEGER, tps REAL, ms INTEGER, trace_id TEXT);`);

const trace = () => { try { return fs.readFileSync('/Users/bard/Code/harness/current_trace.txt', 'utf8').trim() || null; } catch { return null; } };

const TOOLS = {
  simple_job: {
    desc: 'Hand a subtask to ornith (35B, local, free) on pop and verify the result before returning it. ' +
          'REQUIRES a check — a task that cannot state how it would be known to have worked is refused. ' +
          'Good for: extraction against a schema, summarising, classifying, reformatting. ' +
          'Bad for: judgment calls, code that must be correct, editing files — do those yourself.',
    schema: {
      type: 'object',
      properties: {
        task:  { type: 'string', description: 'What ornith should do. Be specific about the output format.' },
        check: { type: 'object', description:
          'How the result is verified. One of: ' +
          '{type:"nonempty"} | {type:"contains",text,case_sensitive?} | {type:"regex",pattern,flags?} | ' +
          '{type:"json_keys",required:[...]} | {type:"line_count",min?,max?} | ' +
          '{type:"shell",command:[argv...],timeout_ms?} (result is piped to stdin; exit 0 passes).' },
        context: { type: 'string', description: 'Material for the task — the text, rows or code to work on.' },
        max_tokens: { type: 'number', description: `Default ${DEFAULT_MAX_TOKENS}. Ornith reasons before answering; too low returns an empty answer.` },
        temperature: { type: 'number' },
        model: { type: 'string', description: `Default ${MODEL}.` },
      },
      required: ['task', 'check'],
    },
    fn: (a = {}) => {
      if (!a.task || !String(a.task).trim()) return { ok: false, error: 'task is required' };
      if (!a.check || !a.check.type)
        return { ok: false, error:
          'A check is required. simple_job will not delegate work it cannot verify — otherwise a ' +
          'reported success means nothing. Use one of: ' + CHECK_TYPES.join(', ') +
          '. If you cannot state how you would know it worked, it is not a simple job: do it yourself.' };

      const t0 = Date.now();
      const r = ask(a.task, { context: a.context, max_tokens: a.max_tokens,
                              temperature: a.temperature, model: a.model });
      const ms = Date.now() - t0;

      if (!r.ok) {
        sql(`INSERT INTO delegations(task,check_type,model,reached,check_passed,why,ms,trace_id)
             VALUES(${q(a.task.slice(0,300))},${q(a.check.type)},${q(a.model||MODEL)},0,0,${q(r.error)},${ms},${q(trace())})`);
        return { ok: false, reached_ornith: false, error: r.error, ms };
      }

      const v = runCheck(a.check, r.content);
      sql(`INSERT INTO delegations(task,check_type,model,reached,check_passed,why,tokens,tps,ms,trace_id)
           VALUES(${q(a.task.slice(0,300))},${q(a.check.type)},${q(a.model||MODEL)},1,${v.passed?1:0},
                  ${q(v.why)},${r.tokens||0},${r.tps||0},${ms},${q(trace())})`);

      return {
        ok: v.passed, output: r.content,
        check: { type: a.check.type, passed: v.passed, why: v.why, ...(v.parsed ? { parsed: v.parsed } : {}) },
        model: a.model || MODEL, tokens: r.tokens, tokens_per_second: r.tps && Math.round(r.tps), ms,
        note: v.passed
          ? 'Check passed. The output is verified only to the extent the check is meaningful — a nonempty check proves very little.'
          : 'CHECK FAILED. Treat this output as unusable. Do the task yourself, or send a sharper task and a sharper check.',
        ...(r.finish_reason === 'length' ? { truncated: 'ornith hit max_tokens — the answer may be cut off' } : {}),
      };
    },
  },

  simple_job_stats: {
    desc: 'How delegation to ornith has actually gone: jobs run, how often the check passed, and speed. Answers whether this server is earning its place.',
    schema: { type: 'object', properties: { limit: { type: 'number' } } },
    fn: () => {
      try {
        const out = execFileSync(SQLITE, ['-batch', DB,
          `SELECT COUNT(*)||'|'||COALESCE(SUM(reached),0)||'|'||COALESCE(SUM(check_passed),0)||'|'||
           COALESCE(ROUND(AVG(ms)),0)||'|'||COALESCE(ROUND(AVG(tps),1),0) FROM delegations;`],
          { encoding: 'utf8', timeout: 8000 }).trim().split('|');
        const [jobs, reached, passed, avgMs, avgTps] = out.map(Number);
        return { jobs, reached_ornith: reached, check_passed: passed,
                 pass_rate: jobs ? Math.round(100 * passed / jobs) + '%' : 'n/a',
                 avg_ms: avgMs, avg_tokens_per_second: avgTps,
                 note: jobs < 10 ? 'Too few jobs to judge yet.'
                     : passed / jobs < 0.6 ? 'Under 60% passing — either the tasks are too hard for ornith or the checks are wrong. Worth looking before delegating more.'
                     : 'Passing consistently. Delegation is earning its place.' };
      } catch (e) { return { error: String(e.message) }; }
    },
  },
};

const server = new Server({ name: 'mcp-simple-job', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.desc, inputSchema: t.schema })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = TOOLS[req.params.name];
  if (!t) return { content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool ${req.params.name}` }) }], isError: true };
  let out;
  try { out = t.fn(req.params.arguments || {}); }
  catch (e) { out = { ok: false, error: String(e.message) }; }
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] };
});
await server.connect(new StdioServerTransport());
console.error(`[simple-job] connected. ornith=${MODEL}`);
