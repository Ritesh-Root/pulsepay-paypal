/**
 * Fail-closed start-up checks. server.js refuses to start when
 * any problem is returned, instead of falling back to unsafe defaults.
 *
 * Demo shortcuts (codes shown in the app, one-tap demo shops) are allowed on simulated
 * PayPal and the PayPal sandbox, so a hosted hackathon demo works, but never when
 * PayPal moves real money.
 */
function bootProblems(env) {
    const problems = [];
    if (!env.JWT_SECRET || env.JWT_SECRET.length < 16) {
        problems.push('JWT_SECRET missing or too short (>=16 chars, from a secrets manager).');
    }
    if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
        problems.push('DATABASE_URL is required in production.');
    }
    const realMoney = !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET)
        && String(env.PAYPAL_ENVIRONMENT || '').toLowerCase() === 'live';
    if (realMoney && env.DEMO_SHOW_OTP === 'true') {
        problems.push('DEMO_SHOW_OTP=true would return one-time codes in API responses; not allowed with live PayPal.');
    }
    if (realMoney && env.DEMO_MODE === 'true') {
        problems.push('DEMO_MODE=true creates demo shops without sign-in; not allowed with live PayPal.');
    }
    return problems;
}

module.exports = { bootProblems };
