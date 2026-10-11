// Payouts with simulated PayPal rails (no PayPal credentials).
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const f = require('./support/fixtures');
const payments = require('../services/payments');
const payouts = require('../services/payouts');

describe('payouts (simulated PayPal)', { skip }, () => {
    let db, pool;
    before(async () => { db = await freshDatabase(); pool = db.pool; });
    after(() => db.close());

    async function sale(merchant, cents) {
        const { wallet } = await f.fundedCustomer(pool, 5000);
        const out = await payments.debit(pool, {
            requestId: `pay:${wallet.id}`, walletId: wallet.id, amountCents: cents, kind: 'payment',
            counterAccount: `merchant:${merchant.id}`, counterparty: merchant.display_name, merchantId: merchant.id,
        });
        assert.equal(out.ok, true);
    }

    it("a completed payout clears what PulsePay owes the merchant and leaves the PayPal pool", async () => {
        const m = await f.merchant(pool);
        await sale(m, 1250);
        assert.equal(await f.books.owed(pool, `merchant:${m.id}`), 1250);

        const p = await payouts.queue(pool, {
            merchantId: m.id, account: `merchant:${m.id}`, recipientEmail: m.paypal_email, amountCents: 1250,
        });
        await payouts.submit(pool, p);

        const row = (await pool.query('SELECT status FROM payouts WHERE id = $1', [p.id])).rows[0];
        assert.equal(row.status, 'SUCCESS');
        assert.equal(await f.books.owed(pool, `merchant:${m.id}`), 0);
        assert.equal((await payouts.available(pool, `merchant:${m.id}`)).available, 0);
        assert.deepEqual(await f.books.unbalanced(pool), []);
    });

    it('a payout reported SUCCESS twice (webhook and poll) is ledgered once', async () => {
        const m = await f.merchant(pool);
        await sale(m, 800);
        const p = await payouts.queue(pool, {
            merchantId: m.id, account: `merchant:${m.id}`, recipientEmail: m.paypal_email, amountCents: 800,
        });
        await Promise.all([
            payouts.applyStatus(pool, p.id, { status: 'SUCCESS', itemId: 'ITEM-1' }),
            payouts.applyStatus(pool, p.id, { status: 'SUCCESS', itemId: 'ITEM-1' }),
        ]);
        await payouts.applyStatus(pool, p.id, { status: 'SUCCESS', itemId: 'ITEM-1' });

        assert.equal((await f.books.rows(pool, `merchant:${m.id}`)).filter((l) => l.kind === 'payout').length, 1);
        assert.equal(await f.books.owed(pool, `merchant:${m.id}`), 0);
    });

    it('never queues a payout for more than PulsePay owes', async () => {
        const m = await f.merchant(pool);
        await sale(m, 1250);
        const args = { merchantId: m.id, account: `merchant:${m.id}`, recipientEmail: m.paypal_email };

        assert.equal(await payouts.queue(pool, { ...args, amountCents: 2000 }), null);
        assert.ok(await payouts.queue(pool, { ...args, amountCents: 1250 }));
        assert.equal(await payouts.queue(pool, { ...args, amountCents: 1 }), null, 'the first payout already covers it');
    });

    it('a failed payout leaves the debt owed and available for the next cash-out', async () => {
        const m = await f.merchant(pool);
        await sale(m, 600);
        const p = await payouts.queue(pool, {
            merchantId: m.id, account: `merchant:${m.id}`, recipientEmail: m.paypal_email, amountCents: 600,
        });
        assert.equal((await payouts.available(pool, `merchant:${m.id}`)).available, 0, 'queued payout is in flight');

        await payouts.applyStatus(pool, p.id, { status: 'RETURNED', error: 'Receiver is unregistered' });

        assert.equal(await f.books.owed(pool, `merchant:${m.id}`), 600);
        assert.deepEqual(await payouts.available(pool, `merchant:${m.id}`), { owed: 600, in_flight: 0, available: 600 });
    });
});
