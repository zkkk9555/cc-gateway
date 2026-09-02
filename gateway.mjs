#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════════
// cc-gateway — Command Code CLI → Standard API Gateway
// Translates CC /alpha/generate private protocol into:
//   - OpenAI Chat Completions  (/v1/chat/completions)
//   - Anthropic Messages       (/v1/messages)
//   - OpenAI Responses          (/v1/responses)
// Zero npm dependencies. Node.js 22+ required.
// ═══════════════════════════════════════════════════════════════════════════════

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`cc-gateway v1.0.30
Usage:
  node gateway.mjs                    Start the gateway
  node gateway.mjs --set-key          Set primary API key interactively
  node gateway.mjs --add-key user_xxx Add a key to the pool
  node gateway.mjs --remove-key user_xxx  Remove a key from the pool
  node gateway.mjs --list-keys        List pool keys (masked)
  node gateway.mjs --show-key         Show masked primary API key
  node gateway.mjs --delete-key       Delete primary API key
  node gateway.mjs --version          Show version
  node gateway.mjs --help             Show this help`);
  process.exit(0);
}
if (args.includes('--version')) { console.log('cc-gateway v1.0.30'); process.exit(0); }

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = { port: 3050, host: '0.0.0.0', api_key: '', api_keys: [], api_base: 'https://api.commandcode.ai', log_level: 'info', proxy: { enabled: false, host: '127.0.0.1', port: 7897 }, stream_timeout_ms: 120000, reasoning_timeout_ms: 300000 };

function loadConfig() {
  let cfg = { ...DEFAULT_CONFIG };
  try { if (fs.existsSync(CONFIG_PATH)) Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch {}
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT) || cfg.port;
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.CC_API_KEY) cfg.api_key = process.env.CC_API_KEY;
  if (process.env.CC_API_BASE) cfg.api_base = process.env.CC_API_BASE;
  if (process.env.LOG_LEVEL) cfg.log_level = process.env.LOG_LEVEL;
  return cfg;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let CFG = loadConfig();

// ── Key Management CLI ──────────────────────────────────────────────────────

if (args.includes('--set-key')) {
  process.stdout.write('Enter API Key (user_xxx): ');
  const rl = await import('node:readline');
  const r = rl.createInterface({ input: process.stdin, output: process.stdout });
  const key = await new Promise(res => r.question('', ans => { r.close(); res(ans.trim()); }));
  if (!key.startsWith('user_')) { console.error('Error: Key must start with user_'); process.exit(1); }
  CFG.api_key = key; saveConfig(CFG);
  console.log('API Key saved.'); process.exit(0);
}
if (args.includes('--add-key')) {
  const idx = args.indexOf('--add-key');
  const key = idx >= 0 ? (args[idx + 1] || '').trim() : '';
  if (!key.startsWith('user_')) { console.error('Error: Key must start with user_. Usage: node gateway.mjs --add-key user_xxx'); process.exit(1); }
  if (!Array.isArray(CFG.api_keys)) CFG.api_keys = [];
  if (!CFG.api_keys.includes(key)) CFG.api_keys.push(key);
  if (!CFG.api_key) CFG.api_key = key;
  saveConfig(CFG);
  console.log(`Key added. Pool size: ${new Set([CFG.api_key, ...CFG.api_keys].filter(Boolean)).size}`);
  process.exit(0);
}
if (args.includes('--remove-key')) {
  const idx = args.indexOf('--remove-key');
  const key = idx >= 0 ? (args[idx + 1] || '').trim() : '';
  if (Array.isArray(CFG.api_keys)) {
    CFG.api_keys = CFG.api_keys.filter(k => k !== key);
    saveConfig(CFG);
    console.log(`Key removed. Pool size: ${new Set([CFG.api_key, ...CFG.api_keys].filter(Boolean)).size}`);
  } else console.log('No key pool configured.');
  process.exit(0);
}
if (args.includes('--list-keys')) {
  const pool = [...new Set([CFG.api_key, ...(Array.isArray(CFG.api_keys) ? CFG.api_keys : [])].filter(Boolean))];
  if (!pool.length) { console.log('No keys configured. Use --set-key or --add-key.'); }
  else pool.forEach((k, i) => console.log(`${i + 1}. ${k.slice(0, 8)}…${k.slice(-4)}`));
  process.exit(0);
}
if (args.includes('--show-key')) {
  console.log(CFG.api_key ? `Primary Key: ${CFG.api_key.slice(0, 8)}…${CFG.api_key.slice(-4)}` : 'No key set.');
  process.exit(0);
}
if (args.includes('--delete-key')) {
  CFG.api_key = ''; saveConfig(CFG); console.log('API Key deleted.'); process.exit(0);
}

// ── Logging ─────────────────────────────────────────────────────────────────

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LOG_LEVELS[CFG.log_level] ?? 1;

// ── Log File Persistence ───────────────────────────────────────────────────

const LOG_DIR = path.join(__dirname, 'logs');
let logStream = null;
let logFileDate = '';

function getLogFile() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== logFileDate) {
    if (logStream) { try { logStream.end(); } catch {} }
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(path.join(LOG_DIR, `gateway-${today}.log`), { flags: 'a' });
    logFileDate = today;
  }
  return logStream;
}

// Request correlation: every log line emitted while handling a request is
// prefixed with its short id, so concurrent requests' lines can be separated
// and a single request's full lifecycle reconstructed from the log file.
const requestStore = new AsyncLocalStorage();
function newReqId() { return 'r' + crypto.randomBytes(3).toString('hex'); }
function reqTag() {
  const s = requestStore.getStore();
  return s?.reqId ? ` [${s.reqId}]` : '';
}

function log(level, msg, data) {
  if ((LOG_LEVELS[level] ?? 1) < minLevel) return;
  const ts = new Date().toISOString();
  const extra = data ? ' ' + JSON.stringify(data) : '';
  const line = `[${ts}] [${level}]${reqTag()} ${msg}${extra}`;
  console.error(line);
  try { getLogFile().write(line + '\n'); } catch {}
}

function logError(msg, error) {
  const ts = new Date().toISOString();
  const stack = error?.stack || error?.message || String(error);
  const line = `[${ts}] [error]${reqTag()} ${msg}\n${stack}`;
  console.error(line);
  try { getLogFile().write(line + '\n'); } catch {}
}

// ── Token Usage Tracking ─────────────────────────────────────────────────────
// Persisted to data/usage.json — survives restarts.

const USAGE_FILE = path.join(__dirname, 'data', 'usage.json');
const tokenUsage = new Map(); // key: "YYYY-MM-DD|model" → { input, output, requests }

function getTodayStr() { return new Date().toISOString().slice(0, 10); }

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      const obj = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      for (const [k, v] of Object.entries(obj)) tokenUsage.set(k, v);
      log('info', `Usage loaded: ${tokenUsage.size} entries`);
    }
  } catch (e) { log('warn', `Usage load failed: ${e.message}`); }
}

function saveUsage() {
  try {
    const dir = path.dirname(USAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(tokenUsage);
    fs.writeFileSync(USAGE_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

function recordTokens(model, inputTokens, outputTokens) {
  const day = getTodayStr();
  const key = `${day}|${model}`;
  let entry = tokenUsage.get(key);
  if (!entry) { entry = { input: 0, output: 0, requests: 0 }; tokenUsage.set(key, entry); }
  entry.input += inputTokens;
  entry.output += outputTokens;
  entry.requests++;
  // Cleanup days older than 30 days
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  for (const [k] of tokenUsage) {
    if (k.split('|')[0] < cutoff) tokenUsage.delete(k);
  }
  saveUsage();
}

function getUsageSummary() {
  const day = getTodayStr();
  const models = [];
  let totalInput = 0, totalOutput = 0, totalRequests = 0;
  for (const [key, entry] of tokenUsage) {
    if (!key.startsWith(day)) continue;
    const model = key.split('|')[1];
    models.push({ model, input: entry.input, output: entry.output, requests: entry.requests });
    totalInput += entry.input;
    totalOutput += entry.output;
    totalRequests += entry.requests;
  }
  models.sort((a, b) => (b.input + b.output) - (a.input + a.output));
  return { date: day, models, total: { input: totalInput, output: totalOutput, requests: totalRequests, tokens: totalInput + totalOutput } };
}

// ── In-Memory Log Buffer (for dashboard) ─────────────────────────────────────
const logBuffer = [];
const LOG_BUFFER_MAX = 200;

function logToBuffer(level, msg) {
  const ts = new Date().toISOString();
  logBuffer.push({ ts, level, msg });
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}

// Patch log function to also buffer
const _origLog = log;
log = function(level, msg, data) {
  _origLog(level, msg, data);
  logToBuffer(level, msg);
};

// ── Fingerprint ─────────────────────────────────────────────────────────────

const CPU_MODELS = ['12th Gen Intel(R) Core(TM) i7-12650H','13th Gen Intel(R) Core(TM) i7-13700K','13th Gen Intel(R) Core(TM) i9-13900K','Intel(R) Core(TM) Ultra 7 155H','AMD Ryzen 7 7800X3D','AMD Ryzen 9 7950X'];
const MEM_SIZES = [8, 16, 24, 32, 48, 64];
const TIMEZONES = ['America/New_York','Europe/London','Asia/Shanghai','Asia/Tokyo','Pacific/Auckland'];

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function randHex(n) { return crypto.randomBytes(n).toString('hex'); }

function generateFingerprint() {
  const cpu = CPU_MODELS[Math.floor(Math.random() * CPU_MODELS.length)];
  const cpuCount = Math.floor(Math.random() * 16) + 4;
  const mem = MEM_SIZES[Math.floor(Math.random() * MEM_SIZES.length)];
  const tz = TIMEZONES[Math.floor(Math.random() * TIMEZONES.length)];
  const macHashes = Array.from({ length: Math.floor(Math.random() * 4) + 2 }, () => sha256(randHex(32)));
  const machineIdHash = sha256(randHex(32));
  const osUserHash = sha256(randHex(16));
  const hostnameHash = sha256(randHex(16));
  const gitEmailHash = sha256(randHex(16));
  const thumbData = [machineIdHash, macHashes.join('|'), osUserHash, hostnameHash, gitEmailHash, 'win32', '10.0.22631', cpu, String(cpuCount), String(mem)].join('|');
  return {
    thumbmark: sha256(thumbData),
    components: {
      machine_id_hash: machineIdHash, mac_hashes: macHashes, os_user_hash: osUserHash,
      hostname_hash: hostnameHash, git_email_hash: gitEmailHash,
      platform: 'win32', arch: 'x64', os_release: '10.0.22631',
      cpu_model: cpu, cpu_count: cpuCount, mem_gib: mem, is_container: false,
      timezone: tz, runtime: 'cli', collector_version: 1,
    },
  };
}

// ── CC Version ──────────────────────────────────────────────────────────────

let CC_VERSION = '1.33.0';
let ccVersionRefreshAt = 0;

async function refreshCcVersion() {
  try {
    const res = await fetchWithTimeout('https://registry.npmjs.org/command-code/latest', {}, 10000);
    if (res.ok) {
      const pkg = await res.json();
      if (pkg.version) { CC_VERSION = pkg.version; log('info', `CC version refreshed: ${CC_VERSION}`); }
    }
  } catch (e) { log('warn', `CC version refresh failed: ${e.message}`); }
  ccVersionRefreshAt = Date.now() + 24 * 60 * 60 * 1000;
}

// ── Session Management ──────────────────────────────────────────────────────

const SESSION_DURATION = 12 * 60 * 60 * 1000; // 12h
const SESSION_JITTER = 1 * 60 * 60 * 1000;    // 1h

const sessions = new Map(); // apiKey → { sessionId, expiresAt }

function getSessionId(apiKey) {
  const existing = sessions.get(apiKey);
  if (existing && Date.now() < existing.expiresAt) return existing.sessionId;
  const sessionId = crypto.randomUUID();
  const jitter = Math.floor(Math.random() * SESSION_JITTER);
  sessions.set(apiKey, { sessionId, expiresAt: Date.now() + SESSION_DURATION + jitter });
  log('info', `Session created for ${apiKey.slice(0, 8)}`);
  return sessionId;
}

// ── API Key Pool ────────────────────────────────────────────────────────────
// Aggregates multiple upstream keys (like New API / sub2api): round-robin
// distribution for capacity, per-request failover so key-level failures are
// invisible to downstream clients, 429 cooldown and auth-failure disabling.

const KEY_COOLDOWN_MS = 60000; // after a 429, skip the key for 1 minute

const keyPool = { keys: [], rr: 0, health: new Map() };

function buildKeyPool() {
  const list = [];
  for (const k of [CFG.api_key, ...(Array.isArray(CFG.api_keys) ? CFG.api_keys : [])]) {
    if (k && k.startsWith('user_') && !list.includes(k)) list.push(k);
  }
  keyPool.keys = list;
  if (keyPool.rr >= list.length) keyPool.rr = 0;
  for (const k of [...keyPool.health.keys()]) if (!list.includes(k)) keyPool.health.delete(k);
  return list;
}

function keyHealth(key) {
  let h = keyPool.health.get(key);
  if (!h) { h = { disabled: false, cooldownUntil: 0, failures: 0, lastError: null }; keyPool.health.set(key, h); }
  return h;
}

function poolNextKey() {
  const n = keyPool.keys.length;
  if (!n) return null;
  // Pass 1: healthy keys only. Pass 2: allow cooling keys (better than failing
  // when the whole pool is rate-limited). Disabled keys are never returned.
  for (const allowCooling of [false, true]) {
    for (let i = 0; i < n; i++) {
      const idx = (keyPool.rr + i) % n;
      const key = keyPool.keys[idx];
      const h = keyHealth(key);
      if (h.disabled) continue;
      if (!allowCooling && Date.now() < h.cooldownUntil) continue;
      keyPool.rr = (idx + 1) % n;
      return key;
    }
  }
  return null;
}

function poolActiveCount() { return keyPool.keys.filter(k => !keyHealth(k).disabled).length; }

function poolPickAny() { return keyPool.keys.find(k => !keyHealth(k).disabled) || null; }

function poolMarkSuccess(key) {
  const h = keyHealth(key);
  h.cooldownUntil = 0; h.failures = 0; h.lastError = null;
}

function poolCooldown(key, reason = 'rate_limited') {
  const h = keyHealth(key);
  h.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
  h.failures++; h.lastError = reason;
  log('warn', `Key ${key.slice(0, 8)}… cooling down ${KEY_COOLDOWN_MS / 1000}s (${reason})`);
}

function poolDisable(key, reason = 'auth_failed') {
  const h = keyHealth(key);
  h.disabled = true; h.failures++; h.lastError = reason;
  log('error', `Key ${key.slice(0, 8)}… DISABLED from pool (${reason}). Restart or --remove-key to clear.`);
}

function poolStatus(reveal = false) {
  return {
    total: keyPool.keys.length,
    healthy: poolActiveCount(),
    keys: keyPool.keys.map(k => {
      const h = keyHealth(k);
      return {
        key: reveal ? k : `${k.slice(0, 8)}…${k.slice(-4)}`,
        status: h.disabled ? 'disabled' : (Date.now() < h.cooldownUntil ? 'cooldown' : 'ok'),
        failures: h.failures,
        last_error: h.lastError,
      };
    }),
  };
}

// Live pool mutations (dashboard management) — update the running pool AND
// persist to config.json so the state survives restarts. Plaintext by design.
function poolAddKey(key) {
  key = (key || '').trim();
  if (!/^user_[a-zA-Z0-9_-]{8,}$/.test(key)) return { ok: false, error: 'Key 格式无效：需 user_ 开头，仅含字母/数字/_/-' };
  if (keyPool.keys.includes(key)) return { ok: false, error: '该 Key 已在池中' };
  keyPool.keys.push(key);
  if (!Array.isArray(CFG.api_keys)) CFG.api_keys = [];
  if (!CFG.api_keys.includes(key)) CFG.api_keys.push(key);
  if (!CFG.api_key) CFG.api_key = key;
  saveConfig(CFG);
  return { ok: true };
}

function poolRemoveKey(key) {
  const i = keyPool.keys.indexOf(key);
  if (i < 0) return { ok: false, error: '该 Key 不在池中' };
  keyPool.keys.splice(i, 1);
  keyPool.health.delete(key);
  if (Array.isArray(CFG.api_keys)) CFG.api_keys = CFG.api_keys.filter(k => k !== key);
  if (CFG.api_key === key) CFG.api_key = CFG.api_keys[0] || '';
  if (keyPool.rr >= keyPool.keys.length) keyPool.rr = 0;
  saveConfig(CFG);
  return { ok: true };
}

function poolEnableKey(key) {
  if (!keyPool.keys.includes(key)) return { ok: false, error: '该 Key 不在池中' };
  const h = keyHealth(key);
  h.disabled = false; h.cooldownUntil = 0; h.failures = 0; h.lastError = null;
  return { ok: true };
}

// Per-request key selector: first pick = round-robin (load distribution),
// subsequent picks = failover to the next healthy key. A client-provided key
// NOT present in the pool is passed through unchanged (power-user escape hatch).
function createKeySelector(clientKey) {
  const passthrough = !!(clientKey && !keyPool.keys.includes(clientKey));
  return {
    passthrough,
    next() {
      if (passthrough) return clientKey;
      return poolNextKey();
    },
  };
}

buildKeyPool();

// ── Initialization (Fingerprint + Lifecycle) ────────────────────────────────

const INIT_REFRESH = 8 * 60 * 60 * 1000;
const INIT_JITTER = 2 * 60 * 60 * 1000;
const keyStates = new Map(); // apiKey → { fingerprint, nextInitAt }

function getKeyState(apiKey) {
  let st = keyStates.get(apiKey);
  if (!st) { st = { fingerprint: generateFingerprint(), nextInitAt: 0 }; keyStates.set(apiKey, st); }
  return st;
}

async function ensureInitialized(apiKey) {
  const st = getKeyState(apiKey);
  if (Date.now() < st.nextInitAt) return;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-cli-environment': 'production',
    'x-command-code-version': CC_VERSION,
  };
  const fp = st.fingerprint;
  const lcBody = {
    eventType: 'cli_session_exists',
    metadata: {
      sessionId: `sess_${randHex(8)}`,
      cliVersion: CC_VERSION,
      mode: 'interactive',
      os: `${fp.components.platform}-${fp.components.arch}`,
    },
  };

  try {
    await Promise.all([
      fetchWithTimeout(`${CFG.api_base}/alpha/fingerprint/record`, { method: 'POST', headers, body: JSON.stringify(fp) }, 15000)
        .then(r => { if (r.ok) log('info', 'Fingerprint recorded'); else log('warn', `Fingerprint failed: ${r.status}`); })
        .catch(e => log('warn', `Fingerprint error: ${e.message}`)),
      fetchWithTimeout(`${CFG.api_base}/alpha/lifecycle-events`, { method: 'POST', headers, body: JSON.stringify(lcBody) }, 15000)
        .then(r => { if (r.ok) log('info', 'Lifecycle event sent'); else log('warn', `Lifecycle failed: ${r.status}`); })
        .catch(e => log('warn', `Lifecycle error: ${e.message}`)),
    ]);
    const jitter = Math.floor(Math.random() * INIT_JITTER);
    st.nextInitAt = Date.now() + INIT_REFRESH + jitter;
  } catch (e) { log('warn', `Init error: ${e.message}`); }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function fetchWithTimeout(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// Parse a CC upstream error body into a clean message + code.
// Upstream returns {"success":false,"error":{"code":"MODEL_NOT_IN_PLAN","message":"..."}} —
// surface that readably instead of a raw JSON blob.
function parseUpstreamError(errText, status) {
  let message = `CC API error: ${status}`, code = null;
  try {
    const j = JSON.parse(errText);
    const e = j.error || j;
    if (e?.message) { message = e.message; code = e.code || j.code || null; }
  } catch { if (errText && errText.trim()) message = errText.slice(0, 500); }
  return { message, code };
}

// Deterministic client/validation errors — retrying them for 120s just hammers
// upstream and delays the inevitable failure. Transient errors ("Service
// temporarily unavailable", "timed out", rate limits) never match these patterns.
const PERMANENT_ERROR_RE = /invalid|must not be|not be empty|required|unsupported|not supported|unknown model|not found|too (large|long|many|big)|exceeds|permission|denied|unauthorized|malformed/i;

function isRetryableUpstreamError(message) {
  return !PERMANENT_ERROR_RE.test(message || '');
}

// 4xx (except 429) are permanent; 429 and 5xx are transient and retried
function isPermanentHttpStatus(status) {
  return status >= 400 && status < 500 && status !== 429;
}

// Fake signature for Anthropic thinking blocks. Anthropic validates signatures
// cryptographically; third-party proxies cannot mint valid ones. Claude Code's
// shallow check only requires base64 with payload first byte 0x12.
// Derived from the thinking text so each block's signature differs.
function fakeThinkingSignature(thinkingText) {
  const seed = crypto.createHash('sha256').update(thinkingText || 'cc-gateway-thinking').digest().subarray(0, 64);
  const raw = Buffer.concat([Buffer.from([0x12, seed.length]), seed]);
  return raw.toString('base64');
}

// ── SOCKS5 Proxy Tunnel ────────────────────────────────────────────────────

function socks5Connect(proxyHost, proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, proxyHost, () => {
      // SOCKS5 greeting: version 5, 1 auth method (no auth)
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    let step = 0;
    socket.on('data', (data) => {
      if (step === 0) {
        if (data[0] !== 0x05 || data[1] !== 0x00) { reject(new Error('SOCKS5 auth failed')); return; }
        step = 1;
        const hostBuf = Buffer.from(targetHost);
        const buf = Buffer.alloc(7 + hostBuf.length);
        buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x03; // ATYP=domain
        buf[4] = hostBuf.length;
        hostBuf.copy(buf, 5);
        buf.writeUInt16BE(targetPort, 5 + hostBuf.length);
        socket.write(buf);
      } else if (step === 1) {
        if (data[1] !== 0x00) { reject(new Error('SOCKS5 connect failed: code=' + data[1])); return; }
        resolve(socket);
      }
    });
    socket.on('error', reject);
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('SOCKS5 timeout')); });
  });
}

async function forwardToCCViaProxy(body, apiKey, signal) {
  const sessionId = getSessionId(apiKey);
  await ensureInitialized(apiKey);

  const targetHost = new URL(CFG.api_base).hostname;
  const targetPort = 443;
  const targetPath = '/alpha/generate';

  const proxyHost = CFG.proxy?.host || '127.0.0.1';
  const proxyPort = CFG.proxy?.port || 7897;

  const payload = JSON.stringify(body);

  const tunnelSocket = await socks5Connect(proxyHost, proxyPort, targetHost, targetPort);

  return new Promise((resolve, reject) => {
    if (signal) signal.addEventListener('abort', () => { tunnelSocket.destroy(); reject(new Error('Aborted')); });

    const tlsSocket = tls.connect({
      socket: tunnelSocket,
      servername: targetHost,
    }, () => {
      const headers = [
        `POST ${targetPath} HTTP/1.1`,
        `Host: ${targetHost}`,
        'Content-Type: application/json',
        `Authorization: Bearer ${apiKey}`,
        'x-cli-environment: production',
        `x-command-code-version: ${CC_VERSION}`,
        `x-session-id: ${sessionId}`,
        'x-co-flag: false',
        'x-taste-learning: false',
        `x-project-slug: ${fakeProjectSlug(sessionId)}`,
        `traceparent: ${generateTraceparent()}`,
        `Content-Length: ${Buffer.byteLength(payload)}`,
        'Connection: close',
        '', '',
      ].join('\r\n');
      tlsSocket.write(headers + payload);
    });

    tlsSocket.on('error', reject);

    // Collect the response as a stream-like object for compatibility with existing handlers.
    // Handles chunked transfer-encoding: without decoding, hex chunk-size markers leak
    // into the NDJSON body and corrupt the event stream (visible as "11" lines).
    let headerBuf = Buffer.alloc(0);
    let headersParsed = false;
    let errorBody = null;      // accumulating full body for non-2xx
    let errorTimer = null;

    const enqueueBody = (ctrl) => (buf) => { try { ctrl.enqueue(buf); } catch {} };

    tlsSocket.on('data', (chunk) => {
      if (!headersParsed) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const headerEnd = headerBuf.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        headersParsed = true;
        const headerText = headerBuf.slice(0, headerEnd).toString('latin1');
        const headerLines = headerText.split('\r\n');
        const statusCode = parseInt(headerLines[0].split(' ')[1]) || 500;
        const respHeaders = {};
        for (const h of headerLines.slice(1)) {
          const i = h.indexOf(':');
          if (i > 0) respHeaders[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
        }
        let bodyStart = headerBuf.slice(headerEnd + 4);
        headerBuf = null;

        if (statusCode < 200 || statusCode >= 300) {
          // Non-2xx: accumulate the FULL error body (up to 5s safety), then resolve.
          // Subsequent bytes arrive via the main data listener's errorBody branch.
          errorBody = [bodyStart];
          errorTimer = setTimeout(() => {
            if (errorBody) {
              const text = Buffer.concat(errorBody).toString('utf8');
              errorBody = null;
              resolve({ ok: false, status: statusCode, text: () => Promise.resolve(text), body: { getReader() { return emptyReader(); } } });
            }
          }, 5000);
          tlsSocket.on('end', () => {
            if (errorBody) {
              clearTimeout(errorTimer);
              const text = Buffer.concat(errorBody).toString('utf8');
              errorBody = null;
              resolve({ ok: false, status: statusCode, text: () => Promise.resolve(text), body: { getReader() { return emptyReader(); } } });
            }
          });
          return;
        }

        // Streaming 2xx: build a byte-accurate body stream
        const isChunked = /chunked/i.test(respHeaders['transfer-encoding'] || '');
        let streamClosed = false;
        const stream = new ReadableStream({
          start(ctrl) {
            const emit = enqueueBody(ctrl);
            let chunkDecoder = null;
            if (isChunked) {
              let pending = Buffer.alloc(0);
              let state = 'size', remaining = 0;
              const feed = () => {
                if (streamClosed) return;
                let progressed = true;
                while (progressed) {
                  progressed = false;
                  if (state === 'size') {
                    const idx = pending.indexOf('\r\n');
                    if (idx >= 0) {
                      const sizeLine = pending.slice(0, idx).toString('latin1').split(';')[0].trim();
                      pending = pending.slice(idx + 2);
                      remaining = parseInt(sizeLine, 16);
                      if (isNaN(remaining)) { state = 'done'; break; }
                      state = remaining === 0 ? 'done' : 'data';
                      progressed = true;
                    }
                  } else if (state === 'data') {
                    if (pending.length >= remaining + 2) { // chunk data + trailing CRLF
                      emit(pending.slice(0, remaining));
                      pending = pending.slice(remaining + 2);
                      remaining = 0;
                      state = 'size';
                      progressed = true;
                    }
                  }
                }
              };
              chunkDecoder = {
                push(c) { pending = Buffer.concat([pending, c]); feed(); },
              };
            }
            const pushBody = (c) => { if (chunkDecoder) chunkDecoder.push(c); else emit(c); };
            if (bodyStart.length) pushBody(bodyStart);
            tlsSocket.on('data', (c) => { if (!streamClosed) pushBody(c); });
            tlsSocket.on('end', () => { streamClosed = true; try { ctrl.close(); } catch {} });
            tlsSocket.on('error', (e) => { streamClosed = true; try { ctrl.error(e); } catch {} });
          },
        });

        resolve({
          ok: true,
          status: statusCode,
          body: {
            getReader() { return stream.getReader(); },
          },
        });
      } else if (errorBody) {
        errorBody.push(chunk);
      }
      // (streaming body bytes are forwarded via the listener registered above)
    });

    tlsSocket.on('end', () => {
      if (!headersParsed) reject(new Error('Connection closed before response headers'));
    });
  });
}

function emptyReader() {
  return { read() { return Promise.resolve({ done: true }); } };
}

function randomUUID() { return crypto.randomUUID(); }
function nowUnix() { return Math.floor(Date.now() / 1000); }
function getDateStr() { return new Date().toISOString().slice(0, 10); }

// ── Client Detection ───────────────────────────────────────────────────────

function detectClient(req, body) {
  const path = req.url || '';
  const headers = req.headers || {};

  // Claude Code: uses /v1/messages + anthropic-version header
  if (path.includes('/messages') && headers['anthropic-version']) return 'claude-code';

  // Try to detect from request body
  if (body) {
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;

      // Hermes: developer role message OR reasoning_effort parameter
      if (parsed.messages?.some(m => m.role === 'developer') || parsed.reasoning_effort) {
        return 'hermes';
      }

      // OpenCode: Chat Completions with tools but no developer role
      if (parsed.tools?.length > 0) {
        return 'opencode';
      }
    } catch {}
  }

  // Fallback: infer from endpoint
  if (path.includes('/messages')) return 'anthropic-client';
  if (path.includes('/responses')) return 'responses-client';
  return 'unknown';
}

function generateTraceparent() {
  const trace = randHex(16);
  const parent = randHex(8);
  return `00-${trace}-${parent}-01`;
}

function fakeProjectSlug(sessionId) {
  const NAMES = ['app','api','backend','bot','cli','core','data','frontend','lib','plugin','proxy','server','service','tool','web','worker'];
  const hex4 = sessionId.slice(0, 4);
  const idx = parseInt(hex4, 16) % NAMES.length;
  const name = NAMES[idx];
  const path = `c-Users-dev-projects-${name}-${hex4}`;
  return path.replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'cc-proxy';
}

function extractApiKey(headers) {
  const auth = headers['authorization'] || headers['Authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const m = auth.slice(7).match(/user_[a-zA-Z0-9_-]+/);
    if (m) return m[0];
  }
  const xKey = headers['x-api-key'] || headers['X-Api-Key'] || '';
  if (xKey) {
    const m = xKey.match(/user_[a-zA-Z0-9_-]+/);
    if (m) return m[0];
  }
  return null;
}

function getApiKey(headers) {
  // Client-provided key only; config keys are served via the key pool
  return extractApiKey(headers);
}

function baseHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'x-cli-environment': 'production',
    'x-command-code-version': CC_VERSION,
  };
}

// ── OpenAI → CC Translation ────────────────────────────────────────────────

function buildCcRequest(openaiReq) {
  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  const messages = openaiReq.messages || [];
  const maxTokens = Math.min(openaiReq.max_tokens || 64000, 200000);

  // Extract system/developer messages
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const systemPrompt = systemMsgs.map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean).join('\n');
  const chatMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

  // Build tool_call_id → tool_name map
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) toolNameMap[tc.id] = tc.function?.name || '';
      }
    }
  }

  // Translate messages
  const ccMessages = chatMessages.map(msg => {
    if (msg.role === 'user') {
      let parts;
      if (typeof msg.content === 'string') {
        parts = [{ type: 'text', text: msg.content }];
      } else if (Array.isArray(msg.content)) {
        parts = msg.content.map(p => {
          if (p.type === 'image_url') return { type: 'image', image: p.image_url?.url || '' };
          return p;
        });
      } else {
        parts = [{ type: 'text', text: String(msg.content || '') }];
      }
      return { role: 'user', content: parts };
    }
    if (msg.role === 'assistant') {
      const parts = [];
      if (typeof msg.content === 'string' && msg.content) {
        parts.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const p of msg.content) { if (p.type === 'text') parts.push(p); }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
          parts.push({ type: 'tool-call', toolCallId: tc.id, toolName: tc.function?.name || '', input });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (msg.role === 'tool') {
      const toolCallId = msg.tool_call_id || '';
      const toolName = toolNameMap[toolCallId] || msg.name || '';
      if (!toolName) log('warn', `Tool result with unknown tool_call_id: ${toolCallId} (name=${msg.name || 'none'})`);
      const output = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      return { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: output } }] };
    }
    return msg;
  });

  const body = {
    config: { workingDir: '', date: getDateStr(), environment: `win32-x64, Node.js ${process.version}`, structure: [], isGitRepo: false, currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [] },
    memory: null, taste: null, skills: '', permissionMode: 'standard',
    params: { model, messages: ccMessages, max_tokens: maxTokens, stream: true },
  };

  if (systemPrompt) body.params.system = systemPrompt;
  if (openaiReq.temperature !== undefined) body.params.temperature = openaiReq.temperature;
  if (openaiReq.reasoning_effort !== undefined) body.params.reasoning_effort = openaiReq.reasoning_effort;
  if (openaiReq.tools?.length) {
    body.params.tools = openaiReq.tools.map(t => ({
      type: t.type || 'function',
      name: t.function?.name || t.name || '',
      description: t.function?.description || t.description || '',
      // Chat: function.parameters; Anthropic: input_schema; Responses: flat parameters
      input_schema: t.function?.parameters || t.input_schema || t.parameters || { type: 'object', properties: {} },
    }));
  }
  if (openaiReq.tool_choice !== undefined) {
    if (typeof openaiReq.tool_choice === 'string') {
      const map = { auto: 'auto', none: 'none', required: 'any' };
      body.params.tool_choice = { type: map[openaiReq.tool_choice] || 'auto' };
    } else if (openaiReq.tool_choice.type === 'function') {
      // Chat format: {type:"function", function:{name}}; Responses format: {type:"function", name}
      body.params.tool_choice = { type: 'tool', name: openaiReq.tool_choice.function?.name || openaiReq.tool_choice.name };
    } else {
      body.params.tool_choice = openaiReq.tool_choice;
    }
  }
  if (openaiReq.parallel_tool_calls !== undefined) body.params.parallel_tool_calls = openaiReq.parallel_tool_calls;

  return body;
}

// ── Anthropic → OpenAI → CC Translation ─────────────────────────────────────

function convertAnthropicToOpenai(anthropicReq) {
  let systemPrompt = '';
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') systemPrompt = anthropicReq.system;
    else if (Array.isArray(anthropicReq.system)) {
      systemPrompt = anthropicReq.system.filter(b => b.type === 'text').map(b => b.text).join('\n');
    }
  }

  const toolNameFromId = {};
  const openaiMessages = [];
  if (systemPrompt) openaiMessages.push({ role: 'system', content: systemPrompt });

  for (const msg of (anthropicReq.messages || [])) {
    if (msg.role === 'assistant') {
      let textContent = '';
      const toolCalls = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
      for (const block of blocks) {
        if (block.type === 'text') textContent += block.text || '';
        if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name;
          toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
        }
      }
      const m = { role: 'assistant', content: textContent || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      openaiMessages.push(m);
    } else if (msg.role === 'user') {
      let textContent = '';
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
      for (const block of blocks) {
        if (block.type === 'text') textContent += block.text || '';
        if (block.type === 'tool_result') {
          const toolUseId = block.tool_use_id || '';
          const content = Array.isArray(block.content) ? block.content.filter(c => c.type === 'text').map(c => c.text).join('') : String(block.content || '');
          openaiMessages.push({ role: 'tool', tool_call_id: toolUseId, name: toolNameFromId[toolUseId] || '', content });
        }
      }
      if (textContent) openaiMessages.push({ role: 'user', content: textContent });
    }
  }

  const result = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: !!anthropicReq.stream,
  };

  if (anthropicReq.tools?.length) {
    result.tools = anthropicReq.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema || { type: 'object', properties: {} } },
    }));
  }
  if (anthropicReq.tool_choice) {
    const t = anthropicReq.tool_choice.type || 'auto';
    if (t === 'any') result.tool_choice = 'required';
    else if (t === 'tool') result.tool_choice = { type: 'function', function: { name: anthropicReq.tool_choice.name } };
    else result.tool_choice = t;
  }
  if (anthropicReq.temperature !== undefined) result.temperature = anthropicReq.temperature;
  if (anthropicReq.thinking) {
    const th = anthropicReq.thinking;
    if (th.type === 'adaptive') result.reasoning_effort = th.effort || 'medium';
    else if (th.budget_tokens >= 10000) result.reasoning_effort = 'high';
    else if (th.budget_tokens >= 5000) result.reasoning_effort = 'medium';
    else result.reasoning_effort = 'low';
  }

  return result;
}

// ── Responses → CC Translation ──────────────────────────────────────────────

function convertResponsesToOpenai(responsesReq) {
  const messages = [];

  if (responsesReq.instructions) messages.push({ role: 'system', content: responsesReq.instructions });

  const input = responsesReq.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      // OpenAI Responses spec: message items may omit "type" (EasyInputMessage)
      // and content may be a plain string instead of an array
      const itemType = item.type || (item.role ? 'message' : null);
      if (itemType === 'message') {
        const contentStr = typeof item.content === 'string' ? item.content
          : (item.content || []).filter(c => c.type === 'input_text' || c.type === 'output_text').map(c => c.text).join('');
        if (item.role === 'system' || item.role === 'developer') {
          if (contentStr) messages.push({ role: 'system', content: contentStr });
        } else if (item.role === 'user') {
          if (contentStr) messages.push({ role: 'user', content: contentStr });
        } else if (item.role === 'assistant') {
          const toolCalls = Array.isArray(item.content)
            ? item.content.filter(c => c.type === 'function_call').map(c => ({
                id: c.call_id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' },
              }))
            : [];
          const m = { role: 'assistant', content: contentStr || null };
          if (toolCalls.length) m.tool_calls = toolCalls;
          if (contentStr || toolCalls.length) messages.push(m);
        }
      } else if (item.type === 'function_call') {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }] });
      } else if (item.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: String(item.output || '') });
      }
      // Other item types (reasoning, etc.) are conversation history artifacts — skip
    }
  }

  const result = {
    model: responsesReq.model || 'deepseek/deepseek-v4-flash',
    messages,
    max_tokens: responsesReq.max_output_tokens || 64000,
    stream: responsesReq.stream !== false,
    temperature: responsesReq.temperature,
    tools: responsesReq.tools,
    tool_choice: responsesReq.tool_choice,
  };
  // Responses API carries reasoning config as {reasoning: {effort: "..."}} (Codex sends this)
  if (responsesReq.reasoning?.effort) result.reasoning_effort = responsesReq.reasoning.effort;

  return result;
}

// ── Forward to CC API ───────────────────────────────────────────────────────

// Smart routing: domestic models go direct, foreign models go through proxy
const DOMESTIC_PREFIXES = ['minimax/', 'deepseek/', 'qwen/', 'glm/', 'yi/', 'baichuan/', 'moonshot/', 'doubao/', 'spark/', 'ernie/'];

function useDirectRoute(model) {
  if (!CFG.proxy?.enabled) return true; // no proxy configured → always direct
  return DOMESTIC_PREFIXES.some(p => model.toLowerCase().startsWith(p));
}

async function forwardToCC(body, apiKey, signal) {
  const model = body.params?.model || '';
  const useProxy = !useDirectRoute(model);

  if (model) {
    log('debug', `Route: ${model} → ${useProxy ? 'proxy' : 'direct'}`);
  }

  const MAX_CC_RETRIES = 3;
  const RETRY_DELAY = 500;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_CC_RETRIES; attempt++) {
    if (attempt > 0) {
      log('info', `CC reconnect ${attempt}/${MAX_CC_RETRIES} (${useProxy ? 'proxy' : 'direct'})`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
    try {
      let res;
      if (useProxy) {
        res = await forwardToCCViaProxy(body, apiKey, signal);
      } else {
        const sessionId = getSessionId(apiKey);
        await ensureInitialized(apiKey);
        res = await fetchWithTimeout(`${CFG.api_base}/alpha/generate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'x-cli-environment': 'production',
            'x-command-code-version': CC_VERSION,
            'x-session-id': sessionId,
            'x-co-flag': 'false',
            'x-taste-learning': 'false',
            'x-project-slug': fakeProjectSlug(sessionId),
            'traceparent': generateTraceparent(),
          },
          body: JSON.stringify(body),
        }, 120000);
      }
      return res;
    } catch (e) {
      lastErr = e;
      const retryable = e.message?.includes('Connection closed') ||
                         e.message?.includes('SOCKS5') ||
                         e.message?.includes('timeout') ||
                         e.message?.includes('ECONNRESET') ||
                         e.message?.includes('socket hang up');
      if (!retryable || attempt >= MAX_CC_RETRIES) throw e;
      log('warn', `CC connection error (retryable): ${e.message}`);
    }
  }
  throw lastErr;
}

// ── SSE Response Helpers ────────────────────────────────────────────────────

// Read with timeout — if CC API stalls, we don't hang forever
function readWithTimeout(reader, timeoutMs = 60000) {
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Stream read timeout')), timeoutMs)),
  ]);
}

// Read a full CC NDJSON stream and collect text / reasoning / tool calls / usage.
// Shared by the non-streaming paths of all three API formats (streaming paths use
// the SSE translators instead). Same dual stream/reasoning timeout as streaming.
async function collectCcStream(reader) {
  const decoder = new TextDecoder();
  let buffer = '', text = '', reasoning = '';
  let inputTokens = 0, outputTokens = 0, finishReason = 'stop';
  let inReasoning = false, timedOut = false;
  const toolCalls = [];
  const toolById = new Map();
  const seenUnknown = new Set(); // log each unknown event type once per request
  let cur = null; // tool call being accumulated from tool-input-* events

  const addTool = (id, name, args) => {
    if (id && toolById.has(id)) return; // complete tool-call after incremental events
    if (id) toolById.set(id, true);
    toolCalls.push({ id: id || `call_${randomUUID().slice(0, 8)}`, name: name || '', arguments: args || '' });
  };

  try {
    while (true) {
      const timeoutMs = inReasoning ? (CFG.reasoning_timeout_ms || 300000) : (CFG.stream_timeout_ms || 120000);
      const { done, value } = await readWithTimeout(reader, timeoutMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        switch (ev.type || '') {
          case 'text-delta': text += ev.text || ''; break;
          case 'reasoning-delta': reasoning += ev.text || ''; break;
          case 'reasoning-start': inReasoning = true; break;
          case 'reasoning-end': inReasoning = false; break;
          case 'tool-input-start':
            cur = { id: ev.id || '', name: ev.toolName || '', args: '' };
            break;
          case 'tool-input-delta':
            if (cur) cur.args += ev.delta || '';
            break;
          case 'tool-input-end':
            if (cur) { addTool(cur.id, cur.name, cur.args); cur = null; }
            break;
          case 'tool-call': {
            const id = ev.toolCallId || ev.id || '';
            if (cur && id && cur.id === id) { addTool(id, cur.name || ev.toolName || '', cur.args); cur = null; break; }
            addTool(id, ev.toolName || '', typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input || {}));
            break;
          }
          case 'finish-step': {
            inReasoning = false;
            const u = ev.usage || {};
            inputTokens = u.inputTokens || 0; outputTokens = u.outputTokens || 0;
            break;
          }
          case 'finish':
            finishReason = ev.finishReason === 'length' ? 'length'
              : (ev.finishReason === 'tool-calls' || ev.finishReason === 'tool_calls') ? 'tool_calls' : 'stop';
            break;
          case 'error':
            text += '[ERROR: ' + (ev.error?.message || 'CC API error') + ']';
            log('warn', `Upstream stream error event: ${ev.error?.message || 'CC API error'}`);
            break;
          case 'tool-error':
            log('warn', `Upstream tool error event: ${ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 150)}`);
            break;
          // Known signal events — no data to collect, nothing to report
          case 'start': case 'start-step': case 'text-start': case 'text-end':
          case 'text-start-step': case 'provider-metadata':
            break;
          default: {
            const t = ev.type || '(no type)';
            if (!seenUnknown.has(t)) { seenUnknown.add(t); log('warn', `Unknown CC event type: ${t} (data: ${line.slice(0, 150)})`); }
            break;
          }
        }
      }
    }
    if (cur) addTool(cur.id, cur.name, cur.args);
  } catch (e) {
    if (e.message === 'Stream read timeout') {
      const timeoutS = Math.round((inReasoning ? (CFG.reasoning_timeout_ms || 300000) : (CFG.stream_timeout_ms || 120000)) / 1000);
      log('warn', `Stream timeout during non-stream collect (${timeoutS}s no data${inReasoning ? ', reasoning phase' : ''})`);
      timedOut = true;
      reader.cancel().catch(() => {});
    } else throw e;
  }
  if (timedOut) text += `[ERROR: Upstream timeout — no response for ${Math.round((inReasoning ? (CFG.reasoning_timeout_ms || 300000) : (CFG.stream_timeout_ms || 120000)) / 1000)}s]`;
  return { text, reasoning, toolCalls, inputTokens, outputTokens, finishReason };
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function jsonRes(res, status, body, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sseData(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── NDJSON → OpenAI SSE Translation ────────────────────────────────────────

function createOpenAiTranslator(completionId, model) {
  let inputTokens = 0, outputTokens = 0, cachedTokens = 0, roleSent = false;
  let toolCallIndex = 0, currentToolId = '', currentToolName = '', currentToolArgs = '';
  const emittedToolIds = new Set();
  const seenUnknown = new Set(); // log each unknown event type once per request

  const base = () => ({ id: completionId, object: 'chat.completion.chunk', created: nowUnix(), model });

  // Emit a tool call chunk. Handles both the incremental (tool-input-*) flow and
  // the complete (tool-call) event; dedups by toolCallId so a model that emits
  // both never produces duplicate calls.
  function emitToolCall(chunks, id, name, args) {
    if (id && emittedToolIds.has(id)) return;
    if (id) emittedToolIds.add(id);
    const idx = toolCallIndex++;
    chunks.push({ ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id, type: 'function', function: { name: name || '', arguments: args || '' } }] }, finish_reason: null }] });
  }

  return function translate(ndjsonLines) {
    const chunks = [];
    for (const line of ndjsonLines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const type = ev.type || '';
      if (type === 'start') {
        if (!roleSent) { chunks.push({ ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }); roleSent = true; }
      } else if (type === 'start-step' || type === 'reasoning-start' || type === 'text-start') {}
      else if (type === 'text-delta') {
        const text = ev.text || '';
        if (text) chunks.push({ ...base(), choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      } else if (type === 'reasoning-delta') {
        // Reasoning goes to delta.reasoning_content (DeepSeek-style), never into
        // content — clients show it as thinking instead of polluting the answer.
        const text = ev.text || '';
        if (text) chunks.push({ ...base(), choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] });
      } else if (type === 'text-end' || type === 'reasoning-end' || type === 'provider-metadata') {}
      else if (type === 'tool-error') {
        log('warn', `Upstream tool error event: ${ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 150)}`);
      }
      // Tool call events from CC API
      else if (type === 'tool-input-start') {
        currentToolId = ev.id || '';
        currentToolName = ev.toolName || '';
        currentToolArgs = '';
      } else if (type === 'tool-input-delta') {
        currentToolArgs += (ev.delta || '');
      } else if (type === 'tool-input-end') {
        emitToolCall(chunks, currentToolId, currentToolName, currentToolArgs);
        currentToolId = ''; currentToolName = ''; currentToolArgs = '';
      } else if (type === 'tool-call') {
        // Fallback: some models emit a complete tool-call without incremental events
        emitToolCall(chunks, ev.toolCallId || ev.id || '', ev.toolName || '',
          typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input || {}));
      } else if (type === 'finish-step') {
        const u = ev.usage || {};
        inputTokens = u.inputTokens || 0;
        outputTokens = u.outputTokens || 0;
        cachedTokens = u.inputTokenDetails?.cacheReadTokens || 0;
      } else if (type === 'error') {
        const msg = ev.error?.message || 'CC API error';
        log('warn', `Upstream stream error event: ${msg}`);
        chunks.push({ ...base(), choices: [{ index: 0, delta: { content: '[ERROR: ' + msg + ']' }, finish_reason: 'stop' }] });
      } else if (type === 'finish') {
        const fr = ev.finishReason === 'length' ? 'length' : ev.finishReason === 'tool-calls' ? 'tool_calls' : 'stop';
        chunks.push({ ...base(), choices: [{ index: 0, delta: {}, finish_reason: fr }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, prompt_tokens_details: { cached_tokens: cachedTokens } } });
        recordTokens(model, inputTokens, outputTokens);
      } else {
        // Unknown upstream event type — protocol may have drifted; log once per type
        if (!seenUnknown.has(type)) { seenUnknown.add(type); log('warn', `Unknown CC event type: ${type} (data: ${line.slice(0, 150)})`); }
      }
    }
    return chunks;
  };
}

// ── NDJSON → Anthropic SSE Translation ─────────────────────────────────────

function createAnthropicTranslator(messageId, model) {
  let inputTokens = 0, outputTokens = 0;
  let started = false;
  let blockIndex = -1;
  let blockType = null;          // 'text' | 'thinking' | 'tool' — currently open block
  let currentThinkingText = '';
  let currentToolId = '', currentToolName = '', currentToolArgs = '';
  const emittedToolIds = new Set();
  const seenUnknown = new Set(); // log each unknown event type once per request
  let stopReason = 'end_turn';

  // Close the open block (if any). Thinking blocks get a signature_delta before
  // stop so Claude Code accepts and displays them.
  function closeBlock() {
    const events = [];
    if (!blockType) return events;
    if (blockType === 'thinking') {
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: blockIndex, delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) } } });
      currentThinkingText = '';
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex } });
    blockType = null;
    return events;
  }

  // Open a new block, closing any previous one first (lazy close keeps indices stable)
  function openBlock(type, contentBlock) {
    const events = closeBlock();
    blockIndex++;
    blockType = type;
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: blockIndex, content_block: contentBlock } });
    return events;
  }

  function translate(ndjsonLines) {
    const events = [];
    for (const line of ndjsonLines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const type = ev.type || '';

      if (type === 'start' && !started) {
        started = true;
        events.push({ event: 'message_start', data: {
          type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
        }});
      } else if (type === 'reasoning-delta') {
        // CC reasoning → Anthropic thinking block (Claude Code shows this as thinking,
        // never mixed into the answer text)
        const text = ev.text || '';
        if (!text) continue;
        if (blockType !== 'thinking') events.push(...openBlock('thinking', { type: 'thinking', thinking: '' }));
        currentThinkingText += text;
        events.push({ event: 'content_block_delta', data: {
          type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: text }
        }});
      } else if (type === 'text-delta') {
        const text = ev.text || '';
        if (!text) continue;
        if (blockType !== 'text') events.push(...openBlock('text', { type: 'text', text: '' }));
        events.push({ event: 'content_block_delta', data: {
          type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text }
        }});
      } else if (type === 'tool-input-start') {
        currentToolId = ev.id || '';
        currentToolName = ev.toolName || '';
        currentToolArgs = '';
        if (currentToolId) emittedToolIds.add(currentToolId);
        events.push(...openBlock('tool', { type: 'tool_use', id: currentToolId, name: currentToolName, input: {} }));
      } else if (type === 'tool-input-delta') {
        const delta = ev.delta || '';
        currentToolArgs += delta;
        if (delta && blockType === 'tool') events.push({ event: 'content_block_delta', data: {
          type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: delta }
        }});
      } else if (type === 'tool-input-end') {
        // Args already streamed via input_json_delta; close the tool block
        events.push(...closeBlock());
      } else if (type === 'tool-call') {
        // Fallback: some models emit a complete tool-call without incremental events
        const id = ev.toolCallId || ev.id || '';
        if (id && emittedToolIds.has(id)) continue;
        if (id) emittedToolIds.add(id);
        const input = typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input || {});
        events.push(...openBlock('tool', { type: 'tool_use', id, name: ev.toolName || '', input: {} }));
        if (input) events.push({ event: 'content_block_delta', data: {
          type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: input }
        }});
        events.push(...closeBlock());
      } else if (type === 'finish-step') {
        const u = ev.usage || {};
        inputTokens = u.inputTokens || 0;
        outputTokens = u.outputTokens || 0;
      } else if (type === 'finish') {
        stopReason = ev.finishReason === 'tool-calls' || ev.finishReason === 'tool_calls' ? 'tool_use'
                   : ev.finishReason === 'length' ? 'max_tokens' : 'end_turn';
      } else if (type === 'error') {
        const msg = ev.error?.message || 'CC API error';
        log('warn', `Upstream stream error event: ${msg}`);
        events.push(...closeBlock());
        events.push({ event: 'error', data: { type: 'error', error: { type: 'internal_error', message: msg } } });
      } else if (type === 'tool-error') {
        log('warn', `Upstream tool error event: ${ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 150)}`);
      } else if (type === 'start-step' || type === 'text-start' || type === 'reasoning-start' || type === 'text-end' || type === 'reasoning-end' || type === 'provider-metadata') {
        // Known signal events — no user-visible data
      } else {
        // Unknown upstream event type — protocol may have drifted; log once per type
        if (!seenUnknown.has(type)) { seenUnknown.add(type); log('warn', `Unknown CC event type: ${type} (data: ${line.slice(0, 150)})`); }
      }
    }
    return events;
  }

  function finalize() {
    recordTokens(model, inputTokens, outputTokens);
    const events = closeBlock();
    events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return events;
  }

  return { translate, finalize };
}

// ── NDJSON → Responses SSE Translation ──────────────────────────────────────
// Emits the standard OpenAI Responses streaming sequence:
//   response.created → response.output_item.added → (response.output_text.delta |
//   response.reasoning_summary_text.delta | response.function_call_arguments.delta)
//   → response.output_item.done → response.completed

function createResponsesTranslator(responseId, model) {
  let started = false;
  let inputTokens = 0, outputTokens = 0, cachedTokens = 0;
  const outputItems = [];        // completed items, assembled into response.completed
  let outputIndex = -1;
  let openKind = null;           // 'reasoning' | 'text' | 'tool'
  let openItemId = null;
  let textContent = '', reasoningText = '';
  let currentToolId = '', currentToolName = '', currentToolArgs = '';
  const emittedToolIds = new Set();
  const seenUnknown = new Set(); // log each unknown event type once per request

  function responseObj(status) {
    return { id: responseId, object: 'response', created_at: nowUnix(), model, status, output: status === 'completed' ? outputItems : [] };
  }

  function closeOpenItem(events) {
    if (!openKind) return;
    if (openKind === 'reasoning') {
      events.push({ event: 'response.reasoning_summary_text.done', data: { type: 'response.reasoning_summary_text.done', item_id: openItemId, output_index: outputIndex, summary_index: 0, text: reasoningText } });
      events.push({ event: 'response.reasoning_summary_part.done', data: { type: 'response.reasoning_summary_part.done', item_id: openItemId, output_index: outputIndex, summary_index: 0, part: { type: 'summary', text: reasoningText } } });
      const item = { id: openItemId, type: 'reasoning', summary: [{ type: 'summary', text: reasoningText }] };
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: outputIndex, item: { ...item, status: 'completed' } } });
      outputItems.push(item);
      reasoningText = '';
    } else if (openKind === 'text') {
      events.push({ event: 'response.output_text.done', data: { type: 'response.output_text.done', item_id: openItemId, output_index: outputIndex, content_index: 0, text: textContent } });
      events.push({ event: 'response.content_part.done', data: { type: 'response.content_part.done', item_id: openItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: textContent, annotations: [] } } });
      const item = { id: openItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: textContent, annotations: [] }] };
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: outputIndex, item } });
      outputItems.push(item);
      textContent = '';
    } else if (openKind === 'tool') {
      events.push({ event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', item_id: openItemId, output_index: outputIndex, arguments: currentToolArgs } });
      const item = { id: openItemId, type: 'function_call', status: 'completed', call_id: currentToolId, name: currentToolName, arguments: currentToolArgs };
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: outputIndex, item } });
      outputItems.push(item);
      currentToolArgs = '';
    }
    openKind = null; openItemId = null;
  }

  function openItem(events, kind, item) {
    closeOpenItem(events);
    outputIndex++;
    openKind = kind; openItemId = item.id;
    events.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, status: 'in_progress' } } });
  }

  function translate(ndjsonLines) {
    const events = [];
    for (const line of ndjsonLines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const type = ev.type || '';
      if (type === 'start' && !started) {
        started = true;
        events.push({ event: 'response.created', data: { type: 'response.created', response: responseObj('in_progress') } });
        events.push({ event: 'response.in_progress', data: { type: 'response.in_progress', response: responseObj('in_progress') } });
      } else if (type === 'reasoning-delta') {
        const text = ev.text || '';
        if (!text) continue;
        if (openKind !== 'reasoning') {
          openItem(events, 'reasoning', { id: `rs_${randomUUID().slice(0, 12)}`, type: 'reasoning', summary: [] });
          events.push({ event: 'response.reasoning_summary_part.added', data: { type: 'response.reasoning_summary_part.added', item_id: openItemId, output_index: outputIndex, summary_index: 0, part: { type: 'summary', text: '' } } });
        }
        reasoningText += text;
        events.push({ event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', item_id: openItemId, output_index: outputIndex, summary_index: 0, delta: text } });
      } else if (type === 'text-delta') {
        const text = ev.text || '';
        if (!text) continue;
        if (openKind !== 'text') {
          openItem(events, 'text', { id: `msg_${randomUUID().slice(0, 12)}`, type: 'message', role: 'assistant', content: [] });
          events.push({ event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: openItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } } });
        }
        textContent += text;
        events.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: openItemId, output_index: outputIndex, content_index: 0, delta: text } });
      } else if (type === 'tool-input-start') {
        currentToolId = ev.id || '';
        currentToolName = ev.toolName || '';
        currentToolArgs = '';
        if (currentToolId) emittedToolIds.add(currentToolId);
        openItem(events, 'tool', { id: `fc_${randomUUID().slice(0, 12)}`, type: 'function_call', call_id: currentToolId, name: currentToolName, arguments: '' });
      } else if (type === 'tool-input-delta') {
        const delta = ev.delta || '';
        currentToolArgs += delta;
        if (delta && openKind === 'tool') events.push({ event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: openItemId, output_index: outputIndex, delta } });
      } else if (type === 'tool-input-end') {
        closeOpenItem(events);
      } else if (type === 'tool-call') {
        // Fallback: some models emit a complete tool-call without incremental events
        const id = ev.toolCallId || ev.id || '';
        if (id && emittedToolIds.has(id)) continue;
        if (id) emittedToolIds.add(id);
        const args = typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input || {});
        openItem(events, 'tool', { id: `fc_${randomUUID().slice(0, 12)}`, type: 'function_call', call_id: id, name: ev.toolName || '', arguments: '' });
        currentToolArgs = args;
        if (args) events.push({ event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: openItemId, output_index: outputIndex, delta: args } });
        closeOpenItem(events);
      } else if (type === 'finish-step') {
        const u = ev.usage || {};
        inputTokens = u.inputTokens || 0; outputTokens = u.outputTokens || 0;
        cachedTokens = u.inputTokenDetails?.cacheReadTokens || 0;
      } else if (type === 'finish') {
        // Stream end signal; response.completed is emitted by finalize()
      } else if (type === 'error') {
        const msg = ev.error?.message || 'CC API error';
        log('warn', `Upstream stream error event: ${msg}`);
        // Surface as output text so the client sees the failure, stream still completes
        if (openKind !== 'text') {
          openItem(events, 'text', { id: `msg_${randomUUID().slice(0, 12)}`, type: 'message', role: 'assistant', content: [] });
          events.push({ event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: openItemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } } });
        }
        textContent += '[ERROR: ' + msg + ']';
        events.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: openItemId, output_index: outputIndex, content_index: 0, delta: '[ERROR: ' + msg + ']' } });
      } else if (type === 'tool-error') {
        log('warn', `Upstream tool error event: ${ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 150)}`);
      } else if (type === 'start-step' || type === 'text-start' || type === 'reasoning-start' || type === 'text-end' || type === 'reasoning-end' || type === 'provider-metadata') {
        // Known signal events — no user-visible data
      } else {
        // Unknown upstream event type — protocol may have drifted; log once per type
        if (!seenUnknown.has(type)) { seenUnknown.add(type); log('warn', `Unknown CC event type: ${type} (data: ${line.slice(0, 150)})`); }
      }
    }
    return events;
  }

  function finalize() {
    const events = [];
    closeOpenItem(events);
    recordTokens(model, inputTokens, outputTokens);
    events.push({ event: 'response.completed', data: {
      type: 'response.completed',
      response: { ...responseObj('completed'), usage: {
        input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
        input_tokens_details: { cached_tokens: cachedTokens }, output_tokens_details: { reasoning_tokens: 0 },
      } },
    } });
    return events;
  }
  return { translate, finalize };
}

// ── Request Handlers ────────────────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let openaiReq;
  try { openaiReq = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }); }

  const clientKey = getApiKey(req.headers);
  if (!clientKey && !keyPool.keys.length) return jsonRes(res, 401, { error: { message: 'Missing API key', type: 'auth_error' } });
  const keySelector = createKeySelector(clientKey);
  const tried403 = new Set();

  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  let completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const ccBody = buildCcRequest(openaiReq);
  const client = detectClient(req, openaiReq);
  log('info', `Request: ${model} /v1/chat/completions [${client}]`);
  log('debug', `Request body`, { client, model, stream: openaiReq.stream, tools: openaiReq.tools?.length || 0, temperature: openaiReq.temperature, max_tokens: openaiReq.max_tokens });

  try {
    // 503 retry: keep trying for 120 seconds, retry on ANY upstream error
    const RETRY_DEADLINE = Date.now() + 120000; // 120 seconds
    let lastError = null;
    let attempt = 0;

    while (true) {
      if (attempt > 0) {
        log('info', `Retry ${attempt} for ${model} (${Math.round((RETRY_DEADLINE - Date.now()) / 1000)}s left)`);
        completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
      }
      attempt++;

      const apiKey = keySelector.next();
      if (!apiKey) return jsonRes(res, 401, { error: { message: 'All API keys in pool are disabled (auth failed). Check --list-keys / logs.', type: 'auth_error' } });

      let ccRes;
      try {
        ccRes = await forwardToCC(ccBody, apiKey);
      } catch (connErr) {
        // Connection-level failure (SOCKS5/TLS/timeout) rides the same 120s window,
        // failing over to the next pool key each attempt
        if (Date.now() >= RETRY_DEADLINE) {
          log('error', `Connection failed after retry window for ${model}: ${connErr.message}`);
          return jsonRes(res, 503, { error: { message: `Service unavailable after ${attempt} retries (120s): ${connErr.message}`, type: 'proxy_error' } });
        }
        log('warn', `Connection error on ${model} (/v1/chat/completions), retrying: ${connErr.message}`);
        continue;
      }
      if (!ccRes.ok) {
        const errText = await ccRes.text().catch(() => '');
        const { message, code } = parseUpstreamError(errText, ccRes.status);
        log('error', `CC error: ${ccRes.status} ${model} ${code || ''} ${message.slice(0, 300)}`);
        if (ccRes.status === 401) {
          // Dead key — remove it from the pool and fail over transparently
          if (keySelector.passthrough) return jsonRes(res, 401, { error: { message, type: 'auth_error', ...(code ? { code } : {}) } });
          poolDisable(apiKey);
          lastError = `[ERROR: ${message}]`;
          continue;
        }
        if (ccRes.status === 403) {
          // Plan errors (MODEL_NOT_IN_PLAN etc.) are key-specific — try the other
          // keys once before giving up; another key's plan may include the model
          tried403.add(apiKey);
          if (tried403.size >= (keySelector.passthrough ? 1 : poolActiveCount())) {
            return jsonRes(res, ccRes.status, { error: { message, type: 'proxy_error', ...(code ? { code } : {}) } });
          }
          log('warn', `403 on key ${apiKey.slice(0, 8)}… for ${model}, failing over to next key`);
          continue;
        }
        // Permanent status errors (400/404/422/...) — return immediately
        if (isPermanentHttpStatus(ccRes.status)) {
          return jsonRes(res, ccRes.status, { error: { message, type: 'proxy_error', ...(code ? { code } : {}) } });
        }
        // Transient upstream error (429 / 5xx) → failover + retry within the deadline
        if (ccRes.status === 429) poolCooldown(apiKey);
        lastError = `[ERROR: ${message}]`;
        if (Date.now() >= RETRY_DEADLINE) {
          return jsonRes(res, 503, { error: { message: `Service unavailable after ${attempt} retries (120s): ${message.slice(0, 300)}`, type: 'proxy_error', ...(code ? { code } : {}) } });
        }
        continue;
      }
      poolMarkSuccess(apiKey);

      const reader = ccRes.body.getReader();
      const decoder = new TextDecoder();

      // Non-streaming: collect the whole stream, then respond with JSON
      if (openaiReq.stream === false) {
        const r = await collectCcStream(reader);
        if (r.text.startsWith('[ERROR:') && !r.toolCalls.length) {
          const errMsg = r.text.replace(/^\[ERROR: /, '').replace(/]$/, '');
          if (!isRetryableUpstreamError(errMsg)) {
            return jsonRes(res, 400, { error: { message: errMsg, type: 'invalid_request_error' } });
          }
          lastError = r.text;
          log('warn', `Transient error on ${model} (non-stream), retrying: ${r.text.slice(0, 100)}`);
          if (Date.now() >= RETRY_DEADLINE) {
            return jsonRes(res, 503, { error: { message: `Service unavailable after ${attempt} retries (120s): ${errMsg.slice(0, 300)}`, type: 'proxy_error' } });
          }
          continue;
        }
        const message = { role: 'assistant', content: r.text };
        if (r.reasoning) message.reasoning_content = r.reasoning;
        if (r.toolCalls.length) message.tool_calls = r.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));
        return jsonRes(res, 200, {
          id: completionId, object: 'chat.completion', created: nowUnix(), model,
          choices: [{ index: 0, message, finish_reason: r.toolCalls.length ? 'tool_calls' : r.finishReason }],
          usage: { prompt_tokens: r.inputTokens, completion_tokens: r.outputTokens, total_tokens: r.inputTokens + r.outputTokens },
        });
      }

      // Phase 1: Buffer initial events (before headers) to detect transient errors
      const translate = createOpenAiTranslator(completionId, model);
      let buffer = '';
      let preHeadersChunks = [];
      let earlyError = null;
      let permanentError = null;

      // Read until we see content or error, then decide
      const MAX_PRE_BUFFER = 20; // max events to buffer before committing
      for (let i = 0; i < MAX_PRE_BUFFER; i++) {
        const { done, value } = await readWithTimeout(reader);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        const chunks = translate(lines);
        for (const chunk of chunks) {
          const delta = chunk.choices?.[0]?.delta?.content || '';
          const fr = chunk.choices?.[0]?.finish_reason;
          if (delta.startsWith('[ERROR:')) {
            if (isRetryableUpstreamError(delta)) earlyError = delta;
            else permanentError = delta.replace(/^\[ERROR: /, '').replace(/]$/, '');
          }
          preHeadersChunks.push(chunk);
          // If we got actual content or finish, stop buffering and commit
          if ((delta && !delta.startsWith('[ERROR:')) || fr) break;
        }
        if (permanentError || earlyError || (preHeadersChunks.some(c => c.choices?.[0]?.delta?.content && !c.choices[0].delta.content.startsWith('[ERROR:')))) break;
      }

      // Permanent in-stream validation error — return immediately, no retry
      if (permanentError) {
        log('warn', `Permanent upstream error on ${model}: ${permanentError.slice(0, 100)}`);
        reader.cancel().catch(() => {});
        return jsonRes(res, 400, { error: { message: permanentError, type: 'invalid_request_error' } });
      }

      // Transient error before any real content → retry
      if (earlyError) {
        log('warn', `Transient error on ${model}, retrying: ${earlyError.slice(0, 100)}`);
        lastError = earlyError;
        reader.cancel().catch(() => {});
        // Check if we've exceeded the 120s deadline
        if (Date.now() >= RETRY_DEADLINE) {
          log('error', `Retry deadline reached for ${model} after ${attempt} attempts`);
          return jsonRes(res, 503, { error: { message: `Service unavailable after ${attempt} retries (120s): ${earlyError.replace('[ERROR: ', '').replace(']', '')}`, type: 'proxy_error' } });
        }
        continue;
      }

      // Non-retryable error or success → break out of retry loop

      // Phase 2: Commit — send headers + pre-buffered chunks, then stream the rest
      sseHeaders(res);
      for (const chunk of preHeadersChunks) sseData(res, chunk);
      let finishSent = preHeadersChunks.some(c => c.choices?.[0]?.finish_reason);

      let streamTimedOut = false;
      let inReasoning = false;
      try {
        while (true) {
          const timeoutMs = inReasoning ? (CFG.reasoning_timeout_ms || 300000) : (CFG.stream_timeout_ms || 120000);
          const { done, value } = await readWithTimeout(reader, timeoutMs);
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const ln of lines) {
            if (ln.includes('"reasoning-start"')) inReasoning = true;
            else if (ln.includes('"finish-step"') || ln.includes('"reasoning-end"')) inReasoning = false;
          }
          const chunks = translate(lines);
          for (const chunk of chunks) {
            if (chunk.choices?.[0]?.finish_reason) finishSent = true;
            sseData(res, chunk);
          }
        }
      } catch (e) {
        if (e.message === 'Stream read timeout') {
          const timeoutMs = inReasoning ? (CFG.reasoning_timeout_ms || 300000) : (CFG.stream_timeout_ms || 120000);
          const timeoutS = Math.round(timeoutMs / 1000);
          log('warn', `Stream timeout on ${model} (${timeoutS}s no data${inReasoning ? ', reasoning phase' : ''})`);
          streamTimedOut = true;
          reader.cancel().catch(() => {});
        } else throw e;
      }
      if (buffer.trim()) {
        const chunks = translate([buffer]);
        for (const chunk of chunks) {
          if (chunk.choices?.[0]?.finish_reason) finishSent = true;
          sseData(res, chunk);
        }
      }

      if (streamTimedOut) {
        const timeoutS = Math.round((inReasoning ? (CFG.reasoning_timeout_ms || 300000) : (CFG.stream_timeout_ms || 120000)) / 1000);
        res.write(`data: ${JSON.stringify({id: completionId, object: 'chat.completion.chunk', created: nowUnix(), model, choices: [{index: 0, delta: {content: `[ERROR: Upstream timeout — no response for ${timeoutS}s${inReasoning ? ' (reasoning phase)' : ''}]`}, finish_reason: 'stop'}]})}\n\n`);
        res.write('data: [DONE]\n\n');
      } else {
        // Upstream stream ended without a finish event (abnormal termination) —
        // synthesize one so client loops terminate cleanly
        if (!finishSent) {
          log('warn', `Upstream stream ended without finish event on ${model}, synthesizing stop`);
          res.write(`data: ${JSON.stringify({id: completionId, object: 'chat.completion.chunk', created: nowUnix(), model, choices: [{index: 0, delta: {}, finish_reason: 'stop'}]})}\n\n`);
        }
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }

    log('error', `Retry deadline reached for ${model}: ${lastError}`);
    if (!res.headersSent) jsonRes(res, 503, { error: { message: lastError || 'Service temporarily unavailable after retries', type: 'proxy_error' } });
  } catch (e) {
    logError(`Request error: ${e.message}`, e);
    if (!res.headersSent) jsonRes(res, 502, { error: { message: e.message, type: 'proxy_error' } });
    else res.end();
  }
}

async function handleMessages(req, res) {
  let anthropicReq;
  try { anthropicReq = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body' } } }); }

  const clientKey = getApiKey(req.headers);
  if (!clientKey && !keyPool.keys.length) return jsonRes(res, 401, { error: { type: 'error', error: { type: 'authentication_error', message: 'Missing API key' } } });
  const keySelector = createKeySelector(clientKey);
  const tried403 = new Set();

  const model = anthropicReq.model || 'deepseek/deepseek-v4-flash';
  const messageId = `msg_${randomUUID().slice(0, 12)}`;
  const openaiReq = convertAnthropicToOpenai(anthropicReq);
  const ccBody = buildCcRequest(openaiReq);
  const client = detectClient(req, anthropicReq);
  log('info', `Request: ${model} /v1/messages [${client}]`);

  try {
    const RETRY_DEADLINE = Date.now() + 120000; // 120s retry window for transient upstream errors
    let attempt = 0;

    while (true) {
      if (attempt > 0) log('info', `Retry ${attempt} for ${model} (/v1/messages, ${Math.round((RETRY_DEADLINE - Date.now()) / 1000)}s left)`);
      attempt++;

      const apiKey = keySelector.next();
      if (!apiKey) return jsonRes(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'All API keys in pool are disabled (auth failed). Check --list-keys / logs.' } });

      let ccRes;
      try {
        ccRes = await forwardToCC(ccBody, apiKey);
      } catch (connErr) {
        if (Date.now() >= RETRY_DEADLINE) {
          log('error', `Connection failed after retry window for ${model}: ${connErr.message}`);
          return jsonRes(res, 503, { type: 'error', error: { type: 'api_error', message: `Service unavailable after ${attempt} retries (120s): ${connErr.message}` } });
        }
        log('warn', `Connection error on ${model} (/v1/messages), retrying: ${connErr.message}`);
        continue;
      }
      if (!ccRes.ok) {
        const errText = await ccRes.text().catch(() => '');
        const { message, code } = parseUpstreamError(errText, ccRes.status);
        log('error', `CC error: ${ccRes.status} ${model} ${code || ''} ${message.slice(0, 300)}`);
        if (ccRes.status === 401) {
          if (keySelector.passthrough) return jsonRes(res, 401, { type: 'error', error: { type: 'authentication_error', message, ...(code ? { code } : {}) } });
          poolDisable(apiKey);
          continue;
        }
        if (ccRes.status === 403) {
          tried403.add(apiKey);
          if (tried403.size >= (keySelector.passthrough ? 1 : poolActiveCount())) {
            return jsonRes(res, ccRes.status, { type: 'error', error: { type: 'api_error', message, ...(code ? { code } : {}) } });
          }
          log('warn', `403 on key ${apiKey.slice(0, 8)}… for ${model}, failing over to next key`);
          continue;
        }
        // Permanent status errors (400/404/422/...) — return immediately
        if (isPermanentHttpStatus(ccRes.status)) {
          return jsonRes(res, ccRes.status, { type: 'error', error: { type: 'api_error', message, ...(code ? { code } : {}) } });
        }
        if (ccRes.status === 429) poolCooldown(apiKey);
        if (Date.now() >= RETRY_DEADLINE) {
          return jsonRes(res, 503, { type: 'error', error: { type: 'api_error', message: `Service unavailable after ${attempt} retries (120s): ${message.slice(0, 300)}`, ...(code ? { code } : {}) } });
        }
        continue;
      }
      poolMarkSuccess(apiKey);

      const reader = ccRes.body.getReader();
      const decoder = new TextDecoder();

      // Non-streaming: collect all and return JSON
      if (anthropicReq.stream === false) {
        const r = await collectCcStream(reader);
        if (r.text.startsWith('[ERROR:') && !r.toolCalls.length) {
          const errMsg = r.text.replace(/^\[ERROR: /, '').replace(/]$/, '');
          if (!isRetryableUpstreamError(errMsg)) {
            return jsonRes(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: errMsg } });
          }
          log('warn', `Transient error on ${model} (/v1/messages non-stream), retrying: ${r.text.slice(0, 100)}`);
          if (Date.now() >= RETRY_DEADLINE) {
            return jsonRes(res, 503, { type: 'error', error: { type: 'api_error', message: `Service unavailable after ${attempt} retries (120s): ${errMsg.slice(0, 300)}` } });
          }
          continue;
        }
        const content = [];
        if (r.reasoning) content.push({ type: 'thinking', thinking: r.reasoning, signature: fakeThinkingSignature(r.reasoning) });
        if (r.text || !r.toolCalls.length) content.push({ type: 'text', text: r.text });
        for (const tc of r.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: safeParseJson(tc.arguments) });
        return jsonRes(res, 200, {
          id: messageId, type: 'message', role: 'assistant', content,
          model, stop_reason: r.toolCalls.length ? 'tool_use' : (r.finishReason === 'length' ? 'max_tokens' : 'end_turn'), stop_sequence: null,
          usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
        });
      }

      // Streaming: pre-buffer initial events to detect transient in-stream errors
      const { translate, finalize } = createAnthropicTranslator(messageId, model);
      let buffer = '';
      const preEvents = [];
      let earlyError = null, hasContent = false, permanentError = null;
      const MAX_PRE_BUFFER = 20;
      for (let i = 0; i < MAX_PRE_BUFFER; i++) {
        const { done, value } = await readWithTimeout(reader);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        preEvents.push(...translate(lines));
        for (const ev of preEvents) {
          if (ev.event === 'error') {
            const msg = ev.data?.error?.message || 'CC API error';
            if (isRetryableUpstreamError(msg)) earlyError = msg;
            else permanentError = msg;
          }
          else if (ev.event === 'content_block_delta' && (ev.data?.delta?.type === 'text_delta' || ev.data?.delta?.type === 'thinking_delta')) hasContent = true;
        }
        if (permanentError || earlyError || hasContent) break;
      }

      // Permanent in-stream validation error — return immediately, no retry
      if (permanentError) {
        log('warn', `Permanent upstream error on ${model}: ${permanentError.slice(0, 100)}`);
        reader.cancel().catch(() => {});
        return jsonRes(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: permanentError } });
      }

      if (earlyError) {
        log('warn', `Transient error on ${model} (/v1/messages), retrying: ${earlyError.slice(0, 100)}`);
        reader.cancel().catch(() => {});
        if (Date.now() >= RETRY_DEADLINE) {
          return jsonRes(res, 503, { type: 'error', error: { type: 'api_error', message: `Service unavailable after ${attempt} retries (120s): ${earlyError}` } });
        }
        continue;
      }

      // Commit — send headers + pre-buffered events, then stream the rest
      sseHeaders(res);
      for (const ev of preEvents) sseWrite(res, ev.event, ev.data);
      let inReasoning = false;

      while (true) {
        const timeoutMs = inReasoning ? (CFG.reasoning_timeout_ms || 300000) : (CFG.stream_timeout_ms || 120000);
        const { done, value } = await readWithTimeout(reader, timeoutMs);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const ln of lines) {
          if (ln.includes('"reasoning-start"')) inReasoning = true;
          else if (ln.includes('"finish-step"') || ln.includes('"reasoning-end"')) inReasoning = false;
        }
        const events = translate(lines);
        for (const ev of events) sseWrite(res, ev.event, ev.data);
      }
      if (buffer.trim()) {
        const events = translate([buffer]);
        for (const ev of events) sseWrite(res, ev.event, ev.data);
      }
      for (const ev of finalize()) sseWrite(res, ev.event, ev.data);
      res.end();
      return;
    }
  } catch (e) {
    logError(`Request error: ${e.message}`, e);
    if (!res.headersSent) jsonRes(res, 502, { type: 'error', error: { type: 'api_error', message: e.message } });
    else {
      // On timeout after headers sent, send error event and close
      try {
        sseWrite(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sseWrite(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[ERROR: Upstream timeout — ${e.message}]` } });
        sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sseWrite(res, 'message_stop', { type: 'message_stop' });
      } catch {}
      res.end();
    }
  }
}

async function handleResponses(req, res) {
  let responsesReq;
  try { responsesReq = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }); }

  const clientKey = getApiKey(req.headers);
  if (!clientKey && !keyPool.keys.length) return jsonRes(res, 401, { error: { message: 'Missing API key', type: 'auth_error' } });
  const keySelector = createKeySelector(clientKey);
  const tried403 = new Set();

  const model = responsesReq.model || 'deepseek/deepseek-v4-flash';
  const responseId = `resp_${randomUUID().slice(0, 12)}`;
  const openaiReq = convertResponsesToOpenai(responsesReq);
  const ccBody = buildCcRequest(openaiReq);
  const client = detectClient(req, responsesReq);
  log('info', `Request: ${model} /v1/responses [${client}]`);

  try {
    const RETRY_DEADLINE = Date.now() + 120000; // 120s retry window for transient upstream errors
    let attempt = 0;

    while (true) {
      if (attempt > 0) log('info', `Retry ${attempt} for ${model} (/v1/responses, ${Math.round((RETRY_DEADLINE - Date.now()) / 1000)}s left)`);
      attempt++;

      const apiKey = keySelector.next();
      if (!apiKey) return jsonRes(res, 401, { error: { message: 'All API keys in pool are disabled (auth failed). Check --list-keys / logs.', type: 'auth_error' } });

      let ccRes;
      try {
        ccRes = await forwardToCC(ccBody, apiKey);
      } catch (connErr) {
        if (Date.now() >= RETRY_DEADLINE) {
          log('error', `Connection failed after retry window for ${model}: ${connErr.message}`);
          return jsonRes(res, 503, { error: { message: `Service unavailable after ${attempt} retries (120s): ${connErr.message}`, type: 'proxy_error' } });
        }
        log('warn', `Connection error on ${model} (/v1/responses), retrying: ${connErr.message}`);
        continue;
      }
      if (!ccRes.ok) {
        const errText = await ccRes.text().catch(() => '');
        const { message, code } = parseUpstreamError(errText, ccRes.status);
        log('error', `CC error: ${ccRes.status} ${model} ${code || ''} ${message.slice(0, 300)}`);
        if (ccRes.status === 401) {
          if (keySelector.passthrough) return jsonRes(res, 401, { error: { message, type: 'auth_error', ...(code ? { code } : {}) } });
          poolDisable(apiKey);
          continue;
        }
        if (ccRes.status === 403) {
          tried403.add(apiKey);
          if (tried403.size >= (keySelector.passthrough ? 1 : poolActiveCount())) {
            return jsonRes(res, ccRes.status, { error: { message, type: 'proxy_error', ...(code ? { code } : {}) } });
          }
          log('warn', `403 on key ${apiKey.slice(0, 8)}… for ${model}, failing over to next key`);
          continue;
        }
        // Permanent status errors (400/404/422/...) — return immediately
        if (isPermanentHttpStatus(ccRes.status)) {
          return jsonRes(res, ccRes.status, { error: { message, type: 'proxy_error', ...(code ? { code } : {}) } });
        }
        if (ccRes.status === 429) poolCooldown(apiKey);
        if (Date.now() >= RETRY_DEADLINE) {
          return jsonRes(res, 503, { error: { message: `Service unavailable after ${attempt} retries (120s): ${message.slice(0, 300)}`, type: 'proxy_error', ...(code ? { code } : {}) } });
        }
        continue;
      }
      poolMarkSuccess(apiKey);

      const reader = ccRes.body.getReader();
      const decoder = new TextDecoder();

      // Non-streaming: collect all and return JSON
      if (responsesReq.stream === false) {
        const r = await collectCcStream(reader);
        if (r.text.startsWith('[ERROR:') && !r.toolCalls.length) {
          const errMsg = r.text.replace(/^\[ERROR: /, '').replace(/]$/, '');
          if (!isRetryableUpstreamError(errMsg)) {
            return jsonRes(res, 400, { error: { message: errMsg, type: 'invalid_request_error' } });
          }
          log('warn', `Transient error on ${model} (/v1/responses non-stream), retrying: ${r.text.slice(0, 100)}`);
          if (Date.now() >= RETRY_DEADLINE) {
            return jsonRes(res, 503, { error: { message: `Service unavailable after ${attempt} retries (120s): ${errMsg.slice(0, 300)}`, type: 'proxy_error' } });
          }
          continue;
        }
        const output = [];
        if (r.reasoning) output.push({ id: `rs_${randomUUID().slice(0, 12)}`, type: 'reasoning', summary: [{ type: 'summary', text: r.reasoning }] });
        if (r.text || !r.toolCalls.length) output.push({ id: `msg_${randomUUID().slice(0, 12)}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: r.text, annotations: [] }] });
        for (const tc of r.toolCalls) output.push({ id: `fc_${randomUUID().slice(0, 12)}`, type: 'function_call', status: 'completed', call_id: tc.id, name: tc.name, arguments: tc.arguments });
        return jsonRes(res, 200, {
          id: responseId, object: 'response', created_at: nowUnix(), status: 'completed', model,
          output,
          usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens, total_tokens: r.inputTokens + r.outputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        });
      }

      // Streaming: pre-buffer initial events to detect transient in-stream errors
      const { translate, finalize } = createResponsesTranslator(responseId, model);
      let buffer = '';
      const preEvents = [];
      let earlyError = null, hasContent = false, permanentError = null;
      const MAX_PRE_BUFFER = 20;
      for (let i = 0; i < MAX_PRE_BUFFER; i++) {
        const { done, value } = await readWithTimeout(reader);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        preEvents.push(...translate(lines));
        for (const ev of preEvents) {
          const delta = ev.event === 'response.output_text.delta' ? String(ev.data?.delta || '') : null;
          if (delta?.startsWith('[ERROR:')) {
            const msg = delta.replace(/^\[ERROR: /, '').replace(/]$/, '');
            if (isRetryableUpstreamError(msg)) earlyError = msg;
            else permanentError = msg;
          }
          else if (ev.event === 'response.output_text.delta' || ev.event === 'response.reasoning_summary_text.delta') hasContent = true;
        }
        if (permanentError || earlyError || hasContent) break;
      }

      // Permanent in-stream validation error — return immediately, no retry
      if (permanentError) {
        log('warn', `Permanent upstream error on ${model}: ${permanentError.slice(0, 100)}`);
        reader.cancel().catch(() => {});
        return jsonRes(res, 400, { error: { message: permanentError, type: 'invalid_request_error' } });
      }

      if (earlyError) {
        log('warn', `Transient error on ${model} (/v1/responses), retrying: ${earlyError.slice(0, 100)}`);
        reader.cancel().catch(() => {});
        if (Date.now() >= RETRY_DEADLINE) {
          return jsonRes(res, 503, { error: { message: `Service unavailable after ${attempt} retries (120s): ${earlyError}`, type: 'proxy_error' } });
        }
        continue;
      }

      // Commit — send headers + pre-buffered events, then stream the rest
      sseHeaders(res);
      for (const ev of preEvents) sseWrite(res, ev.event, ev.data);
      let inReasoning = false;

      while (true) {
        const timeoutMs = inReasoning ? (CFG.reasoning_timeout_ms || 300000) : (CFG.stream_timeout_ms || 120000);
        const { done, value } = await readWithTimeout(reader, timeoutMs);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const ln of lines) {
          if (ln.includes('"reasoning-start"')) inReasoning = true;
          else if (ln.includes('"finish-step"') || ln.includes('"reasoning-end"')) inReasoning = false;
        }
        const events = translate(lines);
        for (const ev of events) sseWrite(res, ev.event, ev.data);
      }
      if (buffer.trim()) {
        const events = translate([buffer]);
        for (const ev of events) sseWrite(res, ev.event, ev.data);
      }
      for (const ev of finalize()) sseWrite(res, ev.event, ev.data);
      res.end();
      return;
    }
  } catch (e) {
    logError(`Request error: ${e.message}`, e);
    if (!res.headersSent) jsonRes(res, 502, { error: { message: e.message, type: 'proxy_error' } });
    else {
      try {
        sseWrite(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_error', output_index: 0, content_index: 0, delta: `[ERROR: Upstream timeout — ${e.message}]` });
        sseWrite(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_error', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: `[ERROR: Upstream timeout — ${e.message}]`, annotations: [] }] } });
        sseWrite(res, 'response.completed', { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output: [] } });
      } catch {}
      res.end();
    }
  }
}

// ── Dynamic Model List (fetched from CC API) ───────────────────────────────

let cachedModels = null;
let modelsFetchedAt = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function refreshModels() {
  try {
    const apiKey = poolPickAny();
    if (!apiKey) return;
    const res = await fetchWithTimeout(`${CFG.api_base}/provider/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 15000);
    if (res.ok) {
      const data = await res.json();
      if (data.data && Array.isArray(data.data)) {
        cachedModels = data.data.map(m => ({ id: m.id, name: m.name || m.id }));
        modelsFetchedAt = Date.now();
        log('info', `Models refreshed: ${cachedModels.length} models`);
      }
    }
  } catch (e) { log('warn', `Models refresh failed: ${e.message}`); }
}

function handleModels(req, res) {
  // Serve cached models, or trigger refresh and return what we have
  if (cachedModels && Date.now() - modelsFetchedAt < MODELS_CACHE_TTL) {
    return jsonRes(res, 200, { object: 'list', data: cachedModels.map(m => ({ ...m, object: 'model', created: nowUnix(), owned_by: 'command-code' })) });
  }
  // Stale or missing — return what we have and refresh in background
  if (cachedModels) {
    refreshModels().catch(() => {});
    return jsonRes(res, 200, { object: 'list', data: cachedModels.map(m => ({ ...m, object: 'model', created: nowUnix(), owned_by: 'command-code' })) });
  }
  // Never fetched yet — fetch synchronously (first call only)
  refreshModels().then(() => {
    if (!res.headersSent) {
      jsonRes(res, 200, { object: 'list', data: (cachedModels || []).map(m => ({ ...m, object: 'model', created: nowUnix(), owned_by: 'command-code' })) });
    }
  }).catch(() => {
    if (!res.headersSent) jsonRes(res, 200, { object: 'list', data: [] });
  });
}

function handleHealth(req, res) {
  jsonRes(res, 200, { status: 'ok', version: '1.0.30', cc_version: CC_VERSION, uptime: Math.floor((Date.now() - startTime) / 1000) });
}

function handleRoot(req, res) {
  jsonRes(res, 200, { name: 'cc-gateway', version: '1.0.30', description: 'Command Code API Gateway', endpoints: ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/health'] });
}

// ── HTTP Server ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Dashboard ────────────────────────────────────────────────────────────────

let dashboardHtml = '';
try { dashboardHtml = fs.readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf8'); } catch { dashboardHtml = '<h1>Dashboard not found</h1>'; }

function handleDashboard(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(dashboardHtml);
}

function handleApiStatus(req, res) {
  jsonRes(res, 200, {
    uptime: Math.floor((Date.now() - startTime) / 1000),
    port: CFG.port,
    host: CFG.host,
    api: CFG.api_base,
    cc_version: CC_VERSION,
    proxy: CFG.proxy?.enabled ? `socks5://${CFG.proxy.host}:${CFG.proxy.port}` : 'off',
    key: CFG.api_key ? `${CFG.api_key.slice(0, 8)}…` : 'none',
    key_pool: poolStatus(),
  });
}

function handleApiUsage(req, res) {
  jsonRes(res, 200, getUsageSummary());
}

function handleApiLogs(req, res) {
  const n = parseInt(new URL(req.url, `http://${req.headers.host}`).searchParams.get('n') || '100');
  jsonRes(res, 200, { logs: logBuffer.slice(-n) });
}

function handleApiModels(req, res) {
  const freeModels = (cachedModels || []).filter(m => /free/i.test(m.id));
  jsonRes(res, 200, { models: freeModels, total: freeModels.length, all_count: (cachedModels || []).length });
}

// ── Key pool management API (dashboard) ─────────────────────────────────────
// Plaintext keys by explicit user decision — instance is operator-owned.

function handleApiKeys(req, res) {
  jsonRes(res, 200, poolStatus(true));
}

async function handleApiKeyAdd(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: 'Invalid JSON' }); }
  const r = poolAddKey(body.key);
  if (!r.ok) return jsonRes(res, 400, { error: r.error });
  log('info', `Key added via dashboard: ${body.key.trim().slice(0, 8)}… (pool ${keyPool.keys.length} keys)`);
  jsonRes(res, 200, poolStatus(true));
}

async function handleApiKeyRemove(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: 'Invalid JSON' }); }
  const r = poolRemoveKey(body.key);
  if (!r.ok) return jsonRes(res, 400, { error: r.error });
  log('info', `Key removed via dashboard (pool ${keyPool.keys.length} keys)`);
  jsonRes(res, 200, poolStatus(true));
}

async function handleApiKeyEnable(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: 'Invalid JSON' }); }
  const r = poolEnableKey(body.key);
  if (!r.ok) return jsonRes(res, 400, { error: r.error });
  log('info', `Key re-enabled via dashboard: ${body.key.slice(0, 8)}…`);
  jsonRes(res, 200, poolStatus(true));
}

async function handleApiKeyTest(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: 'Invalid JSON' }); }
  const key = (body.key || '').trim();
  if (!key.startsWith('user_')) return jsonRes(res, 400, { error: 'Invalid key' });
  const model = 'deepseek/deepseek-v4-flash'; // cheap probe via the direct route
  const start = Date.now();
  try {
    const testBody = buildCcRequest({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: true });
    const ccRes = await forwardToCC(testBody, key);
    if (!ccRes.ok) {
      const errText = await ccRes.text().catch(() => '');
      const { message } = parseUpstreamError(errText, ccRes.status);
      return jsonRes(res, 200, { ok: false, ms: Date.now() - start, status: ccRes.status, error: message.slice(0, 200) });
    }
    const reader = ccRes.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + 20000;
    let finished = false, buffer = '';
    while (!finished && Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.max(deadline - Date.now(), 1))),
      ]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { if (JSON.parse(line).type === 'finish') finished = true; } catch {}
      }
    }
    reader.cancel().catch(() => {});
    jsonRes(res, 200, { ok: true, ms: Date.now() - start, status: 200 });
  } catch (e) {
    jsonRes(res, 200, { ok: false, ms: Date.now() - start, status: 0, error: e.message });
  }
}

async function handleApiTest(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: 'Invalid JSON' }); }
  const model = body.model;
  if (!model) return jsonRes(res, 400, { error: 'Missing model' });
  const apiKey = poolPickAny();
  if (!apiKey) return jsonRes(res, 400, { error: 'No API key configured' });

  const start = Date.now();
  const TIMEOUT_MS = 30000;
  try {
    // Use stream: true to match what buildCcRequest sends
    const testBody = buildCcRequest({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: true });
    const ccRes = await forwardToCC(testBody, apiKey);
    if (!ccRes.ok) {
      const errText = await ccRes.text().catch(() => '');
      return jsonRes(res, 200, { ok: false, model, status: ccRes.status, ms: Date.now() - start, error: errText.slice(0, 200) });
    }
    // Read streaming NDJSON, stop on 'finish' event or timeout
    const reader = ccRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let resultText = '';
    let finished = false;
    const deadline = Date.now() + TIMEOUT_MS;
    while (!finished && Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), deadline - Date.now()))
      ]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'text-delta') resultText += ev.text || '';
          if (ev.type === 'error') resultText += `[ERROR: ${ev.error?.message || 'unknown'}]`;
          if (ev.type === 'finish-step') {
            const u = ev.usage || {};
            recordTokens(model, u.inputTokens || 0, u.outputTokens || 0);
          }
          if (ev.type === 'finish') finished = true;
        } catch {}
      }
    }
    reader.cancel().catch(() => {});
    jsonRes(res, 200, { ok: true, model, status: 200, ms: Date.now() - start, response: resultText.slice(0, 200) });
  } catch (e) {
    jsonRes(res, 200, { ok: false, model, status: 0, ms: Date.now() - start, error: e.message });
  }
}

const startTime = Date.now();

const server = http.createServer((req, res) => {
  const reqId = newReqId();
  const reqStart = Date.now();
  // CORS (outside request context — nothing to correlate)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key' });
    return res.end();
  }

  requestStore.run({ reqId }, () => {
    const urlPath = (req.url || '').split('?')[0];
    const isGatewayRoute = urlPath.startsWith('/v1/') || urlPath === '/health';
    res.on('finish', () => {
      if (isGatewayRoute) log('info', `Request done: ${req.method} ${urlPath} ${res.statusCode} in ${Date.now() - reqStart}ms`);
    });
    res.on('close', () => {
      // Client hung up before the response was fully sent (common for agent aborts)
      if (!res.writableEnded && isGatewayRoute) log('warn', `Client disconnected early: ${req.method} ${urlPath} after ${Date.now() - reqStart}ms, sent ${res.writableLength} buffered bytes`);
    });
    handleRequest(req, res).catch(e => {
      log('error', `Unhandled handler error: ${e.message}`);
      if (e.stack) log('error', e.stack);
      if (!res.headersSent) jsonRes(res, 500, { error: { message: 'Internal server error', type: 'server_error' } });
      else res.end();
    });
  });
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Dashboard routes
    if (url.pathname === '/' && req.method === 'GET') return handleDashboard(req, res);
    if (url.pathname === '/api/status' && req.method === 'GET') return handleApiStatus(req, res);
    if (url.pathname === '/api/usage' && req.method === 'GET') return handleApiUsage(req, res);
    if (url.pathname === '/api/logs' && req.method === 'GET') return handleApiLogs(req, res);
    if (url.pathname === '/api/models' && req.method === 'GET') return handleApiModels(req, res);
    if (url.pathname === '/api/test' && req.method === 'POST') return handleApiTest(req, res);
    if (url.pathname === '/api/keys' && req.method === 'GET') return handleApiKeys(req, res);
    if (url.pathname === '/api/keys/add' && req.method === 'POST') return handleApiKeyAdd(req, res);
    if (url.pathname === '/api/keys/remove' && req.method === 'POST') return handleApiKeyRemove(req, res);
    if (url.pathname === '/api/keys/enable' && req.method === 'POST') return handleApiKeyEnable(req, res);
    if (url.pathname === '/api/keys/test' && req.method === 'POST') return handleApiKeyTest(req, res);

    // Gateway routes
    if (url.pathname === '/health' && req.method === 'GET') return handleHealth(req, res);
    if (url.pathname === '/v1/models' && req.method === 'GET') return handleModels(req, res);
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return handleChatCompletions(req, res);
    if (url.pathname === '/v1/messages' && req.method === 'POST') return handleMessages(req, res);
    if (url.pathname === '/v1/responses' && req.method === 'POST') return handleResponses(req, res);
    jsonRes(res, 404, { error: { message: 'Not found', type: 'not_found_error' } });
  } catch (e) {
    log('error', `Unhandled: ${e.message}`);
    if (!res.headersSent) jsonRes(res, 500, { error: { message: 'Internal server error', type: 'server_error' } });
    else res.end();
  }
}

// ── Global Error Handlers (prevent process crash) ──────────────────────
process.on('uncaughtException', (err) => {
  log('error', `[FATAL] uncaughtException: ${err.message}`);
  if (err.stack) log('error', err.stack);
  // Don't exit — keep the server alive
});

process.on('unhandledRejection', (reason) => {
  log('error', `[FATAL] unhandledRejection: ${reason?.message || reason}`);
  if (reason?.stack) log('error', reason.stack);
  // Don't exit — keep the server alive
});

server.on('error', (err) => {
  log('error', `Server error: ${err.message}`);
});

// ── Start ───────────────────────────────────────────────────────────────────

async function start() {
  // Ensure config exists
  if (!fs.existsSync(CONFIG_PATH)) saveConfig(CFG);

  // Load persisted token usage
  loadUsage();

  // Refresh CC version + model list
  await refreshCcVersion();
  await refreshModels();

  server.listen(CFG.port, CFG.host, () => {
    log('info', `cc-gateway started`, { port: CFG.port, host: CFG.host, api: CFG.api_base, cc_version: CC_VERSION, proxy: CFG.proxy?.enabled ? `socks5://${CFG.proxy.host}:${CFG.proxy.port} (foreign only)` : 'off', key_pool: `${poolActiveCount()}/${keyPool.keys.length} healthy` });
    console.log(`\n  cc-gateway v1.0.30`);
    console.log(`  Listening on http://${CFG.host}:${CFG.port}`);
    console.log(`  CC API: ${CFG.api_base}`);
    console.log(`  CC Version: ${CC_VERSION}`);
    console.log(`  Proxy: ${CFG.proxy?.enabled ? 'socks5://' + CFG.proxy.host + ':' + CFG.proxy.port : 'off'}`);
    console.log(`  API Key Pool: ${poolActiveCount()}/${keyPool.keys.length} healthy (round-robin + failover)`);
    console.log(`\n  Endpoints:`);
    console.log(`    POST /v1/chat/completions   (OpenAI)`);
    console.log(`    POST /v1/messages           (Anthropic)`);
    console.log(`    POST /v1/responses          (Responses)`);
    console.log(`    GET  /v1/models`);
    console.log(`    GET  /health`);
    console.log(`\n  Ctrl+C to stop\n`);
  });
}

start().catch(e => { console.error(e); process.exit(1); });
