# PulsePay Plan
Read the PLAN.md file in this repository completely before writing a single line of code. That file contains the full specification for PulsePay — a biometric micro-wallet for emergency phone-less payments in India, powered by Amazon Nova AI on AWS.

Execute the following build in order. Do not skip steps. Do not add features not in PLAN.md. Commit working code after each major step.

## Amazon Nova Integration (Hackathon Requirement)
PulsePay integrates three Amazon Nova foundation models via AWS Bedrock:
1. **Nova Multimodal Embeddings** (amazon.nova-embed-multimodal-v1:0) — Replaces DeepFace in cv-service for face embedding generation. Images are sent as base64, embeddings are SHA3-256 hashed.
2. **Nova 2 Lite** (amazon.nova-lite-v1:0) — Powers intelligent risk scoring in /api/payment/authenticate. Analyzes transaction context (amount, location, time, merchant) to dynamically recommend authentication tiers instead of static rules.
3. **Nova 2 Sonic** — Generates real-time voice confirmations on the merchant PWA after successful payments via Web Speech API.

All Nova integrations have graceful fallback — if AWS credentials are missing or Bedrock calls fail, the app falls back to its original static behavior.

STEP 1 — PROJECT STRUCTURE
Create this exact folder structure:
- /frontend (Next.js 14 App Router + Tailwind CSS + TypeScript)
- /backend (Node.js + Express)
- /cv-service (Python FastAPI)
- /database (PostgreSQL schema)

Initialize frontend by running: npx create-next-app@latest frontend --app --tailwind --typescript --no-git
Initialize backend with package.json including: express, pg, bcryptjs, twilio, razorpay, dotenv, cors, jsonwebtoken, uuid
Initialize cv-service with requirements.txt including: fastapi, uvicorn, opencv-python, numpy, Pillow, deepface, python-multipart, psycopg2-binary, python-dotenv

STEP 2 — DATABASE SCHEMA
Create /database/schema.sql with these exact tables:

users: id UUID primary key, phone varchar unique not null, aadhaar_verified boolean default false, emergency_contact varchar, created_at timestamp default now()

wallets: id UUID primary key, user_id UUID references users, wallet_id_hash varchar unique not null, fingerprint_hash varchar not null, distress_hash varchar not null, salt varchar not null, balance integer not null, expiry timestamp not null, active boolean default true, created_at timestamp default now()

delegated_wallets: id UUID primary key, parent_wallet_id UUID references wallets, delegate_name varchar, delegate_face_hash varchar, delegate_fingerprint_hash varchar, spending_cap integer, active boolean default true

transactions: id UUID primary key, wallet_id UUID references wallets, merchant_upi varchar, amount integer, confidence_score integer, auth_tier varchar, distress_triggered boolean default false, gps_lat decimal, gps_lng decimal, status varchar, created_at timestamp default now()

STEP 3 — BACKEND API
Create /backend/server.js as the main entry point with cors, express.json(), and routes mounted at /api

Create /backend/routes/enroll.js with:
POST /api/enroll/verify-aadhaar — accepts { phone }, returns { success: true, otp_sent: true } — DO NOT call real UIDAI API, mock it completely
POST /api/enroll/verify-otp — accepts { phone, otp }, always returns { verified: true } for any 6-digit input
POST /api/enroll/create-wallet — accepts { user_id, wallet_id_hash, fingerprint_hash, distress_hash, salt, amount, phone } — inserts into users and wallets tables, sets expiry to 72 hours from now, returns { wallet_id, expiry, balance }

Create /backend/routes/payment.js with:
POST /api/payment/authenticate — accepts { face_hash, fingerprint_hash, amount } — queries wallets table for matching wallet_id_hash, applies tier logic (amount under 20000 paise needs face only, under 100000 needs face+finger, above needs face+finger+otp), returns { authenticated, wallet_id, confidence_score, tier, balance }
POST /api/payment/execute — accepts { wallet_id, amount, merchant_upi, gps_lat, gps_lng } — checks balance and expiry, calls Razorpay payout, deducts balance, inserts transaction, sends Twilio SMS, returns { transaction_id, remaining_balance }
POST /api/payment/distress — accepts { wallet_id, amount, merchant_upi, gps_lat, gps_lng, emergency_contact } — executes payment normally AND sends SOS SMS via Twilio with GPS Google Maps link

Create /backend/routes/wallet.js with:
GET /api/wallet/:wallet_id — returns wallet details including balance, expiry, active status
POST /api/wallet/refund — deactivates wallet, returns balance to user (mock refund for demo)
POST /api/wallet/extend — extends expiry by 72 hours
POST /api/wallet/rotate-salt — generates new random salt, recomputes wallet_id_hash as sha3_256(old_face_embedding_hint + new_salt), updates database, invalidates old hash

Create /backend/routes/family.js with:
POST /api/family/add-delegate — inserts delegated_wallets record
GET /api/family/delegates/:parent_wallet_id — returns all active delegates

Create /backend/services/razorpay.js — initialize with env keys, export async payMerchant(merchantUpiId, amountInPaise, walletId) that calls Razorpay payouts API in test mode

Create /backend/services/twilio.js — initialize with env keys, export async sendSMS(to, message) and async sendSOS(emergencyContact, userName, gpsLat, gpsLng)

Create /backend/.env.example:
DATABASE_URL=postgresql://user:password@localhost:5432/pulsepay
RAZORPAY_KEY_ID=your_key_here
RAZORPAY_KEY_SECRET=your_secret_here
RAZORPAY_ACCOUNT_NUMBER=your_account_here
TWILIO_ACCOUNT_SID=your_sid_here
TWILIO_AUTH_TOKEN=your_token_here
TWILIO_PHONE_NUMBER=your_number_here
JWT_SECRET=your_jwt_secret_here
CV_SERVICE_URL=http://localhost:8000
PORT=5000

STEP 4 — PYTHON CV SERVICE
Create /cv-service/main.py with FastAPI and CORS enabled:

POST /hash-face — accepts multipart form with image file — uses DeepFace.represent() to get 128-dim embedding, converts float array to string, hashes with hashlib.sha3_256, returns { hash: string, confidence: int, embedding_preview: first 5 values }

POST /hash-fingerprint — accepts multipart form with image file — converts to grayscale with OpenCV, applies Gaussian blur, applies binary threshold, finds contours, computes a feature vector from contour areas, hashes with sha3_256, returns { hash: string }

POST /liveness-check — accepts multipart form with image file and challenge_type string — uses DeepFace.extract_faces() to confirm exactly one face detected with confidence above 0.9, returns { liveness_passed: bool, confidence: int, face_detected: bool }

Create /cv-service/.env.example with:
BACKEND_URL=http://localhost:5000

STEP 5 — FRONTEND ENROLLMENT PAGE
Create /frontend/app/enroll/page.tsx as a multi-step enrollment flow:

Step 1 — Aadhaar Mock Verification:
Show PulsePay logo and tagline "Your body is your wallet"
Phone number input field
"Send OTP" button that calls POST /api/enroll/verify-aadhaar
OTP input field that appears after send
"Verify" button that calls POST /api/enroll/verify-otp
On success show green checkmark and auto-advance to step 2

Step 2 — Face Scan with Challenge-Response Liveness:
Show live camera feed using getUserMedia in a rounded card
Show a challenge badge that randomly displays one of: "Please blink twice", "Turn your head slightly left", "Hold up 2 fingers"
Show "Capture Face" button
On capture: send frame as blob to cv-service POST /hash-face and POST /liveness-check simultaneously
Show animated confidence score filling up
If liveness passed and confidence above 70: show green "Face Captured" badge with first 12 chars of hash
Auto-advance to step 3

Step 3 — Fingerprint Scan:
Show instruction: "Place your INDEX finger close to the camera lens"
Camera feed open
"Capture Index Finger" button — sends to cv-service POST /hash-fingerprint — stores as index_hash
On success show green tick, then show: "Now place your PINKY finger close to the camera"
"Capture Pinky Finger" button — sends to cv-service — stores as distress_hash
On both captured show: "Fingerprints enrolled. Index = payment. Pinky = emergency SOS."
Auto-advance to step 4

Step 4 — Fund the Wallet:
Amount slider from 1000 to 2000 rupees showing rupee value
Expiry display: "72 hours from now — auto-refunds if unused"
"Lock Funds via UPI" button that calls POST /api/enroll/create-wallet with all collected data
On success show full-screen confirmation: wallet ID (first 8 chars), amount locked, expiry time, green shield icon
Show link to /dashboard

STEP 6 — FRONTEND MERCHANT PWA
Create /frontend/app/merchant/page.tsx:

Top bar showing "PulsePay Merchant" and a green "Ready to Scan" badge

Main scan area: large circular camera preview with scan animation ring
Random challenge prompt showing in a pill badge above camera
"Scan Customer" button

After capture: show Identity Confidence Score as a large number (0-100) with animated counter and color coding — red below 70, amber 70-89, green 90-100

Show authentication tier badge based on amount entered:
Amount input in rupees below the score
Tier badge updates in real time as amount changes: "Face Only" in green for under 200, "Face + Fingerprint" in amber for 200-1000, "Face + Fingerprint + OTP" in red for above 1000

If tier requires fingerprint: show second camera capture for fingerprint
If tier requires OTP: show OTP input field

"Process Payment" button calls POST /api/payment/authenticate then POST /api/payment/execute
On success: full-screen green confirmation with amount, transaction ID, merchant UPI, timestamp
On failure: red screen with reason

STEP 7 — FRONTEND DASHBOARD
Create /frontend/app/dashboard/page.tsx:

Wallet status card showing: balance in rupees, expiry countdown timer updating every second, active/expired badge
Action buttons: Extend 72 Hours, Refund Now, Rotate Biometric Key
Transaction history table from GET /api/wallet showing: date, amount, merchant, tier used, status

Family wallet section:
List of current delegates from GET /api/family/delegates
"Add Family Member" button that opens a modal with: name input, camera scan for face, spending cap slider, submit button calling POST /api/family/add-delegate

STEP 8 — FRONTEND NAVIGATION
Create /frontend/app/page.tsx as landing page with:
PulsePay logo, tagline, and two large buttons: "Set Up My Wallet" going to /enroll and "Merchant Payment" going to /merchant
Brief explanation of the three steps in icons

Create /frontend/app/layout.tsx with proper metadata, title "PulsePay — Your Body Is Your Wallet"

STEP 9 — DOCKER AND README
Create docker-compose.yml that runs:
postgres on port 5432 with database name pulsepay
backend on port 5000 with depends_on postgres
cv-service on port 8000
frontend on port 3000 with depends_on backend

Create README.md with:
Project name and tagline
Setup instructions: clone, copy .env files, fill in Razorpay sandbox and Twilio test keys, run docker-compose up, visit localhost:3000
Demo flow: enroll at /enroll, then test merchant payment at /merchant
Feature list covering all features from PLAN.md

STEP 10 — FINAL VERIFICATION
After all files are created:
Check all frontend API calls point to the correct backend routes
Check all backend routes connect to the correct database tables
Check cv-service endpoints match what the frontend calls
Check Razorpay and Twilio service files are imported correctly in payment.js
Fix any broken imports, missing dependencies, or type errors found

Commit everything with message: "PulsePay — complete hackathon build: enrollment, merchant PWA, CV service, adaptive auth, distress mode, family wallet, dashboard"
