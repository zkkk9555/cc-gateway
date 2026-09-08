#!/usr/bin/env python3
"""Reasoning-effort probe — minimal-cost upstream capability discovery.

For each model:
  1. Send reasoning_effort="<invalid>" with max_tokens=8 → if upstream
     validates, the error may enumerate the valid levels (no generation cost).
  2. Send low + high with max_tokens=24, tiny arithmetic prompt → compare
     reasoning_content volume, finish_reason, usage.

Cost: ~12 tiny requests; prompts ride the upstream system-prompt cache.
"""
import json, sys, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:3050"
MODELS = ["gpt-5.6-luna", "deepseek/deepseek-v4-flash", "meta/muse-spark-1.3-contributor"]

def send(model, effort, max_tokens=24, timeout=150):
    body = {"model": model,
            "messages": [{"role": "user", "content": "12*13+5=?"}],
            "max_tokens": max_tokens, "stream": True}
    if effort is not None:
        body["reasoning_effort"] = effort
    req = urllib.request.Request(BASE + "/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    reasoning_chars = text_chars = events = 0
    finish = usage = None
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        status = resp.status
        buf = ""
        while True:
            chunk = resp.read(4096)
            if not chunk:
                break
            buf += chunk.decode("utf-8", "replace")
            lines = buf.split("\n")
            buf = lines.pop()
            for line in lines:
                line = line.strip()
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    continue
                try:
                    ev = json.loads(data)
                except Exception:
                    continue
                events += 1
                for c in ev.get("choices", []):
                    if c.get("finish_reason"):
                        finish = c["finish_reason"]
                    d = c.get("delta", {})
                    reasoning_chars += len(d.get("reasoning_content") or "")
                    text_chars += len(d.get("content") or "")
                if ev.get("usage"):
                    usage = ev["usage"]
        return {"status": status, "events": events, "reasoning_chars": reasoning_chars,
                "text_chars": text_chars, "finish": finish, "usage": usage,
                "elapsed": round(time.time() - t0, 1)}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "error": e.read().decode("utf-8", "replace")[:300],
                "elapsed": round(time.time() - t0, 1)}
    except Exception as e:
        return {"status": 0, "error": str(e)[:200], "elapsed": round(time.time() - t0, 1)}

def main():
    only = sys.argv[1:]
    models = only or MODELS
    out = {}
    for m in models:
        print(f"=== {m} ===", flush=True)
        r = send(m, "__probe_invalid__", max_tokens=8)
        print(f"  invalid-value: status={r['status']} {r.get('error', '')[:200]}", flush=True)
        out[m] = {"invalid_probe": r}
        for lvl in ("low", "high"):
            r = send(m, lvl)
            u = r.get("usage") or {}
            print(f"  {lvl}: status={r['status']} events={r.get('events')} "
                  f"reasoning_chars={r.get('reasoning_chars')} text_chars={r.get('text_chars')} "
                  f"finish={r.get('finish')} usage={u.get('total_tokens')}t elapsed={r.get('elapsed')}s",
                  flush=True)
            out[m][lvl] = r
        time.sleep(1)
    json.dump(out, open("probe-result.json", "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("saved probe-result.json")

if __name__ == "__main__":
    main()
