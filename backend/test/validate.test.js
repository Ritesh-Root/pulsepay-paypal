const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePin, dollarsToCents, validateEmail, validatePhone } = require('../middleware/validate');

test('PIN must be 4-6 digits and not trivially guessable', () => {
    assert.equal(validatePin('4827').ok, true);
    assert.equal(validatePin('905172').ok, true);
    assert.equal(validatePin('123').ok, false);
    assert.equal(validatePin('1234').ok, false);
    assert.equal(validatePin('9876').ok, false);
    assert.equal(validatePin('0000').ok, false);
    assert.equal(validatePin('12a4').ok, false);
});

test('dollar amounts parse to integer cents', () => {
    assert.equal(dollarsToCents('45'), 4500);
    assert.equal(dollarsToCents(12.5), 1250);
    assert.equal(dollarsToCents('0.01'), 1);
    assert.equal(dollarsToCents('0'), null);
    assert.equal(dollarsToCents('-5'), null);
    assert.equal(dollarsToCents('1.234'), null);
    assert.equal(dollarsToCents('1e5'), null);
    assert.equal(dollarsToCents(''), null);
});

test('PayPal emails', () => {
    assert.equal(validateEmail('shop-owner@personal.example.com'), true);
    assert.equal(validateEmail('no-at-sign'), false);
    assert.equal(validateEmail('a@b'), false);
    assert.equal(validateEmail('a b@c.com'), false);
});

test('international phone numbers with country code', () => {
    assert.equal(validatePhone('14155550123'), true);   // US
    assert.equal(validatePhone('447700900123'), true);  // UK
    assert.equal(validatePhone('919876543210'), true);  // India
    assert.equal(validatePhone('0123456789'), false);   // no country code
    assert.equal(validatePhone('12345'), false);
    assert.equal(validatePhone('+14155550123'), false); // digits only
});
