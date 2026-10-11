/**
 * One-time codes for phone verification (customer enrolment, merchant sign-in).
 *
 *  - Codes are scoped by PURPOSE, so a code requested for one flow can never
 *    satisfy another.
 *  - At most MAX_ATTEMPTS wrong guesses per code, and at most MAX_ISSUES codes per
 *    phone+purpose per window, so a 6-digit code cannot be brute-forced by
 *    re-requesting.
 *  - The code is delivered by SMS (mocked). It is returned in the API response ONLY
 *    when DEMO_SHOW_OTP=true, which server.js refuses in production.
 *
 * State is in-memory with TTL (single instance demo). Production: Redis.
 */
const crypto = require('crypto');
const sms = require('./twilio');

const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const ISSUE_WINDOW_MS = 10 * 60 * 1000;
const MAX_ISSUES = 3;

const codes = new Map();  // `${purpose}:${phone}` -> { otpHash, expires, attempts, txnId }
const issues = new Map(); // `${purpose}:${phone}` -> [timestamps]

function demoOtpEnabled() {
    return process.env.DEMO_SHOW_OTP === 'true';
}

function hash(otp) {
    return crypto.createHash('sha256').update(String(otp)).digest();
}

function sweep() {
    const now = Date.now();
    for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
    for (const [k, v] of issues) {
        const recent = v.filter((t) => now - t < ISSUE_WINDOW_MS);
        if (recent.length) issues.set(k, recent); else issues.delete(k);
    }
}

/**
 * Issue a code. Returns { ok, txn_id, otp_sent, demo_otp? } or { ok:false, error:'otp_rate_limited' }.
 */
async function issue({ purpose, phone, message }) {
    sweep();
    const key = `${purpose}:${phone}`;
    const recent = issues.get(key) || [];
    if (recent.length >= MAX_ISSUES) return { ok: false, error: 'otp_rate_limited' };
    issues.set(key, [...recent, Date.now()]);

    const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const txnId = `OTP${crypto.randomBytes(6).toString('hex')}`;
    codes.set(key, { otpHash: hash(otp), expires: Date.now() + OTP_TTL_MS, attempts: 0, txnId });

    try { await sms.sendSMS(phone, message(otp)); }
    catch (e) { console.error('OTP SMS failed:', e.message); }

    return { ok: true, txn_id: txnId, otp_sent: true, ...(demoOtpEnabled() ? { demo_otp: otp } : {}) };
}

/**
 * Check a code WITHOUT consuming it (wrong guesses still count). Returns
 * { ok:true, txn_id } or { ok:false, reason }.
 */
function check({ purpose, phone, otp }) {
    sweep();
    const key = `${purpose}:${phone}`;
    const rec = codes.get(key);
    if (!rec || rec.expires < Date.now()) return { ok: false, reason: 'otp_expired' };
    if (!/^\d{6}$/.test(String(otp))) return { ok: false, reason: 'otp_incorrect' };
    if (!crypto.timingSafeEqual(rec.otpHash, hash(otp))) {
        rec.attempts += 1;
        if (rec.attempts >= MAX_ATTEMPTS) codes.delete(key);
        return { ok: false, reason: rec.attempts >= MAX_ATTEMPTS ? 'otp_attempts_exceeded' : 'otp_incorrect' };
    }
    return { ok: true, txn_id: rec.txnId };
}

function consume({ purpose, phone }) {
    codes.delete(`${purpose}:${phone}`);
}

/** check + consume in one step. */
function verify(args) {
    const r = check(args);
    if (r.ok) consume(args);
    return r;
}

module.exports = { issue, check, consume, verify, demoOtpEnabled };
