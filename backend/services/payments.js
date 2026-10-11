/**
 * Unified debit path: the one place money leaves a wallet.
 *
 * One database transaction: optional caller hook (e.g. consume the pay session),
 * wallet row lock, delegate cap, balance guard, a balanced ledger group (wallet ->
 * merchant:<id> or payee:<email>) and the journal row. The money is then owed to
 * the merchant/payee inside PulsePay and paid out to their PayPal account by
 * services/payouts.js, so the shop never waits on PayPal at the counter.
 *
 * Idempotent per requestId: a retry returns the original outcome.
 */
const ledger = require('./ledger');

const ERRORS = {
    wallet_inactive_or_expired: [404, 'Wallet not found or expired'],
    insufficient_balance: [400, 'Insufficient balance'],
    delegate_cap_exceeded: [403, 'Amount exceeds the family member spending cap'],
    delegate_inactive: [403, 'Family member access is no longer active'],
    session_unavailable: [409, 'Customer session already used or expired. Scan again.'],
};

function coded(code) {
    const e = new Error(code);
    e.code = code;
    return e;
}

function failure(err) {
    const [http, error] = ERRORS[err.code] || [500, 'Payment could not be completed'];
    if (http === 500) console.error('debit error:', err);
    return { ok: false, http, status: 'failed', error };
}

async function findExisting(pool, requestId) {
    const r = await pool.query(
        `SELECT le.balance_after, le.created_at, t.id AS tx_id, t.created_at AS tx_created_at
           FROM ledger_entries le
           LEFT JOIN transactions t ON t.ledger_entry_id = le.id
          WHERE le.idempotency_key = $1`,
        [`${requestId}:wallet`]
    );
    return r.rows[0] || null;
}

function completed(row) {
    return {
        ok: true, http: 200, status: 'completed',
        transaction_id: row.tx_id, payment_ref: row.tx_id,
        timestamp: row.tx_created_at || row.created_at,
        remaining_balance: Number(row.balance_after),
    };
}

/**
 * Debit a wallet and owe the amount to a merchant or payee.
 * @param {object} p
 * @param {string} p.requestId          idempotency scope, e.g. `pay:<sessionId>`
 * @param {string} p.walletId
 * @param {number} p.amountCents
 * @param {string} p.counterAccount     ledger account credited (merchant:<id> | payee:<email>)
 * @param {string} p.counterparty       human label for the journal
 * @param {string|null} [p.merchantId]
 * @param {'payment'|'send'} p.kind
 * @param {string|null} [p.delegateSubjectId]  enforce this delegate's cumulative cap
 * @param {(client) => Promise<void>} [p.beforeReserve]  runs inside the transaction
 */
async function debit(pool, p) {
    const { requestId, walletId, amountCents, kind, delegateSubjectId = null } = p;

    const existing = await findExisting(pool, requestId);
    if (existing) return completed(existing);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (p.beforeReserve) await p.beforeReserve(client);

        const wallet = (await client.query('SELECT * FROM wallets WHERE id = $1 FOR UPDATE', [walletId])).rows[0];
        if (!wallet || !wallet.active || new Date(wallet.expiry) <= new Date()) throw coded('wallet_inactive_or_expired');

        if (delegateSubjectId) {
            const d = (await client.query(
                `SELECT * FROM delegated_wallets
                  WHERE parent_wallet_id = $1 AND delegate_subject_id = $2 AND active = true FOR UPDATE`,
                [walletId, delegateSubjectId]
            )).rows[0];
            if (!d || (d.per_delegate_expiry && new Date(d.per_delegate_expiry) <= new Date())) throw coded('delegate_inactive');
            if (Number(d.spent_total) + amountCents > Number(d.spending_cap)) throw coded('delegate_cap_exceeded');
            await client.query('UPDATE delegated_wallets SET spent_total = spent_total + $1 WHERE id = $2', [amountCents, d.id]);
        }

        const upd = await client.query(
            'UPDATE wallets SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
            [amountCents, walletId]
        );
        if (!upd.rows.length) throw coded('insufficient_balance');
        const newBalance = Number(upd.rows[0].balance);

        const lines = await ledger.postGroup(client, {
            requestId, walletId, kind, status: 'settled', paySessionId: p.paySessionId || null,
            lines: [
                { account: ledger.walletAccount(walletId), direction: 'debit', amount: amountCents, balanceAfter: newBalance, suffix: 'wallet' },
                { account: p.counterAccount, direction: 'credit', amount: amountCents, suffix: 'counter' },
            ],
        });
        const tx = await client.query(
            `INSERT INTO transactions
               (wallet_id, merchant_id, ledger_entry_id, kind, counterparty, amount, confidence_score,
                auth_tier, distress_triggered, gps_lat, gps_lng, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed')
             RETURNING id, created_at`,
            [
                walletId, p.merchantId || null, lines[0].id, kind, p.counterparty, amountCents, p.confidence ?? null,
                p.authTier ?? null, !!p.distress, p.gps?.lat ?? null, p.gps?.lng ?? null,
            ]
        );
        await client.query('COMMIT');
        return completed({ balance_after: newBalance, tx_id: tx.rows[0].id, tx_created_at: tx.rows[0].created_at });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        if (e.code === '23505') {
            // A concurrent request with the same requestId won the race.
            const again = await findExisting(pool, requestId);
            if (again) return completed(again);
        }
        return failure(e);
    } finally {
        client.release();
    }
}

/** Recent completed outgoing amounts, for the risk advisor. */
async function recentSpend(pool, walletId) {
    const r = await pool.query(
        `SELECT amount FROM transactions
          WHERE wallet_id = $1 AND status = 'completed' AND kind IN ('payment','send')
          ORDER BY created_at DESC LIMIT 10`,
        [walletId]
    );
    return r.rows.map((x) => Number(x.amount));
}

module.exports = { debit, recentSpend };
