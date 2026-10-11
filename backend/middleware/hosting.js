/**
 * The one-service deploy (root Dockerfile, render.yaml): the backend also serves the
 * built web app and forwards scanner calls to the CV service running next to it, so a
 * visitor needs one URL and the browser never talks to the CV service directly.
 * Locally (docker compose) neither is configured and the three services stay separate.
 */
const path = require('path');
const express = require('express');

/** The built web app (FRONTEND_DIR): hashed assets cached for good, every page path gets index.html. */
function webApp(dir) {
    const index = path.join(dir, 'index.html');
    const files = express.static(dir, {
        index: false,
        setHeaders(res, file) {
            if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
    });
    const page = (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (/^\/(api|cv)(\/|$)/.test(req.path)) return next(); // API misses stay JSON 404s
        res.setHeader('Cache-Control', 'no-cache');
        // PayPal's checkout popup must be able to report back to this page.
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
        res.sendFile(index);
    };
    return [files, page];
}

const CV_PATHS = new Set(['/embed-fingerprint', '/embed-face']);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Read a request body up to `limit` bytes; resolves null when it is larger (the rest is drained, not kept). */
function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size <= limit) chunks.push(c);
        });
        req.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** POST /cv/embed-fingerprint and /cv/embed-face -> the CV service at `target`. Mount before body parsers. */
function cvProxy(target) {
    return async (req, res, next) => {
        if (req.method !== 'POST' || !CV_PATHS.has(req.path)) return next();
        let body;
        try { body = await readBody(req, MAX_FRAME_BYTES); } catch { return res.status(400).json({ error: 'Upload failed' }); }
        if (!body) return res.status(413).json({ error: 'Image too large' });
        try {
            const r = await fetch(new URL(req.path, target), {
                method: 'POST',
                headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
                body,
                signal: AbortSignal.timeout(30000),
            });
            res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(Buffer.from(await r.arrayBuffer()));
        } catch {
            res.status(502).json({ error: "Can't reach the scanner service. Try again in a moment." });
        }
    };
}

module.exports = { webApp, cvProxy, MAX_FRAME_BYTES };
