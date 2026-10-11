/**
 * PIN verification with a card-style lockout.
 *
 * After PIN_MAX_ATTEMPTS consecutive wrong PINs the account is locked for
 * PIN_LOCK_MINUTES; while locked the PIN is not even compared, so it cannot be
 * brute-forced from a merchant device. A correct PIN resets the counter.
 */
const bcrypt = require('bcryptjs');

const MAX_ATTEMPTS = Number(process.env.PIN_MAX_ATTEMPTS || 3);
const LOCK_MINUTES = Number(process.env.PIN_LOCK_MINUTES || 30);

async function hashPin(pin) {
    return bcrypt.hash(String(pin), 10);
}

/**
 * Returns { ok:true } or { ok:false, locked:boolean, attempts_left:number, locked_until? }.
 * `db` may be a pool or a client inside a transaction.
 */
async function checkPin(db, userId, pin) {
    const r = await db.query(
        'SELECT pin_hash, pin_locked_until FROM users WHERE id = $1', [userId]
    );
    const row = r.rows[0];
    if (!row || !row.pin_hash) return { ok: false, locked: false, attempts_left: 0 };
    if (row.pin_locked_until && new Date(row.pin_locked_until) > new Date()) {
        return { ok: false, locked: true, attempts_left: 0, locked_until: row.pin_locked_until };
    }

    const match = await bcrypt.compare(String(pin ?? ''), row.pin_hash);
    if (match) {
        await db.query(
            'UPDATE users SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1', [userId]
        );
        return { ok: true };
    }

    // Atomic increment; lock (and reset the counter) once the limit is reached.
    const upd = await db.query(
        `UPDATE users
            SET pin_failed_attempts = CASE WHEN pin_failed_attempts + 1 >= $2 THEN 0 ELSE pin_failed_attempts + 1 END,
                pin_locked_until   = CASE WHEN pin_failed_attempts + 1 >= $2
                                          THEN NOW() + make_interval(mins => $3::int) ELSE pin_locked_until END
          WHERE id = $1
          RETURNING pin_failed_attempts, pin_locked_until`,
        [userId, MAX_ATTEMPTS, LOCK_MINUTES]
    );
    const u = upd.rows[0];
    const locked = !!(u.pin_locked_until && new Date(u.pin_locked_until) > new Date());
    return {
        ok: false,
        locked,
        attempts_left: locked ? 0 : MAX_ATTEMPTS - u.pin_failed_attempts,
        ...(locked ? { locked_until: u.pin_locked_until } : {}),
    };
}

/** Standard HTTP response for a failed PIN check. */
function pinFailure(res, result) {
    if (result.locked) {
        return res.status(423).json({
            error: `Too many wrong PINs. PIN locked for ${LOCK_MINUTES} minutes.`,
            locked: true,
        });
    }
    return res.status(401).json({ error: 'Incorrect PIN', attempts_left: result.attempts_left });
}

module.exports = { hashPin, checkPin, pinFailure, MAX_ATTEMPTS, LOCK_MINUTES };
