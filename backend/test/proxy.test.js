// Per-visitor rate limiting must see the real visitor behind a hosting proxy (Render),
// and must not trust a forwarded address when no proxy is configured.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

async function appWith(env) {
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../app')];
    const { createApp } = require('../app');
    const server = createApp({}).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const get = async (ip) => (await fetch(`http://127.0.0.1:${server.address().port}/api/demo`, { headers: { 'X-Forwarded-For': ip } })).status;
    return { get, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

describe('rate limiting', () => {
    it('counts visitors separately behind a trusted proxy', async () => {
        const app = await appWith({ TRUST_PROXY: '1', RATE_LIMIT_PER_MIN: '3' });
        try {
            for (let i = 0; i < 3; i++) assert.equal(await app.get('203.0.113.7'), 200);
            assert.equal(await app.get('198.51.100.9'), 200, 'another visitor is not blocked');
            assert.equal(await app.get('203.0.113.7'), 429);
        } finally { await app.close(); }
    });

    it('ignores X-Forwarded-For when no proxy is trusted', async () => {
        const app = await appWith({ TRUST_PROXY: '', RATE_LIMIT_PER_MIN: '3' });
        try {
            const statuses = [];
            for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4']) statuses.push(await app.get(ip));
            assert.deepEqual(statuses, [200, 200, 200, 429], 'a spoofed header does not reset the limit');
        } finally { await app.close(); }
    });
});
