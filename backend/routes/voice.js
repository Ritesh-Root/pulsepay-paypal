/**
 * Voice confirmation route.
 *
 * The merchant needs an audible confirmation in a phone-light flow. This route
 * returns off-critical-path confirmation text that
 * the merchant PWA speaks with the on-device Web Speech API, so no audio service is
 * involved. Multi-language ready for low-literacy and elderly customers.
 */
const express = require('express');
const router = express.Router();

const LANGS = {
    en: (amt, who) => `Payment of ${amt} dollars from ${who} received.`,
    es: (amt, who) => `Pago de ${amt} dólares de ${who} recibido.`,
};

// POST /api/voice/confirm  { amount, merchant_name, payer_name?, transaction_id?, lang? }
router.post('/confirm', (req, res) => {
    try {
        const { amount, merchant_name, payer_name, transaction_id, lang } = req.body;
        if (!amount || !merchant_name) {
            return res.status(400).json({ error: 'amount and merchant_name are required' });
        }
        const dollars = Number(amount).toFixed(2).replace(/\.00$/, '');
        const make = LANGS[lang] || LANGS.en;
        res.json({
            text: make(dollars, payer_name || 'customer'),
            lang: LANGS[lang] ? lang : 'en',
            voice_enabled: true,
            tts: 'client-web-speech', // spoken on-device
            source: 'local-edge',
            transaction_id: transaction_id || null,
        });
    } catch (err) {
        console.error('[voice] /confirm error:', err.message);
        res.status(500).json({ error: 'Voice confirmation failed' });
    }
});

module.exports = router;
