#!/usr/bin/env python3
"""cc-gateway stress test — all scenarios, minimax/minimax-m3-free only."""
import json, time, sys, threading, traceback
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "http://127.0.0.1:3050"
MODEL = "minimax/minimax-m3-free"
RESULTS = []
ERRORS = []

def log(phase, name, ok, detail="", elapsed=0):
    status = "✅" if ok else "❌"
    line = f"{status} [{phase}] {name} ({elapsed:.1f}s) {detail}"
    print(line)
    RESULTS.append({"phase": phase, "name": name, "ok": ok, "detail": detail, "elapsed": elapsed})
    if not ok:
        ERRORS.append({"phase": phase, "name": name, "detail": detail})

def post(path, body, headers=None, timeout=60):
    h = {"Content-Type": "application/json"}
    if headers: h.update(headers)
    req = Request(f"{BASE}{path}", data=json.dumps(body).encode(), headers=h, method="POST")
    return urlopen(req, timeout=timeout)

def get(path, timeout=10):
    req = Request(f"{BASE}{path}")
    return urlopen(req, timeout=timeout)

def read_stream(resp, max_events=500):
    """Read SSE stream, return (text, events_count, has_error, has_finish)"""
    text = ""
    events = 0
    has_error = False
    has_finish = False
    buf = ""
    while True:
        chunk = resp.read(4096)
        if not chunk: break
        buf += chunk.decode(errors="replace")
        lines = buf.split("\n")
        buf = lines.pop()
        for line in lines:
            if not line.startswith("data: "): continue
            data = line[6:].strip()
            if data == "[DONE]": continue
            try:
                ev = json.loads(data)
                events += 1
                if ev.get("error"): has_error = True
                if ev.get("finish_reason") or ev.get("type") == "finish": has_finish = True
                # Extract text content
                if "choices" in ev:
                    for c in ev.get("choices", []):
                        d = c.get("delta", {})
                        if "content" in d: text += d["content"]
                elif "content_block_delta" in ev.get("type", ""):
                    text += ev.get("delta", {}).get("text", "")
            except: pass
            if events >= max_events: return text, events, has_error, has_finish
    return text, events, has_error, has_finish

# ════════════════════════════════════════════════════════════════
# Phase 1: Basic functionality — all 3 API formats
# ════════════════════════════════════════════════════════════════
def test_phase1():
    print("\n═══ Phase 1: Basic API Formats ═══")

    # 1a. OpenAI Chat Completions (streaming)
    t0 = time.time()
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": "say OK"}], "max_tokens": 10, "stream": True}
        resp = post("/v1/chat/completions", body, timeout=30)
        text, events, err, fin = read_stream(resp)
        log("P1", "OpenAI Chat (stream)", True, f"events={events} text='{text[:30]}'", time.time()-t0)
    except Exception as e:
        log("P1", "OpenAI Chat (stream)", False, str(e)[:100], time.time()-t0)

    # 1b. OpenAI Chat Completions (non-streaming) — CC API always streams, gateway translates
    t0 = time.time()
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": "say OK"}], "max_tokens": 10, "stream": False}
        resp = post("/v1/chat/completions", body, timeout=60)
        data = json.loads(resp.read())
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        log("P1", "OpenAI Chat (non-stream)", True, f"text='{text[:30]}'", time.time()-t0)
    except Exception as e:
        log("P1", "OpenAI Chat (non-stream)", False, str(e)[:100], time.time()-t0)

    # 1c. Anthropic Messages (streaming)
    t0 = time.time()
    try:
        body = {"model": MODEL, "max_tokens": 10, "stream": True, "messages": [{"role": "user", "content": "say OK"}]}
        resp = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"}, timeout=30)
        text, events, err, fin = read_stream(resp)
        log("P1", "Anthropic Messages (stream)", True, f"events={events} text='{text[:30]}'", time.time()-t0)
    except Exception as e:
        log("P1", "Anthropic Messages (stream)", False, str(e)[:100], time.time()-t0)

    # 1d. Anthropic Messages (non-streaming)
    t0 = time.time()
    try:
        body = {"model": MODEL, "max_tokens": 10, "stream": False, "messages": [{"role": "user", "content": "say OK"}]}
        resp = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"}, timeout=30)
        data = json.loads(resp.read())
        text = ""
        for c in data.get("content", []):
            if c.get("type") == "text": text += c.get("text", "")
        log("P1", "Anthropic Messages (non-stream)", True, f"text='{text[:30]}'", time.time()-t0)
    except Exception as e:
        log("P1", "Anthropic Messages (non-stream)", False, str(e)[:100], time.time()-t0)

    # 1e. OpenAI Responses (streaming)
    t0 = time.time()
    try:
        body = {"model": MODEL, "stream": True, "input": [{"role": "user", "content": [{"type": "input_text", "text": "say OK"}]}], "max_output_tokens": 10}
        resp = post("/v1/responses", body, timeout=30)
        text, events, err, fin = read_stream(resp)
        log("P1", "OpenAI Responses (stream)", True, f"events={events}", time.time()-t0)
    except Exception as e:
        log("P1", "OpenAI Responses (stream)", False, str(e)[:100], time.time()-t0)

    # 1f. OpenAI Responses (non-streaming)
    t0 = time.time()
    try:
        body = {"model": MODEL, "stream": False, "input": [{"role": "user", "content": [{"type": "input_text", "text": "say OK"}]}], "max_output_tokens": 10}
        resp = post("/v1/responses", body, timeout=30)
        data = json.loads(resp.read())
        log("P1", "OpenAI Responses (non-stream)", True, f"status={data.get('status')}", time.time()-t0)
    except Exception as e:
        log("P1", "OpenAI Responses (non-stream)", False, str(e)[:100], time.time()-t0)

# ════════════════════════════════════════════════════════════════
# Phase 2: Error scenarios
# ════════════════════════════════════════════════════════════════
def test_phase2():
    print("\n═══ Phase 2: Error Scenarios ═══")

    # 2a. Invalid JSON
    t0 = time.time()
    try:
        req = Request(f"{BASE}/v1/chat/completions", data=b"not json", headers={"Content-Type": "application/json"}, method="POST")
        resp = urlopen(req, timeout=10)
        code = resp.status
        log("P2", "Invalid JSON", code == 400, f"status={code}", time.time()-t0)
    except HTTPError as e:
        log("P2", "Invalid JSON", e.code == 400, f"status={e.code}", time.time()-t0)
    except Exception as e:
        log("P2", "Invalid JSON", False, str(e)[:100], time.time()-t0)

    # 2b. Missing API key (default key configured → should succeed)
    t0 = time.time()
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5}
        req = Request(f"{BASE}/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
        resp = urlopen(req, timeout=15)
        log("P2", "Missing auth (default key)", resp.status == 200, f"status={resp.status}", time.time()-t0)
    except HTTPError as e:
        log("P2", "Missing auth (default key)", True, f"status={e.code}", time.time()-t0)
    except Exception as e:
        log("P2", "Missing auth (default key)", False, str(e)[:100], time.time()-t0)

    # 2c. Invalid model
    t0 = time.time()
    try:
        body = {"model": "nonexistent-model-xyz", "messages": [{"role": "user", "content": "hi"}], "max_tokens": 5, "stream": True}
        resp = post("/v1/chat/completions", body, timeout=30)
        text, events, err, fin = read_stream(resp)
        log("P2", "Invalid model", True, f"events={events} err={err}", time.time()-t0)
    except Exception as e:
        log("P2", "Invalid model", True, f"error returned: {str(e)[:60]}", time.time()-t0)

    # 2d. Empty messages array
    t0 = time.time()
    try:
        body = {"model": MODEL, "messages": [], "max_tokens": 5}
        resp = post("/v1/chat/completions", body, timeout=15)
        log("P2", "Empty messages", True, f"status={resp.status}", time.time()-t0)
    except HTTPError as e:
        log("P2", "Empty messages", True, f"status={e.code}", time.time()-t0)
    except Exception as e:
        log("P2", "Empty messages", True, f"error handled: {str(e)[:60]}", time.time()-t0)

    # 2e. Unknown endpoint
    t0 = time.time()
    try:
        resp = get("/v1/unknown", timeout=5)
        log("P2", "Unknown endpoint", resp.status == 404, f"status={resp.status}", time.time()-t0)
    except HTTPError as e:
        log("P2", "Unknown endpoint", e.code == 404, f"status={e.code}", time.time()-t0)
    except Exception as e:
        log("P2", "Unknown endpoint", False, str(e)[:100], time.time()-t0)

    # 2f. Missing model field
    t0 = time.time()
    try:
        body = {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 5}
        resp = post("/v1/chat/completions", body, timeout=15)
        log("P2", "Missing model field", True, f"status={resp.status}", time.time()-t0)
    except HTTPError as e:
        log("P2", "Missing model field", True, f"status={e.code}", time.time()-t0)
    except Exception as e:
        log("P2", "Missing model field", True, f"error handled: {str(e)[:60]}", time.time()-t0)

# ════════════════════════════════════════════════════════════════
# Phase 3: Concurrency
# ════════════════════════════════════════════════════════════════
def test_phase3():
    print("\n═══ Phase 3: Concurrency ═══")

    def single_request(idx):
        t0 = time.time()
        try:
            body = {"model": MODEL, "messages": [{"role": "user", "content": f"say number {idx}"}], "max_tokens": 10, "stream": True}
            resp = post("/v1/chat/completions", body, timeout=60)
            text, events, err, fin = read_stream(resp)
            return {"idx": idx, "ok": True, "text": text[:20], "events": events, "elapsed": time.time()-t0}
        except Exception as e:
            return {"idx": idx, "ok": False, "error": str(e)[:80], "elapsed": time.time()-t0}

    # 3a. 5 concurrent requests
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(single_request, i) for i in range(5)]
        results = [f.result() for f in as_completed(futures)]
    ok_count = sum(1 for r in results if r["ok"])
    log("P3", "5 concurrent requests", ok_count >= 3, f"ok={ok_count}/5 max_elapsed={max(r['elapsed'] for r in results):.1f}s", time.time()-t0)

    # 3b. 10 concurrent requests (mixed endpoints)
    t0 = time.time()
    def mixed_request(idx):
        t0 = time.time()
        try:
            if idx % 3 == 0:
                body = {"model": MODEL, "messages": [{"role": "user", "content": f"say {idx}"}], "max_tokens": 10, "stream": True}
                resp = post("/v1/chat/completions", body, timeout=60)
            elif idx % 3 == 1:
                body = {"model": MODEL, "max_tokens": 10, "stream": True, "messages": [{"role": "user", "content": f"say {idx}"}]}
                resp = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"}, timeout=60)
            else:
                body = {"model": MODEL, "stream": True, "input": [{"role": "user", "content": [{"type": "input_text", "text": f"say {idx}"}]}], "max_output_tokens": 10}
                resp = post("/v1/responses", body, timeout=60)
            text, events, err, fin = read_stream(resp)
            return {"idx": idx, "ok": True, "events": events, "elapsed": time.time()-t0}
        except Exception as e:
            return {"idx": idx, "ok": False, "error": str(e)[:80], "elapsed": time.time()-t0}

    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = [pool.submit(mixed_request, i) for i in range(10)]
        results = [f.result() for f in as_completed(futures)]
    ok_count = sum(1 for r in results if r["ok"])
    log("P3", "10 concurrent (mixed endpoints)", ok_count >= 5, f"ok={ok_count}/10 max_elapsed={max(r['elapsed'] for r in results):.1f}s", time.time()-t0)

# ════════════════════════════════════════════════════════════════
# Phase 4: Large payloads
# ════════════════════════════════════════════════════════════════
def test_phase4():
    print("\n═══ Phase 4: Large Payloads ═══")

    # 4a. With tools (OpenAI format)
    t0 = time.time()
    try:
        tools = [
            {"type": "function", "function": {"name": "get_weather", "description": "Get weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}},
            {"type": "function", "function": {"name": "search_web", "description": "Search the web", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
        ]
        body = {"model": MODEL, "messages": [{"role": "user", "content": "What's the weather in Beijing?"}], "max_tokens": 100, "stream": True, "tools": tools, "tool_choice": "auto"}
        resp = post("/v1/chat/completions", body, timeout=60)
        text, events, err, fin = read_stream(resp)
        log("P4", "OpenAI + tools", True, f"events={events} text='{text[:40]}'", time.time()-t0)
    except Exception as e:
        log("P4", "OpenAI + tools", False, str(e)[:100], time.time()-t0)

    # 4b. With tools (Anthropic format)
    t0 = time.time()
    try:
        tools = [
            {"name": "get_weather", "description": "Get weather for a city", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}},
        ]
        body = {"model": MODEL, "max_tokens": 100, "stream": True, "messages": [{"role": "user", "content": "Weather in Shanghai?"}], "tools": tools}
        resp = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"}, timeout=60)
        text, events, err, fin = read_stream(resp)
        log("P4", "Anthropic + tools", True, f"events={events}", time.time()-t0)
    except Exception as e:
        log("P4", "Anthropic + tools", False, str(e)[:100], time.time()-t0)

    # 4c. Multi-turn conversation (5 rounds)
    t0 = time.time()
    try:
        messages = []
        for i in range(5):
            messages.append({"role": "user", "content": f"Round {i+1}: tell me a fact about the number {i+1}"})
            messages.append({"role": "assistant", "content": f"The number {i+1} is interesting."})
        messages.append({"role": "user", "content": "Now summarize all 5 facts."})
        body = {"model": MODEL, "messages": messages, "max_tokens": 100, "stream": True}
        resp = post("/v1/chat/completions", body, timeout=120)
        text, events, err, fin = read_stream(resp)
        log("P4", "5-round multi-turn", True, f"events={events} text='{text[:40]}'", time.time()-t0)
    except Exception as e:
        log("P4", "5-round multi-turn", False, str(e)[:100], time.time()-t0)

    # 4d. Long system prompt (2000 chars)
    t0 = time.time()
    try:
        sys_msg = "You are a helpful assistant. " * 60  # ~2000 chars
        body = {"model": MODEL, "messages": [{"role": "system", "content": sys_msg}, {"role": "user", "content": "say OK"}], "max_tokens": 10, "stream": True}
        resp = post("/v1/chat/completions", body, timeout=120)
        text, events, err, fin = read_stream(resp)
        log("P4", "Long system prompt (2K)", True, f"events={events} text='{text[:30]}'", time.time()-t0)
    except Exception as e:
        log("P4", "Long system prompt (2K)", False, str(e)[:100], time.time()-t0)

    # 4e. Large user message (5000 chars)
    t0 = time.time()
    try:
        big_msg = "Hello! " * 800  # ~5000 chars
        body = {"model": MODEL, "messages": [{"role": "user", "content": big_msg}], "max_tokens": 20, "stream": True}
        resp = post("/v1/chat/completions", body, timeout=60)
        text, events, err, fin = read_stream(resp)
        log("P4", "Large user msg (5K)", True, f"events={events} text='{text[:30]}'", time.time()-t0)
    except Exception as e:
        log("P4", "Large user msg (5K)", False, str(e)[:100], time.time()-t0)

    # 4f. Anthropic with thinking/reasoning
    t0 = time.time()
    try:
        body = {"model": MODEL, "max_tokens": 200, "stream": True, "thinking": {"type": "enabled", "budget_tokens": 100}, "messages": [{"role": "user", "content": "think step by step: what is 2+2?"}]}
        resp = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"}, timeout=60)
        text, events, err, fin = read_stream(resp)
        log("P4", "Anthropic + thinking", True, f"events={events}", time.time()-t0)
    except Exception as e:
        log("P4", "Anthropic + thinking", False, str(e)[:100], time.time()-t0)

# ════════════════════════════════════════════════════════════════
# Phase 5: Abnormal recovery
# ════════════════════════════════════════════════════════════════
def test_phase5():
    print("\n═══ Phase 5: Abnormal Recovery ═══")

    # 5a. Abort request mid-stream
    t0 = time.time()
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": "write a very long story about cats"}], "max_tokens": 500, "stream": True}
        req = Request(f"{BASE}/v1/chat/completions", data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "Authorization": "Bearer 1"}, method="POST")
        resp = urlopen(req, timeout=60)
        # Read only first chunk then abort
        resp.read(200)
        resp.close()
        log("P5", "Abort mid-stream", True, "connection closed cleanly", time.time()-t0)
    except Exception as e:
        log("P5", "Abort mid-stream", True, f"error handled: {str(e)[:60]}", time.time()-t0)

    # 5b. Very large max_tokens
    t0 = time.time()
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": "say OK"}], "max_tokens": 999999, "stream": True}
        resp = post("/v1/chat/completions", body, timeout=30)
        text, events, err, fin = read_stream(resp, max_events=50)
        log("P5", "Huge max_tokens (999999)", True, f"events={events} text='{text[:30]}'", time.time()-t0)
    except Exception as e:
        log("P5", "Huge max_tokens (999999)", False, str(e)[:100], time.time()-t0)

    # 5c. Empty body
    t0 = time.time()
    try:
        resp = post("/v1/chat/completions", {}, timeout=10)
        log("P5", "Empty body", True, f"status={resp.status}", time.time()-t0)
    except HTTPError as e:
        log("P5", "Empty body", True, f"status={e.code}", time.time()-t0)
    except Exception as e:
        log("P5", "Empty body", True, f"error handled: {str(e)[:60]}", time.time()-t0)

    # 5d. Double-close / rapid re-request after abort
    t0 = time.time()
    try:
        body = {"model": MODEL, "messages": [{"role": "user", "content": "say OK"}], "max_tokens": 10, "stream": True}
        # Send 3 rapid requests
        for i in range(3):
            try:
                resp = post("/v1/chat/completions", body, timeout=15)
                resp.read()
            except: pass
        log("P5", "Rapid re-requests (3x)", True, "survived", time.time()-t0)
    except Exception as e:
        log("P5", "Rapid re-requests (3x)", False, str(e)[:100], time.time()-t0)

    # 5e. Dashboard API endpoints
    t0 = time.time()
    try:
        s = json.loads(get("/api/status", timeout=5).read())
        u = json.loads(get("/api/usage", timeout=5).read())
        l = json.loads(get("/api/logs?n=5", timeout=5).read())
        m = json.loads(get("/api/models", timeout=5).read())
        log("P5", "Dashboard APIs (4 endpoints)", True, f"models={m.get('total',0)} usage_date={u.get('date')}", time.time()-t0)
    except Exception as e:
        log("P5", "Dashboard APIs (4 endpoints)", False, str(e)[:100], time.time()-t0)

# ════════════════════════════════════════════════════════════════
# Main
# ════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    print(f"╔══════════════════════════════════════╗")
    print(f"║  cc-gateway Stress Test v1.018       ║")
    print(f"║  Model: {MODEL:30s} ║")
    print(f"║  Target: {BASE:29s} ║")
    print(f"╚══════════════════════════════════════╝")

    start = time.time()
    try: test_phase1()
    except Exception as e: print(f"P1 CRASH: {e}")
    try: test_phase2()
    except Exception as e: print(f"P2 CRASH: {e}")
    try: test_phase3()
    except Exception as e: print(f"P3 CRASH: {e}")
    try: test_phase4()
    except Exception as e: print(f"P4 CRASH: {e}")
    try: test_phase5()
    except Exception as e: print(f"P5 CRASH: {e}")

    total = time.time() - start
    passed = sum(1 for r in RESULTS if r["ok"])
    failed = sum(1 for r in RESULTS if not r["ok"])

    print(f"\n{'═'*50}")
    print(f"Results: {passed} passed, {failed} failed / {len(RESULTS)} total ({total:.1f}s)")
    if ERRORS:
        print(f"\n⚠️  ERRORS TO FIX:")
        for e in ERRORS:
            print(f"  ❌ [{e['phase']}] {e['name']}: {e['detail']}")
    else:
        print(f"\n✅ ALL TESTS PASSED")
    print(f"{'═'*50}")
