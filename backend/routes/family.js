/**
 * Family / delegate routes (deferred from MVP acceptance; API only, no UI).
 *
 * A delegate is a first-class data principal: their own user, consent, min-KYC,
 * encrypted fingerprint template and PIN. The owner must confirm with their own PIN,
 * and the delegate's cumulative cap is enforced atomically in the debit path
 * (services/payments.js).
 */
const express = require('express');
const router = express.Router();

const { requireWalletOwnership } = require('../middleware/auth');
const { validatePin, dollarsToCents } = require('../middleware/validate');
const biometric = require('../services/biometric');
const consent = require('../services/consent');
const pin = require('../services/pin');
const audit = require('../services/audit');

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// POST /api/family/add-delegate
// Body: { parent_wallet_id, owner_pin, delegate_name, delegate_fingerprint_embedding,
//         delegate_pin, spending_cap (dollars), per_delegate_expiry?, language? }
router.post('/add-delegate', requireWalletOwnership('parent_wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    const {
        delegate_name, delegate_fingerprint_embedding, delegate_pin, spending_cap,
        per_delegate_expiry, language = 'en',
    } = req.body || {};

    if (req.isDelegateCaller) return res.status(403).json({ error: 'Only the wallet owner can add family members' });
    if (!delegate_name || !biometric.isEmbedding(delegate_fingerprint_embedding)) {
        return res.status(400).json({ error: 'delegate_name and delegate_fingerprint_embedding required' });
    }
    const pinCheck = validatePin(delegate_pin);
    if (!pinCheck.ok) return res.status(400).json({ error: `delegate_pin: ${pinCheck.error}` });
    const capCents = dollarsToCents(spending_cap);
    if (!capCents) return res.status(400).json({ error: 'spending_cap (dollars, e.g. 20 or 12.50) required' });
    const expiry = per_delegate_expiry ? new Date(per_delegate_expiry) : null;
    if (expiry && !(expiry > new Date())) {
        return res.status(400).json({ error: 'per_delegate_expiry must be a future date (ISO 8601)' });
    }

    const ownerPin = await pin.checkPin(pool, req.user.id, req.body.owner_pin);
    if (!ownerPin.ok) return pin.pinFailure(res, ownerPin);

    const others = await pool.query(
        `SELECT * FROM biometric_templates WHERE active = true AND template_type = 'fingerprint'`
    );
    if (biometric.collides(delegate_fingerprint_embedding, others.rows)) {
        return res.status(409).json({ error: 'This finger is already registered to a PulsePay customer' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const du = await client.query(
            `INSERT INTO users (pin_hash, id_method) VALUES ($1, 'fingerprint') RETURNING id`,
            [await pin.hashPin(delegate_pin)]
        );
        const delegateUserId = du.rows[0].id;

        await client.query(
            `INSERT INTO kyc_profiles (user_id, kyc_tier, verified_via, screened_at) VALUES ($1,'min','delegate',NOW())`,
            [delegateUserId]
        );
        await consent.record(client, { subjectId: delegateUserId, purpose: 'delegate', granted: true, channel: 'app', language });
        await consent.record(client, { subjectId: delegateUserId, purpose: 'wallet_auth', granted: true, channel: 'app', language });

        const t = biometric.protect(delegate_fingerprint_embedding);
        await client.query(
            `INSERT INTO biometric_templates
               (subject_id, template_type, purpose, protected_vector, enc_iv, enc_tag, transform_salt, kms_key_ref, model_version)
             VALUES ($1,'fingerprint','auth',$2,$3,$4,$5,$6,'local-cv:v1')`,
            [delegateUserId, t.protected_vector, t.enc_iv, t.enc_tag, t.transform_salt, t.kms_key_ref]
        );

        const d = await client.query(
            `INSERT INTO delegated_wallets (parent_wallet_id, delegate_subject_id, spending_cap, per_delegate_expiry)
             VALUES ($1,$2,$3,$4) RETURNING id, spending_cap, created_at`,
            [req.wallet.id, delegateUserId, capCents, expiry]
        );
        await audit.append(client, { action: 'delegate_added', subjectUserId: req.wallet.user_id, resourceRef: d.rows[0].id, ip: req.ip });
        await client.query('COMMIT');

        res.json({
            success: true,
            delegate: {
                id: d.rows[0].id, name: delegate_name,
                spending_cap: Number(d.rows[0].spending_cap), created_at: d.rows[0].created_at,
            },
            message: 'Family member enrolled with their own consent, KYC and biometric template',
        });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}));

// GET /api/family/delegates/:parent_wallet_id
router.get('/delegates/:parent_wallet_id', requireWalletOwnership('parent_wallet_id'), h(async (req, res) => {
    const pool = req.app.locals.pool;
    const r = await pool.query(
        `SELECT id, spending_cap, spent_total, per_delegate_expiry, active, created_at
           FROM delegated_wallets WHERE parent_wallet_id = $1 AND active = true ORDER BY created_at DESC`,
        [req.wallet.id]
    );
    res.json({
        delegates: r.rows.map((d) => ({
            id: d.id, spending_cap: Number(d.spending_cap), spent_total: Number(d.spent_total),
            per_delegate_expiry: d.per_delegate_expiry, active: d.active, created_at: d.created_at,
        })),
    });
}));

module.exports = router;
