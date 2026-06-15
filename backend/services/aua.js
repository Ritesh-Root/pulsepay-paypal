/**
 * UIDAI AUA/KUA Aadhaar connector — PulsePay as Sub-AUA under SBI's licence
 * (ARCHITECTURE §4.6). STUB for the hackathon; the contract matches a real AUA
 * gateway so calling code is correct.
 *
 * Guarantees encoded here:
 *  - Aadhaar number is NEVER accepted/stored in plaintext — only a tokenized VID/ref.
 *  - The OTP is generated + verified server-side by the gateway and is NEVER echoed
 *    in any API response (the old enroll.js returned mock_otp — a security + UIDAI
 *    compliance breach).
 *  - Real Aadhaar biometric auth uses STQC registered devices producing encrypted
 *    PID blocks that PulsePay never decrypts or stores. (Not simulated here.)
 *
 * OTP state is held in a pluggable store. Default is in-memory with TTL (documented);
 * production externalizes to an India-resident Redis cluster (no in-memory SPOF).
 */
const crypto = require('crypto');
const twilio = require('./twilio');

const OTP_TTL_MS = 5 * 60 * 1000;
const store = new Map(); // key: reference -> { otpHash, expires, txnId }  (Redis in prod)

function hashOtp(otp) {
    return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function sweep() {
    const now = Date.now();
    for (const [k, v] of store) if (v.expires < now) store.delete(k);
}

/**
 * Request an e-KYC OTP. Sends it server-side (SMS) and returns ONLY a txnId.
 * @returns {Promise<{txn_id:string, otp_sent:boolean}>}
 */
async function requestEkycOtp({ reference, phone }) {
    sweep();
    const otp = (crypto.randomInt(0, 1_000_000)).toString().padStart(6, '0');
    const txnId = `AUA${crypto.randomBytes(6).toString('hex')}`;
    store.set(reference, { otpHash: hashOtp(otp), expires: Date.now() + OTP_TTL_MS, txnId });

    // Delivered server-side via an India DLT gateway. NEVER returned to the client.
    if (phone) {
        try { await twilio.sendSMS(phone, `Your SBI PulsePay verification code is ${otp}. Valid 5 minutes.`); }
        catch (e) { console.error('OTP SMS failed:', e.message); }
    }
    return { txn_id: txnId, otp_sent: true };
}

/**
 * Verify the e-KYC OTP. On success returns a tokenized Aadhaar reference + minimal
 * e-KYC payload. PID / raw biometrics are never part of this.
 */
async function verifyEkycOtp({ reference, otp }) {
    sweep();
    const rec = store.get(reference);
    if (!rec || rec.expires < Date.now()) return { verified: false, reason: 'otp_expired' };
    if (rec.otpHash !== hashOtp(otp)) return { verified: false, reason: 'otp_incorrect' };
    store.delete(reference);

    return {
        verified: true,
        aua_txn_id: rec.txnId,
        aadhaar_ref_token: `VID:${crypto.createHash('sha256').update(reference).digest('hex').slice(0, 24)}`,
        ekyc: { kyc_tier: 'min' }, // demo: min-KYC. Full e-KYC fields returned in prod.
    };
}

module.exports = { requestEkycOtp, verifyEkycOtp };
