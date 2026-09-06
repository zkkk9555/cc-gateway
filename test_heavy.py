#!/usr/bin/env python3
"""cc-gateway heavy delivery test — Chinese long-text, UTF-8 integrity, complex agent
loops, sustained concurrency. All against poolside/laguna-s-2.1-free."""
import json, time, sys, threading
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "http://127.0.0.1:3050"
MODEL = sys.argv[1] if len(sys.argv) > 1 else "poolside/laguna-s-2.1-free"
PASS = FAIL = 0
FAILURES = []
PRINT_LOCK = threading.Lock()

def report(ok, name, detail="", elapsed=0):
    global PASS, FAIL
    with PRINT_LOCK:
        s = "✅" if ok else "❌"
        print(f"{s} {name} ({elapsed:.1f}s) {detail}", flush=True)
        if ok: PASS += 1
        else:
            FAIL += 1
            FAILURES.append(f"{name}: {detail}")

def post(path, body, headers=None, timeout=240):
    h = {"Content-Type": "application/json"}
    if headers: h.update(headers)
    return urlopen(Request(f"{BASE}{path}", data=json.dumps(body).encode("utf-8"), headers=h, method="POST"), timeout=timeout)

def read_sse(resp, collect=None):
    """Parse any of the 3 SSE dialects. Returns dict with text/thinking/events/done/finish/usage/errors."""
    st = {"text": "", "thinking": "", "events": 0, "done": False, "finish": None,
          "usage": None, "errors": [], "tool_calls": [], "raw_events": set()}
    buf = ""
    while True:
        chunk = resp.read(4096)
        if not chunk: break
        buf += chunk.decode("utf-8", errors="replace")
        lines = buf.split("\n")
        buf = lines.pop()
        for line in lines:
            line = line.strip()
            if not line.startswith("data:"): continue
            d = line[5:].strip()
            if d == "[DONE]": st["done"] = True; continue
            try: ev = json.loads(d)
            except: continue
            st["events"] += 1
            if collect: collect(ev, st)
            if "choices" in ev and ev["choices"]:
                delta = ev["choices"][0].get("delta", {})
                st["text"] += delta.get("content") or ""
                st["thinking"] += delta.get("reasoning_content") or ""
                for tc in delta.get("tool_calls", []) or []:
                    fn = tc.get("function", {})
                    if tc.get("id") or fn.get("name"):
                        st["tool_calls"].append({"id": tc.get("id", ""), "name": fn.get("name", ""), "arguments": fn.get("arguments", "")})
                    elif fn.get("arguments") and st["tool_calls"]:
                        st["tool_calls"][-1]["arguments"] += fn.get("arguments", "")
                if ev["choices"][0].get("finish_reason"): st["finish"] = ev["choices"][0]["finish_reason"]
                if ev.get("usage"): st["usage"] = ev["usage"]
            elif ev.get("type") == "content_block_delta":
                dt = ev.get("delta", {})
                if dt.get("type") == "text_delta": st["text"] += dt.get("text", "")
                elif dt.get("type") == "thinking_delta": st["thinking"] += dt.get("thinking", "")
            elif ev.get("type") == "message_delta":
                if ev.get("delta", {}).get("stop_reason"): st["finish"] = ev["delta"]["stop_reason"]
                if ev.get("usage"): st["usage"] = ev["usage"]
            elif ev.get("type") == "response.output_text.delta":
                st["text"] += ev.get("delta", "")
            elif ev.get("type") == "response.reasoning_summary_text.delta":
                st["thinking"] += ev.get("delta", "")
            elif ev.get("type") == "response.function_call_arguments.delta":
                if st["tool_calls"]: st["tool_calls"][-1]["arguments"] += ev.get("delta", "")
            elif ev.get("type") == "response.output_item.added" and ev.get("item", {}).get("type") == "function_call":
                it = ev["item"]
                st["tool_calls"].append({"name": it.get("name", ""), "arguments": it.get("arguments", "")})
            elif ev.get("type") == "error":
                st["errors"].append(ev.get("error", {}).get("message", "unknown"))
            if ev.get("type") in ("message_stop", "response.completed", "response.failed"): st["done"] = True
    return st

# ═══════════════════ Phase 1: 中文长文本往返（3 modes × stream/non-stream） ═══════════════════
print("\n═══ Phase 1: 中文长文本（长 system + 长 user） ═══", flush=True)

CN_SYS = ("你是一位资深的中文技术文档编辑，精通简体中文规范、技术写作和标点符号用法。"
          "你的任务是根据用户提供的材料进行总结、改写或回答问题。"
          "回答时必须使用简体中文，保持专业、准确、条理清晰。") * 8

def cn_paragraph(seed):
    return (f"第{seed}段：分布式系统的一致性问题是指，在存在网络分区、节点故障和消息延迟的情况下，"
            f"多个节点对同一份数据的视图保持一致的技术挑战。CAP定理指出，一致性（Consistency）、"
            f"可用性（Availability）和分区容错性（Partition tolerance）三者不可兼得。"
            f"【标记{seed}号】Base理论是对CAP的工程化延伸，主张基本可用、软状态和最终一致性。"
            f"在工程实践中，Raft和Paxos是两种主流的共识算法，前者以可理解性著称，后者以正确性证明见长。")

CN_LONG = "\n".join(cn_paragraph(i) for i in range(1, 26))  # ~10KB Chinese

def check_common(st, minlen=20):
    problems = []
    if not st.get("text", "").strip(): problems.append("empty text")
    if len(st.get("text", "")) < minlen: problems.append(f"text too short ({len(st.get('text', ''))})")
    if "[ERROR" in st.get("text", ""): problems.append("error injected in content")
    if st.get("errors"): problems.append(f"sse errors: {st['errors'][:1]}")
    return problems

def t_cn(mode, stream):
    t0 = time.time()
    tag = f"P1 中文长文本 {'流式' if stream else '非流式'} {mode}"
    try:
        if mode == "chat":
            body = {"model": MODEL, "stream": stream, "max_tokens": 8000,
                    "messages": [{"role": "system", "content": CN_SYS},
                                 {"role": "user", "content": f"以下是与分布式系统相关的资料，请用不超过150字总结其中讲了哪些核心概念，并在最后列出文中出现过的所有【标记】编号：\n\n{CN_LONG}"}]}
            r = post("/v1/chat/completions", body)
            if stream: st = read_sse(r)
            else:
                d = json.loads(r.read())
                st = {"text": d["choices"][0]["message"]["content"], "thinking": d["choices"][0]["message"].get("reasoning_content") or "",
                      "events": 1, "done": True, "finish": d["choices"][0].get("finish_reason"), "usage": d.get("usage"), "errors": [], "tool_calls": []}
        elif mode == "messages":
            body = {"model": MODEL, "stream": stream, "max_tokens": 8000, "system": CN_SYS,
                    "messages": [{"role": "user", "content": f"请用不超过150字总结以下资料的核心概念：\n\n{CN_LONG}"}]}
            r = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"})
            if stream: st = read_sse(r)
            else:
                d = json.loads(r.read())
                st = {"text": "".join(c.get("text", "") for c in d.get("content", []) if c.get("type") == "text"),
                      "thinking": "".join(c.get("thinking", "") for c in d.get("content", []) if c.get("type") == "thinking"),
                      "events": 1, "done": True, "finish": d.get("stop_reason"), "usage": d.get("usage"), "errors": [], "tool_calls": []}
        else:
            body = {"model": MODEL, "stream": stream, "max_output_tokens": 8000,
                    "instructions": CN_SYS, "input": f"请用不超过150字总结以下资料的核心概念：\n\n{CN_LONG}"}
            r = post("/v1/responses", body)
            if stream: st = read_sse(r)
            else:
                d = json.loads(r.read())
                st = {"text": "".join(c.get("text", "") for o in d.get("output", []) for c in o.get("content", []) if c.get("type") == "output_text"),
                      "thinking": "", "events": 1, "done": True, "finish": d.get("status"), "usage": d.get("usage"), "errors": [], "tool_calls": []}
        problems = check_common(st, minlen=60)
        if stream and not st["done"]: problems.append("stream not properly terminated")
        marks = [f"标记{i}" for i in range(1, 26) if f"标记{i}" in st["text"]]
        report(not problems, tag, f"resp_len={len(st['text'])} thinking={len(st['thinking'])} finish={st['finish']} marks_found={len(marks)}" +
               (f" problems={'; '.join(problems)}" if problems else ""), time.time()-t0)
    except Exception as e:
        report(False, tag, f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)

for mode in ["chat", "messages", "responses"]:
    for stream in [True, False]:
        t_cn(mode, stream)

# ═══════════════════ Phase 2: 长篇幅生成（中文 + 英文） ═══════════════════
print("\n═══ Phase 2: 长篇幅生成 ═══", flush=True)

def t_long_gen(lang):
    t0 = time.time()
    if lang == "zh":
        prompt = "请写一篇约1200字的中文短文，主题：从算盘到量子计算机的计算工具演进史。要求分四个段落，每段有小标题。"
        minlen = 400
    else:
        prompt = "Write a long essay (about 800 words) on the history of programming languages, with section headings."
        minlen = 1200
    last = None
    try:
        for attempt in range(2):  # model compliance varies — retry once on short output
            body = {"model": MODEL, "stream": True, "max_tokens": 16000,
                    "messages": [{"role": "user", "content": prompt}]}
            r = post("/v1/chat/completions", body)
            st = read_sse(r)
            problems = check_common(st, minlen=minlen)
            if not st["done"]: problems.append("no [DONE]")
            if not st["finish"]: problems.append("no finish_reason")
            if st["finish"] not in ("stop", "length"): problems.append(f"odd finish={st['finish']}")
            if not problems:
                report(True, f"P2 长篇生成-{lang}", f"len={len(st['text'])} chars, finish={st['finish']}, events={st['events']}, usage={st['usage'] and st['usage'].get('total_tokens')} (attempt {attempt+1})", time.time()-t0)
                return
            last = f"len={len(st['text'])} finish={st['finish']} problems={'; '.join(problems)}"
        report(False, f"P2 长篇生成-{lang}", last, time.time()-t0)
    except Exception as e:
        report(False, f"P2 长篇生成-{lang}", f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)

t_long_gen("zh"); t_long_gen("en")

# ═══════════════════ Phase 3: UTF-8 完整性（emoji / 生僻字 / 混合） ═══════════════════
print("\n═══ Phase 3: UTF-8 多字节完整性 ═══", flush=True)

def t_utf8():
    t0 = time.time()
    payload = ("🚀火箭发射中… 『引号』「直角」【方头】…… 破折号——省略号…… "
               "emoji: 🎉🀄🈚🌍🐍🧠💡 中文简繁：数据/數據、网络/網絡。 "
               "生僻字：㙟埗嘅嘢㗎 龘𠀀𪚥。 特殊：\\n\\t\"引号\"'单引' & <html> & {json:真}。 "
               "MIXED English123 中文456 mixed789。结束🎯")
    markers = ["🚀", "『引号』", "龘", "𪚥", "𠀀", "🎯", "網絡", "& <html>", "{json:真}", "English123"]
    last = None
    try:
        for attempt in range(2):  # model may occasionally not echo — retry once
            body = {"model": MODEL, "stream": True, "max_tokens": 4000,
                    "messages": [{"role": "user", "content": f"请把下面内容原样完整复述一遍（这是编码测试，务必逐字保留所有标点和符号），然后另起一行回答：复述完毕：\n\n{payload}"}]}
            r = post("/v1/chat/completions", body)
            st = read_sse(r)
            problems = check_common(st, minlen=50)
            missing = [m for m in markers if m not in st["text"]]
            if not missing and not problems:
                report(True, "P3 UTF-8完整性（emoji/生僻字/标点）", f"len={len(st['text'])} missing=0 (attempt {attempt+1})", time.time()-t0)
                return
            last = f"len={len(st['text'])} missing={missing} {problems}"
        report(False, "P3 UTF-8完整性（emoji/生僻字/标点）", last, time.time()-t0)
    except Exception as e:
        report(False, "P3 UTF-8完整性", f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)

t_utf8()

# ═══════════════════ Phase 4: 复杂 Agent 工具调用 ═══════════════════
print("\n═══ Phase 4: 复杂 Agent 工具调用 ═══", flush=True)

CHAT_TOOLS = [
    {"type": "function", "function": {"name": "get_weather", "description": "查询指定城市的实时天气", "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "城市名，如：北京"}}, "required": ["city"]}}},
    {"type": "function", "function": {"name": "get_time", "description": "查询指定时区的当前时间", "parameters": {"type": "object", "properties": {"timezone": {"type": "string", "description": "时区，如 Asia/Shanghai"}}, "required": ["timezone"]}}},
    {"type": "function", "function": {"name": "calculate", "description": "计算数学表达式", "parameters": {"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]}}},
]
ANTH_TOOLS = [{"name": t["function"]["name"], "description": t["function"]["description"], "input_schema": t["function"]["parameters"]} for t in CHAT_TOOLS]
RESP_TOOLS = [{"type": "function", "name": t["function"]["name"], "description": t["function"]["description"], "parameters": t["function"]["parameters"]} for t in CHAT_TOOLS]

def t_forced_tools():
    """tool_choice=required forces the model to call tools; verify multiple calls + Chinese args."""
    t0 = time.time()
    try:
        body = {"model": MODEL, "stream": True, "max_tokens": 4000, "tool_choice": "required",
                "messages": [{"role": "user", "content": "请帮我查一下北京的天气、上海的时间，并计算 (128*7+64)/3。"}], "tools": CHAT_TOOLS}
        r = post("/v1/chat/completions", body)
        st = read_sse(r)
        names = [tc["name"] for tc in st["tool_calls"]]
        problems = []
        if not names: problems.append("no tool calls")
        if "get_weather" not in names: problems.append(f"missing get_weather in {names}")
        if st["finish"] != "tool_calls": problems.append(f"finish={st['finish']} != tool_calls")
        # Chinese city arg check
        weather_call = next((tc for tc in st["tool_calls"] if tc["name"] == "get_weather"), None)
        if weather_call:
            try:
                args = json.loads(weather_call["arguments"])
                if "北京" not in json.dumps(args, ensure_ascii=False): problems.append(f"chinese arg lost: {args}")
            except Exception as e: problems.append(f"bad args json: {weather_call['arguments'][:50]}")
        report(not problems, "P4a 强制并行工具调用（中文参数）", f"calls={names} args_sample={weather_call['arguments'][:60] if weather_call else '-'}" +
               (f" problems={'; '.join(problems)}" if problems else ""), time.time()-t0)
        return st["tool_calls"]
    except Exception as e:
        report(False, "P4a 强制并行工具调用", f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)
        return []

def t_tool_loop():
    """Full agent loop: assistant tool_calls -> tool results -> final Chinese answer (non-stream)."""
    t0 = time.time()
    try:
        calls = t_forced_tools()
        if not calls:
            report(False, "P4b 工具结果回传循环", "no calls from P4a to build on"); return
        msgs = [{"role": "user", "content": "请帮我查一下北京的天气、上海的时间，并计算 (128*7+64)/3。然后把结果整理成一段中文汇报。"},
                {"role": "assistant", "content": None,
                 "tool_calls": [{"id": tc["id"] or f"call_{i}", "type": "function",
                                 "function": {"name": tc["name"], "arguments": tc["arguments"]}} for i, tc in enumerate(calls)]}]
        fake = {"get_weather": '{"city":"北京","temp":"3°C","cond":"晴"}', "get_time": '{"timezone":"Asia/Shanghai","time":"14:30"}', "calculate": '{"result":"320"}'}
        for i, tc in enumerate(calls):
            name = tc["name"]
            msgs.append({"role": "tool", "tool_call_id": tc["id"] or f"call_{i}", "content": fake.get(name, "{}")})
        body = {"model": MODEL, "stream": False, "max_tokens": 4000, "messages": msgs, "tools": CHAT_TOOLS}
        r = post("/v1/chat/completions", body)
        d = json.loads(r.read())
        text = d["choices"][0]["message"]["content"]
        problems = check_common({"text": text}, minlen=30)
        for kw in ["北京", "320", "14:30"]:
            if kw not in text: problems.append(f"missing '{kw}' in final answer")
        report(not problems, "P4b 工具结果回传→最终中文汇报（非流式）", f"len={len(text)} ans={text[:80]!r}" +
               (f" problems={'; '.join(problems)}" if problems else ""), time.time()-t0)
    except Exception as e:
        report(False, "P4b 工具结果回传循环", f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)

def t_anth_tool_roundtrip():
    """Anthropic format: tool_use block in history + tool_result block with Chinese."""
    t0 = time.time()
    try:
        body = {"model": MODEL, "max_tokens": 4000, "stream": True,
                "system": "你是中文助理，收到工具结果后用中文汇报。",
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": "查一下北京的天气，然后用中文汇报。"}]},
                    {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_test01", "name": "get_weather", "input": {"city": "北京"}}]},
                    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_test01", "content": '{"city":"北京","temp":"3°C","cond":"晴朗","aqi":42}'}]}],
                "tools": ANTH_TOOLS}
        r = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"})
        st = read_sse(r)
        problems = check_common(st, minlen=20)
        for kw in ["北京", "3°C"]:
            if kw not in st["text"]: problems.append(f"missing '{kw}'")
        if st["finish"] not in ("end_turn", None): problems.append(f"finish={st['finish']}")
        report(not problems, "P4c Anthropic tool_result 往返（中文）", f"len={len(st['text'])} ans={st['text'][:60]!r}" +
               (f" problems={'; '.join(problems)}" if problems else ""), time.time()-t0)
    except Exception as e:
        report(False, "P4c Anthropic tool_result 往返", f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)

def t_resp_tool_roundtrip():
    """Responses format: function_call + function_call_output items in input."""
    t0 = time.time()
    try:
        body = {"model": MODEL, "stream": True, "max_output_tokens": 4000,
                "instructions": "你是中文助理，收到工具结果后用中文简洁汇报。",
                "input": [
                    {"role": "user", "content": [{"type": "input_text", "text": "查一下上海的天气然后用中文汇报。"}]},
                    {"type": "function_call", "call_id": "call_testxyz", "name": "get_weather", "arguments": "{\"city\": \"上海\"}"},
                    {"type": "function_call_output", "call_id": "call_testxyz", "output": "{\"city\":\"上海\",\"temp\":\"9°C\",\"cond\":\"小雨\"}"}],
                "tools": RESP_TOOLS}
        r = post("/v1/responses", body)
        st = read_sse(r)
        problems = check_common(st, minlen=10)  # concise Chinese answers are valid
        for kw in ["上海", "小雨"]:
            if kw not in st["text"]: problems.append(f"missing '{kw}'")
        if not st["done"]: problems.append("no response.completed")
        report(not problems, "P4d Responses function_call 往返（中文）", f"len={len(st['text'])} ans={st['text'][:60]!r}" +
               (f" problems={'; '.join(problems)}" if problems else ""), time.time()-t0)
    except Exception as e:
        report(False, "P4d Responses function_call 往返", f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)

def t_multiturn_long():
    """12-turn Chinese conversation with long history."""
    t0 = time.time()
    try:
        msgs = [{"role": "system", "content": "你是中文技术顾问，回答保持简洁准确，记住用户之前说过的所有信息。"}]
        facts = ["我叫赵工，在一家物流公司做架构师", "我们公司的系统主要用Java和Go", "我们的日均订单量是300万单",
                 "我最近在调研大模型网关", "我们机房在北京亦庄", "我的团队有8个人",
                 "我们最关心的是系统的稳定性", "去年的故障SLA是99.95%", "老板要求今年做到99.99%"]
        for i, f in enumerate(facts):
            msgs.append({"role": "user", "content": f"记一下：{f}"})
            msgs.append({"role": "assistant", "content": f"好的，已记录（第{i+1}条）。"})
        msgs.append({"role": "user", "content": "现在请回答：我的团队有多少人？我们对系统可用性的目标是什么？请用中文一段话回答。"})
        body = {"model": MODEL, "stream": True, "max_tokens": 4000, "messages": msgs}
        r = post("/v1/chat/completions", body)
        st = read_sse(r)
        problems = check_common(st, minlen=15)
        ok_kw = sum(1 for kw in ["8", "99.99"] if kw in st["text"])
        if ok_kw < 1: problems.append("model lost conversation facts")
        report(not problems, "P4e 12轮长对话记忆", f"history={len(msgs)} msgs, ans={st['text'][:70]!r}" +
               (f" problems={'; '.join(problems)}" if problems else ""), time.time()-t0)
    except Exception as e:
        report(False, "P4e 12轮长对话记忆", f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)

t_forced_tools(); t_tool_loop(); t_anth_tool_roundtrip(); t_resp_tool_roundtrip(); t_multiturn_long()

# ═══════════════════ Phase 5: 高压并发（15 workers 混合负载） ═══════════════════
print("\n═══ Phase 5: 高压并发（15 并发 × 混合负载） ═══", flush=True)

def one_mixed_job(idx):
    kind = idx % 5
    try:
        t = time.time()
        if kind == 0:  # chat stream Chinese
            body = {"model": MODEL, "stream": True, "max_tokens": 2000,
                    "messages": [{"role": "user", "content": f"用两句话中文介绍一下第{idx}号主题：消息队列。"}]}
            r = post("/v1/chat/completions", body); st = read_sse(r)
            ok = bool(st["text"].strip()) and not st["errors"]
        elif kind == 1:  # chat non-stream
            body = {"model": MODEL, "stream": False, "max_tokens": 2000,
                    "messages": [{"role": "user", "content": f"一句话回答：什么是幂等性？(任务{idx})"}]}
            d = json.loads(post("/v1/chat/completions", body).read())
            ok = bool(d["choices"][0]["message"]["content"].strip())
        elif kind == 2:  # anthropic stream
            body = {"model": MODEL, "stream": True, "max_tokens": 2000,
                    "messages": [{"role": "user", "content": f"用中文一句话解释第{idx}号概念：CAP定理。"}]}
            r = post("/v1/messages", body, headers={"anthropic-version": "2023-06-01"}); st = read_sse(r)
            ok = bool(st["text"].strip()) and not st["errors"]
        elif kind == 3:  # responses stream
            body = {"model": MODEL, "stream": True, "max_output_tokens": 2000,
                    "input": f"用中文一句话解释：负载均衡（任务{idx}）。"}
            r = post("/v1/responses", body); st = read_sse(r)
            ok = bool(st["text"].strip()) and not st["errors"]
        else:  # chat stream with tools
            body = {"model": MODEL, "stream": True, "max_tokens": 2000,
                    "messages": [{"role": "user", "content": f"查一下城市{idx}的天气"}], "tools": CHAT_TOOLS}
            r = post("/v1/chat/completions", body); st = read_sse(r)
            ok = (bool(st["text"].strip()) or bool(st["tool_calls"])) and not st["errors"]
        return ok, kind, time.time()-t, ""
    except Exception as e:
        return False, kind, time.time()-t if 't' in dir() else 0, f"{type(e).__name__}: {str(e)[:80]}"

def concurrency_wave(wave, n=15):
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=n) as pool:
        results = list(pool.map(one_mixed_job, range(wave*100, wave*100+n)))
    ok = sum(1 for r in results if r[0])
    fails = [f"job{wave*100+i}(kind{r[1]}): {r[3]}" for i, r in enumerate(results) if not r[0]]
    worst = max((r[2] for r in results), default=0)
    report(ok == n, f"P5 并发第{wave+1}波 ({n}并发)", f"ok={ok}/{n} worst={worst:.1f}s total={time.time()-t0:.1f}s" +
           (f" fails={fails[:3]}" if fails else ""), time.time()-t0)

concurrency_wave(0); concurrency_wave(1); concurrency_wave(2)

# ═══════════════════ Phase 6: 交付检查（dashboard / 用量 / 日志健康） ═══════════════════
print("\n═══ Phase 6: 交付检查 ═══", flush=True)

def t_dashboard():
    t0 = time.time()
    problems = []
    try:
        d = json.loads(urlopen(Request(f"{BASE}/api/status"), timeout=10).read())
        if d.get("uptime", 0) <= 0: problems.append("bad uptime")
        u = json.loads(urlopen(Request(f"{BASE}/api/usage"), timeout=10).read())
        if u.get("total", {}).get("requests", 0) < 30: problems.append(f"usage not recorded: {u.get('total')}")
        if not u.get("models"): problems.append("no per-model usage")
        l = json.loads(urlopen(Request(f"{BASE}/api/logs?n=50"), timeout=10).read())
        err_logs = [x for x in l.get("logs", []) if x.get("level") == "error" and "CC error" not in x.get("msg", "")]
        if len(err_logs) > 3: problems.append(f"{len(err_logs)} unexpected error logs")
        m = json.loads(urlopen(Request(f"{BASE}/v1/models"), timeout=10).read())
        if len(m.get("data", [])) < 50: problems.append(f"model list small: {len(m.get('data', []))}")
        report(not problems, "P6 Dashboard/用量/日志健康", f"usage_total={u.get('total', {}).get('requests')} reqs, models={len(m.get('data', []))}" +
               (f" problems={'; '.join(problems)}" if problems else ""), time.time()-t0)
    except Exception as e:
        report(False, "P6 Dashboard/用量/日志健康", f"EXCEPTION {type(e).__name__}: {str(e)[:120]}", time.time()-t0)

t_dashboard()

# ═══════════════════ Summary ═══════════════════
print(f"\n{'═'*60}")
print(f"HEAVY TEST RESULT: {PASS} passed, {FAIL} failed / {PASS+FAIL} total")
print(f"{'═'*60}")
if FAILURES:
    print("FAILED:")
    for f in FAILURES: print(f"  ❌ {f}")
sys.exit(1 if FAIL else 0)
