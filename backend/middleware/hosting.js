/**
 * The one-service deploy (root Dockerfile, render.yaml): the backend also serves the
 * built web app and forwards scanner calls to the CV service running next to it, so a
 * visitor needs one URL and the browser never talks to the CV service directly.
 * Locally (docker compose) neither is configured and the three services stay separate.
 */
const path = require('path');
const express = require('express');

/** The page itself is never cached, and PayPal's checkout popup must be able to report back to it. */
function pageHeaders(res) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
}

/** The built web app (FRONTEND_DIR): hashed assets cached for good, every page path gets index.html. */
function webApp(dir) {
    const index = path.join(dir, 'index.html');
    const files = express.static(dir, {
        index: false,
        setHeaders(res, file) {
            const rel = path.relative(dir, file);
            if (rel === 'index.html') pageHeaders(res);
            else if (rel.startsWith(`assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
    });
    const page = (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        // API misses stay JSON 404s, and so do missing files (a stale chunk after a redeploy).
        if (/^\/(api|cv)(\/|$)/.test(req.path) || path.extname(req.path)) return next();
        pageHeaders(res);
        res.sendFile(index);
    };
    return [files, page];
}

const CV_PATHS = new Set(['/embed-fingerprint', '/embed-face']);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** POST /cv/embed-fingerprint and /cv/embed-face -> the CV service at `target`. Mount before body parsers. */
function cvProxy(target) {
    // The frame as raw bytes, whatever its type. Over the cap, the app's error handler answers 413.
    const readFrame = express.raw({ type: () => true, limit: MAX_FRAME_BYTES });
    async function forward(req, res) {
        try {
            const r = await fetch(new URL(req.path, target), {
                method: 'POST',
                headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
                body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
                signal: AbortSignal.timeout(30000),
            });
            res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(Buffer.from(await r.arrayBuffer()));
        } catch {
            res.status(502).json({ error: "Can't reach the scanner service. Try again in a moment." });
        }
    }
    return (req, res, next) => {
        if (req.method !== 'POST' || !CV_PATHS.has(req.path)) return next();
        readFrame(req, res, (err) => (err ? next(err) : forward(req, res)));
    };
}

module.exports = { webApp, cvProxy };
