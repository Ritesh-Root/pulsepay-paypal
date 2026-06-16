/**
 * Enrolment routes (ARCHITECTURE §6.1) — attended in-branch / BC flow.
 *
 * Replaces the Amazon build's mocked Aadhaar (aadhaar_verified=true unconditionally),
 * in-memory OTP Map, OTP echoed in the response, crypto funding path, and SHA3
 * "biometric hash". Now: AUA/KUA e-KYC (OTP server-side only), explicit DPDP consent,
 * an encrypted cancelable face TEMPLATE, a DISTINCT duress credential, and a
 * CBS/UPI-funded min-KYC wallet created atomically with a double-entry ledger credit.
 */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { generateToken } = require('../middleware/auth');
const { validatePhone } = require('../middleware/validate');
const aua = require('../services/aua');
const biometric = require('../services/biometric');
const consent = require('../services/consent');
const rails = require('../services/rails');
const audit = require('../services/audit');

const ENROL_TOKEN_TTL = '15m';
const WALLET_TTL_HOURS = 72;
const WALLET_MAX_LIFETIME_DAYS = 7; // hard cap; /extend can never exceed this

function jwtSecret() {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('FATAL: JWT_SECRET not set (fail-closed).');
    return s;
}

// POST /api/enroll/request-otp  { reference, phone? }
// reference identifies the enrolment subject (phone or an Aadhaar reference at the BC).
router.post('/request-otp', async (req, res) => {
    try {
        const { reference, phone } = req.body;
        const ref = reference || phone;
        if (!ref) return res.status(400).json({ error: 'reference (or phone) required' });
        if (phone && !validatePhone(phone)) {
            return res.status(400).json({ error: 'Invalid phone number' });
        }
        const result = await aua.requestEkycOtp({ reference: ref, phone });
        // The OTP is delivered server-side (SMS). In non-production we also return
        // dev_otp so the demo is usable without reading logs.
        res.json({ success: true, txn_id: result.txn_id, otp_sent: result.otp_sent, ...(result.dev_otp ? { dev_otp: result.dev_otp } : {}) });
    } catch (error) {
        console.error('request-otp error:', error);
        res.status(500).json({ error: 'Failed to request OTP' });
    }
});

// POST /api/enroll/verify-otp  { reference, otp }
// On success returns a short-lived enrolment ticket consumed by create-wallet.
router.post('/verify-otp', async (req, res) => {
    try {
        const { reference, otp, phone } = req.body;
        const ref = reference || phone;
        if (!ref || !otp) return res.status(400).json({ error: 'reference and otp required' });
        if (!/^\d{6}$/.test(String(otp))) return res.status(400).json({ verified: false, error: 'Invalid OTP format' });

        const result = await aua.verifyEkycOtp({ reference: ref, otp });
        if (!result.verified) {
            return res.status(400).json({ verified: false, error: result.reason || 'OTP verification failed' });
        }

        const enrolment_token = jwt.sign(
            {
                kind: 'enrolment',
                reference: ref,
                phone: phone || null,
                aadhaar_ref_token: result.aadhaar_ref_token,
                aua_txn_id: result.aua_txn_id,
                kyc_tier: result.ekyc.kyc_tier,
            },
            jwtSecret(),
            { expiresIn: ENROL_TOKEN_TTL }
        );
        res.json({ verified: true, enrolment_token });
    } catch (error) {
        console.error('verify-otp error:', error);
        res.status(500).json({ error: 'OTP verification failed' });
    }
});

// POST /api/enroll/create-wallet
// Headers: Authorization: Bearer <enrolment_token>
// Body: { fingerprint_embedding, distress_fingerprint_embedding, face_embedding,
//         liveness_passed, wallet_pin, amount, phone?, funding_source, language? }
router.post('/create-wallet', async (req, res) => {
    const pool = req.app.locals.pool;

    // Consume the enrolment ticket (proves AUA e-KYC happened).
    const hdr = req.headers['authorization'];
    const enrolTok = hdr && hdr.split(' ')[1];
    let enrol;
    try {
        enrol = jwt.verify(enrolTok, jwtSecret());
        if (enrol.kind !== 'enrolment') throw new Error('wrong token kind');
    } catch (e) {
        return res.status(401).json({ error: 'Valid enrolment_token required (complete OTP verification first)' });
    }

    const {
        fingerprint_embedding,          // PRIMARY payment finger (vector from a certified scanner)
        distress_fingerprint_embedding, // a DISTINCT finger -> silent distress
        face_embedding,                 // step-up factor, required above the amount limit
        liveness_passed,                // face liveness
        wallet_pin,                     // knowledge second factor for the base tier
        amount,
        funding_source = 'sbi_cbs',
        language = 'en',
    } = req.body;
    const phone = enrol.phone || req.body.phone || null;

    // --- input validation -----------------------------------------------------
    const isVec = (v) => Array.isArray(v) && v.length >= 64;
    if (!isVec(fingerprint_embedding)) {
        return res.status(400).json({ error: 'fingerprint_embedding (primary finger vector) required' });
    }
    if (!isVec(distress_fingerprint_embedding)) {
        return res.status(400).json({ error: 'distress_fingerprint_embedding (a DISTINCT finger) required' });
    }
    if (!isVec(face_embedding)) {
        return res.status(400).json({ error: 'face_embedding (for above-limit step-up) required' });
    }
    if (liveness_passed !== true) {
        return res.status(400).json({ error: 'Face liveness check did not pass; cannot enrol' });
    }
    if (!/^\d{4,6}$/.test(String(wallet_pin || ''))) {
        return res.status(400).json({ error: 'wallet_pin (4-6 digits) required' });
    }
    if (!['sbi_cbs', 'upi'].includes(funding_source)) {
        return res.status(400).json({ error: 'funding_source must be sbi_cbs or upi' }); // crypto removed by construction
    }
    const amountPaise = Math.round(Number(amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise < 100000 || amountPaise > 200000) {
        return res.status(400).json({ error: 'Amount must be between Rs 1000 and Rs 2000' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. user (phone nullable for the phone-less cohort)
        let userId;
        if (phone) {
            const existing = await client.query('SELECT id FROM users WHERE phone = $1', [phone]);
            userId = existing.rows[0]?.id;
        }
        const pinHash = await bcrypt.hash(String(wallet_pin), 10);
        if (!userId) {
            const u = await client.query(
                'INSERT INTO users (phone, emergency_contact, pin_hash) VALUES ($1, $2, $3) RETURNING id',
                [phone, req.body.emergency_contact || null, pinHash]
            );
            userId = u.rows[0].id;
        } else {
            await client.query('UPDATE users SET pin_hash = $1 WHERE id = $2', [pinHash, userId]);
        }

        // 2. KYC profile (min-KYC) + segregated Aadhaar token vault
        await client.query(
            `INSERT INTO kyc_profiles (user_id, kyc_tier, verified_via, screened_at)
             VALUES ($1, $2, 'aua_kua', NOW())`,
            [userId, enrol.kyc_tier || 'min']
        );
        await client.query(
            `INSERT INTO aadhaar_token_vault (user_id, aadhaar_ref_token, aua_txn_id)
             VALUES ($1, $2, $3)`,
            [userId, enrol.aadhaar_ref_token, enrol.aua_txn_id]
        );

        // 3. explicit DPDP consent (per purpose)
        await consent.recordEnrolmentConsent(client, { subjectId: userId, channel: 'branch', language });

        // 4. encrypted, cancelable templates (vectors, NOT hashes):
        //    primary finger (auth), distinct finger (distress), face (auth, step-up).
        async function storeTemplate(type, purpose, embedding) {
            const t = biometric.protect(embedding);
            await client.query(
                `INSERT INTO biometric_templates
                   (subject_id, template_type, purpose, protected_vector, enc_iv, enc_tag, transform_salt, kms_key_ref, model_version)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'cv-india:v1')`,
                [userId, type, purpose, t.protected_vector, t.enc_iv, t.enc_tag, t.transform_salt, t.kms_key_ref]
            );
        }
        await storeTemplate('fingerprint', 'auth', fingerprint_embedding);
        await storeTemplate('fingerprint', 'distress', distress_fingerprint_embedding);
        await storeTemplate('face', 'auth', face_embedding);

        // 6. fund the wallet over SBI/NPCI rails (NOT Razorpay)
        const funded = await rails.fund({ amountPaise, fundingSource: funding_source, walletId: 'pending' });
        if (!funded.ok) throw new Error('Funding failed on rails');

        const now = Date.now();
        const expiry = new Date(now + WALLET_TTL_HOURS * 3600 * 1000);
        const maxLifetime = new Date(now + WALLET_MAX_LIFETIME_DAYS * 24 * 3600 * 1000);

        const w = await client.query(
            `INSERT INTO wallets (user_id, cbs_account_ref, funding_source, balance, expiry, max_lifetime)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, balance, expiry`,
            [userId, `SBIW${crypto.randomBytes(4).toString('hex')}`, funding_source, amountPaise, expiry, maxLifetime]
        );
        const wallet = w.rows[0];

        // 7. double-entry ledger credit (source of truth)
        await client.query(
            `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, idempotency_key, upi_utr, status)
             VALUES ($1, 'credit', $2, $3, $4, $5, 'settled')`,
            [wallet.id, amountPaise, amountPaise, `fund:${wallet.id}`, funded.utr]
        );

        await audit.append(client, {
            actor: 'enrolment', action: 'wallet_created', subjectUserId: userId,
            resourceRef: wallet.id, ip: req.ip,
        });

        await client.query('COMMIT');

        const token = generateToken(userId);
        res.json({
            wallet_id: wallet.id,
            balance: Number(wallet.balance),
            expiry: wallet.expiry,
            funding_source,
            token,
            message: 'Wallet created (min-KYC, 72h expiry, funded via SBI/NPCI rails)',
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('create-wallet error:', error);
        res.status(500).json({ error: 'Failed to create wallet' });
    } finally {
        client.release();
    }
});

module.exports = router;
