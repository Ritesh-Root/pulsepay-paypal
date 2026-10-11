/**
 * Post-commit async notifications.
 *
 * SMS, SOS and business events run AFTER the ledger commit, never inside the money
 * path, so an outage can never delay or fail a payment.
 *
 * Delivery:
 *  - SMS/SOS go through the demo SMS transport (services/twilio.js, logs only).
 *  - Every event is also POSTed to ZAPIER_WEBHOOK_URL when set (a Zapier
 *    "Catch Hook"), so a Zap can text the emergency contact, email a receipt or log
 *    to a sheet without code changes.
 *
 * SOS is ONE-DIRECTIONAL and IDEMPOTENT per transaction.
 */
const sms = require('./twilio');

const sosSent = new Set(); // idempotency guard per transaction id (Redis set in prod)

function enqueue(job) {
    setImmediate(async () => {
        try {
            await job();
        } catch (e) {
            console.error('notification job failed (will dead-letter in prod):', e.message);
        }
    });
}

/** Fire a business event to Zapier (if configured). Never throws. */
function event(type, data) {
    const url = process.env.ZAPIER_WEBHOOK_URL;
    if (!url) return;
    enqueue(async () => {
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: type, at: new Date().toISOString(), app: 'pulsepay', ...data }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`zapier ${r.status}`);
    });
}

const usd = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

function paymentSms({ phone, amountCents, merchant, balanceCents }) {
    if (!phone) return;
    const text = `PulsePay: ${usd(amountCents)} paid to ${merchant}. Balance: ${usd(balanceCents)}`;
    enqueue(() => sms.sendSMS(phone, text));
    event('payment_receipt', { phone, amount_cents: amountCents, merchant, balance_cents: balanceCents, text });
}

/**
 * Silent SOS. Sent even without GPS: the merchant's registered shop name is often
 * the most useful location an emergency contact can get.
 */
function silentSOS({ transactionId, contact, userName, gpsLat, gpsLng, place, reason }) {
    if (!transactionId || sosSent.has(transactionId)) return; // idempotent, one-directional
    sosSent.add(transactionId);
    if (!contact) {
        console.error('silent SOS has no emergency contact on file; flagged for AML review only');
        return;
    }
    enqueue(() => sms.sendSOS(contact, userName || 'PulsePay user', gpsLat, gpsLng, place, reason));
    event('sos', {
        contact, place: place || null, reason: reason || 'used their distress finger to pay',
        map: gpsLat != null && gpsLng != null ? `https://www.google.com/maps?q=${gpsLat},${gpsLng}` : null,
    });
}

module.exports = { paymentSms, silentSOS, event };
