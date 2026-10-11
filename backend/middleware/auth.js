/**
 * Authn/authz middleware.
 *
 *  - FAIL CLOSED: no default secret. Missing JWT_SECRET => boot refused.
 *  - Every token carries an AUDIENCE, so one kind can never be replayed as another:
 *      customer    — the wallet owner on their own phone
 *      merchant    — a signed-in merchant device (receives payments)
 *      enrolment   — proof that phone OTP succeeded (15 min)
 *      pay-session — a customer identified at a merchant device (2 min, single payment)
 *  - requireWalletOwnership: every wallet route proves the caller controls the wallet.
 */
const jwt = require('jsonwebtoken');

const AUD = {
    customer: 'pulsepay:customer',
    merchant: 'pulsepay:merchant',
    enrolment: 'pulsepay:enrolment',
    paySession: 'pulsepay:pay-session',
};

const EXPIRY = {
    customer: process.env.JWT_EXPIRY || '24h',
    merchant: process.env.MERCHANT_JWT_EXPIRY || '12h',
};

function secret() {
    const s = process.env.JWT_SECRET;
    if (!s || s.length < 16) {
        throw new Error('FATAL: JWT_SECRET missing or too short (fail-closed). Provision via Vault/KMS.');
    }
    return s;
}

function sign(aud, claims, expiresIn) {
    return jwt.sign(claims, secret(), { audience: aud, expiresIn });
}

/** Verify a token for one audience. Throws on any mismatch. */
function verify(token, aud) {
    return jwt.verify(token, secret(), { audience: aud });
}

/** role: 'customer' | 'merchant' */
function generateToken(role, id) {
    return sign(AUD[role], { sub: id }, EXPIRY[role]);
}

function bearer(req) {
    const h = req.headers['authorization'];
    return h && h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Middleware: require a token of the given role. Sets req.user = { id, role }. */
function authenticate(role) {
    return function (req, res, next) {
        const token = bearer(req);
        if (!token) return res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        try {
            const claims = verify(token, AUD[role]);
            req.user = { id: claims.sub, role };
            next();
        } catch (err) {
            return res.status(401).json({ error: 'Invalid or expired session', code: 'auth_required' });
        }
    };
}

/**
 * Authorization guard: the customer must own the wallet identified by
 * req.body[field] (or req.params[field]), or be an active delegate of it.
 * Attaches req.wallet on success.
 */
function requireWalletOwnership(field = 'wallet_id') {
    return async function (req, res, next) {
        const pool = req.app.locals.pool;
        const walletId = (req.body && req.body[field]) || req.params[field];
        if (!walletId) return res.status(400).json({ error: `${field} required` });
        if (!req.user || req.user.role !== 'customer') return res.status(401).json({ error: 'Authentication required', code: 'auth_required' });
        if (!/^[0-9a-f-]{36}$/i.test(String(walletId))) return res.status(400).json({ error: `Invalid ${field}` });

        try {
            const owner = await pool.query(
                'SELECT * FROM wallets WHERE id = $1 AND user_id = $2',
                [walletId, req.user.id]
            );
            if (owner.rows.length > 0) {
                req.wallet = owner.rows[0];
                req.isDelegateCaller = false;
                return next();
            }
            const deleg = await pool.query(
                `SELECT w.* FROM delegated_wallets dw
                   JOIN wallets w ON dw.parent_wallet_id = w.id
                  WHERE dw.parent_wallet_id = $1 AND dw.delegate_subject_id = $2 AND dw.active = true`,
                [walletId, req.user.id]
            );
            if (deleg.rows.length > 0) {
                req.wallet = deleg.rows[0];
                req.isDelegateCaller = true;
                return next();
            }
            return res.status(403).json({ error: 'Access denied: caller does not control this wallet' });
        } catch (e) {
            console.error('ownership check failed:', e.message);
            return res.status(500).json({ error: 'Authorization check failed' });
        }
    };
}

module.exports = { AUD, sign, verify, generateToken, authenticate, requireWalletOwnership, bearer };
