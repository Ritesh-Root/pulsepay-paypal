/**
 * Tamper-evident, append-only, hash-chained audit log (ARCHITECTURE §4.10).
 * Records NO biometric data (reference-only) so it survives a DPDP erasure under a
 * PMLA legal hold. Each row's record_hash chains the previous row's hash.
 */
const crypto = require('crypto');

async function append(pool, { actor, action, subjectUserId, resourceRef, ip }) {
    try {
        const prev = await pool.query(
            'SELECT record_hash FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 1'
        );
        const prevHash = prev.rows[0] ? prev.rows[0].record_hash : null;
        const payload = JSON.stringify({ actor, action, subjectUserId, resourceRef, ip, prevHash, t: Date.now() });
        const recordHash = crypto.createHash('sha256').update(payload).digest('hex');

        await pool.query(
            `INSERT INTO audit_log (actor, action, subject_user_id, resource_ref, ip, prev_hash, record_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [actor || 'system', action, subjectUserId || null, resourceRef || null, ip || null, prevHash, recordHash]
        );
    } catch (e) {
        // Audit must never break the main flow, but failures are themselves logged.
        console.error('audit append failed:', e.message);
    }
}

module.exports = { append };
