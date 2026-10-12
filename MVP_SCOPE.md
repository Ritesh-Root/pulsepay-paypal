# PulsePay MVP scope & honesty matrix

What this repository implements today, what was tested against real services, and what is simulated. Nothing here is a claim of production readiness, certified biometrics, or regulatory approval.

---

## 1. Acceptance flow

Someone can run the stack and:

1. Enrol on their phone: phone code → choose fingerprint / face / both → scans (+ optional distress finger) → PIN → **top up with PayPal**.
2. Sign a merchant in (phone code, shop name, PayPal payout email).
3. Pay at the merchant terminal: scan → identified (masked) → amount → PIN → paid → customer signed out automatically.
4. See the sale on the merchant dashboard and **cash out to PayPal**; ask the AI assistant about sales, refunds, cash-outs and invoices.
5. Close the wallet and get the balance **refunded to PayPal**.

---

## 2. Feature matrix

| Capability | Status | How it was verified |
|---|---|---|
| Enrolment + chosen ID method (fingerprint / face / both) | implemented | API end-to-end tests; UI sign-in path in browser |
| Biometric 1:N match with ambiguity margin, collision check | implemented (demo-grade vectors) | unit + end-to-end tests; **FAR/FRR unmeasured** |
| Liveness / PAD | placeholder | a printed photo passes; flag is client-asserted |
| Pay session (identify → amount → PIN, single use, 2 min, cancel) | implemented | end-to-end tests |
| PIN lockout (3 tries / 30 min) | implemented | end-to-end tests |
| Distress finger (capped $25, silent SOS, AML alert, same screens) | implemented | end-to-end tests |
| **PayPal Checkout top-up** (JS SDK v6 + Orders v2 create/capture) | implemented | REST client tested against a local fake PayPal (declines, lost responses, amount mismatch, unconfirmed-capture sweep). **Live sandbox:** OAuth, order creation and the refusal to capture an unapproved order verified; buyer approval + capture still to run in a browser |
| **Refund to PayPal captures** on wallet close | implemented | fake PayPal: newest capture first, retry after failure, lost response refunded once; live sandbox pending |
| **PayPal Payouts** to merchants (instant + cash-out) and payees | implemented | fake PayPal: pending to success, returned items, lost response paid once, 5xx retried. **Live sandbox:** refused with `PAYOUT_NOT_AVAILABLE` ("You live in a country that is not allowed to send this payout"): PayPal blocks payouts from India-based sandbox accounts; needs a US business sandbox account |
| **PayPal webhooks** (signature-verified; payouts, disputes, invoices) | implemented | fake PayPal: verified, unverified, redelivered and duplicate events; real deliveries need a public URL (Render) |
| Double-entry ledger (wallet / pool / merchant / payee) | implemented | every group balanced; wallet balances and the pool reconcile in tests |
| AI merchant assistant (GLM on Bedrock) | implemented | **live** against Bedrock: sales, anomalies, refund proposal; tests against a local Bedrock stand-in: proposals only, masked customers, demo question cap |
| Assistant PayPal invoice tools (Agent Toolkit) | implemented | **live sandbox:** create, send, status and QR code verified. The live run exposed that the toolkit returns JSON encoded twice (status was never read); fixed and covered by tests. Only invoices PayPal collected (`PAID`) are credited, never ones marked paid by hand |
| Merchant dashboard (AG Grid + AG Charts) | implemented | browser |
| Zapier events | implemented | not run against a live Zap |
| Elastic activity index + assistant search | implemented | request format verified against a mock server only |
| OpenAPI spec | done | Redocly lint: valid |
| Postman collection | done | Newman: 15 requests, 19/19 assertions, including cash-out and a refused refund after cash-out |
| "Try the demo" (one-tap shop + customer per visitor) | implemented | tests: off unless `DEMO_MODE`, isolated per visitor, never touches PayPal, per-visitor limit; browser run end to end |
| Merchant refunds | implemented | only from money PulsePay still holds for the merchant (not after a payout); tests |
| Automated tests | 137 | `npm run test:db` (real Postgres, local PayPal and Bedrock stand-ins); every test mutation-checked |
| Hosted demo (one container: API + web app + CV service) | implemented | tests: page serving, frame forwarding, size cap, same-site requests; the image ran the demo end to end in a browser at Render free-plan limits (0.1 CPU, 512 MB), Bedrock live |
| Render blueprint | written | validated against Render's published schema; not deployed yet (needs a Render account) |
| Family / delegates | API only | deferred from MVP |

---

## 3. Money model

PulsePay holds customer funds in its PayPal account (`pool:paypal`) and records who is owed what in a double-entry ledger:

| Event | Ledger |
|---|---|
| Top-up captured | debit `pool:paypal` / credit `wallet:<id>` |
| Payment at a shop | debit `wallet:<id>` / credit `merchant:<id>` |
| Send to a PayPal email | debit `wallet:<id>` / credit `payee:<email>` |
| Payout SUCCESS | debit `merchant:<id>` or `payee:<email>` / credit `pool:paypal` |
| Merchant refund | debit `merchant:<id>` / credit `wallet:<id>` |
| Paid PayPal invoice | debit `pool:paypal` / credit `merchant:<id>` |
| Wallet closed | debit `wallet:<id>` / credit `pool:paypal` (capture refunded) |

Holding customer balances like this needs PayPal's approval for Payouts and a compliance review before any live use.

---

## 4. Auth policy

| Flow | Required | Notes |
|---|---|---|
| Merchant payment | chosen biometric(s) + PIN | no OTP: the customer's phone may be at home |
| Distress payment | distress finger in place of the payment finger + PIN | capped; SOS best-effort |
| Own-phone send / top-up / close | customer session (+ PIN for send) | idempotency key per send |
| Existing customer at enrolment | phone code + current PIN | PIN and biometrics never replaced here |
| AI assistant actions | merchant confirms in the app | the model can only propose |

---

## 5. Open items

| Item | Blocker |
|---|---|
| Live sandbox: buyer-approved top-up, payout, refund | a US business sandbox account (for payouts); one browser run with the sandbox buyer |
| GLM 5.3 | not enabled on the Bedrock account (GLM 5 used automatically) |
| Webhooks verified end-to-end | public URL (Render deploy) + `PAYPAL_WEBHOOK_ID` |
| Real fingerprint capture | external scanner hardware |
| FAR/FRR, liveness certification | real models + evaluation data |
