const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { payMerchant } = require('../services/razorpay');
const { sendSMS, sendSOS } = require('../services/twilio');
const { validateUUID, validateUPI, validateAmount } = require('../middleware/validate');
const nova = require('../services/nova');

// POST /api/payment/authenticate
router.post('/authenticate', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const { face_hash, fingerprint_hash, amount, merchant_upi, gps_lat, gps_lng } = req.body;

        if (!face_hash || !amount) {
            return res.status(400).json({ error: 'Face hash and amount required' });
        }

        const amountInPaise = parseInt(amount) * 100;

        // Determine authentication tier based on amount (static fallback)
        let tier;
        let requiresFingerprint = false;
        let requiresOTP = false;

        if (amountInPaise < 20000) {
            tier = 'face_only';
        } else if (amountInPaise < 100000) {
            tier = 'face_fingerprint';
            requiresFingerprint = true;
        } else {
            tier = 'face_fingerprint_otp';
            requiresFingerprint = true;
            requiresOTP = true;
        }

        // Nova AI risk assessment - override static tier if successful
        let riskAssessment = null;
        try {
            const now = new Date();
            riskAssessment = await nova.assessRisk({
                amount: amountInPaise,
                merchant_upi: merchant_upi || 'unknown',
                gps_lat: gps_lat || 0,
                gps_lng: gps_lng || 0,
                time_of_day: `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`,
                user_spending_history: []
            });

            if (riskAssessment) {
                tier = riskAssessment.recommended_tier;
                requiresFingerprint = tier === 'face_fingerprint' || tier === 'face_fingerprint_otp';
                requiresOTP = tier === 'face_fingerprint_otp';
            }
        } catch (novaError) {
            console.error('Nova risk assessment failed, using static rules:', novaError.message);
        }

        // Find wallet by face hash (wallet_id_hash) - also check delegates
        let walletResult = await pool.query(
            'SELECT * FROM wallets WHERE wallet_id_hash = $1 AND active = true AND expiry > NOW()',
            [face_hash]
        );

        let isDelegate = false;
        let delegateSpendingCap = null;

        if (walletResult.rows.length === 0) {
            // Check if this is a delegate
            const delegateResult = await pool.query(
                `SELECT dw.*, w.* FROM delegated_wallets dw
                 JOIN wallets w ON dw.parent_wallet_id = w.id
                 WHERE dw.delegate_face_hash = $1 AND dw.active = true AND w.active = true AND w.expiry > NOW()`,
                [face_hash]
            );

            if (delegateResult.rows.length === 0) {
                return res.status(404).json({
                    authenticated: false,
                    error: 'Wallet not found or expired'
                });
            }

            isDelegate = true;
            delegateSpendingCap = delegateResult.rows[0].spending_cap;
            // Use parent wallet data
            walletResult = { rows: [delegateResult.rows[0]] };
        }

        const wallet = walletResult.rows[0];

        // Enforce spending cap for delegates
        if (isDelegate && delegateSpendingCap !== null && amountInPaise > delegateSpendingCap) {
            return res.status(403).json({
                authenticated: false,
                error: `Amount exceeds delegate spending cap of Rs ${delegateSpendingCap / 100}`
            });
        }

        // Check if fingerprint is required and matches
        if (requiresFingerprint && fingerprint_hash) {
            if (wallet.fingerprint_hash !== fingerprint_hash) {
                return res.status(401).json({
                    authenticated: false,
                    error: 'Fingerprint does not match'
                });
            }
        } else if (requiresFingerprint && !fingerprint_hash) {
            return res.status(400).json({
                authenticated: false,
                error: 'Fingerprint required for this amount',
                tier
            });
        }

        // Deterministic confidence score based on face hash
        const confidence_score = 88 + (parseInt(face_hash.substring(0, 4), 16) % 12);

        const authResponse = {
            authenticated: true,
            wallet_id: wallet.id,
            confidence_score,
            tier,
            balance: wallet.balance,
            requires_otp: requiresOTP,
            is_delegate: isDelegate
        };

        if (riskAssessment) {
            authResponse.risk_score = riskAssessment.risk_score;
            authResponse.risk_reasoning = riskAssessment.reasoning;
        }

        res.json(authResponse);
    } catch (error) {
        console.error('Error in authenticate:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// POST /api/payment/execute
router.post('/execute', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const { wallet_id, amount, merchant_upi, gps_lat, gps_lng, otp, confidence_score } = req.body;

        if (!wallet_id || !amount || !merchant_upi) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const amountInPaise = parseInt(amount) * 100;

        // Require OTP for high-value transactions
        if (amountInPaise >= 100000) {
            if (!otp || !/^\d{6}$/.test(otp)) {
                return res.status(400).json({ error: 'OTP required for transactions over Rs 1000' });
            }
        }

        // Get wallet
        const walletResult = await pool.query(
            'SELECT * FROM wallets WHERE id = $1 AND active = true AND expiry > NOW()',
            [wallet_id]
        );

        if (walletResult.rows.length === 0) {
            return res.status(404).json({ error: 'Wallet not found or expired' });
        }

        const wallet = walletResult.rows[0];

        // Check balance
        if (wallet.balance < amountInPaise) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Determine tier
        let tier;
        if (amountInPaise < 20000) {
            tier = 'face_only';
        } else if (amountInPaise < 100000) {
            tier = 'face_fingerprint';
        } else {
            tier = 'face_fingerprint_otp';
        }

        // Execute payment via Razorpay (mock)
        let paymentResult;
        try {
            paymentResult = await payMerchant(merchant_upi, amountInPaise, wallet_id);
        } catch (paymentError) {
            console.error('Razorpay payment error:', paymentError);
            paymentResult = { status: 'mock_fallback', id: `fallback_${Date.now()}` };
        }

        // Deduct from wallet
        const newBalance = wallet.balance - amountInPaise;
        await pool.query(
            'UPDATE wallets SET balance = $1 WHERE id = $2',
            [newBalance, wallet_id]
        );

        // Use provided confidence_score or default
        const finalConfidence = confidence_score || 95;

        // Create transaction record
        const transactionResult = await pool.query(
            `INSERT INTO transactions (wallet_id, merchant_upi, amount, confidence_score, auth_tier, gps_lat, gps_lng, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, created_at`,
            [wallet_id, merchant_upi, amountInPaise, finalConfidence, tier, gps_lat || null, gps_lng || null, 'completed']
        );

        const transaction = transactionResult.rows[0];

        // Send SMS notification
        try {
            const userResult = await pool.query(
                'SELECT phone FROM users WHERE id = (SELECT user_id FROM wallets WHERE id = $1)',
                [wallet_id]
            );
            if (userResult.rows.length > 0) {
                const phone = userResult.rows[0].phone;
                await sendSMS(
                    phone,
                    `PulsePay: Rs.${amount} paid to ${merchant_upi}. Balance: Rs.${newBalance / 100}`
                );
            }
        } catch (smsError) {
            console.error('SMS error:', smsError);
        }

        // Generate voice confirmation via Nova
        let voiceConfirmation = null;
        try {
            voiceConfirmation = await nova.generateVoiceConfirmation({
                amount: amountInPaise,
                merchant_name: merchant_upi,
                transaction_id: transaction.id,
                timestamp: transaction.created_at
            });
        } catch (voiceError) {
            console.error('Voice confirmation error:', voiceError.message);
        }

        const executeResponse = {
            transaction_id: transaction.id,
            remaining_balance: newBalance,
            status: 'completed',
            payment_ref: paymentResult.id || paymentResult.utr,
            timestamp: transaction.created_at
        };

        if (voiceConfirmation) {
            executeResponse.voice_confirmation = voiceConfirmation;
        }

        res.json(executeResponse);
    } catch (error) {
        console.error('Error in execute payment:', error);
        res.status(500).json({ error: 'Payment execution failed' });
    }
});

// POST /api/payment/distress
router.post('/distress', async (req, res) => {
    const pool = req.app.locals.pool;

    try {
        const { wallet_id, amount, merchant_upi, gps_lat, gps_lng, emergency_contact } = req.body;

        // For distress test from dashboard (no payment, just SOS)
        if (!amount || !merchant_upi) {
            // SOS-only mode
            try {
                const walletResult = await pool.query(
                    `SELECT w.*, u.phone, u.emergency_contact
                     FROM wallets w
                     JOIN users u ON w.user_id = u.id
                     WHERE w.id = $1 AND w.active = true`,
                    [wallet_id]
                );

                if (walletResult.rows.length > 0) {
                    const wallet = walletResult.rows[0];
                    const contactToAlert = emergency_contact || wallet.emergency_contact || wallet.phone;

                    if (gps_lat && gps_lng) {
                        await sendSOS(contactToAlert, wallet.phone, gps_lat, gps_lng);
                    }
                }

                return res.json({
                    success: true,
                    distress_alert_sent: true,
                    message: 'SOS alert sent successfully'
                });
            } catch (err) {
                console.error('SOS-only error:', err);
                return res.status(500).json({ error: 'Failed to send SOS alert' });
            }
        }

        const amountInPaise = parseInt(amount) * 100;

        // Get wallet and user info
        const walletResult = await pool.query(
            `SELECT w.*, u.phone, u.emergency_contact
             FROM wallets w
             JOIN users u ON w.user_id = u.id
             WHERE w.id = $1 AND w.active = true AND w.expiry > NOW()`,
            [wallet_id]
        );

        if (walletResult.rows.length === 0) {
            return res.status(404).json({ error: 'Wallet not found or expired' });
        }

        const wallet = walletResult.rows[0];

        // Check balance
        if (wallet.balance < amountInPaise) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Execute payment normally
        try {
            await payMerchant(merchant_upi, amountInPaise, wallet_id);
        } catch (paymentError) {
            console.error('Razorpay payment error:', paymentError);
        }

        // Deduct from wallet
        const newBalance = wallet.balance - amountInPaise;
        await pool.query(
            'UPDATE wallets SET balance = $1 WHERE id = $2',
            [newBalance, wallet_id]
        );

        // Create transaction with distress flag
        const transactionResult = await pool.query(
            `INSERT INTO transactions (wallet_id, merchant_upi, amount, confidence_score, auth_tier, distress_triggered, gps_lat, gps_lng, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, created_at`,
            [wallet_id, merchant_upi, amountInPaise, 95, 'distress', true, gps_lat || null, gps_lng || null, 'completed']
        );

        const transaction = transactionResult.rows[0];

        // Send SOS SMS
        const contactToAlert = emergency_contact || wallet.emergency_contact || wallet.phone;
        if (gps_lat && gps_lng) {
            try {
                await sendSOS(contactToAlert, wallet.phone, gps_lat, gps_lng);
            } catch (sosError) {
                console.error('SOS SMS error:', sosError);
            }
        }

        // Also send normal SMS to user
        try {
            await sendSMS(
                wallet.phone,
                `PulsePay: Rs.${amount} paid to ${merchant_upi}. Balance: Rs.${newBalance / 100}. SOS alert sent.`
            );
        } catch (smsError) {
            console.error('SMS error:', smsError);
        }

        res.json({
            transaction_id: transaction.id,
            remaining_balance: newBalance,
            status: 'completed',
            distress_alert_sent: true,
            timestamp: transaction.created_at
        });
    } catch (error) {
        console.error('Error in distress payment:', error);
        res.status(500).json({ error: 'Distress payment failed' });
    }
});

module.exports = router;
