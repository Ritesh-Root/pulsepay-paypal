// "Try the demo": a fresh shop and customer per visitor, so a judge can run the whole
// counter flow on any device. PayPal is "live" here (the local fake) to prove the demo
// never moves money through PayPal.
process.env.PAYOUT_MODE = 'instant';
process.env.DEMO_STARTS_PER_HOUR = '4';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startFakePayPal, useFakePayPal } = require('./support/fake-paypal');
const { startApp } = require('./support/http');
const { near } = require('./support/vectors');
const f = require('./support/fixtures');

describe('demo mode', { skip }, () => {
    let db, pool, paypal, app;
    before(async () => {
        paypal = await startFakePayPal();
        useFakePayPal(paypal);
        db = await freshDatabase();
        pool = db.pool;
        app = await startApp(pool);
    });
    after(async () => { await app.close(); await db.close(); await paypal.close(); });

    const start = () => app.call('POST', '/api/demo/start', {});
    const settle = () => new Promise((r) => setTimeout(r, 300)); // background payouts

    it('is off unless DEMO_MODE is on', async () => {
        delete process.env.DEMO_MODE;
        assert.deepEqual((await app.call('GET', '/api/demo')).body, { enabled: false });
        assert.equal((await start()).status, 404);
        assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM merchants')).rows[0].n, 0);
    });

    it('gives each visitor their own shop with a morning of sales already paid out', async () => {
        process.env.DEMO_MODE = 'true';
        assert.deepEqual((await app.call('GET', '/api/demo')).body, { enabled: true });

        const a = await start();
        const b = await start();
        assert.equal(a.status, 200);
        assert.notEqual(a.body.merchant.merchant.id, b.body.merchant.merchant.id);
        assert.notEqual(a.body.customer.wallet_id, b.body.customer.wallet_id);

        const dash = (await app.call('GET', '/api/merchant/dashboard', undefined, a.body.merchant.token)).body;
        assert.equal(dash.today.payments, 6);
        assert.equal(dash.today.gross_cents, 450 + 325 + 1200 + 680 + 540 + 4800);
        assert.ok(dash.payouts.length === 6 && dash.payouts.every((p) => p.status === 'SUCCESS'));
        assert.ok(dash.anomalies.some((x) => x.type === 'large_payment'), 'something for the assistant to explain');
        assert.equal(dash.balance.owed, 0);
        assert.deepEqual(await f.books.unbalanced(pool), []);
        assert.deepEqual(await f.books.walletDrift(pool), []);
    });

    it("lets the demo customer pay at the demo shop with the demo scan and PIN", async () => {
        const { merchant, customer } = (await start()).body;
        const wallet = await app.call('GET', `/api/wallet/${customer.wallet_id}`, undefined, customer.token);
        assert.equal(wallet.body.wallet.balance, 5000);

        const id = await app.call('POST', '/api/payment/identify',
            { method: 'fingerprint', embedding: near(customer.scan, 0.97, 99) }, merchant.token);
        assert.equal(id.body.customer_label, customer.label);
        const paid = await app.call('POST', '/api/payment/pay',
            { session_token: id.body.session_token, amount: '12.50', pin: customer.pin }, merchant.token);

        assert.equal(paid.status, 200);
        assert.equal((await app.call('GET', `/api/wallet/${customer.wallet_id}`, undefined, customer.token)).body.wallet.balance, 3750);
        await settle();
        const payouts = (await pool.query('SELECT status, simulated FROM payouts WHERE merchant_id = $1', [merchant.merchant.id])).rows;
        assert.equal(payouts.length, 7);
        assert.ok(payouts.every((p) => p.simulated && p.status === 'SUCCESS'));
    });

    it('never moves money through PayPal, including a cash-out and a send', async () => {
        const { merchant, customer } = (await start()).body;
        process.env.PAYOUT_MODE = 'manual';
        try {
            const id = await app.call('POST', '/api/payment/identify',
                { method: 'fingerprint', embedding: near(customer.scan, 0.97, 98) }, merchant.token);
            await app.call('POST', '/api/payment/pay', { session_token: id.body.session_token, amount: '5.00', pin: customer.pin }, merchant.token);
            const cash = await app.call('POST', '/api/merchant/cashout', {}, merchant.token);
            assert.equal(cash.body.payout.status, 'SUCCESS');
            const sent = await app.call('POST', '/api/wallet/send', {
                wallet_id: customer.wallet_id, to_email: 'friend@personal.example.com', amount: '5.00', pin: customer.pin,
                idempotency_key: 'demo-send-0001',
            }, customer.token);
            assert.equal(sent.status, 200);
        } finally {
            process.env.PAYOUT_MODE = 'instant';
        }
        await settle();
        const moneyCalls = paypal.state.requests.filter((r) => r.route !== 'token');
        assert.deepEqual(moneyCalls.map((r) => r.route), []);
    });

    it('limits how many demo shops one visitor can create', async () => {
        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await start()).status);

        assert.ok(statuses.includes(429), `got ${statuses}`);
        assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM merchants')).rows[0].n, 4);
    });
});
