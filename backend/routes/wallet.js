const express = require('express');
const router = express.Router();
const crypto = require('crypto');

// GET /api/wallet/:wallet_id
router.get('/:wallet_id', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const { wallet_id } = req.params;

        const walletResult = await pool.query(
            'SELECT id, balance, expiry, active, created_at FROM wallets WHERE id = $1',
            [wallet_id]
        );

        if (walletResult.rows.length === 0) {
            return res.status(404).json({ error: 'Wallet not found' });
        }

        const wallet = walletResult.rows[0];

        // Get transaction history
        const transactionsResult = await pool.query(
            'SELECT id, merchant_upi, amount, auth_tier, status, created_at FROM transactions WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT 20',
            [wallet_id]
        );

        res.json({
            wallet: {
                id: wallet.id,
                balance: wallet.balance,
                expiry: wallet.expiry,
                active: wallet.active,
                created_at: wallet.created_at
            },
            transactions: transactionsResult.rows
        });
    } catch (error) {
        console.error('Error fetching wallet:', error);
        res.status(500).json({ error: 'Failed to fetch wallet' });
    }
});

// POST /api/wallet/refund
router.post('/refund', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const { wallet_id } = req.body;

        if (!wallet_id) {
            return res.status(400).json({ error: 'Wallet ID required' });
        }

        const walletResult = await pool.query(
            'SELECT balance FROM wallets WHERE id = $1 AND active = true',
            [wallet_id]
        );

        if (walletResult.rows.length === 0) {
            return res.status(404).json({ error: 'Wallet not found or already inactive' });
        }

        const balance = walletResult.rows[0].balance;

        // Deactivate wallet
        await pool.query(
            'UPDATE wallets SET active = false, balance = 0 WHERE id = $1',
            [wallet_id]
        );

        res.json({
            success: true,
            refunded_amount: balance,
            message: 'Wallet deactivated and balance refunded (mock)'
        });
    } catch (error) {
        console.error('Error refunding wallet:', error);
        res.status(500).json({ error: 'Refund failed' });
    }
});

// POST /api/wallet/extend
router.post('/extend', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const { wallet_id } = req.body;

        if (!wallet_id) {
            return res.status(400).json({ error: 'Wallet ID required' });
        }

        // Extend expiry by 72 hours
        const newExpiry = new Date();
        newExpiry.setHours(newExpiry.getHours() + 72);

        const result = await pool.query(
            'UPDATE wallets SET expiry = $1 WHERE id = $2 AND active = true RETURNING expiry',
            [newExpiry, wallet_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Wallet not found or inactive' });
        }

        res.json({
            success: true,
            new_expiry: result.rows[0].expiry,
            message: 'Wallet expiry extended by 72 hours'
        });
    } catch (error) {
        console.error('Error extending wallet:', error);
        res.status(500).json({ error: 'Extension failed' });
    }
});

// POST /api/wallet/rotate-salt
router.post('/rotate-salt', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const { wallet_id, new_face_hash } = req.body;

        if (!wallet_id || !new_face_hash) {
            return res.status(400).json({ error: 'Wallet ID and new face hash required' });
        }

        // Generate new salt
        const newSalt = crypto.randomBytes(32).toString('hex');

        // Update wallet with new salt and wallet_id_hash
        const result = await pool.query(
            'UPDATE wallets SET salt = $1, wallet_id_hash = $2 WHERE id = $3 AND active = true RETURNING id',
            [newSalt, new_face_hash, wallet_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Wallet not found or inactive' });
        }

        res.json({
            success: true,
            message: 'Biometric key rotated successfully',
            new_salt: newSalt
        });
    } catch (error) {
        console.error('Error rotating salt:', error);
        res.status(500).json({ error: 'Salt rotation failed' });
    }
});

module.exports = router;
