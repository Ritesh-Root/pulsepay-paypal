let razorpay = null;

try {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID || 'test_key',
        key_secret: process.env.RAZORPAY_KEY_SECRET || 'test_secret'
    });
} catch (err) {
    console.warn('Razorpay client init skipped (test mode)');
}

async function payMerchant(merchantUpiId, amountInPaise, walletId) {
    // Simulate network latency
    await new Promise(r => setTimeout(r, 500 + Math.random() * 500));

    console.log(`[Razorpay Mock] Payout: Rs.${amountInPaise / 100} to ${merchantUpiId} (Wallet: ${walletId})`);

    return {
        id: `pay_mock_${Date.now()}`,
        entity: 'payout',
        fund_account_id: `fa_mock_${merchantUpiId.replace('@', '_')}`,
        amount: amountInPaise,
        currency: 'INR',
        status: 'processed',
        utr: `MOCK${Date.now()}`,
        mode: 'UPI',
        reference_id: walletId,
        narration: 'PulsePay payment',
        created_at: new Date().toISOString()
    };
}

module.exports = { payMerchant };
