#!/usr/bin/env python3
"""Test matrix: 3 models x 3 API modes (streaming), validate SSE standards compliance."""
import json, sys, time, urllib.request

BASE = "http://127.0.0.1:3050"
MODELS = ["deepseek/deepseek-v4-flash", "gpt-5.6-luna", "meta/muse-spark-1.2-contributor"]
PROMPT = "Reply with exactly: OK"

def post(path, body, timeout=180):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)

def read_sse(resp):
    """Yield (event_name_or_None, data_dict_or_None, raw_line) from an SSE stream."""
    event = None
    for raw in resp:
        line = raw.decode("utf-8", "replace").rstrip("\n").rstrip("\r")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data = line[5:].strip()
            if data == "[DONE]":
                yield ("[DONE]", None, line)
            else:
                try:
                    yield (event, json.loads(data), line)
                except Exception:
                    yield (event, None, line)
        elif not line:
            event = None

def test_chat(model):
    t0 = time.time()
    resp = post("/v1/chat/completions", {"model": model, "messages": [{"role": "user", "content": PROMPT}], "stream": True, "max_tokens": 4000})
    content, reasoning, finish, got_done, chunks = "", "", None, False, 0
    for ev, data, raw in read_sse(resp):
        if ev == "[DONE]": got_done = True; break
        if data is None: continue
        chunks += 1
        if "choices" in data and data["choices"]:
            d = data["choices"][0].get("delta", {})
            content += d.get("content") or ""
            reasoning += d.get("reasoning_content") or ""
            if data["choices"][0].get("finish_reason"): finish = data["choices"][0]["finish_reason"]
    dt = time.time() - t0
    ok = bool(content.strip()) and finish is not None and got_done
    return ok, f"{dt:.1f}s chunks={chunks} finish={finish} done={got_done} content={content[:60]!r} reasoning_len={len(reasoning)}"

def test_messages(model):
    t0 = time.time()
    resp = post("/v1/messages", {"model": model, "max_tokens": 4000, "messages": [{"role": "user", "content": PROMPT}], "stream": True})
    text, thinking, events_seen, stop_reason, blocks = "", "", set(), None, []
    for ev, data, raw in read_sse(resp):
        events_seen.add(ev)
        if data is None: continue
        if ev == "content_block_start":
            blocks.append(data.get("content_block", {}).get("type"))
        elif ev == "content_block_delta":
            d = data.get("delta", {})
            if d.get("type") == "text_delta": text += d.get("text", "")
            elif d.get("type") == "thinking_delta": thinking += d.get("thinking", "")
        elif ev == "message_delta":
            stop_reason = data.get("delta", {}).get("stop_reason")
    dt = time.time() - t0
    ok = bool(text.strip()) and "message_start" in events_seen and "message_stop" in events_seen
    return ok, f"{dt:.1f}s events={sorted(events_seen)} blocks={blocks} stop={stop_reason} text={text[:60]!r} thinking_len={len(thinking)}"

def test_responses(model):
    t0 = time.time()
    resp = post("/v1/responses", {"model": model, "input": PROMPT, "stream": True, "max_output_tokens": 4000})
    text, events_seq, completed = "", [], False
    for ev, data, raw in read_sse(resp):
        if ev == "[DONE]":
            events_seq.append("[DONE]"); continue
        if data is None:
            events_seq.append(f"{ev}:UNPARSEABLE"); continue
        events_seq.append(ev)
        if ev == "response.output_text.delta":
            text += data.get("delta", "")
        if ev == "response.completed":
            completed = True
    dt = time.time() - t0
    # standard Responses streaming requires: created -> output_item.added -> output_text.delta -> output_item.done -> completed
    need = ["response.created", "response.output_item.added", "response.output_text.delta", "response.output_item.done", "response.completed"]
    missing = [e for e in need if e not in events_seq]
    ok = bool(text.strip()) and completed and not missing
    # summarize sequence (collapse repeats)
    collapsed = []
    for e in events_seq:
        if not collapsed or collapsed[-1] != e: collapsed.append(e)
    return ok, f"{dt:.1f}s text={text[:60]!r} completed={completed} missing={missing} seq={collapsed[:14]}"

TESTS = {"chat": test_chat, "messages": test_messages, "responses": test_responses}

only = sys.argv[1] if len(sys.argv) > 1 else None
results = {}
for mode, fn in TESTS.items():
    if only and mode != only: continue
    for model in MODELS:
        key = f"{mode} x {model}"
        try:
            ok, detail = fn(model)
        except Exception as e:
            ok, detail = False, f"EXCEPTION: {type(e).__name__}: {e}"
        results[key] = (ok, detail)
        print(f"{'PASS' if ok else 'FAIL'} | {key} | {detail}", flush=True)

print("\n=== SUMMARY ===")
fails = [k for k, (ok, _) in results.items() if not ok]
print(f"{len(results)-len(fails)}/{len(results)} passed")
if fails: print("FAILED:", *fails, sep="\n  ")
