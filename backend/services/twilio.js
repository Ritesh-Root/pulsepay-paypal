// Demo SMS transport: logs instead of sending. Production: a real SMS gateway (e.g. Twilio).
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER || '+15550000000';

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

async function sendSOS(emergencyContact, userName, gpsLat, gpsLng, place, reason = 'used their distress finger to pay') {
    const hasGps = gpsLat != null && gpsLng != null && !(Number(gpsLat) === 0 && Number(gpsLng) === 0);
    const mapLink = hasGps ? `https://www.google.com/maps?q=${gpsLat},${gpsLng}` : null;
    const where = [place ? `At: ${place}` : null, mapLink ? `Location: ${mapLink}` : 'Location: not available']
        .filter(Boolean).join('\n');
    const message = `PULSEPAY DISTRESS ALERT\n\n${userName} ${reason}.\n\n${where}\n\nThis is an automated alert. Please check on them immediately.`;

    await new Promise(r => setTimeout(r, 300));

    console.log(`[SOS Mock] To: ${emergencyContact} | ${message}`);

    return {
        sid: `SM_sos_mock_${Date.now()}`,
        status: 'sent',
        to: emergencyContact,
        from: TWILIO_PHONE,
        body: message,
        dateCreated: new Date().toISOString(),
        location: mapLink,
    };
}

module.exports = { sendSMS, sendSOS };
