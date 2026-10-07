# PulsePay MVP scope & honesty matrix

This document freezes what **this repo** implements today versus what remains partner- or hardware-blocked. Architecture choices here are **not** evidence of legal compliance, certified biometrics, or production readiness.

---

## 1. MVP acceptance scope (frozen)

| In scope (demo) | Deferred |
|---|---|
| Enrolment flow (OTP → biometrics → PIN → fund wallet) | Family / delegate spend (code may exist; **not** MVP acceptance) |
| Pay / Send (authenticate → execute → balance + transactions update) | Real SBI CBS / NPCI UPI switch / UPI 123Pay |
| Request (QR + copyable code + share/clipboard) | Real UIDAI AUA/KUA + STQC devices |
| Balance + transactions list | HSM / certified PAD / measured FAR–FRR |
| Distress finger path (unified pay; capped; SOS best-effort) | Production AML engines, multi-AZ deploy, indexing systems |
| Bank screen (pooled sub-ledger refs; extend / refund) | Field trial, penetration-test sign-off |

**Success for this build** means someone can run the stack and complete: enrol (or use the demo wallet) → Home → Send (amount and description editable; balance and transactions update) → Request (code visible; copy or share) → Bank → Home and Profile.

---

## 2. Settlement model (ONE choice)

**Decision: pooled SBI sub-ledger (demo).**

- Customer wallets are rows with a `cbs_account_ref` shadow id; funds are tracked in the local double-entry ledger against counterpart `pool:sbi_pulsepay` / `merchant:<upi>`.
- Rails (`services/rails.js`) are **stubs** that return synthetic UTRs.
- **Status:** demo decision pending SBI confirmation of CBS-per-user vs pooled PPI classification.
- **Do not** implement a second settlement system in this codebase.

---

## 3. Feature matrix

| Capability | Status | Notes |
|---|---|---|
| Enrolment UI + API | implemented / partially tested | AUA OTP **mocked** (`services/aua.js`); webcam ≠ fingerprint scanner |
| Fingerprint / face match | mocked | Cancelable vectors + cosine threshold in code; **FAR/FRR unmeasured**; 1:N scale **unproven** |
| PAD / liveness | mocked | Not ISO 30107-3 certified |
| Auth assertion + PIN floor | implemented | |
| Face step-up / OTP tier | implemented (OTP mocked) | |
| Double-entry ledger (balanced request groups) | implemented | Unit-tested balance helper; DB integration needs Postgres |
| Reserve → settle → confirm | implemented (rail stub) | |
| Pending + idempotent reconcile if confirm fails after rail OK | implemented | Status `pending`; retry `/execute` |
| Distress unified path | implemented | Not invisible to attacker — amount/UI/timing can leak; SOS/reversal **best-effort** |
| Family delegates | implemented in code | **Deferred** from MVP acceptance |
| Request QR / share | implemented (frontend) | |
| Send UI → live pay | implemented when session exists | Else demo localStorage ledger |
| Compliance (RBI/DPDP/UIDAI) | design intention only | Not verified; no legal sign-off |
| “No drawbacks / no-loop proof” | design argument | **Not** a verified formal proof against production ops |

---

## 4. Auth policy matrix

| Flow | Required | Skipped | Closed vs exception |
|---|---|---|---|
| Normal pay | Fingerprint match + PIN; face if tier requires; OTP if top tier | — | Fail-closed on mismatch / rail fail |
| Distress pay | Distinct distress finger + PIN | Face/OTP step-up | Same response shape as normal; **amount capped**; SOS async best-effort |
| Enrolment when AUA mocked / outage | Demo OTP path in stub | Real UIDAI | Fail-closed if KMS/JWT unset at boot; AUA stub is the **documented demo exception** |

Distress is **not** invisible: coerced amount, merchant UI, and timing can still leak. Reversal and SOS are **not guaranteed**.

---

## 5. Biometrics (honest)

Webcam / demo capture is a **mock** stand-in for AePS. Templates are encrypted cancelable vectors in this repo’s design, but:

- FAR / FRR are **unmeasured**
- 1:N identification at bank scale is **unproven**
- No certified PAD numbers are claimed

---

## 6. Data lifecycle (short)

| Deleted / deactivated on re-issue or wallet close | May remain |
|---|---|
| Active biometric template rows (`active=false`, new salt) | Prior ciphertext until operational purge |
| Live wallet balance (refund → 0, inactive) | `ledger_entries`, `transactions`, `audit_log`, `aml_alerts` (reference-only; no raw biometrics by design) |
| Session JWT in browser (clear session) | Server logs, backups, stub SMS provider logs if enabled |

No separate deletion subsystem ships in this demo beyond template deactivation + wallet refund.

---

## 7. Open decisions

| Decision | Status | Blocker |
|---|---|---|
| Settlement confirmation with SBI (pooled vs CBS-per-user) | open — demo uses pooled | SBI product / compliance |
| STQC / AePS device access at BC | open | Hardware + SBI ops |
| Distress reversal authority | open — best-effort flag only | Fraud desk / UPI dispute policy |
| Notification model (contact vs feature phone / 123Pay IVR) | open — stub SMS/SOS | Channel reality for phone-light users |
| Cost model | unknown | No specialist owners; no field-trial budget in this repo |
| Numeric RBI/NPCI thresholds | provisional env defaults | Current circulars |

---

## 8. Demo success criteria (measurable here) vs production (unset)

**Demo (this repo can check):**

1. Frontend builds; Home shows balance + txs in mint UI.
2. Send edits amount/description; demo or live path updates balance/txs.
3. Request shows QR + code; copy/share works (clipboard fallback).
4. Bank shows pooled refs; extend/refund call live API when enrolled.
5. `npm test` in `backend/` passes ledger balance unit tests.
6. Enrol + merchant pay still reachable from Profile.

**Production targets:** unset (FAR/FRR, latency SLOs, RPO/RTO, legal compliance) — not claimed.
