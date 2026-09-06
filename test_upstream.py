#!/usr/bin/env python3
"""Upstream edge-case regression test (mock CC upstream, isolated gateway).

Spawns a mock CC upstream (port 3058) + an isolated gateway instance (port 3057,
api_base pointed at the mock), then verifies two real symptoms found while
stress-testing meituan/LongCat-2.0:free:

  A. Upstream in-stream error "参数校验失败" must be classified PERMANENT
     (immediate 400), not retried for the whole 120s window. Tested on all
     three API surfaces (chat / messages / responses) because each handler
     has its own pre-buffer classification loop.

  B. Upstream that sends response headers immediately but then stays silent
     for 65s before the first NDJSON event (slow first token — happens with
     reasoning models under load) must succeed. The gateway pre-buffer read
     used to fall back to a 60s default timeout and die with 502.
"""
import json, os, shutil, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.request, urllib.error

MOCK_PORT = 3058
GW_PORT = 3057
GW = f"http://127.0.0.1:{GW_PORT}"
PASS = FAIL = 0
FAILURES = []

def report(ok, name, detail=""):
    global PASS, FAIL
    print(f"{'✅' if ok else '❌'} {name} {detail}", flush=True)
    if ok: PASS += 1
    else: FAIL += 1; FAILURES.append(f"{name}: {detail}")

class MockCC(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    def _send_ndjson(self, lines, delay=0):
        body = ("\n".join(lines) + "\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if delay:
            time.sleep(delay)
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.path != "/alpha/generate":
            return self._send_ndjson(['{"ok":true}'])
        try: req = json.loads(raw)
        except Exception: req = {}
        max_tokens = (req.get("params") or {}).get("max_tokens") or 0
        if max_tokens > 100000:
            # deterministic upstream validation rejection (permanent)
            return self._send_ndjson(['{"type":"error","error":{"message":"参数校验失败: max_tokens 超出模型上限","code":"INVALID_PARAM"}}'])
        # slow first byte: headers now, body silence 65s, then a normal stream
        return self._send_ndjson([
            '{"type":"start"}',
            '{"type":"reasoning-delta","text":"thinking..."}',
            '{"type":"text-delta","text":"hi"}',
            '{"type":"finish-step","usage":{"inputTokens":1,"outputTokens":1}}',
            '{"type":"finish","finishReason":"stop"}',
        ], delay=65)

    def do_GET(self):
        body = b'{"data":[]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

def post_chat(body, timeout):
    req = urllib.request.Request(GW + "/v1/chat/completions",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()

def main():
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockCC)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    root = os.path.dirname(os.path.abspath(__file__))
    tmp = tempfile.mkdtemp(prefix="ccgw-upstream-")
    shutil.copy(os.path.join(root, "gateway.mjs"), tmp)
    shutil.copytree(os.path.join(root, "public"), os.path.join(tmp, "public"))
    cfg = {"port": GW_PORT, "host": "127.0.0.1", "api_key": "user_test_mock_key",
           "api_keys": [], "api_base": f"http://127.0.0.1:{MOCK_PORT}", "log_level": "info",
           "proxy": {"enabled": False, "host": "127.0.0.1", "port": 7897}}
    json.dump(cfg, open(os.path.join(tmp, "config.json"), "w", encoding="utf-8"))
    node = shutil.which("node") or "node"
    proc = subprocess.Popen([node, os.path.join(tmp, "gateway.mjs")], cwd=tmp,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        up = False
        for _ in range(30):
            time.sleep(1)
            try:
                if json.loads(urllib.request.urlopen(GW + "/health", timeout=5).read()).get("status") == "ok":
                    up = True; break
            except Exception: pass
        if not up:
            report(False, "isolated instance started"); return finish(tmp, proc)

        # A1: chat — permanent in-stream validation error → immediate 400
        t0 = time.time()
        s, body = post_chat({"model": "test/model", "messages": [{"role": "user", "content": "hi"}],
                             "max_tokens": 999999, "stream": True}, timeout=15)
        report(s == 400 and "参数校验失败" in body.decode("utf-8", "replace"),
               "A1 chat: 参数校验失败 → 立即 400（不再重试风暴）", f"status={s} {round(time.time()-t0,1)}s")

        # A2: messages — same classification in its own pre-buffer loop
        t0 = time.time()
        req = urllib.request.Request(GW + "/v1/messages",
            data=json.dumps({"model": "test/model", "max_tokens": 999999,
                             "messages": [{"role": "user", "content": "hi"}]}).encode(),
            headers={"Content-Type": "application/json", "anthropic-version": "2023-06-01"}, method="POST")
        try:
            r = urllib.request.urlopen(req, timeout=15); s, body = r.status, r.read()
        except urllib.error.HTTPError as e: s, body = e.code, e.read()
        except Exception as e: s, body = 0, str(e).encode()
        report(s == 400 and "参数校验失败" in body.decode("utf-8", "replace"),
               "A2 messages: 参数校验失败 → 立即 400", f"status={s} {round(time.time()-t0,1)}s")

        # A3: responses — same classification in its own pre-buffer loop
        t0 = time.time()
        req = urllib.request.Request(GW + "/v1/responses",
            data=json.dumps({"model": "test/model", "input": "hi",
                             "max_output_tokens": 999999, "stream": True}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            r = urllib.request.urlopen(req, timeout=15); s, body = r.status, r.read()
        except urllib.error.HTTPError as e: s, body = e.code, e.read()
        except Exception as e: s, body = 0, str(e).encode()
        report(s == 400 and "参数校验失败" in body.decode("utf-8", "replace"),
               "A3 responses: 参数校验失败 → 立即 400", f"status={s} {round(time.time()-t0,1)}s")

        # B1: slow first byte (65s silence after headers) → must succeed, not 502@60s
        t0 = time.time()
        s, body = post_chat({"model": "test/model", "messages": [{"role": "user", "content": "hi"}],
                             "max_tokens": 100, "stream": True}, timeout=90)
        text = body.decode("utf-8", "replace")
        report(s == 200 and '"hi"' in text,
               "B1 首 token 慢(65s 静默)→ 200 正常出内容（不再 60s 502）", f"status={s} {round(time.time()-t0,1)}s")
    finally:
        mock.shutdown()
        cleanup(tmp, proc)

    return finish(tmp, proc) if False else finish_print()

def finish_print():
    print(f"\nUPSTREAM EDGE TEST: {PASS} passed, {FAIL} failed / {PASS+FAIL} total")
    for f in FAILURES: print(f"  ❌ {f}")
    sys.exit(1 if FAIL else 0)

def cleanup(tmp, proc):
    try: proc.kill()
    except Exception: pass
    time.sleep(0.5)
    shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    main()
