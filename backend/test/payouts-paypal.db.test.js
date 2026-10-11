// Payouts against the PayPal REST API (a local fake that follows PayPal's documented behaviour).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startFakePayPal, useFakePayPal } = require('./support/fake-paypal');
const f = require('./support/fixtures');
const payments = require('../services/payments');
const payouts = require('../services/payouts');

describe('payouts (PayPal REST)', { skip }, () => {
    let db, pool, paypal;
    before(async () => {
        paypal = await startFakePayPal();
        useFakePayPal(paypal);
        db = await freshDatabase();
        pool = db.pool;
    });
    after(async () => { await db.close(); await paypal.close(); });

    /** A merchant who is owed `cents` from one sale, and the payout row for it. */
    async function owedMerchant(cents) {
        const m = await f.merchant(pool);
        const { wallet } = await f.fundedCustomer(pool, 5000, { approve: paypal.approve });
        const out = await payments.debit(pool, {
            requestId: `pay:${wallet.id}`, walletId: wallet.id, amountCents: cents, kind: 'payment',
            counterAccount: `merchant:${m.id}`, counterparty: m.display_name, merchantId: m.id,
        });
        assert.equal(out.ok, true);
        const p = await payouts.queue(pool, {
            merchantId: m.id, account: `merchant:${m.id}`, recipientEmail: m.paypal_email, amountCents: cents,
        });
        return { m, p, account: `merchant:${m.id}` };
    }
    const status = async (p) => (await pool.query('SELECT status FROM payouts WHERE id = $1', [p.id])).rows[0].status;
    const batchesFor = (email) => [...paypal.state.batches.values()].filter((b) => b.item.receiver === email);

    it('a payout PayPal accepted is not settled until its item succeeds', async () => {
        const { m, p, account } = await owedMerchant(1250);
        paypal.state.payoutItemStatus = 'PENDING';

        await payouts.submit(pool, p);
        assert.equal(await status(p), 'PENDING');
        assert.equal(await f.books.owed(pool, account), 1250, 'still owed while PayPal processes it');
        assert.deepEqual(await payouts.available(pool, account), { owed: 1250, in_flight: 1250, available: 0 });

        paypal.state.payoutItemStatus = 'SUCCESS';
        await payouts.refresh(pool, (await pool.query('SELECT * FROM payouts WHERE id = $1', [p.id])).rows[0]);
        assert.equal(await status(p), 'SUCCESS');
        assert.equal(await f.books.owed(pool, account), 0);
        assert.equal(batchesFor(m.paypal_email)[0].item.amount.value, '12.50');
    });

    it('a payout whose response was lost is paid exactly once when retried', async () => {
        const { m, p, account } = await owedMerchant(900);
        paypal.state.payoutItemStatus = 'SUCCESS';
        paypal.fault('create-payout', 'lose-response'); // PayPal creates the batch, we never hear back

        await payouts.submit(pool, p);
        assert.equal(await status(p), 'queued', 'a network failure is retried, not failed');

        await payouts.submit(pool, (await pool.query('SELECT * FROM payouts WHERE id = $1', [p.id])).rows[0]);
        assert.equal(await status(p), 'PENDING', 'the retry found the original batch');
        await payouts.refresh(pool, (await pool.query('SELECT * FROM payouts WHERE id = $1', [p.id])).rows[0]);

        assert.equal(batchesFor(m.paypal_email).length, 1, 'PayPal paid the merchant once');
        assert.equal(await status(p), 'SUCCESS');
        assert.equal(await f.books.owed(pool, account), 0);
        assert.equal((await payouts.available(pool, account)).available, 0, 'nothing left to cash out again');
    });

    it('a returned item in a processed batch leaves the debt owed', async () => {
        const { p, account } = await owedMerchant(1100);
        paypal.state.payoutItemStatus = 'PENDING';
        await payouts.submit(pool, p);

        paypal.state.payoutItemStatus = 'RETURNED'; // the batch reports SUCCESS, the item does not
        await payouts.refresh(pool, (await pool.query('SELECT * FROM payouts WHERE id = $1', [p.id])).rows[0]);

        assert.equal(await status(p), 'RETURNED');
        assert.equal(await f.books.owed(pool, account), 1100);
        assert.equal((await payouts.available(pool, account)).available, 1100);
    });

    it('PayPal being unavailable leaves the payout queued for the next sweep', async () => {
        const { m, p, account } = await owedMerchant(700);
        paypal.fault('create-payout', 'unavailable');

        await payouts.submit(pool, p);

        assert.equal(await status(p), 'queued');
        assert.equal(batchesFor(m.paypal_email).length, 0);
        assert.equal(await f.books.owed(pool, account), 700);
    });
});
