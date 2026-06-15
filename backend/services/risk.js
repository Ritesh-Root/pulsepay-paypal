/**
 * Escalate-only risk engine (ARCHITECTURE §4.4).
 *
 * Authentication model (fingerprint-primary):
 *   - Base:    FINGERPRINT + PIN           (everyday amounts)
 *   - Step-up: FINGERPRINT + FACE          (above a configured amount limit)
 *   - Highest: FINGERPRINT + FACE + OTP    (high value / anomalous)
 *
 * Fingerprint is the primary inherence factor (matches SBI's AePS device base); the
 * agentic risk score may only RAISE the tier (require face, then OTP), never lower it
 * below the deterministic RBI-AFA floor. A poisoned/hallucinated score cannot weaken
 * auth:  final_tier = max(static_floor, ai_recommendation).
 *
 * Cold-start (no history) returns the floor — auth never blocks on the risk engine
 * (no bootstrap loop); the in-path scorer never trains online on its own outcomes.
 */

const TIERS = ['fingerprint_pin', 'fingerprint_face', 'fingerprint_face_otp'];

// Provisional thresholds (paise). Calibrate to RBI/NPCI small-PPI circulars.
const FACE_FLOOR = Number(process.env.TIER_FACE_PAISE || 50000);   // > Rs 500  -> add FACE
const OTP_FLOOR = Number(process.env.TIER_OTP_PAISE || 150000);    // > Rs 1500 -> add OTP

function rank(tier) {
    const i = TIERS.indexOf(tier);
    return i === -1 ? 0 : i;
}
function maxTier(a, b) {
    return rank(a) >= rank(b) ? a : b;
}

/** Deterministic statutory floor. Minimum is always two factors (fingerprint + PIN). */
function staticFloor(amountPaise) {
    if (amountPaise >= OTP_FLOOR) return 'fingerprint_face_otp';
    if (amountPaise >= FACE_FLOOR) return 'fingerprint_face';
    return 'fingerprint_pin';
}

/** Advisory score (escalate-only). Real impl calls the India-resident risk model. */
function advise({ amountPaise, hour, spendingHistory }) {
    let recommend = 'fingerprint_pin';
    if (hour >= 22 || hour < 5) recommend = maxTier(recommend, 'fingerprint_face'); // late night
    if (Array.isArray(spendingHistory) && spendingHistory.length > 0) {
        const avg = spendingHistory.reduce((a, b) => a + b, 0) / spendingHistory.length;
        if (avg > 0 && amountPaise > avg * 5) recommend = maxTier(recommend, 'fingerprint_face_otp');
    }
    return recommend;
}

/** Decide the final tier. Escalate-only: max(floor, advice). */
function decideTier({ amountPaise, now, spendingHistory }) {
    const floor = staticFloor(amountPaise);
    let recommended = floor;
    try {
        recommended = advise({
            amountPaise,
            hour: (now || new Date()).getHours(),
            spendingHistory: spendingHistory || [],
        });
    } catch (_) {
        recommended = floor; // graceful degradation to deterministic policy
    }
    const tier = maxTier(floor, recommended);
    return {
        tier,
        floor,
        recommended,
        requires_face: tier === 'fingerprint_face' || tier === 'fingerprint_face_otp',
        requires_otp: tier === 'fingerprint_face_otp',
    };
}

module.exports = { decideTier, staticFloor, TIERS };
