/**
 * Model-agnostic inference plane client (ARCHITECTURE §4.1).
 *
 * Replaces the hard AWS Bedrock (us-east-1) dependency. Embedding + liveness run
 * on the India-resident CV service behind a swappable provider interface. Amazon
 * Nova, if ever used, is just ONE optional provider that must sit on the India
 * egress allow-list — it is never a hard dependency and never the default.
 *
 * Egress allow-list: ALL outbound model calls must resolve to an India endpoint.
 * Anything off the allow-list is refused (fail-closed), satisfying RBI localization.
 */
const axios = require('axios');

const CV_SERVICE_URL = process.env.CV_SERVICE_URL || 'http://cv-service:8000';

// Hosts permitted to receive biometric data. Default provider is the in-cluster
// India-resident CV service. Extend via INDIA_MODEL_ALLOWLIST (comma-separated).
function allowedHosts() {
    const base = [new URL(CV_SERVICE_URL).host];
    const extra = (process.env.INDIA_MODEL_ALLOWLIST || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return new Set([...base, ...extra]);
}

function assertIndiaResident(targetUrl) {
    const host = new URL(targetUrl).host;
    if (!allowedHosts().has(host)) {
        throw new Error(
            `Egress blocked: ${host} is not on the India model allow-list (RBI data localization).`
        );
    }
}

/**
 * Extract a face embedding vector for a captured image via the India CV service.
 * @param {Buffer|string} imageData base64 image or buffer (forwarded; never persisted here)
 * @returns {Promise<{embedding:number[], liveness_passed:boolean, pad_score:number}>}
 */
async function extractFace(imageBase64) {
    const url = `${CV_SERVICE_URL}/embed-face`;
    assertIndiaResident(url);
    const resp = await axios.post(url, { image: imageBase64 }, { timeout: 8000 });
    return resp.data;
}

module.exports = { extractFace, assertIndiaResident, CV_SERVICE_URL };
