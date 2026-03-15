const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// Uses AWS_BEARER_TOKEN_BEDROCK env var (Bedrock API key) or standard
// IAM credentials via the default credential provider chain.
const clientConfig = {
  region: process.env.AWS_REGION || 'us-east-1',
};

// Only set explicit IAM credentials if provided
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  clientConfig.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
  };
}

const client = new BedrockRuntimeClient(clientConfig);

/**
 * Uses Amazon Nova 2 Lite via AWS Bedrock to dynamically score transaction risk.
 * Returns null on failure so callers can fall back to static logic.
 */
async function assessRisk(transactionData) {
  try {
    const { amount, merchant_upi, gps_lat, gps_lng, time_of_day, user_spending_history } = transactionData;

    const prompt = `You are a payment fraud risk assessment engine. Analyze this transaction and return ONLY valid JSON with no extra text.

Transaction:
- Amount (paise): ${amount}
- Merchant UPI: ${merchant_upi}
- GPS: ${gps_lat}, ${gps_lng}
- Time of day: ${time_of_day}
- User spending history (recent amounts in paise): ${JSON.stringify(user_spending_history || [])}

Return JSON with exactly these fields:
- "risk_score": integer 0-100 (0=safe, 100=fraud)
- "recommended_tier": one of "face_only", "face_fingerprint", "face_fingerprint_otp"
- "reasoning": short string explaining the score

Rules:
- Amounts far above user history = higher risk
- Late night (22:00-05:00) = +10 risk
- Very high amounts (>100000 paise) always need "face_fingerprint_otp"
- Medium amounts (20000-100000 paise) need at least "face_fingerprint"
- Low risk (<30) can use "face_only" even for medium amounts`;

    const body = JSON.stringify({
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 300, temperature: 0.1 }
    });

    const command = new InvokeModelCommand({
      modelId: 'amazon.nova-lite-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));

    // Extract text from Nova response
    const text = responseBody.output?.message?.content?.[0]?.text || '';

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const result = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (typeof result.risk_score !== 'number' || !result.recommended_tier || !result.reasoning) {
      return null;
    }

    // Clamp risk_score
    result.risk_score = Math.max(0, Math.min(100, result.risk_score));

    // Validate tier value
    const validTiers = ['face_only', 'face_fingerprint', 'face_fingerprint_otp'];
    if (!validTiers.includes(result.recommended_tier)) {
      result.recommended_tier = 'face_fingerprint'; // safe default
    }

    return result;
  } catch (error) {
    console.error('Nova assessRisk error:', error.message);
    return null;
  }
}

/**
 * Generates a voice confirmation using Nova 2 Sonic for real audio output.
 * Falls back to text-only confirmation if Sonic is unavailable.
 */
async function generateVoiceConfirmation(transactionDetails) {
  try {
    const { generateSpokenConfirmation } = require('./nova-sonic');
    const result = await generateSpokenConfirmation(transactionDetails);
    return {
      text: result.text,
      voice_enabled: result.voice_enabled,
      audio_base64: result.audio_base64 || undefined,
      source: result.source,
    };
  } catch (error) {
    console.error('Nova generateVoiceConfirmation error:', error.message);
    const amountRupees = Math.round(Number(transactionDetails.amount) / 100);
    const shortId = transactionDetails.transaction_id
      ? String(transactionDetails.transaction_id).slice(-4)
      : '0000';
    const displayName = transactionDetails.merchant_name || 'merchant';
    return {
      text: `Payment of ${amountRupees} rupees to ${displayName} confirmed. Transaction ID: TXN-${shortId}`,
      voice_enabled: false,
      source: 'fallback',
    };
  }
}

/**
 * Uses Nova Multimodal Embeddings via Bedrock for image embedding.
 * Returns embedding vector or null on failure.
 */
async function getEmbedding(imageBase64) {
  try {
    const body = JSON.stringify({
      inputImage: imageBase64,
      embeddingConfig: { outputEmbeddingLength: 1024 }
    });

    const command = new InvokeModelCommand({
      modelId: 'amazon.nova-embed-multimodal-v1:0',
      contentType: 'application/json',
      accept: 'application/json',
      body
    });

    const response = await client.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    return responseBody.embedding || null;
  } catch (error) {
    console.error('Nova getEmbedding error:', error.message);
    return null;
  }
}

module.exports = { assessRisk, generateVoiceConfirmation, getEmbedding };
