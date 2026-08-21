#!/usr/bin/env python3
"""
delegate.py — run ornith with TOOLS, using the bridge the dashboard already proved.

Called by simple_job when tools are asked for. Reads a JSON job on stdin, writes a JSON
result on stdout. Deliberately a separate process: mcp_bridge.py is Python and works;
porting it to Node would be rebuilding something that already runs.

Mikey, 2026-08-19: "if you have to do two searches, why not do them on two different
machines, one on each? If it fails, we should say so."

So: every failure is reported, never swallowed. A tool that errors, a step budget that
runs out, a model that stops without answering — each comes back named, in `failures`,
with the loop's own verdict in `stopped_because`. The caller must be able to tell a real
answer from an exhausted one, which is the entire reason this server exists.

stdin:  {"task","context","allow_servers":[...],"pinned":[...],"max_steps":N,
         "max_tokens":N,"temperature":F,"model":"..."}
stdout: {"ok","content","steps","tool_calls":[...],"failures":[...],"stopped_because","tokens"}
"""
import json, os, sys, time, urllib.request

sys.path.insert(0, os.path.expanduser("~/Code/harness"))
import mcp_bridge  # noqa: E402

ENDPOINT = os.environ.get("ORNITH_URL", "http://127.0.0.1:8081/v1/chat/completions")

SYSTEM = (
    "You are handling a delegated subtask and you have tools. Use them — do not guess at "
    "anything you could look up or read. When you have the answer, reply with the RESULT "
    "ONLY: no preamble, no explanation, no restating the question. If a tool fails or you "
    "cannot complete the task, say so in one line beginning with CANNOT: rather than "
    "inventing an answer."
)

def post(body, timeout):
    req = urllib.request.Request(ENDPOINT, json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

def main():
    job = json.load(sys.stdin)
    task        = job["task"]
    context     = job.get("context") or ""
    allow_srv   = job.get("allow_servers")
    pinned      = job.get("pinned") or []
    max_steps   = int(job.get("max_steps") or 8)
    max_tokens  = int(job.get("max_tokens") or 2048)
    temperature = float(job.get("temperature", 0.2))
    model       = job.get("model") or "ornith:35b"

    failures, calls = [], []   # emitted as "tool_calls" — the docstring is the contract
    br = None
    try:
        servers = mcp_bridge.servers_from_config(allow_srv) if allow_srv else mcp_bridge.servers_from_config()
        if not servers:
            return out(False, failures=["no MCP servers could be started from the config"],
                       stopped_because="no tools available")
        br = mcp_bridge.MCPBridge(servers)
        br.start()
        allow = br.select(task + " " + context[:400], k=22, pinned=pinned)
        tools = br.openai_tools(allow=allow)
        if not tools:
            failures.append("the bridge started but exposed no tools")

        user = f"{task}\n\n--- material ---\n{context}" if context else task
        msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
        tokens = 0

        for step in range(1, max_steps + 1):
            try:
                j = post({"model": model, "messages": msgs, "tools": tools,
                          "temperature": temperature, "max_tokens": max_tokens}, 240)
            except Exception as e:
                failures.append(f"step {step}: could not reach ornith: {e}")
                return out(False, steps=step, tool_calls=calls, failures=failures,
                           stopped_because="ornith unreachable", tokens=tokens)

            ch = (j.get("choices") or [{}])[0]
            m = ch.get("message") or {}
            tokens += (j.get("usage") or {}).get("completion_tokens", 0) or 0
            tcs = m.get("tool_calls") or []

            if not tcs:
                content = (m.get("content") or "").strip()
                if not content:
                    reason = ("produced reasoning but no answer — raise max_tokens"
                              if (m.get("reasoning_content") or "").strip()
                              else "returned an empty response")
                    failures.append(f"step {step}: {reason}")
                    return out(False, steps=step, tool_calls=calls, failures=failures,
                               stopped_because=reason, tokens=tokens)
                if content.upper().startswith("CANNOT"):
                    failures.append(f"ornith declined: {content[:200]}")
                    return out(False, content=content, steps=step, tool_calls=calls,
                               failures=failures, stopped_because="ornith said it could not do the task",
                               tokens=tokens)
                return out(True, content=content, steps=step, tool_calls=calls,
                           failures=failures, stopped_because="answered", tokens=tokens)

            msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": tcs})
            for tc in tcs:
                fn = tc.get("function") or {}
                name = fn.get("name") or "?"
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except Exception as e:
                    args, err = {}, f"unparseable arguments: {e}"
                    failures.append(f"step {step}: {name}: {err}")
                    msgs.append({"role": "tool", "tool_call_id": tc.get("id"), "content": f"[error] {err}"})
                    calls.append({"step": step, "tool": name, "ok": False, "error": err})
                    continue
                t0 = time.time()
                try:
                    res = br.call(name, args)
                    bad = res.startswith("[tool error]")
                    if bad:
                        failures.append(f"step {step}: {name} returned an error: {res[:160]}")
                    calls.append({"step": step, "tool": name, "ok": not bad,
                                  "ms": int((time.time() - t0) * 1000), "bytes": len(res)})
                except Exception as e:
                    res = f"[error] {e}"
                    failures.append(f"step {step}: {name} raised: {e}")
                    calls.append({"step": step, "tool": name, "ok": False, "error": str(e)})
                msgs.append({"role": "tool", "tool_call_id": tc.get("id"), "content": res[:20000]})

        failures.append(f"step budget of {max_steps} exhausted without an answer")
        return out(False, steps=max_steps, tool_calls=calls, failures=failures,
                   stopped_because=f"ran out of steps ({max_steps}) — it was still calling tools",
                   tokens=tokens)
    finally:
        if br:
            try: br.stop()
            except Exception: pass

def out(ok, **kw):
    print(json.dumps({"ok": ok, **kw}))
    return 0

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"ok": False, "failures": [f"delegate.py crashed: {e}"],
                          "stopped_because": "helper crashed"}))
