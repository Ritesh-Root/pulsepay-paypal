# PulsePay — Your Fingerprint Is Your Wallet

**A biometric wallet for phone-light payments.**

PulsePay lets someone pay with a **fingerprint** and a PIN. Larger amounts can add a face check or a one-time code. Balances sit on a pooled sub-ledger, settlement goes through payment-rail adapters, and biometric templates are stored as encrypted cancelable vectors. Live bank rails, certified capture devices, and legal compliance are **not** claimed by this repository. See [MVP_SCOPE.md](MVP_SCOPE.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [PLAN.md](PLAN.md).

---

## Design choices

| Earlier approach | Current approach |
|---|---|
| SHA3 hash of embedding + exact-match → **biometrics can never match** | Encrypted, **cancelable vector templates** + cosine-similarity threshold |
| Face data → **AWS Bedrock us-east-1** (RBI localization breach) | **India-resident** inference plane; system-wide egress allow-list |
| **Razorpay** payout (competing PSP) + crypto funding | **NPCI UPI / UPI 123Pay / SBI CBS** rails; crypto removed by schema enum |
| Aadhaar mocked; **OTP returned in the API response** | UIDAI **AUA/KUA** (Sub-AUA); OTP server-side only; Aadhaar tokenized in a segregated vault |
| Read-then-write balance → **double-spend**; INTEGER paise | **Atomic double-entry ledger** + idempotency; **BIGINT** paise |
| `face_only` tier (single factor) | **Fingerprint + PIN** base; **face step-up above an amount limit**; OTP at the top; AI **escalate-only** |
| Hardcoded secrets, CORS `*`, fake liveness, no rate limit | KMS/Vault (**fail-closed**), scoped CORS, PAD hook, rate limiting, per-route ownership |
| Distress = separate, distinguishable, double-spendable endpoint | **Unified** debit path; **distinct distress finger**; capped; byte-identical response; async one-directional SOS |

---

## Architecture (summary)

```
Branch / BC kiosk + STQC device ─┐
UPI 123Pay assisted terminal ────┤   ┌──────── INDIA-RESIDENT TRUST BOUNDARY ────────┐
                                 └──▶│ API gateway (WAF, rate limit, CORS allowlist)  │
                                     │ App services (stateless, ≥2 replicas)          │
                                     │  ├─ Inference plane (local model + PAD)        │
                                     │  ├─ Biometric vault (cancelable, HSM-encrypted)│
                                     │  ├─ Auth assertion + escalate-only risk        │
                                     │  ├─ Atomic double-entry ledger                 │
                                     │  ├─ RailsAdapter (UPI/123Pay/CBS)              │
                                     │  └─ Consent / KYC-AML / audit                  │
                                     │ HA Postgres · Redis · HSM/KMS (all in India)   │
                                     └───────────────┬───────────────┬───────────────┘
                                             NPCI/UPI/SBI CBS   UIDAI (via SBI AUA/KUA)
```

Full detail, data model, flows, and threat model are in [ARCHITECTURE.md](ARCHITECTURE.md). **What is in / out of the demo MVP, the settlement decision, and the honesty matrix (implemented / mocked / tested / deferred) live in [MVP_SCOPE.md](MVP_SCOPE.md).** Design arguments in §9 of ARCHITECTURE are not verified operational proofs.

---

## Project structure

```
/frontend     - Vite + React PWA (enrolment, merchant, dashboard) — wired to the API
/backend      - Node/Express API: biometric vault, ledger, rails, auth assertion, AUA, consent
/cv-service   - FastAPI India-resident inference plane (face embedding + liveness)
/database     - PostgreSQL schema (encrypted templates, double-entry ledger, consent/audit)
ARCHITECTURE.md, PLAN.md - design and build plan
```

---

## Setup (Docker)

```bash
cp .env.example .env
# generate the KMS data key (32-byte hex) and a JWT secret:
node -e "console.log('KMS_DATA_KEY='+require('crypto').randomBytes(32).toString('hex'))" >> .env
# set JWT_SECRET (>=16 chars) and POSTGRES_PASSWORD in .env, then:
docker-compose up --build
```

The backend **fails closed**: it will refuse to start if `JWT_SECRET` or `KMS_DATA_KEY` are missing — by design.

- Frontend: http://localhost:3000  ·  Backend: http://localhost:5000  ·  CV: http://localhost:8000

---

## API

**Enrolment** (attended in-branch / BC)
- `POST /api/enroll/request-otp` — AUA/KUA e-KYC OTP (sent server-side; **never** in the response)
- `POST /api/enroll/verify-otp` — returns a short-lived enrolment ticket
- `POST /api/enroll/create-wallet` — consent + encrypted **fingerprint** (payment + distinct distress finger) and **face** templates + CBS-funded wallet (atomic)

**Payment** (unified, AFA-compliant)
- `POST /api/payment/authenticate` — 1:N **fingerprint** match + PIN, **face step-up above a limit** → escalate-only tier → single-use **Auth Assertion**
- `POST /api/payment/execute` — consumes the assertion; atomic idempotent ledger debit; reserve→settle→confirm
- `POST /api/payment/sos` — owner-authenticated panic button (SOS only; payment-time duress is silent inside the unified flow)

**Wallet** (all ownership-guarded)
- `GET /api/wallet/:id` · `POST /api/wallet/refund` (ledgered) · `POST /api/wallet/extend` (capped) · `POST /api/wallet/reissue-biometric` (re-verified, cancelable)

**Family** — `POST /api/family/add-delegate` (owner-auth, delegate gets own consent+KYC+template) · `GET /api/family/delegates/:parent_wallet_id`

**Voice** — `POST /api/voice/confirm` (India-resident text; spoken on-device via Web Speech API)

---

## Demo flow

1. **Enrol** at a BC kiosk: OTP e-KYC → consent → register a **payment finger** and a **distinct distress finger** (+ a face for step-up) → set a wallet PIN → fund ₹1000–2000 (72h expiry).
2. **Pay**: merchant enters amount → customer's **fingerprint** is matched (1:N) + PIN → above a set limit a **face scan** is added (OTP at the top tier) → assertion issued → atomic debit over UPI/CBS → on-device voice confirmation.
3. **Distress**: the customer uses their **distinct distress finger** → payment completes (capped) and looks identical, while a silent SOS + location goes to their emergency contact.

---

## Security & compliance highlights

> These are **design intentions**. They are **not** claims of completed legal compliance, certified presentation-attack detection, licensed identity-gateway access, or penetration-test results. See [MVP_SCOPE.md](MVP_SCOPE.md).

- **RBI data localization (intent)** — keep biometric/payment data India-resident; egress allow-list in design.
- **RBI AFA (intent in code)** — payment path aims for ≥2 factors; risk may escalate only.
- **DPDP (partial)** — consent records exist; full rights/erasure subsystem not demo-complete.
- **UIDAI (mocked)** — Aadhaar only via stubbed AUA interface; no production Sub-AUA.
- **Payment integrity (demo ledger)** — balanced double-entry groups, idempotency, reserve→settle→confirm on stub rails; pending reconcile if confirm fails after rail OK.
- **Biometrics (mocked)** — webcam stand-in; FAR/FRR unmeasured; 1:N unproven.

---

## Status

Backend, database schema, CV service, and a **mint-wallet Vite + React frontend** (Home / Send / Request / Bank + Profile for enrol & merchant) are wired to the fingerprint-primary design. Webcam capture is a **mock** for AePS. Real SBI/UIDAI/NPCI/HSM integrations remain stubbed (`services/rails.js`, `aua.js`, `kms.js`).

**Settlement model for this codebase:** pooled SBI sub-ledger (demo) — see [MVP_SCOPE.md](MVP_SCOPE.md). Family delegation remains in code but is **deferred** from MVP acceptance.

**Run the frontend locally:** `cd frontend && npm install && npm run dev` → http://localhost:3000 (backend + CV for live enrol/pay; UI works in demo mode without them).

**Schema note:** fresh installs use `database/schema.sql` (includes `request_id`, `counterpart_account`, `pending`, `debit`). Existing Postgres volumes need a recreate or manual ALTER before balanced postings work.

## License

MIT
