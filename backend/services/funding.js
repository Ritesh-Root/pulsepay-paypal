/**
 * Wallet top-ups with PayPal Checkout.
 *
 *   1. createOrder   server creates a PayPal order for an allowed amount and records
 *                    what it may fund (an enrolment for a phone, or one wallet)
 *   2. (customer approves it with the PayPal JS SDK v6 button)
 *   3. claimAndCapture  atomically claims the order (so two requests can't both use
 *                    it), captures it at PayPal and checks status + amount
 *   4. creditWallet  records the capture and posts the balanced funding group
 *
 * If the database write fails after PayPal captured the money, `compensate` refunds
 * the capture so the customer is never charged for a wallet that doesn't exist.
 */
const ledger = require('./ledger');
const rails = require('./rails');

const CURRENCY = 'USD';
const MIN_FUND_CENTS = Number(process.env.MIN_FUND_CENTS || 1000);       // $10
const MAX_BALANCE_CENTS = Number(process.env.MAX_BALANCE_CENTS || 20000); // $200 low-limit wallet
const UNCONFIRMED_GRACE_MINUTES = 10;

function coded(code, extra = {}) {
    const e = new Error(code);
    e.code = code;
    Object.assign(e, extra);
    return e;
}

/** Validate a top-up amount against the wallet's current balance. */
function checkAmount(amountCents, currentBalance = 0) {
    if (!amountCents || amountCents < MIN_FUND_CENTS) return `Top-up must be at least $${(MIN_FUND_CENTS / 100).toFixed(2)}`;
    if (currentBalance + amountCents > MAX_BALANCE_CENTS) {
        return `A PulsePay wallet holds at most $${(MAX_BALANCE_CENTS / 100).toFixed(2)}`;
    }
    return null;
}

/** `simulated: true` forces the simulator even when PayPal is configured (demo seeding). */
async function createOrder(pool, { purpose, phone = null, walletId = null, amountCents, appUrl, simulated = false }) {
    const order = await rails.createTopupOrder({
        amountCents, currency: CURRENCY, simulated,
        customId: purpose === 'enrol' ? `enrol:${phone}` : `wallet:${walletId}`,
        returnUrl: appUrl, cancelUrl: appUrl,
    });
    await pool.query(
        `INSERT INTO paypal_orders (order_id, purpose, phone, wallet_id, amount, currency, simulated)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, purpose, phone, walletId, amountCents, CURRENCY, order.simulated]
    );
    return { order_id: order.id, simulated: order.simulated, amount: amountCents, currency: CURRENCY };
}

/**
 * Claim and capture. `match` restricts which flow may use the order:
 * { purpose:'enrol', phone } or { purpose:'topup', walletId }.
 */
async function claimAndCapture(pool, orderId, match) {
    const claimed = await pool.query(
        `UPDATE paypal_orders SET status = 'capturing'
          WHERE order_id = $1 AND purpose = $2 AND status = 'created'
            AND (($2 = 'enrol' AND phone = $3) OR ($2 = 'topup' AND wallet_id = $4::uuid))
        RETURNING *`,
        [String(orderId || ''), match.purpose, match.phone || null, match.walletId || null]
    );
    const order = claimed.rows[0];
    if (!order) throw coded('order_unavailable');

    let capture;
    try {
        capture = await rails.captureTopupOrder(order);
    } catch (e) {
        // Declined: the customer may pick another funding source, which is a new capture
        // attempt with a new PayPal-Request-Id (PayPal replays the decline for the old one).
        // No answer (timeout, 5xx): PayPal may have captured, so the order stays usable and
        // a retry sends the same PayPal-Request-Id to get that capture back.
        // Any other refusal fails the order.
        const declined = e.issue === 'INSTRUMENT_DECLINED' || e.issue === 'PAYER_ACTION_REQUIRED';
        const unconfirmed = !e.status || e.status >= 500;
        await pool.query(
            `UPDATE paypal_orders SET status = $2, capture_attempts = capture_attempts + $3,
                    unconfirmed_at = CASE WHEN $4 THEN NOW() ELSE unconfirmed_at END
              WHERE order_id = $1`,
            [order.order_id, declined || unconfirmed ? 'created' : 'failed', declined ? 1 : 0, unconfirmed]
        );
        throw coded(declined ? 'payment_declined' : unconfirmed ? 'capture_unconfirmed' : 'capture_failed', { cause: e });
    }
    if (capture.captureStatus !== 'COMPLETED' || capture.amountCents !== Number(order.amount) || capture.currency !== order.currency) {
        await pool.query(`UPDATE paypal_orders SET status = 'failed' WHERE order_id = $1`, [order.order_id]);
        if (capture.captureStatus === 'COMPLETED') await compensate(order, capture);
        throw coded('capture_mismatch');
    }
    return { order, capture };
}

/**
 * Credit a captured top-up to an existing wallet in one transaction. Returns the new
 * balance. Throws if the wallet closed meanwhile or the top-up would exceed the wallet
 * limit ('wallet_limit'); the caller then refunds the capture.
 */
async function creditTopUp(pool, { walletId, order, capture }) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        const w = (await c.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [walletId])).rows[0];
        if (!w || !w.active) throw new Error('wallet_closed_during_topup');
        const newBalance = Number(w.balance) + capture.amountCents;
        // Re-checked under the lock: two orders created at the same balance can't both fit.
        if (newBalance > MAX_BALANCE_CENTS) throw new Error('wallet_limit');
        await c.query('UPDATE wallets SET balance = $2 WHERE id = $1', [walletId, newBalance]);
        await creditWallet(c, { walletId, order, capture, newBalance });
        await c.query('COMMIT');
        return newBalance;
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        c.release();
    }
}

/** Inside the caller's transaction: record the capture and credit the wallet. */
async function creditWallet(client, { walletId, order, capture, newBalance }) {
    await client.query(`UPDATE paypal_orders SET status = 'captured', wallet_id = $2 WHERE order_id = $1`, [order.order_id, walletId]);
    await client.query(
        `INSERT INTO wallet_fundings (wallet_id, paypal_order_id, capture_id, amount, payer_email, simulated)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [walletId, order.order_id, capture.captureId, capture.amountCents, capture.payerEmail, order.simulated]
    );
    const lines = await ledger.postGroup(client, {
        requestId: `fund:${order.order_id}`, walletId, kind: 'fund', status: 'settled', externalRef: capture.captureId,
        lines: [
            { account: ledger.POOL_ACCOUNT, direction: 'debit', amount: capture.amountCents, suffix: 'counter' },
            { account: ledger.walletAccount(walletId), direction: 'credit', amount: capture.amountCents, balanceAfter: newBalance, suffix: 'wallet' },
        ],
    });
    await client.query(
        `INSERT INTO transactions (wallet_id, ledger_entry_id, kind, counterparty, amount, auth_tier, status)
         VALUES ($1,$2,'fund',$3,$4,'paypal','completed')`,
        [walletId, lines[1].id, order.simulated ? 'Top-up (simulated PayPal)' : 'PayPal top-up', capture.amountCents]
    );
}

/**
 * A capture that got no answer may still have moved the customer's money. If they don't
 * retry within the grace period, capture again with the same PayPal-Request-Id (PayPal
 * returns the original capture) and refund it: there is no wallet to credit.
 */
async function sweepUnconfirmed(pool, graceMinutes = UNCONFIRMED_GRACE_MINUTES) {
    const stale = await pool.query(
        `UPDATE paypal_orders SET status = 'capturing'
          WHERE status = 'created' AND unconfirmed_at < NOW() - make_interval(mins => $1)
        RETURNING *`,
        [graceMinutes]
    );
    for (const order of stale.rows) {
        let capture;
        try {
            capture = await rails.captureTopupOrder(order);
        } catch (e) {
            const unconfirmed = !e.status || e.status >= 500;
            await pool.query(`UPDATE paypal_orders SET status = $2 WHERE order_id = $1`, [order.order_id, unconfirmed ? 'created' : 'failed']);
            continue;
        }
        await pool.query(`UPDATE paypal_orders SET status = 'failed' WHERE order_id = $1`, [order.order_id]);
        if (capture.captureStatus === 'COMPLETED') await compensate(order, capture);
    }
}

function startSweeper(pool, seconds = 60) {
    const timer = setInterval(() => {
        sweepUnconfirmed(pool).catch((e) => console.error('unconfirmed capture sweep failed:', e.message));
    }, seconds * 1000);
    timer.unref();
    return timer;
}

/** Refund a capture we could not record, so nobody pays for a wallet that doesn't exist. */
async function compensate(order, capture) {
    try {
        await rails.refund({
            captureId: capture.captureId, amountCents: capture.amountCents, currency: order.currency,
            requestId: `compensate-${capture.captureId}`, simulated: order.simulated,
        });
    } catch (e) {
        console.error(`COMPENSATION FAILED for capture ${capture.captureId}; refund manually:`, e.message);
    }
}

module.exports = {
    checkAmount, createOrder, claimAndCapture, creditWallet, creditTopUp, compensate, sweepUnconfirmed, startSweeper,
    MIN_FUND_CENTS, MAX_BALANCE_CENTS, CURRENCY,
};
