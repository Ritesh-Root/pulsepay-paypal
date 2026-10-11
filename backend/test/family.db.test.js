// POST /api/family/add-delegate input checks.
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startApp, customerToken } = require('./support/http');
const { vec } = require('./support/vectors');
const f = require('./support/fixtures');

describe('adding a family member', { skip }, () => {
    let db, pool, app, owner, seed = 7000;
    before(async () => {
        db = await freshDatabase(); pool = db.pool; app = await startApp(pool);
        owner = await f.fundedCustomer(pool, 5000);
    });
    after(async () => { await app.close(); await db.close(); });

    const add = (extra) => app.call('POST', '/api/family/add-delegate', {
        parent_wallet_id: owner.wallet.id, owner_pin: f.PIN, delegate_name: 'Sam',
        delegate_fingerprint_embedding: vec(seed += 1), delegate_pin: '4826', spending_cap: '20', ...extra,
    }, customerToken(owner.user));

    it('adds a delegate with a cap in dollars', async () => {
        const r = await add({});
        assert.equal(r.status, 200);
        assert.equal(r.body.delegate.spending_cap, 2000);
    });

    it('refuses a cap that is not a plain dollar amount', async () => {
        assert.equal((await add({ spending_cap: '1e3' })).status, 400);
        assert.equal((await add({ spending_cap: '-5' })).status, 400);
    });

    it('refuses an expiry that is not a future date', async () => {
        assert.equal((await add({ per_delegate_expiry: 'next tuesday' })).status, 400);
        assert.equal((await add({ per_delegate_expiry: '2020-01-01T00:00:00Z' })).status, 400);
        assert.equal((await add({ per_delegate_expiry: new Date(Date.now() + 86400e3).toISOString() })).status, 200);
    });
});
