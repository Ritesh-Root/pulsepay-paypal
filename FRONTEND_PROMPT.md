# Front-end re-wiring prompt (PulsePay-SBI)

Copy everything below the line into your coding agent (Claude Code / Cursor / v0).
It is self-contained and grounded in the actual backend in this repo.

---

You are updating the **frontend** of PulsePay, a Next.js (App Router) + TypeScript + Tailwind PWA in `/frontend`. The **backend has been re-architected** for the State Bank of India (SBI) hackathon. Re-wire the frontend to the new API and flows. Read `ARCHITECTURE.md` and `PLAN.md` for context. Do not invent endpoints/fields beyond what is specified; the contracts below are exact.

## Authentication model (important — this drives the UX)
- **Fingerprint is the PRIMARY payment factor** (everyday amounts) — captured on a fingerprint scanner (or camera fallback). It identifies the wallet 1:N.
- **PIN** is the knowledge second factor for the base tier (fingerprint + PIN).
- **Face is a STEP-UP factor required only above an amount limit** (the backend's risk engine returns `requires_face`). OTP is required at the highest tier (`requires_otp`).
- **Distress is a DISTINCT finger.** Every finger is biometrically distinct, so the user enrols a normal payment finger and a separate distress finger. Scanning the distress finger completes the payment **identically on screen** while silently alerting their contact. There is therefore **no distress button or distinct styling** in the merchant UI — the customer simply places a different finger.

## Ground rules
- Keep Next.js App Router, TypeScript, Tailwind, and the existing camera/`getUserMedia` capture shells. Change data flow, fields, and copy only.
- **No dead states, no loops.** Every async path resolves to success or a visible error with retry. Always stop the camera on unmount/step change.
- Money is rupees in the UI; the backend stores paise (it multiplies `amount` by 100). When reading wallet/transaction amounts, divide paise by 100.
- Remove all "Amazon Nova" branding. Biometrics are **vectors**, not hashes — never send/show a "hash".

## Environment
- `NEXT_PUBLIC_API_URL` (default `http://localhost:5000`) — backend
- `NEXT_PUBLIC_CV_SERVICE_URL` (default `http://localhost:8000`) — India-resident CV service

---

## CV service contract (two endpoints; remove `/hash-face`, `/hash-fingerprint`, `/liveness-check`)

`POST {CV}/embed-fingerprint` — **primary**. Request: multipart field `image` (a JPEG blob) **or** JSON `{ "image":"<base64>" }`. Response: `{ "embedding":[/*1024 floats*/], "quality":90 }` (or `{error, embedding:[]}`).

`POST {CV}/embed-face` — **step-up**. Same request shape. Response: `{ "face_detected":true, "liveness_passed":true, "pad_score":90, "embedding":[/*1024*/] }`. On no/multiple faces, the booleans are false and `embedding` is `[]`.

Helpers to add in `lib/api.ts`:
```ts
async function embedBlob(path: '/embed-fingerprint'|'/embed-face', blob: Blob) {
  const fd = new FormData(); fd.append('image', blob, 'capture.jpg');
  const r = await fetch(`${CV_SERVICE_URL}${path}`, { method:'POST', body: fd });
  return r.json();
}
export const embedFingerprint = (b: Blob) => embedBlob('/embed-fingerprint', b);
export const embedFace = (b: Blob) => embedBlob('/embed-face', b);
```

---

## Backend API contract (exact)

### Enrolment (public)
1. `POST {API}/api/enroll/request-otp` — Body `{ reference, phone }` → `{ success, txn_id, otp_sent }`. **OTP is not in the response.**
2. `POST {API}/api/enroll/verify-otp` — Body `{ reference, otp, phone }` → success `{ verified:true, enrolment_token }` (store in component state). Failure `{ verified:false, error }`.
3. `POST {API}/api/enroll/create-wallet` — **Header** `Authorization: Bearer <enrolment_token>`. Body:
   ```json
   { "fingerprint_embedding":[...], "distress_fingerprint_embedding":[...],
     "face_embedding":[...], "liveness_passed":true, "wallet_pin":"1234",
     "amount":1500, "phone":"<10-digit>", "funding_source":"sbi_cbs"|"upi" }
   ```
   `wallet_pin` is 4–6 digits. All three embeddings are required (primary finger, a **distinct** distress finger, and a face for future step-up). Success → `{ wallet_id, balance, expiry, funding_source, token, message }` → `saveSession({ walletId: wallet_id, token, phone, expiry })`.

### Payment (requires a terminal JWT — see Task 0)
4. `POST {API}/api/payment/authenticate` — Body:
   ```json
   { "fingerprint_embedding":[...], "pin":"1234", "amount":200, "merchant_upi":"shop@upi",
     "face_embedding":[...optional...], "gps_lat":..., "gps_lng":..., "otp":"...", "otp_reference":"..." }
   ```
   - If the amount needs the face step-up and no `face_embedding` was sent: `{ authenticated:false, tier, requires_face:true }` → capture face, re-call with `face_embedding`.
   - If the highest tier and no OTP: `{ authenticated:false, tier, requires_otp:true, otp_sent:true, otp_reference }` → collect OTP, re-call with `otp` + `otp_reference` (keep the same `fingerprint_embedding`, `pin`, `amount`, `merchant_upi`, `face_embedding`).
   - Success: `{ authenticated:true, assertion_token, wallet_id, confidence_score, tier, balance, expires_at }`.
   - 404 `Biometric not recognized` / 401 `Authentication failed`.
5. `POST {API}/api/payment/execute` — Body `{ wallet_id, amount, merchant_upi, assertion_token, gps_lat?, gps_lng? }` → `{ transaction_id, remaining_balance, status:"completed", payment_ref, timestamp }`. Errors: 401/400/502/409. Assertion is single-use, ~90s TTL — call execute immediately after authenticate.
6. `POST {API}/api/payment/sos` — panic button (user JWT + ownership). Body `{ wallet_id, gps_lat, gps_lng }` → `{ success:true }`.

### Wallet (user JWT; caller must own the wallet)
7. `GET {API}/api/wallet/:wallet_id` → `{ wallet:{ id, balance, expiry, max_lifetime, extend_count, active, created_at }, transactions:[{ id, merchant_upi, amount, auth_tier, distress_triggered, status, created_at }] }` (paise).
8. `POST {API}/api/wallet/refund` `{ wallet_id }` → `{ success, refunded_amount }`.
9. `POST {API}/api/wallet/extend` `{ wallet_id }` → `{ success, new_expiry, extend_count }`; may return **400** `{ error, max_lifetime }` when capped — handle it.
10. `POST {API}/api/wallet/reissue-biometric` `{ wallet_id, template_type:"fingerprint"|"face", embedding:[...], pin }` → `{ success, template_type }`. (Re-verified, cancelable; default `fingerprint`.)

### Family (user JWT; caller must own the parent wallet)
11. `POST {API}/api/family/add-delegate` `{ parent_wallet_id, delegate_name, delegate_fingerprint_embedding:[...], delegate_face_embedding?:[...], delegate_pin:"1234", spending_cap:500 }` (`spending_cap` rupees) → `{ success, delegate:{ id, name, spending_cap, created_at } }`.
12. `GET {API}/api/family/delegates/:parent_wallet_id` → `{ delegates:[{ id, spending_cap, spent_total, per_delegate_expiry, active, created_at }] }` (paise).

### Voice (public)
13. `POST {API}/api/voice/confirm` `{ amount, merchant_name, payer_name?, transaction_id?, lang?:"en"|"hi" }` → `{ text, lang, ... }`. **Speak `text` with `window.speechSynthesis`** (no `audio_base64`).

---

## Tasks

### Task 0 — Merchant/terminal auth (small backend addition, required)
Payment routes need a JWT but the merchant terminal has no user. In `backend/server.js`, add a public `POST /api/merchant/session` that takes `{ merchant_upi }` and returns `{ token }` via `generateToken` (from `backend/middleware/auth.js`) using a synthetic merchant identity (fixed/derived UUID). On the merchant page, fetch this on mount and store the token so `api.post` sends it for `/api/payment/*`. This is the only backend change permitted.

### Task 1 — `app/enroll/page.tsx`
- Step 1 (OTP): `request-otp` then `verify-otp`; store `enrolment_token` in state; remove any mock-OTP auto-fill.
- Step 2 (Fingerprints — PRIMARY): capture the **payment finger** → `embedFingerprint` → store as `fingerprint_embedding`. Then prompt "Now place a DIFFERENT finger for emergencies" and capture the **distress finger** → `embedFingerprint` → store as `distress_fingerprint_embedding`. Explain plainly: "Your distress finger pays normally but silently alerts your emergency contact." (If using a camera rather than a scanner, keep the existing capture UI.)
- Step 3 (Face — for step-up): capture face → `embedFace`; require `liveness_passed === true`; store `face_embedding`. Copy: "Used only for higher-value payments."
- Step 4 (PIN + Fund): one numeric **Wallet PIN** input (4–6 digits). Funding: `sbi_cbs` (default) or `upi` — **remove crypto entirely**. Keep the ₹1000–2000 slider.
- Submit: `create-wallet` with `Authorization: Bearer <enrolment_token>` and the body in contract #3. On success `saveSession(...)`.

### Task 2 — `app/merchant/page.tsx`
- Enter amount. Capture the customer's **fingerprint** → `embedFingerprint` → `fingerprint_embedding`. Add a customer **PIN** field.
- Call `authenticate` with `{ fingerprint_embedding, pin, amount, merchant_upi, gps_lat, gps_lng }`.
  - If `requires_face`: capture the customer's face → `embedFace` → re-call with `face_embedding` added.
  - If `requires_otp`: show an OTP input → re-call with `otp` + `otp_reference`.
  - On success: show `confidence_score` + `tier`, then call `execute` immediately with the `assertion_token` (≤90s TTL).
- **No distress UI** — distress is silent (the customer uses their distinct finger). Remove the old `face_hash`/`fingerprint_hash` fields, the `/api/payment/distress` call, and any client-sent `confidence_score`.
- On success, call `/api/voice/confirm` and speak `text` via `window.speechSynthesis`.

### Task 3 — `app/dashboard/page.tsx`
- Wallet card: new shape (`balance` paise→₹, `expiry` countdown, `max_lifetime`, `extend_count`).
- Extend: handle the **400 cap** (show `max_lifetime`, disable when capped). Refund: show `refunded_amount` (₹).
- "Rotate key" → **"Re-issue Fingerprint"**: capture fingerprint → `embedFingerprint` → `reissue-biometric` `{ wallet_id, template_type:"fingerprint", embedding, pin }` (prompt for the wallet PIN). Optionally offer face re-issue too (`template_type:"face"`).
- Add-delegate modal: capture the delegate's **fingerprint** (+ optional face) → `add-delegate` `{ parent_wallet_id, delegate_name, delegate_fingerprint_embedding, delegate_face_embedding?, delegate_pin, spending_cap }`. Delegates list shows `spent_total`/`spending_cap`.
- Panic button → `POST /api/payment/sos { wallet_id, gps_lat, gps_lng }` (GPS via `navigator.geolocation`).

### Task 4 — Shared + copy
- `lib/api.ts`: add `embedFingerprint`/`embedFace`; ensure the merchant terminal token is used for `/api/payment/*`.
- `app/page.tsx` + `app/layout.tsx`: remove "Powered by Amazon Nova"; SBI + financial-inclusion + RBI-AFA + India-resident messaging. Change the auth feature copy to **"Fingerprint to pay; face adds security on larger amounts."** Describe Distress Mode as **"a separate finger that pays normally while silently alerting your contact."**

## Acceptance criteria
- Enrol (2 fingers + face + PIN) → fund → merchant pay: small amount = fingerprint + PIN; above the limit = fingerprint + face; highest = + OTP. Dashboard shows the transaction and reduced balance. No "hash" anywhere.
- Scanning the **distress finger** at the merchant completes a (capped) payment with a UI **identical** to a normal one; the dashboard later shows `distress_triggered = true`.
- Crypto funding is removed. No calls remain to `/hash-face`, `/hash-fingerprint`, `/liveness-check`, `/api/enroll/verify-aadhaar`, `/api/payment/distress`, or `/api/wallet/rotate-salt`.
- `next build` passes with no type errors. The camera always stops on unmount/navigation. Every error path shows a message and allows retry.
```
