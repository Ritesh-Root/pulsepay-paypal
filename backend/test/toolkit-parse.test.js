// The PayPal Agent Toolkit (v1.11, Bedrock adapter) returns its results as text. Live
// sandbox runs showed the JSON is encoded twice: the text is a JSON string that holds
// the invoice JSON. The assistant must read the invoice either way.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseToolkitText } = require('../services/assistant');

const invoice = { id: 'INV2-WWD6-K8CV-HRE6-RERJ', status: 'SENT', amount: { currency_code: 'USD', value: '9.00' } };

describe('reading Agent Toolkit results', () => {
    it('reads JSON encoded twice (what get_invoice returns)', () => {
        const text = JSON.stringify(JSON.stringify(invoice));
        assert.deepEqual(parseToolkitText(text), invoice);
    });

    it('reads plain JSON', () => {
        assert.deepEqual(parseToolkitText(JSON.stringify(invoice)), invoice);
    });

    it('keeps non-JSON results (the QR code comes back as a multipart body) as raw text', () => {
        const multipart = '--509dbc9e\r\nContent-Disposition: form-data; name="image"\r\nContent-Type: text/plain\r\n\r\niVBORw0KGgoAAAANSUhEUgAA\r\n--509dbc9e--';
        assert.deepEqual(parseToolkitText(JSON.stringify(multipart)), { raw: multipart });
        assert.deepEqual(parseToolkitText('not json'), { raw: 'not json' });
    });

    it('treats an empty result as an empty object', () => {
        assert.deepEqual(parseToolkitText(''), {});
        assert.deepEqual(parseToolkitText(undefined), {});
    });
});
