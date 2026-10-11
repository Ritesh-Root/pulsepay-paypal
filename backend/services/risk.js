/**
 * Escalate-only risk check.
 *
 * Every payment already needs the customer's chosen biometric(s) + PIN, inside
 * hard wallet limits (balance cap, per-payment cap, 72h expiry). The customer's
 * phone may be at home, so there is no OTP to step up to. The advisor can therefore
 * only do one thing: escalate an allowed payment to DECLINED.
 *
 *   final = strictest(floor, advice)      floor is always 'allow' within limits
 *
 * A poisoned or hallucinated advisor can block a payment but can never weaken
 * authentication. If Jev does not answer, a local heuristic produces a score for
 * display and the floor stands (auth never blocks on the advisor).
 */

const DECISIONS = ['allow', 'decline'];

function rank(decision) {
    const i = DECISIONS.indexOf(decision);
    return i === -1 ? 0 : i;
}
function strictest(a, b) {
    return rank(a) >= rank(b) ? a : b;
}
function knownDecision(d) {
    return DECISIONS.includes(d) ? d : null;
}

/** Offline heuristic: a 0–100 score for display only. Never declines. */
function localScore({ amountCents, hour, spendingHistory }) {
    let score = 10;
    if (hour >= 22 || hour < 5) score += 25;
    if (spendingHistory.length > 0) {
        const avg = spendingHistory.reduce((a, b) => a + b, 0) / spendingHistory.length;
        if (avg > 0 && amountCents > avg * 5) score += 50;
    }
    return Math.min(100, score);
}

async function assess({ amountCents, now, spendingHistory }) {
    const floor = 'allow';
    const history = Array.isArray(spendingHistory) ? spendingHistory : [];
    const hour = (now || new Date()).getHours();

    let advice = floor;
    let source = 'floor';
    let jev = null;
    let fallbackReason = null;
    let fraudScore = null;
    try {
        jev = await require('./jev').advise({
            amount_usd: amountCents / 100,
            hour_of_day: hour,
            is_late_night: hour >= 22 || hour < 5,
            recent_amounts_usd: history.map((c) => c / 100),
        });
        const d = knownDecision(jev.choice);
        if (d) {
            advice = d;
            source = 'jev';
        }
        fraudScore = jev.fraud_risk_score;
    } catch (err) {
        source = 'fallback';
        fallbackReason = err && err.message ? err.message : 'jev unavailable';
        fraudScore = localScore({ amountCents, hour, spendingHistory: history });
        jev = null;
    }

    const decision = strictest(floor, advice);
    return {
        decision,
        floor,
        advice,
        source,
        fallback_reason: fallbackReason,
        model: jev?.model || null,
        fraud_risk_score: fraudScore,
        choice_confidence: jev?.choice_confidence ?? null,
    };
}

module.exports = { assess, strictest, localScore };
