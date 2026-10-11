/** International phone number as digits with country code (E.164 without "+"), e.g. 14155550123. */
function validatePhone(phone) {
  return typeof phone === 'string' && /^[1-9]\d{9,14}$/.test(phone);
}

/** A PayPal account email (deliberately simple; PayPal does the real check). */
function validateEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * Parse a dollar amount (number or numeric string, up to 2 decimals) into cents.
 * Returns null when it is not a positive amount.
 */
function dollarsToCents(amount) {
  if (amount === null || amount === undefined || amount === '') return null;
  const s = String(amount).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** 4–6 digits, and not trivially guessable (all-same digits or a straight run). */
function validatePin(pin) {
  const s = String(pin ?? '');
  if (!/^\d{4,6}$/.test(s)) return { ok: false, error: 'PIN must be 4–6 digits' };
  if (/^(\d)\1+$/.test(s)) return { ok: false, error: 'PIN cannot be one repeated digit' };
  const digits = [...s].map(Number);
  const step = digits[1] - digits[0];
  if ((step === 1 || step === -1) && digits.every((d, i) => i === 0 || d - digits[i - 1] === step)) {
    return { ok: false, error: 'PIN cannot be a straight sequence like 1234' };
  }
  return { ok: true };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUUID(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

const usd = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

module.exports = { validatePhone, validateEmail, dollarsToCents, validatePin, validateUUID, usd };
