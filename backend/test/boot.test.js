// Start-up checks (services/boot.js): the server refuses to start in unsafe configurations.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { bootProblems } = require('../services/boot');

const base = { JWT_SECRET: 'x'.repeat(32), DATABASE_URL: 'postgres://db/pulsepay' };
const livePayPal = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ENVIRONMENT: 'live' };
const sandboxPayPal = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_ENVIRONMENT: 'sandbox' };

describe('start-up checks', () => {
    it('accept a normal configuration', () => {
        assert.deepEqual(bootProblems({ ...base, NODE_ENV: 'production', ...livePayPal }), []);
    });

    it('refuse a missing or short JWT secret', () => {
        assert.equal(bootProblems({ ...base, JWT_SECRET: undefined }).length, 1);
        assert.equal(bootProblems({ ...base, JWT_SECRET: 'short' }).length, 1);
    });

    it('refuse demo sign-in when PayPal moves real money', () => {
        const problems = bootProblems({ ...base, ...livePayPal, DEMO_MODE: 'true' });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /DEMO_MODE/);
    });

    it('refuse showing one-time codes when PayPal moves real money', () => {
        const problems = bootProblems({ ...base, ...livePayPal, DEMO_SHOW_OTP: 'true' });
        assert.equal(problems.length, 1);
        assert.match(problems[0], /DEMO_SHOW_OTP/);
    });

    it('allow a hosted demo on PayPal sandbox or simulated PayPal', () => {
        const demo = { DEMO_MODE: 'true', DEMO_SHOW_OTP: 'true', NODE_ENV: 'production' };
        assert.deepEqual(bootProblems({ ...base, ...sandboxPayPal, ...demo }), []);
        assert.deepEqual(bootProblems({ ...base, ...demo }), []);
    });
});
