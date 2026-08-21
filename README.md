# mcp-simple-job

Hands a subtask to **ornith** (35B, llama.cpp on pop:8080 via the tunnel on 127.0.0.1:8081)
and verifies the result before returning it.

## The one rule

**A job must come with a check.** `simple_job` refuses a task that cannot say how it
would be known to have worked.

This is not distrust of ornith. It is that the caller cannot tell. Delegating without a
check adds a second place where a green light means nothing — which is the failure this
whole system spent 2026-08-19 removing. The check is also a useful filter: if you cannot
state the test, it is not a simple job.

## Good jobs

- extract fields from text against a schema — the schema is the check
- summarise each of forty files — wrong is obvious, and spot-checkable
- classify items into buckets — the counts must add up
- transform text to a format — a regex or a parse is the check

## Bad jobs

Anything where "looks right" is the only test. Judgment calls. Code that must be correct.
Editing files. Send those up, not down.

## Predecessor

This is the delegation half of `elvis`, retired 2026-08-19 because work started going to
pop directly. What changed: ornith now reaches all of Mikey's MCP servers, so it can act
rather than only answer — and this version refuses unverifiable work, which elvis did not.

## Note on the model

Ornith emits `reasoning_content` separately from `content`. Budget tokens for the
thinking or the answer arrives empty with HTTP 200 — the exact silent-success shape this
server exists to prevent. `max_tokens` covers both; the default is generous.
