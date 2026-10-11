/**
 * PayPal integration endpoints.
 *
 *   GET  /config    browser-safe settings for the JS SDK v6 (client id only, never the secret)
 *   POST /webhook   PayPal webhook receiver. Every event is stored once; only events whose
 *                   signature PayPal itself verifies (PAYPAL_WEBHOOK_ID) are acted on:
 *                     PAYMENT.PAYOUTS-ITEM.*      -> payout status (SUCCESS moves the ledger)
 *                     CUSTOMER.DISPUTE.CREATED    -> freeze the wallet a disputed top-up funded
 *                     INVOICING.INVOICE.PAID      -> credit the merchant who issued the invoice
 */
const express = require('express');
const router = express.Router();

const paypal = require('../services/paypal');
const rails = require('../services/rails');
const payouts = require('../services/payouts');
const invoices = require('../services/invoices');
const notifications = require('../services/notifications');
const audit = require('../services/audit');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/config', (req, res) => {
    res.json({
        mode: rails.mode(),                       // paypal-sandbox | paypal-live | simulated
        enabled: rails.live(),
        client_id: rails.live() ? process.env.PAYPAL_CLIENT_ID : null,
        sdk_url: paypal.sdkUrl(),
        currency: 'USD',
        payouts: payouts.instantMode() ? 'instant' : 'manual',
    });
});

async function onPayoutItem(pool, resource) {
    const status = resource.transaction_status;
    const itemId = resource.payout_item_id;
    const batchId = resource.payout_batch_id;
    const p = (await pool.query(
        'SELECT * FROM payouts WHERE payout_item_id = $1 OR payout_batch_id = $2 LIMIT 1', [itemId, batchId]
    )).rows[0];
    if (p) await payouts.applyStatus(pool, p.id, { status, itemId, error: resource.errors?.message || null });
}

async function onDispute(pool, resource) {
    const captureIds = (resource.disputed_transactions || []).map((t) => t.seller_transaction_id).filter(Boolean);
    for (const captureId of captureIds) {
        const f = (await pool.query(
            `SELECT f.wallet_id, w.user_id FROM wallet_fundings f JOIN wallets w ON w.id = f.wallet_id WHERE f.capture_id = $1`,
            [captureId]
        )).rows[0];
        if (!f) continue;
        await pool.query('UPDATE wallets SET active = false WHERE id = $1', [f.wallet_id]);
        await pool.query(
            `INSERT INTO aml_alerts (identity_id, rule_id, risk_score, alert_type) VALUES ($1,'paypal_dispute',80,'dispute')`,
            [f.user_id]
        );
        await audit.append(pool, { actor: 'paypal', action: 'wallet_frozen_dispute', subjectUserId: f.user_id, resourceRef: f.wallet_id });
        notifications.event('dispute_opened', { wallet: f.wallet_id, dispute_id: resource.dispute_id, capture_id: captureId });
    }
}

async function onInvoicePaid(pool, resource) {
    const invoice = resource.invoice || resource;
    await invoices.creditIfPaid(pool, invoice.id, invoice.payments?.paid_amount?.value || invoice.amount?.value);
}

router.post('/webhook', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const event = req.body || {};
    if (!event.id || !event.event_type) return res.status(400).json({ error: 'Not a PayPal event' });
    if (!process.env.PAYPAL_WEBHOOK_ID || !rails.live()) {
        return res.status(503).json({ error: 'Webhooks are not configured on this server' });
    }

    let verified = false;
    try { verified = await paypal.verifyWebhook(req.headers, event); } catch (e) { console.error('webhook verify error:', e.message); }

    // Returns a row the first time an event is stored, and again the first time a stored
    // event verifies (PayPal redelivers an event we could not verify), so it is acted on once.
    const stored = await pool.query(
        `INSERT INTO paypal_events (event_id, event_type, resource_id, verified, payload)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (event_id) DO UPDATE SET verified = true
          WHERE paypal_events.verified = false AND EXCLUDED.verified = true
         RETURNING event_id`,
        [event.id, event.event_type, event.resource?.id || null, verified, event]
    );
    if (!verified) return res.status(400).json({ error: 'Signature verification failed' });
    if (!stored.rows.length) return res.json({ received: true, duplicate: true });

    const type = event.event_type;
    if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) await onPayoutItem(pool, event.resource || {});
    else if (type === 'CUSTOMER.DISPUTE.CREATED') await onDispute(pool, event.resource || {});
    else if (type === 'INVOICING.INVOICE.PAID') await onInvoicePaid(pool, event.resource || {});
    res.json({ received: true });
}));

module.exports = router;
