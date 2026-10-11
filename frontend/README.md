# PulsePay frontend

React 18 + Vite + Tailwind. One app with two modes:

- **User** (the customer's own phone): open a wallet, top up with PayPal, send, close and refund.
- **Merchant** (the shop's phone): the payment terminal, the dashboard (AG Grid + AG Charts) and the AI assistant. With `DEMO_MODE` on the server, the sign-in screen offers **Try the demo**.

```bash
npm ci
npm run dev        # http://localhost:3000
npm run build      # static build in dist/
```

`VITE_API_URL` (default `http://localhost:5000`) and `VITE_CV_URL` (default `http://localhost:8000`) point at the backend and the CV service. The dev and preview servers send `Cross-Origin-Opener-Policy: same-origin-allow-popups`, which the PayPal JS SDK v6 popup needs.

See the [project README](../README.md) for the full picture.
