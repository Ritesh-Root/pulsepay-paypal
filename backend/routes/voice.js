/**
 * Voice confirmation route (ARCHITECTURE §4 H26).
 *
 * The merchant needs an audible confirmation in a phone-less flow. The Amazon build
 * shipped financial details to Amazon Nova Sonic in us-east-1 (a data-residency
 * breach). Here we return India-resident, off-critical-path confirmation TEXT that
 * the merchant PWA speaks with the on-device Web Speech API (local/edge TTS) — no
 * data leaves India and no foreign model is involved. Indic-language ready for the
 * low-literacy inclusion cohort.
 */
const express = require('express');
const router = express.Router();

const LANGS = {
    en: (amt, who) => `Payment of ${amt} rupees from ${who} received successfully.`,
    hi: (amt, who) => `${who} se ${amt} rupaye ka bhugtan safal raha.`,
};

// POST /api/voice/confirm  { amount, merchant_name, payer_name?, transaction_id?, lang? }
router.post('/confirm', (req, res) => {
    try {
        const { amount, merchant_name, payer_name, transaction_id, lang } = req.body;
        if (!amount || !merchant_name) {
            return res.status(400).json({ error: 'amount and merchant_name are required' });
        }
        const rupees = Math.round(Number(amount));
        const make = LANGS[lang] || LANGS.en;
        res.json({
            text: make(rupees, payer_name || 'customer'),
            lang: LANGS[lang] ? lang : 'en',
            voice_enabled: true,
            tts: 'client-web-speech', // spoken on-device; India-resident, no foreign model
            source: 'local-edge',
            transaction_id: transaction_id || null,
        });
    } catch (err) {
        console.error('[voice] /confirm error:', err.message);
        res.status(500).json({ error: 'Voice confirmation failed' });
    }
});

module.exports = router;
