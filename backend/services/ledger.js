/**
 * Double-entry ledger.
 *
 * Every money movement is a request_id group of lines posted to named accounts.
 * A group is balanced: total debits == total credits.
 *
 *   wallet:<id>        the customer's wallet (a liability: credit raises it, debit lowers it)
 *   pool:paypal        PulsePay's PayPal balance (an asset: debit raises it)
 *   merchant:<id>      what PulsePay owes a merchant until it is paid out (liability)
 *   payee:<email>      what PulsePay owes someone a customer sent money to (liability)
 *
 *   fund             debit pool             / credit wallet           (PayPal capture)
 *   payment          debit wallet           / credit merchant:<id>    (biometric pay at a shop)
 *   send             debit wallet           / credit payee:<email>    (own-phone send)
 *   payout           debit merchant / payee / credit pool             (PayPal Payout succeeded)
 *   merchant_refund  debit merchant:<id>    / credit wallet           (merchant refunds a payment)
 *   invoice          debit pool             / credit merchant:<id>    (PayPal invoice paid)
 *   refund           debit wallet           / credit pool             (wallet closed, capture refunded)
 *
 * Lines move together through reserved -> settled (or released). Released lines
 * no longer count, so every balance is derivable from the ledger.
 */

const DIRECTIONS = new Set(['debit', 'credit']);
const COUNTED = new Set(['reserved', 'settled', 'pending']);

function walletAccount(walletId) { return `wallet:${walletId}`; }
function merchantAccount(merchantId) { return `merchant:${merchantId}`; }
function payeeAccount(email) { return `payee:${String(email).toLowerCase()}`; }
const POOL_ACCOUNT = 'pool:paypal';

function signedAmount(direction, amount) {
    if (!DIRECTIONS.has(direction)) throw new Error(`unknown_direction:${direction}`);
    const n = Number(amount);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`invalid_amount:${amount}`);
    return direction === 'debit' ? n : -n;
}

/** Throws unless the lines form a balanced group of at least two lines. */
function assertBalanced(lines) {
    if (!Array.isArray(lines) || lines.length < 2) {
        throw new Error('ledger_group_needs_at_least_two_lines');
    }
    let sum = 0;
    for (const line of lines) sum += signedAmount(line.direction, line.amount);
    if (sum !== 0) throw new Error(`unbalanced_ledger_group:sum=${sum}`);
    return true;
}

/** Balance of a liability account (wallet, merchant, payee) from its ledger lines. Pure. */
function deriveBalance(lines, account) {
    let bal = 0;
    for (const l of lines) {
        if (l.account !== account || !COUNTED.has(l.status)) continue;
        bal += l.direction === 'credit' ? Number(l.amount) : -Number(l.amount);
    }
    return bal;
}

/**
 * Insert one balanced group inside the caller's transaction.
 * lines: [{ account, direction, amount, balanceAfter?, suffix }]
 * Each line's idempotency key is `${requestId}:${suffix}`. Returns inserted rows.
 */
async function postGroup(client, { requestId, walletId = null, kind, status, lines, externalRef = null, paySessionId = null }) {
    assertBalanced(lines);
    const rows = [];
    for (const line of lines) {
        const r = await client.query(
            `INSERT INTO ledger_entries
               (wallet_id, request_id, account, direction, kind, amount, balance_after,
                idempotency_key, pay_session_id, external_ref, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
            [
                walletId, requestId, line.account, line.direction, kind, line.amount,
                line.balanceAfter ?? null, `${requestId}:${line.suffix}`, paySessionId, externalRef, status,
            ]
        );
        rows.push({ ...line, id: r.rows[0].id });
    }
    return rows;
}

/** SQL expression for a liability account's balance (credits - debits, non-released). */
const BALANCE_SQL = `COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount ELSE -amount END)
                      FILTER (WHERE status <> 'released'), 0)`;

module.exports = {
    assertBalanced, signedAmount, deriveBalance, postGroup,
    walletAccount, merchantAccount, payeeAccount, POOL_ACCOUNT, BALANCE_SQL,
};
