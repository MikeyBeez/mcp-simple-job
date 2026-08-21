# mcp-simple-job

Hands a subtask to **ornith** (35B, llama.cpp on pop:8080 via the tunnel on 127.0.0.1:8081)
and verifies the result before returning it.

## The one rule

**A job must come with a check.** A task that cannot say how it would be known to have
worked is refused.

This is not distrust of ornith. It is that the caller cannot tell. Delegating without a
check adds a second place where a green light means nothing — which is the failure this
whole system spent 2026-08-19 removing. The check is also a useful filter: if you cannot
state the test, it is not a simple job.

## The four subtasks

| tool | what it does | where the work happens |
|---|---|---|
| `simple_job` | a plain prompt with your own check | pop (model) |
| `summarize` | text, or url/urls fetched first | pop (fetch + model) |
| `search_and_summarize` | search, read the top pages, summarise | search alternates mac/pop, rest on pop |
| `download` | fetch a file, report bytes + sha256 | pop by default, mac on request |

`simple_job_stats` reports how all of them have actually gone.

## No servers are spun up

An earlier design started a copy of every wired MCP server for each job — 21 processes on
a 16 GB Mac already in swap, including a copy of this server. Mikey ruled it out
(2026-08-21: *"I don't want all the servers/tools unless they are running on pop.
Therefore we shouldn't need to spin up servers"*) and he was right: searching, fetching
and downloading are curl and a parser.

They are one file, `pop_agent.py`, shipped over ssh stdin **on every call** so no
installed copy on pop can drift from this repo.

## Search is rationed, and here is why

DuckDuckGo does not rate-limit politely. Measured 2026-08-21:

- a served query is **HTTP 200**, ~28 KB, ten result links
- a refused one is **HTTP 202**, ~14.2 KB, and its visible text reads *"Please complete
  the following challenge... Select all squares containing a duck"*

It is a **captcha flag on the IP**, not a timed limit. Spacing does not clear one:
after four minutes of silence, six queries at 30 s spacing from the Mac and six at 15 s
from pop were **0 for 12**. Polling every 5 s during a block never recovered in 162 s —
retrying feeds it. The flag decayed on its own in roughly twenty minutes.

So `hands.js` rations search: a minimum gap per machine, and it **alternates between the
Mac and pop**, which are two IPs and therefore two independent budgets — Mikey's idea,
first about splitting two searches across two machines, and it applies twice over here.
When both are flagged the tool says *throttled*, never *no results*. Those mean opposite
things and a caller must be able to tell them apart.

There is deliberately only **one** search tool. Everything else runs on pop as often as
you like; pop is idle.

## Thinking is off by default

Ornith emits `reasoning_content` separately from `content`, and left to itself it will
spend the entire token budget thinking and return an empty answer with HTTP 200 — the
exact silent success this server exists to catch.

Measured on one 1,570-character summarise job, three identical runs:

- thinking **on**: 2 of 3 produced 5,500–6,000 characters of reasoning, hit the ceiling,
  returned **nothing**
- thinking **off** (`chat_template_kwargs: {enable_thinking: false}`): a clean answer in
  258 tokens

`reasoning_effort:"low"` and a `/no_think` system tag were both tried; neither stopped it.
Pass `think: true` for a job that genuinely needs deliberation, and raise `max_tokens`.

## Which machine is faster?

Measured 2026-08-21, verified by identical sha256 both sides:

| | mac | pop |
|---|---|---|
| ssh round-trip | — | ~185 ms, paid on every pop call |
| fetch 4 pages | ~1.7 s | ~2.0 s |
| download 20 MB | 17.5 MB/s | 12.6 MB/s |

**The Mac is the faster machine at both.** So speed is not the reason to send work to
pop. The reasons are that pop holds the model, that pop is idle while the Mac is his
daily workstation in swap, and that a second machine is a second search budget. Choose a
download's host by where the file is needed, not by throughput.

## Bad jobs

Anything where "looks right" is the only test. Judgment calls. Code that must be correct.
Editing files. Send those up, not down.

## Tests

    node test_e2e.mjs

Spawns the real server over JSON-RPC against a throwaway ledger, the way Claude Desktop
spawns it — an in-process test would not catch a PATH or environment bug, and those only
appear after a restart. 17 assertions.

**Changes to `index.js` take effect on the next Claude Desktop restart, not now.**
