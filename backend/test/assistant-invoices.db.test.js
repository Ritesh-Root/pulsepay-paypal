// The assistant's invoice tools, with the PayPal Agent Toolkit replaced by a stand-in that
// answers the way the real one did against the live sandbox: JSON encoded twice.
process.env.PAYPAL_CLIENT_ID = 'test-client';
process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
process.env.PAYPAL_ENVIRONMENT = 'sandbox';
process.env.PAYOUT_MODE = 'manual';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-0123456789';
process.env.KMS_DATA_KEY = process.env.KMS_DATA_KEY || 'b'.repeat(64);

const replies = {};
const toolkitPath = require.resolve('@paypal/agent-toolkit/bedrock');
require.cache[toolkitPath] = {
    id: toolkitPath, filename: toolkitPath, loaded: true,
    exports: {
        PayPalAgentToolkit: class {
            async handleToolCall({ name, input }) { return { content: [{ text: replies[name](input) }] }; }
        },
    },
};

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { skip, freshDatabase } = require('./support/db');
const f = require('./support/fixtures');
const assistant = require('../services/assistant');
const invoices = require('../services/invoices');
const payouts = require('../services/payouts');
const ledger = require('../services/ledger');

/** What the toolkit's get_invoice returned live: the invoice JSON inside a JSON string. */
const encodedTwice = (invoice) => JSON.stringify(JSON.stringify(invoice));

describe('assistant invoice status', { skip }, () => {
    let db, pool;
    before(async () => { db = await freshDatabase(); pool = db.pool; });
    after(async () => { await db.close(); });

    async function shopWithInvoice() {
        const merchant = await f.merchant(pool);
        const invoiceId = `INV2-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
        await invoices.record(pool, { invoiceId, merchantId: merchant.id, recipientEmail: 'sam@example.com', amountCents: 900, status: 'SENT' });
        return { merchant, invoiceId };
    }
    const owed = async (merchant) => (await payouts.available(pool, ledger.merchantAccount(merchant.id))).available;
    const status = (invoiceId, merchant) => assistant.runTool('invoice_status', { invoice_id: invoiceId }, { pool, merchant, actions: [] });

    it('reads the status PayPal reports', async () => {
        const { merchant, invoiceId } = await shopWithInvoice();
        replies.get_invoice = () => encodedTwice({ id: invoiceId, status: 'SENT', amount: { currency_code: 'USD', value: '9.00' } });
        const out = await status(invoiceId, merchant);
        assert.equal(out.status, 'SENT');
        assert.equal(out.amount, '9.00');
        assert.equal(await owed(merchant), 0);
    });

    it('credits the shop once when PayPal collected the money', async () => {
        const { merchant, invoiceId } = await shopWithInvoice();
        replies.get_invoice = () => encodedTwice({
            id: invoiceId, status: 'PAID', amount: { currency_code: 'USD', value: '9.00' },
            payments: { paid_amount: { currency_code: 'USD', value: '9.00' } },
        });
        assert.equal((await status(invoiceId, merchant)).status, 'PAID');
        assert.equal(await owed(merchant), 900);
        await status(invoiceId, merchant);
        assert.equal(await owed(merchant), 900, 'asking again does not credit twice');
    });

    it('does not credit an invoice marked paid outside PayPal', async () => {
        const { merchant, invoiceId } = await shopWithInvoice();
        replies.get_invoice = () => encodedTwice({ id: invoiceId, status: 'MARKED_AS_PAID', amount: { currency_code: 'USD', value: '9.00' } });
        assert.equal((await status(invoiceId, merchant)).status, 'MARKED_AS_PAID');
        assert.equal(await owed(merchant), 0, 'no money reached PulsePay, so nothing is owed');
    });
});
