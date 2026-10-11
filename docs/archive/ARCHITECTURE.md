# PulsePay — Architecture

**Biometric wallet for phone-light payments.**

> This document describes the **target architecture** for PulsePay. **Controls listed here are design intentions — not verified legal compliance, certified biometrics, or penetration-test evidence.** For what this repo implements, mocks, or defers, see **[MVP_SCOPE.md](MVP_SCOPE.md)**.

> Stubbed identity, payment-rail, and key-management adapters are not a licensed production system.

> **PayPal version (current).** PulsePay now runs on PayPal: wallets are funded with PayPal Checkout (JS SDK v6 + Orders v2), merchants are paid with PayPal Payouts, unused balances are refunded to the original PayPal captures, and PayPal webhooks reconcile payouts, disputes and invoices. Amounts are USD. An AI merchant assistant (GLM on Amazon Bedrock + PayPal Agent Toolkit) answers sales questions and proposes refunds that a person confirms. See README.md and MVP_SCOPE.md for the current pipeline. The India-specific material below (RBI, UIDAI/Aadhaar, NPCI/UPI, SBI) documents the original design and is kept for reference; it is **not** what the code does now.
>
> **Payment model.** The customer enrols on their own phone, then leaves it at home. At the shop they are identified on the merchant's phone by their chosen biometric (fingerprint, face, or both) via 1:N match, the merchant enters the amount, and the customer types their PIN. The identification is a single-use pay session; the terminal signs the customer out after one payment. There is no OTP in the payment path, because the phone may be at home.

---

## 1. Design corrections

| # | Confirmed flaw in current code | Where | Fix in this architecture |
|---|---|---|---|
| 1 | Biometric match is impossible: SHA3-256 of an embedding + exact-match SQL — avalanche means two captures never match | `cv-service/main.py:91-94`, `backend/routes/payment.js:62` | Encrypted, **cancelable** template vectors + cosine-similarity threshold (§4 Biometric Vault) |
| 2 | Data-residency violation: face images + embeddings shipped to AWS Bedrock in **us-east-1** | `backend/services/nova.js`, `cv-service/main.py`, `render.yaml` | **India-resident, model-agnostic inference plane**; egress allow-list (§4) |
| 3 | Wrong rails: payouts via mocked **Razorpay** (a competing PSP); crypto funding path | `backend/services/razorpay.js`, `enroll.js:93,156` | **NPCI UPI / UPI 123Pay / SBI CBS** RailsAdapter; crypto removed by schema enum (§4) |
| 4 | Identity hand-waved: Aadhaar mocked, `aadhaar_verified=true` unconditionally, OTP returned in response | `enroll.js:37,125`, in-memory OTP `Map` `:9` | Aadhaar **only** via SBI's licensed AUA/KUA + STQC registered devices; OTP never echoed (§4, §6) |
| 5 | Double-spend: read-then-write balance, no lock/transaction; `INTEGER` paise caps ~₹21.4 L | `payment.js:199-203`, `wallet.js:79` | Atomic, append-only **double-entry ledger** + idempotency keys; **BIGINT** paise (§4) |
| 6 | Security holes: hardcoded DB password, default JWT secret, CORS `*`, fake Haar-cascade "liveness", no rate limiting, salt beside hash | `docker-compose.yml`, `auth.js`, `server.js:17`, `main.py:34,198-202` | KMS/Vault, scoped CORS, ISO 30107-3 PAD, rate limiting/WAF, cancelable transform (§8) |
| 7 | No HA / observability / DR | — | Multi-AZ HA, fail-closed degradation, observability, DR runbooks (§10) |

**Kept:** phone-light payment, a distinct distress finger with a silent alert, a pre-funded wallet with a 72-hour expiry, and risk that can only raise the authentication tier.

---

## 2. Design principles

1. **One source of truth per decision.** Identification is decided once and carried forward as a single-use pay session that is consumed with the payment, never recomputed downstream.
2. **AI advises, deterministic policy decides.** The risk engine may only *raise* authentication strength, never lower it below the statutory floor (`final_tier = max(static_floor, ai_recommendation)`). A poisoned, hallucinated, or prompt-injected risk score can never weaken auth.
3. **Fail closed.** Every dependency outage (inference plane, KMS, AUA/KUA) denies with a clear message or degrades to a *stronger* safe mode — never to a weaker matcher or a fabricated success.
4. **Identifier ≠ authenticator.** A random wallet UUID identifies; the biometric template authenticates. A leaked template never becomes a permanent account-takeover key (templates are cancelable/re-issuable).
5. **Data minimization & residency.** Raw biometric frames never persist and never leave India; only encrypted, transformed templates are stored. Biometric data never enters immutable audit/AML logs.
6. **Money moves atomically or not at all.** Reserve → settle → confirm; debit only on rail acknowledgement (UTR); idempotent end-to-end.

---

## 3. System architecture

```
                         ┌─────────────────────────────────────────────────────────────┐
                         │            INDIA-RESIDENT TRUST BOUNDARY (RBI localization)   │
                         │            SBI on-prem / MeitY-empanelled India-region cloud  │
                         │                                                               │
  Branch / BC / CSP      │   ┌──────────────┐      ┌───────────────────────────────┐    │
  kiosk + STQC           │   │ API Gateway  │      │  Inference Plane (model-agnostic)│   │
  registered device ─────┼──▶│ WAF + rate   │─────▶│  • FaceEmbeddingProvider iface │    │
  (attended liveness)    │   │ limit + CORS │      │  • default on-prem ONNX (ArcFace)│   │
                         │   │ allowlist    │      │  • ISO 30107-3 PAD / liveness   │    │
  UPI 123Pay assisted    │   └──────┬───────┘      │  • escalate-only risk scorer    │    │
  terminal / BC POS ─────┼──────────┤              └──────────────┬────────────────┘    │
                         │          │                             │ (enclave only)       │
                         │   ┌──────▼────────┐   ┌────────────────▼───────────────┐      │
                         │   │ App services  │   │ Biometric Template Vault       │      │
                         │   │ (stateless,   │──▶│ (cancelable vectors, HSM       │      │
                         │   │  ≥2 replicas) │   │  envelope-encrypted, cosine     │      │
                         │   │ auth/pay/     │   │  threshold match)               │      │
                         │   │ enrol/wallet/ │   └─────────────────────────────────┘     │
                         │   │ family/rights │   ┌─────────────────────────────────┐     │
                         │   └──┬────────┬───┘   │ Aadhaar Token Vault (SEGREGATED) │     │
                         │      │        │       │ VID/reference only, separate KMS │     │
                         │      │        │       └─────────────────────────────────┘     │
                         │   ┌──▼──────┐ │  ┌──────────────┐  ┌──────────────────────┐   │
                         │   │ HA      │ │  │ Redis cluster│  │ HA HSM / KMS cluster  │   │
                         │   │ Postgres│ │  │ (OTP/session)│  │ (key replication, IN) │   │
                         │   │ multi-AZ│ │  └──────────────┘  └──────────────────────┘   │
                         │   │ +PITR   │ │                                                │
                         │   └─────────┘ │   ┌─────────────────────────────────────┐    │
                         │               └──▶│ Async queue (post-commit)           │    │
                         │   ┌───────────────┤  SMS (India DLT) │ Indic voice TTS  │    │
                         │   │ RailsAdapter  │  one-directional SOS │ AML/STR feed  │    │
                         │   │ (NPCI/UPI/    │   └─────────────────────────────────┘    │
                         │   │  123Pay/CBS)  │                                           │
                         │   └──────┬────────┘   ┌─────────────────────────────────┐    │
                         │          │            │ SBI AUA/KUA gateway (Sub-AUA)   │    │
                         │          │            │ STQC registered devices, eKYC   │    │
                         └──────────┼────────────┴─────────────────┬───────────────┘    │
                                    │                              │                     
                            ┌───────▼────────┐            ┌────────▼────────┐
                            │ NPCI / UPI     │            │ UIDAI (via SBI  │
                            │ SBI Core Bank  │            │ licence only)   │
                            └────────────────┘            └─────────────────┘
```

Everything inside the trust boundary is India-resident. The only external calls are to NPCI/UPI/CBS (settlement) and UIDAI *through SBI's AUA/KUA* (identity) — both mandated, both India-domestic.

---

## 4. Component catalogue

Each component: **purpose** · **why this over the alternative** · **what it replaces.**

### 4.1 India-Resident, Model-Agnostic Inference Plane
- **Purpose:** run all face-embedding extraction, liveness/PAD, and risk scoring inside India.
- **Why this over the alternative:** inference stays in-region on an on-prem model, with an optional managed model behind the same adapter. A network egress guard blocks endpoints that are not on the India allow-list.
- **Replaces:** `cv-service/main.py get_nova_embedding()`, `nova.js getEmbedding/assessRisk`, `render.yaml AWS_REGION=us-east-1`.

### 4.2 Encrypted, Cancelable Biometric Template Vault + Matcher
- **Purpose:** store face/fingerprint as **transformed** (cancelable) vectors, envelope-encrypted with a per-record HSM key; match by cosine similarity ≥ a calibrated FAR/FRR threshold inside a secure enclave.
- **Why this over the alternative:** hashing destroys the similarity geometry needed to match (the root cause of flaw #1); plaintext vectors are a reversible-biometric honeypot under DPDP; using the face hash *as the lookup key* makes a leak a permanent takeover. Cancelable transform + identifier/authenticator separation fixes the functional bug *and* the irrevocability problem in one move.
- **Replaces:** `cv-service` SHA3 logic; `wallets.wallet_id_hash / fingerprint_hash / distress_hash`; the exact-hash lookup in `payment.js`.

### 4.3 Pay sessions: identify → amount → PIN
- **Purpose:** `/identify` turns a biometric scan on the merchant's device into a **single-use, 2-minute pay session** bound to that merchant. `/pay` consumes the session together with the amount and the customer's PIN; nothing is recomputed downstream.
- **Factors:** every merchant payment needs the customer's **chosen inherence factor(s)** (fingerprint, face, or both; chosen at enrolment) **plus the PIN** (knowledge). "Both" means a second 1:1 scan against the same person before the amount is taken. OTP is not used during payment because the customer's phone may be at home.
- **Why this over the alternative:** a card-like flow (identify, amount, PIN) keeps the customer phone-free and the merchant device stateless: the session is consumed atomically with the ledger reservation, cancellable, and expires on its own. The distress flag lives only in the session row, never in a token.
- **Lockout:** three wrong PINs lock the PIN for 30 minutes (card-style), so a merchant device cannot brute-force it.
- **Replaces:** the earlier `/authenticate` → signed assertion → `/execute` split with amount-based face/OTP step-up.

### 4.4 Escalate-only risk check
- **Purpose:** score amount, time of day and recent spending, and optionally **decline** a payment.
- **Why this over the alternative:** the floor (chosen biometric(s) + PIN inside hard wallet limits) is deterministic. The advisor (TypeSafe Jev when `TYPESAFE_API_KEY` is set, otherwise a local display-only heuristic) can only make the outcome stricter: `final = strictest(allow, advice)`. A poisoned or prompt-injected advisor can block a payment but can never skip a factor. The external advisor receives only amounts and time of day.
- **Replaces:** tier escalation to face/OTP, which is not possible when the phone is at home.

### 4.5 RailsAdapter (NPCI/UPI · UPI 123Pay · SBI CBS)
- **Purpose:** settle by debiting the pre-funded SBI wallet account via CBS and routing merchant payment over UPI / UPI 123Pay (NPCI's purpose-built phone-less product).
- **Why this over the alternative:** SBI is an NPCI member; an SBI product must use NPCI/SBI rails, not a competing third-party PSP. UPI 123Pay is the natural fit for the phone-less inclusion narrative. **Reserve → settle → confirm (UTR); never debit on rail failure** — no fabricated success id.
- **Replaces:** `backend/services/razorpay.js` and the generic VPA payout path.

### 4.6 UIDAI AUA/KUA Aadhaar Connector (PulsePay as Sub-AUA)
- **Purpose:** all Aadhaar e-KYC/auth runs through SBI's licensed AUA/KUA gateway with STQC-certified registered devices producing signed encrypted PID blocks PulsePay never decrypts or stores.
- **Why this over the alternative:** real Aadhaar auth is legal *only* via a licensed AUA/KUA + registered devices; PulsePay obtaining its own licence is slower and off-mission when SBI already holds it. Aadhaar is **tokenized** (VID/reference) in a *segregated* vault with independent KMS + RBAC, so it is not a re-identification honeypot next to biometrics and the ledger. OTP is issued/verified server-side and never echoed.
- **Replaces:** `enroll.js` mock Aadhaar, unconditional `aadhaar_verified=true`, in-memory OTP `Map`, `mock_otp` in response.

### 4.7 Consent Ledger & DPDP Rights Service
- **Purpose:** capture explicit, granular, per-purpose, revocable consent; service data-principal rights (access/correct/erase/withdraw) + grievance redress; breach notification.
- **Why this over the alternative:** a single consent boolean cannot evidence purpose limitation or support withdrawal; DPDP requires demonstrable, itemized, time-stamped consent. Append-only + hash-chained gives tamper-evidence. Withdrawal is a **state machine** (below) so it never contradicts AML retention or orphans in-flight settlement.
- **Replaces:** the total absence of consent/rights handling.

### 4.8 KYC/AML Service
- **Purpose:** tiered KYC (min-KYC small-value wallet upgradeable to full KYC), CKYC, sanctions/PEP screening, STR/CTR reporting to SBI's FIU channel; **identity-keyed** cross-wallet velocity monitoring.
- **Why this over the alternative:** full KYC upfront would exclude the core unbanked cohort; RBI explicitly permits min-KYC small wallets — low friction *and* compliant. Monitoring is keyed to the KYC'd identity across wallets/expiries to catch the rapid-serial-72h-wallet structuring vector that per-wallet rules miss.
- **Replaces:** absence of KYC tiers and AML; reframes the 72h expiry as a compliant small-wallet control.

### 4.9 Atomic Double-Entry Ledger
- **Purpose:** every money movement is one locked, transactional, idempotent ledger write; balance is derived; `transactions` becomes an immutable journal. **Each `request_id` posts a balanced group** of debit and credit lines on named accounts (`wallet:<id>`, `pool:sbi_pulsepay`, `merchant:<upi>`); lines move together through reserved → settled (or released), so a wallet's balance is derivable from its account. If the rail succeeds but local confirm fails, status is `pending` and a retry of `/pay` (same session) reconciles idempotently.
- **Why this over the alternative:** the current read-then-write double-spends under concurrency and `INTEGER` overflows. `UPDATE ... WHERE balance >= amount` + unique `idempotency_key` (one namespace spanning execute *and* distress) + BIGINT paise + reserve/release states fixes all three.
- **Demo settlement:** pooled SBI sub-ledger (see MVP_SCOPE.md) — not CBS-per-user.
- **Replaces:** `payment.js`/`wallet.js` mutable-balance updates.

### 4.10 Security, Secrets & Audit Baseline
- **Purpose:** KMS/Vault-managed secrets (fail-closed if unset), CORS allow-list, rate limiting + WAF, private-subnet CV service, tamper-evident append-only audit log, least-privilege RBAC, per-route ownership/authorization.
- **Why this over the alternative:** the current hardcoded creds, CORS `*`, public biometric service, and "any-JWT-drains-any-wallet" routes are non-starters for a bank. JWT is scoped to the **user** (a user owns many wallets and may be a delegate), with per-wallet authorization checks on every state-changing route.
- **Replaces:** `docker-compose.yml` password, `auth.js` JWT default, `server.js`/`main.py` CORS `*`, the missing authorization checks.

---

## 5. Consolidated data model

All tables India-resident; TDE at rest; envelope/field-level encryption where noted; TLS in transit. Monetary columns are **BIGINT paise, CHECK ≥ 0**.

| Table | Key fields | Notes / why |
|---|---|---|
| **users** | `id UUID PK`, `phone (nullable for delegates)`, `emergency_contact`, `pin_hash`, `id_method (fingerprint\|face\|both)`, `pin_failed_attempts`, `pin_locked_until` | the customer chooses how merchants identify them; card-style PIN lockout |
| **merchants** | `id UUID PK`, `phone UNIQUE`, `display_name`, `upi_handle UNIQUE`, `active` | merchant signs in with phone + OTP; payouts go only to the registered handle |
| **kyc_profiles** | `user_id FK`, `kyc_tier (min\|full)`, `ckyc_id`, `pep_sanctions_status`, `verified_via (aua_kua)`, `limits_json` | replaces the `users.aadhaar_verified` boolean |
| **aadhaar_token_vault** *(segregated)* | `user_id FK`, `aadhaar_ref_token (VID/reference, no plaintext)`, `aua_txn_id` | separate KMS key + RBAC from the app DB → breaks the re-identification honeypot |
| **biometric_templates** | `subject_id FK`, `template_type (fingerprint\|face)`, `purpose (auth\|distress)`, `protected_vector (cancelable, HSM-encrypted)`, `kms_key_ref`, `transform_salt`, `model_version`, `deactivated_at` | fingerprint = primary; face = step-up; a `purpose='distress'` fingerprint = the distinct distress finger (replaces the duress-PIN). Identifier (wallet UUID) separated from authenticator; enclave-only decryption |
| *(distress credential)* | not a separate table — a `biometric_templates` row with `template_type='fingerprint'`, `purpose='distress'` | a DISTINCT enrolled finger; resolves same-trait cross-fire (see §6.3) |
| **wallets** | `id UUID PK`, `user_id FK`, `cbs_account_ref`, `funding_source ENUM CHECK {sbi_cbs,upi}`, `balance_cached BIGINT`, `expiry`, `max_lifetime`, `extend_count`, `active` | BIGINT paise; crypto removed by enum |
| **delegated_wallets** | `parent_wallet_id FK`, `delegate_subject_id FK`, `spending_cap BIGINT`, `spent_total BIGINT`, `per_delegate_expiry`, `active` | delegate is a real data principal (own KYC/consent/template); `spent_total` atomically enforced |
| **ledger_entries** *(append-only, double-entry)* | `request_id`, `account (wallet:<id>\|pool:…\|merchant:<upi>)`, `direction (debit\|credit)`, `kind (fund\|payment\|send\|refund)`, `amount BIGINT`, `balance_after`, `idempotency_key UNIQUE`, `pay_session_id`, `upi_utr`, `status (reserved\|settled\|released\|pending)` | every request is a balanced group; a wallet's balance is derivable from its account |
| **transactions** *(immutable journal)* | `wallet_id FK`, `merchant_upi`, `amount BIGINT`, `confidence_score (server-derived)`, `auth_tier`, `distress_triggered`, `gps_lat/lng`, `status` | confidence is the real match score, never client-supplied |
| **consent_records** *(append-only, hash-chained)* | `subject_id FK`, `purpose`, `granted`, `channel`, `language`, `prev_hash`, `record_hash`, `withdrawn_at` | references only, no biometric data |
| **audit_log** *(append-only, hash-chained)* | `actor`, `action`, `subject_user_id`, `resource_ref`, `ip`, `prev_hash`, `record_hash` | no biometric data → survives DPDP erasure under legal hold |
| **aml_alerts** | `identity_id FK`, `rule_id`, `risk_score`, `alert_type (structuring\|velocity\|geo\|sanctions\|wallet_churn\|distress)`, `status`, `analyst_id` | identity-keyed, not wallet-keyed |
| **pay_sessions** | `merchant_id`, `subject_id`, `wallet_id`, `methods_required`, `fingerprint_ok`, `face_ok`, `distress`, `failed_scans`, `expires_at (120s)`, `consumed_at` | single-use identification on a merchant device; distress flag stored only here |

---

## 6. Key flows

### 6.1 Enrolment (customer's own phone)
Phone OTP (e-KYC via the AUA/KUA adapter) → the customer **chooses an ID method** (fingerprint, face, or both) → scans → optional **distinct distress finger** (must be clearly separable from the payment finger) → PIN (weak PINs refused) → optional emergency contact → per-purpose consent → each vector cancelable-transformed + encrypted → **duplicate check against every enrolled identity** (1:N needs every identity to be distinct) → low-limit wallet funded over CBS/UPI with a 72h expiry.
- *Existing customers:* the same phone number can sign in (OTP + PIN) or open a new wallet (OTP + PIN). Their PIN and biometrics are never replaced in this flow, so OTP access alone (e.g. a SIM swap) cannot take over an identity. Biometric changes go through re-issue (PIN + matching live scan).
- *Attended enrolment* at a branch/BC kiosk with certified devices remains the route for people without any phone.

### 6.2 Payment at a merchant (phone at home)
`/identify`: the customer scans the finger or face they chose → **1:N match** with an ambiguity margin (best match must beat the runner-up, including the same person's distress finger) → pay session. A "both" customer then scans the other factor (1:1).
`/pay`: amount within limits → **PIN** (lockout) → escalate-only risk check → **reserve** (session consumed in the same transaction) → RailsAdapter settle → **confirm on UTR** (or **release** on failure) → post-commit SMS to the customer's phone. The response carries no balance. The terminal clears itself; `/cancel` and the 2-minute expiry end abandoned sessions.
- *Why identify first, amount second:* it mirrors a card (tap, amount, PIN) and lets the merchant see the customer was recognised (masked as "Customer ••3210") before typing the bill.

### 6.3 Distress / silent SOS (re-based, compliant)
A **distinct enrolled finger** (a `purpose='distress'` fingerprint template) is matched in place of the payment finger → the **same** steps run (including the second scan for "both" customers, and the PIN) → the debit is **capped** at a low duress limit → response shapes are identical to a normal payment and the flag never leaves the server → an **async, one-directional, idempotent** SOS with the shop's name and location goes to the emergency contact (never to the customer's own phone, which may be at home) → the txn is flagged for priority AML. Reversal is best-effort.
- *Why a distinct finger, not a same-trait second template:* every finger is biometrically distinct, so the distress finger has FAR≈0 separation from the payment finger and the decision is deterministic. Two templates of the *same* trait would sit inside each other's match radius and cross-fire — a genuine payment could trip a false SOS, or a coerced user's distress attempt could match the normal finger and the silent alert would fail.
- *Why capped-with-reversal, not full completion or refusal:* refusing tips off the coercer (unsafe); completing the full attacker-demanded amount on regulated rails is unbounded authorized-but-fraudulent loss; a capped debit bounds blast radius while the pre-armed reversal gives a real recovery path.

### 6.4 Wallet lifecycle
`fund (CBS/UPI)` → `72h expiry` → **capped, AFA-gated** `/extend` (from `now()`, bounded by `max_lifetime`/`extend_count`) → at expiry an **idempotent, indexed, batched sweep** auto-refunds unspent balance to the source CBS account → wallet closed.
- *Why:* read-only expiry strands funds (a fund-trap for the unbanked) and uncapped extend makes the wallet permanent (defeats the headline 72h control).

### 6.5 Consent withdrawal (DPDP erasure)
State machine: `withdraw_requested → auth_frozen → ledger_quiesced (await in-flight UTR reconciliation, bounded timeout) → template_erased → consent_tombstone_retained`.
- *Why a state machine:* a naive immediate erase contradicts immutable AML/audit retention and orphans in-flight NPCI legs. Because audit/AML records hold **no** biometric data (reference-only), retention never forces template re-creation — erasure is terminal.

---

## 7. Compliance mapping (regulation → architectural control)

> **Qualification:** the table below maps regulations to *intended* controls. Presence of a row is **not** evidence that PulsePay is legally compliant, licensed as a Sub-AUA, or approved by RBI/UIDAI/NPCI. Partner access and audits are required before any compliance claim.

| Regulation | Requirement | Control in this design |
|---|---|---|
| RBI Storage of Payment System Data | All payment data stored only in India | India-resident inference plane + data stores + system-wide egress allow-list (§4.1) |
| RBI Master Directions — Digital Payment Security / AFA | Genuine second factor | Hard ≥2-factor floor; `face_only` deleted; AI escalate-only (§4.3) |
| UIDAI AUA/KUA + STQC devices | Aadhaar auth only via licensed AUA/KUA + registered devices | Sub-AUA connector; encrypted PID never stored; OTP server-side only (§4.6) |
| NPCI membership + UPI circulars | Use NPCI rails, not a competing PSP | RailsAdapter over UPI / 123Pay / CBS; Razorpay removed (§4.5) |
| DPDP Act 2023 | Explicit, purpose-limited, revocable consent; data-principal rights; biometrics = sensitive data | Consent Ledger + Rights Service + encrypted cancelable templates + breach notification (§4.7) |
| RBI KYC Master Direction + PMLA | Tiered KYC, CKYC, screening, STR/CTR | KYC/AML service; identity-keyed monitoring (§4.8) |
| Foundational security controls | Encryption, key management, audit, RBAC | HSM/KMS, tamper-evident audit log, scoped CORS, rate limiting, per-route authorization (§4.10) |

---

## 8. Security & threat model (selected)

| Threat | Old behavior | Control |
|---|---|---|
| Spoofing (printed photo / replay) | Haar-cascade "liveness," beaten by a photo | ISO 30107-3 PAD at the point of sale, server-scored; nonce-bound assertion |
| Account takeover via biometric leak | Face hash *is* the lookup key — permanent | Cancelable templates; identifier≠authenticator; re-issuable |
| Account takeover via key rotation | `/rotate-salt` accepts attacker-supplied hash | Re-issue requires PIN + a live scan matching the current template |
| Account takeover via phone OTP (SIM swap) | Re-enrolment reset the PIN and added templates | Existing customers need their current PIN; PIN and templates are never replaced at enrolment |
| Rogue or spoofed merchant | Unauthenticated terminal token; payout UPI from the request body | Merchant accounts (phone + OTP); payouts only to the registered UPI handle; sessions bound to one merchant |
| PIN guessing on a merchant device | Unlimited attempts | 3 wrong PINs → 30-minute lock |
| Wrong person / distress misfire in 1:N | Best score above threshold wins | Ambiguity margin over the runner-up; enrolment collision check |
| Authorization bypass | Any JWT drains/refunds/extends any wallet | Per-route ownership checks; user-scoped JWT + per-wallet authz |
| Double-spend | Read-then-write balance | Atomic locked ledger + idempotency key (one namespace) |
| Coercion (the user *is* under duress) | Separate relaxed `/distress` endpoint, distinguishable on the wire | Unified path, byte-identical response, capped debit, async one-directional SOS, pre-armed reversal |
| Secrets exposure | Hardcoded password / default JWT secret | KMS/Vault; fail-closed if unset |
| Risk-model compromise (poison/prompt-injection) | AI could downgrade to `face_only` | Escalate-only clamp `max(floor, advice)`; AI never sole gate |
| Data exfiltration abroad | Embeddings + voice to us-east-1 | System-wide India egress allow-list |
| AML structuring via serial 72h wallets | Per-wallet rules miss it | Identity-keyed cross-wallet/cross-expiry velocity |

---

## 9. Design DAG argument (not a verified no-loop proof)

> Previously titled “no drawbacks / no-loop proof.” This section is a **design argument** that candidate cycles are broken *if* the described controls are fully implemented and operated. It is **not** machine-checked, not an operational proof, and not evidence that the demo deployment is loop-free under failure.

The intended control graph is a finite DAG; every happy path terminates in a terminal state (committed / denied / refunded / erased / SOS-dispatched-once). Five candidate cycles and how the design breaks them:

1. **Enrolment ↔ Aadhaar-auth** — *broken in design:* AUA/KUA uses UIDAI registered-device biometrics, not PulsePay templates, once. (Demo: AUA is stubbed.)
2. **Consent-withdrawal ↔ AML-retention ↔ immutable-audit** — *broken by data separation:* audit/AML hold no biometric payloads; erasure of templates is terminal in the state machine (state machine partially specified; full rights service not MVP).
3. **Consent-withdrawal vs in-flight settlement** — *broken by sequencing:* wait (bounded) for NPCI legs before erase.
4. **Risk/AML alert ↔ SOS** — *broken:* SOS is idempotent per txn; AML must not re-enter SOS. Delivery is best-effort.
5. **Auth ↔ risk-engine bootstrap** — *broken:* escalate-only; cold-start uses deterministic floor; no online self-training in-path.

Idempotency and never-debit-on-rail-failure limit retry storms in the money path. See **MVP_SCOPE.md** for implemented vs mocked status.

---

## 10. High availability, SPOFs & DR

| SPOF | Mitigation |
|---|---|
| Inference plane | ≥2 India-AZ replicas + on-prem ONNX hot failover; adapter degrades to local default if a managed endpoint drifts off-allow-list; **auth fails closed**, never to a weaker matcher |
| HSM/KMS | HA cluster, key replication within India, documented availability SLA; on outage, **deny** (never cache plaintext templates) |
| SBI AUA/KUA gateway | Degraded offline **min-KYC** enrolment at the BC + queued full-KYC upgrade + circuit breaker |
| Postgres / backend / CV / OTP store | Multi-AZ Postgres (primary + sync standby, PITR, auto-failover); ≥2 stateless replicas behind a load balancer; OTP/session externalized to a Redis cluster; biometric store isolated from ledger store |
| Notification coupling | SMS/voice/SOS run post-commit on an async queue, never inside the debit transaction |

DR: documented RPO/RTO with tested runbooks (build Phase 14).

---

## 11. Open decisions (see also MVP_SCOPE.md)

| Decision | Status | Blocker |
|---|---|---|
| MVP: family/delegates | **Deferred** from MVP acceptance (code may remain) | Product timebox |
| Settlement: CBS-per-user vs pooled sub-ledger | **Demo chooses pooled sub-ledger** | SBI confirmation / PPI classification |
| RBI/NPCI numeric thresholds | provisional env defaults | Current circulars |
| Distress finger UX under stress | decided modality; UX unvalidated | Field trial |
| Notification channel | open | Phone-light vs feature-phone reality |
| Customer ID method defaults (fingerprint / face / both) | customer's choice | Field trial |
| Distress reversal authority | open; SOS/reversal best-effort in demo | Fraud desk policy |
| STQC devices + Sub-AUA sponsorship | open / not obtained | SBI + UIDAI |
| Cost / owners / field-trial budget | unknown | No specialist owners in this repo |

---

*Companions: [MVP_SCOPE.md](MVP_SCOPE.md) (acceptance + honesty matrix) · [PLAN.md](PLAN.md) (build sequence).*
