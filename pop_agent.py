#!/usr/bin/env python3
"""
pop_agent.py — the hands. Runs ON pop, never on the Mac.

Mikey, 2026-08-21: "I don't want all the servers/tools unless they are running on pop.
Therefore we shouldn't need to spin up servers."

He is right, and this file is what that decision looks like. The earlier plan started a
copy of every wired MCP server per job — 21 extra processes on a 16 GB Mac already in
swap, including a copy of simple-job itself. None of that is needed. Searching, fetching
and downloading are curl and a parser. They belong on the machine that also holds the
model, so the bytes never cross the tunnel.

Shipped to pop over ssh stdin on EVERY call (ssh pop-os 'python3 - <job>' < pop_agent.py)
so there is no installed copy that can go stale — the failure mode found across this
system on 2026-08-20. Nothing is written to pop except what `download` is asked to write.

SEARCH IS DUCKDUCKGO, BY INSTRUCTION (Mikey, 2026-08-21: "Don't use brave. use ddg").
Brave was probed first the same day and returned HTTP 200 with ZERO results from pop —
the same 200-but-empty shape recorded months earlier. DDG needs no credential, so there
is nothing to store on pop, nothing to leak and nothing to rotate.

argv, not stdin, carries the job: stdin is the program itself. Safe here only because no
secret is involved — argv is visible in `ps` to anyone on the box.

Usage:  python3 - '{"op":"search","query":"...","count":5}'
Ops:    search | fetch | download
Out:    one JSON object on stdout. Every failure is named, never swallowed.
"""
import sys, os, re, json, html, time, hashlib, urllib.request, urllib.parse, urllib.error

STATUS = [0]      # last response status, so the caller can tell 200 from 202
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
DDG = "https://html.duckduckgo.com/html/"


def die(msg, **extra):
    print(json.dumps({"ok": False, "error": msg, **extra}))
    sys.exit(0)          # exit 0: the JSON carries the verdict, not the exit code


class _Redirects(urllib.request.HTTPRedirectHandler):
    """Follow 307 and 308 as well as the older codes.

    THE TWO MACHINES DISAGREED WITHOUT THIS. Measured 2026-08-21: one url returned
    "HTTP Error 308: Permanent Redirect" on the Mac and fetched fine on pop -- same file,
    same argument, different answer. The Mac's system python is 3.9.6 and pop's is
    3.12.3, and urllib only learned 308 in 3.11. That is the shell-out hardening problem
    in its subtler form: not a missing binary, but the SAME command quietly behaving
    differently depending on which machine ran it. A search that alternates machines
    would have returned different pages from the same query, and nothing would have said
    so. Handling it here makes the two hosts interchangeable, which the design assumes.
    """
    # Overriding redirect_request alone is NOT enough on 3.9: the handler is dispatched
    # by method NAME, and 3.9 has no http_error_308 at all, so a 308 was raised as an
    # error before any of this ran. Binding the name is the part that actually works.
    http_error_308 = urllib.request.HTTPRedirectHandler.http_error_302

    def redirect_request(self, req, fp, code, msg, hdrs, newurl):
        if code in (307, 308):
            newreq = urllib.request.Request(newurl, data=req.data, headers=req.headers,
                                            origin_req_host=req.origin_req_host, unverifiable=True)
            newreq.get_method = req.get_method
            return newreq
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, hdrs, newurl)


_OPENER = urllib.request.build_opener(_Redirects)


def get(url, data=None, timeout=30, headers=None):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, headers=h)
    with _OPENER.open(req, timeout=timeout) as r:
        STATUS[0] = r.status
        # LOWERCASE THE KEYS. r.headers is a case-INSENSITIVE HTTPMessage; dict() turns
        # it into an ordinary case-SENSITIVE dict and silently throws that away. HTTP/2
        # servers send "content-type" lowercase, so .get("Content-Type") returned None
        # and every wikipedia page was rejected as "not text (unknown)". Measured
        # 2026-08-21. Header names are case-insensitive by spec (RFC 9110); code that
        # compares them case-sensitively is wrong even when it happens to work.
        return r.read(), {k.lower(): v for k, v in r.headers.items()}, r.geturl()


# ---- html -> text ------------------------------------------------------------------
# Deliberately crude and dependency-free. pop has no node and no bs4; requiring either
# would make this server depend on pop staying provisioned a particular way.
_DROP = re.compile(r"(?is)<(script|style|noscript|svg|head|nav|footer|form)\b.*?</\1>")
_TAG = re.compile(r"(?s)<[^>]+>")
_WS = re.compile(r"[ \t\x0b\f\r]+")
_NL = re.compile(r"\n{3,}")


def to_text(raw):
    s = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
    s = _DROP.sub(" ", s)
    s = re.sub(r"(?i)</(p|div|li|tr|h[1-6]|section|article|br)>", "\n", s)
    s = _TAG.sub(" ", s)
    s = html.unescape(s)
    s = _WS.sub(" ", s)
    s = "\n".join(line.strip() for line in s.split("\n"))
    return _NL.sub("\n\n", s).strip()


def title_of(raw):
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw.decode("utf-8", "replace"))
    return html.unescape(_TAG.sub("", m.group(1))).strip()[:200] if m else ""


# ---- ops ---------------------------------------------------------------------------
_HIT = re.compile(r'(?is)<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>')
_SNIP = re.compile(r'(?is)<a[^>]+class="result__snippet"[^>]*>(.*?)</a>')
_AD = re.compile(r"(?i)duckduckgo\.com/y\.js|[?&]ad_(domain|provider|type)=")


def op_search(job):
    q = (job.get("query") or "").strip()
    if not q:
        die("search needs a query")
    count = max(1, min(int(job.get("count") or 5), 20))
    # ONE ATTEMPT. NO SLEEPING IN HERE. This file is the hands; it does not set policy.
    # Retrying, spacing and choosing a machine belong to the dispatcher on the Mac,
    # which is the only thing that can see BOTH machines at once. A retry loop hidden
    # down here would fight the dispatcher's spacing and, worse, keep the block alive:
    # measured 2026-08-21, polling every 5s during a block never recovered in 162s.
    try:
        raw, _, _ = get(DDG, data=urllib.parse.urlencode({"q": q}).encode(), timeout=30)
    except Exception as e:
        die("duckduckgo could not be reached: %s" % e)
    body = raw.decode("utf-8", "replace")
    snips = [html.unescape(_TAG.sub("", s)).strip() for s in _SNIP.findall(body)]
    out, ads = [], 0
    for i, (href, t) in enumerate(_HIT.findall(body)):
        if "uddg=" in href:                       # ddg wraps every link in a redirect
            href = urllib.parse.unquote(href.split("uddg=")[1].split("&")[0])
        if not href.startswith("http"):
            continue
        # PAID RESULTS. Measured 2026-08-21: a plain hardware query put two Bing ads
        # above the one real answer. They point at duckduckgo.com/y.js, not the
        # advertiser, so fetching one summarises a redirector. Dropped, and counted --
        # a silently shorter result list is the kind of thing that should be visible.
        if _AD.search(href):
            ads += 1
            continue
        out.append({"title": html.unescape(_TAG.sub("", t)).strip()[:200],
                    "url": href,
                    "snippet": (snips[i] if i < len(snips) else "")[:400]})
        if len(out) >= count:
            break
    if not out:
        # THROTTLE, WITH A 200. Measured 2026-08-21: a served page is ~28 KB carrying
        # ten result links; a throttled one is ~14.2 KB carrying none -- same status
        # code, no error field anywhere. Telling those apart is the whole job here.
        # Reporting a throttle as "no results" would say nothing exists about a query
        # that was never actually run.
        if not _HIT.search(body):
            # HTTP 202 IS THE TELL, and it is not documented as one. Measured
            # 2026-08-21: a served query is 200 with ~28 KB and ten result links; a
            # refused one is **202** with ~14.2 KB whose visible text reads "Please
            # complete the following challenge... Select all squares containing a
            # duck." A captcha, not a timed limit -- so waiting a fixed number of
            # seconds is not what clears it, and retrying only feeds it.
            captcha = "containing a duck" in body or "confirm this search was made by a human" in body
            die("duckduckgo served a bot captcha instead of results (HTTP %d, %d bytes)%s"
                % (STATUS[0], len(raw), " -- this IP is flagged, not merely rate-limited"
                   if captcha else ""),
                throttled=True, captcha=captcha, status=STATUS[0], bytes=len(raw))
        die("duckduckgo returned a real results page but nothing survived filtering "
            "(ads and non-http links removed)", bytes=len(raw), ads_dropped=ads)
    return {"ok": True, "query": q, "count": len(out), "results": out,
            **({"ads_dropped": ads} if ads else {})}


def op_fetch(job):
    urls = job.get("urls") or ([job["url"]] if job.get("url") else [])
    if not urls:
        die("fetch needs url or urls")
    per = int(job.get("chars_per_page") or 6000)
    pages, failures = [], []
    for u in urls[: int(job.get("max_pages") or 5)]:
        try:
            raw, hdrs, final = get(u, timeout=int(job.get("timeout") or 25))
        except Exception as e:
            failures.append({"url": u, "error": str(e)[:200]})
            continue
        ctype = (hdrs.get("content-type") or "").lower()
        if "html" not in ctype and "text" not in ctype and "json" not in ctype:
            failures.append({"url": u, "error": "not text (%s)" % (ctype[:60] or "unknown")})
            continue
        text = to_text(raw)
        # A JAVASCRIPT SHELL IS NOT A PAGE, and it does not announce itself: HTTP 200,
        # real bytes, and a handful of characters of chrome. Measured 2026-08-21 --
        # braincuber.com returned 40 characters, "AI Search Book Free Audit Loading...",
        # three times running. The old test was `if not text`, which 40 characters of
        # nothing passes, so the shell went into a summary as though it were content and
        # the model wrote a confident benchmark figure attributed to it. That is a silent
        # success in the server built to refuse silent successes.
        #
        # Two tests, because either alone is fooled: an absolute floor (a real article is
        # not 200 characters) and a ratio (markup that is almost entirely script yields
        # almost no text). A short-but-real page still passes the ratio, and a long page
        # of pure javascript still fails the floor.
        floor = int(job.get("min_chars") or 400)
        ratio = (len(text) / len(raw)) if raw else 0
        if len(text) < floor or (len(raw) > 20000 and ratio < 0.02):
            failures.append({"url": u,
                "error": "fetched %d bytes but only %d characters of text (%.1f%% of the "
                         "page) — this is a javascript-rendered shell, not an article"
                         % (len(raw), len(text), ratio * 100)})
            continue
        pages.append({"url": final, "title": title_of(raw),
                      "chars": len(text), "truncated": len(text) > per,
                      "text": text[:per]})
    return {"ok": bool(pages), "pages": pages, "failures": failures,
            **({} if pages else {"error": "no page could be read"})}


def op_download(job):
    url = (job.get("url") or "").strip()
    if not url:
        die("download needs a url")
    if not url.startswith(("http://", "https://")):
        die("download refuses a non-http url: %r" % url[:80])
    dest = os.path.expanduser(job.get("dest") or "~/Downloads")
    name = job.get("filename") or os.path.basename(urllib.parse.urlparse(url).path) or "download.bin"
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)[:120]
    # A directory that exists is not the same as one we may write to; find out now,
    # while the error can still name the reason.
    try:
        os.makedirs(dest, exist_ok=True)
    except Exception as e:
        die("cannot create %s on pop: %s" % (dest, e))
    if not os.access(dest, os.W_OK):
        die("%s on pop is not writable" % dest)
    path = os.path.join(dest, name)
    if os.path.exists(path) and not job.get("overwrite"):
        die("%s already exists on pop — pass overwrite:true to replace it" % path,
            existing_bytes=os.path.getsize(path))
    cap = int(job.get("max_mb") or 500) * 1024 * 1024
    h, total, declared = hashlib.sha256(), 0, None
    tmp = path + ".part"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=int(job.get("timeout") or 120)) as r, open(tmp, "wb") as f:
            ctype = (r.headers.get("Content-Type") or "").split(";")[0].strip()
            declared = r.headers.get("Content-Length")
            while True:
                chunk = r.read(262144)
                if not chunk:
                    break
                total += len(chunk)
                if total > cap:
                    raise ValueError("exceeded max_mb=%s" % job.get("max_mb", 500))
                h.update(chunk)
                f.write(chunk)
        os.replace(tmp, path)
    except Exception as e:
        try:
            os.remove(tmp)
        except OSError:
            pass
        die("download failed after %d bytes: %s" % (total, e), url=url)
    if total == 0:
        os.remove(path)
        die("the server returned 0 bytes — nothing was saved", url=url)
    # Content-Length disagreeing with what landed is a truncated file that still looks
    # like a success. Report it rather than let the caller trust the sha.
    short = bool(declared and str(declared).isdigit() and int(declared) != total)
    # NO "host" KEY HERE. It was hardcoded to "pop" and then spread over the caller's
    # real value, so a download to the Mac reported itself as living on pop. The file
    # was in the right place; the report was wrong, which is worse than a plain error.
    return {"ok": True, "path": path, "bytes": total,
            "sha256": h.hexdigest(), "content_type": ctype,
            **({"warning": "server declared %s bytes but %d arrived — file may be truncated"
                % (declared, total)} if short else {})}


OPS = {"search": op_search, "fetch": op_fetch, "download": op_download}

if __name__ == "__main__":
    try:
        job = json.loads(sys.argv[1]) if len(sys.argv) > 1 else json.load(sys.stdin)
    except Exception as e:
        die("could not parse the job: %s" % e)
    fn = OPS.get(job.get("op"))
    if not fn:
        die("unknown op %r — expected one of %s" % (job.get("op"), ", ".join(OPS)))
    try:
        print(json.dumps(fn(job)))
    except SystemExit:
        raise
    except Exception as e:
        die("%s crashed on pop: %s: %s" % (job.get("op"), type(e).__name__, e))
