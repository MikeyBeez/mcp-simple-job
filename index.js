#!/usr/bin/env node
// mcp-simple-job — hand a CHECKABLE subtask to ornith on pop.
//
// Built 2026-08-19. This is the delegation half of `elvis`, retired the same evening
// because side jobs started going to pop directly.
//
// THE RULE: a job carries its own check. Not because ornith is unreliable, but because
// the caller cannot tell. Delegating without a check adds a second place where a green
// light means nothing, and removing those is what this system spent 2026-08-19 doing.
//
// 2026-08-21, Mikey: "I don't want all the servers/tools unless they are running on pop.
// Therefore we shouldn't need to spin up servers." That deleted a whole subsystem. The
// previous plan started a copy of every wired MCP server per job — 21 processes on a
// 16 GB Mac already in swap, including a copy of THIS server. Searching, fetching and
// downloading are curl and a parser; they are pop_agent.py, run over ssh. See hands.js.
//
// Also his: "so perhaps we can only have one ddg websearch subtask. But we can have a
// lot of other subtasks on pop." Exactly right, and it is the shape of this file. Search
// is rationed because someone else's server rations it. Everything else on pop is bound
// only by pop, and pop is idle.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ask, MODEL, DEFAULT_MAX_TOKENS } from './ornith.js';
import { runCheck, CHECK_TYPES } from './checks.js';
import { hands, search, SEARCH_POLICY } from './hands.js';

// ---- ledger: so "did delegation earn its place?" is answerable from data ------------
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
// Added 2026-08-21 when the server grew from one job type to four. Existing rows keep a
// NULL kind rather than being rewritten as 'simple_job' — they predate the distinction,
// and back-filling a column with a guess destroys the only honest thing about old data.
sql(`ALTER TABLE delegations ADD COLUMN kind TEXT;`);

const trace = () => { try { return fs.readFileSync('/Users/bard/Code/harness/current_trace.txt', 'utf8').trim() || null; } catch { return null; } };

function logRow({ kind, task, checkType, model, reached, passed, why, tokens, tps, ms }) {
  sql(`INSERT INTO delegations(kind,task,check_type,model,reached,check_passed,why,tokens,tps,ms,trace_id)
       VALUES(${q(kind)},${q(String(task).slice(0, 300))},${q(checkType)},${q(model || MODEL)},
              ${reached ? 1 : 0},${passed ? 1 : 0},${q(why)},${tokens || 0},${tps || 0},${ms},${q(trace())})`);
}

/** Ask ornith, run the check, log the row, shape the reply. The one path all jobs share. */
function runJob({ kind, prompt, context, check, a, t0 }) {
  const r = ask(prompt, { context, max_tokens: a.max_tokens, temperature: a.temperature,
                          model: a.model, think: !!a.think });
  const ms = Date.now() - t0;
  if (!r.ok) {
    logRow({ kind, task: prompt, checkType: check.type, model: a.model, reached: false, passed: false, why: r.error, ms });
    return { ok: false, reached_ornith: false, error: r.error, ms };
  }
  const v = runCheck(check, r.content);
  logRow({ kind, task: prompt, checkType: check.type, model: a.model, reached: true,
           passed: v.passed, why: v.why, tokens: r.tokens, tps: r.tps, ms });
  return {
    ok: v.passed, output: r.content,
    check: { type: check.type, passed: v.passed, why: v.why, ...(v.parsed ? { parsed: v.parsed } : {}) },
    model: a.model || MODEL, tokens: r.tokens, tokens_per_second: r.tps && Math.round(r.tps), ms,
    note: v.passed
      ? 'Check passed. The output is verified only as far as the check is meaningful.'
      : 'CHECK FAILED. Treat this output as unusable. Do the task yourself, or send a sharper task and a sharper check.',
    ...(r.finish_reason === 'length' ? { truncated: 'ornith hit max_tokens — the answer may be cut off' } : {}),
  };
}

// ORNITH REASONS BEFORE IT ANSWERS, and the reasoning comes out of the same budget as
// the answer. A summarize call with max_tokens=2048 failed live on 2026-08-21: 2048
// tokens of reasoning, zero tokens of answer, HTTP 200. The server caught it and said so
// -- which is the point of the server -- but the right fix is not to make the caller
// discover the number. Longer material makes it think longer, so the budget scales with
// the material and stays generous: local tokens are free and a starved call costs a
// whole round trip.
function budget(sourceChars, wantWords = 200, floor = 3072) {
  return Math.min(12000, Math.max(floor, Math.round(1200 + sourceChars / 3 + wantWords * 4)));
}

const COMMON = {
  max_tokens:  { type: 'number', description: `Default ${DEFAULT_MAX_TOKENS}. Ornith reasons before answering; too low returns an empty answer.` },
  temperature: { type: 'number' },
  model:       { type: 'string', description: `Default ${MODEL}.` },
  think:       { type: 'boolean', description: 'Let ornith reason before answering. Default false. Measured 2026-08-21: with reasoning on, 2 of 3 summarise runs returned an EMPTY answer after burning the whole token budget on thinking. Turn it on only for a job that genuinely needs deliberation, and raise max_tokens with it.' },
};

const TOOLS = {
  // ---------------------------------------------------------------- 1. plain prompt
  simple_job: {
    desc: 'Hand a plain subtask to ornith (35B, local, free) on pop and verify the result before returning it. ' +
          'REQUIRES a check — a task that cannot state how it would be known to have worked is refused. ' +
          'Good for: extraction against a schema, classifying, reformatting. ' +
          'Bad for: judgment calls, code that must be correct, editing files — do those yourself.',
    schema: {
      type: 'object',
      properties: {
        task:  { type: 'string', description: 'What ornith should do. Be specific about the output format.' },
        check: { type: 'object', description:
          'How the result is verified. One of: {type:"nonempty"} | {type:"contains",text,case_sensitive?} | ' +
          '{type:"regex",pattern,flags?} | {type:"json_keys",required:[...]} | {type:"line_count",min?,max?} | ' +
          '{type:"shell",command:[argv...],timeout_ms?} (result is piped to stdin; exit 0 passes).' },
        context: { type: 'string', description: 'Material for the task — the text, rows or code to work on.' },
        ...COMMON,
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
      return runJob({ kind: 'simple_job', prompt: a.task, context: a.context, check: a.check, a, t0: Date.now() });
    },
  },

  // ------------------------------------------------------------------- 2. summarize
  summarize: {
    desc: 'Summarise text with ornith on pop. Free, local, and it does not spend Claude context on the source. ' +
          'Pass the text directly, or a url/urls to fetch first (fetched on pop). ' +
          'The default check is a real one: the summary must be substantially shorter than the source and not a copy of it.',
    schema: {
      type: 'object',
      properties: {
        text:  { type: 'string', description: 'The material to summarise. Either this or url/urls.' },
        url:   { type: 'string', description: 'Fetch this page on pop and summarise it.' },
        urls:  { type: 'array', items: { type: 'string' }, description: 'Fetch several pages on pop and summarise them together.' },
        focus: { type: 'string', description: 'What the summary should be about, if not everything. e.g. "only the benchmark numbers".' },
        style: { type: 'string', description: '"bullets" (default) or "paragraph".' },
        max_words: { type: 'number', description: 'Target length. Default 200.' },
        check: { type: 'object', description: 'Optional. Defaults to {type:"summary_of"} against the source text.' },
        ...COMMON,
      },
    },
    fn: (a = {}) => {
      const t0 = Date.now();
      let source = a.text || '', fetched = null;
      const urls = a.urls || (a.url ? [a.url] : []);
      if (urls.length) {
        // Fetched on pop: the bytes land on the machine that also holds the model, and
        // never touch this Mac's memory or Claude's context.
        const cap = a.chars_per_page || 8000;
        const f = hands('pop', { op: 'fetch', urls, chars_per_page: cap, max_pages: urls.length,
                                 ...(a.focus ? { focus: a.focus } : {}) });
        if (!f.ok) return { ok: false, stage: 'fetch', error: f.error, failures: f.failures, ms: Date.now() - t0 };
        // A page can be far longer than what gets summarised, and a summary that quietly
        // covers the first fifth of a document is a wrong answer wearing a right one.
        // Live test 2026-08-21: a wikipedia page was 40,063 characters, of which 8,084
        // reached the model. Both numbers were in the reply and neither was labelled.
        fetched = { pages: f.pages.map(p => ({ url: p.url, title: p.title, chars: p.chars,
                                               ...(p.truncated ? { summarised_first: cap } : {}),
                                               ...(a.focus ? { focus_hits: p.focus_hits } : {}) })),
                    failures: f.failures };
        source = [source, ...f.pages.map(p => `## ${p.title || p.url}\n${p.url}\n\n${p.text}`)].filter(Boolean).join('\n\n---\n\n');
      }
      if (!String(source).trim())
        return { ok: false, error: 'summarize needs `text`, `url` or `urls` — there is nothing to summarise' };

      const words = a.max_words || 200;
      const style = (a.style || 'bullets') === 'paragraph'
        ? `Write a single prose paragraph of at most ${words} words.`
        : `Write at most ${words} words as short bullet points, one fact per bullet.`;
      const prompt = [
        'Summarise the material below.', style,
        a.focus ? `Cover only this: ${a.focus}` : 'Cover the main points and any concrete numbers.',
        'Use only what the material says. Do not add outside knowledge and do not speculate.',
      ].join(' ');

      const check = a.check && a.check.type ? a.check : { type: 'summary_of', source };
      if (check.type === 'summary_of' && !check.source) check.source = source;
      const out = runJob({ kind: 'summarize', prompt, context: source, check, t0,
                           a: { ...a, max_tokens: a.max_tokens || budget(source.length, words) } });
      const cut = fetched && fetched.pages.filter(p => p.summarised_first);
      // ZERO HITS IS AN ANSWER, and a better one than a fluent summary of the wrong
      // passage. If the page never uses the words the caller asked about, say that --
      // the model, handed the material anyway, will write something plausible about
      // whatever it did receive and nothing will mark it as off-target.
      const dry = fetched && a.focus && fetched.pages.every(p => p.focus_hits === 0);
      return { ...out, source_chars: source.length, ...(fetched ? { fetched } : {}),
               ...(dry ? { ok: false,
                     focus_not_found: `nothing on the page(s) matches "${a.focus}" — the summary above is of other material and does not answer it` } : {}),
               // Do not claim to have read "the passages around X" when there were no
               // such passages. With zero hits the excerpt falls back to the head, and
               // saying otherwise put two contradictory sentences in one reply --
               // focus_not_found reporting nothing matched, beside a partial message
               // claiming the window had followed the match. Seen live 2026-08-21.
               ...(cut && cut.length ? { partial: (a.focus && !dry)
                     ? `page(s) exceeded the ${cut[0].summarised_first}-character limit, so this reads the passages around "${a.focus}" rather than the whole page`
                     : `${cut.length} page(s) were longer than the ${cut[0].summarised_first}-character limit; this summarises the beginning of them, not the whole page. Raise chars_per_page to cover more.` } : {}) };
    },
  },

  // -------------------------------------------------------- 3. search and summarize
  search_and_summarize: {
    desc: 'Search the web (DuckDuckGo), read the top pages on pop, and have ornith summarise them — one call, no Claude context spent on the raw pages. ' +
          'THE ONLY SEARCH TOOL HERE, and deliberately: DuckDuckGo rate-limits hard, so searches are spaced and alternated between this Mac and pop. ' +
          'A throttle is reported as a throttle, never as "no results".',
    schema: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'The web search query.' },
        focus:  { type: 'string', description: 'What you actually want to know, if narrower than the query.' },
        pages:  { type: 'number', description: 'How many top results to read. Default 3, max 8. More pages costs seconds, not money.' },
        count:  { type: 'number', description: 'How many search results to list. Default 6.' },
        max_words: { type: 'number', description: 'Target summary length. Default 250.' },
        results_only: { type: 'boolean', description: 'Skip reading and summarising; just return the search results.' },
        check:  { type: 'object', description: 'Optional. Defaults to {type:"summary_of"} against the fetched pages.' },
        ...COMMON,
      },
      required: ['query'],
    },
    fn: (a = {}) => {
      const t0 = Date.now();
      if (!a.query || !String(a.query).trim()) return { ok: false, error: 'query is required' };

      const s = search(a.query, { count: Math.min(a.count || 6, 20) });
      if (!s.ok) return { ok: false, stage: 'search', ...s, ms: Date.now() - t0 };
      const found = { searched_from: s.host, waited_ms: s.waited_ms, results: s.results,
                      ...(s.ads_dropped ? { ads_dropped: s.ads_dropped } : {}),
                      ...(s.throttles ? { throttles: s.throttles } : {}) };
      if (a.results_only) return { ok: true, ...found, ms: Date.now() - t0 };

      const want = Math.min(Math.max(a.pages || 3, 1), 8);
      const f = hands('pop', { op: 'fetch', urls: s.results.slice(0, want).map(r => r.url),
                               chars_per_page: a.chars_per_page || 7000, max_pages: want,
                               focus: a.focus || a.query },
                      { timeout_ms: 120000 });
      if (!f.ok)
        return { ok: false, stage: 'fetch', ...found,
                 error: 'search worked but no page could be read: ' + (f.error || ''),
                 failures: f.failures, ms: Date.now() - t0 };

      // PAGES ARE NUMBERED, AND THE NUMBERS ARE VERIFIED ON THE WAY BACK OUT.
      // Live test 2026-08-21: asked for urls in brackets, ornith attributed a figure it
      // had read in a blog to the llama.cpp docs url. The FACT was in the material --
      // it did not invent anything -- but the attribution was wrong, and `summary_of`
      // cannot see that, because a mislabelled bullet is the right length and is not a
      // copy. A url is a long opaque string to copy correctly; "[2]" is not, and an
      // index can be range-checked against the pages actually read. That turns an
      // unverifiable claim into a verifiable one, which is the whole point of this
      // server. The urls are put back below, by this code rather than by the model.
      const source = f.pages.map((p, i) => `## [${i + 1}] ${p.title || p.url}\n${p.url}\n\n${p.text}`).join('\n\n---\n\n');
      const prompt = [
        `Answer this using only the numbered pages below: ${a.focus || a.query}`,
        `At most ${a.max_words || 250} words, as short bullet points.`,
        `End every bullet with the number of the page it came from, in brackets, like [1]. ` +
        `The pages are numbered 1 to ${f.pages.length}. Use only those numbers, and use the number of the page the fact is actually on.`,
        'If the pages do not answer it, say so plainly instead of guessing.',
      ].join(' ');

      const check = a.check && a.check.type ? a.check : { type: 'summary_of', source };
      if (check.type === 'summary_of' && !check.source) check.source = source;
      const out = runJob({ kind: 'search_and_summarize', prompt, context: source, check, t0,
                           a: { ...a, max_tokens: a.max_tokens || budget(source.length, a.max_words || 250) } });

      const sources = f.pages.map((p, i) => ({ n: i + 1, url: p.url, title: p.title, chars: p.chars,
                                               ...(p.truncated ? { read_only_first: source.length && true } : {}) }));
      const cited = [...new Set([...(out.output || '').matchAll(/\[(\d+)\]/g)].map(m => +m[1]))];
      const bogus = cited.filter(n => n < 1 || n > f.pages.length);
      const lines = (out.output || '').split('\n').filter(l => /^\s*[-*]/.test(l));
      const uncited = lines.filter(l => !/\[\d+\]/.test(l)).length;

      return { ...out, ...found, sources,
               citations: { cited_pages: cited.sort((x, y) => x - y),
                            bullets: lines.length, bullets_without_a_source: uncited,
                            ...(bogus.length ? { invalid: bogus } : {}) },
               ...(bogus.length ? { ok: false,
                     citation_error: `the summary cites page(s) ${bogus.join(', ')} but only ${f.pages.length} were read — treat the attributions as unreliable` } : {}),
               ...(uncited ? { citation_warning: `${uncited} of ${lines.length} bullets carry no source number` } : {}),
               ...(f.failures && f.failures.length ? { could_not_read: f.failures } : {}) };
    },
  },

  // ------------------------------------------------------------------- 4. download
  download: {
    desc: 'Download a file to pop (default) or to this Mac. Returns the path, byte count and sha256 — a download that reports success without those is not verified. ' +
          'Put it on pop when pop will use it (models, datasets, anything for the GPU); put it on the mac when you will open it.',
    schema: {
      type: 'object',
      properties: {
        url:  { type: 'string', description: 'http(s) url to download.' },
        host: { type: 'string', description: '"pop" (default) or "mac". Measured 2026-08-21: the Mac is the faster of the two (17.5 vs 12.6 MB/s), so choose by where the file is needed, not by speed.' },
        dest: { type: 'string', description: 'Directory on that machine. Default ~/Downloads.' },
        filename: { type: 'string', description: 'Override the filename.' },
        overwrite: { type: 'boolean', description: 'Replace an existing file. Default false — an existing file is an error, not a silent clobber.' },
        max_mb: { type: 'number', description: 'Refuse anything larger. Default 500.' },
        expect_sha256: { type: 'string', description: 'If given, the download fails unless the hash matches.' },
      },
      required: ['url'],
    },
    fn: (a = {}) => {
      const t0 = Date.now();
      if (!a.url) return { ok: false, error: 'url is required' };
      const host = a.host === 'mac' ? 'mac' : 'pop';
      const r = hands(host, { op: 'download', url: a.url, dest: a.dest, filename: a.filename,
                              overwrite: !!a.overwrite, max_mb: a.max_mb, timeout: 600 },
                      { timeout_ms: 900000 });
      const ms = Date.now() - t0;
      if (!r.ok) {
        logRow({ kind: 'download', task: a.url, checkType: 'download', reached: false, passed: false, why: r.error, ms });
        return { ...r, ms };
      }
      // A hash the caller supplied is the only check here that means anything.
      if (a.expect_sha256 && a.expect_sha256.toLowerCase() !== r.sha256) {
        logRow({ kind: 'download', task: a.url, checkType: 'sha256', reached: true, passed: false, why: 'sha mismatch', ms });
        // `ok` LAST. Written as {ok:false, ...r} it was overwritten by r.ok===true, so
        // a failed hash check returned ok:true WITH the mismatch error sitting beside
        // it -- a green light next to the evidence against it, which is the exact
        // failure this whole server exists to prevent. Caught by the e2e suite.
        return { ...r, ok: false, ms,
          error: `sha256 mismatch: expected ${a.expect_sha256.toLowerCase()}, got ${r.sha256}. The file is on disk but is NOT what you asked for.` };
      }
      logRow({ kind: 'download', task: a.url, checkType: a.expect_sha256 ? 'sha256' : 'bytes',
               reached: true, passed: true, why: `${r.bytes} bytes`, ms });
      // Below a megabyte the rate rounds to 0.0 and reads like a failure rather than a
      // fast small file. Report a rate only where it means something; bytes and ms are
      // always there.
      const rate = r.bytes / 1e6 / (ms / 1000);
      return { ...r, ms, ...(rate >= 0.1 ? { mb_per_second: +rate.toFixed(1) } : {}),
               ...(a.expect_sha256 ? { sha256_verified: true } : {}),
               note: `On ${host}, not on the other machine.` };
    },
  },

  // ---------------------------------------------------------------------- 5. stats
  simple_job_stats: {
    desc: 'How delegation has actually gone: jobs by kind, how often the check passed, and speed. Answers whether this server is earning its place.',
    schema: { type: 'object', properties: {} },
    fn: () => {
      try {
        const rows = execFileSync(SQLITE, ['-batch', DB,
          `SELECT COALESCE(kind,'(before kinds existed)')||'|'||COUNT(*)||'|'||COALESCE(SUM(reached),0)||'|'||
                  COALESCE(SUM(check_passed),0)||'|'||COALESCE(ROUND(AVG(ms)),0)||'|'||COALESCE(ROUND(AVG(tps),1),0)
           FROM delegations GROUP BY kind ORDER BY COUNT(*) DESC;`],
          { encoding: 'utf8', timeout: 8000 }).trim();
        const by_kind = rows ? rows.split('\n').map(line => {
          const [kind, jobs, reached, passed, avgMs, avgTps] = line.split('|');
          return { kind, jobs: +jobs, reached_ornith: +reached, check_passed: +passed,
                   pass_rate: +jobs ? Math.round(100 * passed / jobs) + '%' : 'n/a',
                   avg_ms: +avgMs, avg_tokens_per_second: +avgTps };
        }) : [];
        const jobs = by_kind.reduce((n, k) => n + k.jobs, 0);
        const passed = by_kind.reduce((n, k) => n + k.check_passed, 0);
        return { jobs, check_passed: passed,
                 pass_rate: jobs ? Math.round(100 * passed / jobs) + '%' : 'n/a', by_kind,
                 search_policy: { gap_between_searches_s: SEARCH_POLICY.GAP_MS / 1000,
                                  cooldown_after_throttle_s: SEARCH_POLICY.BLOCK_MS / 1000,
                                  alternates_between: SEARCH_POLICY.HOSTS },
                 note: jobs < 10 ? 'Too few jobs to judge yet.'
                     : passed / jobs < 0.6 ? 'Under 60% passing — either the tasks are too hard for ornith or the checks are wrong. Worth looking before delegating more.'
                     : 'Passing consistently. Delegation is earning its place.' };
      } catch (e) { return { error: String(e.message) }; }
    },
  },
};

const server = new Server({ name: 'mcp-simple-job', version: '2.0.0' }, { capabilities: { tools: {} } });
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
console.error(`[simple-job] connected. ornith=${MODEL}, tools=${Object.keys(TOOLS).join(', ')}`);
