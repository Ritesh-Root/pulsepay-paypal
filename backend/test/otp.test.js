// One-time codes (services/otp.js). In-memory, no database.
delete process.env.DEMO_SHOW_OTP;

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const otp = require('../services/otp');

let n = 0;
const phone = () => `1415555${String(++n).padStart(4, '0')}`;
const message = (code) => `PulsePay code ${code}`;

async function issued(purpose, p) {
    process.env.DEMO_SHOW_OTP = 'true';
    try { return await otp.issue({ purpose, phone: p, message }); } finally { delete process.env.DEMO_SHOW_OTP; }
}
const wrong = (code) => String((Number(code) + 1) % 1e6).padStart(6, '0');

describe('one-time codes', () => {
    beforeEach(() => { delete process.env.DEMO_SHOW_OTP; });

    it('verifies the code that was sent, once', async () => {
        const p = phone();
        const { demo_otp } = await issued('enrol', p);

        assert.equal(otp.verify({ purpose: 'enrol', phone: p, otp: demo_otp }).ok, true);
        assert.deepEqual(otp.verify({ purpose: 'enrol', phone: p, otp: demo_otp }), { ok: false, reason: 'otp_expired' });
    });

    it('does not accept a code sent for a different purpose', async () => {
        const p = phone();
        const { demo_otp } = await issued('merchant', p);

        assert.equal(otp.verify({ purpose: 'enrol', phone: p, otp: demo_otp }).ok, false);
        assert.equal(otp.verify({ purpose: 'merchant', phone: p, otp: demo_otp }).ok, true);
    });

    it('destroys the code after five wrong guesses', async () => {
        const p = phone();
        const { demo_otp } = await issued('enrol', p);
        const reasons = [];
        for (let i = 0; i < 5; i++) reasons.push(otp.check({ purpose: 'enrol', phone: p, otp: wrong(demo_otp) }).reason);

        assert.deepEqual(reasons, ['otp_incorrect', 'otp_incorrect', 'otp_incorrect', 'otp_incorrect', 'otp_attempts_exceeded']);
        assert.equal(otp.verify({ purpose: 'enrol', phone: p, otp: demo_otp }).ok, false);
    });

    it('stops issuing codes after three in ten minutes', async () => {
        const p = phone();
        for (let i = 0; i < 3; i++) assert.equal((await otp.issue({ purpose: 'enrol', phone: p, message })).ok, true);

        assert.deepEqual(await otp.issue({ purpose: 'enrol', phone: p, message }), { ok: false, error: 'otp_rate_limited' });
    });

    it('only puts the code in the response in demo mode', async () => {
        const off = await otp.issue({ purpose: 'enrol', phone: phone(), message });
        const on = await issued('enrol', phone());

        assert.equal('demo_otp' in off, false);
        assert.match(on.demo_otp, /^\d{6}$/);
    });
});
