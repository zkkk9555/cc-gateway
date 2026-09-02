#!/usr/bin/env python3
"""Extra tests: non-streaming matrix + tool calls in all 3 modes + error cleanliness."""
import json, sys, time, urllib.request, urllib.error

BASE = "http://127.0.0.1:3050"

def post(path, body, timeout=180):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        return e

WEATHER_TOOL = [{
    "type": "function",
    "function": {"name": "get_weather", "description": "Get current weather",
                 "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}},
}]

def ns_chat(model):
    r = post("/v1/chat/completions", {"model": model, "messages": [{"role": "user", "content": "Reply with exactly: OK"}], "stream": False, "max_tokens": 4000})
    d = json.loads(r.read())
    m = d.get("choices", [{}])[0].get("message", {})
    ok = m.get("content", "").strip() == "OK" and "usage" in d
    return ok, f"status={r.status} content={m.get('content')!r} reasoning={'reasoning_content' in m} usage={d.get('usage', {}).get('total_tokens')}"

def ns_messages(model):
    r = post("/v1/messages", {"model": model, "max_tokens": 4000, "stream": False, "messages": [{"role": "user", "content": "Reply with exactly: OK"}]})
    d = json.loads(r.read())
    content = d.get("content", [])
    types = [c.get("type") for c in content]
    text = "".join(c.get("text", "") for c in content if c.get("type") == "text")
    ok = text.strip() == "OK" and d.get("stop_reason") == "end_turn"
    return ok, f"status={r.status} blocks={types} text={text!r} usage={d.get('usage')}"

def ns_responses(model):
    r = post("/v1/responses", {"model": model, "input": "Reply with exactly: OK", "stream": False, "max_output_tokens": 4000})
    d = json.loads(r.read())
    out_types = [o.get("type") for o in d.get("output", [])]
    text = ""
    for o in d.get("output", []):
        for c in o.get("content", []):
            if c.get("type") == "output_text": text += c.get("text", "")
    ok = text.strip() == "OK" and d.get("object") == "response" and "usage" in d
    return ok, f"status={r.status} output={out_types} text={text!r}"

def tool_chat():
    r = post("/v1/chat/completions", {"model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "What's the weather in Paris? Use the tool."}], "stream": False, "max_tokens": 2000, "tools": WEATHER_TOOL, "tool_choice": "auto"})
    d = json.loads(r.read())
    tc = d.get("choices", [{}])[0].get("message", {}).get("tool_calls")
    ok = bool(tc) and tc[0]["function"]["name"] == "get_weather"
    args = json.loads(tc[0]["function"]["arguments"]) if tc else {}
    return ok, f"status={r.status} tool={tc[0]['function']['name'] if tc else None} args={args}"

def tool_chat_stream():
    r = post("/v1/chat/completions", {"model": "gpt-5.6-luna", "messages": [{"role": "user", "content": "What's the weather in Paris? Use the tool."}], "stream": True, "max_tokens": 2000, "tools": WEATHER_TOOL, "tool_choice": "auto"})
    tool_calls, finish = [], None
    for raw in r:
        line = raw.decode().strip()
        if not line.startswith("data:"): continue
        data = line[5:].strip()
        if data == "[DONE]": break
        try: c = json.loads(data)
        except: continue
        for tc in c.get("choices", [{}])[0].get("delta", {}).get("tool_calls", []) or []:
            if tc.get("function", {}).get("name"): tool_calls.append(tc["function"]["name"])
        if c.get("choices", [{}])[0].get("finish_reason"): finish = c["choices"][0]["finish_reason"]
    ok = "get_weather" in tool_calls and finish == "tool_calls"
    return ok, f"tools={tool_calls} finish={finish}"

def tool_messages():
    r = post("/v1/messages", {"model": "gpt-5.6-luna", "max_tokens": 2000, "stream": False,
        "messages": [{"role": "user", "content": "What's the weather in Paris? Use the tool."}],
        "tools": [{"name": "get_weather", "description": "Get current weather", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]})
    d = json.loads(r.read())
    tool_use = [c for c in d.get("content", []) if c.get("type") == "tool_use"]
    ok = bool(tool_use) and tool_use[0]["name"] == "get_weather" and d.get("stop_reason") == "tool_use"
    return ok, f"status={r.status} blocks={[c.get('type') for c in d.get('content', [])]} stop={d.get('stop_reason')} input={tool_use[0].get('input') if tool_use else None}"

def tool_responses():
    r = post("/v1/responses", {"model": "gpt-5.6-luna", "input": "What's the weather in Paris? Use the tool.", "stream": True,
        "max_output_tokens": 2000,
        "tools": [{"type": "function", "name": "get_weather", "description": "Get current weather", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}],
        "tool_choice": "auto"})
    fn_items, evs = [], set()
    for raw in r:
        line = raw.decode().strip()
        if line.startswith("event:"): evs.add(line[6:].strip())
        elif line.startswith("data:"):
            data = line[5:].strip()
            if data == "[DONE]" or not data: continue
            try: e = json.loads(data)
            except: continue
            if e.get("type") == "response.output_item.done" and e.get("item", {}).get("type") == "function_call":
                fn_items.append(e["item"])
    ok = bool(fn_items) and fn_items[0].get("name") == "get_weather" and "response.function_call_arguments.delta" in evs
    return ok, f"call={fn_items[0] if fn_items else None} args_delta={'response.function_call_arguments.delta' in evs}"

def err_clean():
    r = post("/v1/chat/completions", {"model": "meta/muse-spark-1.2", "messages": [{"role": "user", "content": "hi"}], "stream": False, "max_tokens": 100})
    d = json.loads(r.read())
    msg = d.get("error", {}).get("message", "")
    code = d.get("error", {}).get("code", "")
    ok = "MODEL_NOT_IN_PLAN" in str(code) or "GOAT" in msg
    raw_json_leak = msg.startswith("{") and "success" in msg
    return ok and not raw_json_leak, f"status={r.status} code={code} message={msg[:100]!r}"

TESTS = [
    ("ns_chat deepseek", lambda: ns_chat("deepseek/deepseek-v4-flash")),
    ("ns_chat gpt-5.6-luna", lambda: ns_chat("gpt-5.6-luna")),
    ("ns_chat muse-contrib", lambda: ns_chat("meta/muse-spark-1.2-contributor")),
    ("ns_messages deepseek", lambda: ns_messages("deepseek/deepseek-v4-flash")),
    ("ns_messages gpt-5.6-luna", lambda: ns_messages("gpt-5.6-luna")),
    ("ns_messages muse-contrib", lambda: ns_messages("meta/muse-spark-1.2-contributor")),
    ("ns_responses deepseek", lambda: ns_responses("deepseek/deepseek-v4-flash")),
    ("ns_responses gpt-5.6-luna", lambda: ns_responses("gpt-5.6-luna")),
    ("ns_responses muse-contrib", lambda: ns_responses("meta/muse-spark-1.2-contributor")),
    ("tool_chat (non-stream)", tool_chat),
    ("tool_chat (stream)", tool_chat_stream),
    ("tool_messages (non-stream)", tool_messages),
    ("tool_responses (stream)", tool_responses),
    ("err_clean MODEL_NOT_IN_PLAN", err_clean),
]

only = sys.argv[1] if len(sys.argv) > 1 else None
fails = 0
for name, fn in TESTS:
    if only and only not in name: continue
    t0 = time.time()
    try:
        ok, detail = fn()
    except Exception as e:
        ok, detail = False, f"EXCEPTION: {type(e).__name__}: {e}"
    dt = time.time() - t0
    if not ok: fails += 1
    print(f"{'PASS' if ok else 'FAIL'} | {name} | {dt:.1f}s | {detail}", flush=True)
print(f"\n{len(TESTS)-fails if not only else '?'} checks, {fails} failed")
