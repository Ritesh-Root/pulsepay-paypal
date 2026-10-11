process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'a'.repeat(64);
process.env.BIOMETRIC_MATCH_THRESHOLD = '0.86';
process.env.BIOMETRIC_MATCH_MARGIN = '0.03';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const bio = require('../services/biometric');
const { vec, near } = require('./support/vectors');

function row(subject, purpose, embedding, id) {
    return { id: id || `${subject}-${purpose}`, subject_id: subject, purpose, ...bio.protect(embedding) };
}

describe('cancelable templates', () => {
    it('keep cosine similarity after transform + encryption', () => {
        const v = vec(1);
        const probe = near(v, 0.95, 2);
        const s = bio.scoreAgainst(probe, row('a', 'auth', v));
        assert.ok(Math.abs(s - bio.similarity(probe, v)) < 1e-4);
    });
});

describe('1:N identification', () => {
    const alice = vec(10), bob = vec(20), aliceDistress = vec(30);
    const rows = [row('alice', 'auth', alice), row('alice', 'distress', aliceDistress), row('bob', 'auth', bob)];

    it('identifies the right person and purpose', () => {
        const m = bio.identify(near(alice, 0.97, 11), rows);
        assert.equal(m.subject_id, 'alice');
        assert.equal(m.purpose, 'auth');
    });

    it('detects the distress finger', () => {
        const m = bio.identify(near(aliceDistress, 0.97, 31), rows);
        assert.equal(m.subject_id, 'alice');
        assert.equal(m.purpose, 'distress');
    });

    it('returns null for a stranger', () => {
        assert.equal(bio.identify(vec(99), rows), null);
    });

    it('rejects an ambiguous scan instead of guessing between two templates', () => {
        const base = vec(40);
        const twin = near(base, 0.995, 41); // two templates almost identical to each other
        const amb = [row('carol', 'auth', base), row('carol', 'distress', twin)];
        assert.deepEqual(bio.identify(near(base, 0.98, 42), amb), { ambiguous: true });
    });

    it('does not treat two templates of the same finger as ambiguous', () => {
        const base = vec(50);
        const same = [row('dan', 'auth', base, 't1'), row('dan', 'auth', near(base, 0.995, 51), 't2')];
        const m = bio.identify(near(base, 0.98, 52), same);
        assert.equal(m.subject_id, 'dan');
    });
});

describe('enrolment checks', () => {
    it('collides with an already-registered identity', () => {
        const v = vec(60);
        assert.equal(bio.collides(near(v, 0.97, 61), [row('erin', 'auth', v)]), true);
        assert.equal(bio.collides(vec(62), [row('erin', 'auth', v)]), false);
    });

    it('validates embeddings', () => {
        assert.equal(bio.isEmbedding(vec(1)), true);
        assert.equal(bio.isEmbedding([0.1, 0.2, 0.3, 0.4]), false);          // the old dummy vectors
        assert.equal(bio.isEmbedding(new Array(128).fill(0)), false);         // all zeros
        assert.equal(bio.isEmbedding([...vec(1).slice(0, 127), 'x']), false); // non-numeric
        assert.equal(bio.isEmbedding(new Array(5000).fill(0.1)), false);      // too large
    });
});

describe('resilience', () => {
    it('skips a template that cannot be decrypted instead of failing everyone', () => {
        const good = vec(70);
        const broken = { ...row('ghost', 'auth', vec(71)), enc_tag: Buffer.alloc(16) }; // tampered tag
        const m = bio.identify(near(good, 0.97, 72), [broken, row('frank', 'auth', good)]);
        assert.equal(m.subject_id, 'frank');
        assert.equal(bio.collides(near(vec(73), 0.97, 74), [broken]), false);
    });
});
