// Wallet top-ups through PayPal Checkout (Orders v2), against the local fake PayPal.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startFakePayPal, useFakePayPal } = require('./support/fake-paypal');
const f = require('./support/fixtures');
const funding = require('../services/funding');

describe('top-ups (PayPal Orders v2)', { skip }, () => {
    let db, pool, paypal;
    before(async () => {
        paypal = await startFakePayPal();
        useFakePayPal(paypal);
        db = await freshDatabase();
        pool = db.pool;
    });
    after(async () => { await db.close(); await paypal.close(); });

    const orderStatus = async (id) => (await pool.query('SELECT status FROM paypal_orders WHERE order_id = $1', [id])).rows[0].status;
    const captureCalls = (id) => paypal.state.requests.filter((r) => r.route === 'capture-order' && r.path.includes(id)).length;

    async function approvedOrder(walletId, cents) {
        const o = await funding.createOrder(pool, { purpose: 'topup', walletId, amountCents: cents });
        paypal.approve(o.order_id);
        return o.order_id;
    }

    it('credits the wallet with what PayPal captured and remembers the payer', async () => {
        const { wallet } = await f.fundedCustomer(pool, 0);
        await f.topUp(pool, wallet.id, 4500, { approve: paypal.approve });

        const w = (await pool.query('SELECT balance FROM wallets WHERE id = $1', [wallet.id])).rows[0];
        const fund = (await pool.query('SELECT * FROM wallet_fundings WHERE wallet_id = $1', [wallet.id])).rows[0];
        assert.equal(Number(w.balance), 4500);
        assert.equal(Number(fund.amount), 4500);
        assert.equal(fund.payer_email, 'sb-buyer@personal.example.com');
        assert.equal(fund.simulated, false);
        assert.ok(paypal.state.captures.has(fund.capture_id), 'the recorded capture id is the real PayPal capture');
        assert.deepEqual(await f.books.walletDrift(pool), []);
        assert.deepEqual(await f.books.unbalanced(pool), []);
    });

    it('lets only one of two simultaneous requests capture an order', async () => {
        const { wallet } = await f.fundedCustomer(pool, 0);
        const id = await approvedOrder(wallet.id, 2000);
        const match = { purpose: 'topup', walletId: wallet.id };

        const results = await Promise.allSettled([
            funding.claimAndCapture(pool, id, match),
            funding.claimAndCapture(pool, id, match),
        ]);

        assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
        assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'order_unavailable');
        assert.equal(captureCalls(id), 1);
    });

    it("refuses an order created for someone else's wallet", async () => {
        const a = await f.fundedCustomer(pool, 0);
        const b = await f.fundedCustomer(pool, 0);
        const id = await approvedOrder(a.wallet.id, 2000);

        await assert.rejects(funding.claimAndCapture(pool, id, { purpose: 'topup', walletId: b.wallet.id }), { code: 'order_unavailable' });
        assert.equal(captureCalls(id), 0);
        assert.equal(await orderStatus(id), 'created', 'still usable by its own wallet');
    });

    it('refuses an enrolment order from a different phone', async () => {
        const o = await funding.createOrder(pool, { purpose: 'enrol', phone: '14155550100', amountCents: 2000 });
        paypal.approve(o.order_id);

        await assert.rejects(funding.claimAndCapture(pool, o.order_id, { purpose: 'enrol', phone: '14155550199' }), { code: 'order_unavailable' });
        const ok = await funding.claimAndCapture(pool, o.order_id, { purpose: 'enrol', phone: '14155550100' });
        assert.equal(ok.capture.amountCents, 2000);
    });

    it('lets the customer retry with another funding source after a decline', async () => {
        const { wallet } = await f.fundedCustomer(pool, 0);
        const id = await approvedOrder(wallet.id, 3000);
        paypal.state.nextCaptureIssue = 'INSTRUMENT_DECLINED';

        await assert.rejects(funding.claimAndCapture(pool, id, { purpose: 'topup', walletId: wallet.id }), { code: 'payment_declined' });
        assert.equal(await orderStatus(id), 'created');

        const ok = await funding.claimAndCapture(pool, id, { purpose: 'topup', walletId: wallet.id });
        assert.equal(ok.capture.amountCents, 3000);
    });

    it('completes a capture whose response was lost on retry, without capturing twice', async () => {
        const { wallet } = await f.fundedCustomer(pool, 0);
        const id = await approvedOrder(wallet.id, 2500);
        paypal.fault('capture-order', 'lose-response'); // PayPal captures, we never hear back

        await assert.rejects(funding.claimAndCapture(pool, id, { purpose: 'topup', walletId: wallet.id }));
        assert.equal(await orderStatus(id), 'created', 'the customer can retry');

        const ok = await funding.claimAndCapture(pool, id, { purpose: 'topup', walletId: wallet.id });
        assert.equal(ok.capture.amountCents, 2500);
        const captures = [...paypal.state.captures.entries()].filter(([, c]) => c.orderId === id);
        assert.equal(captures.length, 1, 'PayPal captured the order once');
        assert.equal(captures[0][0], ok.capture.captureId, 'and we recorded that capture');
    });

    describe('sweep of unconfirmed captures', () => {
        async function unconfirmedOrder(cents) {
            const { wallet } = await f.fundedCustomer(pool, 0);
            const id = await approvedOrder(wallet.id, cents);
            paypal.fault('capture-order', 'lose-response');
            await assert.rejects(funding.claimAndCapture(pool, id, { purpose: 'topup', walletId: wallet.id }));
            return id;
        }
        const capturesOf = (id) => [...paypal.state.captures.values()].filter((c) => c.orderId === id);
        const age = (id, minutes) => pool.query(
            `UPDATE paypal_orders SET unconfirmed_at = NOW() - make_interval(mins => $2) WHERE order_id = $1`, [id, minutes]
        );

        it('refunds a capture the customer never came back for', async () => {
            const id = await unconfirmedOrder(1800);
            await age(id, 15);

            await funding.sweepUnconfirmed(pool);

            assert.equal(capturesOf(id).length, 1, 'not captured a second time');
            assert.equal(capturesOf(id)[0].refundedCents, 1800);
            assert.equal(await orderStatus(id), 'failed');
        });

        it("leaves a recent one for the customer's own retry", async () => {
            const id = await unconfirmedOrder(1600);

            await funding.sweepUnconfirmed(pool);

            assert.equal(await orderStatus(id), 'created');
            assert.equal(capturesOf(id)[0].refundedCents, 0);
        });

        it('never captures an order that was only approved', async () => {
            const { wallet } = await f.fundedCustomer(pool, 0);
            const id = await approvedOrder(wallet.id, 1400);
            await pool.query(`UPDATE paypal_orders SET created_at = NOW() - INTERVAL '1 hour' WHERE order_id = $1`, [id]);

            await funding.sweepUnconfirmed(pool);

            assert.equal(capturesOf(id).length, 0);
            assert.equal(await orderStatus(id), 'created');
        });
    });

    it('refunds and fails a capture for a different amount than the order', async () => {
        const { wallet } = await f.fundedCustomer(pool, 0);
        const id = await approvedOrder(wallet.id, 5000);
        paypal.state.nextCaptureAmount = '5.00';

        await assert.rejects(funding.claimAndCapture(pool, id, { purpose: 'topup', walletId: wallet.id }), { code: 'capture_mismatch' });

        assert.equal(await orderStatus(id), 'failed');
        const [capture] = [...paypal.state.captures.values()].filter((c) => c.amountCents === 500);
        assert.equal(capture.refundedCents, 500, 'the customer got the unexpected capture back');
        assert.equal(Number((await pool.query('SELECT balance FROM wallets WHERE id = $1', [wallet.id])).rows[0].balance), 0);
    });
});
