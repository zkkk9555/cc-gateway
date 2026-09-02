#!/usr/bin/env python3
"""API key pool regression test.

Spawns an ISOLATED gateway instance (temp dir, port 3051) with a fake invalid
key mixed into the pool, then verifies:
  - round-robin selection + transparent 401 failover (client never sees errors)
  - auth-failed keys get disabled and reported in /api/status
  - client key passthrough (key outside pool -> forwarded as-is)
  - pool-member key accepted, no-key requests served from the pool

Also checks pool basics against the main gateway on 3050 (read-only).
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.error

BASE_MAIN = "http://127.0.0.1:3050"
BASE_ISOL = "http://127.0.0.1:3051"
FAKE_KEY = "user_fake_invalid_pool_key"
PASS = FAIL = 0
FAILURES = []

def report(ok, name, detail=""):
    global PASS, FAIL
    print(f"{'✅' if ok else '❌'} {name} {detail}", flush=True)
    if ok: PASS += 1
    else: FAIL += 1; FAILURES.append(f"{name}: {detail}")

def post(base, path, body, headers=None, timeout=120):
    h = {"Content-Type": "application/json"}
    if headers: h.update(headers)
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers=h, method="POST")
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        return e

def get(base, path, timeout=10):
    try:
        return json.loads(urllib.request.urlopen(base + path, timeout=timeout).read())
    except Exception as e:
        return {"error": str(e)}

def chat(base, model="poolside/laguna-s-2.1-free", key=None, max_tokens=30):
    headers = {"Authorization": f"Bearer {key}"} if key else None
    r = post(base, "/v1/chat/completions", {"model": model, "stream": False, "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": "Reply OK"}]}, headers=headers)
    body = r.read()
    try: d = json.loads(body)
    except Exception: d = {"raw": body[:150].decode("utf-8", "replace")}
    return r.status, d

def main():
    root = os.path.dirname(os.path.abspath(__file__))
    main_cfg = json.load(open(os.path.join(root, "config.json"), encoding="utf-8"))
    real_key = main_cfg.get("api_key") or (main_cfg.get("api_keys") or [None])[0]
    if not real_key:
        print("No real key configured in config.json — cannot run pool test."); sys.exit(1)

    # ── spawn isolated instance with [real, fake] pool on port 3051 ──
    tmp = tempfile.mkdtemp(prefix="ccgw-pool-")
    shutil.copy(os.path.join(root, "gateway.mjs"), tmp)
    iso_cfg = dict(main_cfg)
    iso_cfg["port"] = 3051
    iso_cfg["host"] = "127.0.0.1"
    iso_cfg["api_key"] = real_key
    iso_cfg["api_keys"] = [FAKE_KEY]          # pool = [real, fake]
    json.dump(iso_cfg, open(os.path.join(tmp, "config.json"), "w", encoding="utf-8"))
    node = shutil.which("node") or "node"
    proc = subprocess.Popen([node, os.path.join(tmp, "gateway.mjs")], cwd=tmp,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        up = False
        for _ in range(30):
            time.sleep(1)
            try:
                if get(BASE_ISOL, "/health").get("status") == "ok": up = True; break
            except Exception: pass
        if not up:
            report(False, "isolated instance started"); return cleanup(tmp, proc)

        # 1. pool reports 2 healthy keys at start
        st = get(BASE_ISOL, "/api/status")
        report(st.get("key_pool", {}).get("total") == 2 and st["key_pool"]["healthy"] == 2,
               "P1 池初始状态 2/2 healthy", json.dumps(st.get("key_pool", {}))[:100])

        # 2. round-robin + failover: 4 requests, all must succeed even though the
        #    fake key is picked on alternating attempts and 401s upstream
        codes, times = [], []
        for _ in range(4):
            t0 = time.time()
            s, d = chat(BASE_ISOL)
            codes.append(s); times.append(round(time.time() - t0, 1))
        report(all(c == 200 for c in codes), "P2 4请求全 200（假 key 在轮询中自动故障转移）",
               f"codes={codes} times={times}")

        # 3. fake key disabled after auth failure, real key ok
        st = get(BASE_ISOL, "/api/status")
        keys = {k["key"][:8]: k for k in st.get("key_pool", {}).get("keys", [])}
        fake = keys.get(FAKE_KEY[:8]); real = keys.get(real_key[:8])
        report(bool(fake) and fake["status"] == "disabled" and fake["last_error"] == "auth_failed",
               "P3 假 key 已摘除 (disabled/auth_failed)", json.dumps(fake, ensure_ascii=False) if fake else "missing")
        report(bool(real) and real["status"] == "ok", "P4 真 key 保持 ok", json.dumps(real, ensure_ascii=False) if real else "missing")

        # 4. after disable, requests keep succeeding (pool now 1 healthy)
        s, d = chat(BASE_ISOL)
        report(s == 200 and d.get("choices", [{}])[0].get("message", {}).get("content", "").strip() != "",
               "P5 摘除后请求继续成功", f"status={s}")

        # 5. passthrough: key outside pool forwarded as-is -> upstream 401 returned
        s, d = chat(BASE_ISOL, key="user_bogus_outside_pool")
        report(s == 401, "P6 池外 key 透传（上游 401 原样返回）", f"status={s} err={d.get('error', {}).get('code', '')}")

        # 6. pool-member key in header accepted -> 200
        s, d = chat(BASE_ISOL, key=real_key)
        report(s == 200, "P7 池内 key 作为客户端凭证 → 入池轮询 200", f"status={s}")

        # 7. log evidence of failover with request correlation id
        log_ok = False
        logdir = os.path.join(tmp, "logs")
        for f in os.listdir(logdir):
            content = open(os.path.join(logdir, f), encoding="utf-8", errors="replace").read()
            if "DISABLED from pool" in content and "Request done" in content:
                log_ok = True
        report(log_ok, "P8 日志含摘除事件 + 请求关联 ID")

        # 8. main gateway (3050) pool basics — read-only sanity
        st = get(BASE_MAIN, "/api/status")
        report("key_pool" in st and st["key_pool"]["total"] >= 1,
               "P9 主网关 /api/status 暴露 key_pool", json.dumps(st.get("key_pool", {}))[:100])
    finally:
        cleanup(tmp, proc)

    print(f"\nPOOL TEST: {PASS} passed, {FAIL} failed / {PASS+FAIL} total")
    for f in FAILURES: print(f"  ❌ {f}")
    sys.exit(1 if FAIL else 0)

def cleanup(tmp, proc):
    try: proc.kill()
    except Exception: pass
    time.sleep(0.5)
    shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    main()
