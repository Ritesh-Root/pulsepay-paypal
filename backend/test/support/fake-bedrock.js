/**
 * A local stand-in for the Amazon Bedrock Converse API. Each call to
 * POST /model/{modelId}/converse returns the next scripted turn:
 *
 *   fake.script.push({ text: 'Hello' })                                   // a final answer
 *   fake.script.push({ toolUse: { name: 'propose_refund', input: {...} } }) // a tool call
 *
 * With an empty script it answers "OK". Requests are recorded in fake.calls.
 */
const http = require('http');
const crypto = require('crypto');

function startFakeBedrock() {
    const script = [];
    const calls = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const m = req.url.match(/^\/model\/([^/]+)\/converse$/);
            if (req.method !== 'POST' || !m) { res.writeHead(404); return res.end('{}'); }
            calls.push({ modelId: decodeURIComponent(m[1]), auth: req.headers.authorization, body: JSON.parse(raw || '{}') });
            const turn = script.shift() || { text: 'OK' };
            const content = turn.toolUse
                ? [{ toolUse: { toolUseId: `tooluse_${crypto.randomBytes(6).toString('hex')}`, name: turn.toolUse.name, input: turn.toolUse.input || {} } }]
                : [{ text: turn.text }];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                output: { message: { role: 'assistant', content } },
                stopReason: turn.toolUse ? 'tool_use' : 'end_turn',
                usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
                metrics: { latencyMs: 42 },
            }));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            script,
            calls,
            close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
        }));
    });
}

/** Point services/bedrock.js at the fake. */
function useFakeBedrock(fake) {
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'test-bedrock-key';
    process.env.BEDROCK_ENDPOINT = fake.url;
}

module.exports = { startFakeBedrock, useFakeBedrock };
