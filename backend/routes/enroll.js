const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// POST /api/enroll/verify-aadhaar
router.post('/verify-aadhaar', async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone || phone.length < 10) {
            return res.status(400).json({ error: 'Invalid phone number' });
        }

        // Mock UIDAI verification - always succeeds
        res.json({
            success: true,
            otp_sent: true,
            message: 'OTP sent successfully (mock)'
        });
    } catch (error) {
        console.error('Error in verify-aadhaar:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/enroll/verify-otp
router.post('/verify-otp', async (req, res) => {
    try {
        const { phone, otp } = req.body;

        if (!phone || !otp) {
            return res.status(400).json({ error: 'Phone and OTP required' });
        }

        // Always verify any 6-digit OTP
        if (otp.length === 6 && /^\d+$/.test(otp)) {
            res.json({
                verified: true,
                message: 'Aadhaar verification successful (mock)'
            });
        } else {
            res.status(400).json({
                verified: false,
                error: 'Invalid OTP format'
            });
        }
    } catch (error) {
        console.error('Error in verify-otp:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// POST /api/enroll/create-wallet
router.post('/create-wallet', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const {
            wallet_id_hash,
            fingerprint_hash,
            distress_hash,
            salt,
            amount,
            phone
        } = req.body;

        if (!wallet_id_hash || !fingerprint_hash || !distress_hash || !salt || !amount || !phone) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Convert amount from rupees to paise
        const amountInPaise = parseInt(amount) * 100;

        // Set expiry to 72 hours from now
        const expiry = new Date();
        expiry.setHours(expiry.getHours() + 72);

        // Check if user exists, if not create
        let userResult = await pool.query(
            'SELECT id FROM users WHERE phone = $1',
            [phone]
        );

        let userId;
        if (userResult.rows.length === 0) {
            // Create new user
            const newUserResult = await pool.query(
                'INSERT INTO users (phone, aadhaar_verified) VALUES ($1, $2) RETURNING id',
                [phone, true]
            );
            userId = newUserResult.rows[0].id;
        } else {
            userId = userResult.rows[0].id;
        }

        // Create wallet
        const walletResult = await pool.query(
            `INSERT INTO wallets (user_id, wallet_id_hash, fingerprint_hash, distress_hash, salt, balance, expiry, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, balance, expiry`,
            [userId, wallet_id_hash, fingerprint_hash, distress_hash, salt, amountInPaise, expiry, true]
        );

        const wallet = walletResult.rows[0];

        res.json({
            wallet_id: wallet.id,
            balance: wallet.balance,
            expiry: wallet.expiry,
            message: 'Wallet created successfully'
        });
    } catch (error) {
        console.error('Error in create-wallet:', error);
        res.status(500).json({ error: 'Failed to create wallet' });
    }
});

module.exports = router;
