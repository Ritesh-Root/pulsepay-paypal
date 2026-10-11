/**
 * Consent ledger for biometric data (GDPR / BIPA-style explicit, per-purpose consent).
 * Append-only, hash-chained, per-purpose, time-stamped, revocable. References only —
 * never any biometric data. A single boolean cannot evidence purpose limitation or
 * support withdrawal, so we record one row per granted/withdrawn purpose.
 */
const crypto = require('crypto');

const PURPOSES = ['wallet_auth', 'fraud_prevention', 'kyc', 'distress', 'delegate'];

async function record(pool, { subjectId, purpose, granted, channel, language }) {
    if (!PURPOSES.includes(purpose)) throw new Error(`invalid consent purpose: ${purpose}`);
    const prev = await pool.query(
        'SELECT record_hash FROM consent_records WHERE subject_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [subjectId]
    );
    const prevHash = prev.rows[0] ? prev.rows[0].record_hash : null;
    const payload = JSON.stringify({ subjectId, purpose, granted, channel, language, prevHash, t: Date.now() });
    const recordHash = crypto.createHash('sha256').update(payload).digest('hex');

    const r = await pool.query(
        `INSERT INTO consent_records (subject_id, purpose, granted, channel, language, prev_hash, record_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [subjectId, purpose, !!granted, channel || 'app', language || 'en', prevHash, recordHash]
    );
    return r.rows[0].id;
}

/** Grant the enrolment purpose set in one call ('distress' only if a distress finger was enrolled). */
async function recordEnrolmentConsent(pool, { subjectId, channel, language, distress }) {
    const purposes = ['wallet_auth', 'fraud_prevention', 'kyc', ...(distress ? ['distress'] : [])];
    for (const purpose of purposes) {
        await record(pool, { subjectId, purpose, granted: true, channel, language });
    }
}

module.exports = { record, recordEnrolmentConsent };
