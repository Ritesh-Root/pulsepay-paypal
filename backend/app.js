/**
 * The Express app: middleware and routes, given a database pool. server.js runs the
 * boot checks, opens the pool, listens and starts the background jobs; tests use
 * createApp directly.
 */
const express = require('express');
const cors = require('cors');
const { authenticate } = require('./middleware/auth');
const { webApp, cvProxy } = require('./middleware/hosting');

const enrollRoutes = require('./routes/enroll');
const merchantRoutes = require('./routes/merchant');
const paypalRoutes = require('./routes/paypal');
const assistantRoutes = require('./routes/assistant');
const paymentRoutes = require('./routes/payment');
const walletRoutes = require('./routes/wallet');
const familyRoutes = require('./routes/family');
const voiceRoutes = require('./routes/voice');
const demoRoutes = require('./routes/demo');

function createApp(pool) {
    const app = express();

    app.disable('x-powered-by');
    // Behind a hosting proxy (Render: TRUST_PROXY=1) req.ip must be the visitor, not the proxy,
    // for the rate limits. Unset locally, so a forged X-Forwarded-For is ignored.
    const trust = process.env.TRUST_PROXY;
    if (trust) app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);

    // Security headers (minimal, no extra deps).
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        next();
    });

    // Scoped CORS — no wildcard. Configured origins, Render's public URL, and the page this
    // app serves itself (the one-service deploy calls its own host).
    const allowedOrigins = [...(process.env.CORS_ORIGINS || 'http://localhost:3000').split(','), process.env.RENDER_EXTERNAL_URL || '']
        .map(s => s.trim()).filter(Boolean);
    app.use(cors((req, cb) => {
        const origin = req.header('Origin');
        const ok = !origin || allowedOrigins.includes(origin) || origin === `${req.protocol}://${req.get('host')}`;
        cb(ok ? null : new Error('CORS: origin not allowed'), { origin: ok, credentials: true });
    }));

    // Lightweight in-process rate limiter (per IP). Production: API-gateway/WAF + Redis.
    const rl = new Map();
    const RL_WINDOW = 60 * 1000, RL_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 120);
    setInterval(() => {
        const now = Date.now();
        for (const [k, e] of rl) if (now > e.reset) rl.delete(k);
    }, RL_WINDOW).unref();
    app.use((req, res, next) => {
        const key = req.ip;
        const now = Date.now();
        const e = rl.get(key) || { count: 0, reset: now + RL_WINDOW };
        if (now > e.reset) { e.count = 0; e.reset = now + RL_WINDOW; }
        e.count++;
        rl.set(key, e);
        if (e.count > RL_MAX) return res.status(429).json({ error: 'Too many requests' });
        next();
    });

    // Camera frames go to the CV service unparsed (one-service deploy only).
    if (process.env.CV_SERVICE_URL) app.use('/cv', cvProxy(process.env.CV_SERVICE_URL));

    app.use(express.json({ limit: '256kb' })); // tight cap (was 5mb -> DoS surface)

    app.locals.pool = pool;

    // Public routes
    app.use('/api/enroll', enrollRoutes);    // customer: OTP, sign-in, create wallet
    app.use('/api/merchant', merchantRoutes); // merchant: OTP sign-in, dashboard, cash-out (own auth inside)
    app.use('/api/paypal', paypalRoutes);     // JS SDK config + signature-verified webhooks
    app.use('/api/voice', voiceRoutes);
    app.use('/api/demo', demoRoutes);         // "Try the demo" (DEMO_MODE only)

    // Protected routes. Each token audience only opens its own routes.
    app.use('/api/payment', authenticate('merchant'), paymentRoutes); // merchant device
    app.use('/api/wallet', authenticate('customer'), walletRoutes);   // customer's own phone
    app.use('/api/family', authenticate('customer'), familyRoutes);
    app.use('/api/assistant', authenticate('merchant'), assistantRoutes); // GLM on Bedrock + PayPal Agent Toolkit

    // Health check
    app.get('/health', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok', db: 'connected', uptime: process.uptime() });
        } catch (err) {
            res.status(503).json({ status: 'error', db: 'disconnected' });
        }
    });

    // The built web app (one-service deploy only).
    if (process.env.FRONTEND_DIR) app.use(webApp(process.env.FRONTEND_DIR));

    app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

    app.use((err, req, res, next) => {
        if (err && /CORS/.test(err.message)) return res.status(403).json({ error: 'Origin not allowed' });
        if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
        if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
        console.error('Unhandled error:', err);
        // Never echo internal error text (SQL, stack details) to clients; it is in the log.
        res.status(500).json({ error: 'Internal server error' });
    });
    return app;
}

module.exports = { createApp };
