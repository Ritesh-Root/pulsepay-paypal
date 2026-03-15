# PulsePay — Your Body Is Your Wallet

**Biometric micro-wallet for emergency phone-less payments in India, powered by Amazon Nova AI**

PulsePay enables phone-less payments using only your body — face recognition, fingerprint authentication, and voice confirmations — all powered by Amazon Nova foundation models on AWS. Designed for India's unbanked population and emergency scenarios where you don't have your phone.

#AmazonNova

---

## Amazon Nova Integration

PulsePay leverages **three Amazon Nova foundation models** across multiple hackathon categories:

### 1. Nova Multimodal Embeddings — Biometric Hashing (Multimodal Understanding)
- Replaces traditional face embedding models with **Amazon Nova Multimodal Embeddings** via AWS Bedrock
- Generates high-dimensional vectors from facial images for zero-knowledge biometric matching
- Embeddings are SHA3-256 hashed — raw biometrics are never stored
- Powers the core identity verification pipeline for enrollment and payment authentication

### 2. Nova 2 Lite — Smart Auth Agent (Agentic AI)
- Upgrades static authentication tiers to **AI-driven dynamic risk scoring**
- Nova 2 Lite analyzes transaction context in real-time: amount, merchant location, time of day, user spending patterns
- Dynamically decides which authentication tier is required (face only, face+fingerprint, face+fingerprint+OTP)
- Acts as an intelligent security agent that adapts to each transaction's risk profile

### 3. Nova 2 Sonic — Merchant Voice Confirmations (Voice AI)
- Provides **real-time conversational voice confirmations** on the merchant PWA
- After successful payment, Nova 2 Sonic generates natural speech: *"Payment of 200 rupees from Ritesh received successfully"*
- Critical for a phone-less payment system where the merchant needs audible confirmation
- Supports multilingual voice output for India's diverse merchant base

---

## Features

### Adaptive Authentication (Nova 2 Lite Powered)
- **Face Only**: Low-risk transactions under ₹200
- **Face + Fingerprint**: Medium-risk transactions ₹200-1000
- **Face + Fingerprint + OTP**: High-risk transactions above ₹1000
- Risk scoring dynamically adjusts tiers based on real-time context via Nova 2 Lite

### Distress Mode
- Use your pinky finger instead of index to trigger emergency payment
- Automatically sends SOS SMS to emergency contact with GPS coordinates
- Payment completes normally while alerting your contacts

### Family Wallet
- Add family members as delegates with spending caps
- Each delegate uses their own biometrics
- Parent wallet controls all spending limits

### 72-Hour Auto-Expiry
- Wallet automatically expires after 72 hours
- Unused funds automatically refunded
- Can extend by another 72 hours before expiry

### Biometric Key Rotation
- Regenerate wallet hash with new salt
- Invalidates old biometric signatures
- Maintains security over time

### Zero-Knowledge Biometrics
- Face and fingerprint never stored as images
- Only cryptographic hashes (via Nova embeddings + SHA3-256) stored in database
- Liveness detection prevents photo attacks

### Voice-Confirmed Payments
- Nova 2 Sonic generates real-time voice confirmations for merchants
- Natural, conversational speech confirms transaction details
- Hands-free confirmation ideal for busy merchant environments

---

## Architecture

```
                        ┌─────────────────────────────────────┐
                        │           AWS Bedrock               │
                        │  ┌───────────┐  ┌───────────────┐   │
                        │  │ Nova 2    │  │ Nova          │   │
                        │  │ Lite      │  │ Multimodal    │   │
                        │  │ (Risk AI) │  │ Embeddings    │   │
                        │  └───────────┘  └───────────────┘   │
                        │  ┌───────────────────────────────┐   │
                        │  │ Nova 2 Sonic (Voice AI)       │   │
                        │  └───────────────────────────────┘   │
                        └──────────┬──────────────────────────┘
                                   │
        ┌──────────┐    ┌──────────┴──────────┐    ┌──────────┐
        │ Frontend │───▶│   Backend (Express) │───▶│ PostgreSQL│
        │ Next.js  │    │   + Nova Services   │    │          │
        │ PWA      │    └──────────┬──────────┘    └──────────┘
        └──────────┘               │
                        ┌──────────┴──────────┐
                        │  CV Service (FastAPI)│
                        │  + Nova Embeddings   │
                        └─────────────────────┘
```

## Project Structure

```
/frontend          - Next.js 16 App Router + Tailwind CSS + TypeScript
/backend           - Node.js + Express API + Nova 2 Lite + Nova 2 Sonic
/cv-service        - Python FastAPI + Nova Multimodal Embeddings
/database          - PostgreSQL schema
/scripts           - Utility scripts
```

## Setup Instructions

### Prerequisites
- **AWS Account** with Bedrock access (Nova models enabled)
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

3. **Configure API keys**

Edit `backend/.env`:
```env
# AWS Credentials (Required for Nova models)
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=us-east-1

# Payment & SMS
RAZORPAY_KEY_ID=your_razorpay_key
RAZORPAY_KEY_SECRET=your_razorpay_secret
TWILIO_ACCOUNT_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_token
TWILIO_PHONE_NUMBER=your_twilio_number
```

Edit `cv-service/.env`:
```env
AWS_ACCESS_KEY_ID=your_aws_access_key
AWS_SECRET_ACCESS_KEY=your_aws_secret_key
AWS_REGION=us-east-1
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
createdb pulsepay
psql pulsepay < database/schema.sql
```

#### 2. Backend Setup
```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your AWS + database credentials
npm start
```

#### 3. CV Service Setup
```bash
cd cv-service
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your AWS credentials
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
3. Enter phone number and verify with OTP
4. Complete face liveness check — face embedding generated via **Nova Multimodal Embeddings**
5. Scan index finger (payment) and pinky finger (distress SOS)
6. Fund wallet with ₹1000-2000
7. Receive wallet ID and access dashboard

### For Merchants (Payment)
1. Visit http://localhost:3000/merchant
2. Enter payment amount in rupees
3. **Nova 2 Lite** dynamically scores risk and selects authentication tier
4. Scan customer's face (and fingerprint if needed)
5. View AI-powered identity confidence score
6. Process payment
7. Hear **Nova 2 Sonic** voice confirmation: *"Payment of ₹200 received successfully"*

### Dashboard Features
- View wallet balance and expiry countdown
- See transaction history with AI risk scores
- Extend wallet by 72 hours
- Refund remaining balance
- Rotate biometric keys
- Add family delegates with spending caps

## Technology Stack

### Frontend
- Next.js 16 with App Router
- TypeScript
- Tailwind CSS
- Camera API for biometric capture
- Web Audio API for Nova 2 Sonic voice playback

### Backend
- Express.js
- PostgreSQL with pg driver
- **AWS Bedrock SDK** — Nova 2 Lite (risk scoring), Nova 2 Sonic (voice)
- Razorpay for payments
- Twilio for SMS
- JWT for authentication

### CV Service
- FastAPI
- **Amazon Nova Multimodal Embeddings** via AWS Bedrock for face embeddings
- OpenCV for fingerprint processing
- SHA3-256 for cryptographic hashing

### Database
- PostgreSQL 15
- UUID primary keys
- Indexed queries for performance
- Transaction support

## API Endpoints

### Enrollment
- `POST /api/enroll/verify-aadhaar` - Aadhaar verification
- `POST /api/enroll/verify-otp` - Verify OTP
- `POST /api/enroll/create-wallet` - Create new wallet

### Payment
- `POST /api/payment/authenticate` - Authenticate biometrics (Nova risk scoring)
- `POST /api/payment/execute` - Execute payment + Nova voice confirmation
- `POST /api/payment/distress` - Execute distress payment with SOS

### Wallet Management
- `GET /api/wallet/:wallet_id` - Get wallet details
- `POST /api/wallet/refund` - Refund and close wallet
- `POST /api/wallet/extend` - Extend expiry
- `POST /api/wallet/rotate-salt` - Rotate biometric key

### Family Delegation
- `POST /api/family/add-delegate` - Add family member
- `GET /api/family/delegates/:parent_wallet_id` - List delegates

### CV Service
- `POST /hash-face` - Generate face hash via Nova Multimodal Embeddings
- `POST /hash-fingerprint` - Generate fingerprint hash
- `POST /liveness-check` - Verify face liveness

## Security Considerations

### What's Secure
- Biometrics stored as cryptographic hashes only (Nova embeddings + SHA3-256)
- Liveness detection prevents photo attacks
- AI-powered adaptive authentication via Nova 2 Lite
- Transaction logging with GPS coordinates
- Auto-expiry prevents long-term exposure
- Distress mode for emergency situations

### Production Considerations
- Integrate real UIDAI Aadhaar API for production deployment
- Hardware biometric sensors recommended for enterprise use
- Camera-based fingerprint suitable for consumer mobile devices

## Hackathon Categories Covered

| Category | Nova Model | Integration |
|----------|-----------|-------------|
| **Multimodal Understanding** | Nova Multimodal Embeddings | Face biometric hashing and identity verification |
| **Agentic AI** | Nova 2 Lite | Dynamic risk scoring and adaptive authentication |
| **Voice AI** | Nova 2 Sonic | Real-time merchant payment voice confirmations |

## Community Impact

PulsePay addresses a critical gap in India's digital payment ecosystem:
- **400M+ unbanked Indians** who lack smartphones for UPI payments
- **Emergency scenarios** where phones are lost, stolen, or out of battery
- **Elderly and differently-abled users** who struggle with smartphone interfaces
- **Distress situations** with a silent SOS system that doesn't alert the attacker

By using Amazon Nova's multimodal AI, PulsePay makes biometric payments accessible, secure, and inclusive — enabling financial participation for communities traditionally excluded from the digital economy.

## License

MIT License — Built for Amazon Nova AI Hackathon 2026

## Acknowledgments

Built with Amazon Nova foundation models on AWS Bedrock. Combines Nova Multimodal Embeddings, Nova 2 Lite, and Nova 2 Sonic to create a complete biometric payment system for India's unbanked population.
