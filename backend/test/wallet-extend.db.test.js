// POST /api/wallet/extend: push the expiry out by 72 hours, never past the 7-day lifetime.
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startApp, customerToken } = require('./support/http');
const f = require('./support/fixtures');

describe('extending a wallet', { skip }, () => {
    let db, pool, app;
    before(async () => { db = await freshDatabase(); pool = db.pool; app = await startApp(pool); });
    after(async () => { await app.close(); await db.close(); });

    const extend = (walletId, user) => app.call('POST', '/api/wallet/extend', { wallet_id: walletId }, customerToken(user));

    it('moves the expiry 72 hours from now', async () => {
        const { user, wallet } = await f.fundedCustomer(pool, 2000);
        const r = await extend(wallet.id, user);
        assert.equal(r.status, 200);
        const hours = (new Date(r.body.new_expiry) - Date.now()) / 3600e3;
        assert.ok(hours > 71.9 && hours <= 72, `${hours}`);
    });

    it('does not bring back a wallet that has already expired', async () => {
        const { user, wallet } = await f.fundedCustomer(pool, 2000);
        await pool.query(`UPDATE wallets SET expiry = NOW() - INTERVAL '1 minute' WHERE id = $1`, [wallet.id]);

        assert.equal((await extend(wallet.id, user)).status, 410);
        assert.ok(new Date((await pool.query('SELECT expiry FROM wallets WHERE id = $1', [wallet.id])).rows[0].expiry) < new Date());
    });

    it('is only for the wallet owner, not family members', async () => {
        const { wallet } = await f.fundedCustomer(pool, 2000);
        const kid = await f.customer(pool);
        await pool.query('INSERT INTO delegated_wallets (parent_wallet_id, delegate_subject_id, spending_cap) VALUES ($1,$2,1000)', [wallet.id, kid.id]);

        assert.equal((await extend(wallet.id, kid)).status, 403);
    });
});
