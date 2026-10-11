/**
 * Test data. Money always enters through the real top-up path (services/funding), so
 * the ledger is as consistent as it would be in production.
 *
 * `books` derives ledger facts with plain SQL, independently of services/ledger.js.
 */
const crypto = require('crypto');
const funding = require('../../services/funding');
const pin = require('../../services/pin');
const biometric = require('../../services/biometric');

const digits = (n) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
const PIN = '2580';

async function merchant(pool, { email } = {}) {
    const r = await pool.query(
        'INSERT INTO merchants (phone, display_name, paypal_email) VALUES ($1,$2,$3) RETURNING *',
        [`1415${digits(7)}`, 'Corner Cafe', email || `shop-${digits(8)}@business.example.com`]
    );
    return r.rows[0];
}

async function customer(pool, { idMethod = 'fingerprint', emergencyContact = null } = {}) {
    const r = await pool.query(
        'INSERT INTO users (phone, pin_hash, id_method, emergency_contact) VALUES ($1,$2,$3,$4) RETURNING *',
        [`1650${digits(7)}`, await pin.hashPin(PIN), idMethod, emergencyContact]
    );
    return r.rows[0];
}

async function wallet(pool, userId) {
    const r = await pool.query(
        `INSERT INTO wallets (user_id, expiry, max_lifetime)
         VALUES ($1, NOW() + INTERVAL '72 hours', NOW() + INTERVAL '30 days') RETURNING *`,
        [userId]
    );
    return r.rows[0];
}

/**
 * Add money the way /api/wallet/topup-capture does. `approve` is called with the order id
 * between create and capture (the buyer approving in the PayPal popup), for live rails.
 */
async function topUp(pool, walletId, amountCents, { approve } = {}) {
    const o = await funding.createOrder(pool, { purpose: 'topup', walletId, amountCents });
    if (approve) approve(o.order_id);
    const { order, capture } = await funding.claimAndCapture(pool, o.order_id, { purpose: 'topup', walletId });
    await funding.creditTopUp(pool, { walletId, order, capture });
    return order.order_id;
}

/** Store a biometric template the way enrolment does (cancelable transform + encryption). */
async function enrolScan(pool, userId, embedding, { type = 'fingerprint', purpose = 'auth' } = {}) {
    const t = biometric.protect(embedding);
    await pool.query(
        `INSERT INTO biometric_templates (subject_id, template_type, purpose, protected_vector, enc_iv, enc_tag, transform_salt, kms_key_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [userId, type, purpose, t.protected_vector, t.enc_iv, t.enc_tag, t.transform_salt, t.kms_key_ref]
    );
}

/** A customer with an active wallet holding `cents`. */
async function fundedCustomer(pool, cents, opts = {}) {
    const user = await customer(pool, opts);
    const w = await wallet(pool, user.id);
    if (cents) await topUp(pool, w.id, cents, opts);
    return { user, wallet: w };
}

const books = {
    /** What PulsePay owes on a liability account: credits - debits, ignoring released lines. */
    async owed(pool, account) {
        const r = await pool.query(
            `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END), 0)::bigint AS v
               FROM ledger_entries WHERE account = $1 AND status <> 'released'`, [account]
        );
        return Number(r.rows[0].v);
    },
    /** Money PulsePay holds at PayPal according to the ledger: debits - credits on pool:paypal. */
    async pool(pool) {
        return -(await books.owed(pool, 'pool:paypal'));
    },
    /** request_ids whose lines do not sum to zero. */
    async unbalanced(pool) {
        const r = await pool.query(
            `SELECT request_id FROM ledger_entries WHERE status <> 'released' GROUP BY request_id
             HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0`
        );
        return r.rows.map((x) => x.request_id);
    },
    /** Wallets whose cached balance differs from their ledger balance. */
    async walletDrift(pool) {
        const r = await pool.query(
            `SELECT w.id FROM wallets w
              WHERE w.balance <> COALESCE((SELECT SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)
                                             FROM ledger_entries
                                            WHERE account = 'wallet:' || w.id AND status <> 'released'), 0)`
        );
        return r.rows.map((x) => x.id);
    },
    async rows(pool, account) {
        return (await pool.query('SELECT * FROM ledger_entries WHERE account = $1 ORDER BY created_at', [account])).rows;
    },
};

module.exports = { PIN, merchant, customer, wallet, topUp, enrolScan, fundedCustomer, books };
