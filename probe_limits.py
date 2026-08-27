#!/usr/bin/env python3
"""Probe CC API rate limits for free models."""
import subprocess, time, concurrent.futures, json

API_KEY = "user_REDACTED"
PROXY = "127.0.0.1:7897"
MODEL = "minimax/minimax-m3-free"

def make_body(idx):
    return json.dumps({
        "config": {"workingDir":"","date":"2026-08-27","environment":"test","structure":[],
                    "isGitRepo":False,"currentBranch":"","mainBranch":"","gitStatus":"","recentCommits":[]},
        "memory":None,"taste":None,"skills":"","permissionMode":"standard",
        "params": {"model":MODEL,"messages":[{"role":"user","content":"hi"}],"max_tokens":5,"stream":True}
    })

def curl_req(idx, concurrent=False):
    t = time.time()
    try:
        r = subprocess.run([
            "curl", "-s", "--socks5", PROXY, "-o", "/dev/null", "-w", "%{http_code}",
            "--max-time", "20",
            "https://api.commandcode.ai/alpha/generate",
            "-H", "Content-Type: application/json",
            "-H", f"Authorization: Bearer {API_KEY}",
            "-H", "x-cli-environment: production",
            "-H", "x-command-code-version: 1.36.0",
            "-H", f"x-session-id: probe-{idx}",
            "-d", make_body(idx)
        ], capture_output=True, text=True, timeout=25)
        return idx, r.stdout.strip(), time.time() - t
    except Exception as e:
        return idx, f"error:{e}", time.time() - t

# Test 1: Sequential (15 requests)
print("═══ Test 1: 15 sequential requests ═══")
t0 = time.time()
results = [curl_req(i) for i in range(1, 16)]
for i, code, elapsed in results:
    print(f"  req{i}: HTTP {code} ({elapsed:.1f}s)")
ok = sum(1 for _, c, _ in results if c == "200")
print(f"  → {ok}/15 succeeded, total {time.time()-t0:.1f}s\n")

# Test 2: Concurrent (10 at once)
print("═══ Test 2: 10 concurrent requests ═══")
t0 = time.time()
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
    results = list(pool.map(lambda i: curl_req(100+i, True), range(10)))
for i, code, elapsed in results:
    print(f"  req{i}: HTTP {code} ({elapsed:.1f}s)")
ok = sum(1 for _, c, _ in results if c == "200")
print(f"  → {ok}/10 succeeded, total {time.time()-t0:.1f}s\n")

# Test 3: Burst then wait (5 rapid, wait 5s, 5 more)
print("═══ Test 3: Burst-wait-burst ═══")
t0 = time.time()
results1 = [curl_req(200+i) for i in range(5)]
print(f"  First burst: {sum(1 for _,c,_ in results1 if c=='200')}/5")
print("  Waiting 5s...")
time.sleep(5)
results2 = [curl_req(210+i) for i in range(5)]
print(f"  Second burst: {sum(1 for _,c,_ in results2 if c=='200')}/5")
print(f"  Total: {time.time()-t0:.1f}s\n")

# Test 4: Long request then fast requests (does long gen block others?)
print("═══ Test 4: Long gen + fast requests ═══")
t0 = time.time()
# Start a long request in background
long_future = None
def long_req():
    return subprocess.run([
        "curl", "-s", "--socks5", PROXY, "-o", "/dev/null", "-w", "%{http_code}",
        "--max-time", "60",
        "https://api.commandcode.ai/alpha/generate",
        "-H", "Content-Type: application/json",
        "-H", f"Authorization: Bearer {API_KEY}",
        "-H", "x-cli-environment: production",
        "-H", "x-command-code-version: 1.36.0",
        "-H", "x-session-id: probe-long",
        "-d", json.dumps({
            "config": {"workingDir":"","date":"2026-08-27","environment":"test","structure":[],
                        "isGitRepo":False,"currentBranch":"","mainBranch":"","gitStatus":"","recentCommits":[]},
            "memory":None,"taste":None,"skills":"","permissionMode":"standard",
            "params": {"model":MODEL,"messages":[{"role":"user","content":"write a 3000 word essay about AI"}],
                       "max_tokens":4000,"stream":True}
        })
    ], capture_output=True, text=True, timeout=65)

with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    long_future = pool.submit(long_req)
    time.sleep(1)  # Let long request start
    fast_results = [pool.submit(curl_req, 300+i).result() for i in range(5)]

long_code = long_future.result().stdout.strip()
fast_ok = sum(1 for _, c, _ in fast_results if c == "200")
print(f"  Long request: HTTP {long_code}")
print(f"  Fast requests during long: {fast_ok}/5 succeeded")
print(f"  Total: {time.time()-t0:.1f}s\n")

print("═══ Summary ═══")
print("If concurrent requests all succeed → no strict rate limit")
print("If some fail with 429 → there IS a rate limit")
