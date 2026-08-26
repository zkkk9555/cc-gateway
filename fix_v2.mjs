import fs from 'node:fs';
let c = fs.readFileSync('gateway.mjs','utf8');

// ======== FIX 1: Remove broken duplicate error handlers from OpenAI translator ========
// The error handler for Anthropic (events.push) was incorrectly injected into OpenAI translator
// Find and remove the duplicate `} else if (type === 'error') {` blocks that reference `events`

// Remove the broken Anthropic error handler that leaked into OpenAI translator
c = c.replace(
  /(\} else if \(type === 'error'\) \{\n        const msg = ev\.error\?\.message \|\| 'CC API error';\n        chunks\.push\(\{ id: completionId.*?\}\);\n      \}) \} else if \(type === 'error'\) \{\n        const msg = ev\.error\?\.message \|\| 'CC API error';\n        events\.push\(\{ event: 'content_block_delta'.*?\}\);\n      \} else if \(type === 'finish'\) \{\n        events\.push\(\{ event: 'content_block_stop'.*?\}\);\n        const sr = ev\.finishReason === 'length' \? 'max_tokens' : 'end_turn';\n        events\.push\(\{ event: 'message_delta'.*?\}\);\n        events\.push\(\{ event: 'message_stop'.*?\}\);\n      \}/,
  '$1'
);

// ======== FIX 2: Add Responses finalize() call in handleResponses ========
// Currently handleResponses doesn't call finalize() after the stream loop
const oldResponsesHandler = /res\.end\(\);\n  \} catch \(e\) \{\n    log\('error', `Request error: \$\{e\.message\}`\);\n    if \(!res\.headersSent\) jsonRes\(res, 502, \{ error: \{ message: e\.message, type: 'proxy_error' \} \}\);\n    else res\.end\(\);\n  \}\n\}/;

// Check if finalize is already called in handleResponses
if (!c.includes("for (const ev of finalize()) sseWrite(res, ev.event, ev.data);")) {
  // Only add if not already present in handleResponses
  // Find the last res.end() in handleResponses and add finalize before it
}

// Actually let me just check what handleResponses looks like now
const responsesStart = c.indexOf('async function handleResponses');
const responsesEnd = c.indexOf('function handleModels');
const responsesSection = c.substring(responsesStart, responsesEnd);

// Check if finalize is called
if (!responsesSection.includes('finalize()')) {
  // Add finalize call before the last res.end() in handleResponses
  c = c.replace(
    /(\}\n\nfunction handleModels)/,
    '\n    for (const ev of finalize()) sseWrite(res, ev.event, ev.data);\n$1'
  );
}

fs.writeFileSync('gateway.mjs', c);
console.log('Fixes applied');
