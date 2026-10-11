/**
 * Biometric template protection + matching.
 *
 * Fixes the core flaw of the earlier build: it hashed the embedding (SHA3-256) and
 * did an EXACT-MATCH SQL lookup, which can never match two captures of the same
 * face (hash avalanche). Here we:
 *   1. keep the embedding as a VECTOR and match by cosine similarity >= threshold;
 *   2. apply a per-record CANCELABLE transform (orthogonal: permutation + sign-flip
 *      seeded by a per-record salt) so a stolen template is revocable and is NOT a
 *      reusable account-takeover key. Orthogonal transforms preserve cosine, so
 *      transform(probe) vs transform(enrolled) == probe vs enrolled, while a
 *      differently-salted probe cannot match a leaked template;
 *   3. envelope-encrypt the transformed vector at rest via the KMS service.
 *
 * The identifier (wallet UUID) is separated from the authenticator (this template):
 * matching returns WHICH subject matched; it is never used as a primary key.
 *
 * Demo caveat: the CV service's vectors come from a webcam frame, not a certified
 * fingerprint sensor or face model. FAR/FRR are unmeasured.
 */
const crypto = require('crypto');
const kms = require('./kms');

// Calibrated against FAR/FRR targets in production; provisional defaults here.
const MATCH_THRESHOLD = Number(process.env.BIOMETRIC_MATCH_THRESHOLD || process.env.FACE_MATCH_THRESHOLD || 0.86);
// 1:N decisions must be unambiguous: the best match has to beat the runner-up from
// any OTHER identity or purpose by this much, otherwise the scan is rejected and
// retaken. This is what stops a payment finger from tripping the distress finger
// (or another customer) when two templates score almost the same.
const MATCH_MARGIN = Number(process.env.BIOMETRIC_MATCH_MARGIN || 0.03);

const MIN_DIM = 64;
const MAX_DIM = 4096;

// ---- cancelable transform (orthogonal => cosine-preserving) ----------------

function seededRng(saltHex) {
    // Deterministic PRNG seeded by the per-record salt.
    let state = crypto.createHash('sha256').update(saltHex).digest();
    let idx = 0;
    return function next() {
        if (idx >= state.length - 4) {
            state = crypto.createHash('sha256').update(state).digest();
            idx = 0;
        }
        const v = state.readUInt32BE(idx);
        idx += 4;
        return v / 0xffffffff;
    };
}

function buildTransform(dim, saltHex) {
    const rng = seededRng(saltHex);
    // Fisher-Yates permutation
    const perm = Array.from({ length: dim }, (_, i) => i);
    for (let i = dim - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    // sign flips
    const signs = Array.from({ length: dim }, () => (rng() < 0.5 ? -1 : 1));
    return { perm, signs };
}

function applyTransform(vec, saltHex) {
    const { perm, signs } = buildTransform(vec.length, saltHex);
    const out = new Array(vec.length);
    for (let i = 0; i < vec.length; i++) {
        out[i] = vec[perm[i]] * signs[i];
    }
    return out;
}

// ---- vector math -----------------------------------------------------------

function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return -1;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return -1;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function vecToBuffer(vec) {
    const buf = Buffer.alloc(vec.length * 4);
    for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
    return buf;
}

function bufferToVec(buf) {
    const vec = new Array(buf.length / 4);
    for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
    return vec;
}

// ---- public API ------------------------------------------------------------

/** A usable embedding: a plain array of 64..4096 finite numbers that is not all zeros. */
function isEmbedding(v) {
    if (!Array.isArray(v) || v.length < MIN_DIM || v.length > MAX_DIM) return false;
    let nonZero = false;
    for (const x of v) {
        if (typeof x !== 'number' || !Number.isFinite(x)) return false;
        if (x !== 0) nonZero = true;
    }
    return nonZero;
}

/**
 * Protect a raw embedding for storage: cancelable-transform then envelope-encrypt.
 * Returns the row fields for biometric_templates.
 */
function protect(embedding) {
    const transformSalt = crypto.randomBytes(16).toString('hex');
    const transformed = applyTransform(embedding, transformSalt);
    const { ciphertext, iv, tag, keyRef } = kms.encrypt(vecToBuffer(transformed));
    return {
        protected_vector: ciphertext,
        enc_iv: iv,
        enc_tag: tag,
        transform_salt: transformSalt,
        kms_key_ref: keyRef,
    };
}

/**
 * Score a probe embedding against ONE stored template row.
 * Decrypts inside this "enclave", transforms the probe with the row's salt,
 * and returns the cosine similarity.
 */
function scoreAgainst(probeEmbedding, templateRow) {
    const storedTransformed = bufferToVec(
        kms.decrypt(templateRow.protected_vector, templateRow.enc_iv, templateRow.enc_tag)
    );
    const probeTransformed = applyTransform(probeEmbedding, templateRow.transform_salt);
    return cosine(probeTransformed, storedTransformed);
}

/**
 * Score against a row, or null if the row can't be decrypted (wrong/rotated key,
 * corrupted ciphertext). One unreadable template must not take down matching for
 * every other customer; it is logged and treated as a non-match, so only its own
 * owner is locked out until it is re-enrolled.
 */
function safeScore(probeEmbedding, row) {
    try {
        return scoreAgainst(probeEmbedding, row);
    } catch (e) {
        console.error(`biometric template ${row.id} could not be decrypted (${e.message}); skipped`);
        return null;
    }
}

/** Raw cosine between two unprotected embeddings (enrolment-time checks only). */
function similarity(a, b) {
    return cosine(a, b);
}

/**
 * 1:N identification over a set of active templates (small-N is fine for a demo;
 * production uses an ANN index inside the enclave).
 *
 * Returns one of:
 *   null                         — nothing above threshold
 *   { ambiguous: true }          — best and runner-up (different subject or purpose)
 *                                  are within MATCH_MARGIN; rescan
 *   { subject_id, template_id, purpose, similarity, confidence_score }
 */
function identify(probeEmbedding, templateRows) {
    // Best score per (subject, purpose) group, so two templates of the same finger
    // never count as ambiguity, but payment-vs-distress finger of one person does.
    const groups = new Map();
    for (const row of templateRows) {
        const sim = safeScore(probeEmbedding, row);
        if (sim === null) continue;
        const key = `${row.subject_id}:${row.purpose}`;
        const cur = groups.get(key);
        if (!cur || sim > cur.similarity) groups.set(key, { row, similarity: sim });
    }
    const ranked = [...groups.values()].sort((a, b) => b.similarity - a.similarity);
    const best = ranked[0];
    if (!best || best.similarity < MATCH_THRESHOLD) return null;
    const runnerUp = ranked[1];
    if (runnerUp && best.similarity - runnerUp.similarity < MATCH_MARGIN) return { ambiguous: true };
    return {
        subject_id: best.row.subject_id,
        template_id: best.row.id,
        purpose: best.row.purpose,
        similarity: best.similarity,
        confidence_score: Math.round(Math.min(100, best.similarity * 100)),
    };
}

/**
 * True if the probe would collide with any of these templates in a future 1:N
 * search (within MATCH_MARGIN of the threshold). Used at enrolment so two
 * identities can never be confused with each other.
 */
function collides(probeEmbedding, templateRows) {
    return templateRows.some((row) => (safeScore(probeEmbedding, row) ?? -1) >= MATCH_THRESHOLD - MATCH_MARGIN);
}

module.exports = {
    isEmbedding, protect, scoreAgainst, safeScore, similarity, identify, collides,
    MATCH_THRESHOLD, MATCH_MARGIN,
};
