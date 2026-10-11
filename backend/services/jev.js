/**
 * Jev (TypeSafe System One) advisory call.
 *
 * This is an EXTERNAL call to api.typesafe.ai, so it is opt-in (only when
 * TYPESAFE_API_KEY is set) and the payload is minimized: amount, hour of day and
 * recent amounts only. No customer, wallet, phone or merchant identifier is sent.
 *
 * A timeout or HTTP failure throws so the risk check falls back without blocking
 * the payment.
 */

const MODEL = 'jev-1.13.0';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 1500;

const RISK_LEVELS = [
    'Routine in-pattern purchase',
    'Slightly above this customer\'s recent average, still plausible',
    'Unusual hour or a clear step up from recent spends',
    'Large break from history',
    'Extreme deviation that looks like fraud',
];

function questions() {
    return {
        decision: {
            type: 'choice',
            instructions: 'Should this wallet payment go ahead, based only on `transaction`? The customer has already passed biometric identification and PIN. Decline only when the pattern looks like fraud.',
            criteria: {
                allow: 'Consistent with, or a plausible step up from, the customer\'s recent spending.',
                decline: 'An extreme deviation from recent spending that looks like fraud.',
            },
        },
        fraud_risk_score: {
            type: 'score',
            instructions: 'How high is the fraud risk of `transaction` compared with this customer\'s recent spending?',
            criteria: RISK_LEVELS,
        },
    };
}

/** Map a Score (0 .. levels-1) onto 0–100. */
function scoreToHundred(score) {
    if (typeof score !== 'number' || Number.isNaN(score)) return null;
    const top = RISK_LEVELS.length - 1;
    const clamped = Math.min(top, Math.max(0, score));
    return Math.round((clamped / top) * 100);
}

async function advise(transaction) {
    const key = process.env.TYPESAFE_API_KEY;
    if (!key) throw new Error('TYPESAFE_API_KEY not set (advisor disabled)');

    const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: MODEL,
            state: { transaction },
            questions: questions(),
        }),
    });
    if (!res.ok) throw new Error(`jev ${res.status}`);
    const body = await res.json();
    const decision = body.answers?.decision;
    const risk = body.answers?.fraud_risk_score;
    return {
        model: body.model || MODEL,
        choice: decision?.choice || null,
        choice_confidence: typeof decision?.confidence === 'number' ? decision.confidence : null,
        fraud_risk_score: scoreToHundred(risk?.score),
    };
}

module.exports = { advise };
