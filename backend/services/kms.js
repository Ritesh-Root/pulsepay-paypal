/**
 * KMS / envelope-encryption service.
 *
 * Stand-in for the India-resident HA HSM/KMS cluster (ARCHITECTURE §4.2, §10).
 * In production the data key never leaves the HSM and decryption happens inside a
 * secure enclave. Here we use AES-256-GCM with a data key sourced from the
 * KMS_DATA_KEY env var (which would itself be delivered by Vault/KMS, never hardcoded).
 *
 * FAIL CLOSED: if no key is configured the process refuses to start rather than
 * silently falling back to plaintext biometric storage.
 */
const crypto = require('crypto');

const KEY_REF = 'kms:data-key:v1';

function loadDataKey() {
    const hex = process.env.KMS_DATA_KEY;
    if (!hex) {
        throw new Error(
            'FATAL: KMS_DATA_KEY is not set. Biometric templates cannot be encrypted. ' +
            'Refusing to start (fail-closed). Provision a 32-byte hex key via Vault/KMS.'
        );
    }
    const key = Buffer.from(hex, 'hex');
    if (key.length !== 32) {
        throw new Error('FATAL: KMS_DATA_KEY must be 32 bytes (64 hex chars) for AES-256.');
    }
    return key;
}

/** Encrypt a Buffer. Returns { ciphertext, iv, tag, keyRef }. */
function encrypt(plaintextBuffer) {
    const key = loadDataKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag, keyRef: KEY_REF };
}

/** Decrypt. Throws on tamper (GCM auth failure). */
function decrypt(ciphertext, iv, tag) {
    const key = loadDataKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Verify a key is available at boot (used by server.js fail-closed check). */
function assertAvailable() {
    loadDataKey();
}

module.exports = { encrypt, decrypt, assertAvailable, KEY_REF };
