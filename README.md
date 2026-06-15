# PulsePay-SBI — Your Body Is Your Wallet

**Biometric, phone-less micro-wallet for financial inclusion — built for the State Bank of India (SBI) hackathon.**

PulsePay lets an unbanked or phone-less person pay with their **fingerprint** at any SBI Business Correspondent (a face scan adds security on larger amounts) — money on SBI's books, settled over UPI 123Pay, biometrics encrypted and never leaving India, RBI-AFA compliant, with a silent distress mode for coercion safety.

> **Re-targeted from Amazon Nova → SBI.** This project was originally built for the Amazon Nova hackathon. It has been re-architected for SBI: data localization (RBI), NPCI/UPI rails, UIDAI AUA/KUA identity, DPDP privacy, bank-grade security, and financial inclusion. Amazon Nova is now an optional, swappable model provider behind an India-resident interface — never a hard dependency. See **[ARCHITECTURE.md](ARCHITECTURE.md)** and **[PLAN.md](PLAN.md)**.

---

## What changed (and why it matters for SBI)

| Amazon build (flaw) | SBI build (fix) |
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

Full detail, data model, flows, compliance mapping, threat model and the **no-loop proof** are in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Project structure

```
/frontend     - Next.js PWA (enrolment, merchant, dashboard)  [pending update to new API]
/backend      - Node/Express API: biometric vault, ledger, rails, auth assertion, AUA, consent
/cv-service   - FastAPI India-resident inference plane (face embedding + liveness)
/database     - PostgreSQL schema (encrypted templates, double-entry ledger, consent/audit)
ARCHITECTURE.md, PLAN.md - the SBI design + build plan
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

## API (SBI build)

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

- **RBI data localization** — all biometric/payment data India-resident; egress allow-list.
- **RBI AFA** — every payment is ≥2 factors; AI can only escalate, never weaken.
- **DPDP Act 2023** — explicit per-purpose consent ledger; encrypted, cancelable, revocable biometric templates; audit/AML carry no biometric data.
- **UIDAI** — Aadhaar only via SBI's AUA/KUA; OTP server-side; Aadhaar tokenized + segregated.
- **Payment integrity** — double-entry ledger, idempotency, reserve→settle→confirm, never debit on rail failure.
- **No drawbacks / no loops** — see the formal no-loop proof in [ARCHITECTURE.md §9](ARCHITECTURE.md).

---

## Status

Backend, database schema, and CV service are re-architected to the SBI design (the demoable subset). The **frontend still calls the old API shape** and is the main remaining work — see [PLAN.md](PLAN.md) §4 for the definition-of-done checklist. Real SBI/UIDAI/NPCI/HSM integrations are stubbed behind interfaces (`services/rails.js`, `services/aua.js`, `services/kms.js`, `services/inference.js`) so they swap in without changing calling code.

## License

MIT — re-architected for the SBI hackathon.
