// Paid PayPal invoices are credited to the merchant exactly once (services/invoices.js).
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
process.env.PAYOUT_MODE = 'manual'; // keep payouts out of this test

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const f = require('./support/fixtures');
const invoices = require('../services/invoices');

describe('invoice credits', { skip }, () => {
    let db, pool;
    before(async () => { db = await freshDatabase(); pool = db.pool; });
    after(() => db.close());

    it('credits a paid invoice to its merchant once, however many times PayPal reports it', async () => {
        const m = await f.merchant(pool);
        await invoices.record(pool, { invoiceId: 'INV2-AAAA-1111', merchantId: m.id, recipientEmail: 'sam@example.com', amountCents: 900 });

        const results = await Promise.all([
            invoices.creditIfPaid(pool, 'INV2-AAAA-1111', '9.00'),
            invoices.creditIfPaid(pool, 'INV2-AAAA-1111', '9.00'),
        ]);
        const later = await invoices.creditIfPaid(pool, 'INV2-AAAA-1111', '9.00');

        assert.deepEqual(results.sort(), [false, true]);
        assert.equal(later, false);
        assert.equal(await f.books.owed(pool, `merchant:${m.id}`), 900);
        assert.equal(await f.books.pool(pool), 900);
        assert.deepEqual(await f.books.unbalanced(pool), []);
    });

    it("ignores invoices PulsePay didn't issue", async () => {
        assert.equal(await invoices.creditIfPaid(pool, 'INV2-NOT-OURS', '50.00'), false);
        assert.equal((await pool.query(`SELECT COUNT(*)::int AS n FROM ledger_entries WHERE kind = 'invoice' AND external_ref = 'INV2-NOT-OURS'`)).rows[0].n, 0);
    });
});
