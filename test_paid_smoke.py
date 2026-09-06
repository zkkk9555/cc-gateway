#!/usr/bin/env python3
"""Paid-model smoke test — ⚠️ CONSUMES REAL QUOTA. Run deliberately, never in bulk.

For each model: ONE streaming chat request (max_tokens=64, one short Chinese
prompt), asserting the gateway round-trips it correctly:
  HTTP 200 → SSE events ≥ 3 → finish_reason present → [DONE] → usage > 0

Reasoning models (e.g. muse-spark) may spend the whole budget on thinking —
the assertion is on the EVENT STREAM, not on visible text.

Usage:
  python test_paid_smoke.py                      # default 3 models
  python test_paid_smoke.py model/a model/b      # custom list
"""
import json, sys, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:3050"
DEFAULT_MODELS = [
    "meta/muse-spark-1.3-contributor",
    "deepseek/deepseek-v4-flash",
    "gpt-5.6-luna",
]
PASS = FAIL = 0
FAILURES = []

def report(ok, name, detail=""):
    global PASS, FAIL
    print(f"{'✅' if ok else '❌'} {name} {detail}", flush=True)
    if ok: PASS += 1
    else: FAIL += 1; FAILURES.append(f"{name}: {detail}")

def smoke(model, max_tokens=64, timeout=120):
    body = {"model": model, "messages": [{"role": "user", "content": "用一句话介绍你自己"}],
            "max_tokens": max_tokens, "stream": True}
    req = urllib.request.Request(BASE + "/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    events = finish_reason = usage = None
    text = ""
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        status = resp.status
        buf = ""
        while True:
            chunk = resp.read(4096)
            if not chunk: break
            buf += chunk.decode("utf-8", "replace")
            lines = buf.split("\n")
            buf = lines.pop()
            for line in lines:
                line = line.strip()
                if not line.startswith("data: "): continue
                data = line[6:]
                if data == "[DONE]": events = (events or 0) + 1; continue
                try: ev = json.loads(data)
                except Exception: continue
                events = (events or 0) + 1
                for c in ev.get("choices", []):
                    if c.get("finish_reason"): finish_reason = c["finish_reason"]
                    d = c.get("delta", {})
                    if d.get("content"): text += d["content"]
                if ev.get("usage"): usage = ev["usage"]
        return status, events, finish_reason, usage, text, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, 0, None, None, e.read().decode("utf-8", "replace")[:200], time.time() - t0
    except Exception as e:
        return 0, 0, None, None, str(e)[:200], time.time() - t0

def main():
    models = sys.argv[1:] or DEFAULT_MODELS
    print(f"⚠️  付费模型冒烟:每个模型 1 个流式请求(max_tokens=64)——消耗真实额度\n")
    for m in models:
        status, events, finish_reason, usage, text, elapsed = smoke(m)
        ok = status == 200 and (events or 0) >= 3 and finish_reason and usage and (usage.get("total_tokens") or 0) > 0
        detail = f"status={status} events={events} finish={finish_reason} usage={usage and usage.get('total_tokens')}t {elapsed:.1f}s"
        if status == 200 and not text:
            detail += " (正文空=推理模型预算内正常)"
        report(ok, m, detail)

    print(f"\nPAID SMOKE: {PASS} passed, {FAIL} failed / {PASS+FAIL} total")
    for f in FAILURES: print(f"  ❌ {f}")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
