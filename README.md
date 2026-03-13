# PulsePay — Your Body Is Your Wallet

**Biometric micro-wallet for emergency phone-less payments in India**

PulsePay is a complete hackathon build featuring enrollment, merchant PWA, CV service, adaptive authentication, distress mode, family wallet delegation, and a dashboard.

## Features

### 🔐 Adaptive Authentication
- **Face Only**: For amounts under ₹200
- **Face + Fingerprint**: For amounts ₹200-1000
- **Face + Fingerprint + OTP**: For amounts above ₹1000

### 🚨 Distress Mode
- Use your pinky finger instead of index to trigger emergency payment
- Automatically sends SOS SMS to emergency contact with GPS coordinates
- Payment completes normally while alerting your contacts

### 👨‍👩‍👧 Family Wallet
- Add family members as delegates with spending caps
- Each delegate uses their own biometrics
- Parent wallet controls all spending limits

### ⏱️ 72-Hour Auto-Expiry
- Wallet automatically expires after 72 hours
- Unused funds automatically refunded
- Can extend by another 72 hours before expiry

### 🔄 Biometric Key Rotation
- Regenerate wallet hash with new salt
- Invalidates old biometric signatures
- Maintains security over time

### 🎯 Zero-Knowledge Biometrics
- Face and fingerprint never stored as images
- Only cryptographic hashes stored in database
- Liveness detection prevents photo attacks

## Project Structure

```
/frontend          - Next.js 14 App Router + Tailwind CSS + TypeScript
/backend           - Node.js + Express API
/cv-service        - Python FastAPI for biometric hashing
/database          - PostgreSQL schema
```

## Setup Instructions

### Prerequisites
- Docker and Docker Compose
- OR: Node.js 18+, Python 3.11+, PostgreSQL 15+

### Quick Start with Docker

1. **Clone the repository**
```bash
git clone <repository-url>
cd Nova-hackathon
```

2. **Copy environment files**
```bash
cp backend/.env.example backend/.env
cp cv-service/.env.example cv-service/.env
```

3. **Configure API keys** (Optional - works with test mode)

Edit `backend/.env` with your keys:
```env
RAZORPAY_KEY_ID=your_razorpay_key
RAZORPAY_KEY_SECRET=your_razorpay_secret
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=your_twilio_number
```

4. **Start all services**
```bash
docker-compose up --build
```

5. **Visit the application**
- Frontend: http://localhost:3000
- Backend API: http://localhost:5000
- CV Service: http://localhost:8000
- Database: localhost:5432

### Manual Setup (Without Docker)

#### 1. Database Setup
```bash
# Start PostgreSQL
createdb pulsepay
psql pulsepay < database/schema.sql
```

#### 2. Backend Setup
```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your database URL
npm start
```

#### 3. CV Service Setup
```bash
cd cv-service
pip install -r requirements.txt
cp .env.example .env
python main.py
```

#### 4. Frontend Setup
```bash
cd frontend
npm install
npm run dev
```

## Demo Flow

### For Users (Enrollment)
1. Visit http://localhost:3000
2. Click "Set Up My Wallet"
3. Enter phone number and mock OTP (any 6 digits)
4. Complete face liveness check
5. Scan index finger (payment) and pinky finger (distress)
6. Fund wallet with ₹1000-2000
7. Receive wallet ID and access dashboard

### For Merchants (Payment)
1. Visit http://localhost:3000/merchant
2. Enter payment amount in rupees
3. System shows required authentication tier
4. Scan customer's face (and fingerprint if needed)
5. View identity confidence score
6. Process payment
7. Show success confirmation

### Dashboard Features
- View wallet balance and expiry countdown
- See transaction history
- Extend wallet by 72 hours
- Refund remaining balance
- Add family delegates with spending caps

## Technology Stack

### Frontend
- Next.js 14 with App Router
- TypeScript
- Tailwind CSS
- Camera API for biometric capture

### Backend
- Express.js
- PostgreSQL with pg driver
- Razorpay for payments (test mode)
- Twilio for SMS (test mode)
- JWT for authentication
- bcryptjs for password hashing

### CV Service
- FastAPI
- DeepFace for face embeddings
- OpenCV for fingerprint processing
- SHA3-256 for cryptographic hashing

### Database
- PostgreSQL 15
- UUID primary keys
- Indexed queries for performance
- Transaction support

## API Endpoints

### Enrollment
- `POST /api/enroll/verify-aadhaar` - Mock Aadhaar verification
- `POST /api/enroll/verify-otp` - Verify OTP
- `POST /api/enroll/create-wallet` - Create new wallet

### Payment
- `POST /api/payment/authenticate` - Authenticate biometrics
- `POST /api/payment/execute` - Execute payment
- `POST /api/payment/distress` - Execute distress payment

### Wallet Management
- `GET /api/wallet/:wallet_id` - Get wallet details
- `POST /api/wallet/refund` - Refund and close wallet
- `POST /api/wallet/extend` - Extend expiry
- `POST /api/wallet/rotate-salt` - Rotate biometric key

### Family Delegation
- `POST /api/family/add-delegate` - Add family member
- `GET /api/family/delegates/:parent_wallet_id` - List delegates

### CV Service
- `POST /hash-face` - Generate face hash
- `POST /hash-fingerprint` - Generate fingerprint hash
- `POST /liveness-check` - Verify face liveness

## Security Considerations

### What's Secure
✅ Biometrics stored as cryptographic hashes only
✅ Liveness detection prevents photo attacks
✅ Adaptive authentication based on amount
✅ Transaction logging with GPS
✅ Auto-expiry prevents long-term exposure
✅ Distress mode for emergency situations

### Demo Limitations
⚠️ Mock Aadhaar verification (real UIDAI integration needed)
⚠️ Razorpay and Twilio in test mode
⚠️ Camera-based fingerprint (real sensor recommended)
⚠️ Self-signed biometric hashes (HSM recommended for production)

## Contributing

This is a hackathon prototype built for demonstration purposes. For production use:
- Integrate real UIDAI Aadhaar verification
- Use hardware biometric sensors
- Implement HSM for cryptographic operations
- Add comprehensive audit logging
- Implement rate limiting and DDoS protection
- Add end-to-end encryption for sensitive data

## License

MIT License - Built for Nova Hackathon

## Acknowledgments

Built following the complete specification in PLAN.md covering enrollment, merchant PWA, CV service, adaptive authentication, distress mode, family wallet, and dashboard functionality.
