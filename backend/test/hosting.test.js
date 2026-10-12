// The one-service deploy (Dockerfile at the repo root, render.yaml): the backend also
// serves the built web app and forwards scanner calls to the CV service next to it, so
// judges get a single URL.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

async function appWith(env) {
    for (const k of ['FRONTEND_DIR', 'CV_SERVICE_URL', 'CORS_ORIGINS', 'TRUST_PROXY', 'RENDER_EXTERNAL_URL']) delete process.env[k];
    Object.assign(process.env, env);
    delete require.cache[require.resolve('../app')];
    const { createApp } = require('../app');
    const server = createApp({ query: async () => ({ rows: [] }) }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

/** A stand-in CV service that records what reached it. Frames reading "blank" are rejected like the real one. */
async function fakeCv() {
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
            const blank = body.includes(Buffer.from('blank'));
            res.writeHead(blank ? 422 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(blank ? { detail: 'Image too blurry' } : { embedding: [0.1, 0.2], quality: 77 }));
        });
    }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

describe('serving the web app', () => {
    let dir;
    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsepay-web-'));
        fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>PulsePay</title>');
        fs.mkdirSync(path.join(dir, 'assets'));
        fs.writeFileSync(path.join(dir, 'assets', 'app-1a2b.js'), 'console.log(1)');
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('serves the page, its assets and app paths from the build folder', async () => {
        const app = await appWith({ FRONTEND_DIR: dir });
        try {
            const page = await fetch(app.base + '/');
            assert.equal(page.status, 200);
            assert.match(await page.text(), /<title>PulsePay<\/title>/);
            // PayPal's checkout opens in a popup that must be able to report back.
            assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
            assert.match(page.headers.get('cache-control'), /no-cache/);

            const asset = await fetch(app.base + '/assets/app-1a2b.js');
            assert.equal(asset.status, 200);
            assert.equal(await asset.text(), 'console.log(1)');
            assert.match(asset.headers.get('cache-control'), /immutable/);

            const deepLink = await fetch(app.base + '/merchant');
            assert.equal(deepLink.status, 200);
            assert.match(await deepLink.text(), /PulsePay/);
        } finally { await app.close(); }
    });

    it('keeps API misses as JSON 404s, not the web page', async () => {
        const app = await appWith({ FRONTEND_DIR: dir });
        try {
            const r = await fetch(app.base + '/api/nope');
            assert.equal(r.status, 404);
            assert.deepEqual(await r.json(), { error: 'Route not found' });
            assert.equal((await fetch(app.base + '/health')).status, 200);
        } finally { await app.close(); }
    });

    it('answers 404 for a missing file instead of the page (a stale chunk after a redeploy)', async () => {
        const app = await appWith({ FRONTEND_DIR: dir });
        try {
            const r = await fetch(app.base + '/assets/merchant-dashboard-OLDHASH.js');
            assert.equal(r.status, 404);
            assert.doesNotMatch(r.headers.get('content-type'), /html/);
        } finally { await app.close(); }
    });

    it('gives /index.html the same headers as /', async () => {
        const app = await appWith({ FRONTEND_DIR: dir });
        try {
            const r = await fetch(app.base + '/index.html');
            assert.equal(r.status, 200);
            assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
            assert.match(r.headers.get('cache-control'), /no-cache/);
        } finally { await app.close(); }
    });

    it('caches for good only the hashed files in the build\'s own assets folder', async () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsepay-'));
        const nested = path.join(parent, 'assets', 'web'); // the build folder itself sits under "assets"
        fs.mkdirSync(path.join(nested, 'assets'), { recursive: true });
        fs.writeFileSync(path.join(nested, 'index.html'), '<!doctype html>');
        fs.writeFileSync(path.join(nested, 'robots.txt'), 'User-agent: *');
        fs.writeFileSync(path.join(nested, 'assets', 'app-9z.js'), '1');
        const app = await appWith({ FRONTEND_DIR: nested });
        try {
            assert.doesNotMatch((await fetch(app.base + '/robots.txt')).headers.get('cache-control'), /immutable/);
            assert.match((await fetch(app.base + '/assets/app-9z.js')).headers.get('cache-control'), /immutable/);
        } finally { await app.close(); fs.rmSync(parent, { recursive: true, force: true }); }
    });

    it('serves no web app when no build folder is configured', async () => {
        const app = await appWith({});
        try {
            const r = await fetch(app.base + '/');
            assert.equal(r.status, 404);
            assert.deepEqual(await r.json(), { error: 'Route not found' });
        } finally { await app.close(); }
    });
});

describe('forwarding scanner calls to the CV service', () => {
    it('passes the camera frame through and returns the vector', async () => {
        const cv = await fakeCv();
        const app = await appWith({ CV_SERVICE_URL: cv.url });
        try {
            const fd = new FormData();
            fd.append('image', new Blob([Buffer.from('fake-jpeg-bytes')], { type: 'image/jpeg' }), 'capture.jpg');
            const r = await fetch(app.base + '/cv/embed-face', { method: 'POST', body: fd });
            assert.equal(r.status, 200);
            assert.deepEqual(await r.json(), { embedding: [0.1, 0.2], quality: 77 });

            assert.equal(cv.seen.length, 1);
            assert.equal(cv.seen[0].method, 'POST');
            assert.equal(cv.seen[0].url, '/embed-face');
            assert.match(cv.seen[0].type, /^multipart\/form-data; boundary=/);
            assert.ok(cv.seen[0].body.includes(Buffer.from('fake-jpeg-bytes')), 'the frame arrives unchanged');
        } finally { await app.close(); await cv.close(); }
    });

    it("passes the CV service's rejection back as is", async () => {
        const cv = await fakeCv();
        const app = await appWith({ CV_SERVICE_URL: cv.url });
        try {
            const r = await fetch(app.base + '/cv/embed-fingerprint', { method: 'POST', body: 'blank', headers: { 'Content-Type': 'image/jpeg' } });
            assert.equal(r.status, 422);
            assert.deepEqual(await r.json(), { detail: 'Image too blurry' });
        } finally { await app.close(); await cv.close(); }
    });

    it('only forwards the two embed endpoints', async () => {
        const cv = await fakeCv();
        const app = await appWith({ CV_SERVICE_URL: cv.url });
        try {
            assert.equal((await fetch(app.base + '/cv/docs')).status, 404);
            assert.equal((await fetch(app.base + '/cv/embed-face')).status, 404, 'GET is not forwarded');
            assert.equal((await fetch(app.base + '/cv/embed-voice', { method: 'POST', body: 'x' })).status, 404);
            assert.equal(cv.seen.length, 0);
        } finally { await app.close(); await cv.close(); }
    });

    it('refuses frames over the size cap without forwarding them', async () => {
        const cv = await fakeCv();
        const app = await appWith({ CV_SERVICE_URL: cv.url });
        try {
            const big = Buffer.alloc(9 * 1024 * 1024, 1);
            const r = await fetch(app.base + '/cv/embed-fingerprint', { method: 'POST', body: big, headers: { 'Content-Type': 'image/jpeg' } });
            assert.equal(r.status, 413);
            assert.equal(cv.seen.length, 0);
        } finally { await app.close(); await cv.close(); }
    });

    it('answers 502 when the CV service is down', async () => {
        const cv = await fakeCv();
        await cv.close();
        const app = await appWith({ CV_SERVICE_URL: cv.url });
        try {
            const r = await fetch(app.base + '/cv/embed-face', { method: 'POST', body: 'x', headers: { 'Content-Type': 'image/jpeg' } });
            assert.equal(r.status, 502);
            assert.match((await r.json()).error, /scanner/i);
        } finally { await app.close(); }
    });

    it('is off unless CV_SERVICE_URL is set', async () => {
        const app = await appWith({});
        try {
            assert.equal((await fetch(app.base + '/cv/embed-face', { method: 'POST', body: 'x' })).status, 404);
        } finally { await app.close(); }
    });
});

describe('requests from the page itself', () => {
    const post = (base, headers) => fetch(base + '/api/demo/start', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });

    it('allows the page served from this host, refuses other sites', async () => {
        const app = await appWith({ CORS_ORIGINS: 'http://localhost:3000' });
        try {
            const host = new URL(app.base).host;
            assert.notEqual((await post(app.base, { Origin: `http://${host}` })).status, 403);
            assert.equal((await post(app.base, { Origin: 'https://evil.example' })).status, 403);
            assert.notEqual((await post(app.base, { Origin: 'http://localhost:3000' })).status, 403, 'configured origins still work');
        } finally { await app.close(); }
    });

    it('sees https behind a trusted proxy', async () => {
        const app = await appWith({ TRUST_PROXY: '1' });
        try {
            const host = new URL(app.base).host;
            assert.notEqual((await post(app.base, { Origin: `https://${host}`, 'X-Forwarded-Proto': 'https' })).status, 403);
            assert.equal((await post(app.base, { Origin: `https://${host}` })).status, 403, 'plain http request claiming an https origin');
        } finally { await app.close(); }
    });

    it("allows Render's public URL", async () => {
        const app = await appWith({ RENDER_EXTERNAL_URL: 'https://pulsepay.onrender.com' });
        try {
            assert.notEqual((await post(app.base, { Origin: 'https://pulsepay.onrender.com' })).status, 403);
        } finally { await app.close(); }
    });
});
