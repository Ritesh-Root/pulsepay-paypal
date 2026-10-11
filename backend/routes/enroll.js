/**
 * Enrolment on the customer's own phone.
 *
 *   1. POST /request-otp    phone -> one-time code by SMS
 *   2. POST /verify-otp     -> 15-minute enrolment token (+ whether this phone is a customer)
 *   3. POST /topup-order    -> PayPal order for the first top-up (approved with the JS SDK)
 *   4a. new customer:       POST /create-wallet with their chosen ID method
 *                           (fingerprint | face | both), the scans, a PIN and the approved order
 *   4b. existing customer:  POST /sign-in (PIN) to reopen their active wallet, or
 *                           POST /create-wallet (PIN + approved order) to open a new one.
 *
 * The PayPal order is captured only after every other check has passed, and the
 * capture is refunded if the wallet cannot be written.
 *
 * An existing customer's PIN and biometrics are never replaced here: OTP access to
 * a phone number (e.g. a SIM swap) is not enough to take over an identity.
 */
const express = require('express');
const router = express.Router();

const { AUD, sign, verify, generateToken, bearer } = require('../middleware/auth');
const { validatePhone, validatePin, dollarsToCents } = require('../middleware/validate');
const otp = require('../services/otp');
const biometric = require('../services/biometric');
const consent = require('../services/consent');
const funding = require('../services/funding');
const pin = require('../services/pin');
const audit = require('../services/audit');

const ENROL_TOKEN_TTL = '15m';
const WALLET_TTL_HOURS = 72;
const WALLET_MAX_LIFETIME_DAYS = 7;   // hard cap; /extend can never exceed this
const ID_METHODS = ['fingerprint', 'face', 'both'];

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function enrolmentClaims(req) {
    try { return verify(String(bearer(req) || ''), AUD.enrolment); } catch { return null; }
}

async function activeWallet(db, userId) {
    const r = await db.query(
        `SELECT id, balance, expiry FROM wallets
          WHERE user_id = $1 AND active = true AND expiry > NOW()
          ORDER BY created_at DESC LIMIT 1`, [userId]
    );
    return r.rows[0] || null;
}

const FUNDING_ERRORS = {
    order_unavailable: [409, 'That PayPal payment was already used or does not belong to this sign-up. Start the top-up again.'],
    payment_declined: [402, 'PayPal declined that funding source. Try again with another one.'],
    capture_failed: [502, 'PayPal could not complete the payment. You have not been charged.'],
    capture_unconfirmed: [502, 'PayPal did not confirm the payment. Try again: you will only be charged once.'],
    capture_mismatch: [502, 'PayPal returned an unexpected amount. The payment was refunded.'],
};

// POST /api/enroll/request-otp  { phone }
router.post('/request-otp', h(async (req, res) => {
    const { phone } = req.body || {};
    if (!validatePhone(phone)) return res.status(400).json({ error: 'Enter your mobile number with country code, digits only (e.g. 14155550123)' });
    const result = await otp.issue({
        purpose: 'enrol', phone,
        message: (code) => `Your PulsePay verification code is ${code}. Valid 5 minutes. Do not share it.`,
    });
    if (!result.ok) return res.status(429).json({ error: 'Too many codes requested. Try again in 10 minutes.' });
    res.json({ success: true, otp_sent: true, ...(result.demo_otp ? { demo_otp: result.demo_otp } : {}) });
}));

// POST /api/enroll/verify-otp  { phone, otp }
router.post('/verify-otp', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const { phone, otp: code } = req.body || {};
    if (!validatePhone(phone) || !code) return res.status(400).json({ error: 'phone and otp required' });

    const result = otp.verify({ purpose: 'enrol', phone, otp: String(code) });
    if (!result.ok) {
        const msg = result.reason === 'otp_expired' ? 'Code expired. Request a new one.'
            : result.reason === 'otp_attempts_exceeded' ? 'Too many wrong codes. Request a new one.'
            : 'Incorrect code';
        return res.status(400).json({ verified: false, error: msg });
    }

    const existing = (await pool.query('SELECT id FROM users WHERE phone = $1', [phone])).rows[0];
    const enrolment_token = sign(AUD.enrolment, { phone, kyc_tier: 'min' }, ENROL_TOKEN_TTL);
    res.json({
        verified: true,
        enrolment_token,
        existing_customer: !!existing,
        has_active_wallet: existing ? !!(await activeWallet(pool, existing.id)) : false,
    });
}));

// POST /api/enroll/sign-in  (Bearer enrolment token)  { pin }
router.post('/sign-in', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const enrol = enrolmentClaims(req);
    if (!enrol) return res.status(401).json({ error: 'Verify your phone number first' });

    const user = (await pool.query('SELECT id FROM users WHERE phone = $1', [enrol.phone])).rows[0];
    if (!user) return res.status(404).json({ error: 'No PulsePay account for this number' });

    const pinResult = await pin.checkPin(pool, user.id, req.body?.pin);
    if (!pinResult.ok) {
        await audit.append(pool, { action: 'sign_in_pin_fail', subjectUserId: user.id, ip: req.ip });
        return pin.pinFailure(res, pinResult);
    }
    const wallet = await activeWallet(pool, user.id);
    if (!wallet) return res.status(404).json({ error: 'no_active_wallet', message: 'No active wallet. Open a new one.' });

    await audit.append(pool, { action: 'customer_sign_in', subjectUserId: user.id, resourceRef: wallet.id, ip: req.ip });
    res.json({ token: generateToken('customer', user.id), wallet_id: wallet.id, balance: Number(wallet.balance), expiry: wallet.expiry });
}));

// POST /api/enroll/topup-order  (Bearer enrolment token)  { amount (dollars) }
router.post('/topup-order', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const enrol = enrolmentClaims(req);
    if (!enrol) return res.status(401).json({ error: 'Verify your phone number first' });
    const amountCents = dollarsToCents(req.body?.amount);
    const problem = funding.checkAmount(amountCents, 0);
    if (problem) return res.status(400).json({ error: problem });
    try {
        res.json(await funding.createOrder(pool, {
            purpose: 'enrol', phone: enrol.phone, amountCents, appUrl: req.get('origin') || undefined,
        }));
    } catch (e) {
        console.error('topup-order failed:', e.message, e.debugId || '');
        res.status(502).json({ error: 'Could not start the PayPal payment. Try again.' });
    }
}));

// POST /api/enroll/create-wallet  (Bearer enrolment token)
// New customer:      { id_method, fingerprint_embedding?, distress_fingerprint_embedding?,
//                      face_embedding?, liveness_passed?, wallet_pin, emergency_contact?,
//                      paypal_order_id, language? }
// Existing customer: { wallet_pin (their current PIN), paypal_order_id }
router.post('/create-wallet', h(async (req, res) => {
    const pool = req.app.locals.pool;
    const enrol = enrolmentClaims(req);
    if (!enrol) return res.status(401).json({ error: 'Verify your phone number first' });

    const body = req.body || {};
    const { language = 'en' } = body;
    if (!body.paypal_order_id) return res.status(400).json({ error: 'Top up with PayPal first' });

    const existingUser = (await pool.query('SELECT id FROM users WHERE phone = $1', [enrol.phone])).rows[0];

    // --- every check that can fail without moving money -----------------------
    let plan = null;
    if (existingUser) {
        const pinResult = await pin.checkPin(pool, existingUser.id, body.wallet_pin);
        if (!pinResult.ok) {
            await audit.append(pool, { action: 'reenrol_pin_fail', subjectUserId: existingUser.id, ip: req.ip });
            return pin.pinFailure(res, pinResult);
        }
        if (await activeWallet(pool, existingUser.id)) {
            return res.status(409).json({ error: 'You already have an active wallet. Sign in instead.' });
        }
    } else {
        const idMethod = body.id_method;
        if (!ID_METHODS.includes(idMethod)) {
            return res.status(400).json({ error: "id_method must be 'fingerprint', 'face' or 'both'" });
        }
        const wantsFinger = idMethod !== 'face';
        const wantsFace = idMethod !== 'fingerprint';
        const fp = body.fingerprint_embedding;
        const distress = body.distress_fingerprint_embedding;
        const face = body.face_embedding;

        if (wantsFinger && !biometric.isEmbedding(fp)) return res.status(400).json({ error: 'Scan your payment finger' });
        if (wantsFace) {
            if (!biometric.isEmbedding(face)) return res.status(400).json({ error: 'Scan your face' });
            if (body.liveness_passed !== true) return res.status(400).json({ error: 'Face liveness check did not pass' });
        }
        if (distress !== undefined && distress !== null) {
            if (!wantsFinger) return res.status(400).json({ error: 'A distress finger needs fingerprint ID' });
            if (!biometric.isEmbedding(distress)) return res.status(400).json({ error: 'Invalid distress finger scan' });
            if (biometric.similarity(fp, distress) >= biometric.MATCH_THRESHOLD - biometric.MATCH_MARGIN) {
                return res.status(400).json({ error: 'Distress finger is too similar to your payment finger. Use a different finger.' });
            }
        }
        const pinCheck = validatePin(body.wallet_pin);
        if (!pinCheck.ok) return res.status(400).json({ error: pinCheck.error });
        if (body.emergency_contact && !validatePhone(String(body.emergency_contact))) {
            return res.status(400).json({ error: 'Emergency contact must be a phone number with country code' });
        }
        const scans = [
            ...(wantsFinger ? [['fingerprint', fp]] : []),
            ...(wantsFinger && distress ? [['fingerprint', distress]] : []),
            ...(wantsFace ? [['face', face]] : []),
        ];
        for (const [type, emb] of scans) {
            const others = await pool.query('SELECT * FROM biometric_templates WHERE active = true AND template_type = $1', [type]);
            if (biometric.collides(emb, others.rows)) {
                return res.status(409).json({ error: `This ${type === 'face' ? 'face' : 'finger'} is already registered to another PulsePay customer.` });
            }
        }
        plan = { idMethod, wantsFinger, wantsFace, fp, distress, face, pinHash: await pin.hashPin(body.wallet_pin) };
    }

    // --- capture the PayPal payment ------------------------------------------
    let captured;
    try {
        captured = await funding.claimAndCapture(pool, body.paypal_order_id, { purpose: 'enrol', phone: enrol.phone });
    } catch (e) {
        const [code, msg] = FUNDING_ERRORS[e.code] || [502, 'PayPal payment failed'];
        console.error('enrol capture failed:', e.code, e.cause?.message || '');
        return res.status(code).json({ error: msg });
    }
    const { order, capture } = captured;

    // --- write -----------------------------------------------------------------
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        let userId;
        if (existingUser) {
            userId = existingUser.id;
        } else {
            const u = await client.query(
                'INSERT INTO users (phone, emergency_contact, pin_hash, id_method) VALUES ($1,$2,$3,$4) RETURNING id',
                [enrol.phone, body.emergency_contact || null, plan.pinHash, plan.idMethod]
            );
            userId = u.rows[0].id;
            await client.query(
                `INSERT INTO kyc_profiles (user_id, kyc_tier, verified_via, screened_at) VALUES ($1, $2, 'phone_otp', NOW())`,
                [userId, enrol.kyc_tier || 'min']
            );
            await consent.recordEnrolmentConsent(client, { subjectId: userId, channel: 'app', language, distress: !!plan.distress });

            const store = async (type, purpose, embedding) => {
                const t = biometric.protect(embedding);
                await client.query(
                    `INSERT INTO biometric_templates
                       (subject_id, template_type, purpose, protected_vector, enc_iv, enc_tag, transform_salt, kms_key_ref, model_version)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'local-cv:v1')`,
                    [userId, type, purpose, t.protected_vector, t.enc_iv, t.enc_tag, t.transform_salt, t.kms_key_ref]
                );
            };
            if (plan.wantsFinger) await store('fingerprint', 'auth', plan.fp);
            if (plan.wantsFinger && plan.distress) await store('fingerprint', 'distress', plan.distress);
            if (plan.wantsFace) await store('face', 'auth', plan.face);
        }

        const now = Date.now();
        const w = await client.query(
            `INSERT INTO wallets (user_id, currency, balance, expiry, max_lifetime)
             VALUES ($1,$2,$3,$4,$5) RETURNING id, balance, expiry`,
            [
                userId, funding.CURRENCY, capture.amountCents,
                new Date(now + WALLET_TTL_HOURS * 3600 * 1000),
                new Date(now + WALLET_MAX_LIFETIME_DAYS * 24 * 3600 * 1000),
            ]
        );
        const wallet = w.rows[0];
        await funding.creditWallet(client, { walletId: wallet.id, order, capture, newBalance: capture.amountCents });

        await audit.append(client, {
            actor: 'enrolment', action: existingUser ? 'wallet_reopened' : 'wallet_created',
            subjectUserId: userId, resourceRef: wallet.id, ip: req.ip,
        });
        await client.query('COMMIT');

        res.json({
            wallet_id: wallet.id,
            balance: Number(wallet.balance),
            currency: funding.CURRENCY,
            expiry: wallet.expiry,
            funded_by: order.simulated ? 'simulated' : 'paypal',
            token: generateToken('customer', userId),
            message: 'Wallet ready: low-limit, 72h expiry',
        });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        await pool.query(`UPDATE paypal_orders SET status = 'failed' WHERE order_id = $1`, [order.order_id]).catch(() => {});
        await funding.compensate(order, capture);
        if (error.code === '23505') return res.status(409).json({ error: 'This phone number is already being enrolled. Your PayPal payment was refunded.' });
        throw error;
    } finally {
        client.release();
    }
}));

module.exports = router;
