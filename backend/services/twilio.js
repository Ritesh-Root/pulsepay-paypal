let client = null;

try {
    const twilio = require('twilio');
    client = twilio(
        process.env.TWILIO_ACCOUNT_SID || 'test_sid',
        process.env.TWILIO_AUTH_TOKEN || 'test_token'
    );
} catch (err) {
    console.warn('Twilio client init skipped (test mode)');
}

const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER || '+1234567890';

async function sendSMS(to, message) {
    await new Promise(r => setTimeout(r, 300));

    console.log(`[SMS Mock] To: ${to} | Message: ${message}`);

    return {
        sid: `SM_mock_${Date.now()}`,
        status: 'sent',
        to,
        from: TWILIO_PHONE,
        body: message,
        dateCreated: new Date().toISOString(),
        direction: 'outbound-api'
    };
}

async function sendSOS(emergencyContact, userName, gpsLat, gpsLng) {
    const googleMapsLink = `https://www.google.com/maps?q=${gpsLat},${gpsLng}`;
    const message = `PULSEPAY DISTRESS ALERT\n\nUser ${userName} triggered emergency payment mode.\n\nLocation: ${googleMapsLink}\n\nThis is an automated alert. Please check on them immediately.`;

    await new Promise(r => setTimeout(r, 300));

    console.log(`[SOS Mock] To: ${emergencyContact} | ${message}`);

    return {
        sid: `SM_sos_mock_${Date.now()}`,
        status: 'sent',
        to: emergencyContact,
        from: TWILIO_PHONE,
        body: message,
        dateCreated: new Date().toISOString(),
        location: googleMapsLink
    };
}

module.exports = { sendSMS, sendSOS };
