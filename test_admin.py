#!/usr/bin/env python3
"""Admin token regression test.

Spawns two ISOLATED gateway instances (temp dirs, ports 3053/3054):

Instance A (admin_token=test-token-123):
  - /health and /v1/models stay open (no token) — gateway surface untouched
  - /api/* returns 401 without / with a wrong token
  - /api/* returns 200 with the correct x-admin-token header
  - dashboard HTML ships the token bar (auth-bar)
Instance B (no admin_token configured):
  - /api/status stays open — backward compatibility with existing setups
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request, urllib.error

PASS = FAIL = 0
FAILURES = []

def report(ok, name, detail=""):
    global PASS, FAIL
    print(f"{'✅' if ok else '❌'} {name} {detail}", flush=True)
    if ok: PASS += 1
    else: FAIL += 1; FAILURES.append(f"{name}: {detail}")

def req(base, path, headers=None, timeout=15):
    try:
        r = urllib.request.urlopen(urllib.request.Request(base + path, headers=headers or {}), timeout=timeout)
        return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 0, str(e).encode()

def spawn(root, port, extra_cfg):
    tmp = tempfile.mkdtemp(prefix=f"ccgw-admin-{port}-")
    shutil.copy(os.path.join(root, "gateway.mjs"), tmp)
    shutil.copytree(os.path.join(root, "public"), os.path.join(tmp, "public"))
    main_cfg = json.load(open(os.path.join(root, "config.json"), encoding="utf-8"))
    iso_cfg = dict(main_cfg)
    iso_cfg.update({"port": port, "host": "127.0.0.1", "api_key": "user_fake_invalid_admin_test_key",
                    "api_keys": [], "proxy": {"enabled": False, "host": "127.0.0.1", "port": 7897}})
    iso_cfg.update(extra_cfg)
    json.dump(iso_cfg, open(os.path.join(tmp, "config.json"), "w", encoding="utf-8"))
    node = shutil.which("node") or "node"
    proc = subprocess.Popen([node, os.path.join(tmp, "gateway.mjs")], cwd=tmp,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(30):
        time.sleep(1)
        try:
            if json.loads(urllib.request.urlopen(base + "/health", timeout=5).read()).get("status") == "ok":
                return tmp, proc, base
        except Exception: pass
    return tmp, proc, None

def main():
    root = os.path.dirname(os.path.abspath(__file__))
    tok = {"x-admin-token": "test-token-123"}

    # ── Instance A: admin_token set ──
    tmpA, procA, baseA = spawn(root, 3053, {"admin_token": "test-token-123"})
    try:
        if not baseA:
            report(False, "instance A started"); cleanup(tmpA, procA); return finish()
        s, _ = req(baseA, "/health")
        report(s == 200, "A1 /health 无令牌 200（网关面不设防）", f"status={s}")
        s, _ = req(baseA, "/v1/models")
        report(s == 200, "A2 /v1/models 无令牌 200（网关面不设防）", f"status={s}")
        s, _ = req(baseA, "/api/status")
        report(s == 401, "A3 /api/status 无令牌 401", f"status={s}")
        s, _ = req(baseA, "/api/status", {"x-admin-token": "wrong-token"})
        report(s == 401, "A4 /api/status 错令牌 401", f"status={s}")
        s, body = req(baseA, "/api/status", tok)
        d = json.loads(body) if s == 200 else {}
        report(s == 200 and d.get("auth_required") is True, "A5 /api/status 对令牌 200 且 auth_required=true", f"status={s}")
        s, _ = req(baseA, "/api/keys", tok)
        report(s == 200, "A6 /api/keys 对令牌 200", f"status={s}")
        s, body = req(baseA, "/")
        html = body.decode("utf-8", "replace")
        report(s == 200 and "auth-bar" in html, "A7 仪表盘含令牌输入条 auth-bar", f"status={s}")
    finally:
        cleanup(tmpA, procA)

    # ── Instance B: no admin_token (backward compat) ──
    tmpB, procB, baseB = spawn(root, 3054, {})
    try:
        if not baseB:
            report(False, "instance B started"); return finish()
        s, _ = req(baseB, "/api/status")
        report(s == 200, "B1 未配置令牌时 /api/status 仍开放（行为不变）", f"status={s}")
    finally:
        cleanup(tmpB, procB)

    return finish()

def finish():
    print(f"\nADMIN TOKEN TEST: {PASS} passed, {FAIL} failed / {PASS+FAIL} total")
    for f in FAILURES: print(f"  ❌ {f}")
    sys.exit(1 if FAIL else 0)

def cleanup(tmp, proc):
    try: proc.kill()
    except Exception: pass
    time.sleep(0.5)
    shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    main()
