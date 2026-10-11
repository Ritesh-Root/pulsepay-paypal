/**
 * PayPal REST client (server-side only). Sandbox unless PAYPAL_ENVIRONMENT=live.
 *
 *   Orders v2      create + capture a wallet top-up (Checkout, JS SDK v6 on the client)
 *   Payments v2    refund a capture when a wallet is closed
 *   Payouts v1     pay a merchant's (or a payee's) PayPal account
 *   Webhooks v1    verify webhook signatures
 *
 * Every money-moving call sends a PayPal-Request-Id (or sender_batch_id), so a
 * retry can never move money twice.
 *
 * When PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are not set, `configured()` is false
 * and services/rails.js simulates these calls instead (clearly labelled in the UI).
 */

const TIMEOUT_MS = 30_000;

function environment() {
    return (process.env.PAYPAL_ENVIRONMENT || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
}
function baseUrl() {
    if (process.env.PAYPAL_API_BASE) return process.env.PAYPAL_API_BASE; // tests: a local fake PayPal
    return environment() === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}
function sdkUrl() {
    return environment() === 'live'
        ? 'https://www.paypal.com/web-sdk/v6/core'
        : 'https://www.sandbox.paypal.com/web-sdk/v6/core';
}
function configured() {
    return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

class PayPalError extends Error {
    constructor(status, body) {
        const detail = body?.details?.[0]?.issue || body?.name || `HTTP_${status}`;
        super(`paypal_${detail}`);
        this.status = status;
        this.issue = detail;
        this.debugId = body?.debug_id;
        this.body = body;
    }
}

let tokenCache = null; // { token, expiresAt }

async function accessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${baseUrl()}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) throw new PayPalError(r.status, data);
    tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3000) * 1000 };
    return tokenCache.token;
}

async function api(method, path, body, { requestId, prefer } = {}) {
    const headers = {
        Authorization: `Bearer ${await accessToken()}`,
        'Content-Type': 'application/json',
        ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
    };
    const r = await fetch(`${baseUrl()}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!r.ok) throw new PayPalError(r.status, data);
    return data;
}

const toValue = (cents) => (Number(cents) / 100).toFixed(2);
const toCents = (value) => Math.round(Number(value) * 100);

/** Orders v2: a top-up order the customer approves with the JS SDK. */
async function createOrder({ amountCents, currency = 'USD', description, customId, requestId, returnUrl, cancelUrl }) {
    const order = await api('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{
            amount: { currency_code: currency, value: toValue(amountCents) },
            description: description || 'PulsePay wallet top-up',
            custom_id: customId,
        }],
        payment_source: {
            paypal: {
                experience_context: {
                    brand_name: 'PulsePay',
                    shipping_preference: 'NO_SHIPPING',
                    user_action: 'PAY_NOW',
                    ...(returnUrl ? { return_url: returnUrl } : {}),
                    ...(cancelUrl ? { cancel_url: cancelUrl } : {}),
                },
            },
        },
    }, { requestId, prefer: 'return=minimal' });
    return { id: order.id, status: order.status };
}

/** Capture an approved order. Returns the capture that actually moved money. */
async function captureOrder(orderId, { requestId } = {}) {
    const res = await api('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, {
        requestId: requestId || `capture-${orderId}`, prefer: 'return=representation',
    });
    const capture = res.purchase_units?.[0]?.payments?.captures?.[0];
    return {
        orderStatus: res.status,
        captureId: capture?.id || null,
        captureStatus: capture?.status || null,
        amountCents: capture?.amount ? toCents(capture.amount.value) : null,
        currency: capture?.amount?.currency_code || null,
        payerEmail: res.payer?.email_address || res.payment_source?.paypal?.email_address || null,
    };
}

/** Payments v2: refund part or all of a capture. */
async function refundCapture(captureId, { amountCents, currency = 'USD', requestId, note }) {
    const res = await api('POST', `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
        amount: { currency_code: currency, value: toValue(amountCents) },
        note_to_payer: note || 'PulsePay wallet closed: unused balance returned',
    }, { requestId, prefer: 'return=representation' });
    return { refundId: res.id, status: res.status };
}

/**
 * Payouts v1: one item per batch, so the batch id doubles as our idempotency key.
 * PayPal rejects a reused sender_batch_id, so it is also sent as PayPal-Request-Id:
 * a retry after a lost response then gets the original batch back instead of an error.
 */
async function createPayout({ senderBatchId, recipientEmail, amountCents, currency = 'USD', note, senderItemId }) {
    const res = await api('POST', '/v1/payments/payouts', {
        sender_batch_header: {
            sender_batch_id: senderBatchId,
            email_subject: 'You received a PulsePay payout',
            email_message: note || 'Payment from PulsePay customers.',
        },
        items: [{
            recipient_type: 'EMAIL',
            amount: { value: toValue(amountCents), currency },
            receiver: recipientEmail,
            note: note || 'PulsePay payout',
            sender_item_id: senderItemId || senderBatchId,
        }],
    }, { requestId: senderBatchId });
    return { payoutBatchId: res.batch_header?.payout_batch_id, batchStatus: res.batch_header?.batch_status };
}

async function getPayoutBatch(payoutBatchId) {
    const res = await api('GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
    const item = res.items?.[0] || {};
    return {
        batchStatus: res.batch_header?.batch_status,
        itemId: item.payout_item_id || null,
        itemStatus: item.transaction_status || null,
        error: item.errors?.message || item.errors?.name || null,
    };
}

/** Webhooks v1: ask PayPal whether this event really came from PayPal. */
async function verifyWebhook(headers, event) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) return false;
    const h = (k) => headers[k] || headers[k.toLowerCase()];
    const res = await api('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: webhookId,
        webhook_event: event,
    });
    return res.verification_status === 'SUCCESS';
}

module.exports = {
    configured, environment, sdkUrl, accessToken,
    createOrder, captureOrder, refundCapture, createPayout, getPayoutBatch, verifyWebhook,
    PayPalError, toCents, toValue,
};
