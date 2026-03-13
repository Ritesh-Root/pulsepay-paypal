const twilio = require('twilio');

// Initialize Twilio client
const client = twilio(
    process.env.TWILIO_ACCOUNT_SID || 'test_sid',
    process.env.TWILIO_AUTH_TOKEN || 'test_token'
);

const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER || '+1234567890';

/**
 * Send SMS to a phone number
 * @param {string} to - Recipient phone number
 * @param {string} message - Message to send
 * @returns {Promise<Object>} - SMS result
 */
async function sendSMS(to, message) {
    try {
        console.log(`Mock SMS to ${to}: ${message}`);

        // In production with valid Twilio credentials:
        // const result = await client.messages.create({
        //     body: message,
        //     from: TWILIO_PHONE,
        //     to: to
        // });

        return {
            success: true,
            message_id: `msg_mock_${Date.now()}`,
            to,
            status: 'sent'
        };
    } catch (error) {
        console.error('Twilio SMS error:', error);
        throw error;
    }
}

/**
 * Send SOS alert with GPS location
 * @param {string} emergencyContact - Emergency contact phone number
 * @param {string} userName - User's phone number
 * @param {number} gpsLat - GPS latitude
 * @param {number} gpsLng - GPS longitude
 * @returns {Promise<Object>} - SOS result
 */
async function sendSOS(emergencyContact, userName, gpsLat, gpsLng) {
    try {
        const googleMapsLink = `https://www.google.com/maps?q=${gpsLat},${gpsLng}`;
        const message = `🚨 PULSEPAY DISTRESS ALERT 🚨\n\nUser ${userName} triggered emergency payment mode.\n\nLocation: ${googleMapsLink}\n\nThis is an automated alert. Please check on them immediately.`;

        console.log(`Mock SOS to ${emergencyContact}: ${message}`);

        // In production with valid Twilio credentials:
        // const result = await client.messages.create({
        //     body: message,
        //     from: TWILIO_PHONE,
        //     to: emergencyContact
        // });

        return {
            success: true,
            message_id: `sos_mock_${Date.now()}`,
            to: emergencyContact,
            status: 'sent',
            location: googleMapsLink
        };
    } catch (error) {
        console.error('Twilio SOS error:', error);
        throw error;
    }
}

module.exports = {
    sendSMS,
    sendSOS
};
