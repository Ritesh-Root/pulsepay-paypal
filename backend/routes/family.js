const express = require('express');
const router = express.Router();

// POST /api/family/add-delegate
router.post('/add-delegate', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const {
            parent_wallet_id,
            delegate_name,
            delegate_face_hash,
            delegate_fingerprint_hash,
            spending_cap
        } = req.body;

        if (!parent_wallet_id || !delegate_name || !delegate_face_hash || !spending_cap) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Verify parent wallet exists
        const walletResult = await pool.query(
            'SELECT id FROM wallets WHERE id = $1 AND active = true',
            [parent_wallet_id]
        );

        if (walletResult.rows.length === 0) {
            return res.status(404).json({ error: 'Parent wallet not found' });
        }

        // Create delegated wallet
        const delegateResult = await pool.query(
            `INSERT INTO delegated_wallets (parent_wallet_id, delegate_name, delegate_face_hash, delegate_fingerprint_hash, spending_cap, active)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, delegate_name, spending_cap, created_at`,
            [parent_wallet_id, delegate_name, delegate_face_hash, delegate_fingerprint_hash || null, spending_cap, true]
        );

        const delegate = delegateResult.rows[0];

        res.json({
            success: true,
            delegate: {
                id: delegate.id,
                name: delegate.delegate_name,
                spending_cap: delegate.spending_cap,
                created_at: delegate.created_at
            },
            message: 'Delegate added successfully'
        });
    } catch (error) {
        console.error('Error adding delegate:', error);
        res.status(500).json({ error: 'Failed to add delegate' });
    }
});

// GET /api/family/delegates/:parent_wallet_id
router.get('/delegates/:parent_wallet_id', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const { parent_wallet_id } = req.params;

        const delegatesResult = await pool.query(
            'SELECT id, delegate_name, spending_cap, active, created_at FROM delegated_wallets WHERE parent_wallet_id = $1 AND active = true ORDER BY created_at DESC',
            [parent_wallet_id]
        );

        res.json({
            delegates: delegatesResult.rows
        });
    } catch (error) {
        console.error('Error fetching delegates:', error);
        res.status(500).json({ error: 'Failed to fetch delegates' });
    }
});

module.exports = router;
