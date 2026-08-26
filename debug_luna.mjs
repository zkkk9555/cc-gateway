import crypto from 'node:crypto';
const API_KEY = 'user_REDACTED';
const body = {
  config: { workingDir: '', date: '2026-08-27', environment: 'win32-x64, Node.js v22.23.2', structure: [], isGitRepo: false, currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [] },
  memory: null, taste: null, skills: '', permissionMode: 'standard',
  params: { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'say ok' }], max_tokens: 10, stream: true }
};
const res = await fetch('https://api.commandcode.ai/alpha/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY, 'x-cli-environment': 'production', 'x-command-code-version': '1.35.1', 'x-session-id': 'debug-luna-' + Date.now(), 'x-co-flag': 'false', 'x-taste-learning': 'false', 'x-project-slug': 'debug-luna', traceparent: '00-' + crypto.randomBytes(16).toString('hex') + '-' + crypto.randomBytes(8).toString('hex') + '-01' },
  body: JSON.stringify(body)
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let eventCount = 0;
const eventTypes = {};
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      eventCount++;
      eventTypes[ev.type] = (eventTypes[ev.type] || 0) + 1;
      if (['start','text-delta','reasoning-delta','finish'].includes(ev.type)) {
        console.log('[' + eventCount + '] ' + ev.type + ': ' + (ev.text ? JSON.stringify(ev.text).slice(0,80) : ev.finishReason || ''));
      }
    } catch {}
  }
}
if (buffer.trim()) { try { const ev = JSON.parse(buffer); eventCount++; eventTypes[ev.type] = (eventTypes[ev.type] || 0) + 1; } catch {} }
console.log('\nTotal events: ' + eventCount);
console.log('Event types: ' + JSON.stringify(eventTypes));
