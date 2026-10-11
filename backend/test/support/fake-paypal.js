/**
 * A local stand-in for the PayPal REST API, for tests. It implements the documented
 * behaviour PulsePay relies on:
 *
 *   OAuth2 client credentials           POST /v1/oauth2/token
 *   Orders v2                           create; buyer approval (fake.approve); capture
 *   Payments v2                         refund part or all of a capture
 *   Payouts v1                          create batch (a reused sender_batch_id is rejected,
 *                                       a reused PayPal-Request-Id replays), get batch
 *   Webhooks v1                         verify-webhook-signature
 *
 * Bodies follow the developer.paypal.com reference examples, including fields PulsePay
 * does not read, so a parser that reads the wrong field fails here as it would live.
 *
 * Faults: fake.fault('create-payout', 'lose-response') lets PayPal act on
 * the next matching request and then drops the connection (a timeout after PayPal
 * moved the money). 'unavailable' answers 503 without acting.
 */
const http = require('http');
const crypto = require('crypto');

const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
const newId = (n = 17) => Array.from({ length: n }, () => ALNUM[crypto.randomInt(ALNUM.length)]).join('');
const cents = (value) => Math.round(Number(value) * 100);
const value = (c) => (c / 100).toFixed(2);

function startFakePayPal() {
    const state = {
        orders: new Map(),          // order id -> order
        captures: new Map(),        // capture id -> { orderId, amountCents, refundedCents, currency }
        batches: new Map(),         // payout_batch_id -> batch
        senderBatchIds: new Map(),  // sender_batch_id -> payout_batch_id
        replays: new Map(),         // `${route}:${PayPal-Request-Id}` -> stored response
        payoutItemStatus: 'SUCCESS',   // what GET payout reports for every item
        nextCaptureIssue: null,        // e.g. 'INSTRUMENT_DECLINED' for the next capture only
        nextCaptureAmount: null,       // e.g. '5.00' to capture a different amount once
        webhookVerification: 'SUCCESS',
        requests: [],
    };
    const faults = [];
    let base = '';

    const error = (status, name, message, details) => ({
        status, body: { name, message, debug_id: newId(13).toLowerCase(), details, links: [] },
    });

    const routes = [
        ['POST', /^\/v1\/oauth2\/token$/, 'token', (req) => {
            if (!/^Basic .+/.test(req.headers.authorization || '')) return { status: 401, body: { error: 'invalid_client' } };
            return { status: 200, body: {
                scope: 'https://uri.paypal.com/services/payments/payment https://uri.paypal.com/payments/payouts',
                access_token: `A21AA${newId(40)}`, token_type: 'Bearer', app_id: 'APP-80W284485P519543T',
                expires_in: 32400, nonce: newId(20),
            } };
        }],

        ['POST', /^\/v2\/checkout\/orders$/, 'create-order', (req, body) => {
            const unit = body.purchase_units?.[0];
            if (body.intent !== 'CAPTURE' || !unit?.amount?.value || !unit.amount.currency_code) {
                return error(400, 'INVALID_REQUEST', 'Request is not well-formed, syntactically incorrect, or violates schema.',
                    [{ issue: 'MISSING_REQUIRED_PARAMETER' }]);
            }
            const order = {
                id: newId(17), intent: 'CAPTURE', status: 'PAYER_ACTION_REQUIRED',
                purchase_units: [{ reference_id: 'default', amount: unit.amount, custom_id: unit.custom_id, description: unit.description }],
                create_time: new Date().toISOString(),
            };
            state.orders.set(order.id, order);
            return { status: 200, body: {
                id: order.id, status: order.status,
                links: [
                    { href: `${base}/v2/checkout/orders/${order.id}`, rel: 'self', method: 'GET' },
                    { href: `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`, rel: 'payer-action', method: 'GET' },
                ],
            } };
        }],

        ['POST', /^\/v2\/checkout\/orders\/([^/]+)\/capture$/, 'capture-order', (req, body, [orderId]) => {
            const order = state.orders.get(orderId);
            if (!order) {
                return error(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.', [{ issue: 'INVALID_RESOURCE_ID' }]);
            }
            if (order.status === 'COMPLETED') {
                return error(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed.', [{ issue: 'ORDER_ALREADY_CAPTURED' }]);
            }
            if (order.status !== 'APPROVED') {
                return error(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed.', [{ issue: 'ORDER_NOT_APPROVED' }]);
            }
            if (state.nextCaptureIssue) {
                const issue = state.nextCaptureIssue;
                state.nextCaptureIssue = null;
                return error(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed.', [{ issue }]);
            }
            const amount = state.nextCaptureAmount
                ? { currency_code: order.purchase_units[0].amount.currency_code, value: state.nextCaptureAmount }
                : order.purchase_units[0].amount;
            state.nextCaptureAmount = null;
            const now = new Date().toISOString();
            const capture = {
                id: newId(17), status: 'COMPLETED', amount, final_capture: true,
                seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
                seller_receivable_breakdown: {
                    gross_amount: amount,
                    paypal_fee: { currency_code: amount.currency_code, value: '0.49' },
                    net_amount: { currency_code: amount.currency_code, value: value(cents(amount.value) - 49) },
                },
                create_time: now, update_time: now,
            };
            state.captures.set(capture.id, { orderId: order.id, amountCents: cents(amount.value), refundedCents: 0, currency: amount.currency_code });
            order.status = 'COMPLETED';
            const payer = {
                name: { given_name: 'John', surname: 'Doe' }, email_address: 'sb-buyer@personal.example.com',
                payer_id: 'QYR5Z8XDVJNXQ', address: { country_code: 'US' },
            };
            return { status: 201, body: {
                id: order.id, intent: 'CAPTURE', status: 'COMPLETED',
                payment_source: { paypal: {
                    email_address: payer.email_address, account_id: payer.payer_id, account_status: 'VERIFIED',
                    name: payer.name, address: payer.address,
                } },
                purchase_units: [{ reference_id: 'default', amount: order.purchase_units[0].amount, payments: { captures: [capture] } }],
                payer, create_time: order.create_time, update_time: now,
                links: [{ href: `${base}/v2/checkout/orders/${order.id}`, rel: 'self', method: 'GET' }],
            } };
        }],

        ['POST', /^\/v2\/payments\/captures\/([^/]+)\/refund$/, 'refund', (req, body, [captureId]) => {
            const cap = state.captures.get(captureId);
            if (!cap) return error(404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.', [{ issue: 'INVALID_RESOURCE_ID' }]);
            const want = body.amount ? cents(body.amount.value) : cap.amountCents - cap.refundedCents;
            if (want <= 0 || want > cap.amountCents - cap.refundedCents) {
                return error(422, 'UNPROCESSABLE_ENTITY', 'The requested action could not be performed.', [{ issue: 'REFUND_AMOUNT_EXCEEDED' }]);
            }
            cap.refundedCents += want;
            const refundId = newId(17);
            return { status: 201, body: {
                id: refundId, status: 'COMPLETED', amount: { currency_code: cap.currency, value: value(want) },
                note_to_payer: body.note_to_payer,
                links: [{ href: `${base}/v2/payments/refunds/${refundId}`, rel: 'self', method: 'GET' }],
            } };
        }],

        ['POST', /^\/v1\/payments\/payouts$/, 'create-payout', (req, body) => {
            const header = body.sender_batch_header || {};
            const existing = state.senderBatchIds.get(header.sender_batch_id);
            if (existing) {
                return { status: 400, body: {
                    name: 'USER_BUSINESS_ERROR', message: 'User business error.', debug_id: newId(13).toLowerCase(),
                    information_link: 'https://developer.paypal.com/docs/api/payments.payouts-batch/#errors',
                    details: [{
                        field: 'SENDER_BATCH_ID', location: 'body', issue: 'Batch with given sender_batch_id already exists',
                        link: [{ href: `${base}/v1/payments/payouts/${existing}`, rel: 'self', method: 'GET', encType: 'application/json' }],
                    }],
                    links: [],
                } };
            }
            const item = body.items?.[0];
            const batch = {
                payout_batch_id: newId(13), sender_batch_header: header, item,
                payout_item_id: newId(13), transaction_id: newId(17), time_created: new Date().toISOString(),
            };
            state.batches.set(batch.payout_batch_id, batch);
            state.senderBatchIds.set(header.sender_batch_id, batch.payout_batch_id);
            return { status: 201, body: {
                batch_header: {
                    sender_batch_header: { sender_batch_id: header.sender_batch_id, email_subject: header.email_subject, email_message: header.email_message },
                    payout_batch_id: batch.payout_batch_id, batch_status: 'PENDING',
                },
                links: [{ href: `${base}/v1/payments/payouts/${batch.payout_batch_id}`, rel: 'self', method: 'GET', encType: 'application/json' }],
            } };
        }],

        ['GET', /^\/v1\/payments\/payouts\/([^/]+)$/, 'get-payout', (req, body, [batchId]) => {
            const batch = state.batches.get(batchId);
            if (!batch) return error(404, 'INVALID_RESOURCE_ID', 'Requested resource ID was not found.');
            const status = state.payoutItemStatus;
            const failed = ['FAILED', 'RETURNED', 'BLOCKED', 'DENIED'].includes(status);
            return { status: 200, body: {
                batch_header: {
                    payout_batch_id: batch.payout_batch_id, batch_status: status === 'PENDING' ? 'PROCESSING' : 'SUCCESS',
                    time_created: batch.time_created, sender_batch_header: batch.sender_batch_header,
                    amount: batch.item.amount, fees: { currency: batch.item.amount.currency, value: '0.00' },
                },
                items: [{
                    payout_item_id: batch.payout_item_id, transaction_id: batch.transaction_id,
                    transaction_status: status, payout_batch_id: batch.payout_batch_id,
                    payout_item_fee: { currency: batch.item.amount.currency, value: '0.00' },
                    payout_item: batch.item, time_processed: new Date().toISOString(),
                    ...(failed ? { errors: { name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered' } } : {}),
                    links: [{ href: `${base}/v1/payments/payouts-item/${batch.payout_item_id}`, rel: 'item', method: 'GET' }],
                }],
                links: [],
            } };
        }],

        ['POST', /^\/v1\/notifications\/verify-webhook-signature$/, 'verify-webhook', () => (
            { status: 200, body: { verification_status: state.webhookVerification } }
        )],
    ];

    function takeFault(key) {
        const i = faults.findIndex((f) => f.key === key);
        return i === -1 ? null : faults.splice(i, 1)[0].mode;
    }

    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const path = req.url.split('?')[0];
            const route = routes.find(([m, re]) => m === req.method && re.test(path));
            const send = ({ status, body }) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (!route) return send(error(404, 'NOT_FOUND', `No fake for ${req.method} ${path}`));
            const [method, re, name, handler] = route;
            const json = /json/.test(req.headers['content-type'] || '') && raw ? JSON.parse(raw) : {};
            state.requests.push({ method, path, route: name, headers: req.headers, body: json });

            if (name !== 'token' && !/^Bearer A21AA/.test(req.headers.authorization || '')) {
                return send({ status: 401, body: { error: 'invalid_token', error_description: 'Token signature verification failed' } });
            }
            const fault = takeFault(name);
            if (fault === 'unavailable') return send(error(503, 'SERVICE_UNAVAILABLE', 'Service Unavailable.'));

            const requestId = req.headers['paypal-request-id'];
            const replayKey = requestId && `${name}:${requestId}`;
            let out = replayKey && state.replays.get(replayKey);
            if (!out) {
                out = handler(req, json, path.match(re).slice(1));
                if (replayKey && out.status < 500) state.replays.set(replayKey, out);
            }
            if (fault === 'lose-response') return req.socket.destroy();
            send(out);
        });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${server.address().port}`;
            resolve({
                url: base,
                state,
                /** The buyer approves the order in the PayPal popup. */
                approve(orderId) {
                    const o = state.orders.get(orderId);
                    if (!o) throw new Error(`fake PayPal: no order ${orderId}`);
                    o.status = 'APPROVED';
                },
                /** Inject a fault into the next request to `name` (a route name such as 'create-payout'). */
                fault(name, mode) { faults.push({ key: name, mode }); },
                close() { return new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); },
            });
        });
    });
}

/** Point services/paypal.js at the fake. Call before the first PayPal request. */
function useFakePayPal(fake) {
    process.env.PAYPAL_CLIENT_ID = 'test-client-id';
    process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
    process.env.PAYPAL_API_BASE = fake.url;
}

module.exports = { startFakePayPal, useFakePayPal };
