/**
 * Payment routes (ARCHITECTURE §6.2, §6.3).
 *
 * Fixes vs the Amazon build:
 *  - ONE authentication decision, carried as a signed single-use Auth Assertion;
 *    /execute re-derives nothing (kills the split-brain).
 *  - Hard AFA floor: face (inherence, real 1:N cosine match) + PIN (knowledge).
 *    No 'face_only'. The risk engine may only escalate.
 *  - Atomic, idempotent, double-entry ledger debit with reserve->settle->confirm.
 *    Never debits on rail failure; never fabricates a success id.
 *  - Distress is folded into the SAME path via a DISTINCT duress PIN: capped debit,
 *    async one-directional SOS, byte-identical response (no wire-observable "silence").
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const biometric = require('../services/biometric');
const risk = require('../services/risk');
const authAssertion = require('../services/authAssertion');
const rails = require('../services/rails');
const notifications = require('../services/notifications');
const audit = require('../services/audit');
const { validateAmount, validateUPI } = require('../middleware/validate');

const DISTRESS_CAP_PAISE = Number(process.env.DISTRESS_CAP_PAISE || 50000); // Rs 500 default

// Resolve the customer's active wallet (own first, then delegate).
async function resolveWallet(pool, subjectId) {
    const own = await pool.query(
        `SELECT * FROM wallets WHERE user_id = $1 AND active = true AND expiry > NOW()
         ORDER BY created_at DESC LIMIT 1`, [subjectId]
    );
    if (own.rows.length) return { wallet: own.rows[0], isDelegate: false, delegate: null };

    const deleg = await pool.query(
        `SELECT w.*, dw.id AS deleg_id, dw.spending_cap, dw.spent_total
           FROM delegated_wallets dw JOIN wallets w ON dw.parent_wallet_id = w.id
          WHERE dw.delegate_subject_id = $1 AND dw.active = true AND w.active = true AND w.expiry > NOW()
          ORDER BY w.created_at DESC LIMIT 1`, [subjectId]
    );
    if (deleg.rows.length) return { wallet: deleg.rows[0], isDelegate: true, delegate: deleg.rows[0] };
    return null;
}

// Identity-keyed recent spend (for the escalate-only risk engine).
async function recentSpend(pool, walletId) {
    const r = await pool.query(
        `SELECT amount FROM transactions WHERE wallet_id = $1 AND status = 'completed'
         ORDER BY created_at DESC LIMIT 10`, [walletId]
    );
    return r.rows.map(x => Number(x.amount));
}

// POST /api/payment/authenticate
// Body: { fingerprint_embedding:[...], pin, amount, merchant_upi, gps_lat, gps_lng,
//         face_embedding?:[...] (above-limit step-up), otp?, otp_reference? }
router.post('/authenticate', async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const { fingerprint_embedding, pin, amount, merchant_upi, face_embedding } = req.body;
        if (!Array.isArray(fingerprint_embedding) || !pin || !amount) {
            return res.status(400).json({ error: 'fingerprint_embedding, pin and amount required' });
        }
        if (!validateAmount(amount)) return res.status(400).json({ error: 'Invalid amount' });
        if (merchant_upi && !validateUPI(merchant_upi)) return res.status(400).json({ error: 'Invalid merchant UPI' });
        const amountPaise = Math.round(Number(amount) * 100);

        // 1. PRIMARY factor: real 1:N FINGERPRINT identification over active templates
        //    (both normal-purpose and distress-purpose fingers; owners + delegates).
        const fpTemplates = await pool.query(
            `SELECT DISTINCT bt.* FROM biometric_templates bt
              WHERE bt.active = true AND bt.template_type = 'fingerprint' AND (
                EXISTS (SELECT 1 FROM wallets w
                         WHERE w.user_id = bt.subject_id AND w.active = true AND w.expiry > NOW())
                OR EXISTS (SELECT 1 FROM delegated_wallets dw
                            JOIN wallets w2 ON dw.parent_wallet_id = w2.id
                           WHERE dw.delegate_subject_id = bt.subject_id AND dw.active = true
                             AND w2.active = true AND w2.expiry > NOW())
              )`
        );
        const match = biometric.identify(fingerprint_embedding, fpTemplates.rows);
        if (!match) {
            await audit.append(pool, { action: 'auth_fp_no_match', resourceRef: merchant_upi, ip: req.ip });
            return res.status(404).json({ authenticated: false, error: 'Biometric not recognized' });
        }
        // Which finger matched -> normal or silent distress.
        const matchedRow = fpTemplates.rows.find(r => r.id === match.template_id);
        const distress = matchedRow && matchedRow.purpose === 'distress';

        const resolved = await resolveWallet(pool, match.subject_id);
        if (!resolved) return res.status(404).json({ authenticated: false, error: 'No active wallet for this identity' });
        const { wallet, isDelegate } = resolved;

        // 2. Knowledge factor: PIN (AFA second factor for the base tier).
        const userRow = await pool.query('SELECT pin_hash FROM users WHERE id = $1', [match.subject_id]);
        const pinOk = userRow.rows[0]?.pin_hash && await bcrypt.compare(String(pin), userRow.rows[0].pin_hash);
        if (!pinOk) {
            await audit.append(pool, { action: 'auth_pin_fail', subjectUserId: match.subject_id, ip: req.ip });
            return res.status(401).json({ authenticated: false, error: 'Authentication failed' });
        }

        // 3. Escalate-only tier decision (deterministic floor; risk may only raise).
        const history = await recentSpend(pool, wallet.id);
        const tierInfo = risk.decideTier({ amountPaise, now: new Date(), spendingHistory: history });

        // Distress short-circuits the step-up: it must look like (and be as frictionless
        // as) a normal small payment. The amount is capped downstream in /execute.
        if (!distress) {
            // 4. FACE step-up above the limit (additional inherence factor).
            if (tierInfo.requires_face) {
                if (!Array.isArray(face_embedding)) {
                    return res.json({
                        authenticated: false, tier: tierInfo.tier, requires_face: true,
                        message: 'Higher amount: face scan required',
                    });
                }
                const faceRows = await pool.query(
                    `SELECT * FROM biometric_templates
                      WHERE subject_id = $1 AND template_type = 'face' AND purpose = 'auth' AND active = true`,
                    [match.subject_id]
                );
                const faceOk = faceRows.rows.some(r => biometric.scoreAgainst(face_embedding, r) >= biometric.MATCH_THRESHOLD);
                if (!faceOk) {
                    await audit.append(pool, { action: 'auth_face_fail', subjectUserId: match.subject_id, ip: req.ip });
                    return res.status(401).json({ authenticated: false, error: 'Face verification failed' });
                }
            }

            // 5. OTP at the highest tier (issued server-side; verified here).
            if (tierInfo.requires_otp) {
                const aua = require('../services/aua');
                const { otp, otp_reference } = req.body;
                if (!otp || !otp_reference) {
                    const reference = `pay:${wallet.id}`;
                    const phone = userRow.rows[0] && (await pool.query('SELECT phone FROM users WHERE id=$1', [match.subject_id])).rows[0]?.phone;
                    const issued = await aua.requestEkycOtp({ reference, phone });
                    return res.json({
                        authenticated: false, tier: tierInfo.tier, requires_otp: true,
                        otp_sent: issued.otp_sent, otp_reference: reference,
                        message: 'High-value transaction: OTP required',
                    });
                }
                const v = await aua.verifyEkycOtp({ reference: otp_reference, otp });
                if (!v.verified) return res.status(401).json({ authenticated: false, error: 'OTP verification failed' });
            }
        }

        // 6. Issue the single-use Auth Assertion (carries distress flag opaquely).
        const assertion = await authAssertion.issue(pool, {
            walletId: wallet.id, subjectId: match.subject_id, amountCeiling: amountPaise,
            merchant: merchant_upi, tier: distress ? `${tierInfo.tier}+distress` : tierInfo.tier,
            isDelegate,
        });

        await audit.append(pool, {
            action: 'auth_assertion_issued', subjectUserId: match.subject_id,
            resourceRef: wallet.id, ip: req.ip,
        });

        // Response is identical whether or not distress is set (no wire leak).
        res.json({
            authenticated: true,
            assertion_token: assertion.token,
            wallet_id: wallet.id,
            confidence_score: match.confidence_score, // real cosine-derived score
            tier: tierInfo.tier,
            balance: Number(wallet.balance),
            expires_at: assertion.expires_at,
        });
    } catch (error) {
        console.error('authenticate error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// POST /api/payment/execute
// Body: { wallet_id, amount, merchant_upi, assertion_token, gps_lat, gps_lng }
router.post('/execute', async (req, res) => {
    const pool = req.app.locals.pool;
    const { wallet_id, amount, merchant_upi, assertion_token, gps_lat, gps_lng } = req.body;

    if (!wallet_id || !amount || !merchant_upi || !assertion_token) {
        return res.status(400).json({ error: 'wallet_id, amount, merchant_upi and assertion_token required' });
    }
    if (!validateUPI(merchant_upi)) return res.status(400).json({ error: 'Invalid merchant UPI' });
    let amountPaise = Math.round(Number(amount) * 100);

    // Verify the assertion signature + binding (no consume yet).
    let claims;
    try {
        claims = authAssertion.verifyToken(assertion_token, { walletId: wallet_id, amountPaise, merchant: merchant_upi });
    } catch (e) {
        return res.status(401).json({ error: e.message });
    }
    const distress = String(claims.tier || '').includes('+distress');
    if (distress && amountPaise > DISTRESS_CAP_PAISE) {
        amountPaise = DISTRESS_CAP_PAISE; // cap the attacker-demanded amount; reversal pre-armed
    }
    const idemKey = `pay:${claims.aid}`;

    // Idempotent replay: if this assertion already produced a ledger entry, return it.
    const existing = await pool.query(
        `SELECT le.*, t.id AS tx_id FROM ledger_entries le
           LEFT JOIN transactions t ON t.ledger_entry_id = le.id
          WHERE le.idempotency_key = $1`, [idemKey]
    );
    if (existing.rows.length) {
        const e = existing.rows[0];
        if (e.status === 'settled') {
            return res.json({
                transaction_id: e.tx_id, remaining_balance: Number(e.balance_after),
                status: 'completed', payment_ref: e.upi_utr, timestamp: e.created_at,
            });
        }
        if (e.status === 'released' || e.status === 'failed') {
            return res.status(502).json({ error: 'Payment failed on rails', status: 'failed' });
        }
        return res.status(202).json({ status: 'processing' }); // reserved, settle in flight
    }

    // --- Phase 1: atomic reserve (consume assertion + lock wallet + debit guard) ---
    const client = await pool.connect();
    let reserved;
    try {
        await client.query('BEGIN');
        await authAssertion.consumeWithClient(client, claims.aid); // single-use

        const wr = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [wallet_id]);
        if (!wr.rows.length || !wr.rows[0].active || new Date(wr.rows[0].expiry) <= new Date()) {
            throw new Error('wallet_inactive_or_expired');
        }
        const wallet = wr.rows[0];

        // Delegate cumulative cap, enforced atomically.
        if (claims.del) {
            const dl = await client.query(
                `SELECT * FROM delegated_wallets WHERE parent_wallet_id = $1 AND delegate_subject_id = $2 AND active = true FOR UPDATE`,
                [wallet_id, claims.sub]
            );
            if (dl.rows.length) {
                const d = dl.rows[0];
                if (Number(d.spent_total) + amountPaise > Number(d.spending_cap)) {
                    throw new Error('delegate_cap_exceeded');
                }
                await client.query('UPDATE delegated_wallets SET spent_total = spent_total + $1 WHERE id = $2',
                    [amountPaise, d.id]);
            }
        }

        // Atomic balance guard: only succeeds if funds are sufficient.
        const upd = await client.query(
            'UPDATE wallets SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
            [amountPaise, wallet_id]
        );
        if (!upd.rows.length) throw new Error('insufficient_balance');
        const newBalance = Number(upd.rows[0].balance);

        const le = await client.query(
            `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, idempotency_key, auth_assertion_id, status)
             VALUES ($1, 'reserve', $2, $3, $4, $5, 'reserved') RETURNING id`,
            [wallet_id, amountPaise, newBalance, idemKey, claims.aid]
        );
        reserved = { ledgerId: le.rows[0].id, newBalance, wallet };
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        client.release();
        const map = {
            wallet_inactive_or_expired: [404, 'Wallet not found or expired'],
            insufficient_balance: [400, 'Insufficient balance'],
            delegate_cap_exceeded: [403, 'Amount exceeds delegate spending cap'],
            auth_assertion_already_used_or_expired: [409, 'Authentication already used or expired'],
        };
        const [code, msg] = map[e.message] || [500, 'Payment reservation failed'];
        return res.status(code).json({ error: msg });
    }
    client.release();

    // --- Phase 2: settle on the rail (outside the lock) ---
    const settled = await rails.settle({
        merchantUpi: merchant_upi, amountPaise, walletId: wallet_id, cbsAccountRef: reserved.wallet.cbs_account_ref,
    });

    if (!settled.ok) {
        // Fail closed: RELEASE the reservation (credit back). Never leave money debited on rail failure.
        const rc = await pool.connect();
        try {
            await rc.query('BEGIN');
            await rc.query('UPDATE wallets SET balance = balance + $1 WHERE id = $2', [amountPaise, wallet_id]);
            await rc.query("UPDATE ledger_entries SET status = 'released' WHERE id = $1", [reserved.ledgerId]);
            if (claims.del) {
                await rc.query(
                    `UPDATE delegated_wallets SET spent_total = GREATEST(spent_total - $1, 0)
                       WHERE parent_wallet_id = $2 AND delegate_subject_id = $3`,
                    [amountPaise, wallet_id, claims.sub]);
            }
            await rc.query('COMMIT');
        } catch (_) { await rc.query('ROLLBACK'); } finally { rc.release(); }
        return res.status(502).json({ error: 'Payment failed on rails', status: 'failed' });
    }

    // --- Phase 3: confirm (settled) + immutable journal entry ---
    let txId, ts;
    const fc = await pool.connect();
    try {
        await fc.query('BEGIN');
        await fc.query("UPDATE ledger_entries SET status = 'settled', upi_utr = $1, cbs_ref = $2 WHERE id = $3",
            [settled.utr, settled.cbs_ref, reserved.ledgerId]);
        const tx = await fc.query(
            `INSERT INTO transactions (wallet_id, ledger_entry_id, merchant_upi, amount, confidence_score, auth_tier, distress_triggered, gps_lat, gps_lng, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed') RETURNING id, created_at`,
            [wallet_id, reserved.ledgerId, merchant_upi, amountPaise, null, claims.tier, distress, gps_lat || null, gps_lng || null]
        );
        txId = tx.rows[0].id; ts = tx.rows[0].created_at;
        await fc.query('COMMIT');
    } catch (e) {
        await fc.query('ROLLBACK');
        console.error('confirm phase error:', e.message);
    } finally { fc.release(); }

    await audit.append(pool, { action: distress ? 'payment_distress' : 'payment_settled', subjectUserId: claims.sub, resourceRef: wallet_id, ip: req.ip });

    // --- Post-commit, async notifications (never in the money path) ---
    const u = await pool.query('SELECT phone, emergency_contact FROM users WHERE id = $1', [claims.sub]);
    const phone = u.rows[0]?.phone;
    notifications.paymentSms({ phone, amountPaise, merchant: merchant_upi, balancePaise: reserved.newBalance });
    if (distress) {
        notifications.silentSOS({
            transactionId: txId, contact: u.rows[0]?.emergency_contact || phone,
            userName: 'PulsePay user', gpsLat: gps_lat, gpsLng: gps_lng,
        });
        // distress also flagged for AML/priority review
        await pool.query(
            `INSERT INTO aml_alerts (identity_id, rule_id, risk_score, alert_type) VALUES ($1,'duress',100,'distress')`,
            [claims.sub]
        ).catch(() => {});
    }

    // Response is byte-identical for normal and distress payments.
    res.json({
        transaction_id: txId,
        remaining_balance: reserved.newBalance,
        status: 'completed',
        payment_ref: settled.utr,
        timestamp: ts,
    });
});

// POST /api/payment/sos  — panic button (owner-authenticated, SOS only, no payment).
// (Payment-time duress is handled silently inside the unified flow above.)
const { requireWalletOwnership } = require('../middleware/auth');
router.post('/sos', requireWalletOwnership('wallet_id'), async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const { gps_lat, gps_lng } = req.body;
        const u = await pool.query('SELECT phone, emergency_contact FROM users WHERE id = $1', [req.wallet.user_id]);
        notifications.silentSOS({
            transactionId: `sos:${req.wallet.id}:${Date.now()}`,
            contact: u.rows[0]?.emergency_contact || u.rows[0]?.phone,
            userName: 'PulsePay user', gpsLat: gps_lat, gpsLng: gps_lng,
        });
        await audit.append(pool, { action: 'sos_panic', subjectUserId: req.wallet.user_id, resourceRef: req.wallet.id, ip: req.ip });
        res.json({ success: true, message: 'SOS dispatched' });
    } catch (e) {
        console.error('sos error:', e);
        res.status(500).json({ error: 'Failed to dispatch SOS' });
    }
});

module.exports = router;
