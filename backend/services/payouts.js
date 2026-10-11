/**
 * PayPal Payouts to merchants (and to people customers sent money to).
 *
 * A payout row is queued whenever PulsePay owes someone money: when a merchant taps
 * "Cash out" (PAYOUT_MODE=manual, the default, so recent sales can still be refunded)
 * or after each payment (PAYOUT_MODE=instant).
 * It is submitted to PayPal with a unique sender_batch_id, then tracked by webhook
 * or by polling. Only when PayPal reports SUCCESS does the debt leave the ledger
 * (debit merchant:<id> / credit pool:paypal), so a failed or returned payout simply
 * leaves the merchant's balance owed and it is included in the next cash-out.
 */
const crypto = require('crypto');
const ledger = require('./ledger');
const rails = require('./rails');
const notifications = require('./notifications');
const elastic = require('./elastic');

const FAILED = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'DENIED', 'REFUNDED', 'REVERSED']);
const OPEN_SQL = `status NOT IN ('SUCCESS','FAILED','RETURNED','BLOCKED','DENIED','REFUNDED','REVERSED')`;

function instantMode() {
    return process.env.PAYOUT_MODE === 'instant';
}

/**
 * Queue a payout of money PulsePay owes on `account`. Returns null (and queues nothing)
 * when less than `amountCents` is available, so a payout can never exceed what is owed.
 * Locks the merchant row, as refunds do, so a refund and a payout can't both spend
 * the same balance. `simulated` defaults to the current rails; demo shops pass true
 * (their money never reached PayPal).
 */
async function queue(pool, { merchantId = null, account, recipientEmail, amountCents, sourceRequest = null, simulated = !rails.live() }) {
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        if (merchantId) await c.query('SELECT id FROM merchants WHERE id = $1 FOR UPDATE', [merchantId]);
        else await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [account]);
        if ((await available(c, account)).available < amountCents) {
            await c.query('ROLLBACK');
            return null;
        }
        const r = await c.query(
            `INSERT INTO payouts (merchant_id, account, recipient_email, amount, sender_batch_id, source_request, simulated)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [merchantId, account, recipientEmail, amountCents, `pulsepay-${crypto.randomUUID().replace(/-/g, '')}`,
                sourceRequest, simulated]
        );
        await c.query('COMMIT');
        return r.rows[0];
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        c.release();
    }
}

/** Record a status from PayPal; post the ledger group exactly once on SUCCESS. */
async function applyStatus(pool, payoutId, { status, itemId = null, error = null }) {
    const c = await pool.connect();
    let payout;
    try {
        await c.query('BEGIN');
        payout = (await c.query('SELECT * FROM payouts WHERE id = $1 FOR UPDATE', [payoutId])).rows[0];
        if (!payout || payout.status === 'SUCCESS' || !status) { await c.query('COMMIT'); return payout; }
        await c.query(
            `UPDATE payouts SET status = $2, payout_item_id = COALESCE($3, payout_item_id),
                    last_error = $4, updated_at = NOW() WHERE id = $1`,
            [payoutId, status, itemId, error]
        );
        if (status === 'SUCCESS') {
            await ledger.postGroup(c, {
                requestId: `payout:${payout.id}`, kind: 'payout', status: 'settled', externalRef: itemId || payout.payout_batch_id,
                lines: [
                    { account: payout.account, direction: 'debit', amount: Number(payout.amount), suffix: 'payee' },
                    { account: ledger.POOL_ACCOUNT, direction: 'credit', amount: Number(payout.amount), suffix: 'pool' },
                ],
            });
        }
        await c.query('COMMIT');
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        if (e.code !== '23505') throw e; // already ledgered by a concurrent update
    } finally {
        c.release();
    }
    if (payout && status !== payout.status) {
        elastic.index({
            type: 'payout', merchant_id: payout.merchant_id, payout_id: payoutId, status,
            amount_usd: Number(payout.amount) / 100, error: error || undefined,
        });
    }
    if (FAILED.has(status)) {
        notifications.event('payout_failed', {
            payout_id: payoutId, recipient: payout?.recipient_email, amount_cents: Number(payout?.amount), status, error,
        });
    }
    return payout;
}

/** Send a queued payout to PayPal. Network errors leave it queued for the next sweep. */
async function submit(pool, payout) {
    if (!payout || payout.status !== 'queued') return payout;
    try {
        const r = await rails.payout({
            senderBatchId: payout.sender_batch_id, recipientEmail: payout.recipient_email,
            amountCents: Number(payout.amount), currency: payout.currency, simulated: payout.simulated,
            note: 'Your PulsePay sales',
        });
        // SUCCESS is only ever written by applyStatus, together with its ledger entry.
        const status = !r.batchStatus || r.batchStatus === 'SUCCESS' ? 'PENDING' : r.batchStatus;
        await pool.query(
            `UPDATE payouts SET payout_batch_id = $2, status = $3, last_error = NULL, updated_at = NOW() WHERE id = $1`,
            [payout.id, r.payoutBatchId, status]
        );
        if (payout.simulated || r.batchStatus === 'SUCCESS') {
            await refresh(pool, { ...payout, payout_batch_id: r.payoutBatchId, status });
        }
    } catch (e) {
        const permanent = e.status >= 400 && e.status < 500 && e.status !== 429;
        await pool.query(
            `UPDATE payouts SET status = $2, last_error = $3, updated_at = NOW() WHERE id = $1`,
            [payout.id, permanent ? 'FAILED' : 'queued', String(e.message).slice(0, 500)]
        );
        if (permanent) notifications.event('payout_failed', { payout_id: payout.id, recipient: payout.recipient_email, error: e.message });
        console.error(`payout ${payout.id} submit failed (${permanent ? 'permanent' : 'will retry'}):`, e.message);
    }
    return payout;
}

async function refresh(pool, payout) {
    if (!payout?.payout_batch_id) return;
    const st = await rails.payoutStatus({ payoutBatchId: payout.payout_batch_id, simulated: payout.simulated });
    const status = st.itemStatus || st.batchStatus;
    if (status && status !== payout.status) await applyStatus(pool, payout.id, { status, itemId: st.itemId, error: st.error });
}

/** Queue + submit in the background (never blocks the payment response). */
function queueAndSubmit(pool, args) {
    queue(pool, args)
        .then((p) => submit(pool, p))
        .catch((e) => console.error('payout queue failed (debt stays on the ledger):', e.message));
}

/** What PulsePay owes this ledger account, minus payouts already on their way. `db`: pool or client. */
async function available(db, account) {
    const owed = await db.query(`SELECT ${ledger.BALANCE_SQL} AS bal FROM ledger_entries WHERE account = $1`, [account]);
    const open = await db.query(`SELECT COALESCE(SUM(amount), 0) AS amt FROM payouts WHERE account = $1 AND ${OPEN_SQL}`, [account]);
    const owedCents = Number(owed.rows[0].bal);
    const inFlight = Number(open.rows[0].amt);
    return { owed: owedCents, in_flight: inFlight, available: owedCents - inFlight };
}

/** Background sweep: submit queued payouts and refresh open ones (webhook fallback). */
function startReconciler(pool) {
    const seconds = Number(process.env.PAYOUT_POLL_SECONDS ?? 20);
    if (!seconds) return null;
    let running = false;
    const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            const queued = await pool.query(
                `SELECT * FROM payouts WHERE status = 'queued' AND updated_at < NOW() - INTERVAL '5 seconds' ORDER BY created_at LIMIT 20`
            );
            for (const p of queued.rows) await submit(pool, p);
            const open = await pool.query(
                `SELECT * FROM payouts WHERE payout_batch_id IS NOT NULL AND ${OPEN_SQL} ORDER BY updated_at LIMIT 20`
            );
            for (const p of open.rows) await refresh(pool, p).catch((e) => console.error('payout refresh failed:', e.message));
        } catch (e) {
            console.error('payout sweep failed:', e.message);
        } finally {
            running = false;
        }
    }, seconds * 1000);
    timer.unref();
    return timer;
}

module.exports = { instantMode, queue, submit, refresh, applyStatus, queueAndSubmit, available, startReconciler, OPEN_SQL };
