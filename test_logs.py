#!/usr/bin/env python3
"""Log retention regression test.

Spawns an ISOLATED gateway instance (temp dir, port 3052) with pre-seeded
log files of different ages, then verifies log retention cleanup:
  - a log file older than log_retention_days (60 days) is deleted at startup
  - a recent-but-not-today log file (10 days) is kept
  - today's log file is kept
"""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from datetime import datetime, timedelta, timezone

BASE_ISOL = "http://127.0.0.1:3052"
PASS = FAIL = 0
FAILURES = []

def report(ok, name, detail=""):
    global PASS, FAIL
    print(f"{'✅' if ok else '❌'} {name} {detail}", flush=True)
    if ok: PASS += 1
    else: FAIL += 1; FAILURES.append(f"{name}: {detail}")

def get(path, timeout=10):
    try:
        return json.loads(urllib.request.urlopen(BASE_ISOL + path, timeout=timeout).read())
    except Exception as e:
        return {"error": str(e)}

def main():
    root = os.path.dirname(os.path.abspath(__file__))
    main_cfg = json.load(open(os.path.join(root, "config.json"), encoding="utf-8"))

    tmp = tempfile.mkdtemp(prefix="ccgw-logs-")
    shutil.copy(os.path.join(root, "gateway.mjs"), tmp)
    iso_cfg = dict(main_cfg)
    iso_cfg["port"] = 3052
    iso_cfg["host"] = "127.0.0.1"
    iso_cfg["log_retention_days"] = 30
    json.dump(iso_cfg, open(os.path.join(tmp, "config.json"), "w", encoding="utf-8"))

    today = datetime.now(timezone.utc)
    dates = {
        "old":   (today - timedelta(days=60)).strftime("%Y-%m-%d"),
        "mid":   (today - timedelta(days=10)).strftime("%Y-%m-%d"),
        "today": today.strftime("%Y-%m-%d"),
    }
    logdir = os.path.join(tmp, "logs")
    os.makedirs(logdir)
    for name, d in dates.items():
        with open(os.path.join(logdir, f"gateway-{d}.log"), "w", encoding="utf-8") as f:
            f.write(f"[seed] {name} log file\n")

    node = shutil.which("node") or "node"
    proc = subprocess.Popen([node, os.path.join(tmp, "gateway.mjs")], cwd=tmp,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        up = False
        for _ in range(30):
            time.sleep(1)
            try:
                if get("/health").get("status") == "ok": up = True; break
            except Exception: pass
        if not up:
            report(False, "isolated instance started"); return cleanup(tmp, proc)

        def exists(name):
            return os.path.exists(os.path.join(logdir, f"gateway-{dates[name]}.log"))

        # L1: log older than retention window is gone
        report(not exists("old"), "L1 60天前日志已删除", dates["old"])
        # L2: within window (10 days) kept
        report(exists("mid"), "L2 10天前日志保留", dates["mid"])
        # L3: today's log kept
        report(exists("today"), "L3 今日日志保留", dates["today"])
    finally:
        cleanup(tmp, proc)

    print(f"\nLOG RETENTION TEST: {PASS} passed, {FAIL} failed / {PASS+FAIL} total")
    for f in FAILURES: print(f"  ❌ {f}")
    sys.exit(1 if FAIL else 0)

def cleanup(tmp, proc):
    try: proc.kill()
    except Exception: pass
    time.sleep(0.5)
    shutil.rmtree(tmp, ignore_errors=True)

if __name__ == "__main__":
    main()
