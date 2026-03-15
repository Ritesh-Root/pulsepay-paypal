const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { generateToken } = require('../middleware/auth');
const { validatePhone, validateOTP } = require('../middleware/validate');

// In-memory OTP store (Map with TTL)
const otpStore = new Map();

function generateMockOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /api/enroll/verify-aadhaar
router.post('/verify-aadhaar', async (req, res) => {
    try {
        const { phone } = req.body;

        if (!phone || !validatePhone(phone)) {
            return res.status(400).json({ error: 'Invalid phone number. Must be 10-digit Indian mobile number.' });
        }

        // Generate and store mock OTP
        const mockOtp = generateMockOTP();
        otpStore.set(phone, { otp: mockOtp, expires: Date.now() + 5 * 60 * 1000 }); // 5 min TTL

        // Clean expired OTPs
        for (const [key, val] of otpStore) {
            if (val.expires < Date.now()) otpStore.delete(key);
        }

        res.json({
            success: true,
            otp_sent: true,
            message: 'OTP sent successfully (mock)',
            mock_otp: mockOtp // Exposed for dev/demo - remove in production
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

        if (!validateOTP(otp)) {
            return res.status(400).json({ verified: false, error: 'Invalid OTP format' });
        }

        // Verify against stored OTP
        const stored = otpStore.get(phone);
        if (!stored || stored.expires < Date.now()) {
            return res.status(400).json({ verified: false, error: 'OTP expired or not found. Please request a new one.' });
        }

        if (stored.otp !== otp) {
            return res.status(400).json({ verified: false, error: 'Incorrect OTP' });
        }

        // OTP verified - remove from store
        otpStore.delete(phone);

        res.json({
            verified: true,
            message: 'Aadhaar verification successful (mock)'
        });
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
            phone,
            funding_method,    // 'upi' or 'crypto'
            funding_address    // UPI ID or crypto wallet address
        } = req.body;

        if (!wallet_id_hash || !fingerprint_hash || !distress_hash || !salt || !amount || !phone) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        if (!validatePhone(phone)) {
            return res.status(400).json({ error: 'Invalid phone number' });
        }

        // Convert amount from rupees to paise
        const amountInPaise = parseInt(amount) * 100;

        if (amountInPaise < 100000 || amountInPaise > 200000) {
            return res.status(400).json({ error: 'Amount must be between Rs 1000 and Rs 2000' });
        }

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

        // Generate JWT token
        const token = generateToken(userId, wallet.id);

        // Log funding method
        const method = funding_method || 'upi';
        console.log(`Wallet ${wallet.id} funded via ${method}${funding_address ? ` (${funding_address})` : ''}`);

        res.json({
            wallet_id: wallet.id,
            balance: wallet.balance,
            expiry: wallet.expiry,
            funding_method: method,
            token,
            message: `Wallet created successfully via ${method === 'crypto' ? 'Crypto' : 'UPI'}`
        });
    } catch (error) {
        console.error('Error in create-wallet:', error);
        res.status(500).json({ error: 'Failed to create wallet' });
    }
});

module.exports = router;
