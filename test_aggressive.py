#!/usr/bin/env python3
"""cc-gateway aggressive stress test — targeting weak points found in round 1."""
import json, time, threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "http://127.0.0.1:3050"
MODEL = "poolside/laguna-s-2.1-free"
PASS = FAIL = 0

def log(ok, name, detail="", elapsed=0):
    global PASS, FAIL
    s = "✅" if ok else "❌"
    print(f"{s} {name} ({elapsed:.1f}s) {detail}")
    if ok: PASS += 1
    else: FAIL += 1

def post(path, body, headers=None, timeout=60):
    h = {"Content-Type": "application/json"}
    if headers: h.update(headers)
    return urlopen(Request(f"{BASE}{path}", data=json.dumps(body).encode(), headers=h, method="POST"), timeout=timeout)

def read_sse(resp, max_events=500):
    text, events, buf = "", 0, ""
    while True:
        chunk = resp.read(4096)
        if not chunk: break
        buf += chunk.decode(errors="replace")
        lines = buf.split("\n")
        buf = lines.pop()
        for line in lines:
            if not line.startswith("data: "): continue
            d = line[6:].strip()
            if d == "[DONE]": continue
            try:
                ev = json.loads(d)
                events += 1
                if "choices" in ev:
                    for c in ev.get("choices", []):
                        text += c.get("delta", {}).get("content", "")
                elif ev.get("type") == "content_block_delta":
                    text += ev.get("delta", {}).get("text", "")
                elif ev.get("type") == "response.output_text.delta":
                    text += ev.get("delta", "")
            except: pass
            if events >= max_events: return text, events
    return text, events

print("╔══════════════════════════════════════════╗")
print("║  cc-gateway Aggressive Stress Test      ║")
print("║  Free Model · All endpoints             ║")
print("╚══════════════════════════════════════════╝")

# ═══ A. Rapid-fire same endpoint (test connection pooling / SOCKS5 reuse) ═══
print("\n═══ A: Rapid-fire (10 fast requests, one endpoint) ═══")
t0 = time.time()
def fast_req(i):
    t = time.time()
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": f"x{i}"}], "max_tokens": 5, "stream": True}
        resp = post("/v1/chat/completions", body, timeout=30)
        text, ev = read_sse(resp, max_events=10)
        return True, f"ev={ev}", time.time()-t
    except Exception as e:
        return False, str(e)[:60], time.time()-t

with ThreadPoolExecutor(max_workers=10) as pool:
    results = list(pool.map(fast_req, range(10)))
ok = sum(1 for r in results if r[0])
log(ok >= 8, f"10 rapid-fire: {ok}/10 ok", f"worst={max(r[2] for r in results):.1f}s", time.time()-t0)

# ═══ B. Stream abort storm (open+close immediately, 5 times) ═══
print("\n═══ B: Stream abort storm ═══")
t0 = time.time()
aborted = 0
for i in range(5):
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": "write a long story"}], "max_tokens": 500, "stream": True}
        req = Request(f"{BASE}/v1/chat/completions", data=json.dumps(body).encode(),
                      headers={"Content-Type": "application/json", "Authorization": "Bearer 1"}, method="POST")
        resp = urlopen(req, timeout=30)
        resp.read(100)  # read a bit then abort
        resp.close()
        aborted += 1
    except: pass
log(aborted >= 4, f"Stream abort storm: {aborted}/5 survived", "", time.time()-t0)

# ═══ C. Mixed endpoint burst (5 of each type simultaneously) ═══
print("\n═══ C: Mixed burst (5 Chat + 5 Anthropic + 5 Responses) ═══")
t0 = time.time()
def mixed_burst(idx):
    t = time.time()
    try:
        ep = idx % 3
        if ep == 0:
            body = {"model": MODEL, "messages": [{"role": "user", "content": f"say {idx}"}], "max_tokens": 5, "stream": True}
            resp = post("/v1/chat/completions", body, timeout=45)
        elif ep == 1:
            body = {"model": MODEL, "max_tokens": 5, "stream": True, "messages": [{"role": "user", "content": f"say {idx}"}]}
            resp = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"}, timeout=45)
        else:
            body = {"model": MODEL, "stream": True, "input": [{"role": "user", "content": [{"type": "input_text", "text": f"say {idx}"}]}], "max_output_tokens": 5}
            resp = post("/v1/responses", body, timeout=45)
        text, ev = read_sse(resp, max_events=10)
        return True, time.time()-t
    except Exception as e:
        return False, time.time()-t

with ThreadPoolExecutor(max_workers=15) as pool:
    results = list(pool.map(mixed_burst, range(15)))
ok = sum(1 for r in results if r[0])
log(ok >= 10, f"Mixed burst: {ok}/15 ok", f"worst={max(r[1] for r in results):.1f}s", time.time()-t0)

# ═══ D. Non-streaming rapid (3 of each format) ═══
print("\n═══ D: Non-streaming (3× each format) ═══")
t0 = time.time()
ns_ok = 0
for fmt in ["openai", "anthropic", "responses"]:
    for i in range(3):
        t = time.time()
        try:
            if fmt == "openai":
                body = {"model": MODEL, "messages": [{"role": "user", "content": f"ns{i}"}], "max_tokens": 5, "stream": False}
                resp = post("/v1/chat/completions", body, timeout=60)
                d = json.loads(resp.read())
                txt = d.get("choices", [{}])[0].get("message", {}).get("content", "")
            elif fmt == "anthropic":
                body = {"model": MODEL, "max_tokens": 5, "stream": False, "messages": [{"role": "user", "content": f"ns{i}"}]}
                resp = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"}, timeout=60)
                d = json.loads(resp.read())
                txt = "".join(c.get("text", "") for c in d.get("content", []) if c.get("type") == "text")
            else:
                body = {"model": MODEL, "stream": False, "input": [{"role": "user", "content": [{"type": "input_text", "text": f"ns{i}"}]}], "max_output_tokens": 5}
                resp = post("/v1/responses", body, timeout=60)
                d = json.loads(resp.read())
                txt = str(d.get("status", ""))
            # max_tokens=5 may legitimately yield empty content (reasoning eats the
            # budget, or upstream returns 0 tokens) — a valid JSON 200 counts as ok
            ns_ok += 1
        except: pass
log(ns_ok >= 7, f"Non-streaming: {ns_ok}/9 got response", "", time.time()-t0)

# ═══ E. Error recovery (send error, then normal request) ═══
print("\n═══ E: Error recovery (bad→good→bad→good) ═══")
t0 = time.time()
seq = [
    ({"model": "bad-model"}, True),      # should error
    ({"model": MODEL, "messages": [{"role": "user", "content": "ok"}], "max_tokens": 5, "stream": True}, False),  # should work
    ({"model": "bad-model"}, True),      # should error
    ({"model": MODEL, "messages": [{"role": "user", "content": "ok"}], "max_tokens": 5, "stream": True}, False),  # should work
]
recovery_ok = 0
for body, expect_error in seq:
    try:
        resp = post("/v1/chat/completions", body, timeout=30)
        if not expect_error:
            text, ev = read_sse(resp, max_events=10)
            if text: recovery_ok += 1
    except HTTPError:
        if expect_error: recovery_ok += 1
    except: pass
log(recovery_ok >= 3, f"Error recovery: {recovery_ok}/4 correct", "", time.time()-t0)

# ═══ F. Dashboard API under load (hit APIs while requests are running) ═══
print("\n═══ F: Dashboard APIs during load ═══")
t0 = time.time()
def bg_request():
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": "wait"}], "max_tokens": 5, "stream": True}
        resp = post("/v1/chat/completions", body, timeout=30)
        read_sse(resp)
    except: pass

# Start background load
bg = ThreadPoolExecutor(max_workers=3)
futures = [bg.submit(bg_request) for _ in range(3)]

# Hit dashboard APIs
dash_ok = 0
for ep in ["/api/status", "/api/usage", "/api/logs?n=10", "/api/models"]:
    try:
        r = urlopen(Request(f"{BASE}{ep}"), timeout=5)
        d = json.loads(r.read())
        if d: dash_ok += 1
    except: pass

for f in futures: f.result()
log(dash_ok >= 3, f"Dashboard under load: {dash_ok}/4 ok", "", time.time()-t0)

# ═══ G. Long-running stream (test timeout handling) ═══
print("\n═══ G: Long stream (ask for lots of text) ═══")
t0 = time.time()
try:
    body = {"model": MODEL, "messages": [{"role": "user", "content": "write a 5000 word essay about AI"}], "max_tokens": 4000, "stream": True}
    resp = post("/v1/chat/completions", body, timeout=180)
    text, ev = read_sse(resp, max_events=10000)
    log(True, f"Long stream: {len(text)} chars, {ev} events", f"speed={len(text)/(time.time()-t0):.0f} chars/s", time.time()-t0)
except Exception as e:
    log(False, f"Long stream failed: {str(e)[:80]}", "", time.time()-t0)

# ═══ H. Connection endpoint tests ═══
print("\n═══ H: Edge cases ═══")
t0 = time.time()
# H1: Double content-type header
try:
    body = {"model": MODEL, "messages": [{"role": "user", "content": "ok"}], "max_tokens": 5}
    req = Request(f"{BASE}/v1/chat/completions", data=json.dumps(body).encode(),
                  headers={"Content-Type": "application/json", "Authorization": "Bearer 1"}, method="POST")
    resp = urlopen(req, timeout=15)
    log(resp.status == 200, "H1: Normal request after stress", f"status={resp.status}", 0)
except Exception as e:
    log(False, f"H1: Normal request after stress: {str(e)[:60]}", "", 0)

# H2: Health check
try:
    r = urlopen(Request(f"{BASE}/health"), timeout=5)
    d = json.loads(r.read())
    log(d.get("status") == "ok", f"H2: Health check", f"uptime={d.get('uptime')}s", 0)
except Exception as e:
    log(False, f"H2: Health check: {str(e)[:60]}", "", 0)

# ═══ Summary ═══
print(f"\n{'═'*50}")
print(f"Results: {PASS} passed, {FAIL} failed / {PASS+FAIL} total")
print(f"{'═'*50}")
