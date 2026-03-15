function validatePhone(phone) {
  return typeof phone === 'string' && /^[6-9]\d{9}$/.test(phone);
}

function validateOTP(otp) {
  return typeof otp === 'string' && /^\d{6}$/.test(otp);
}

function validateAmount(amount) {
  const num = Number(amount);
  return !isNaN(num) && num > 0 && num <= 200000;
}

function validateUPI(upi) {
  return typeof upi === 'string' && /^[\w.\-]+@[\w]+$/.test(upi);
}

function validateUUID(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

module.exports = { validatePhone, validateOTP, validateAmount, validateUPI, validateUUID };
