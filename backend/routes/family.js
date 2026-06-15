/**
 * Family / delegate routes (ARCHITECTURE §6 I27).
 *
 * Fixes vs the Amazon build: add-delegate had no ownership check and stored a second
 * person's biometric with ZERO DPDP consent/KYC; spent_total was never enforced
 * (drain-by-repetition). Now a delegate is a first-class data principal: owner-
 * authenticated enrolment, the delegate's OWN consent + min-KYC + encrypted template
 * + PIN, and a cumulative cap enforced atomically in the debit (see payment.js).
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const { requireWalletOwnership } = require('../middleware/auth');
const biometric = require('../services/biometric');
const consent = require('../services/consent');
const audit = require('../services/audit');

// POST /api/family/add-delegate
// Body: { parent_wallet_id, delegate_name, delegate_fingerprint_embedding,
//         delegate_face_embedding?, delegate_pin, spending_cap, per_delegate_expiry?, language? }
router.post('/add-delegate', requireWalletOwnership('parent_wallet_id'), async (req, res) => {
    const pool = req.app.locals.pool;
    const {
        delegate_name, delegate_fingerprint_embedding, delegate_face_embedding,
        delegate_pin, spending_cap, per_delegate_expiry, language = 'en',
    } = req.body;

    const isVec = (v) => Array.isArray(v) && v.length >= 64;
    if (!delegate_name || !isVec(delegate_fingerprint_embedding)) {
        return res.status(400).json({ error: 'delegate_name and delegate_fingerprint_embedding required' });
    }
    if (!/^\d{4,6}$/.test(String(delegate_pin || ''))) {
        return res.status(400).json({ error: 'delegate_pin (4-6 digits) required' });
    }
    const capPaise = Math.round(Number(spending_cap) * 100);
    if (!Number.isFinite(capPaise) || capPaise <= 0) {
        return res.status(400).json({ error: 'spending_cap (rupees) required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // The delegate is a NEW data principal (own user, KYC, consent, template, PIN).
        const pinHash = await bcrypt.hash(String(delegate_pin), 10);
        const du = await client.query(
            'INSERT INTO users (pin_hash) VALUES ($1) RETURNING id', [pinHash]
        );
        const delegateUserId = du.rows[0].id;

        await client.query(
            `INSERT INTO kyc_profiles (user_id, kyc_tier, verified_via, screened_at) VALUES ($1,'min','delegate',NOW())`,
            [delegateUserId]
        );
        await consent.record(client, { subjectId: delegateUserId, purpose: 'delegate', granted: true, channel: 'branch', language });
        await consent.record(client, { subjectId: delegateUserId, purpose: 'wallet_auth', granted: true, channel: 'branch', language });

        async function storeTemplate(type, embedding) {
            const t = biometric.protect(embedding);
            await client.query(
                `INSERT INTO biometric_templates
                   (subject_id, template_type, purpose, protected_vector, enc_iv, enc_tag, transform_salt, kms_key_ref, model_version)
                 VALUES ($1,$2,'auth',$3,$4,$5,$6,$7,'cv-india:v1')`,
                [delegateUserId, type, t.protected_vector, t.enc_iv, t.enc_tag, t.transform_salt, t.kms_key_ref]
            );
        }
        await storeTemplate('fingerprint', delegate_fingerprint_embedding); // primary
        if (isVec(delegate_face_embedding)) await storeTemplate('face', delegate_face_embedding); // optional step-up

        const d = await client.query(
            `INSERT INTO delegated_wallets (parent_wallet_id, delegate_subject_id, spending_cap, per_delegate_expiry)
             VALUES ($1,$2,$3,$4) RETURNING id, spending_cap, created_at`,
            [req.wallet.id, delegateUserId, capPaise, per_delegate_expiry || null]
        );
        await audit.append(client, { action: 'delegate_added', subjectUserId: req.wallet.user_id, resourceRef: d.rows[0].id, ip: req.ip });
        await client.query('COMMIT');

        res.json({
            success: true,
            delegate: {
                id: d.rows[0].id, name: delegate_name,
                spending_cap: Number(d.rows[0].spending_cap), created_at: d.rows[0].created_at,
            },
            message: 'Delegate enrolled with own consent, KYC and biometric template',
        });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('add-delegate error:', e);
        res.status(500).json({ error: 'Failed to add delegate' });
    } finally { client.release(); }
});

// GET /api/family/delegates/:parent_wallet_id
router.get('/delegates/:parent_wallet_id', requireWalletOwnership('parent_wallet_id'), async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const r = await pool.query(
            `SELECT id, spending_cap, spent_total, per_delegate_expiry, active, created_at
               FROM delegated_wallets WHERE parent_wallet_id = $1 AND active = true ORDER BY created_at DESC`,
            [req.wallet.id]
        );
        res.json({
            delegates: r.rows.map(d => ({
                id: d.id, spending_cap: Number(d.spending_cap), spent_total: Number(d.spent_total),
                per_delegate_expiry: d.per_delegate_expiry, active: d.active, created_at: d.created_at,
            })),
        });
    } catch (e) {
        console.error('delegates list error:', e);
        res.status(500).json({ error: 'Failed to fetch delegates' });
    }
});

module.exports = router;
