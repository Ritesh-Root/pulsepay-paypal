/**
 * Post-commit async notification dispatch (ARCHITECTURE §4 G23, §6.3).
 *
 * SMS / voice / SOS run AFTER the ledger entry is committed, on an async queue —
 * never inside the debit transaction. So a notification outage can never delay or
 * fail a confirmed debit, and a client retry cannot re-enter the money path.
 *
 * SOS is ONE-DIRECTIONAL and IDEMPOTENT per transaction: at most one SOS per txn,
 * and AML/risk alerting may never call this channel (breaks the alert<->SOS loop).
 *
 * This is an in-process queue stub for the hackathon; production uses a durable
 * broker (e.g. an India-resident queue) with retries + dead-letter. SMS/voice go
 * via an India DLT-registered gateway, not a foreign one.
 */
const twilio = require('./twilio'); // kept only as the demo SMS transport

const sosSent = new Set(); // idempotency guard per transaction id (Redis set in prod)

function enqueue(job) {
    // Fire-and-forget; never awaited by the debit path.
    setImmediate(async () => {
        try {
            await job();
        } catch (e) {
            console.error('notification job failed (will dead-letter in prod):', e.message);
        }
    });
}

function paymentSms({ phone, amountPaise, merchant, balancePaise }) {
    if (!phone) return;
    enqueue(() => twilio.sendSMS(
        phone,
        `PulsePay: Rs.${(amountPaise / 100).toFixed(2)} paid to ${merchant}. Balance: Rs.${(balancePaise / 100).toFixed(2)}`
    ));
}

function silentSOS({ transactionId, contact, userName, gpsLat, gpsLng }) {
    if (!transactionId || sosSent.has(transactionId)) return; // idempotent, one-directional
    sosSent.add(transactionId);
    if (!contact || gpsLat == null || gpsLng == null) return;
    enqueue(() => twilio.sendSOS(contact, userName || 'PulsePay user', gpsLat, gpsLng));
}

module.exports = { paymentSms, silentSOS };
