const Razorpay = require('razorpay');

// Initialize Razorpay instance
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'test_key',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'test_secret'
});

/**
 * Pay merchant via Razorpay Payouts API
 * @param {string} merchantUpiId - Merchant's UPI ID
 * @param {number} amountInPaise - Amount in paise
 * @param {string} walletId - Wallet ID for reference
 * @returns {Promise<Object>} - Payout result
 */
async function payMerchant(merchantUpiId, amountInPaise, walletId) {
    try {
        // In test mode, we'll mock the payout
        console.log(`Mock Razorpay Payout: Rs.${amountInPaise / 100} to ${merchantUpiId} (Wallet: ${walletId})`);

        // In production, you would use:
        // const payout = await razorpay.payouts.create({
        //     account_number: process.env.RAZORPAY_ACCOUNT_NUMBER,
        //     fund_account_id: merchantFundAccountId,
        //     amount: amountInPaise,
        //     currency: 'INR',
        //     mode: 'UPI',
        //     purpose: 'payout',
        //     queue_if_low_balance: false,
        //     reference_id: walletId,
        //     narration: 'PulsePay payment'
        // });

        return {
            success: true,
            payout_id: `payout_mock_${Date.now()}`,
            amount: amountInPaise,
            status: 'processed'
        };
    } catch (error) {
        console.error('Razorpay payout error:', error);
        throw error;
    }
}

module.exports = {
    payMerchant
};
