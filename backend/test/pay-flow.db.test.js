// The merchant terminal over HTTP: scan -> amount -> PIN -> paid -> signed out.
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
process.env.PAYOUT_MODE = 'manual'; // payouts have their own tests
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const { startApp, merchantToken, customerToken } = require('./support/http');
const { vec, near } = require('./support/vectors');
const f = require('./support/fixtures');

describe('merchant terminal', { skip }, () => {
    let db, pool, app, shop, shopToken;
    before(async () => {
        db = await freshDatabase();
        pool = db.pool;
        app = await startApp(pool);
        shop = await f.merchant(pool);
        shopToken = merchantToken(shop);
    });
    after(async () => { await app.close(); await db.close(); });

    let seed = 1000;
    /** A customer holding `cents` whose payment finger (and face/distress finger) are enrolled. */
    async function enrolled(cents, { idMethod = 'fingerprint', distress = false, emergencyContact = '14155550911' } = {}) {
        const c = await f.fundedCustomer(pool, cents, { idMethod, emergencyContact });
        const scans = { finger: vec(seed += 10), face: vec(seed += 10), distress: vec(seed += 10) };
        if (idMethod !== 'face') await f.enrolScan(pool, c.user.id, scans.finger);
        if (idMethod !== 'fingerprint') await f.enrolScan(pool, c.user.id, scans.face, { type: 'face' });
        if (distress) await f.enrolScan(pool, c.user.id, scans.distress, { purpose: 'distress' });
        return { ...c, scans };
    }
    const scan = (v, method = 'fingerprint', extra = {}, token = shopToken) =>
        app.call('POST', '/api/payment/identify', { method, embedding: near(v, 0.97, seed += 1), ...extra }, token);
    const pay = (session_token, amount, pin = f.PIN, token = shopToken) =>
        app.call('POST', '/api/payment/pay', { session_token, amount, pin }, token);
    const balance = async (w) => Number((await pool.query('SELECT balance FROM wallets WHERE id = $1', [w.id])).rows[0].balance);

    it('identifies the customer by scan, charges after the PIN, and signs them out', async () => {
        const c = await enrolled(5000);

        const id = await scan(c.scans.finger);
        assert.equal(id.status, 200);
        assert.equal(id.body.ready, true);
        assert.equal(id.body.customer_label, `Customer ••${c.user.phone.slice(-4)}`);

        const paid = await pay(id.body.session_token, '12.50');
        assert.equal(paid.status, 200);
        assert.equal(paid.body.status, 'completed');
        assert.equal(await balance(c.wallet), 3750);
        assert.equal(await f.books.owed(pool, `merchant:${shop.id}`) >= 1250, true);

        const again = await pay(id.body.session_token, '30.00');
        assert.equal(again.body.transaction_id, paid.body.transaction_id, 'a replay returns the first receipt');
        assert.equal(await balance(c.wallet), 3750, 'and charges nothing more');
    });

    it('does not recognise someone who is not enrolled', async () => {
        const r = await scan(vec(424242));
        assert.equal(r.status, 404);
    });

    it('ends the session when the merchant cancels', async () => {
        const c = await enrolled(5000);
        const id = await scan(c.scans.finger);

        await app.call('POST', '/api/payment/cancel', { session_token: id.body.session_token }, shopToken);
        const r = await pay(id.body.session_token, '5.00');

        assert.equal(r.status, 410);
        assert.equal(await balance(c.wallet), 5000);
    });

    it('locks the PIN after three wrong tries and ends the session', async () => {
        const c = await enrolled(5000);
        const id = await scan(c.scans.finger);

        const tries = [];
        for (let i = 0; i < 3; i++) tries.push((await pay(id.body.session_token, '5.00', '9999')).status);
        assert.deepEqual(tries, [401, 401, 423]);

        assert.equal((await pay(id.body.session_token, '5.00')).status, 410);
        assert.equal((await pay((await scan(c.scans.finger)).body.session_token, '5.00')).status, 423, 'still locked on a new scan');
        assert.equal(await balance(c.wallet), 5000);
    });

    it('refuses an amount over the per-payment limit before asking for the PIN', async () => {
        const c = await enrolled(15000);
        const id = await scan(c.scans.finger);

        const r = await pay(id.body.session_token, '100.01', '9999');

        assert.equal(r.status, 400);
        const u = (await pool.query('SELECT pin_failed_attempts FROM users WHERE id = $1', [c.user.id])).rows[0];
        assert.equal(u.pin_failed_attempts, 0, 'the wrong PIN was never checked');
    });

    it('asks a customer who chose both for their face before they can pay', async () => {
        const c = await enrolled(5000, { idMethod: 'both' });

        const first = await scan(c.scans.finger);
        assert.equal(first.body.ready, false);
        assert.equal(first.body.next_scan, 'face');
        assert.equal((await pay(first.body.session_token, '5.00')).status, 400);

        const someoneElse = await enrolled(5000, { idMethod: 'both' });
        const wrongFace = await scan(someoneElse.scans.face, 'face', { session_token: first.body.session_token });
        assert.equal(wrongFace.status, 401, "another person's face does not complete the session");

        const second = await scan(c.scans.face, 'face', { session_token: first.body.session_token });
        assert.equal(second.body.ready, true);
        assert.equal((await pay(first.body.session_token, '5.00')).status, 200);
        assert.equal(await balance(c.wallet), 4500);
    });

    it('pays at most $25 with the distress finger, looks normal, and raises an alert', async () => {
        const normal = await enrolled(9000);
        const forced = await enrolled(9000, { distress: true });

        const idNormal = await scan(normal.scans.finger);
        const a = await pay(idNormal.body.session_token, '80.00');
        const idForced = await scan(forced.scans.distress);
        const b = await pay(idForced.body.session_token, '80.00');

        // Everything but ids, times and the masked label is identical to a normal payment.
        const scanView = ({ session_token, expires_at, customer_label, ...rest }) => rest;
        const receipt = ({ transaction_id, payment_ref, timestamp, ...rest }) => rest;
        assert.deepEqual(scanView(idForced.body), scanView(idNormal.body));
        assert.equal(b.status, a.status);
        assert.deepEqual(receipt(b.body), receipt(a.body));
        assert.deepEqual(Object.keys(b.body).sort(), Object.keys(a.body).sort());
        assert.equal(await balance(normal.wallet), 1000);
        assert.equal(await balance(forced.wallet), 6500);

        let alerts = 0;
        for (let i = 0; i < 40 && !alerts; i++) {
            alerts = (await pool.query(`SELECT COUNT(*)::int AS n FROM aml_alerts WHERE identity_id = $1 AND alert_type = 'distress'`, [forced.user.id])).rows[0].n;
            if (!alerts) await new Promise((r) => setTimeout(r, 50));
        }
        assert.equal(alerts, 1);
    });

    it("rejects another merchant's session token", async () => {
        const c = await enrolled(5000);
        const id = await scan(c.scans.finger);
        const other = merchantToken(await f.merchant(pool));

        assert.equal((await pay(id.body.session_token, '5.00', f.PIN, other)).status, 410);
        assert.equal(await balance(c.wallet), 5000);
    });

    it('keeps customer and merchant tokens to their own routes', async () => {
        const c = await enrolled(5000);
        const asCustomer = await app.call('POST', '/api/payment/identify', { method: 'fingerprint', embedding: c.scans.finger }, customerToken(c.user));
        const asMerchant = await app.call('GET', `/api/wallet/${c.wallet.id}`, undefined, shopToken);

        assert.equal(asCustomer.status, 401);
        assert.equal(asMerchant.status, 401);
    });
});
