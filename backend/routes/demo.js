/**
 * "Try the demo" (only when DEMO_MODE=true; server.js refuses it with live PayPal).
 *
 *   GET  /api/demo         { enabled }
 *   POST /api/demo/start   a fresh demo shop + customer for this visitor (services/demo.js)
 */
const express = require('express');
const router = express.Router();
const demo = require('../services/demo');

const STARTS_PER_HOUR = Number(process.env.DEMO_STARTS_PER_HOUR || 10);
const starts = new Map(); // ip -> timestamps in the last hour (single instance demo)

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const enabled = () => process.env.DEMO_MODE === 'true';

function allowed(ip) {
    const now = Date.now();
    const recent = (starts.get(ip) || []).filter((t) => now - t < 3600e3);
    if (recent.length >= STARTS_PER_HOUR) { starts.set(ip, recent); return false; }
    starts.set(ip, [...recent, now]);
    return true;
}

router.get('/', (req, res) => res.json({ enabled: enabled() }));

router.post('/start', h(async (req, res) => {
    if (!enabled()) return res.status(404).json({ error: 'Route not found' });
    if (!allowed(req.ip)) return res.status(429).json({ error: 'Too many demo shops from this device. Try again in an hour.' });
    res.json(await demo.start(req.app.locals.pool));
}));

module.exports = router;
