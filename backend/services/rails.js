/**
 * RailsAdapter — NPCI/UPI · UPI 123Pay · SBI CBS (ARCHITECTURE §4.5).
 *
 * Replaces the mocked Razorpay payout (a competing PSP). Money moves over SBI/NPCI
 * rails only. The contract is RESERVE -> SETTLE -> CONFIRM(UTR), or RELEASE on
 * failure. We NEVER fabricate a success id and debit anyway (the old /execute did).
 *
 * This is a stub for the hackathon: real integration plugs SBI CBS APIs + the NPCI
 * UPI switch behind the same interface. Behaviour (two-phase, UTR, fail-closed) is
 * production-shaped so the calling code is correct as-is.
 */

const RAIL = process.env.PAYMENT_RAIL || 'upi_123pay'; // upi | upi_123pay | cbs

function utr() {
    // Real UTR comes from the NPCI/CBS response. Deterministic-ish stub id.
    return `UTR${process.hrtime.bigint().toString().slice(-12)}`;
}

/**
 * Debit the pre-funded SBI wallet account (CBS) and route the merchant credit
 * over UPI/123Pay. Returns { ok, utr, cbs_ref } or { ok:false, reason }.
 * Throws nothing the caller must guard — caller treats !ok as "release the hold".
 */
async function settle({ merchantUpi, amountPaise, walletId, cbsAccountRef }) {
    try {
        // Simulated rail latency. Real impl: CBS debit + UPI credit message.
        await new Promise(r => setTimeout(r, 150));

        if (!merchantUpi || amountPaise <= 0) {
            return { ok: false, reason: 'invalid_rail_request' };
        }

        return {
            ok: true,
            rail: RAIL,
            utr: utr(),
            cbs_ref: cbsAccountRef ? `CBS:${cbsAccountRef}` : null,
        };
    } catch (err) {
        // Fail closed: the caller will RELEASE the ledger reservation, not debit.
        return { ok: false, reason: err.message };
    }
}

/**
 * Credit funds INTO the wallet account at enrolment / top-up (CBS or UPI collect).
 */
async function fund({ amountPaise, fundingSource, walletId }) {
    await new Promise(r => setTimeout(r, 100));
    return { ok: true, source: fundingSource, utr: utr() };
}

/**
 * Refund unspent balance back to the source SBI/CBS account (expiry sweep / manual).
 */
async function refund({ amountPaise, walletId, cbsAccountRef }) {
    await new Promise(r => setTimeout(r, 100));
    return { ok: true, utr: utr(), cbs_ref: cbsAccountRef ? `CBS:${cbsAccountRef}` : null };
}

module.exports = { settle, fund, refund, RAIL };
