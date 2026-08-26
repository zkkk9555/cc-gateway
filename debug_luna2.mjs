import crypto from 'node:crypto';
const API_KEY = 'user_REDACTED';
const body = {
  config: { workingDir: '', date: '2026-08-27', environment: 'win32-x64, Node.js v22.23.2', structure: [], isGitRepo: false, currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [] },
  memory: null, taste: null, skills: '', permissionMode: 'standard',
  params: { model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'say ok' }], max_tokens: 10, stream: true }
};
const res = await fetch('https://api.commandcode.ai/alpha/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY, 'x-cli-environment': 'production', 'x-command-code-version': '1.35.1', 'x-session-id': 'debug-luna2-' + Date.now(), 'x-co-flag': 'false', 'x-taste-learning': 'false', 'x-project-slug': 'debug-luna2', traceparent: '00-' + crypto.randomBytes(16).toString('hex') + '-' + crypto.randomBytes(8).toString('hex') + '-01' },
  body: JSON.stringify(body)
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
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
      console.log('Event:', ev.type, JSON.stringify(ev).slice(0, 200));
    } catch { console.log('Raw:', line.slice(0, 200)); }
  }
}
if (buffer.trim()) console.log('Buffer:', buffer.slice(0, 200));
