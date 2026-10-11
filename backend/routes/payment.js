/**
 * Merchant-device payment flow. Every route needs a
 * signed-in merchant.
 *
 *   1. POST /identify  The customer scans a finger or their face. 1:N match ->
 *                      short-lived pay session. A customer who chose 'both' is
 *                      asked for the other scan next (1:1 against the same person).
 *   2. The merchant enters the bill amount.
 *   3. POST /pay       The customer types their PIN. Limits + risk check -> unified
 *                      debit; the merchant's balance is then paid out to their
 *                      registered PayPal account (PayPal Payouts).
 *   4. The session is consumed by that one payment and the terminal clears itself,
 *      like a card leaving the reader. POST /cancel ends a session early and every
 *      session expires after PAY_SESSION_TTL seconds.
 *
 * Distress: the customer's distress finger satisfies the fingerprint step exactly
 * like their payment finger, so the screens, response shapes and step count are the
 * same. The flag is stored only in pay_sessions; the debit is capped and a silent
 * SOS goes to the emergency contact.
 */
const express = require('express');
const router = express.Router();

const { AUD, sign, verify } = require('../middleware/auth');
const { dollarsToCents, usd } = require('../middleware/validate');
const biometric = require('../services/biometric');
const pin = require('../services/pin');
const risk = require('../services/risk');
const payments = require('../services/payments');
const payouts = require('../services/payouts');
const ledger = require('../services/ledger');
const notifications = require('../services/notifications');
const elastic = require('../services/elastic');
const audit = require('../services/audit');

const SESSION_TTL_SECONDS = Number(process.env.PAY_SESSION_TTL || 120);
const MAX_FAILED_SCANS = 3;
const DISTRESS_CAP_CENTS = Number(process.env.DISTRESS_CAP_CENTS || 2500);           // $25
const PER_PAYMENT_LIMIT_CENTS = Number(process.env.PER_PAYMENT_LIMIT_CENTS || 10000); // $100

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Every route acts as a registered, active merchant.
router.use(h(async (req, res, next) => {
    const r = await req.app.locals.pool.query(
        'SELECT * FROM merchants WHERE id = $1 AND active = true', [req.user.id]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Merchant account not found', code: 'auth_required' });
    req.merchant = r.rows[0];
    next();
}));

// ---- helpers ----------------------------------------------------------------

/** Which scan this session still needs, or null when identification is complete. */
function nextScan(s) {
    const m = s.methods_required;
    if ((m === 'fingerprint' || m === 'both') && !s.fingerprint_ok) return 'fingerprint';
    if ((m === 'face' || m === 'both') && !s.face_ok) return 'face';
    return null;
}

function isLive(s) {
    return !s.consumed_at && new Date(s.expires_at) > new Date();
}

async function endSession(pool, sessionId) {
    await pool.query(
        'UPDATE pay_sessions SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL', [sessionId]
    );
}

/** Verify a pay-session token for this merchant. Returns the session row or null. */
async function loadSession(pool, token, merchantId) {
    let claims;
    try { claims = verify(String(token || ''), AUD.paySession); } catch { return null; }
    if (claims.mid !== merchantId) return null;
    const r = await pool.query('SELECT * FROM pay_sessions WHERE id = $1 AND merchant_id = $2', [claims.sid, merchantId]);
    return r.rows[0] || null;
}

async function customerLabel(pool, session) {
    const r = await pool.query(
        `SELECT u.phone AS subject_phone, o.phone AS owner_phone
           FROM users u, wallets w JOIN users o ON o.id = w.user_id
          WHERE u.id = $1 AND w.id = $2`,
        [session.subject_id, session.wallet_id]
    );
    const row = r.rows[0] || {};
    if (row.subject_phone) return `Customer ••${String(row.subject_phone).slice(-4)}`;
    return `Family member of ••${String(row.owner_phone || '').slice(-4)}`;
}

async function sessionView(pool, session, token) {
    const next = nextScan(session);
    return {
        session_token: token,
        ready: !next,
        next_scan: next,
        expires_at: session.expires_at,
        customer_label: await customerLabel(pool, session),
    };
}

// Templates eligible for 1:N: the method must be one the customer chose, and the
// customer must have an active wallet (as owner or delegate).
async function candidateTemplates(pool, method) {
    const r = await pool.query(
        `SELECT bt.* FROM biometric_templates bt
           JOIN users u ON u.id = bt.subject_id
          WHERE bt.active = true AND bt.template_type = $1
            AND (u.id_method = $1 OR u.id_method = 'both')
            AND (
              EXISTS (SELECT 1 FROM wallets w
                       WHERE w.user_id = bt.subject_id AND w.active = true AND w.expiry > NOW())
              OR EXISTS (SELECT 1 FROM delegated_wallets dw JOIN wallets w2 ON dw.parent_wallet_id = w2.id
                          WHERE dw.delegate_subject_id = bt.subject_id AND dw.active = true
                            AND (dw.per_delegate_expiry IS NULL OR dw.per_delegate_expiry > NOW())
                            AND w2.active = true AND w2.expiry > NOW())
            )`,
        [method]
    );
    return r.rows;
}

// The customer's active wallet: their own first, then one they are a delegate on.
async function resolveWallet(pool, subjectId) {
    const own = await pool.query(
        `SELECT * FROM wallets WHERE user_id = $1 AND active = true AND expiry > NOW()
          ORDER BY created_at DESC LIMIT 1`, [subjectId]
    );
    if (own.rows.length) return { wallet: own.rows[0], isDelegate: false };
    const deleg = await pool.query(
        `SELECT w.* FROM delegated_wallets dw JOIN wallets w ON dw.parent_wallet_id = w.id
          WHERE dw.delegate_subject_id = $1 AND dw.active = true
            AND (dw.per_delegate_expiry IS NULL OR dw.per_delegate_expiry > NOW())
            AND w.active = true AND w.expiry > NOW()
          ORDER BY w.created_at DESC LIMIT 1`, [subjectId]
    );
    if (deleg.rows.length) return { wallet: deleg.rows[0], isDelegate: true };
    return null;
}

const distressDispatched = new Set(); // session ids (Redis set in prod)

function dispatchDistress(pool, { session, merchant, gps }) {
    // Fire-and-forget and idempotent per session: never delays or changes the response.
    if (distressDispatched.has(session.id)) return;
    distressDispatched.add(session.id);
    (async () => {
        const r = await pool.query(
            `SELECT u.emergency_contact, o.phone AS owner_phone
               FROM users u, wallets w JOIN users o ON o.id = w.user_id
              WHERE u.id = $1 AND w.id = $2`,
            [session.subject_id, session.wallet_id]
        );
        const row = r.rows[0] || {};
        notifications.silentSOS({
            transactionId: `distress:${session.id}`,
            // A delegate's alert goes to the wallet owner. Never to the customer's own
            // phone: in this product it is usually at home.
            contact: row.emergency_contact || (session.is_delegate ? row.owner_phone : null),
            userName: 'A PulsePay customer',
            gpsLat: gps.lat, gpsLng: gps.lng,
            place: merchant.display_name,
        });
        await pool.query(
            `INSERT INTO aml_alerts (identity_id, rule_id, risk_score, alert_type) VALUES ($1,'duress',100,'distress')`,
            [session.subject_id]
        );
    })().catch((e) => console.error('distress dispatch failed:', e.message));
}

function gpsFrom(body) {
    const lat = Number(body.gps_lat), lng = Number(body.gps_lng);
    const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    return ok ? { lat, lng } : { lat: null, lng: null };
}

// ---- routes -----------------------------------------------------------------

// POST /api/payment/identify  { method: 'fingerprint'|'face', embedding:[...], session_token? }
router.post('/identify', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const { method, embedding, session_token } = req.body || {};
    if (!['fingerprint', 'face'].includes(method)) {
        return res.status(400).json({ error: "method must be 'fingerprint' or 'face'" });
    }
    if (!biometric.isEmbedding(embedding)) return res.status(400).json({ error: 'A valid scan is required' });

    // --- second scan for a customer who chose 'both' (1:1 against the same person)
    if (session_token) {
        const session = await loadSession(pool, session_token, req.merchant.id);
        if (!session || !isLive(session)) {
            return res.status(410).json({ error: 'Session ended. Start again.', expired: true });
        }
        const need = nextScan(session);
        if (!need) return res.json(await sessionView(pool, session, session_token));
        if (method !== need) return res.status(400).json({ error: `Scan the customer's ${need}` });

        const own = await pool.query(
            `SELECT * FROM biometric_templates
              WHERE subject_id = $1 AND template_type = $2 AND active = true`,
            [session.subject_id, method]
        );
        const m = biometric.identify(embedding, own.rows);
        if (!m || m.ambiguous) {
            const f = await pool.query(
                `UPDATE pay_sessions
                    SET failed_scans = failed_scans + 1,
                        consumed_at = CASE WHEN failed_scans + 1 >= $2 THEN NOW() ELSE consumed_at END
                  WHERE id = $1 RETURNING consumed_at`,
                [session.id, MAX_FAILED_SCANS]
            );
            await audit.append(pool, { action: 'identify_second_scan_fail', subjectUserId: session.subject_id, resourceRef: session.id, ip: req.ip });
            if (f.rows[0]?.consumed_at) {
                return res.status(410).json({ error: 'Too many failed scans. Start again.', expired: true });
            }
            return res.status(401).json({ error: 'Not recognised. Please scan again.' });
        }
        const upd = await pool.query(
            `UPDATE pay_sessions
                SET fingerprint_ok = fingerprint_ok OR $2, face_ok = face_ok OR $3,
                    distress = distress OR $4, confidence_score = LEAST(confidence_score, $5)
              WHERE id = $1 AND consumed_at IS NULL RETURNING *`,
            [session.id, method === 'fingerprint', method === 'face', m.purpose === 'distress', m.confidence_score]
        );
        if (!upd.rows.length) return res.status(410).json({ error: 'Session ended. Start again.', expired: true });
        return res.json(await sessionView(pool, upd.rows[0], session_token));
    }

    // --- first scan: 1:N identification
    const match = biometric.identify(embedding, await candidateTemplates(pool, method));
    if (!match) {
        await audit.append(pool, { action: 'identify_no_match', resourceRef: req.merchant.id, ip: req.ip });
        return res.status(404).json({ error: 'Not recognised. Try again, or try the other scan.' });
    }
    if (match.ambiguous) {
        await audit.append(pool, { action: 'identify_ambiguous', resourceRef: req.merchant.id, ip: req.ip });
        return res.status(422).json({ error: 'Scan was not clear enough. Please scan again.' });
    }

    const resolved = await resolveWallet(pool, match.subject_id);
    if (!resolved) return res.status(404).json({ error: 'No active PulsePay wallet. Ask the customer to top up in the app.' });

    const u = await pool.query('SELECT id_method FROM users WHERE id = $1', [match.subject_id]);
    const ins = await pool.query(
        `INSERT INTO pay_sessions
           (merchant_id, subject_id, wallet_id, is_delegate, distress, methods_required,
            fingerprint_ok, face_ok, confidence_score, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
            req.merchant.id, match.subject_id, resolved.wallet.id, resolved.isDelegate,
            match.purpose === 'distress', u.rows[0].id_method,
            method === 'fingerprint', method === 'face', match.confidence_score,
            new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
        ]
    );
    const session = ins.rows[0];
    const token = sign(AUD.paySession, { sid: session.id, mid: req.merchant.id }, `${SESSION_TTL_SECONDS}s`);
    await audit.append(pool, { action: 'customer_identified', subjectUserId: match.subject_id, resourceRef: session.id, ip: req.ip });
    res.json(await sessionView(pool, session, token));
}));

// POST /api/payment/pay  { session_token, amount (dollars), pin, gps_lat?, gps_lng? }
router.post('/pay', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const body = req.body || {};
    const session = await loadSession(pool, body.session_token, req.merchant.id);
    if (!session) return res.status(410).json({ error: 'Session ended. Start again.', expired: true });

    const requestId = `pay:${session.id}`;
    const gps = gpsFrom(body);
    const meta = {
        requestId, walletId: session.wallet_id, kind: 'payment',
        counterAccount: ledger.merchantAccount(req.merchant.id), counterparty: req.merchant.display_name,
        merchantId: req.merchant.id,
        delegateSubjectId: session.is_delegate ? session.subject_id : null, paySessionId: session.id,
        confidence: session.confidence_score, authTier: `${session.methods_required}+pin`,
        distress: session.distress, gps,
    };
    const send = (out) => {
        if (out.ok) {
            return res.json({ status: out.status, transaction_id: out.transaction_id, payment_ref: out.payment_ref, timestamp: out.timestamp });
        }
        return res.status(out.http).json({ status: out.status, error: out.error, ...(out.payment_ref ? { payment_ref: out.payment_ref } : {}) });
    };

    // A retry of a payment that already started reports / reconciles it.
    const prior = await pool.query('SELECT 1 FROM ledger_entries WHERE idempotency_key = $1', [`${requestId}:wallet`]);
    if (prior.rows.length) return send(await payments.debit(pool, meta));

    if (!isLive(session)) return res.status(410).json({ error: 'Session ended. Start again.', expired: true });
    if (nextScan(session)) return res.status(400).json({ error: 'Customer identification is not complete' });

    let amountCents = dollarsToCents(body.amount);
    if (!amountCents) return res.status(400).json({ error: 'Enter a valid amount' });
    if (amountCents > PER_PAYMENT_LIMIT_CENTS) {
        return res.status(400).json({ error: `PulsePay allows up to ${usd(PER_PAYMENT_LIMIT_CENTS)} per payment` });
    }

    const pinResult = await pin.checkPin(pool, session.subject_id, body.pin);
    if (!pinResult.ok) {
        await audit.append(pool, { action: 'pay_pin_fail', subjectUserId: session.subject_id, resourceRef: session.id, ip: req.ip });
        if (pinResult.locked) await endSession(pool, session.id);
        return pin.pinFailure(res, pinResult);
    }

    if (session.distress) {
        amountCents = Math.min(amountCents, DISTRESS_CAP_CENTS); // bounded loss; reversal is best-effort
        dispatchDistress(pool, { session, merchant: req.merchant, gps });
    }

    const verdict = await risk.assess({
        amountCents, now: new Date(), spendingHistory: await payments.recentSpend(pool, session.wallet_id),
    });
    if (verdict.decision === 'decline') {
        await endSession(pool, session.id);
        await audit.append(pool, { action: 'pay_risk_declined', subjectUserId: session.subject_id, resourceRef: session.id, ip: req.ip });
        return res.status(403).json({ status: 'declined', error: 'Payment declined by the risk check' });
    }

    const out = await payments.debit(pool, {
        ...meta,
        amountCents,
        // Consume the session in the same transaction as the reservation: one session, one payment.
        beforeReserve: async (client) => {
            const c = await client.query(
                `UPDATE pay_sessions SET consumed_at = NOW()
                  WHERE id = $1 AND consumed_at IS NULL AND expires_at > NOW() RETURNING id`,
                [session.id]
            );
            if (!c.rowCount) {
                const e = new Error('session_unavailable');
                e.code = 'session_unavailable';
                throw e;
            }
        },
    });

    if (out.ok) {
        await audit.append(pool, {
            action: session.distress ? 'payment_distress' : 'payment_settled',
            subjectUserId: session.subject_id, resourceRef: session.wallet_id, ip: req.ip,
        });
        const owner = await pool.query(
            'SELECT u.phone FROM wallets w JOIN users u ON u.id = w.user_id WHERE w.id = $1', [session.wallet_id]
        );
        notifications.paymentSms({
            phone: owner.rows[0]?.phone, amountCents, merchant: req.merchant.display_name,
            balanceCents: out.remaining_balance,
        });
        if (payouts.instantMode()) {
            payouts.queueAndSubmit(pool, {
                merchantId: req.merchant.id, account: ledger.merchantAccount(req.merchant.id),
                recipientEmail: req.merchant.paypal_email, amountCents, sourceRequest: requestId,
                simulated: req.merchant.is_demo || undefined,
            });
        }
        elastic.index({
            type: 'payment', merchant_id: req.merchant.id, merchant: req.merchant.display_name,
            transaction_id: out.transaction_id, amount_usd: amountCents / 100,
            verified_by: `${session.methods_required} + PIN`, match_score: session.confidence_score,
        });
    }
    // Same response shape for normal and distress payments; no balance on a merchant screen.
    return send(out);
}));

// POST /api/payment/cancel  { session_token } — the customer walked away or the merchant reset.
router.post('/cancel', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const session = await loadSession(pool, req.body?.session_token, req.merchant.id);
    if (session) await endSession(pool, session.id);
    res.json({ cancelled: true });
}));

module.exports = router;
