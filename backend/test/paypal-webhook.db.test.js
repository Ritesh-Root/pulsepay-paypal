// POST /api/paypal/webhook: only events PayPal verifies are acted on, each exactly once.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { skip, freshDatabase } = require('./support/db');
const { startFakePayPal, useFakePayPal } = require('./support/fake-paypal');
const { startApp } = require('./support/http');
const f = require('./support/fixtures');
const payments = require('../services/payments');
const payouts = require('../services/payouts');

process.env.PAYOUT_MODE = 'manual';
process.env.PAYPAL_WEBHOOK_ID = '1JE4291016473214C';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

// Delivery headers PayPal sends with every webhook.
const deliveryHeaders = () => ({
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
    'paypal-transmission-id': crypto.randomUUID(),
    'paypal-transmission-sig': crypto.randomBytes(64).toString('base64'),
    'paypal-transmission-time': new Date().toISOString(),
});
const eventId = () => `WH-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

function payoutItemEvent(payout, status = 'SUCCESS') {
    return {
        id: eventId(), event_version: '1.0', create_time: new Date().toISOString(), resource_type: 'payouts_item',
        event_type: status === 'SUCCESS' ? 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED' : `PAYMENT.PAYOUTS-ITEM.${status}`,
        summary: 'A payout item has succeeded',
        resource: {
            transaction_id: '4TC5I2AXM9XQ4', transaction_status: status, payout_item_id: `ITEM-${payout.payout_batch_id}`,
            payout_batch_id: payout.payout_batch_id, time_processed: new Date().toISOString(),
            payout_item_fee: { currency: 'USD', value: '0.00' },
            payout_item: { recipient_type: 'EMAIL', amount: { currency: 'USD', value: (payout.amount / 100).toFixed(2) }, receiver: payout.recipient_email },
            links: [],
        },
        links: [],
    };
}

function disputeEvent(captureId) {
    return {
        id: eventId(), event_version: '1.0', create_time: new Date().toISOString(), resource_type: 'dispute',
        event_type: 'CUSTOMER.DISPUTE.CREATED', summary: 'A new dispute opened with Case # PP-D-27803',
        resource: {
            dispute_id: 'PP-D-27803', reason: 'UNAUTHORISED', status: 'OPEN', dispute_life_cycle_stage: 'CHARGEBACK',
            dispute_amount: { currency_code: 'USD', value: '50.00' },
            disputed_transactions: [{ seller_transaction_id: captureId, seller: { merchant_id: 'RD465XN5VS364' } }],
        },
        links: [],
    };
}

describe('PayPal webhooks', { skip }, () => {
    let db, pool, paypal, app;
    before(async () => {
        paypal = await startFakePayPal();
        useFakePayPal(paypal);
        db = await freshDatabase();
        pool = db.pool;
        app = await startApp(pool);
    });
    after(async () => { await app.close(); await db.close(); await paypal.close(); });

    const deliver = (event) => app.call('POST', '/api/paypal/webhook', event, null, deliveryHeaders());

    /** A merchant owed `cents`, with a payout PayPal accepted and is still processing. */
    async function payoutInFlight(cents) {
        const m = await f.merchant(pool);
        const { wallet } = await f.fundedCustomer(pool, 5000, { approve: paypal.approve });
        await payments.debit(pool, {
            requestId: `pay:${wallet.id}`, walletId: wallet.id, amountCents: cents, kind: 'payment',
            counterAccount: `merchant:${m.id}`, counterparty: m.display_name, merchantId: m.id,
        });
        paypal.state.payoutItemStatus = 'PENDING';
        const p = await payouts.queue(pool, { merchantId: m.id, account: `merchant:${m.id}`, recipientEmail: m.paypal_email, amountCents: cents });
        await payouts.submit(pool, p);
        return { m, payout: (await pool.query('SELECT * FROM payouts WHERE id = $1', [p.id])).rows[0] };
    }

    it('settles a payout when PayPal says its item succeeded', async () => {
        const { m, payout } = await payoutInFlight(1500);
        paypal.state.webhookVerification = 'SUCCESS';

        const r = await deliver(payoutItemEvent(payout));

        assert.equal(r.status, 200);
        assert.equal(await f.books.owed(pool, `merchant:${m.id}`), 0);
        const verify = paypal.state.requests.filter((q) => q.route === 'verify-webhook').at(-1);
        assert.equal(verify.body.webhook_id, '1JE4291016473214C');
        assert.equal(verify.body.webhook_event.resource.payout_batch_id, payout.payout_batch_id);
    });

    it('ignores an event PayPal does not verify', async () => {
        const { m, payout } = await payoutInFlight(1500);
        paypal.state.webhookVerification = 'FAILURE';

        const r = await deliver(payoutItemEvent(payout));

        assert.equal(r.status, 400);
        assert.equal(await f.books.owed(pool, `merchant:${m.id}`), 1500);
    });

    it('acts on an event when PayPal redelivers it after a failed verification', async () => {
        const { m, payout } = await payoutInFlight(1500);
        const event = payoutItemEvent(payout);

        paypal.fault('verify-webhook', 'unavailable'); // PayPal could not verify the first delivery
        assert.notEqual((await deliver(event)).status, 200);
        paypal.state.webhookVerification = 'SUCCESS';
        const retry = await deliver(event);

        assert.equal(retry.status, 200);
        assert.equal(await f.books.owed(pool, `merchant:${m.id}`), 0);
    });

    it('freezes the wallet a disputed top-up funded, once per event', async () => {
        const { user, wallet } = await f.fundedCustomer(pool, 5000, { approve: paypal.approve });
        const capture = (await pool.query('SELECT capture_id FROM wallet_fundings WHERE wallet_id = $1', [wallet.id])).rows[0].capture_id;
        paypal.state.webhookVerification = 'SUCCESS';
        const event = disputeEvent(capture);

        await deliver(event);
        const dup = await deliver(event);

        assert.equal(dup.body.duplicate, true);
        assert.equal((await pool.query('SELECT active FROM wallets WHERE id = $1', [wallet.id])).rows[0].active, false);
        const alerts = await pool.query(`SELECT * FROM aml_alerts WHERE identity_id = $1 AND alert_type = 'dispute'`, [user.id]);
        assert.equal(alerts.rows.length, 1);
    });
});
