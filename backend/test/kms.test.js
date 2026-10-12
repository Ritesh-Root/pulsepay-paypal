// Biometric templates are encrypted with KMS_DATA_KEY. The key may be 64 hex chars or
// base64 (what Render's generateValue produces); anything that isn't 32 bytes is refused.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const kms = require('../services/kms');

const saved = process.env.KMS_DATA_KEY;
afterEach(() => {
    // Assigning undefined to process.env stores the string "undefined".
    if (saved === undefined) delete process.env.KMS_DATA_KEY;
    else process.env.KMS_DATA_KEY = saved;
});

function roundTrip() {
    const sealed = kms.encrypt(Buffer.from('template'));
    return kms.decrypt(sealed.ciphertext, sealed.iv, sealed.tag).toString();
}

describe('KMS data key', () => {
    it('accepts 64 hex characters', () => {
        process.env.KMS_DATA_KEY = crypto.randomBytes(32).toString('hex');
        assert.equal(roundTrip(), 'template');
    });

    it('ignores whitespace around the key (a trailing newline from a secrets file)', () => {
        const key = crypto.randomBytes(32);
        process.env.KMS_DATA_KEY = key.toString('hex');
        const sealed = kms.encrypt(Buffer.from('template'));
        for (const padded of [`${key.toString('hex')}\n`, `  ${key.toString('base64')} \n`]) {
            process.env.KMS_DATA_KEY = padded;
            assert.equal(kms.decrypt(sealed.ciphertext, sealed.iv, sealed.tag).toString(), 'template');
        }
    });

    it("accepts base64 of 32 bytes (Render's generateValue)", () => {
        process.env.KMS_DATA_KEY = crypto.randomBytes(32).toString('base64');
        assert.equal(roundTrip(), 'template');
    });

    it('reads the same key the same way every time', () => {
        const key = crypto.randomBytes(32);
        process.env.KMS_DATA_KEY = key.toString('hex');
        const sealed = kms.encrypt(Buffer.from('template'));
        process.env.KMS_DATA_KEY = key.toString('base64');
        assert.equal(kms.decrypt(sealed.ciphertext, sealed.iv, sealed.tag).toString(), 'template');
    });

    it('refuses keys that are not 32 bytes', () => {
        for (const bad of [crypto.randomBytes(16).toString('hex'), crypto.randomBytes(16).toString('base64'), 'not a key', '']) {
            process.env.KMS_DATA_KEY = bad;
            assert.throws(() => kms.assertAvailable(), /KMS_DATA_KEY/);
        }
    });
});
