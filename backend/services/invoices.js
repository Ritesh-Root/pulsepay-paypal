/**
 * PayPal invoices a merchant creates through the AI assistant.
 *
 * Invoices are issued by PulsePay's PayPal account on the merchant's behalf (the note
 * names the shop). When PayPal reports one paid (webhook, or a status check), the
 * amount is credited to the merchant's PulsePay balance exactly once and paid out
 * like any other sale.
 */
const ledger = require('./ledger');
const payouts = require('./payouts');
const paypal = require('./paypal');

async function record(pool, { invoiceId, merchantId, recipientEmail, amountCents, status = 'DRAFT' }) {
    await pool.query(
        `INSERT INTO merchant_invoices (invoice_id, merchant_id, recipient_email, amount, status)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (invoice_id) DO NOTHING`,
        [invoiceId, merchantId, recipientEmail, amountCents, status]
    );
}

async function ownedBy(pool, invoiceId, merchantId) {
    const r = await pool.query('SELECT * FROM merchant_invoices WHERE invoice_id = $1 AND merchant_id = $2', [invoiceId, merchantId]);
    return r.rows[0] || null;
}

async function setStatus(pool, invoiceId, status) {
    await pool.query('UPDATE merchant_invoices SET status = $2 WHERE invoice_id = $1 AND credited = false', [invoiceId, status]);
}

/** Credit a paid invoice to its merchant (idempotent) and pay it out. */
async function creditIfPaid(pool, invoiceId, paidValue) {
    const inv = (await pool.query('SELECT * FROM merchant_invoices WHERE invoice_id = $1', [invoiceId])).rows[0];
    if (!inv || inv.credited || !paidValue) return false;
    const amount = paypal.toCents(paidValue);
    const c = await pool.connect();
    let credited = false;
    try {
        await c.query('BEGIN');
        const claimed = await c.query(
            `UPDATE merchant_invoices SET credited = true, status = 'PAID' WHERE invoice_id = $1 AND credited = false RETURNING merchant_id`,
            [invoiceId]
        );
        if (claimed.rows.length) {
            await ledger.postGroup(c, {
                requestId: `invoice:${invoiceId}`, kind: 'invoice', status: 'settled', externalRef: invoiceId,
                lines: [
                    { account: ledger.POOL_ACCOUNT, direction: 'debit', amount, suffix: 'pool' },
                    { account: ledger.merchantAccount(inv.merchant_id), direction: 'credit', amount, suffix: 'merchant' },
                ],
            });
            credited = true;
        }
        await c.query('COMMIT');
    } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        c.release();
    }
    if (credited && payouts.instantMode()) {
        const m = (await pool.query('SELECT * FROM merchants WHERE id = $1', [inv.merchant_id])).rows[0];
        if (m) {
            payouts.queueAndSubmit(pool, {
                merchantId: m.id, account: ledger.merchantAccount(m.id), recipientEmail: m.paypal_email,
                amountCents: amount, sourceRequest: `invoice:${invoiceId}`,
            });
        }
    }
    return credited;
}

module.exports = { record, ownedBy, setStatus, creditIfPaid };
