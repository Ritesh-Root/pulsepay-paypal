const test = require('node:test');
const assert = require('node:assert');
const { strictest, localScore, assess } = require('../services/risk');

test('the advisor can escalate allow -> decline', () => {
    assert.equal(strictest('allow', 'decline'), 'decline');
});

test('the advisor can never relax a decline', () => {
    assert.equal(strictest('decline', 'allow'), 'decline');
});

test('an unknown advice never weakens the floor', () => {
    assert.equal(strictest('allow', 'skip_pin'), 'allow');
});

test('local heuristic flags a large break from history but stays display-only', () => {
    const routine = localScore({ amountCents: 2000, hour: 12, spendingHistory: [2000, 2500] });
    const spike = localScore({ amountCents: 20000, hour: 23, spendingHistory: [2000, 2500] });
    assert.ok(spike > routine);
});

test('without an advisor key the decision falls back to the allow floor', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
        const r = await assess({ amountCents: 9000, now: new Date(), spendingHistory: [1000] });
        assert.equal(r.decision, 'allow');
        assert.equal(r.source, 'fallback');
        assert.equal(typeof r.fraud_risk_score, 'number');
    } finally {
        if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
});
