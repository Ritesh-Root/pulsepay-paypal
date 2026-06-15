/**
 * Biometric template protection + matching (ARCHITECTURE §4.2).
 *
 * Fixes the core flaw of the Amazon build: it hashed the embedding (SHA3-256) and
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
 */
const crypto = require('crypto');
const kms = require('./kms');

// Calibrated against FAR/FRR targets in production; provisional default here.
const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD || 0.86);

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
 * and returns the cosine similarity (0..1-ish).
 */
function scoreAgainst(probeEmbedding, templateRow) {
    const storedTransformed = bufferToVec(
        kms.decrypt(templateRow.protected_vector, templateRow.enc_iv, templateRow.enc_tag)
    );
    const probeTransformed = applyTransform(probeEmbedding, templateRow.transform_salt);
    return cosine(probeTransformed, storedTransformed);
}

/**
 * 1:N identification over a set of active templates (small-N is fine for a demo;
 * production uses an ANN index inside the enclave). Returns the best match above
 * threshold, or null. Confidence is the REAL similarity score (0..100), never a
 * client value and never a hash-modulo.
 */
function identify(probeEmbedding, templateRows) {
    let best = null;
    for (const row of templateRows) {
        const sim = scoreAgainst(probeEmbedding, row);
        if (!best || sim > best.similarity) best = { row, similarity: sim };
    }
    if (!best || best.similarity < MATCH_THRESHOLD) return null;
    return {
        subject_id: best.row.subject_id,
        template_id: best.row.id,
        similarity: best.similarity,
        confidence_score: Math.round(Math.min(100, best.similarity * 100)),
    };
}

module.exports = { protect, scoreAgainst, identify, cosine, MATCH_THRESHOLD };
