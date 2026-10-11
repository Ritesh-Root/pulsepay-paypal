/**
 * Merchant accounts and back office.
 *
 * A merchant signs in on their own phone with phone + OTP. What customers pay them
 * is owed inside PulsePay (ledger account merchant:<id>) and paid out to the PayPal
 * email registered here with PayPal Payouts. The payout address never comes from a
 * request body.
 *
 *   POST /request-otp   { phone }
 *   POST /verify-otp    { phone, otp, display_name?, paypal_email? }   (new numbers register)
 *   GET  /me            profile + balance
 *   GET  /dashboard     sales, payouts and anomaly flags for the dashboard / assistant
 *   POST /cashout       pay the available balance out to PayPal now
 *   POST /refunds       { transaction_id, reason? }  refund a customer payment to their wallet
 */
const express = require('express');
const router = express.Router();

const { generateToken, authenticate } = require('../middleware/auth');
const { validatePhone, validateEmail, usd } = require('../middleware/validate');
const otp = require('../services/otp');
const ledger = require('../services/ledger');
const payouts = require('../services/payouts');
const merchantData = require('../services/merchantData');
const audit = require('../services/audit');

const PURPOSE = 'merchant';
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function view(m) {
    return { id: m.id, display_name: m.display_name, paypal_email: m.paypal_email };
}

router.post('/request-otp', h(async (req, res) => {
    const { phone } = req.body || {};
    if (!validatePhone(phone)) return res.status(400).json({ error: 'Enter the shop phone number with country code, digits only' });
    const r = await otp.issue({
        purpose: PURPOSE,
        phone,
        message: (code) => `Your PulsePay merchant sign-in code is ${code}. Valid 5 minutes. Do not share it.`,
    });
    if (!r.ok) return res.status(429).json({ error: 'Too many codes requested. Try again in 10 minutes.' });
    res.json({ otp_sent: true, ...(r.demo_otp ? { demo_otp: r.demo_otp } : {}) });
}));

router.post('/verify-otp', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const { phone, otp: code, display_name, paypal_email } = req.body || {};
    if (!validatePhone(phone) || !code) return res.status(400).json({ error: 'phone and otp required' });

    const check = otp.check({ purpose: PURPOSE, phone, otp: String(code) });
    if (!check.ok) {
        const msg = check.reason === 'otp_expired' ? 'Code expired. Request a new one.'
            : check.reason === 'otp_attempts_exceeded' ? 'Too many wrong codes. Request a new one.'
            : 'Incorrect code';
        return res.status(400).json({ error: msg });
    }

    let merchant = (await pool.query('SELECT * FROM merchants WHERE phone = $1', [phone])).rows[0];
    if (!merchant) {
        const name = String(display_name || '').trim();
        const email = String(paypal_email || '').trim().toLowerCase();
        if (!name || !email) {
            return res.status(409).json({ registration_required: true, error: 'New merchant: add your shop name and PayPal email' });
        }
        if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Shop name must be 2–80 characters' });
        if (!validateEmail(email)) return res.status(400).json({ error: 'Enter the email of the PayPal account that should receive payouts' });
        try {
            merchant = (await pool.query(
                'INSERT INTO merchants (phone, display_name, paypal_email) VALUES ($1,$2,$3) RETURNING *',
                [phone, name, email]
            )).rows[0];
        } catch (e) {
            if (e.code === '23505') return res.status(409).json({ error: 'That PayPal email is already registered to another merchant' });
            throw e;
        }
        await audit.append(pool, { actor: 'merchant', action: 'merchant_registered', resourceRef: merchant.id, ip: req.ip });
    }
    if (!merchant.active) return res.status(403).json({ error: 'Merchant account is disabled' });

    otp.consume({ purpose: PURPOSE, phone });
    await audit.append(pool, { actor: 'merchant', action: 'merchant_sign_in', resourceRef: merchant.id, ip: req.ip });
    res.json({ token: generateToken('merchant', merchant.id), merchant: view(merchant) });
}));

// Everything below needs a signed-in, active merchant.
const merchantOnly = [authenticate('merchant'), h(async (req, res, next) => {
    const r = await req.app.locals.pool.query('SELECT * FROM merchants WHERE id = $1 AND active = true', [req.user.id]);
    if (!r.rows.length) return res.status(401).json({ error: 'Merchant account not found', code: 'auth_required' });
    req.merchant = r.rows[0];
    next();
})];

router.get('/me', merchantOnly, h(async (req, res) => {
    const pool = req.app.locals.pool;
    res.json({ merchant: view(req.merchant), balance: await payouts.available(pool, ledger.merchantAccount(req.merchant.id)) });
}));

router.get('/dashboard', merchantOnly, h(async (req, res) => {
    res.json(await merchantData.dashboard(req.app.locals.pool, req.merchant));
}));

router.post('/cashout', merchantOnly, h(async (req, res) => {
    const pool = req.app.locals.pool;
    const account = ledger.merchantAccount(req.merchant.id);
    const bal = await payouts.available(pool, account);
    if (bal.available <= 0) return res.status(400).json({ error: 'Nothing to cash out right now', balance: bal });
    const payout = await payouts.queue(pool, {
        merchantId: req.merchant.id, account, recipientEmail: req.merchant.paypal_email,
        amountCents: bal.available, sourceRequest: 'cashout', simulated: req.merchant.is_demo || undefined,
    });
    if (!payout) return res.status(400).json({ error: 'Nothing to cash out right now', balance: await payouts.available(pool, account) });
    await payouts.submit(pool, payout);
    const fresh = (await pool.query('SELECT id, amount, status, last_error FROM payouts WHERE id = $1', [payout.id])).rows[0];
    await audit.append(pool, { actor: 'merchant', action: 'merchant_cashout', resourceRef: payout.id, ip: req.ip });
    res.json({ payout: { ...fresh, amount: Number(fresh.amount) }, message: `Sending ${usd(bal.available)} to ${req.merchant.paypal_email}` });
}));

// POST /api/merchant/refunds  { transaction_id, reason? }
// A person (not the AI assistant) confirms every refund in the merchant UI.
router.post('/refunds', merchantOnly, h(async (req, res) => {
    const out = await merchantData.refundPayment(req.app.locals.pool, req.merchant, req.body?.transaction_id, req.body?.reason);
    if (out.error) return res.status(out.http || 400).json({ error: out.error });
    await audit.append(req.app.locals.pool, { actor: 'merchant', action: 'merchant_refund', resourceRef: out.refund.transaction_id, ip: req.ip });
    res.json(out);
}));

module.exports = router;
