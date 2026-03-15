const express = require('express');
const router = express.Router();
const { generateSpokenConfirmation } = require('../services/nova-sonic');

/**
 * POST /api/voice/confirm
 *
 * Generate a spoken payment confirmation using Amazon Nova 2 Sonic.
 * No auth required for demo/hackathon purposes.
 *
 * Body: { amount: number, merchant_name: string, transaction_id: string }
 * Response: { audio_base64, text, voice_enabled, source }
 */
router.post('/confirm', async (req, res) => {
  try {
    const { amount, merchant_name, transaction_id } = req.body;

    if (!amount || !merchant_name) {
      return res.status(400).json({ error: 'amount and merchant_name are required' });
    }

    const result = await generateSpokenConfirmation({
      amount,
      merchant_name,
      transaction_id: transaction_id || 'unknown',
    });

    res.json(result);
  } catch (err) {
    console.error('[voice] /confirm error:', err.message);
    res.status(500).json({ error: 'Voice confirmation failed' });
  }
});

module.exports = router;
