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
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`cc-gateway v1.0.0
Usage:
  node gateway.mjs              Start the gateway
  node gateway.mjs --set-key    Set API key interactively
  node gateway.mjs --show-key   Show masked API key
  node gateway.mjs --delete-key Delete stored API key
  node gateway.mjs --version    Show version
  node gateway.mjs --help       Show this help`);
  process.exit(0);
}
if (args.includes('--version')) { console.log('cc-gateway v1.0.0'); process.exit(0); }

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = { port: 3050, host: '0.0.0.0', api_key: '', api_base: 'https://api.commandcode.ai', log_level: 'info', proxy: { enabled: false, host: '127.0.0.1', port: 7897 } };

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
if (args.includes('--show-key')) {
  console.log(CFG.api_key ? `Key: ${CFG.api_key.slice(0, 8)}…${CFG.api_key.slice(-4)}` : 'No key set.');
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

function log(level, msg, data) {
  if ((LOG_LEVELS[level] ?? 1) < minLevel) return;
  const ts = new Date().toISOString();
  const extra = data ? ' ' + JSON.stringify(data) : '';
  const line = `[${ts}] [${level}] ${msg}${extra}`;
  console.error(line);
  try { getLogFile().write(line + '\n'); } catch {}
}

function logError(msg, error) {
  const ts = new Date().toISOString();
  const stack = error?.stack || error?.message || String(error);
  const line = `[${ts}] [error] ${msg}\n${stack}`;
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

    // Collect the response as a stream-like object for compatibility with existing handlers
    const chunks = [];
    let headersParsed = false;
    let responseData = '';

    tlsSocket.on('data', (chunk) => {
      if (!headersParsed) {
        responseData += chunk.toString();
        const headerEnd = responseData.indexOf('\r\n\r\n');
        if (headerEnd >= 0) {
          headersParsed = true;
          const statusLine = responseData.split('\r\n')[0];
          const statusCode = parseInt(statusLine.split(' ')[1]) || 500;
          const bodyData = responseData.slice(headerEnd + 4);

          if (statusCode < 200 || statusCode >= 300) {
            // Non-2xx: return as error response
            resolve({
              ok: false,
              status: statusCode,
              body: {
                getReader() {
                  const encoder = new TextEncoder();
                  const encoded = encoder.encode(bodyData);
                  let read = false;
                  return {
                    read() {
                      if (!read) { read = true; return Promise.resolve({ done: false, value: encoded }); }
                      return Promise.resolve({ done: true });
                    }
                  };
                },
                text() { return Promise.resolve(bodyData); },
              },
              text() { return Promise.resolve(bodyData); },
            });
            return;
          }

          // Streaming response: create a ReadableStream from the socket
          let streamClosed = false;
          const stream = new ReadableStream({
            start(ctrl) {
              if (bodyData) ctrl.enqueue(new TextEncoder().encode(bodyData));
              tlsSocket.on('data', (chunk) => {
                if (!streamClosed) {
                  try { ctrl.enqueue(chunk); } catch {}
                }
              });
              tlsSocket.on('end', () => { streamClosed = true; try { ctrl.close(); } catch {} });
              tlsSocket.on('error', (e) => { streamClosed = true; try { ctrl.error(e); } catch {} });
            }
          });

          resolve({
            ok: true,
            status: statusCode,
            body: {
              getReader() { return stream.getReader(); },
            },
          });
        }
      }
    });

    tlsSocket.on('end', () => {
      if (!headersParsed) reject(new Error('Connection closed before response headers'));
    });
  });
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
  return extractApiKey(headers) || (CFG.api_key || null);
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
      input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
    }));
  }
  if (openaiReq.tool_choice !== undefined) {
    if (typeof openaiReq.tool_choice === 'string') {
      const map = { auto: 'auto', none: 'none', required: 'any' };
      body.params.tool_choice = { type: map[openaiReq.tool_choice] || 'auto' };
    } else if (openaiReq.tool_choice.type === 'function') {
      body.params.tool_choice = { type: 'tool', name: openaiReq.tool_choice.function?.name };
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
      if (item.type === 'message') {
        if (item.role === 'user') {
          const text = (item.content || []).filter(c => c.type === 'input_text').map(c => c.text).join('');
          if (text) messages.push({ role: 'user', content: text });
        } else if (item.role === 'assistant') {
          const text = (item.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
          const toolCalls = (item.content || []).filter(c => c.type === 'function_call').map(c => ({
            id: c.call_id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' },
          }));
          const m = { role: 'assistant', content: text || null };
          if (toolCalls.length) m.tool_calls = toolCalls;
          messages.push(m);
        }
      } else if (item.type === 'function_call') {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments || '{}' } }] });
      } else if (item.type === 'function_call_output') {
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: String(item.output || '') });
      }
    }
  }

  return {
    model: responsesReq.model || 'deepseek/deepseek-v4-flash',
    messages,
    max_tokens: responsesReq.max_output_tokens || 64000,
    stream: responsesReq.stream !== false,
    temperature: responsesReq.temperature,
    tools: responsesReq.tools,
    tool_choice: responsesReq.tool_choice,
  };
}

// ── Forward to CC API ───────────────────────────────────────────────────────

async function forwardToCC(body, apiKey, signal) {
  // Use SOCKS5 proxy if configured (bypasses CC's proxy detection)
  if (CFG.proxy?.enabled) {
    return forwardToCCViaProxy(body, apiKey, signal);
  }

  // Direct connection (original path)
  const sessionId = getSessionId(apiKey);
  await ensureInitialized(apiKey);

  const res = await fetchWithTimeout(`${CFG.api_base}/alpha/generate`, {
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

  return res;
}

// ── SSE Response Helpers ────────────────────────────────────────────────────

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
  return function translate(ndjsonLines) {
    const chunks = [];
    for (const line of ndjsonLines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const type = ev.type || '';
      if (type === 'start') {
        if (!roleSent) { chunks.push({ id: completionId, object: 'chat.completion.chunk', created: nowUnix(), model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }); roleSent = true; }
      } else if (type === 'start-step' || type === 'reasoning-start' || type === 'text-start') {}
      else if (type === 'text-delta' || type === 'reasoning-delta') {
        const text = ev.text || '';
        if (text) chunks.push({ id: completionId, object: 'chat.completion.chunk', created: nowUnix(), model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
      } else if (type === 'text-end' || type === 'reasoning-end') {}
      // Tool call events from CC API
      else if (type === 'tool-input-start') {
        currentToolId = ev.id || '';
        currentToolName = ev.toolName || '';
        currentToolArgs = '';
      } else if (type === 'tool-input-delta') {
        currentToolArgs += (ev.delta || '');
      } else if (type === 'tool-input-end') {
        // Emit the tool call as a delta chunk
        const idx = toolCallIndex++;
        chunks.push({
          id: completionId, object: 'chat.completion.chunk', created: nowUnix(), model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: idx, id: currentToolId, type: 'function', function: { name: currentToolName, arguments: currentToolArgs } }] }, finish_reason: null }],
        });
      } else if (type === 'tool-call') {
        // Final tool call confirmation (already emitted via tool-input-end)
      } else if (type === 'finish-step') {
        const u = ev.usage || {};
        inputTokens = u.inputTokens || 0;
        outputTokens = u.outputTokens || 0;
        cachedTokens = u.inputTokenDetails?.cacheReadTokens || 0;
      } else if (type === 'error') {
        const msg = ev.error?.message || 'CC API error';
        chunks.push({ id: completionId, object: 'chat.completion.chunk', created: nowUnix(), model, choices: [{ index: 0, delta: { content: '[ERROR: ' + msg + ']' }, finish_reason: 'stop' }] });
      } else if (type === 'finish') {
        const fr = ev.finishReason === 'length' ? 'length' : ev.finishReason === 'tool-calls' ? 'tool_calls' : 'stop';
        chunks.push({ id: completionId, object: 'chat.completion.chunk', created: nowUnix(), model, choices: [{ index: 0, delta: {}, finish_reason: fr }], usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens, prompt_tokens_details: { cached_tokens: cachedTokens } } });
        recordTokens(model, inputTokens, outputTokens);
      }
    }
    return chunks;
  };
}

// ── NDJSON → Anthropic SSE Translation ─────────────────────────────────────

function createAnthropicTranslator(messageId, model) {
  let inputTokens = 0, outputTokens = 0;
  let started = false;
  let blockIndex = 0;
  let blockOpen = false;
  let currentText = '';
  let currentToolId = '', currentToolName = '', currentToolArgs = '';

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
      } else if (type === 'text-start') {
        // Close previous block if still open (no explicit end event)
        if (blockOpen) {
          events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex }});
          blockIndex++;
        }
        blockOpen = true;
        currentText = '';
        events.push({ event: 'content_block_start', data: {
          type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' }
        }});
      } else if (type === 'text-delta' || type === 'reasoning-delta') {
        const text = ev.text || '';
        if (text) events.push({ event: 'content_block_delta', data: {
          type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text }
        }});
      } else if (type === 'text-end' || type === 'reasoning-end') {
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex }});
        blockOpen = false;
        blockIndex++;
      } else if (type === 'tool-input-start') {
        // Close previous block if still open
        if (blockOpen) {
          events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex }});
          blockIndex++;
        }
        blockOpen = true;
        currentToolId = ev.id || '';
        currentToolName = ev.toolName || '';
        currentToolArgs = '';
        events.push({ event: 'content_block_start', data: {
          type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: currentToolId, name: currentToolName, input: {} }
        }});
      } else if (type === 'tool-input-delta') {
        currentToolArgs += (ev.delta || '');
      } else if (type === 'tool-input-end') {
        events.push({ event: 'content_block_delta', data: {
          type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: currentToolArgs }
        }});
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex }});
        blockOpen = false;
        blockIndex++;
        // Already handled via tool-input-end
      } else if (type === 'finish-step') {
        const u = ev.usage || {};
        inputTokens = u.inputTokens || 0;
        outputTokens = u.outputTokens || 0;
      } else if (type === 'error') {
        const msg = ev.error?.message || 'CC API error';
        events.push({ event: 'content_block_start', data: {
          type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' }
        }});
        events.push({ event: 'content_block_delta', data: {
          type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '[ERROR: ' + msg + ']' }
        }});
        events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: blockIndex }});
        blockIndex++;
      }
    }
    return events;
  }

  function finalize() {
    const stopReason = 'end_turn';
    recordTokens(model, inputTokens, outputTokens);
    return [
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ];
  }

  return { translate, finalize };
}

// ── NDJSON → Responses SSE Translation ──────────────────────────────────────

function createResponsesTranslator(responseId, model) {
  let textContent = '', started = false, inputTokens = 0, outputTokens = 0;
  function translate(ndjsonLines) {
    const events = [];
    for (const line of ndjsonLines) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const type = ev.type || '';
      if (type === 'start' && !started) {
        started = true;
        events.push({ event: 'response.created', data: { type: 'response.created', response: { id: responseId, model, status: 'in_progress', output: [] } } });
        events.push({ event: 'response.in_progress', data: { type: 'response.in_progress', response: { id: responseId } } });
      } else if (type === 'text-delta' || type === 'reasoning-delta') {
        const text = ev.text || '';
        if (text) { textContent += text; events.push({ event: 'response.output_item.delta', data: { type: 'response.output_item.delta', delta: { type: 'content.delta', content_index: 0, text } } }); }
      } else if (type === 'error') {
        const msg = ev.error?.message || 'CC API error';
        textContent += '[ERROR: ' + msg + ']';
      } else if (type === 'finish-step') {
        const u = ev.usage || {};
        inputTokens = u.inputTokens || 0; outputTokens = u.outputTokens || 0;
      }
    }
    return events;
  }
  function finalize() {
    recordTokens(model, inputTokens, outputTokens);
    return [
      { event: 'response.output_item.done', data: { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textContent }] } } },
      { event: 'response.completed', data: { type: 'response.completed', response: { id: responseId, model, status: 'completed', usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textContent }] }] } } }
    ];
  }
  return { translate, finalize };
}

// ── Request Handlers ────────────────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let openaiReq;
  try { openaiReq = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }); }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) return jsonRes(res, 401, { error: { message: 'Missing API key', type: 'auth_error' } });

  const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
  let completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const ccBody = buildCcRequest(openaiReq);
  const client = detectClient(req, openaiReq);
  log('info', `Request: ${model} /v1/chat/completions [${client}]`);
  log('debug', `Request body`, { client, model, stream: openaiReq.stream, tools: openaiReq.tools?.length || 0, temperature: openaiReq.temperature, max_tokens: openaiReq.max_tokens });

  try {
    // Retry on transient errors — buffer first events before committing to client
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        log('info', `Retry ${attempt}/${MAX_RETRIES} for ${model}`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
      }

      const ccRes = await forwardToCC(ccBody, apiKey);
      if (!ccRes.ok) {
        const errText = await ccRes.text().catch(() => '');
        log('error', `CC error: ${ccRes.status} ${model} ${errText.slice(0, 300)}`);
        return jsonRes(res, ccRes.status >= 500 ? 502 : ccRes.status, { error: { message: errText.slice(0, 500) || `CC API error: ${ccRes.status}`, type: 'proxy_error' } });
      }

      // Phase 1: Buffer initial events (before headers) to detect transient errors
      const translate = createOpenAiTranslator(completionId, model);
      const reader = ccRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let preHeadersChunks = [];
      let earlyError = null;

      // Read until we see content or error, then decide
      const MAX_PRE_BUFFER = 20; // max events to buffer before committing
      for (let i = 0; i < MAX_PRE_BUFFER; i++) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        const chunks = translate(lines);
        for (const chunk of chunks) {
          const delta = chunk.choices?.[0]?.delta?.content || '';
          const fr = chunk.choices?.[0]?.finish_reason;
          if (delta.startsWith('[ERROR:') && delta.includes('Service temporarily unavailable')) {
            earlyError = delta;
          }
          preHeadersChunks.push(chunk);
          // If we got actual content or finish, stop buffering and commit
          if ((delta && !delta.startsWith('[ERROR:')) || fr) break;
        }
        if (earlyError || (preHeadersChunks.some(c => c.choices?.[0]?.delta?.content && !c.choices[0].delta.content.startsWith('[ERROR:')))) break;
      }

      // Transient error before any real content → retry
      if (earlyError && attempt < MAX_RETRIES) {
        log('warn', `Transient error on ${model}, retrying: ${earlyError.slice(0, 100)}`);
        lastError = earlyError;
        reader.cancel().catch(() => {});
        continue;
      }

      // All retries exhausted → return proper error
      if (earlyError) {
        log('error', `All retries exhausted for ${model}: ${earlyError.slice(0, 200)}`);
        reader.cancel().catch(() => {});
        return jsonRes(res, 503, { error: { message: earlyError.replace('[ERROR: ', '').replace(']', ''), type: 'proxy_error' } });
      }

      // Phase 2: Commit — send headers + pre-buffered chunks, then stream the rest
      sseHeaders(res);
      for (const chunk of preHeadersChunks) sseData(res, chunk);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        const chunks = translate(lines);
        for (const chunk of chunks) sseData(res, chunk);
      }
      if (buffer.trim()) {
        const chunks = translate([buffer]);
        for (const chunk of chunks) sseData(res, chunk);
      }

      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    log('error', `All ${MAX_RETRIES} retries exhausted for ${model}: ${lastError}`);
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

  const apiKey = getApiKey(req.headers);
  if (!apiKey) return jsonRes(res, 401, { error: { type: 'error', error: { type: 'authentication_error', message: 'Missing API key' } } });

  const model = anthropicReq.model || 'deepseek/deepseek-v4-flash';
  const messageId = `msg_${randomUUID().slice(0, 12)}`;
  const openaiReq = convertAnthropicToOpenai(anthropicReq);
  const ccBody = buildCcRequest(openaiReq);
  const client = detectClient(req, anthropicReq);
  log('info', `Request: ${model} /v1/messages [${client}]`);

  try {
    const ccRes = await forwardToCC(ccBody, apiKey);
    if (!ccRes.ok) {
      const errText = await ccRes.text().catch(() => '');
      log('error', `CC error: ${ccRes.status}`);
      return jsonRes(res, ccRes.status >= 500 ? 502 : ccRes.status, { type: 'error', error: { type: 'api_error', message: errText.slice(0, 500) || `CC API error: ${ccRes.status}` } });
    }

    sseHeaders(res);
    const { translate, finalize } = createAnthropicTranslator(messageId, model);
    const reader = ccRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      const events = translate(lines);
      for (const ev of events) sseWrite(res, ev.event, ev.data);
    }
    if (buffer.trim()) {
      const events = translate([buffer]);
      for (const ev of events) sseWrite(res, ev.event, ev.data);
    }
    for (const ev of finalize()) sseWrite(res, ev.event, ev.data);
    res.end();
  } catch (e) {
    logError(`Request error: ${e.message}`, e);
    if (!res.headersSent) jsonRes(res, 502, { type: 'error', error: { type: 'api_error', message: e.message } });
    else res.end();
  }
}

async function handleResponses(req, res) {
  let responsesReq;
  try { responsesReq = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }); }

  const apiKey = getApiKey(req.headers);
  if (!apiKey) return jsonRes(res, 401, { error: { message: 'Missing API key', type: 'auth_error' } });

  const model = responsesReq.model || 'deepseek/deepseek-v4-flash';
  const responseId = `resp_${randomUUID().slice(0, 12)}`;
  const openaiReq = convertResponsesToOpenai(responsesReq);
  const ccBody = buildCcRequest(openaiReq);
  const client = detectClient(req, responsesReq);
  log('info', `Request: ${model} /v1/responses [${client}]`);

  try {
    const ccRes = await forwardToCC(ccBody, apiKey);
    if (!ccRes.ok) {
      const errText = await ccRes.text().catch(() => '');
      log('error', `CC error: ${ccRes.status}`);
      return jsonRes(res, ccRes.status >= 500 ? 502 : ccRes.status, { error: { message: errText.slice(0, 500) || `CC API error: ${ccRes.status}`, type: 'proxy_error' } });
    }

    sseHeaders(res);
    const { translate, finalize } = createResponsesTranslator(responseId, model);
    const reader = ccRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      const events = translate(lines);
      for (const ev of events) sseWrite(res, ev.event, ev.data);
    }
    if (buffer.trim()) {
      const events = translate([buffer]);
      for (const ev of events) sseWrite(res, ev.event, ev.data);
    }
    for (const ev of finalize()) sseWrite(res, ev.event, ev.data);
    res.end();
  } catch (e) {
    logError(`Request error: ${e.message}`, e);
    if (!res.headersSent) jsonRes(res, 502, { error: { message: e.message, type: 'proxy_error' } });
    else res.end();
  }
}

// ── Dynamic Model List (fetched from CC API) ───────────────────────────────

let cachedModels = null;
let modelsFetchedAt = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function refreshModels() {
  try {
    const apiKey = CFG.api_key;
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
  jsonRes(res, 200, { status: 'ok', version: '1.0.0', cc_version: CC_VERSION, uptime: Math.floor((Date.now() - startTime) / 1000) });
}

function handleRoot(req, res) {
  jsonRes(res, 200, { name: 'cc-gateway', version: '1.0.0', description: 'Command Code API Gateway', endpoints: ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/health'] });
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

async function handleApiTest(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return jsonRes(res, 400, { error: 'Invalid JSON' }); }
  const model = body.model;
  if (!model) return jsonRes(res, 400, { error: 'Missing model' });
  const apiKey = CFG.api_key;
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

const server = http.createServer(async (req, res) => {
  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Api-Key' });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    // Dashboard routes
    if (url.pathname === '/' && req.method === 'GET') return handleDashboard(req, res);
    if (url.pathname === '/api/status' && req.method === 'GET') return handleApiStatus(req, res);
    if (url.pathname === '/api/usage' && req.method === 'GET') return handleApiUsage(req, res);
    if (url.pathname === '/api/logs' && req.method === 'GET') return handleApiLogs(req, res);
    if (url.pathname === '/api/models' && req.method === 'GET') return handleApiModels(req, res);
    if (url.pathname === '/api/test' && req.method === 'POST') return handleApiTest(req, res);

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
});

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
    log('info', `cc-gateway started`, { port: CFG.port, host: CFG.host, api: CFG.api_base, cc_version: CC_VERSION, proxy: CFG.proxy?.enabled ? `socks5://${CFG.proxy.host}:${CFG.proxy.port}` : 'off', key: CFG.api_key ? `${CFG.api_key.slice(0, 8)}…` : 'none (pass via header)' });
    console.log(`\n  cc-gateway v1.0.0`);
    console.log(`  Listening on http://${CFG.host}:${CFG.port}`);
    console.log(`  CC API: ${CFG.api_base}`);
    console.log(`  CC Version: ${CC_VERSION}`);
    console.log(`  Proxy: ${CFG.proxy?.enabled ? 'socks5://' + CFG.proxy.host + ':' + CFG.proxy.port : 'off'}`);
    console.log(`  API Key: ${CFG.api_key ? CFG.api_key.slice(0, 8) + '…' : 'not set (pass via Authorization header)'}`);
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
