/**
 * Money rails adapter: real PayPal (sandbox/live) when credentials are set,
 * otherwise a clearly-labelled simulation with the same contract, so the app and
 * its tests run without credentials.
 *
 * Each order / funding / payout row records whether it was simulated, so switching
 * modes later never tries to refund a simulated capture at PayPal (or vice versa).
 */
const crypto = require('crypto');
const paypal = require('./paypal');

function live() {
    return paypal.configured();
}
function mode() {
    return live() ? `paypal-${paypal.environment()}` : 'simulated';
}
const simId = (p) => `SIM-${p}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

async function createTopupOrder({ amountCents, currency, customId, requestId, returnUrl, cancelUrl, simulated = false }) {
    if (simulated || !live()) return { id: simId('ORDER'), status: 'CREATED', simulated: true };
    const o = await paypal.createOrder({
        amountCents, currency, customId, requestId, returnUrl, cancelUrl,
        description: 'PulsePay wallet top-up',
    });
    return { ...o, simulated: false };
}

async function captureTopupOrder(order) {
    if (order.simulated) {
        return {
            orderStatus: 'COMPLETED', captureId: simId('CAPTURE'), captureStatus: 'COMPLETED',
            amountCents: Number(order.amount), currency: order.currency, payerEmail: null,
        };
    }
    return paypal.captureOrder(order.order_id, { requestId: `capture-${order.order_id}-${order.capture_attempts || 0}` });
}

async function refund({ captureId, amountCents, currency, requestId, simulated }) {
    if (simulated) return { refundId: simId('REFUND'), status: 'COMPLETED' };
    return paypal.refundCapture(captureId, { amountCents, currency, requestId });
}

async function payout({ senderBatchId, recipientEmail, amountCents, currency, note, simulated }) {
    if (simulated) return { payoutBatchId: simId('BATCH'), batchStatus: 'SUCCESS' };
    return paypal.createPayout({ senderBatchId, recipientEmail, amountCents, currency, note });
}

async function payoutStatus({ payoutBatchId, simulated }) {
    if (simulated) return { batchStatus: 'SUCCESS', itemStatus: 'SUCCESS', itemId: `${payoutBatchId}-ITEM`, error: null };
    return paypal.getPayoutBatch(payoutBatchId);
}

module.exports = { live, mode, createTopupOrder, captureTopupOrder, refund, payout, payoutStatus };
