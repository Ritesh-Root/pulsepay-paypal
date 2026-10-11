/**
 * Amazon Bedrock Converse client using a Bedrock API key (Bearer auth), no AWS SDK.
 *
 *   AWS_BEARER_TOKEN_BEDROCK   the Bedrock API key (server-side only)
 *   BEDROCK_REGION             default us-east-1
 *   BEDROCK_MODEL_ID           default zai.glm-5.3
 *   BEDROCK_FALLBACK_MODEL_ID  default zai.glm-5, used when the account is not enabled
 *                              for the primary model
 */
const REGION = () => process.env.BEDROCK_REGION || 'us-east-1';
const PRIMARY = () => process.env.BEDROCK_MODEL_ID || 'zai.glm-5.3';
const FALLBACK = () => process.env.BEDROCK_FALLBACK_MODEL_ID || 'zai.glm-5';

let resolvedModel = null; // first model that answered

function configured() {
    return !!process.env.AWS_BEARER_TOKEN_BEDROCK;
}

async function converseOnce(modelId, body) {
    const base = process.env.BEDROCK_ENDPOINT || `https://bedrock-runtime.${REGION()}.amazonaws.com`; // tests: a local fake
    const r = await fetch(`${base}/model/${encodeURIComponent(modelId)}/converse`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
        const e = new Error(data.message || `bedrock ${r.status}`);
        e.status = r.status;
        throw e;
    }
    return data;
}

const unavailable = (e) => /not available for this account|model identifier is invalid|access to the model/i.test(e.message);

/** Converse with automatic fallback when the primary model is not enabled. */
async function converse(body) {
    if (!configured()) throw new Error('AWS_BEARER_TOKEN_BEDROCK not set');
    const order = resolvedModel ? [resolvedModel] : [PRIMARY(), FALLBACK()];
    let lastErr;
    for (const modelId of order) {
        try {
            const out = await converseOnce(modelId, body);
            resolvedModel = modelId;
            return { ...out, modelId };
        } catch (e) {
            lastErr = e;
            if (!unavailable(e)) throw e;
            console.warn(`Bedrock model ${modelId} unavailable for this account; trying the next one`);
        }
    }
    throw lastErr;
}

module.exports = { configured, converse, model: () => resolvedModel || PRIMARY() };
