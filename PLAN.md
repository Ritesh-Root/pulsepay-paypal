# PulsePay-SBI — Build Plan

**Biometric, phone-less micro-wallet for financial inclusion — build plan for the State Bank of India (SBI) hackathon.**

> **Re-targeting note.** The previous `PLAN.md` (preserved in git history) targeted the *Amazon Nova* hackathon and was scored on depth of Amazon Nova / AWS Bedrock usage. This plan targets **SBI**, which judges financial inclusion, RBI compliance, data localization, NPCI/UPI rail fit, integration with SBI (YONO / Core Banking), DPDP privacy, security, and bank-scale soundness. Amazon Nova is reduced to **one optional, swappable provider** behind a model-agnostic interface — never a hard dependency, never in the data-residency path.
>
> Read [ARCHITECTURE.md](ARCHITECTURE.md) before building. This plan is the dependency-ordered sequence; the architecture is the *why*.

---

## 1. Mission

Let an unbanked or phone-less person pay with their body — **fingerprint + PIN, with a face step-up on larger amounts** — at an SBI merchant / Business Correspondent (BC), funded from a pre-paid, auto-expiring micro-wallet on SBI's books, with a silent distress mode (a distinct finger) for coercion safety. **Every rupee moves over NPCI/SBI rails, every byte of biometric data stays in India, and every payment is RBI-AFA compliant.**

---

## 2. Use-case catalogue (each justified)

Every use case states **why it exists** and **why this approach over the alternative.**

1. **Assisted in-branch / BC biometric enrolment with consent.**
   *Why:* the legal basis for capturing biometrics (DPDP explicit consent) + RBI in-person KYC; the entry point for the unbanked.
   *Why this way:* attended capture over unattended self-enrolment — consent is verifiable at an SBI touchpoint, active-challenge liveness defeats the printed-photo spoof, the target users lack smartphones for video-KYC, and it leverages SBI's branch/BC footprint.

2. **Phone-less micro-payment with AFA** (the core "body is your wallet").
   *Why:* demonstrates the headline value while staying RBI-AFA compliant.
   *Why this way:* **fingerprint + PIN** as the base two factors (fingerprint runs on SBI's existing AePS scanners), with a **face step-up above an amount limit** and OTP at the top tier — never the deleted single-factor `face_only`; UPI 123Pay rails (NPCI's phone-less product) over a third-party PSP; a single signed Auth Assertion over dual recomputation.

3. **Distress payment + silent SOS** (compliant, re-based).
   *Why:* user-safety under coercion — transact while silently alerting SBI/contacts.
   *Why this way:* a **distinct distress finger** (every finger is biometrically distinct → FAR≈0 separation; not a same-trait second template, which cross-fires); a **capped** debit with a pre-armed reversal (not full completion = unbounded loss, not refusal = tips off coercer); the **same** atomic ledger + byte-identical response (a separate endpoint leaks "silence" and re-introduces double-spend).

4. **Delegate / family spend** (first-class).
   *Why:* SBI family-inclusion (a parent funding a child/elder/dependent).
   *Why this way:* full data-principal treatment (own consent, own min-KYC, owner-authenticated enrolment, atomic cumulative cap) over the code's consent-free, auth-free, uncapped carryover.

5. **Data-principal rights & consent withdrawal.**
   *Why:* mandatory under DPDP — view/correct/erase/withdraw + grievance.
   *Why this way:* a withdrawal **state machine** (quiesce in-flight settlement → erase template → retain reference-only AML/audit under legal hold) over naive immediate-erase, which contradicts AML retention and orphans in-flight legs.

6. **AML monitoring & STR/CTR reporting.**
   *Why:* PMLA/RBI — continuous monitoring, screening, reporting to SBI's FIU.
   *Why this way:* continuous **identity-keyed** cross-wallet/cross-expiry monitoring over onboarding-only / per-wallet screening — structuring shows up across wallets, not at one wallet.

7. **Wallet lifecycle: fund (CBS/UPI) → 72h expiry → capped extend → auto-sweep refund.**
   *Why:* the pre-funded micro-wallet with blast-radius control; RBI small-PPI fit.
   *Why this way:* enforced expiry + capped, AFA-gated extend + automated ledgered sweep over read-only expiry + uncapped extend (which strands funds and makes the wallet permanent). Funding restricted to CBS/UPI by enum — crypto is an AML/FEMA non-starter.

8. **Wallet view + cancelable biometric re-issuance.**
   *Why:* users must see balance/history and recover from a compromised template.
   *Why this way:* re-enrolment with liveness + AFA + ownership over the code's `rotate-salt` accepting an arbitrary new hash (a one-call takeover primitive); ownership-checked reads over body-supplied `wallet_id` (which lets any JWT read any wallet).

**Explicitly excluded (with justification):** crypto funding (AML/FEMA); Nova-LLM-as-inline-risk-*decider* (non-deterministic, prompt-injectable, residency-violating — replaced by a deterministic escalate-only scorer); unauthenticated voice endpoint; client-supplied `confidence_score`; mock Razorpay payout; mock Aadhaar / OTP-in-response.

---

## 3. Build sequence (dependency-ordered — no forward references)

Each phase depends **only** on earlier phases, so the build graph topologically sorts as listed and contains no cycles. Phase 7 (rails) depends only on infra+ledger and can be built in parallel with Phases 2–6.

### Phase 0 — Landing zone & security baseline · `depends_on: []`
- Provision an India-region landing zone (SBI on-prem / MeitY-empanelled India cloud). Make region a **deploy-time policy guardrail** (deny non-India), not an env var.
- Stand up an **HA HSM/KMS cluster** (India-resident, key replication) and a Vault/secrets manager.
- Stand up **multi-AZ HA Postgres** (primary + sync standby, PITR), a **Redis cluster**, private subnets, an API gateway with WAF, **CORS allow-list**, and rate limiting.
- Centralized observability (structured logs, metrics, tracing) + an immutable audit-log sink.
- **Delete:** hardcoded secrets (`pulsepay123`, `dev_jwt_secret_key`), CORS `*`, the Render/us-east-1 manifests, Razorpay, the crypto funding path, the dev JWT fallback.

### Phase 1 — Data model & ledger primitives · `depends_on: [0]`
- Create all tables (ARCHITECTURE §5) with **BIGINT-paise + CHECK** constraints, the `funding_source` enum, and the segregated Aadhaar token vault.
- Append-only **double-entry ledger** + unique `idempotency_key` + tamper-evident hash-chained `audit_log` + `consent_records`.
- Schema, constraints, and encryption-at-rest only — no business logic yet.

### Phase 2 — India-resident, model-agnostic inference plane · `depends_on: [0,1]`
- Biometric embedding provider interface (fingerprint + face); default on-prem ONNX (ArcFace-class) model + fingerprint extractor; ≥2 AZ replicas + hot failover; system-wide egress allow-list.
- ISO 30107-3 PAD / liveness service; server-side confidence = the real similarity score.
- Fail-closed behavior + circuit breakers.

### Phase 3 — Protected biometric template vault + matcher · `depends_on: [0,1,2]`
- Cancelable transform + per-record HSM envelope encryption; cosine-threshold matcher inside the enclave; identifier (UUID) separated from authenticator (template); calibrate FAR/FRR.

### Phase 4 — Consent ledger & DPDP rights service · `depends_on: [1,3]`
- Per-purpose append-only consent capture; rights API (access/correct/erase) with the withdrawal **state machine**; legal-hold precedence (erase template, retain reference-only AML/audit); breach-notification + grievance-officer workflow.

### Phase 5 — Identity/KYC via AUA-KUA + KYC/AML service · `depends_on: [0,1,4]`
- Sub-AUA connector to SBI's AUA/KUA + STQC registered devices (encrypted PID, tokenized Aadhaar in the segregated vault, OTP server-side only — never echoed).
- Tiered KYC (min/full), CKYC, sanctions/PEP screening; degraded offline min-KYC + queued upgrade + circuit breaker.

### Phase 6 — Enrolment use case · `depends_on: [2,3,4,5]`
- Attended branch/BC enrolment: consent → AUA e-KYC → register primary finger + **distinct distress finger** + face (liveness) templates → min-KYC wallet on CBS with 72h expiry.

### Phase 7 — Rails adapter + atomic settlement · `depends_on: [0,1]`
- `RailsAdapter` over NPCI/UPI/123Pay/CBS; **reserve → settle → confirm (UTR)**, release-on-failure; UTR/CBS reconciliation job. (Build in parallel with 2–6.)

### Phase 8 — Auth decision service · `depends_on: [3,5]`
- `/authenticate` issues a signed, single-use **Auth Assertion**; deterministic statutory floor; **escalate-only** risk scorer with cold-start default; OTP/UPI-PIN verified against an issued challenge.

### Phase 9 — Payment execution (unified debit path) · `depends_on: [1,7,8]`
- `/execute` consumes **only** the Auth Assertion; atomic idempotent ledgered debit; ownership/authorization on every route; reserve→settle→confirm via Phase 7.

### Phase 10 — Distress path · `depends_on: [8,9]`
- Distress = the same debit path triggered by the **distinct distress finger**; capped/decoy debit; byte-identical response; async one-directional SOS; pre-armed reversal; priority AML flag.

### Phase 11 — Delegate / family · `depends_on: [3,4,5,9]`
- Owner-authenticated delegate enrolment (own consent + min-KYC + template); atomic cumulative cap; per-delegate expiry; parent notification; AML attribution.

### Phase 12 — Async notifications & confirmations · `depends_on: [9]`
- Post-commit queued SMS (India DLT gateway) + India-resident/edge Indic-language voice; never inside the debit transaction.

### Phase 13 — Wallet lifecycle jobs · `depends_on: [7,9]`
- Idempotent batched expiry-sweep auto-refund to CBS; capped AFA-gated extend; cancelable biometric re-issuance (liveness + AFA + ownership).

### Phase 14 — AML, reconciliation, DR · `depends_on: [5,7,9,10,11]`
- Identity-keyed cross-wallet velocity/structuring; STR/CTR to FIU; UTR/CBS reconciliation; documented RPO/RTO + tested DR runbooks.

---

## 4. Definition of done (acceptance criteria mapped to the fixed flaws)

A phase/feature is done only when the corresponding flaw is provably closed:

- [ ] **Biometric match works:** two separate captures of the same enrolled person authenticate via cosine threshold (not hash equality). *(Flaw 1)*
- [ ] **Residency:** no biometric/payment data leaves India; the egress allow-list blocks all non-India endpoints across backend, CV, and voice. *(Flaw 2)*
- [ ] **Rails:** settlement flows over UPI/123Pay/CBS with a real UTR; Razorpay and the crypto path are removed from code and schema. *(Flaw 3)*
- [ ] **Identity:** Aadhaar runs only through SBI's AUA/KUA; OTP never appears in any response; Aadhaar tokenized in the segregated vault. *(Flaw 4)*
- [ ] **No double-spend:** concurrent `/execute` calls with the same idempotency key debit exactly once; balance never goes negative; amounts are BIGINT. *(Flaw 5)*
- [ ] **AFA floor:** no payment completes with a single factor; the risk engine can only raise, never lower, the tier. *(Flaw 4/6)*
- [ ] **Authorization:** no route accepts a body-supplied `wallet_id` without an ownership/RBAC check. *(Flaw 6)*
- [ ] **Liveness:** a printed photo fails PAD at the point of sale. *(Flaw 6)*
- [ ] **Distress is indistinguishable** on the wire and bounded in loss, with a pre-armed reversal. *(Distress)*
- [ ] **HA/DR:** each SPOF in ARCHITECTURE §10 has a tested failover or fail-closed path. *(Flaw 7)*
- [ ] **No loops:** the five candidate cycles in ARCHITECTURE §9 are each demonstrably broken.

---

## 5. Open questions (decide before/with SBI)

See [ARCHITECTURE.md §11](ARCHITECTURE.md). The blocking one for scope: **is delegate/family in the MVP?** If not, remove the `delegated_wallets` table and code entirely — do not ship it as a non-compliant carryover. The rest (RBI/NPCI numeric thresholds, duress modality, notification channel, CBS settlement model, assertion binding, reversal authority, STQC device availability) are parameterized as provisional config and need SBI confirmation, not a code rewrite.

---

## 6. One-line pitch for the SBI panel

> *PulsePay lets an unbanked Indian pay with their fingerprint at any SBI Business Correspondent — a face scan adds security on larger amounts — with money on SBI's books, over UPI 123Pay, biometrics encrypted and never leaving India, RBI-AFA compliant, and a silent distress mode (a distinct finger) for coercion safety. Financial inclusion, built on SBI's own rails.*
