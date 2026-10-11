/**
 * Ledger balance tests — run with: npm test
 * No extra test-runner dependency.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assertBalanced, signedAmount, deriveBalance, walletAccount, merchantAccount, POOL_ACCOUNT } = require('../services/ledger');

describe('ledger balanced groups', () => {
    it('accepts a debit and a credit of the same amount', () => {
        assert.equal(assertBalanced([
            { direction: 'debit', amount: 50000 },
            { direction: 'credit', amount: 50000 },
        ]), true);
    });

    it('rejects a single unpaired line', () => {
        assert.throws(() => assertBalanced([{ direction: 'debit', amount: 100 }]), /at_least_two/);
    });

    it('rejects an unbalanced pair', () => {
        assert.throws(() => assertBalanced([
            { direction: 'debit', amount: 100 },
            { direction: 'credit', amount: 50 },
        ]), /unbalanced/);
    });

    it('rejects unknown directions and non-positive amounts', () => {
        assert.throws(() => signedAmount('reserve', 10), /unknown_direction/);
        assert.throws(() => signedAmount('debit', 0), /invalid_amount/);
        assert.throws(() => signedAmount('debit', 1.5), /invalid_amount/);
    });
});

describe('wallet balance is derivable from the ledger', () => {
    const W = walletAccount('w1');
    const fund = [
        { account: POOL_ACCOUNT, direction: 'debit', amount: 150000, status: 'settled' },
        { account: W, direction: 'credit', amount: 150000, status: 'settled' },
    ];
    const pay = (amount, status) => [
        { account: W, direction: 'debit', amount, status },
        { account: merchantAccount('m1'), direction: 'credit', amount, status },
    ];

    it('fund then a settled payment', () => {
        const lines = [...fund, ...pay(45000, 'settled')];
        assert.equal(deriveBalance(lines, W), 105000);
        assert.equal(deriveBalance(lines, merchantAccount('m1')), 45000);
    });

    it('a reserved payment already counts against the wallet', () => {
        assert.equal(deriveBalance([...fund, ...pay(20000, 'reserved')], W), 130000);
    });

    it('a released payment does not count', () => {
        assert.equal(deriveBalance([...fund, ...pay(20000, 'released')], W), 150000);
    });

    it('a refund empties the wallet', () => {
        const lines = [
            ...fund, ...pay(45000, 'settled'),
            { account: W, direction: 'debit', amount: 105000, status: 'settled' },
            { account: POOL_ACCOUNT, direction: 'credit', amount: 105000, status: 'settled' },
        ];
        assert.equal(deriveBalance(lines, W), 0);
    });
});
