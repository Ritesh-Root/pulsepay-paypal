/**
 * Merchant back-office data, shared by the dashboard endpoint and the AI assistant.
 *
 * Privacy rules for everything returned here:
 *  - customers appear only as "Customer ••1234" (last 4 digits of their phone);
 *  - the distress flag is never read or returned (a coerced payment must look normal);
 *  - only this merchant's own rows are visible.
 */
const ledger = require('./ledger');
const payouts = require('./payouts');
const elastic = require('./elastic');
const { validateUUID, usd } = require('../middleware/validate');

const NOT_REFUNDABLE = "This sale has already been paid out to your PayPal account, so PulsePay can't refund it. Refund the customer from PayPal instead.";

const PERIODS = {
    today: `date_trunc('day', NOW())`,
    yesterday: `date_trunc('day', NOW()) - INTERVAL '1 day'`,
    week: `NOW() - INTERVAL '7 days'`,
    month: `NOW() - INTERVAL '30 days'`,
};

async function salesSummary(pool, merchantId, period = 'today') {
    const from = PERIODS[period] || PERIODS.today;
    const to = period === 'yesterday' ? `date_trunc('day', NOW())` : 'NOW() + INTERVAL \'1 minute\'';
    const r = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE kind = 'payment')                       AS payments,
                COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0)        AS gross,
                COUNT(*) FILTER (WHERE kind = 'merchant_refund')                AS refunds,
                COALESCE(SUM(amount) FILTER (WHERE kind = 'merchant_refund'), 0) AS refunded,
                COALESCE(MAX(amount) FILTER (WHERE kind = 'payment'), 0)        AS largest
           FROM transactions
          WHERE merchant_id = $1 AND created_at >= ${from} AND created_at < ${to}`,
        [merchantId]
    );
    const s = r.rows[0];
    const gross = Number(s.gross), refunded = Number(s.refunded);
    return {
        period,
        payments: Number(s.payments),
        gross_cents: gross,
        refunds: Number(s.refunds),
        refunded_cents: refunded,
        net_cents: gross - refunded,
        largest_payment_cents: Number(s.largest),
        average_payment_cents: Number(s.payments) ? Math.round(gross / Number(s.payments)) : 0,
        text: `${period}: ${s.payments} payments, ${usd(gross)} gross, ${usd(refunded)} refunded, ${usd(gross - refunded)} net`,
    };
}

async function recentPayments(pool, merchantId, limit = 20) {
    const r = await pool.query(
        `SELECT t.id, t.created_at, t.kind, t.amount, t.status, t.refunded, t.auth_tier, t.confidence_score,
                RIGHT(u.phone, 4) AS phone_last4
           FROM transactions t
           JOIN wallets w ON w.id = t.wallet_id
           JOIN users u ON u.id = w.user_id
          WHERE t.merchant_id = $1 AND t.kind IN ('payment','merchant_refund')
          ORDER BY t.created_at DESC
          LIMIT $2`,
        [merchantId, Math.min(Math.max(Number(limit) || 20, 1), 200)]
    );
    return r.rows.map((t) => ({
        id: t.id,
        created_at: t.created_at,
        kind: t.kind,
        amount_cents: Number(t.amount),
        status: t.status,
        refunded: t.refunded,
        method: t.auth_tier,
        match_score: t.confidence_score,
        customer: t.phone_last4 ? `Customer ••${t.phone_last4}` : 'Family member',
    }));
}

async function payoutList(pool, merchantId, limit = 50) {
    const r = await pool.query(
        `SELECT id, amount, status, recipient_email, created_at, updated_at, last_error, simulated, payout_batch_id
           FROM payouts WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [merchantId, limit]
    );
    return r.rows.map((p) => ({ ...p, amount_cents: Number(p.amount), amount: undefined }));
}

/** Simple, explainable anomaly flags (never about distress). */
async function anomalies(pool, merchantId) {
    const flags = [];
    const today = await salesSummary(pool, merchantId, 'today');
    if (today.payments >= 3 && today.refunds / today.payments > 0.2) {
        flags.push({ type: 'refund_rate', severity: 'warning', message: `${today.refunds} of ${today.payments} payments refunded today` });
    }
    const recent = await pool.query(
        `SELECT amount FROM transactions WHERE merchant_id = $1 AND kind = 'payment' ORDER BY created_at DESC LIMIT 30`, [merchantId]
    );
    const amounts = recent.rows.map((r) => Number(r.amount));
    if (amounts.length >= 5) {
        const sorted = [...amounts.slice(1)].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        if (amounts[0] >= 2000 && amounts[0] > median * 3) {
            flags.push({ type: 'large_payment', severity: 'info', message: `Latest payment ${usd(amounts[0])} is over 3× the usual ${usd(median)}` });
        }
    }
    const scans = await pool.query(
        `SELECT COUNT(*)::int AS n FROM audit_log
          WHERE resource_ref = $1 AND action IN ('identify_no_match','identify_ambiguous') AND created_at > NOW() - INTERVAL '1 hour'`,
        [merchantId]
    );
    if (scans.rows[0].n >= 5) {
        flags.push({ type: 'failed_scans', severity: 'warning', message: `${scans.rows[0].n} unrecognised scans at this terminal in the last hour` });
    }
    const pins = await pool.query(
        `SELECT COUNT(*)::int AS n FROM audit_log a JOIN pay_sessions s ON s.id::text = a.resource_ref
          WHERE s.merchant_id = $1 AND a.action = 'pay_pin_fail' AND a.created_at > NOW() - INTERVAL '1 hour'`,
        [merchantId]
    );
    if (pins.rows[0].n >= 3) {
        flags.push({ type: 'pin_failures', severity: 'warning', message: `${pins.rows[0].n} wrong PINs entered at this terminal in the last hour` });
    }
    const failed = await pool.query(
        `SELECT COUNT(*)::int AS n FROM payouts
          WHERE merchant_id = $1 AND status IN ('FAILED','RETURNED','BLOCKED','DENIED','UNCLAIMED')`,
        [merchantId]
    );
    if (failed.rows[0].n > 0) {
        flags.push({ type: 'payout_problem', severity: 'error', message: `${failed.rows[0].n} PayPal payout(s) did not go through; that money is still owed to you` });
    }
    return flags;
}

async function hourly(pool, merchantId) {
    const r = await pool.query(
        `SELECT date_trunc('hour', created_at) AS hour,
                COALESCE(SUM(amount) FILTER (WHERE kind = 'payment'), 0) AS sales,
                COUNT(*) FILTER (WHERE kind = 'payment') AS payments
           FROM transactions
          WHERE merchant_id = $1 AND created_at > NOW() - INTERVAL '24 hours'
          GROUP BY 1 ORDER BY 1`,
        [merchantId]
    );
    return r.rows.map((x) => ({ hour: x.hour, sales_cents: Number(x.sales), payments: Number(x.payments) }));
}

async function dashboard(pool, merchant) {
    const [balance, today, week, transactions, payoutRows, flags, series] = await Promise.all([
        payouts.available(pool, ledger.merchantAccount(merchant.id)),
        salesSummary(pool, merchant.id, 'today'),
        salesSummary(pool, merchant.id, 'week'),
        recentPayments(pool, merchant.id, 200),
        payoutList(pool, merchant.id, 50),
        anomalies(pool, merchant.id),
        hourly(pool, merchant.id),
    ]);
    return {
        merchant: { id: merchant.id, display_name: merchant.display_name, paypal_email: merchant.paypal_email },
        balance, today, week, transactions, payouts: payoutRows, anomalies: flags, hourly: series,
    };
}

/** Refund one of this merchant's payments back to the customer's wallet. */
async function refundPayment(pool, merchant, transactionId, reason) {
    if (!validateUUID(String(transactionId || ''))) return { http: 400, error: 'transaction_id required' };
    const c = await pool.connect();
    try {
        await c.query('BEGIN');
        // Same lock as payouts.queue: a refund and a payout can't both spend this balance.
        await c.query('SELECT id FROM merchants WHERE id = $1 FOR UPDATE', [merchant.id]);
        const tx = (await c.query(
            `SELECT * FROM transactions WHERE id = $1 AND merchant_id = $2 AND kind = 'payment' FOR UPDATE`,
            [transactionId, merchant.id]
        )).rows[0];
        if (!tx) { await c.query('ROLLBACK'); return { http: 404, error: 'Payment not found' }; }
        if (tx.refunded) { await c.query('ROLLBACK'); return { http: 409, error: 'This payment was already refunded' }; }
        // Refunds come only from money PulsePay still holds for this merchant. Once a sale
        // is paid out (or on its way) to their PayPal, PulsePay would be paying it twice.
        if ((await payouts.available(c, ledger.merchantAccount(merchant.id))).available < Number(tx.amount)) {
            await c.query('ROLLBACK');
            return { http: 409, error: NOT_REFUNDABLE };
        }
        const wallet = (await c.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [tx.wallet_id])).rows[0];
        if (!wallet || !wallet.active) {
            await c.query('ROLLBACK');
            return { http: 409, error: "The customer's wallet is closed, so the refund can't be returned to it" };
        }
        const amount = Number(tx.amount);
        const newBalance = Number(wallet.balance) + amount;
        await c.query('UPDATE wallets SET balance = $2 WHERE id = $1', [wallet.id, newBalance]);
        const lines = await ledger.postGroup(c, {
            requestId: `mrefund:${tx.id}`, walletId: wallet.id, kind: 'merchant_refund', status: 'settled',
            lines: [
                { account: ledger.merchantAccount(merchant.id), direction: 'debit', amount, suffix: 'counter' },
                { account: ledger.walletAccount(wallet.id), direction: 'credit', amount, balanceAfter: newBalance, suffix: 'wallet' },
            ],
        });
        await c.query('UPDATE transactions SET refunded = true WHERE id = $1', [tx.id]);
        const r = await c.query(
            `INSERT INTO transactions (wallet_id, merchant_id, ledger_entry_id, kind, counterparty, amount, auth_tier, status)
             VALUES ($1,$2,$3,'merchant_refund',$4,$5,$6,'completed') RETURNING id, created_at`,
            [wallet.id, merchant.id, lines[1].id, `Refund from ${merchant.display_name}`, amount, String(reason || 'merchant').slice(0, 32)]
        );
        await c.query('COMMIT');
        elastic.index({
            type: 'refund', merchant_id: merchant.id, merchant: merchant.display_name, transaction_id: r.rows[0].id,
            original_transaction_id: tx.id, amount_usd: amount / 100, reason: String(reason || ''),
        });
        return {
            refund: { transaction_id: r.rows[0].id, original_transaction_id: tx.id, amount_cents: amount, created_at: r.rows[0].created_at },
            message: `Refunded ${usd(amount)} to the customer's PulsePay wallet`,
        };
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        c.release();
    }
}

module.exports = { salesSummary, recentPayments, payoutList, anomalies, hourly, dashboard, refundPayment, NOT_REFUNDABLE };
