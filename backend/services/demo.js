/**
 * "Try the demo": one tap gives a visitor (a hackathon judge) their own shop and their
 * own customer, so the whole counter flow runs on any device, without a camera and
 * without anyone else's data showing up.
 *
 *   shop      a merchant flagged is_demo, with this morning's sales already paid out
 *             (the last one unusually large, so the assistant has something to explain)
 *   customer  a $50 wallet, an enrolled demo fingerprint and a PIN, returned to the
 *             app so it can stand in for the scanner
 *
 * All demo money goes through the simulator, even when PayPal is configured: none of
 * it ever reached PayPal, so none of it may leave through PayPal. server.js refuses
 * DEMO_MODE when PayPal is live.
 */
const crypto = require('crypto');
const { generateToken } = require('../middleware/auth');
const { validatePin } = require('../middleware/validate');
const biometric = require('./biometric');
const funding = require('./funding');
const ledger = require('./ledger');
const payments = require('./payments');
const payouts = require('./payouts');
const pin = require('./pin');

const SAMPLE_SALES_CENTS = [450, 325, 1200, 680, 540, 4800]; // oldest first; the last is unusually large
const SAMPLE_MINUTES_AGO = [290, 235, 170, 115, 60, 18];
const CUSTOMER_WALLET_CENTS = 5000;
const SCAN_DIM = 1024; // the CV service's embedding size

const digits = (n) => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');
const demoPhone = () => `1555${digits(7)}`; // 555 numbers are reserved for fiction

function demoPin() {
    for (;;) {
        const p = digits(4);
        if (validatePin(p).ok) return p;
    }
}

function demoScan() {
    return Array.from({ length: SCAN_DIM }, () => crypto.randomInt(-1e6, 1e6) / 1e6);
}

async function walletFor(pool, userId, cents) {
    const w = (await pool.query(
        `INSERT INTO wallets (user_id, expiry, max_lifetime)
         VALUES ($1, NOW() + INTERVAL '72 hours', NOW() + INTERVAL '7 days') RETURNING *`,
        [userId]
    )).rows[0];
    const o = await funding.createOrder(pool, { purpose: 'topup', walletId: w.id, amountCents: cents, simulated: true });
    const { order, capture } = await funding.claimAndCapture(pool, o.order_id, { purpose: 'topup', walletId: w.id });
    await funding.creditTopUp(pool, { walletId: w.id, order, capture });
    return w;
}

/** This morning's sales at the shop, each already paid out (simulated). */
async function seedSales(pool, shop) {
    const regular = (await pool.query('INSERT INTO users (phone) VALUES ($1) RETURNING id', [demoPhone()])).rows[0];
    const w = await walletFor(pool, regular.id, SAMPLE_SALES_CENTS.reduce((a, b) => a + b, 0));
    for (let i = 0; i < SAMPLE_SALES_CENTS.length; i++) {
        const amountCents = SAMPLE_SALES_CENTS[i];
        const requestId = `demo:${shop.id}:${i}`;
        await payments.debit(pool, {
            requestId, walletId: w.id, amountCents, kind: 'payment',
            counterAccount: ledger.merchantAccount(shop.id), counterparty: shop.display_name, merchantId: shop.id,
            authTier: 'fingerprint+pin',
        });
        const p = await payouts.queue(pool, {
            merchantId: shop.id, account: ledger.merchantAccount(shop.id), recipientEmail: shop.paypal_email,
            amountCents, sourceRequest: requestId, simulated: true,
        });
        await payouts.submit(pool, p);
        // Spread the sales over the morning (never before midnight), keeping their order.
        const at = `GREATEST(date_trunc('day', NOW()) + make_interval(secs => $2), NOW() - make_interval(mins => $3))`;
        const args = [requestId, i, SAMPLE_MINUTES_AGO[i]];
        await pool.query(`UPDATE ledger_entries SET created_at = ${at} WHERE request_id = $1`, args);
        await pool.query(
            `UPDATE transactions SET created_at = ${at}
              WHERE ledger_entry_id IN (SELECT id FROM ledger_entries WHERE request_id = $1)`, args
        );
        await pool.query(`UPDATE payouts SET created_at = ${at}, updated_at = ${at} WHERE source_request = $1`, args);
    }
}

async function start(pool) {
    const shop = (await pool.query(
        `INSERT INTO merchants (phone, display_name, paypal_email, is_demo) VALUES ($1,$2,$3,true) RETURNING *`,
        [demoPhone(), 'Demo Café', `demo-${crypto.randomBytes(5).toString('hex')}@business.example.com`]
    )).rows[0];
    await seedSales(pool, shop);

    const code = demoPin();
    const phone = demoPhone();
    const user = (await pool.query(
        `INSERT INTO users (phone, pin_hash, id_method) VALUES ($1,$2,'fingerprint') RETURNING *`,
        [phone, await pin.hashPin(code)]
    )).rows[0];
    const scan = demoScan();
    const t = biometric.protect(scan);
    await pool.query(
        `INSERT INTO biometric_templates (subject_id, template_type, purpose, protected_vector, enc_iv, enc_tag, transform_salt, kms_key_ref, model_version)
         VALUES ($1,'fingerprint','auth',$2,$3,$4,$5,$6,'demo')`,
        [user.id, t.protected_vector, t.enc_iv, t.enc_tag, t.transform_salt, t.kms_key_ref]
    );
    const wallet = await walletFor(pool, user.id, CUSTOMER_WALLET_CENTS);

    return {
        merchant: {
            token: generateToken('merchant', shop.id),
            merchant: { id: shop.id, display_name: shop.display_name, paypal_email: shop.paypal_email, is_demo: true },
        },
        customer: {
            token: generateToken('customer', user.id),
            wallet_id: wallet.id, expiry: wallet.expiry,
            label: `Customer ••${phone.slice(-4)}`, pin: code, scan,
        },
    };
}

module.exports = { start };
