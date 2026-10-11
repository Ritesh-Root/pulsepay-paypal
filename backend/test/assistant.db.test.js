// POST /api/assistant/chat against a local stand-in for Amazon Bedrock.
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
process.env.PAYOUT_MODE = 'manual';
process.env.DEMO_MODE = 'true';
process.env.DEMO_ASSISTANT_QUESTIONS = '2';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startFakeBedrock, useFakeBedrock } = require('./support/fake-bedrock');
const { startApp, merchantToken } = require('./support/http');
const f = require('./support/fixtures');
const payments = require('../services/payments');
const payouts = require('../services/payouts');

describe('AI assistant', { skip }, () => {
    let db, pool, app, bedrock;
    before(async () => {
        bedrock = await startFakeBedrock();
        useFakeBedrock(bedrock);
        db = await freshDatabase();
        pool = db.pool;
        app = await startApp(pool);
    });
    after(async () => { await app.close(); await db.close(); await bedrock.close(); });

    const ask = (token, text) => app.call('POST', '/api/assistant/chat', { messages: [{ role: 'user', text }] }, token);

    it('only proposes a refund: nothing moves until the merchant confirms', async () => {
        const shop = await f.merchant(pool);
        const { wallet } = await f.fundedCustomer(pool, 5000);
        const sale = await payments.debit(pool, {
            requestId: `pay:${wallet.id}`, walletId: wallet.id, amountCents: 1200, kind: 'payment',
            counterAccount: `merchant:${shop.id}`, counterparty: shop.display_name, merchantId: shop.id,
        });
        bedrock.script.push({ toolUse: { name: 'propose_refund', input: { transaction_id: sale.transaction_id, reason: 'wrong item' } } });
        bedrock.script.push({ text: 'I prepared the refund. Tap Confirm to send it.' });

        const r = await ask(merchantToken(shop), 'Refund the last payment');

        assert.equal(r.status, 200);
        assert.deepEqual(r.body.actions.map((a) => [a.type, a.transaction_id, a.amount_cents]), [['refund', sale.transaction_id, 1200]]);
        assert.equal(Number((await pool.query('SELECT balance FROM wallets WHERE id = $1', [wallet.id])).rows[0].balance), 3800);
        assert.equal((await pool.query('SELECT refunded FROM transactions WHERE id = $1', [sale.transaction_id])).rows[0].refunded, false);
    });

    it("doesn't offer to refund a sale that was already paid out", async () => {
        const shop = await f.merchant(pool);
        const { wallet } = await f.fundedCustomer(pool, 5000);
        const sale = await payments.debit(pool, {
            requestId: `pay:${wallet.id}`, walletId: wallet.id, amountCents: 900, kind: 'payment',
            counterAccount: `merchant:${shop.id}`, counterparty: shop.display_name, merchantId: shop.id,
        });
        await payouts.submit(pool, await payouts.queue(pool, { merchantId: shop.id, account: `merchant:${shop.id}`, recipientEmail: shop.paypal_email, amountCents: 900 }));
        bedrock.script.push({ toolUse: { name: 'propose_refund', input: { transaction_id: sale.transaction_id } } });
        bedrock.script.push({ text: 'That sale was already paid out.' });

        const r = await ask(merchantToken(shop), 'Refund the last payment');

        assert.deepEqual(r.body.actions, []);
    });

    it('never shows the model a customer phone number', async () => {
        const shop = await f.merchant(pool);
        const { user, wallet } = await f.fundedCustomer(pool, 5000);
        await payments.debit(pool, {
            requestId: `pay:${wallet.id}`, walletId: wallet.id, amountCents: 700, kind: 'payment',
            counterAccount: `merchant:${shop.id}`, counterparty: shop.display_name, merchantId: shop.id,
        });
        bedrock.script.push({ toolUse: { name: 'recent_payments', input: { limit: 5 } } });
        bedrock.script.push({ text: 'One payment of $7.00.' });
        const before = bedrock.calls.length;

        await ask(merchantToken(shop), 'Who paid me?');

        const sent = JSON.stringify(bedrock.calls.slice(before).map((c) => c.body));
        assert.ok(sent.includes(`••${user.phone.slice(-4)}`), 'the masked label is sent');
        assert.ok(!sent.includes(user.phone), 'the full number is not');
    });

    it('gives a demo shop a few questions, then stops calling Bedrock', async () => {
        const demo = (await app.call('POST', '/api/demo/start', {})).body;
        const before = bedrock.calls.length;

        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await ask(demo.merchant.token, 'How much did I take today?')).status);

        assert.deepEqual(statuses, [200, 200, 429]);
        assert.equal(bedrock.calls.length - before, 2);
    });
});
