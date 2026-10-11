// The one debit path every payment and send goes through (services/payments.js).
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const f = require('./support/fixtures');
const payments = require('../services/payments');

describe('debit', { skip }, () => {
    let db, pool, shop;
    before(async () => { db = await freshDatabase(); pool = db.pool; shop = await f.merchant(pool); });
    after(() => db.close());

    let n = 0;
    const pay = (walletId, amountCents, extra = {}) => payments.debit(pool, {
        requestId: `pay:test-${++n}`, walletId, amountCents, kind: 'payment',
        counterAccount: `merchant:${shop.id}`, counterparty: shop.display_name, merchantId: shop.id, ...extra,
    });
    const balance = async (id) => Number((await pool.query('SELECT balance FROM wallets WHERE id = $1', [id])).rows[0].balance);

    it('moves the amount from the wallet to what PulsePay owes the merchant', async () => {
        const { wallet } = await f.fundedCustomer(pool, 5000);
        const before = await f.books.owed(pool, `merchant:${shop.id}`);

        const out = await pay(wallet.id, 1275);

        assert.equal(out.ok, true);
        assert.equal(out.remaining_balance, 3725);
        assert.equal(await balance(wallet.id), 3725);
        assert.equal(await f.books.owed(pool, `merchant:${shop.id}`) - before, 1275);
        assert.deepEqual(await f.books.walletDrift(pool), []);
        assert.deepEqual(await f.books.unbalanced(pool), []);
    });

    it('lets only one of two simultaneous payments spend the same money', async () => {
        const { wallet } = await f.fundedCustomer(pool, 5000);

        const outs = await Promise.all([pay(wallet.id, 3000), pay(wallet.id, 3000)]);

        assert.equal(outs.filter((o) => o.ok).length, 1);
        assert.deepEqual(outs.find((o) => !o.ok), { ok: false, http: 400, status: 'failed', error: 'Insufficient balance' });
        assert.equal(await balance(wallet.id), 2000);
        assert.deepEqual(await f.books.walletDrift(pool), []);
    });

    it('debits once when the same request is retried, and returns the same receipt', async () => {
        const { wallet } = await f.fundedCustomer(pool, 5000);
        const args = { requestId: `send:${wallet.id}:retry-key-1` };

        const first = await pay(wallet.id, 1000, args);
        const again = await Promise.all([pay(wallet.id, 1000, args), pay(wallet.id, 1000, args)]);

        assert.equal(await balance(wallet.id), 4000);
        for (const o of again) assert.equal(o.transaction_id, first.transaction_id);
    });

    it('moves no money when the pay session check inside the transaction fails', async () => {
        const { wallet } = await f.fundedCustomer(pool, 5000);
        const out = await pay(wallet.id, 1000, {
            beforeReserve: async () => { const e = new Error('session_unavailable'); e.code = 'session_unavailable'; throw e; },
        });

        assert.equal(out.http, 409);
        assert.equal(await balance(wallet.id), 5000);
        assert.equal((await f.books.rows(pool, `wallet:${wallet.id}`)).filter((l) => l.kind === 'payment').length, 0);
    });

    it('refuses an expired wallet', async () => {
        const { wallet } = await f.fundedCustomer(pool, 5000);
        await pool.query(`UPDATE wallets SET expiry = NOW() - INTERVAL '1 minute' WHERE id = $1`, [wallet.id]);

        const out = await pay(wallet.id, 100);

        assert.equal(out.http, 404);
        assert.equal(await balance(wallet.id), 5000);
    });

    it("stops a family member at their spending cap", async () => {
        const { wallet } = await f.fundedCustomer(pool, 5000);
        const kid = await f.customer(pool);
        await pool.query(
            'INSERT INTO delegated_wallets (parent_wallet_id, delegate_subject_id, spending_cap) VALUES ($1,$2,1000)', [wallet.id, kid.id]
        );

        assert.equal((await pay(wallet.id, 800, { delegateSubjectId: kid.id })).ok, true);
        const over = await pay(wallet.id, 300, { delegateSubjectId: kid.id });

        assert.equal(over.http, 403);
        assert.equal(await balance(wallet.id), 4200);
        const d = (await pool.query('SELECT spent_total FROM delegated_wallets WHERE delegate_subject_id = $1', [kid.id])).rows[0];
        assert.equal(Number(d.spent_total), 800);
    });
});
