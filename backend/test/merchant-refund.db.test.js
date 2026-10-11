// POST /api/merchant/refunds: a merchant refunds a payment back to the customer's wallet,
// but only from money PulsePay still holds for that merchant.
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
process.env.PAYOUT_MODE = 'manual';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startApp, merchantToken } = require('./support/http');
const f = require('./support/fixtures');
const payments = require('../services/payments');
const payouts = require('../services/payouts');

describe('merchant refunds', { skip }, () => {
    let db, pool, app;
    before(async () => { db = await freshDatabase(); pool = db.pool; app = await startApp(pool); });
    after(async () => { await app.close(); await db.close(); });

    /** A customer with $50 who paid `cents` at a new shop. */
    async function sale(cents) {
        const shop = await f.merchant(pool);
        const { wallet } = await f.fundedCustomer(pool, 5000);
        const out = await payments.debit(pool, {
            requestId: `pay:${wallet.id}`, walletId: wallet.id, amountCents: cents, kind: 'payment',
            counterAccount: `merchant:${shop.id}`, counterparty: shop.display_name, merchantId: shop.id,
        });
        return { shop, wallet, txId: out.transaction_id, token: merchantToken(shop) };
    }
    const refund = (s) => app.call('POST', '/api/merchant/refunds', { transaction_id: s.txId }, s.token);
    const balance = async (w) => Number((await pool.query('SELECT balance FROM wallets WHERE id = $1', [w.id])).rows[0].balance);

    it('returns an unpaid-out sale to the customer', async () => {
        const s = await sale(1200);

        const r = await refund(s);

        assert.equal(r.status, 200);
        assert.equal(await balance(s.wallet), 5000);
        assert.equal(await f.books.owed(pool, `merchant:${s.shop.id}`), 0);
        assert.deepEqual(await f.books.unbalanced(pool), []);
    });

    it("refuses a sale that was already paid out to the merchant's PayPal", async () => {
        const s = await sale(1200);
        const p = await payouts.queue(pool, { merchantId: s.shop.id, account: `merchant:${s.shop.id}`, recipientEmail: s.shop.paypal_email, amountCents: 1200 });
        await payouts.submit(pool, p); // simulated: SUCCESS
        const poolBefore = await f.books.pool(pool);

        const r = await refund(s);

        assert.equal(r.status, 409);
        assert.equal(await balance(s.wallet), 3800, 'PulsePay does not pay the refund out of other people\'s money');
        assert.equal(await f.books.owed(pool, `merchant:${s.shop.id}`), 0);
        assert.equal(await f.books.pool(pool), poolBefore);
    });

    it('refuses while the payout for that sale is on its way', async () => {
        const s = await sale(1200);
        await payouts.queue(pool, { merchantId: s.shop.id, account: `merchant:${s.shop.id}`, recipientEmail: s.shop.paypal_email, amountCents: 1200 });

        assert.equal((await refund(s)).status, 409);
        assert.equal(await balance(s.wallet), 3800);
    });
});
