require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { authenticateToken, generateToken } = require('./middleware/auth');
const kms = require('./services/kms');

const enrollRoutes = require('./routes/enroll');
const paymentRoutes = require('./routes/payment');
const walletRoutes = require('./routes/wallet');
const familyRoutes = require('./routes/family');
const voiceRoutes = require('./routes/voice');

// --- Fail-closed boot checks (ARCHITECTURE §4.10) ---------------------------
// Refuse to start without the secrets a bank-grade service requires, instead of
// silently falling back to dev defaults / plaintext biometric storage.
(function bootGuards() {
    const errors = [];
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
        errors.push('JWT_SECRET missing or too short (>=16 chars, from Vault/KMS).');
    }
    try { kms.assertAvailable(); } catch (e) { errors.push(e.message); }
    if (process.env.NODE_ENV === 'production' && !process.env.DATABASE_URL) {
        errors.push('DATABASE_URL is required in production.');
    }
    if (errors.length) {
        console.error('FATAL: refusing to start (fail-closed):\n - ' + errors.join('\n - '));
        process.exit(1);
    }
})();

const app = express();
const PORT = process.env.PORT || 5000;

app.disable('x-powered-by');

// Security headers (minimal, no extra deps).
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});

// Scoped CORS — no wildcard. Only configured SBI/merchant origins.
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin(origin, cb) {
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error('CORS: origin not allowed'));
    },
    credentials: true,
}));

app.use(express.json({ limit: '256kb' })); // tight cap (was 5mb -> DoS surface)

// Lightweight in-process rate limiter (per IP). Production: API-gateway/WAF + Redis.
const rl = new Map();
const RL_WINDOW = 60 * 1000, RL_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 120);
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

// DB pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
app.locals.pool = pool;

// Public routes
app.use('/api/enroll', enrollRoutes);
app.use('/api/voice', voiceRoutes);

// Merchant/terminal session (demo): issues a terminal JWT so the merchant PWA can
// call the protected /api/payment/* routes. The customer is still identified by
// biometric 1:N match, not by this token. Production: real merchant onboarding/auth.
app.post('/api/merchant/session', (req, res) => {
    const merchantId = '00000000-0000-4000-8000-000000000000'; // synthetic terminal identity
    res.json({ token: generateToken(merchantId), merchant_upi: req.body?.merchant_upi || null });
});

// Protected routes (JWT required)
app.use('/api/payment', authenticateToken, paymentRoutes);
app.use('/api/wallet', authenticateToken, walletRoutes);
app.use('/api/family', authenticateToken, familyRoutes);

// Health check
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ status: 'ok', db: 'connected', uptime: process.uptime() });
    } catch (err) {
        res.status(503).json({ status: 'error', db: 'disconnected' });
    }
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, next) => {
    if (err && /CORS/.test(err.message)) return res.status(403).json({ error: 'Origin not allowed' });
    console.error('Unhandled error:', err);
    res.status(err.status || 500).json({
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    });
});

const server = app.listen(PORT, () => console.log(`PulsePay-SBI backend running on port ${PORT}`));

const shutdown = async () => {
    console.log('Shutting down gracefully...');
    server.close();
    await pool.end();
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = app;
