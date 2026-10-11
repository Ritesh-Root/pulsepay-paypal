# PulsePay demo video script (2 minutes 50 seconds)

The rules require a video **under 3 minutes**, public on YouTube, with no copyrighted music. Record the browser at phone width (about 400 px) so it looks like a phone. Use the hosted demo, or start the stack with `docker compose up --build` and open http://localhost:3000, and keep the PayPal sandbox buyer login handy if you show a real top-up.

---

### 0:00 – 0:20 · The problem

**Screen:** a phone with a dead battery, or the PulsePay sign-in screen.

> "Every way we pay in a shop assumes you carry something: a card, a phone, a watch. Batteries die, phones get left at home, and lots of people don't carry one at all. PulsePay lets you pay with your fingerprint or face plus a PIN, funded by PayPal, so you can leave your phone at home."

### 0:20 – 0:50 · Open a wallet once (User tab)

**Screen:** User → Profile → Create wallet.

1. Phone number → the code fills in (demo mode).
2. Choose **Fingerprint** (mention face or both are options).
3. Scan the payment finger, then a **distress finger**.
4. Set a PIN and an emergency contact.
5. **Pay with PayPal**: $50 (sandbox buyer, or the simulated button without keys).

> "You do this once, on your own phone. You choose how shops recognise you, set a PIN, and top up a small wallet with PayPal Checkout. PayPal only captures the money after every check passes."

### 0:50 – 1:30 · Pay with no phone (Merchant tab)

**Screen:** Merchant → Checkout. (Or tap **Open my demo shop** and use the demo finger if there's no camera.)

1. **Scan finger** → "Customer ••1234" appears with a 2-minute timer.
2. Tap **$12** → **Continue to PIN** → the customer types their PIN → **Pay**.
3. "$12.00 received", spoken confirmation, "Customer signed out automatically".

> "At the shop, the customer brings nothing. The merchant's phone scans them, PulsePay finds who it is among all customers, and shows only a masked label. The merchant types the bill, the customer types their PIN, and the terminal signs them out, like a card leaving the reader."

### 1:30 – 2:05 · The AI assistant (Assistant tab)

**Screen:** ask "How much did I take today?", then "Anything unusual?", then "Pay out my balance to PayPal" → **Confirm**. With PayPal sandbox keys, also "Invoice sam@example.com for 2 coffees at $4.50".

> "The assistant runs on GLM in Amazon Bedrock with the PayPal Agent Toolkit. It answers in plain language, spots unusual payments, creates PayPal invoices, and drafts refunds and cash-outs. Money moves only when a person taps Confirm."

### 2:05 – 2:30 · The merchant gets paid (Dashboard tab)

**Screen:** Dashboard: tiles, sales chart, payments grid, and the new cash-out in the PayPal payouts grid.

> "Sales show up live, and the cash-out went to the merchant's PayPal account with PayPal Payouts. Until a sale is cashed out, the merchant can refund it from this grid. Every movement is in a double-entry ledger, so the money always adds up."

### 2:30 – 2:42 · Safety

**Screen:** pay $80 with the distress finger: the screens look normal and "$25.00" moves (show the wallet history). Show three wrong PINs → locked.

> "If someone forces you to pay, use your distress finger. Everything looks normal, but at most $25 moves and your emergency contact gets a silent alert. Wrong PINs lock after three tries, and the wallet itself is capped and expires in days."

### 2:42 – 2:50 · Close

**Screen:** User → Wallet → **Close wallet · refund to PayPal**.

> "Anything you don't spend goes back to your PayPal. PulsePay: leave your phone at home."

---

**If something goes wrong on camera:** a payment whose response was lost is safe to retry (the same session or idempotency key returns the first result), so tap Pay again rather than scanning again.
