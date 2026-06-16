# PulsePay-SBI — Demo Video Script (HyperFrames)

**Target length:** 2:55–3:00 (hard cap 3:00) · **Aspect:** 16:9 (1920×1080) · **FPS:** 30
**Voice:** HeyGen TTS — warm, professional, Indian-English accent if available.
**Theme (match the deck):** navy `#0B2A6B`, teal `#00A896`, ice `#CADCFC`, white `#FFFFFF`.
**Type:** Cambria (headlines) / Calibri (captions). **Captions:** lower-third, navy bar at ~12% opacity, white text.
**Music:** soft, optimistic corporate bed at ~12% volume; small "whoosh" on scene cuts; a single soft chime on each payment "success".
**Motion:** gentle Ken-Burns (slow zoom) on screenshots; captions slide up; stat numbers count up.

---

## 1. Asset / shot list

**Already have (reuse the rendered deck slides as polished cards):**
`deck-build/slide-01.jpg … slide-10.jpg` — use 01 (title), 02 (problem), 04 (auth ladder), 06 (compliance), 07 (value), 09 (roadmap), 10 (closing).

**Real app screenshots to capture (stack running — `docker-compose up`, open localhost:3000):**
| ID | Screen | How to get it |
|----|--------|----------------|
| A1 | Enrol · Identity (phone + OTP, "verified") | Enrol tab, step 1 after Verify |
| A2 | Enrol · Biometric (live camera + the 3-chip tracker: payment finger / distress finger / face) | Enrol step 2 mid-capture |
| A3 | Enrol · Security (Wallet PIN) | Enrol step 3 |
| A4 | Enrol · Funding (amount slider + SBI Account/UPI) | Enrol step 4 |
| A5 | Enrol · Success (wallet id, balance, expiry) | after Create wallet |
| A6 | Merchant · Amount due (₹450 to kirana@upi) | Merchant tab |
| A7 | Merchant · Fingerprint scan (live camera) | Merchant → Authenticate to pay |
| A8 | Merchant · PIN entry | after scan |
| A9 | Merchant · Face step-up (set amount ₹1200) + OTP screen (₹2400) | high-value path |
| A10 | Merchant · Success + voice line + Session panel (tier, confidence %) | after pay |
| A11 | Dashboard · wallet card (balance, expiry countdown, Extend/Refund/Re-issue, Panic) | Wallet tab |
| A12 | Dashboard · transaction list with a **"distress"** badge row | after a distress payment |
| A13 | Dashboard · Delegates (cap/spent bars) + Add-delegate panel | Wallet tab |

> Tip: record at 1920×1080, browser zoom 100%, hide bookmarks bar. A few are short screen-recordings (A2, A7) — even 2–3s clips look great with the Ken-Burns alternative.

---

## 2. Storyboard (timecode · visual · on-screen caption · voiceover)

**S1 — Hook / Problem · 0:00–0:14**
- Visual: `slide-02.jpg` (400M+ problem) → quick montage feel; numbers count up.
- Caption: *"UPI needs a smartphone. 400M+ Indians don't have one."*
- VO: "India runs on UPI — but UPI needs a smartphone, an app, and a data plan. For over four hundred million unbanked, rural, and elderly Indians, that's a wall."

**S2 — Title · 0:14–0:25**
- Visual: `slide-01.jpg` (PulsePay title, fingerprint motif), subtle zoom.
- Caption: *"PulsePay — Your Fingerprint Is Your Wallet"*
- VO: "What if your body was your wallet? Meet PulsePay — phone-less biometric payments, built on SBI's own rails."

**S3 — Enrolment · 0:25–0:58**
- Visual: A1 → A2 → A3 → A4 → A5 (quick, ~6s each, slide transitions).
- Captions (sync to each): *"Aadhaar e-KYC via SBI's AUA gateway"* · *"3 scans: payment finger · distress finger · face"* · *"Encrypted, revocable vectors — never an image"* · *"Funded from SBI · 72-hour auto-expiry"*
- VO: "Onboarding happens at any SBI Business Correspondent. The customer consents under the DPDP Act and verifies identity through Aadhaar e-KYC over SBI's licensed gateway — the OTP never leaves the server. Then three quick scans: a payment finger, a distinct distress finger, and a face for larger amounts. Every biometric becomes an encrypted, revocable vector — never an image. A wallet PIN, and funds are locked with a seventy-two-hour auto-expiry."

**S4 — Payment + adaptive auth · 0:58–1:28**
- Visual: A6 → A7 → A8 → A10, then A9 (face/OTP) as a quick "and for bigger amounts…" insert. Show the Session panel (confidence %, tier) and the voice line.
- Captions: *"Fingerprint + PIN"* · *"Agentic risk engine — escalates only"* · *"Face above ₹500 · OTP above ₹1,500"* · *"Settled on UPI 123Pay · atomic ledger"* · *"🔊 Instant voice confirmation"*
- VO: "At the shop, paying is effortless — fingerprint plus PIN. But security scales with the amount. An agentic risk engine watches every transaction and steps up only when needed: a face scan above a limit, an OTP for high-value payments. It can raise security, never weaken it. Money moves over UPI 123Pay through an atomic, idempotent ledger — and the merchant hears an instant voice confirmation, in their own language."

**S5 — Distress mode · 1:28–1:48**
- Visual: A7 (same scan, captioned "distress finger") → A10 (identical success) → A12 (dashboard distress badge). Add a subtle SOS/GPS map graphic overlay.
- Captions: *"Coerced? Use your distress finger."* · *"Looks identical — silent SOS + GPS sent"* · *"Amount capped · reversal pre-armed"*
- VO: "And if someone is forced to pay under threat? They use their distress finger. The payment completes normally — the attacker sees nothing — but a silent SOS with live GPS reaches their emergency contact, the amount is capped, and a reversal is pre-armed. Safety, built in."

**S6 — Wallet control & family · 1:48–2:08**
- Visual: A11 (wallet card, countdown, actions) → A13 (delegates).
- Captions: *"Live balance · extend · refund"* · *"One-tap cancelable biometric re-issue"* · *"Family delegates — own KYC, hard caps"*
- VO: "Everything is in the customer's control: live balance and expiry, a tap to extend or refund unused funds, and one-tap biometric re-issuance if a credential is ever compromised. Families can add delegates — each with their own consent, KYC, and a hard spending cap."

**S7 — Security & compliance · 2:08–2:32**
- Visual: `slide-06.jpg` (compliance grid); icons highlight one by one.
- Captions: *"India-resident · RBI AFA · DPDP · UIDAI"* · *"Encrypted, cancelable templates · no double-spend"*
- VO: "Under the hood, PulsePay is built for a bank. Every byte of biometric and payment data stays in India. Authentication meets RBI's two-factor mandate. Privacy follows the DPDP Act. Aadhaar runs only through SBI's licensed gateway. Templates are encrypted and cancelable — and the ledger makes double-spending impossible."

**S8 — Value for SBI + roadmap · 2:32–2:52**
- Visual: `slide-07.jpg` (value) → `slide-09.jpg` (roadmap).
- Captions: *"Runs on SBI's existing AePS scanners"* · *"Acquisition + CASA + inclusion"* · *"Pilot → District → YONO"*
- VO: "Best of all, it runs on infrastructure SBI already owns — the same AePS fingerprint scanners at every Business Correspondent. It's a new-to-bank acquisition and deposit engine that advances financial inclusion — from pilot, to district rollout, to a phone-less mode inside YONO."

**S9 — Close · 2:52–3:00**
- Visual: `slide-10.jpg` (closing). Hold; logo + details fade in.
- Caption: *"github.com/Ritesh-Root/Nova-hackathon · Ritesh Kumar Mahato · SOA ITER"*
- VO: "PulsePay — your fingerprint is your wallet. Financial inclusion, built on SBI's own rails."

---

## 3. Continuous voiceover (for TTS — paste this as the narration track)

> India runs on UPI — but UPI needs a smartphone, an app, and a data plan. For over four hundred million unbanked, rural, and elderly Indians, that's a wall. What if your body was your wallet? Meet PulsePay — phone-less biometric payments, built on SBI's own rails.
>
> Onboarding happens at any SBI Business Correspondent. The customer consents under the DPDP Act and verifies identity through Aadhaar e-KYC over SBI's licensed gateway — the OTP never leaves the server. Then three quick scans: a payment finger, a distinct distress finger, and a face for larger amounts. Every biometric becomes an encrypted, revocable vector — never an image. A wallet PIN, and funds are locked with a seventy-two-hour auto-expiry.
>
> At the shop, paying is effortless — fingerprint plus PIN. But security scales with the amount. An agentic risk engine watches every transaction and steps up only when needed: a face scan above a limit, an OTP for high-value payments. It can raise security, never weaken it. Money moves over UPI 123Pay through an atomic, idempotent ledger — and the merchant hears an instant voice confirmation, in their own language.
>
> And if someone is forced to pay under threat? They use their distress finger. The payment completes normally — the attacker sees nothing — but a silent SOS with live GPS reaches their emergency contact, the amount is capped, and a reversal is pre-armed. Safety, built in.
>
> Everything is in the customer's control: live balance and expiry, a tap to extend or refund unused funds, and one-tap biometric re-issuance if a credential is ever compromised. Families can add delegates — each with their own consent, KYC, and a hard spending cap.
>
> Under the hood, PulsePay is built for a bank. Every byte of biometric and payment data stays in India. Authentication meets RBI's two-factor mandate. Privacy follows the DPDP Act. Aadhaar runs only through SBI's licensed gateway. Templates are encrypted and cancelable — and the ledger makes double-spending impossible.
>
> Best of all, it runs on infrastructure SBI already owns — the same AePS fingerprint scanners at every Business Correspondent. It's a new-to-bank acquisition and deposit engine that advances financial inclusion — from pilot, to district rollout, to a phone-less mode inside YONO.
>
> PulsePay — your fingerprint is your wallet. Financial inclusion, built on SBI's own rails.

*(~455 words ≈ 2:55 at a measured 155 wpm. If TTS runs long, trim S6 first, then S1.)*

---

## 4. Feature-coverage checklist (every feature → scene)

- [x] Phone-less, fingerprint-first payment — S2, S4
- [x] Aadhaar e-KYC via SBI AUA/KUA, OTP server-side — S3
- [x] DPDP consent — S3, S7
- [x] 3 biometric captures incl. distinct distress finger — S3
- [x] Encrypted, cancelable biometric vectors (no image) — S3, S7
- [x] SBI CBS / UPI funding + 72h auto-expiry — S3, S6
- [x] Adaptive / agentic escalate-only auth (PIN → face → OTP) — S4
- [x] Atomic ledger + UPI 123Pay settlement (no double-spend) — S4, S7
- [x] On-device Indic voice confirmation — S4
- [x] Distinct-finger silent distress + GPS SOS + cap + reversal — S5
- [x] Dashboard: balance, expiry, extend (capped), refund — S6
- [x] Cancelable biometric re-issuance — S6
- [x] Family delegates with own KYC + atomic caps — S6
- [x] India data localization, RBI AFA, DPDP, UIDAI — S7
- [x] AePS device reuse / business value / roadmap — S8

---

## 5. Production notes / next steps

1. **Capture A1–A13** from the running app (1080p). I can spin up the stack and grab these.
2. **Assemble in HyperFrames** via the connector: one scene per storyboard row, durations as above, screenshots + the 7 deck slides as media, lower-third captions, the continuous VO as the narration track, music bed, then render to MP4.
3. Keep total ≤ 3:00 (the form's hard limit). Export 1080p MP4, upload, paste the link into form field 8.
