// POST /api/wallet/topup-order + /topup-capture: add money with PayPal Checkout.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startFakePayPal, useFakePayPal } = require('./support/fake-paypal');
const { startApp, customerToken } = require('./support/http');
const f = require('./support/fixtures');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

describe('adding money', { skip }, () => {
    let db, pool, paypal, app;
    before(async () => {
        paypal = await startFakePayPal();
        useFakePayPal(paypal);
        db = await freshDatabase();
        pool = db.pool;
        app = await startApp(pool);
    });
    after(async () => { await app.close(); await db.close(); await paypal.close(); });

    async function customerWith(cents) {
        const c = await f.fundedCustomer(pool, cents, { approve: paypal.approve });
        return { ...c, token: customerToken(c.user) };
    }
    const order = (c, amount) => app.call('POST', '/api/wallet/topup-order', { wallet_id: c.wallet.id, amount }, c.token);
    const capture = (c, id) => app.call('POST', '/api/wallet/topup-capture', { wallet_id: c.wallet.id, paypal_order_id: id }, c.token);
    const balance = async (c) => Number((await pool.query('SELECT balance FROM wallets WHERE id = $1', [c.wallet.id])).rows[0].balance);

    it('adds an approved PayPal payment to the wallet', async () => {
        const c = await customerWith(5000);
        const o = await order(c, 20);
        paypal.approve(o.body.order_id);

        const r = await capture(c, o.body.order_id);

        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { success: true, balance: 7000, added: 2000 });
        assert.equal(await balance(c), 7000);
        assert.deepEqual(await f.books.walletDrift(pool), []);
    });

    it('refunds a top-up for a wallet that closed while the customer was in PayPal', async () => {
        const c = await customerWith(5000);
        const o = await order(c, 20);
        paypal.approve(o.body.order_id);
        await pool.query('UPDATE wallets SET active = false WHERE id = $1', [c.wallet.id]);

        const r = await capture(c, o.body.order_id);

        assert.equal(r.status, 500);
        const [cap] = [...paypal.state.captures.values()].filter((x) => x.orderId === o.body.order_id);
        assert.equal(cap.refundedCents, 2000);
        assert.equal(await balance(c), 5000);
    });

    it('refunds a second top-up that would push the wallet past $200', async () => {
        const c = await customerWith(10000);
        const first = await order(c, 100);
        const second = await order(c, 100); // both pass the limit check while the balance is $100
        paypal.approve(first.body.order_id);
        paypal.approve(second.body.order_id);

        assert.equal((await capture(c, first.body.order_id)).status, 200);
        const over = await capture(c, second.body.order_id);
        assert.equal(over.status, 409);
        assert.match(over.body.error, /refunded/);

        assert.equal(await balance(c), 20000);
        const [cap] = [...paypal.state.captures.values()].filter((x) => x.orderId === second.body.order_id);
        assert.equal(cap.refundedCents, 10000);
    });

    it('refuses a top-up past the wallet limit', async () => {
        const c = await customerWith(5000);
        assert.equal((await order(c, 160)).status, 400);
        assert.equal((await order(c, 150)).status, 200);
    });
});
