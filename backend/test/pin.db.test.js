// Card-style PIN lockout (services/pin.js): 3 wrong PINs lock it for 30 minutes.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { skip, freshDatabase } = require('./support/db');
const f = require('./support/fixtures');
const pin = require('../services/pin');

describe('PIN lockout', { skip }, () => {
    let db, pool;
    before(async () => { db = await freshDatabase(); pool = db.pool; });
    after(() => db.close());

    it('counts down the attempts left', async () => {
        const u = await f.customer(pool);
        assert.deepEqual(await pin.checkPin(pool, u.id, '1111'), { ok: false, locked: false, attempts_left: 2 });
        assert.deepEqual(await pin.checkPin(pool, u.id, '1111'), { ok: false, locked: false, attempts_left: 1 });
    });

    it('locks after the third wrong PIN and then refuses even the right one', async () => {
        const u = await f.customer(pool);
        for (let i = 0; i < 2; i++) await pin.checkPin(pool, u.id, '1111');

        const third = await pin.checkPin(pool, u.id, '1111');
        assert.equal(third.locked, true);
        const lockedFor = new Date(third.locked_until) - Date.now();
        assert.ok(lockedFor > 29 * 60e3 && lockedFor <= 30 * 60e3, `locked for ${lockedFor} ms`);

        const right = await pin.checkPin(pool, u.id, f.PIN);
        assert.equal(right.ok, false);
        assert.equal(right.locked, true);
    });

    it('unlocks when the lock has expired', async () => {
        const u = await f.customer(pool);
        await pool.query(`UPDATE users SET pin_locked_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [u.id]);
        assert.deepEqual(await pin.checkPin(pool, u.id, f.PIN), { ok: true });
    });

    it('resets the count after a correct PIN', async () => {
        const u = await f.customer(pool);
        await pin.checkPin(pool, u.id, '1111');
        await pin.checkPin(pool, u.id, '1111');
        assert.deepEqual(await pin.checkPin(pool, u.id, f.PIN), { ok: true });

        assert.equal((await pin.checkPin(pool, u.id, '1111')).attempts_left, 2);
    });

    it('cannot be brute-forced by guessing in parallel', async () => {
        const u = await f.customer(pool);
        const guesses = await Promise.all(['0000', '1111', '2222', '3333', '4444', '5555'].map((g) => pin.checkPin(pool, u.id, g)));

        assert.equal(guesses.filter((g) => g.locked).length >= 1, true);
        const row = (await pool.query('SELECT pin_locked_until FROM users WHERE id = $1', [u.id])).rows[0];
        assert.ok(new Date(row.pin_locked_until) > new Date());
        assert.equal((await pin.checkPin(pool, u.id, f.PIN)).ok, false);
    });
});
