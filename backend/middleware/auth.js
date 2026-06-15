/**
 * Authn/authz middleware (ARCHITECTURE §4.10, threat "Authorization bypass").
 *
 * Fixes:
 *  - FAIL CLOSED: no 'dev_jwt_secret_key' default. Missing JWT_SECRET => boot refused.
 *  - User-scoped token (a user owns many wallets and may be a delegate) instead of a
 *    single embedded walletId that cannot even represent the data model.
 *  - requireWalletOwnership: every state-changing wallet route must prove the caller
 *    owns/controls the target wallet. The old routes took wallet_id from the body
 *    with no check, so any valid JWT could drain/refund/extend/hijack ANY wallet.
 */
const jwt = require('jsonwebtoken');

const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

function secret() {
    const s = process.env.JWT_SECRET;
    if (!s || s.length < 16) {
        throw new Error('FATAL: JWT_SECRET missing or too short (fail-closed). Provision via Vault/KMS.');
    }
    return s;
}

/** Token is scoped to the USER. */
function generateToken(userId) {
    return jwt.sign({ userId }, secret(), { expiresIn: JWT_EXPIRY });
}

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
        req.user = jwt.verify(token, secret());
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
}

/**
 * Authorization guard: the caller (req.user.userId) must own the wallet identified
 * by req.body[field] (or req.params[field]). Also allows an active delegate of the
 * wallet. Attaches req.wallet on success.
 */
function requireWalletOwnership(field = 'wallet_id') {
    return async function (req, res, next) {
        const pool = req.app.locals.pool;
        const walletId = req.body[field] || req.params[field];
        if (!walletId) return res.status(400).json({ error: `${field} required` });
        if (!req.user || !req.user.userId) return res.status(401).json({ error: 'Authentication required' });

        try {
            const owner = await pool.query(
                'SELECT * FROM wallets WHERE id = $1 AND user_id = $2',
                [walletId, req.user.userId]
            );
            if (owner.rows.length > 0) {
                req.wallet = owner.rows[0];
                req.isDelegateCaller = false;
                return next();
            }
            // Allow an active delegate of this wallet to act within their cap.
            const deleg = await pool.query(
                `SELECT w.* FROM delegated_wallets dw
                   JOIN wallets w ON dw.parent_wallet_id = w.id
                  WHERE dw.parent_wallet_id = $1 AND dw.delegate_subject_id = $2 AND dw.active = true`,
                [walletId, req.user.userId]
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

module.exports = { generateToken, authenticateToken, requireWalletOwnership };
