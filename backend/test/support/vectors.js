/** Deterministic stand-ins for CV-service embeddings. */

/** A pseudo-random vector, the same for the same seed. */
function vec(seed, dim = 256) {
    let s = seed >>> 0;
    return Array.from({ length: dim }, () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0xffffffff - 0.5;
    });
}

/** A noisy recapture of v whose cosine similarity to v is roughly `target`. */
function near(v, target, seed) {
    const n = vec(seed, v.length);
    const k = Math.sqrt(1 / (target * target) - 1);
    return v.map((x, i) => x + k * n[i]);
}

module.exports = { vec, near };
