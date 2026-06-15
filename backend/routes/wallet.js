/**
 * Wallet lifecycle routes (ARCHITECTURE §6.4, §4.10).
 *
 * Fixes vs the Amazon build:
 *  - Every route enforces ownership (the old routes took wallet_id from the body
 *    with no check -> any JWT could read/refund/extend/hijack any wallet).
 *  - /extend is CAPPED (bounded by max_lifetime, extends from now) instead of
 *    unbounded extend-from-prior-expiry that made the wallet permanent.
 *  - /refund moves money over rails and writes a ledger refund entry.
 *  - rotate-salt -> /reissue-biometric requires live re-verification (matching
 *    biometric + pin), never an attacker-supplied new hash (a one-call takeover).
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

const { requireWalletOwnership } = require('../middleware/auth');
const { validateUUID } = require('../middleware/validate');
const biometric = require('../services/biometric');
const rails = require('../services/rails');
const audit = require('../services/audit');

const EXTEND_HOURS = 72;

// GET /api/wallet/:wallet_id
router.get('/:wallet_id', requireWalletOwnership('wallet_id'), async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const wallet = req.wallet;
        const txs = await pool.query(
            `SELECT id, merchant_upi, amount, auth_tier, distress_triggered, status, created_at
               FROM transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [wallet.id]
        );
        res.json({
            wallet: {
                id: wallet.id, balance: Number(wallet.balance), expiry: wallet.expiry,
                max_lifetime: wallet.max_lifetime, extend_count: wallet.extend_count,
                active: wallet.active, created_at: wallet.created_at,
            },
            transactions: txs.rows,
        });
    } catch (e) {
        console.error('wallet get error:', e);
        res.status(500).json({ error: 'Failed to fetch wallet' });
    }
});

// POST /api/wallet/refund  { wallet_id }
router.post('/refund', requireWalletOwnership('wallet_id'), async (req, res) => {
    const pool = req.app.locals.pool;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const wr = await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [req.wallet.id]);
        const wallet = wr.rows[0];
        if (!wallet || !wallet.active) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Wallet not found or already inactive' });
        }
        const balance = Number(wallet.balance);

        const refundRes = balance > 0
            ? await rails.refund({ amountPaise: balance, walletId: wallet.id, cbsAccountRef: wallet.cbs_account_ref })
            : { ok: true, utr: null };
        if (!refundRes.ok) { await client.query('ROLLBACK'); return res.status(502).json({ error: 'Refund failed on rails' }); }

        await client.query('UPDATE wallets SET active = false, balance = 0 WHERE id = $1', [wallet.id]);
        if (balance > 0) {
            const le = await client.query(
                `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, idempotency_key, upi_utr, status)
                 VALUES ($1,'refund',$2,0,$3,$4,'settled') RETURNING id`,
                [wallet.id, balance, `refund:${wallet.id}`, refundRes.utr]
            );
            await client.query(
                `INSERT INTO transactions (wallet_id, ledger_entry_id, merchant_upi, amount, auth_tier, status)
                 VALUES ($1,$2,'REFUND',$3,'system','refunded')`,
                [wallet.id, le.rows[0].id, balance]
            );
        }
        await audit.append(client, { action: 'wallet_refunded', subjectUserId: wallet.user_id, resourceRef: wallet.id, ip: req.ip });
        await client.query('COMMIT');
        res.json({ success: true, refunded_amount: balance, message: 'Wallet closed and balance refunded to source account' });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('refund error:', e);
        res.status(500).json({ error: 'Refund failed' });
    } finally { client.release(); }
});

// POST /api/wallet/extend  { wallet_id }  — capped by max_lifetime, extends from now.
router.post('/extend', requireWalletOwnership('wallet_id'), async (req, res) => {
    const pool = req.app.locals.pool;
    try {
        const wallet = req.wallet;
        if (!wallet.active) return res.status(404).json({ error: 'Wallet inactive' });

        const proposed = new Date(Date.now() + EXTEND_HOURS * 3600 * 1000);
        const maxLifetime = new Date(wallet.max_lifetime);
        if (proposed > maxLifetime) {
            return res.status(400).json({
                error: 'Cannot extend beyond the wallet maximum lifetime',
                max_lifetime: wallet.max_lifetime,
            });
        }
        const r = await pool.query(
            `UPDATE wallets SET expiry = $1, extend_count = extend_count + 1
               WHERE id = $2 AND active = true RETURNING expiry, extend_count`,
            [proposed, wallet.id]
        );
        await audit.append(pool, { action: 'wallet_extended', subjectUserId: wallet.user_id, resourceRef: wallet.id, ip: req.ip });
        res.json({ success: true, new_expiry: r.rows[0].expiry, extend_count: r.rows[0].extend_count });
    } catch (e) {
        console.error('extend error:', e);
        res.status(500).json({ error: 'Extension failed' });
    }
});

// POST /api/wallet/reissue-biometric  { wallet_id, template_type?, embedding, pin }
// Cancelable re-issuance of the primary finger (default) or face. Requires live
// re-verification + ownership; never accepts an arbitrary hash.
router.post('/reissue-biometric', requireWalletOwnership('wallet_id'), async (req, res) => {
    const pool = req.app.locals.pool;
    const { template_type = 'fingerprint', embedding, pin } = req.body;
    if (!['fingerprint', 'face'].includes(template_type)) {
        return res.status(400).json({ error: "template_type must be 'fingerprint' or 'face'" });
    }
    if (!Array.isArray(embedding) || !pin) {
        return res.status(400).json({ error: 'embedding and pin required for re-issuance' });
    }
    const client = await pool.connect();
    try {
        const subjectId = req.wallet.user_id;
        // Re-verify: PIN + that the new sample still matches the existing active template.
        const userRow = await client.query('SELECT pin_hash FROM users WHERE id = $1', [subjectId]);
        const pinOk = userRow.rows[0]?.pin_hash && await bcrypt.compare(String(pin), userRow.rows[0].pin_hash);
        if (!pinOk) return res.status(401).json({ error: 'Re-verification failed' });

        const cur = await client.query(
            `SELECT * FROM biometric_templates
              WHERE subject_id = $1 AND active = true AND template_type = $2 AND purpose = 'auth'`,
            [subjectId, template_type]
        );
        const stillYou = cur.rows.some(row => biometric.scoreAgainst(embedding, row) >= biometric.MATCH_THRESHOLD);
        if (!stillYou) return res.status(401).json({ error: 'Biometric re-verification failed' });

        await client.query('BEGIN');
        await client.query(
            `UPDATE biometric_templates SET active = false, deactivated_at = NOW()
               WHERE subject_id = $1 AND active = true AND template_type = $2 AND purpose = 'auth'`,
            [subjectId, template_type]
        );
        const t = biometric.protect(embedding); // new transform_salt => old template revoked
        await client.query(
            `INSERT INTO biometric_templates
               (subject_id, template_type, purpose, protected_vector, enc_iv, enc_tag, transform_salt, kms_key_ref, model_version)
             VALUES ($1,$2,'auth',$3,$4,$5,$6,$7,'cv-india:v1')`,
            [subjectId, template_type, t.protected_vector, t.enc_iv, t.enc_tag, t.transform_salt, t.kms_key_ref]
        );
        await audit.append(client, { action: 'biometric_reissued', subjectUserId: subjectId, resourceRef: req.wallet.id, ip: req.ip });
        await client.query('COMMIT');
        res.json({ success: true, template_type, message: 'Biometric template re-issued; previous template revoked' });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('reissue error:', e);
        res.status(500).json({ error: 'Re-issuance failed' });
    } finally { client.release(); }
});

module.exports = router;
