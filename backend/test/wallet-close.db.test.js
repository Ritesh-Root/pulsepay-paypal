// POST /api/wallet/refund: close the wallet and refund the balance to the PayPal captures.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startFakePayPal, useFakePayPal } = require('./support/fake-paypal');
const { startApp, customerToken } = require('./support/http');
const f = require('./support/fixtures');
const payments = require('../services/payments');

process.env.PAYOUT_MODE = 'manual';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

describe('closing a wallet', { skip }, () => {
    let db, pool, paypal, app, shop;
    before(async () => {
        paypal = await startFakePayPal();
        useFakePayPal(paypal);
        db = await freshDatabase();
        pool = db.pool;
        app = await startApp(pool);
        shop = await f.merchant(pool);
    });
    after(async () => { await app.close(); await db.close(); await paypal.close(); });

    /** Top up $30 then $40 with PayPal and spend $25 at the shop: $45 left. */
    async function usedWallet() {
        const c = await f.fundedCustomer(pool, 3000, { approve: paypal.approve });
        await f.topUp(pool, c.wallet.id, 4000, { approve: paypal.approve });
        await payments.debit(pool, {
            requestId: `pay:${c.wallet.id}`, walletId: c.wallet.id, amountCents: 2500, kind: 'payment',
            counterAccount: `merchant:${shop.id}`, counterparty: shop.display_name, merchantId: shop.id,
        });
        const fundings = (await pool.query('SELECT capture_id, amount FROM wallet_fundings WHERE wallet_id = $1 ORDER BY created_at', [c.wallet.id])).rows;
        return { ...c, token: customerToken(c.user), older: fundings[0].capture_id, newer: fundings[1].capture_id };
    }
    const close = (c) => app.call('POST', '/api/wallet/refund', { wallet_id: c.wallet.id }, c.token);
    const refunded = (captureId) => paypal.state.captures.get(captureId).refundedCents;
    const walletRow = async (c) => (await pool.query('SELECT balance, active FROM wallets WHERE id = $1', [c.wallet.id])).rows[0];

    it('refunds the balance to the newest PayPal payment first', async () => {
        const c = await usedWallet();

        const r = await close(c);

        assert.equal(r.status, 200);
        assert.equal(r.body.refunded_amount, 4500);
        assert.equal(refunded(c.newer), 4000);
        assert.equal(refunded(c.older), 500);
        assert.deepEqual(await walletRow(c), { balance: '0', active: false });
        assert.deepEqual(await f.books.walletDrift(pool), []);
        assert.deepEqual(await f.books.unbalanced(pool), []);
    });

    it('can be retried after PayPal fails, and nothing more can be spent meanwhile', async () => {
        const c = await usedWallet();
        paypal.fault('refund', 'unavailable');

        const first = await close(c);
        assert.equal(first.status, 502);
        assert.equal((await walletRow(c)).active, false, 'frozen');
        const spend = await payments.debit(pool, {
            requestId: `pay:frozen:${c.wallet.id}`, walletId: c.wallet.id, amountCents: 100, kind: 'payment',
            counterAccount: `merchant:${shop.id}`, counterparty: shop.display_name, merchantId: shop.id,
        });
        assert.equal(spend.ok, false);

        const retry = await close(c);
        assert.equal(retry.status, 200);
        assert.equal(refunded(c.newer) + refunded(c.older), 4500);
        assert.equal((await walletRow(c)).balance, '0');
    });

    it('refunds once when the response to a refund was lost', async () => {
        const c = await usedWallet();
        paypal.fault('refund', 'lose-response'); // PayPal refunds, we never hear back

        assert.equal((await close(c)).status, 502);
        const retry = await close(c);

        assert.equal(retry.status, 200);
        assert.equal(refunded(c.newer) + refunded(c.older), 4500, 'PayPal refunded the balance once');
        assert.equal((await walletRow(c)).balance, '0');
        assert.deepEqual(await f.books.unbalanced(pool), []);
    });

    it("cannot close someone else's wallet", async () => {
        const c = await usedWallet();
        const stranger = await f.customer(pool);

        const r = await app.call('POST', '/api/wallet/refund', { wallet_id: c.wallet.id }, customerToken(stranger));

        assert.ok(r.status === 403 || r.status === 404, `got ${r.status}`);
        assert.deepEqual(await walletRow(c), { balance: '4500', active: true });
    });
});
