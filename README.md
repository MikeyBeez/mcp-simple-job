# mcp-simple-job

Hand a subtask to a local model on another machine, and **verify the result before returning it**.

Built for a specific shape of problem: the capable, metered assistant runs on the machine
you sit in front of, while a perfectly good GPU box sits idle in the corner. Reading forty
files, summarising a long page, pulling down a dataset — none of that needs the expensive
model, and doing it in the assistant's context spends the one resource that is genuinely
scarce.

Measured on the author's setup, against doing the same four jobs in-context:
**~2.7x faster, and 6.1x less context spent**, because the raw pages never enter it.

## The one rule

**A job must come with a check.** A task that cannot state how it would be known to have
worked is refused — not warned about, refused.

This is not distrust of the local model. It is that the caller cannot tell. When the
assistant delegates a summary and gets back four hundred confident words, it has no
independent way to know whether those words describe the document or something else.
Delegating without a check adds a second place where a green light means nothing.

Checks are deliberately boring: `nonempty`, `contains`, `regex`, `json_keys`,
`line_count`, `shell` (your argv, exit 0 passes, output piped to stdin), and `summary_of`
(shorter than the source and not a copy of it).

## The four subtasks

| tool | what it does | where the work happens |
|---|---|---|
| `simple_job` | a plain prompt with your own check | the model host |
| `summarize` | text, or url/urls fetched first | worker machine (fetch + model) |
| `search_and_summarize` | search, read the top pages, summarise | search alternates hosts, rest on the worker |
| `download` | fetch a file, report bytes + sha256 | worker by default, any configured host |

`simple_job_stats` reports how all of them have actually gone, from a ledger row written
for every job.

---

# Running it

## Requirements

- **Node 18+** on the machine running the MCP server.
- **An OpenAI-compatible chat endpoint.** llama.cpp's `llama-server`, Ollama, vLLM,
  LM Studio, or a hosted API — anything that answers `POST /v1/chat/completions`.
- **Python 3.9+** on whichever machine does the fetching. Standard library only; no pip
  install, no node, no beautifulsoup.
- **SSH key auth** to the second machine, if you use one. It is optional (see below).

## How it is wired on the author's machines

Two computers:

- **A Mac mini** — the daily workstation. 16 GB, usually a few gigabytes into swap. It
  runs Claude Desktop and therefore this MCP server.
- **A Pop!\_OS box with an RTX 5070 Ti** — the laboratory. It runs a 35B model called
  ornith under `llama-server` on port 8080, and is idle most of the day.

An SSH tunnel makes the remote model look local to the Mac:

```bash
ssh -N -o ServerAliveInterval=30 -L 127.0.0.1:8081:127.0.0.1:8080 pop-os
```

`pop-os` is a `~/.ssh/config` alias with a key and `IdentitiesOnly yes`, so the server can
reach it non-interactively with `BatchMode=yes`.

The MCP client entry is just:

```json
{ "mcpServers": { "simple-job": { "command": "node", "args": ["/path/to/mcp-simple-job/index.js"] } } }
```

Defaults do the rest: the model at `127.0.0.1:8081`, the worker machine at `pop-os`, and
the ledger in an existing `~/Code/harness/` if there is one.

Nothing is ever called by hand. The assistant picks the tool — which is a harder problem
than it sounds, and is covered below.

## Running it on yours

**Two machines**, one running the client and one running the model:

```json
{
  "mcpServers": {
    "simple-job": {
      "command": "node",
      "args": ["/path/to/mcp-simple-job/index.js"],
      "env": {
        "ORNITH_URL": "http://127.0.0.1:8081/v1/chat/completions",
        "ORNITH_MODEL": "your-model-name",
        "POP_HOST": "your-ssh-alias"
      }
    }
  }
}
```

**One machine** — everything local, no SSH anywhere:

```json
{
  "env": {
    "ORNITH_URL": "http://127.0.0.1:11434/v1/chat/completions",
    "ORNITH_MODEL": "qwen3:8b",
    "SEARCH_HOSTS": "mac"
  }
}
```

`SEARCH_HOSTS=mac` is the switch that says "there is no second machine". Fetching,
downloading and searching all happen locally, and search simply has one rate budget
instead of two. Everything else behaves the same.

### Environment variables

| variable | default | what it does |
|---|---|---|
| `ORNITH_URL` | `http://127.0.0.1:8081/v1/chat/completions` | the chat endpoint |
| `ORNITH_MODEL` | `ornith:35b` | model name sent in the request |
| `POP_HOST` | `pop-os` | SSH alias of the worker machine |
| `SEARCH_HOSTS` | `mac,pop` | machines to alternate searches across; set to `mac` for a single-machine install |
| `SEARCH_GAP_MS` | `30000` | minimum gap between searches from one machine |
| `SEARCH_BLOCK_MS` | `300000` | how long a machine sits out after being throttled |
| `SIMPLE_JOB_STATE` | next to `index.js` | where search timing state is kept |
| `HARNESS_LEDGER` | `~/Code/harness/ledger.db` if that directory exists, else `~/.mcp-simple-job/ledger.db` | the SQLite ledger |
| `HARNESS_TRACE` | `~/Code/harness/current_trace.txt` | optional trace id to stamp on rows |

**The ledger is optional.** It is created on first use, and if it cannot be written the
jobs still run — logging is best-effort and never blocks work. `HARNESS_TRACE` is a hook
for the author's own tracing setup; ignore it and rows simply have a null trace id.

## Getting it actually used

This is the part most people skip, and it is the part that decides whether any of the
above matters.

A tool that nothing routes to is invisible no matter how well it works. The author has a
separate MCP server that works perfectly and had **zero calls in months**, purely because
nothing ever told the assistant to reach for it. Building a capability and routing to it
are two different jobs, and finishing the first one feels like finishing.

Three ways to close that gap, cheapest first. Most people want the second one.

**1. Do nothing, and see.** Some clients read tool descriptions well enough that a
sufficiently obvious request — "summarise these forty pages" — finds the tool on its own.
Worth trying for a day before adding machinery. Watch whether it actually gets called.

**2. Put a rule where your client keeps standing instructions.** Claude Desktop project
instructions, a `CLAUDE.md` for Claude Code, `.cursorrules`, a custom GPT's instructions —
whatever your client reads on every turn. Something like:

> There is a local model available through `simple-job`. Use it when the material is not
> already in context and the job is mechanical: summarising pages or files, web search
> plus reading, fetching downloads, extraction and reformatting. It is free and does not
> spend context on the source.
>
> Do it yourself when the text is already in context, when the job needs interpretation
> rather than transcription, or when being right matters more than being checkable.
> Never delegate judgment calls, code that must be correct, or file edits.
>
> Every job must carry a check — the server refuses work it cannot verify.

Spend as many words on **when not to delegate** as on when to. The failure mode of
routing a delegation tool is over-delegation, and an assistant that ships everything
downhill will hand you faithful transcription where you wanted judgment.

**3. Wire it into a router, if you have one.** If your setup already matches situations to
tools, add an entry for "bulk reading or fetching material not yet in context". The
advantage over a standing instruction is that it is *measurable* — you can count whether
it fired when it should have. A standing instruction either works or it does not, and
nothing records which.

## What not to send it

Anything where "looks right" is the only test. Judgment calls. Code that must be correct.
Editing files.

And one boundary found by measurement rather than taste: a small local model
**transcribes faithfully but does not interpret**. In testing it reproduced a source's
ambiguous phrasing verbatim instead of resolving what it meant, and summarised a
repository's star count as though it were part of a bug report. Send it transcription.
Keep interpretation.

---

# Notes from building it

Everything below is a measurement, not an opinion. The numbers are in the code comments too.

## Thinking is off by default

Reasoning models emit their deliberation and their answer from the same token budget. On
one summarising job run three times identically, **two of the three spent 5,500–6,000
characters thinking, hit the ceiling, and returned an empty answer with HTTP 200.**

Raising `max_tokens` did not fix it. `reasoning_effort: "low"` did not fix it. A
`/no_think` system tag did not fix it. Only `chat_template_kwargs: {enable_thinking:
false}` did, and the same job then answered in 258 tokens. Pass `think: true` for a job
that genuinely needs deliberation, and raise `max_tokens` with it.

## Search is rationed, and DuckDuckGo lies about why

DuckDuckGo does not rate-limit politely:

- a served query is **HTTP 200**, ~28 KB, ten result links
- a refused one is **HTTP 202**, ~14.2 KB, and its text reads *"Please complete the
  following challenge... Select all squares containing a duck"*

It is a captcha flag on the IP, not a timed limit, and spacing does not clear one. After
four minutes of silence, six queries at 30 s spacing from one machine and six at 15 s from
the other were **0 for 12**. Polling every 5 s during a block never recovered in 162 s —
retrying feeds it. The flag decayed on its own in roughly twenty minutes.

So searches are spaced, alternated across machines (two IPs are two budgets), and a
throttle is reported as `throttled`, never as "no results". Those mean opposite things.

## Reading follows the question

A long page gets cut to fit the model's window, and cutting from the top answers the wrong
question silently. Asked about *"sparse gating and load balancing"* in a 40,063-character
page with an 8,000-character window, the first version returned a fluent summary of the
article's opening — in which "load balancing" never appears (it starts at character
16,181) and "sparse" never appears (14,671).

So `focus` steers the window: a head for context, then the passages around each named
term, **one window guaranteed per term** before any term gets a second. Two earlier
versions were not enough — substring matching found "load" inside "download" and reported
42 hits of noise, and taking passages in document order spent the budget before reaching
character 16,181.

If the page never uses those words, the call returns `ok:false` with `focus_not_found`.
Zero hits is a better answer than a plausible summary of other material.

## A page that is mostly script is refused

One site served 68,896 bytes containing 40 characters of text ("Loading..."), which the
original `if not text` guard passed — so the shell went into a summary as source material
and the model wrote a confident benchmark figure citing it.

Two tests now, because either alone is fooled: an absolute floor, and a text-to-bytes
ratio that only condemns a page which is *also* short. A GitHub issue is 290,000 bytes of
markup around 3,896 characters of real discussion, and the ratio alone threw it away.

## Citations are numbered so they can be checked

`search_and_summarize` numbers the pages and asks for `[1]`, `[2]` rather than urls. Asked
for urls, the model attributed a figure it had read in a blog to a documentation page —
the fact was real and in the material, the attribution was not, and `summary_of` cannot
see that because a mislabelled bullet is the right length and is not a copy.

A url is a long opaque string to copy correctly. An integer is not, and it can be
range-checked against the pages actually read — which the code does, failing the call on
an out-of-range number and counting bullets with no source at all.

## Which machine is faster?

Verified by identical sha256 on both sides:

| | client machine | worker machine |
|---|---|---|
| ssh round-trip | — | ~185 ms per call |
| fetch 4 pages | ~1.7 s | ~2.0 s |
| download 20 MB | 17.5 MB/s | 12.6 MB/s |

**The client machine was faster at both.** Speed is not the reason to send work to the
worker. The reasons are that it holds the model, that it is idle while the other machine
is in use, and that a second machine is a second search budget. Choose a download's host
by where the file is needed, not by throughput.

## Tests

```bash
node test_e2e.mjs                        # 24 assertions, spawns the real server over JSON-RPC
node --test test/simple-job.test.mjs     # 19 unit assertions on the checks
```

The end-to-end suite spawns the actual server the way a client would, against a throwaway
ledger. An in-process test would not catch a PATH or environment bug, and those are
exactly the ones that only appear after a restart.

**Changes to `index.js` take effect when the client next starts the server. `pop_agent.py`
is re-read on every call, so changes to fetching, searching and downloading are live
immediately.**
