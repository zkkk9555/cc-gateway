#!/usr/bin/env python3
"""Launch-script regression test — runs the three .bat scripts via cmd.exe and
asserts the real port-state transitions a double-click produces:

  S1 启动网关.bat  → gateway listening on 3050 (health 200)
  S2 重启网关.bat  → gateway comes back with a DIFFERENT pid
  S3 停止网关.bat  → port 3050 released

Encoding red-line: every script must decode strictly as UTF-8 (no BOM) and
declare `chcp 65001`; console output must not contain U+FFFD replacement
chars (the classic Chinese-bat mojibake signature).

The test cleans up after itself: final state = gateway stopped.
"""
import json, os, re, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
HEALTH = "http://127.0.0.1:3050/health"
PASS = FAIL = 0
FAILURES = []

def report(ok, name, detail=""):
    global PASS, FAIL
    print(f"{'✅' if ok else '❌'} {name} {detail}", flush=True)
    if ok: PASS += 1
    else: FAIL += 1; FAILURES.append(f"{name}: {detail}")

def run_bat(name, arg=None, timeout=90):
    # Output goes to a FILE (kept for post-mortem), not a pipe: hidden
    # grand-children spawned by the script can hold pipe write-ends open and
    # deadlock communicate().
    out_path = os.path.join(os.environ.get("TEMP", "/tmp"), f"ccgw-bat-{name}.log")
    cmd = ["cmd", "/c", os.path.join(ROOT, name)]
    if arg: cmd.append(arg)
    with open(out_path, "wb") as f:
        try:
            p = subprocess.run(cmd, stdout=f, stderr=subprocess.STDOUT, timeout=timeout,
                               cwd=ROOT, creationflags=subprocess.CREATE_NO_WINDOW)
            rc = p.returncode
        except subprocess.TimeoutExpired:
            rc = -1
    out = open(out_path, "rb").read().decode("utf-8", "replace")
    return rc, out

def pid_on_3050():
    out = subprocess.run(["netstat", "-ano"], capture_output=True).stdout.decode("utf-8", "replace")
    m = re.search(r":3050\s.*LISTENING\s+(\d+)", out)
    return int(m.group(1)) if m else None

def wait_health(timeout_s, want=True, obs=None):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            ok = json.loads(urllib.request.urlopen(HEALTH, timeout=3).read()).get("status") == "ok"
            if obs is not None: obs.append(f"health={'ok' if ok else 'no'}")
            if want and ok: return True
        except Exception as e:
            pid = pid_on_3050()
            if obs is not None: obs.append(f"health-err={type(e).__name__}:{str(e)[:60]} pid={pid}")
            if not want: return True if pid is None else False
        time.sleep(1)
    return False

def bat_log_tail(name, n=400):
    path = os.path.join(os.environ.get("TEMP", "/tmp"), f"ccgw-bat-{name}.log")
    try:
        return open(path, "rb").read().decode("utf-8", "replace")[-n:].replace("\r\n", " | ")
    except OSError:
        return "(no log)"

def main():
    # E0: encoding red-line — UTF-8 strict, no BOM, declares chcp 65001
    for name in ("启动网关.bat", "停止网关.bat", "重启网关.bat"):
        path = os.path.join(ROOT, name)
        try:
            b = open(path, "rb").read()
            b.decode("utf-8")  # strict
            ok = b[:3] != b"\xef\xbb\xbf" and b"chcp 65001" in b
            report(ok, f"E0 {name} 编码(UTF-8 无 BOM + chcp 65001)",
                   f"{len(b)}B" + ("" if ok else " | BOM 或缺 chcp"))
        except FileNotFoundError:
            report(False, f"E0 {name} 存在", "文件不存在")
        except UnicodeDecodeError as e:
            report(False, f"E0 {name} 编码(UTF-8 无 BOM + chcp 65001)", f"非 UTF-8: {e}")
    if FAIL:
        return finish()  # scripts missing/mis-encoded → behavioural runs meaningless

    # S1: 启动网关.bat → listening
    rc, out = run_bat("启动网关.bat", "--no-browser")
    up = wait_health(60)
    pid1 = pid_on_3050()
    report(up and pid1, "S1 启动网关 → 3050 监听且 /health 200",
           f"rc={rc} pid={pid1}" + ("" if "\ufffd" not in out else " | 输出含乱码符"))
    if not up: return finish()

    # S2: 重启网关.bat → new pid, still healthy
    rc, out = run_bat("重启网关.bat", "--no-browser", timeout=90)
    up2 = wait_health(75)
    pid2 = pid_on_3050()
    report(up2 and pid2 and pid2 != pid1, "S2 重启网关 → 回到 200 且 PID 已更换",
           f"rc={rc} {pid1} → {pid2}" + ("" if "\ufffd" not in out else " | 输出含乱码符"))

    # S3: 停止网关.bat → port released
    rc, out = run_bat("停止网关.bat")
    obs3 = []
    freed = wait_health(15, want=False, obs=obs3)
    raw = subprocess.run(["netstat", "-ano"], capture_output=True).stdout.decode("utf-8", "replace")
    lines3050 = [l.strip() for l in raw.splitlines() if ":3050" in l]
    report(freed and pid_on_3050() is None, "S3 停止网关 → 3050 释放",
           f"rc={rc} obs={obs3} netstat3050={lines3050} log[{bat_log_tail('停止网关.bat')}]"
           + ("" if "\ufffd" not in out else " | 输出含乱码符"))

    return finish()

def finish():
    # safety net: never leave the gateway running behind the test
    p = pid_on_3050()
    if p:
        subprocess.run(["taskkill", "/PID", str(p), "/F"], capture_output=True)
    print(f"\nLAUNCH SCRIPT TEST: {PASS} passed, {FAIL} failed / {PASS+FAIL} total")
    for f in FAILURES: print(f"  ❌ {f}")
    sys.exit(1 if FAIL else 0)

if __name__ == "__main__":
    main()
