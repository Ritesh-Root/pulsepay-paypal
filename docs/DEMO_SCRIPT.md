# PulsePay demo video (2 minutes 24 seconds)

The submitted video: real footage of the app at phone size (recorded with Playwright), title cards, and a narrated voiceover. Money in the demo shop is simulated; the PayPal button, checkout popup and invoices are the real PayPal sandbox; the assistant is live GLM on Amazon Bedrock.

| # | On screen | Narration |
|---|---|---|
| 1 | Title card: "pulse pay · Leave your phone at home." | This is PulsePay. Pay at any shop with your fingerprint and a PIN, and leave your phone at home. |
| 2 | The problem: dead battery, phone in a gym locker, a day at the beach, people without a phone. | Every way we pay assumes you carry something: a card, a phone, a watch. A dead battery, or a phone locked in a gym locker, and you can't even buy a coffee. Kids and many older people are left out completely. |
| 3 | The idea: Scan → Amount → PIN → Paid → Signed out. | But the shop already has a phone. So PulsePay lets the customer bring only themselves. |
| 4 | User tab → Create wallet: phone code, Fingerprint, scan, PIN, top-up with the PayPal button, the PayPal sandbox popup. | Once, at home, you open a small wallet on your own phone. Choose how shops recognise you: fingerprint, face, or both. Scan. Here, the webcam stands in for a fingerprint sensor. Set a PIN, then top up with PayPal. That's real PayPal Checkout, running in the sandbox. |
| 5 | Merchant tab → Open my demo shop → Scan finger → demo finger → $12 → PIN → paid, signed out. | At the shop, the merchant's phone does the work. For this demo, a ready-made customer holds fifty dollars, and a demo finger stands in for the scanner. PulsePay finds the customer among everyone, and shows the merchant only a masked label. The merchant types the bill. The customer types their PIN. Paid, and signed out automatically, like a card leaving the reader. |
| 6 | Dashboard: tiles, sales by hour (AG Charts), payments and payouts (AG Grid). | The shop sees every sale on an AG Grid dashboard. Sales stay refundable until the merchant cashes out to PayPal, with PayPal Payouts. |
| 7 | Assistant: "How much did I take today?", a real PayPal invoice with QR code, "Pay out my balance" → Confirm. | And the shop gets a back office it can talk to: an assistant running GLM on Amazon Bedrock. It answers questions about the day. With the PayPal Agent Toolkit, it creates a real PayPal invoice, with a QR code. It can draft a cash-out too, but money only moves when a person taps Confirm. |
| 8 | Safety card: $200 cap, 72 hours, PIN every time, distress finger. | Risk is capped by design. At most two hundred dollars, gone in seventy-two hours unless you extend it, and a PIN on every payment. If someone forces you to pay, use your distress finger. The screens look normal, but at most twenty-five dollars moves, and your emergency contact gets a silent alert. |
| 9 | User tab → Wallet → Close wallet: refunded to PayPal. | Back home, close the wallet any time. Whatever you didn't spend goes back to your PayPal. |
| 10 | Under the hood: PayPal APIs, GLM on Bedrock, idempotency, ledger, 137 tests. | Under the hood: PayPal Checkout, Orders, Refunds, Payouts, Invoicing and verified webhooks. Every money call is idempotent, so nothing is charged or paid twice. A double-entry ledger, and a hundred and thirty-seven automated tests. |
| 11 | End card with the GitHub link. | PulsePay. Leave your phone at home. |

To record it yourself instead: start the stack (`docker compose up --build`), open http://localhost:3000 at phone width (about 400 px), and follow the rows above. The rules ask for a video under 3 minutes, public on YouTube, with no copyrighted music.
