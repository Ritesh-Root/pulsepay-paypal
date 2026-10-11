/**
 * AI merchant assistant endpoint (merchant token required).
 *
 *   POST /api/assistant/chat  { messages: [{ role: 'user'|'assistant', text }] }
 *     -> { reply, actions: [...proposals the merchant can confirm], tools_used, model }
 */
const express = require('express');
const router = express.Router();

const assistant = require('../services/assistant');
const bedrock = require('../services/bedrock');
const audit = require('../services/audit');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const perMerchant = new Map(); // merchantId -> [timestamps]
const LIMIT_PER_MIN = 20;
// "Try the demo" shops are anonymous and use the operator's Bedrock key: a few questions
// each, and a daily ceiling across all of them.
const DEMO_QUESTIONS = Number(process.env.DEMO_ASSISTANT_QUESTIONS || 10);
const DEMO_DAILY = Number(process.env.DEMO_ASSISTANT_DAILY || 300);
const demoAsked = new Map(); // merchantId -> questions asked
let demoDay = { date: '', count: 0 };

function demoAllowance(merchantId) {
    const today = new Date().toISOString().slice(0, 10);
    if (demoDay.date !== today) demoDay = { date: today, count: 0 };
    const asked = demoAsked.get(merchantId) || 0;
    if (asked >= DEMO_QUESTIONS || demoDay.count >= DEMO_DAILY) return false;
    demoAsked.set(merchantId, asked + 1);
    demoDay.count += 1;
    return true;
}

router.use(h(async (req, res, next) => {
    const r = await req.app.locals.pool.query('SELECT * FROM merchants WHERE id = $1 AND active = true', [req.user.id]);
    if (!r.rows.length) return res.status(401).json({ error: 'Merchant account not found', code: 'auth_required' });
    req.merchant = r.rows[0];
    next();
}));

router.get('/status', (req, res) => {
    res.json({ enabled: bedrock.configured(), model: bedrock.model() });
});

router.post('/chat', h(async (req, res) => {
    if (!bedrock.configured()) return res.status(503).json({ error: 'The assistant is not configured on this server' });
    const now = Date.now();
    const recent = (perMerchant.get(req.merchant.id) || []).filter((t) => now - t < 60_000);
    if (recent.length >= LIMIT_PER_MIN) return res.status(429).json({ error: 'Slow down a little: too many questions this minute' });
    perMerchant.set(req.merchant.id, [...recent, now]);
    if (req.merchant.is_demo && !demoAllowance(req.merchant.id)) {
        return res.status(429).json({ error: 'This demo shop has used its assistant questions. Open a new demo shop to ask more.' });
    }

    try {
        const out = await assistant.chat(req.app.locals.pool, req.merchant, req.body?.messages);
        await audit.append(req.app.locals.pool, {
            actor: 'assistant', action: 'assistant_chat', resourceRef: req.merchant.id, ip: req.ip,
        });
        res.json(out);
    } catch (e) {
        if (e.message === 'empty_message') return res.status(400).json({ error: 'Ask a question' });
        console.error('assistant failed:', e.message);
        res.status(502).json({ error: 'The assistant is unavailable right now' });
    }
}));

module.exports = router;
