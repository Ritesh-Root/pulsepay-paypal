/**
 * Wallet routes for the customer's own phone.
 * Every route needs a customer token and proves ownership of the wallet.
 *
 *  - GET  /:wallet_id          balance, limits, history
 *  - POST /topup-order         PayPal order to add money (approved with the JS SDK)
 *  - POST /topup-capture       capture the approved order and credit the wallet
 *  - POST /send                pay someone's PayPal account (PIN + limits + risk; paid by Payouts)
 *  - POST /refund              close the wallet, refund the balance to the PayPal captures
 *  - POST /extend              capped by max_lifetime, extends from now
 *  - POST /reissue-biometric   cancelable re-issue; needs PIN + a matching live scan
 *  - POST /sos                 panic button
 */
const express = require('express');
const router = express.Router();

const { requireWalletOwnership } = require('../middleware/auth');
const { dollarsToCents, validateEmail, usd } = require('../middleware/validate');
const biometric = require('../services/biometric');
const ledger = require('../services/ledger');
const funding = require('../services/funding');
const payments = require('../services/payments');
const payouts = require('../services/payouts');
const pin = require('../services/pin');
const rails = require('../services/rails');
const risk = require('../services/risk');
const notifications = require('../services/notifications');
const audit = require('../services/audit');

const EXTEND_HOURS = 72;
const PER_PAYMENT_LIMIT_CENTS = Number(process.env.PER_PAYMENT_LIMIT_CENTS || 10000);

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// GET /api/wallet/:wallet_id
router.get('/:wallet_id', requireWalletOwnership('wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    const wallet = req.wallet;
    const [txs, user, fundings] = await Promise.all([
        pool.query(
            `SELECT id, kind, counterparty, amount, status, refunded, created_at
               FROM transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 30`,
            [wallet.id]
        ),
        pool.query('SELECT phone, id_method, emergency_contact FROM users WHERE id = $1', [req.user.id]),
        pool.query(
            `SELECT COUNT(*)::int AS n, BOOL_OR(simulated) AS simulated, MAX(payer_email) AS payer_email
               FROM wallet_fundings WHERE wallet_id = $1`, [wallet.id]
        ),
    ]);
    res.json({
        wallet: {
            id: wallet.id, balance: Number(wallet.balance), currency: wallet.currency, expiry: wallet.expiry,
            max_lifetime: wallet.max_lifetime, extend_count: wallet.extend_count,
            active: wallet.active, created_at: wallet.created_at,
            per_payment_limit: PER_PAYMENT_LIMIT_CENTS, max_balance: funding.MAX_BALANCE_CENTS,
            funded_by: fundings.rows[0].simulated ? 'simulated' : 'paypal',
            paypal_payer: fundings.rows[0].payer_email || null,
        },
        user: {
            phone_last4: user.rows[0]?.phone ? String(user.rows[0].phone).slice(-4) : null,
            id_method: user.rows[0]?.id_method,
            has_emergency_contact: !!user.rows[0]?.emergency_contact,
        },
        // Distress flags are not returned: the phone may be in a coercer's hands.
        transactions: txs.rows.map((t) => ({ ...t, amount: Number(t.amount) })),
    });
}));

// POST /api/wallet/topup-order  { wallet_id, amount (dollars) }
router.post('/topup-order', requireWalletOwnership('wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    if (req.isDelegateCaller) return res.status(403).json({ error: 'Only the wallet owner can add money' });
    if (!req.wallet.active || new Date(req.wallet.expiry) <= new Date()) return res.status(409).json({ error: 'Wallet closed' });
    const amountCents = dollarsToCents(req.body?.amount);
    const problem = funding.checkAmount(amountCents, Number(req.wallet.balance));
    if (problem) return res.status(400).json({ error: problem });
    try {
        res.json(await funding.createOrder(pool, {
            purpose: 'topup', walletId: req.wallet.id, amountCents, appUrl: req.get('origin') || undefined,
        }));
    } catch (e) {
        console.error('wallet topup-order failed:', e.message, e.debugId || '');
        res.status(502).json({ error: 'Could not start the PayPal payment. Try again.' });
    }
}));

// POST /api/wallet/topup-capture  { wallet_id, paypal_order_id }
router.post('/topup-capture', requireWalletOwnership('wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    let captured;
    try {
        captured = await funding.claimAndCapture(pool, req.body?.paypal_order_id, { purpose: 'topup', walletId: req.wallet.id });
    } catch (e) {
        const map = {
            order_unavailable: [409, 'That PayPal payment was already used. Start again.'],
            payment_declined: [402, 'PayPal declined that funding source. Try another one.'],
            capture_unconfirmed: [502, 'PayPal did not confirm the payment. Try again: you will only be charged once.'],
        };
        const [code, msg] = map[e.code] || [502, 'PayPal could not complete the payment'];
        return res.status(code).json({ error: msg });
    }
    const { order, capture } = captured;
    try {
        const balance = await funding.creditTopUp(pool, { walletId: req.wallet.id, order, capture });
        await audit.append(pool, { action: 'wallet_topup', subjectUserId: req.user.id, resourceRef: req.wallet.id, ip: req.ip });
        res.json({ success: true, balance, added: capture.amountCents });
    } catch (e) {
        await pool.query(`UPDATE paypal_orders SET status = 'failed' WHERE order_id = $1`, [order.order_id]).catch(() => {});
        await funding.compensate(order, capture);
        if (e.message === 'wallet_limit') {
            return res.status(409).json({ error: `That would take your wallet over ${usd(funding.MAX_BALANCE_CENTS)}, so the payment was refunded to PayPal.` });
        }
        console.error('topup credit failed; capture refunded:', e.message);
        res.status(500).json({ error: 'Top-up failed and was refunded to PayPal' });
    }
}));

// POST /api/wallet/send  { wallet_id, to_email, amount (dollars), pin, idempotency_key }
router.post('/send', requireWalletOwnership('wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    const { idempotency_key } = req.body || {};
    const toEmail = String(req.body?.to_email || '').trim().toLowerCase();
    if (req.isDelegateCaller) return res.status(403).json({ error: 'Only the wallet owner can send from the app' });
    if (!validateEmail(toEmail)) return res.status(400).json({ error: "Enter the recipient's PayPal email" });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(String(idempotency_key || ''))) {
        return res.status(400).json({ error: 'idempotency_key required' });
    }
    const amountCents = dollarsToCents(req.body?.amount);
    if (!amountCents) return res.status(400).json({ error: 'Enter a valid amount' });
    if (amountCents > PER_PAYMENT_LIMIT_CENTS) {
        return res.status(400).json({ error: `PulsePay allows up to ${usd(PER_PAYMENT_LIMIT_CENTS)} per payment` });
    }

    const requestId = `send:${req.wallet.id}:${idempotency_key}`;
    const meta = {
        requestId, walletId: req.wallet.id, kind: 'send', authTier: 'app+pin', amountCents,
        counterAccount: ledger.payeeAccount(toEmail), counterparty: toEmail,
    };
    const respond = (out) => out.ok
        ? res.json({ status: out.status, transaction_id: out.transaction_id, payment_ref: out.payment_ref, remaining_balance: out.remaining_balance })
        : res.status(out.http).json({ status: out.status, error: out.error });

    const prior = await pool.query('SELECT 1 FROM ledger_entries WHERE idempotency_key = $1', [`${requestId}:wallet`]);
    if (prior.rows.length) return respond(await payments.debit(pool, meta));

    const pinResult = await pin.checkPin(pool, req.user.id, req.body.pin);
    if (!pinResult.ok) return pin.pinFailure(res, pinResult);

    const verdict = await risk.assess({
        amountCents, now: new Date(), spendingHistory: await payments.recentSpend(pool, req.wallet.id),
    });
    if (verdict.decision === 'decline') return res.status(403).json({ status: 'declined', error: 'Payment declined by the risk check' });

    const out = await payments.debit(pool, meta);
    if (out.ok) {
        await audit.append(pool, { action: 'wallet_send', subjectUserId: req.user.id, resourceRef: req.wallet.id, ip: req.ip });
        // Money that only ever came in through the simulator (e.g. a demo wallet) leaves through it.
        const realFunding = await pool.query('SELECT 1 FROM wallet_fundings WHERE wallet_id = $1 AND simulated = false LIMIT 1', [req.wallet.id]);
        payouts.queueAndSubmit(pool, {
            account: ledger.payeeAccount(toEmail), recipientEmail: toEmail, amountCents, sourceRequest: requestId,
            simulated: realFunding.rows.length ? undefined : true,
        });
    }
    return respond(out);
}));

// POST /api/wallet/refund  { wallet_id }
// Closes the wallet and returns the balance to the PayPal payments that funded it,
// newest first. Safe to retry: a wallet that is closing keeps its remaining balance
// until every refund has gone through.
router.post('/refund', requireWalletOwnership('wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    if (req.isDelegateCaller) return res.status(403).json({ error: 'Only the wallet owner can close the wallet' });

    // 1. Freeze the wallet (no payments can start), unless a payment is still settling.
    const c = await pool.connect();
    let wallet;
    try {
        await c.query('BEGIN');
        wallet = (await c.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [req.wallet.id])).rows[0];
        if (!wallet || (!wallet.active && Number(wallet.balance) === 0)) {
            await c.query('ROLLBACK');
            return res.status(404).json({ error: 'Wallet not found or already closed' });
        }
        const inFlight = await c.query(
            `SELECT 1 FROM ledger_entries WHERE wallet_id = $1 AND status IN ('reserved','pending') LIMIT 1`, [wallet.id]
        );
        if (inFlight.rows.length) {
            await c.query('ROLLBACK');
            return res.status(409).json({ error: 'A payment is still settling. Try again in a moment.' });
        }
        await c.query('UPDATE wallets SET active = false WHERE id = $1', [wallet.id]);
        await c.query('COMMIT');
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        c.release();
    }

    // 2. Refund against each funding capture until the balance is zero.
    const fundings = (await pool.query(
        `SELECT * FROM wallet_fundings WHERE wallet_id = $1 AND refunded_amount < amount ORDER BY created_at DESC`, [wallet.id]
    )).rows;
    let refunded = 0;
    for (const f of fundings) {
        const remaining = Number((await pool.query('SELECT balance FROM wallets WHERE id = $1', [wallet.id])).rows[0].balance);
        if (remaining <= 0) break;
        const part = Math.min(remaining, Number(f.amount) - Number(f.refunded_amount));
        let r;
        try {
            r = await rails.refund({
                captureId: f.capture_id, amountCents: part, currency: wallet.currency,
                requestId: `refund-${f.capture_id}-${Number(f.refunded_amount) + part}`, simulated: f.simulated,
            });
        } catch (e) {
            console.error(`refund of capture ${f.capture_id} failed:`, e.message, e.debugId || '');
            return res.status(502).json({
                error: 'PayPal refund failed. Your wallet is frozen and the rest will be refunded when you retry.',
                refunded_amount: refunded,
            });
        }
        const rc = await pool.connect();
        try {
            await rc.query('BEGIN');
            const upd = await rc.query(
                'UPDATE wallets SET balance = balance - $2 WHERE id = $1 AND balance >= $2 RETURNING balance', [wallet.id, part]
            );
            const after = Number(upd.rows[0].balance);
            await rc.query('UPDATE wallet_fundings SET refunded_amount = refunded_amount + $2 WHERE id = $1', [f.id, part]);
            const lines = await ledger.postGroup(rc, {
                requestId: `refund:${r.refundId}`, walletId: wallet.id, kind: 'refund', status: 'settled', externalRef: r.refundId,
                lines: [
                    { account: ledger.walletAccount(wallet.id), direction: 'debit', amount: part, balanceAfter: after, suffix: 'wallet' },
                    { account: ledger.POOL_ACCOUNT, direction: 'credit', amount: part, suffix: 'counter' },
                ],
            });
            await rc.query(
                `INSERT INTO transactions (wallet_id, ledger_entry_id, kind, counterparty, amount, auth_tier, status)
                 VALUES ($1,$2,'refund',$3,$4,'system','completed')`,
                [wallet.id, lines[0].id, f.simulated ? 'Refund (simulated PayPal)' : 'Refund to PayPal', part]
            );
            await rc.query('COMMIT');
            refunded += part;
        } catch (e) {
            await rc.query('ROLLBACK').catch(() => {});
            console.error(`REFUND ${r.refundId} succeeded at PayPal but was not recorded; reconcile manually:`, e.message);
            throw e;
        } finally {
            rc.release();
        }
    }

    await audit.append(pool, { action: 'wallet_refunded', subjectUserId: wallet.user_id, resourceRef: wallet.id, ip: req.ip });
    notifications.event('wallet_closed', { wallet: wallet.id, refunded_cents: refunded });
    res.json({ success: true, refunded_amount: refunded, message: `Wallet closed. ${usd(refunded)} refunded to PayPal.` });
}));

// POST /api/wallet/extend  { wallet_id } — capped by max_lifetime, extends from now.
router.post('/extend', requireWalletOwnership('wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    const wallet = req.wallet;
    if (req.isDelegateCaller) return res.status(403).json({ error: 'Only the wallet owner can extend the wallet' });
    if (!wallet.active) return res.status(404).json({ error: 'Wallet closed' });
    if (new Date(wallet.expiry) <= new Date()) return res.status(410).json({ error: 'This wallet has expired. Close it to get your balance back.' });

    const proposed = new Date(Date.now() + EXTEND_HOURS * 3600 * 1000);
    if (proposed > new Date(wallet.max_lifetime)) {
        return res.status(400).json({ error: 'Cannot extend beyond the wallet maximum lifetime', max_lifetime: wallet.max_lifetime });
    }
    const r = await pool.query(
        `UPDATE wallets SET expiry = $1, extend_count = extend_count + 1
           WHERE id = $2 AND active = true AND expiry > NOW() RETURNING expiry, extend_count`,
        [proposed, wallet.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Wallet closed or expired' });
    await audit.append(pool, { action: 'wallet_extended', subjectUserId: wallet.user_id, resourceRef: wallet.id, ip: req.ip });
    res.json({ success: true, new_expiry: r.rows[0].expiry, extend_count: r.rows[0].extend_count });
}));

// POST /api/wallet/reissue-biometric  { wallet_id, template_type?, embedding, pin }
router.post('/reissue-biometric', requireWalletOwnership('wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    const { template_type = 'fingerprint', embedding } = req.body || {};
    if (req.isDelegateCaller) return res.status(403).json({ error: 'Only the wallet owner can re-issue biometrics' });
    if (!['fingerprint', 'face'].includes(template_type)) {
        return res.status(400).json({ error: "template_type must be 'fingerprint' or 'face'" });
    }
    if (!biometric.isEmbedding(embedding)) return res.status(400).json({ error: 'A valid scan is required' });

    const subjectId = req.user.id;
    const pinResult = await pin.checkPin(pool, subjectId, req.body.pin);
    if (!pinResult.ok) return pin.pinFailure(res, pinResult);

    const cur = await pool.query(
        `SELECT * FROM biometric_templates
          WHERE subject_id = $1 AND active = true AND template_type = $2 AND purpose = 'auth'`,
        [subjectId, template_type]
    );
    const stillYou = cur.rows.some((row) => (biometric.safeScore(embedding, row) ?? -1) >= biometric.MATCH_THRESHOLD);
    if (!stillYou) return res.status(401).json({ error: 'Biometric re-verification failed' });

    const others = await pool.query(
        `SELECT * FROM biometric_templates WHERE active = true AND template_type = $1 AND subject_id <> $2`,
        [template_type, subjectId]
    );
    if (biometric.collides(embedding, others.rows)) {
        return res.status(409).json({ error: 'This scan is too close to another registered customer. Try again.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE biometric_templates SET active = false, deactivated_at = NOW()
              WHERE subject_id = $1 AND active = true AND template_type = $2 AND purpose = 'auth'`,
            [subjectId, template_type]
        );
        const t = biometric.protect(embedding);
        await client.query(
            `INSERT INTO biometric_templates
               (subject_id, template_type, purpose, protected_vector, enc_iv, enc_tag, transform_salt, kms_key_ref, model_version)
             VALUES ($1,$2,'auth',$3,$4,$5,$6,$7,'local-cv:v1')`,
            [subjectId, template_type, t.protected_vector, t.enc_iv, t.enc_tag, t.transform_salt, t.kms_key_ref]
        );
        await audit.append(client, { action: 'biometric_reissued', subjectUserId: subjectId, resourceRef: req.wallet.id, ip: req.ip });
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
    res.json({ success: true, template_type, message: 'Biometric template re-issued; previous template revoked' });
}));

// POST /api/wallet/sos  { wallet_id, gps_lat?, gps_lng? } — panic button on the customer's phone.
router.post('/sos', requireWalletOwnership('wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    const { gps_lat, gps_lng } = req.body || {};
    const u = await pool.query('SELECT emergency_contact FROM users WHERE id = $1', [req.user.id]);
    const contact = u.rows[0]?.emergency_contact;
    if (!contact) return res.status(400).json({ error: 'No emergency contact on file' });
    notifications.silentSOS({
        transactionId: `sos:${req.wallet.id}:${Date.now()}`,
        contact, userName: 'A PulsePay customer', gpsLat: gps_lat, gpsLng: gps_lng,
        reason: 'pressed the panic button',
    });
    await audit.append(pool, { action: 'sos_panic', subjectUserId: req.user.id, resourceRef: req.wallet.id, ip: req.ip });
    res.json({ success: true, message: 'SOS dispatched' });
}));

module.exports = router;
