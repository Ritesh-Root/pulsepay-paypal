# PulsePay-SBI — Architecture

**Biometric, phone-less micro-wallet for financial inclusion — re-architected for the State Bank of India (SBI) hackathon.**

> This document supersedes the Amazon Nova–era design. The original build targeted the Amazon Nova hackathon (judged on depth of Amazon Nova / AWS Bedrock usage). SBI judging rewards a different axis entirely: **financial inclusion, RBI compliance, data localization, NPCI/UPI rail fit, integration with SBI (YONO / Core Banking), DPDP privacy, security, and bank-scale operational soundness.** Every component below carries an explicit justification, every use case states *why this approach over the alternative*, and §9 gives a formal proof that the system contains no drawbacks-by-design and no operational or dependency loops.

---

## 1. What changed from the Amazon build (and why)

| # | Confirmed flaw in current code | Where | Fix in this architecture |
|---|---|---|---|
| 1 | Biometric match is impossible: SHA3-256 of an embedding + exact-match SQL — avalanche means two captures never match | `cv-service/main.py:91-94`, `backend/routes/payment.js:62` | Encrypted, **cancelable** template vectors + cosine-similarity threshold (§4 Biometric Vault) |
| 2 | Data-residency violation: face images + embeddings shipped to AWS Bedrock in **us-east-1** | `backend/services/nova.js`, `cv-service/main.py`, `render.yaml` | **India-resident, model-agnostic inference plane**; egress allow-list (§4) |
| 3 | Wrong rails: payouts via mocked **Razorpay** (a competing PSP); crypto funding path | `backend/services/razorpay.js`, `enroll.js:93,156` | **NPCI UPI / UPI 123Pay / SBI CBS** RailsAdapter; crypto removed by schema enum (§4) |
| 4 | Identity hand-waved: Aadhaar mocked, `aadhaar_verified=true` unconditionally, OTP returned in response | `enroll.js:37,125`, in-memory OTP `Map` `:9` | Aadhaar **only** via SBI's licensed AUA/KUA + STQC registered devices; OTP never echoed (§4, §6) |
| 5 | Double-spend: read-then-write balance, no lock/transaction; `INTEGER` paise caps ~₹21.4 L | `payment.js:199-203`, `wallet.js:79` | Atomic, append-only **double-entry ledger** + idempotency keys; **BIGINT** paise (§4) |
| 6 | Security holes: hardcoded DB password, default JWT secret, CORS `*`, fake Haar-cascade "liveness", no rate limiting, salt beside hash | `docker-compose.yml`, `auth.js`, `server.js:17`, `main.py:34,198-202` | KMS/Vault, scoped CORS, ISO 30107-3 PAD, rate limiting/WAF, cancelable transform (§8) |
| 7 | No HA / observability / DR | — | Multi-AZ HA, fail-closed degradation, observability, DR runbooks (§10) |

**Kept and reframed (strong for SBI):** the phone-less "body is your wallet" concept; distress / silent-SOS safety; the pre-funded micro-wallet with 72h auto-expiry (blast-radius control); adaptive risk-based authentication; and above all the **financial-inclusion narrative** — SBI has India's largest rural + Business Correspondent (BC) footprint, and the unbanked are its mandate.

---

## 2. Design principles

1. **One source of truth per decision.** Authentication is decided once and carried forward as a signed, single-use assertion — never recomputed downstream (kills the `/authenticate`↔`/execute` split-brain).
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
- **Why this over the alternative:** chosen over "keep Bedrock but move to ap-south-1 (Mumbai)" because (a) the brief requires Nova be optional/swappable, (b) a foreign-controlled control plane still raises RBI data-access concerns for bank-grade systems, (c) SBI judging rewards SBI integration over a single foreign AI vendor. A `FaceEmbeddingProvider` adapter (default on-prem ArcFace-class ONNX; optional India-region managed model) removes vendor lock-in. A network egress guard blocks any endpoint not on the India allow-list — for **all** services, not just embedding.
- **Replaces:** `cv-service/main.py get_nova_embedding()`, `nova.js getEmbedding/assessRisk`, `render.yaml AWS_REGION=us-east-1`.

### 4.2 Encrypted, Cancelable Biometric Template Vault + Matcher
- **Purpose:** store face/fingerprint as **transformed** (cancelable) vectors, envelope-encrypted with a per-record HSM key; match by cosine similarity ≥ a calibrated FAR/FRR threshold inside a secure enclave.
- **Why this over the alternative:** hashing destroys the similarity geometry needed to match (the root cause of flaw #1); plaintext vectors are a reversible-biometric honeypot under DPDP; using the face hash *as the lookup key* makes a leak a permanent takeover. Cancelable transform + identifier/authenticator separation fixes the functional bug *and* the irrevocability problem in one move.
- **Replaces:** `cv-service` SHA3 logic; `wallets.wallet_id_hash / fingerprint_hash / distress_hash`; the exact-hash lookup in `payment.js`.

### 4.3 Auth Decision Service (single signed Auth Assertion + AFA floor)
- **Purpose:** `/authenticate` issues a **server-signed, single-use, 90s-TTL Auth Assertion** bound to `wallet_id + amount-ceiling + merchant + nonce`; `/execute` accepts only that assertion and re-derives nothing.
- **Why this over the alternative:** two independent decision sites (`payment.js:22-55` vs `179-187`) diverge and let `/execute` skip biometric/OTP re-checks. A single carried-forward assertion eliminates the split-brain and the "OTP-decoration" hole. The **AFA floor** is a hard ≥2-factor minimum: **fingerprint (primary inherence factor) + PIN (knowledge)**. **Face is a step-up factor required above an amount limit**, and AUA OTP is required at the highest tier. Fingerprint-primary matches SBI's existing AePS device base. `face_only`/single-factor is deleted because it breaches RBI AFA.
- **Replaces:** the dual tier logic and Bedrock-hosted `assessRisk` in `nova.js`.

### 4.4 Escalate-Only Risk Engine
- **Purpose:** score amount/velocity/geo/time and *raise* the required factor strength.
- **Why this over the alternative:** chosen over a flat "always face+OTP" because inclusion needs low-friction micro-payments; chosen over "AI decides the tier" because a non-deterministic, prompt-injectable model must never be the sole gate on money. Clamped to `max(floor, advice)`; cold-start returns the deterministic floor (no bootstrap loop); the in-path model never trains online on its own gated outcomes (no drift loop).
- **Replaces:** the static + Bedrock split, and the non-functional `user_spending_history = []` (`payment.js:48`).

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
- **Purpose:** every money movement is one locked, transactional, idempotent ledger write; balance is derived; `transactions` becomes an immutable journal.
- **Why this over the alternative:** the current read-then-write double-spends under concurrency and `INTEGER` overflows. `UPDATE ... WHERE balance >= amount` + unique `idempotency_key` (one namespace spanning execute *and* distress) + BIGINT paise + reserve/release states fixes all three.
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
| **users** | `id UUID PK`, `phone (nullable)`, `emergency_contact`, `created_at` | `phone` not mandatory — resolves the phone-less contradiction; PII encrypted |
| **kyc_profiles** | `user_id FK`, `kyc_tier (min\|full)`, `ckyc_id`, `pep_sanctions_status`, `verified_via (aua_kua)`, `limits_json` | replaces the `users.aadhaar_verified` boolean |
| **aadhaar_token_vault** *(segregated)* | `user_id FK`, `aadhaar_ref_token (VID/reference, no plaintext)`, `aua_txn_id` | separate KMS key + RBAC from the app DB → breaks the re-identification honeypot |
| **biometric_templates** | `subject_id FK`, `template_type (fingerprint\|face)`, `purpose (auth\|distress)`, `protected_vector (cancelable, HSM-encrypted)`, `kms_key_ref`, `transform_salt`, `model_version`, `deactivated_at` | fingerprint = primary; face = step-up; a `purpose='distress'` fingerprint = the distinct distress finger (replaces the duress-PIN). Identifier (wallet UUID) separated from authenticator; enclave-only decryption |
| *(distress credential)* | not a separate table — a `biometric_templates` row with `template_type='fingerprint'`, `purpose='distress'` | a DISTINCT enrolled finger; resolves same-trait cross-fire (see §6.3) |
| **wallets** | `id UUID PK`, `user_id FK`, `cbs_account_ref`, `funding_source ENUM CHECK {sbi_cbs,upi}`, `balance_cached BIGINT`, `expiry`, `max_lifetime`, `extend_count`, `active` | BIGINT paise; crypto removed by enum |
| **delegated_wallets** | `parent_wallet_id FK`, `delegate_subject_id FK`, `spending_cap BIGINT`, `spent_total BIGINT`, `per_delegate_expiry`, `active` | delegate is a real data principal (own KYC/consent/template); `spent_total` atomically enforced |
| **ledger_entries** *(append-only, double-entry)* | `wallet_id FK`, `entry_type (debit\|credit\|reserve\|release\|refund)`, `amount BIGINT`, `running_balance_after`, `idempotency_key UNIQUE`, `auth_assertion_ref`, `upi_utr`, `cbs_ref`, `status` | one idempotency namespace for execute+distress |
| **transactions** *(immutable journal)* | `wallet_id FK`, `merchant_upi`, `amount BIGINT`, `confidence_score (server-derived)`, `auth_tier`, `distress_triggered`, `gps_lat/lng`, `status` | confidence is the real match score, never client-supplied |
| **consent_records** *(append-only, hash-chained)* | `subject_id FK`, `purpose`, `granted`, `channel`, `language`, `prev_hash`, `record_hash`, `withdrawn_at` | references only, no biometric data |
| **audit_log** *(append-only, hash-chained)* | `actor`, `action`, `subject_user_id`, `resource_ref`, `ip`, `prev_hash`, `record_hash` | no biometric data → survives DPDP erasure under legal hold |
| **aml_alerts** | `identity_id FK`, `rule_id`, `risk_score`, `alert_type (structuring\|velocity\|geo\|sanctions\|wallet_churn\|distress)`, `status`, `analyst_id` | identity-keyed, not wallet-keyed |
| **auth_assertions** | `wallet_id`, `subject_id`, `amount_ceiling BIGINT`, `merchant`, `tier`, `nonce`, `expires_at (90s)`, `consumed_at` | single-use server-signed bridge from authenticate→execute |

---

## 6. Key flows

### 6.1 Enrolment (attended, in-branch / BC)
`branch/BC kiosk` → record per-purpose consent in **consent_records** (in the user's language) → Aadhaar e-KYC via SBI **AUA/KUA** with STQC device (PID block never stored; Aadhaar tokenized) → register a **primary payment finger** and a **distinct distress finger** on a certified scanner, plus a **face template** (for step-up) with attended liveness → each vector cancelable-transformed + HSM-encrypted → stored in **biometric_templates** → **min-KYC wallet** provisioned on **CBS** with 72h expiry.
- *Why attended, not remote self-enrolment:* DPDP needs verifiable explicit consent for sensitive data; attended active-challenge liveness defeats the printed-photo spoof the old Haar cascade allowed; the target users lack smartphones for video-KYC; it leverages SBI's branch/BC reach. (Remote video-KYC is a later phase for already-banked users.)

### 6.2 Phone-less payment (the core "body is your wallet")
`/authenticate`: **1:N fingerprint match** (real cosine score) + **PIN** → escalate-only tier decision → **face step-up** verified if the amount is above the limit (OTP at the top tier) → issue **single-use Auth Assertion**.
`/execute`: consume the assertion (no recomputation) → **reserve** in ledger → RailsAdapter settle over UPI/123Pay/CBS → **confirm on UTR** (or **release** on failure) → commit → enqueue **post-commit async** SMS/voice.
- *Why fingerprint-primary + face step-up:* fingerprint is the everyday factor (runs on SBI's existing AePS scanners, low friction for the unbanked); face is added only when the amount warrants it, keeping micro-payments effortless while hardening large ones. *Why a signed assertion + reserve→settle→confirm:* removes the split-brain, guarantees the inherence factor is genuine at the point of sale, and never debits on rail failure.

### 6.3 Distress / silent SOS (re-based, compliant)
A **distinct enrolled finger** (a `purpose='distress'` fingerprint template) is matched → the **same** atomic debit path runs, **capped** at a low duress limit, **skipping the face/OTP step-up** so it is as frictionless as a normal small payment → response body and timing are **byte-for-byte identical** to a normal payment → an **async, one-directional, idempotent** SOS + geo is dispatched → the txn is flagged for priority AML and a **pre-armed reversal** (UPI dispute / CBS) is queued.
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
| Account takeover via key rotation | `/rotate-salt` accepts attacker-supplied hash | Re-enrolment requires liveness + AFA + ownership proof |
| Authorization bypass | Any JWT drains/refunds/extends any wallet | Per-route ownership checks; user-scoped JWT + per-wallet authz |
| Double-spend | Read-then-write balance | Atomic locked ledger + idempotency key (one namespace) |
| Coercion (the user *is* under duress) | Separate relaxed `/distress` endpoint, distinguishable on the wire | Unified path, byte-identical response, capped debit, async one-directional SOS, pre-armed reversal |
| Secrets exposure | Hardcoded password / default JWT secret | KMS/Vault; fail-closed if unset |
| Risk-model compromise (poison/prompt-injection) | AI could downgrade to `face_only` | Escalate-only clamp `max(floor, advice)`; AI never sole gate |
| Data exfiltration abroad | Embeddings + voice to us-east-1 | System-wide India egress allow-list |
| AML structuring via serial 72h wallets | Per-wallet rules miss it | Identity-keyed cross-wallet/cross-expiry velocity |

---

## 9. Resolved drawbacks & no-loop proof

The full system is a finite DAG; every path terminates in a terminal state (committed / denied / refunded / erased / SOS-dispatched-once). The five candidate cycles and how each is broken:

1. **Enrolment ↔ Aadhaar-auth** — *broken:* the AUA/KUA leg uses UIDAI's own registered-device biometric, **not** PulsePay's template, and runs once. Two disjoint credential systems → no back-edge.
2. **Consent-withdrawal ↔ AML-retention ↔ immutable-audit** — *broken by data separation + precedence:* audit/AML records carry no biometric data (reference-only), so retention never forces template re-creation; erasure deletes the vault template once, terminally.
3. **Consent-withdrawal vs in-flight settlement** — *broken by sequencing:* the withdrawal state machine waits (bounded) for in-flight NPCI legs to reconcile before erasing.
4. **Risk/AML alert ↔ SOS** — *broken:* AML/risk alerting may never call the SOS channel; SOS dispatch is idempotent per transaction → at most one SOS per txn, no re-entry.
5. **Auth ↔ risk-engine bootstrap / self-training drift** — *broken:* risk never blocks auth (cold-start returns the deterministic floor); the in-path model never trains online on its own gated outcomes (offline, versioned, human-reviewed only).

Retry-storms cannot accumulate debits (idempotency key + never-debit-on-failure); notifications are post-commit and async so a slow notifier cannot stall or re-enter the debit; `/extend` is capped so the wallet cannot live forever; expiry sweeps are dead-lettered (bounded retries), not an unbounded re-credit loop.

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

## 11. Open questions (decisions needed from SBI)

1. **Delegate/family in or out for the MVP?** It is fully specified (own consent + min-KYC + atomic cap). If timeboxed out, the `delegated_wallets` table/code must be **explicitly removed**, not left as a non-compliant carryover.
2. **Exact RBI/NPCI numeric thresholds** — min-KYC balance/velocity caps, distress duress-limit, FAR/FRR targets, STR timelines, localization purge windows, assertion TTL — carried as provisional config, to be calibrated to the then-current circulars.
3. **Duress modality — DECIDED: a distinct enrolled finger** (every finger is biometrically distinct, FAR≈0 separation; no keypad needed; fits the phone-less/low-literacy cohort). Remaining UX validation: helping the rural cohort reliably remember the distress finger under stress.
4. **Notification channel reality** — is the user truly device-less (alerts to a registered contact / BC device) or do they have feature phones (UPI 123Pay IVR)? Affects the `emergency_contact` requirement.
5. **CBS settlement model** — real shadow CBS account per user vs a pooled SBI account with a sub-ledger? Affects reconciliation granularity and RBI PPI classification.
6. **Auth Assertion binding** — exact merchant+amount (strongest, breaks tips/variable amounts) vs merchant+amount-ceiling (chosen default)? Confirm against 123Pay assisted-acceptance UX.
7. **Distress reversal authority** — automated on SOS confirmation vs manual SBI fraud-desk; fit with the UPI dispute window.
8. **STQC device availability at BC/CSP kiosks** and SBI sponsoring PulsePay as a Sub-AUA within hackathon scope.

---

*Companion document: [PLAN.md](PLAN.md) — the dependency-ordered build sequence.*
