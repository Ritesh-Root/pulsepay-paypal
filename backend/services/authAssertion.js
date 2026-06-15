/**
 * Auth Assertion service (ARCHITECTURE §4.3).
 *
 * Single source of truth for an authentication decision. /authenticate issues a
 * server-signed, single-use, short-TTL assertion bound to wallet + amount-ceiling
 * + merchant + nonce. /execute CONSUMES it and re-derives nothing — killing the
 * split-brain where the old code recomputed tiers in two places and /execute never
 * re-verified biometrics or that an OTP was actually issued.
 *
 * Persisted in auth_assertions so consumption is atomic (consumed_at set once);
 * a replayed assertion is rejected.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const TTL_SECONDS = Number(process.env.AUTH_ASSERTION_TTL || 90);

function secret() {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('FATAL: JWT_SECRET not set (fail-closed).');
    return s;
}

/**
 * Create + persist an assertion. Returns { token, id, nonce, expires_at }.
 */
async function issue(pool, { walletId, subjectId, amountCeiling, merchant, tier, isDelegate }) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);

    const row = await pool.query(
        `INSERT INTO auth_assertions
         (wallet_id, subject_id, amount_ceiling, merchant, tier, nonce, is_delegate, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
        [walletId, subjectId, amountCeiling, merchant || null, tier, nonce, !!isDelegate, expiresAt]
    );

    const id = row.rows[0].id;
    const token = jwt.sign(
        { aid: id, wallet: walletId, sub: subjectId, ceiling: amountCeiling, merchant: merchant || null, tier, nonce, del: !!isDelegate },
        secret(),
        { expiresIn: `${TTL_SECONDS}s` }
    );
    return { token, id, nonce, expires_at: expiresAt };
}

/**
 * Verify signature + check binding (no DB side-effect). Returns claims or throws.
 */
function verifyToken(token, { walletId, amountPaise, merchant }) {
    let claims;
    try {
        claims = jwt.verify(token, secret());
    } catch (e) {
        throw new Error('auth_assertion_invalid_or_expired');
    }
    if (claims.wallet !== walletId) throw new Error('auth_assertion_wallet_mismatch');
    if (merchant && claims.merchant && claims.merchant !== merchant) {
        throw new Error('auth_assertion_merchant_mismatch');
    }
    if (amountPaise > Number(claims.ceiling)) throw new Error('auth_assertion_amount_exceeds_ceiling');
    return claims;
}

/**
 * Atomically consume (single-use) using a provided client/pool. Only the first
 * caller flips consumed_at. Throws if already used/expired.
 */
async function consumeWithClient(client, assertionId) {
    const upd = await client.query(
        `UPDATE auth_assertions
            SET consumed_at = NOW()
          WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW()
          RETURNING id, tier, subject_id, is_delegate, merchant`,
        [assertionId]
    );
    if (upd.rows.length === 0) throw new Error('auth_assertion_already_used_or_expired');
    return upd.rows[0];
}

/** Convenience: verify + consume on the pool (single-shot, non-transactional callers). */
async function consume(pool, token, binding) {
    const claims = verifyToken(token, binding);
    const row = await consumeWithClient(pool, claims.aid);
    return {
        assertion_id: claims.aid,
        wallet_id: claims.wallet,
        subject_id: row.subject_id,
        tier: row.tier,
        is_delegate: row.is_delegate,
    };
}

module.exports = { issue, verifyToken, consumeWithClient, consume, TTL_SECONDS };
