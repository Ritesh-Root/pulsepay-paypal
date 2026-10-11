// Shared wallet UI state: prefers live API session, falls back to seeded demo data.

export type Tx = {
  id: string;
  kind?: "fund" | "payment" | "send" | "refund" | "merchant_refund";
  counterparty: string;
  amount: number; // cents, always positive; direction says which way it moved
  status: string;
  refunded?: boolean;
  created_at: string;
  direction?: "out" | "in";
};

export type WalletSnap = {
  id: string;
  balance: number; // cents
  currency?: string;
  expiry?: string;
  max_lifetime?: string;
  extend_count?: number;
  active?: boolean;
  per_payment_limit?: number; // cents
  max_balance?: number; // cents
  funded_by?: "paypal" | "simulated";
  paypal_payer?: string | null;
};

export const DEMO_USER = {
  name: "Maya",
  email: "maya@demo.pulsepay.app",
  initials: "MA",
};

export const DEMO_RECIPIENT = {
  name: "Sam Rivera",
  email: "sam.rivera@personal.example.com",
  initials: "SR",
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// Offline demo data, shaped like a real low-limit wallet ($200 cap, 72h expiry).
function demoSeed(): { wallet: WalletSnap; transactions: Tx[] } {
  return {
    wallet: {
      id: "demo-wallet",
      balance: 11275,
      currency: "USD",
      active: true,
      extend_count: 0,
      expiry: new Date(Date.now() + 60 * 3600 * 1000).toISOString(),
      per_payment_limit: 10000,
      max_balance: 20000,
      funded_by: "simulated",
    },
    transactions: [
      { id: "d4", kind: "payment", counterparty: "Corner Coffee", amount: 425, status: "completed", created_at: hoursAgo(2), direction: "out" },
      { id: "d3", kind: "payment", counterparty: "Green Grocer", amount: 2350, status: "completed", created_at: hoursAgo(5), direction: "out" },
      { id: "d2", kind: "payment", counterparty: "Main St Pharmacy", amount: 1950, status: "completed", created_at: hoursAgo(9), direction: "out" },
      { id: "d1", kind: "fund", counterparty: "PayPal top-up", amount: 15000, status: "completed", created_at: hoursAgo(12), direction: "in" },
    ],
  };
}

const DEMO_KEY = "pulsepay_demo_wallet_usd";

export function loadDemoWallet(): { wallet: WalletSnap; transactions: Tx[] } {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  const seed = demoSeed();
  try { localStorage.setItem(DEMO_KEY, JSON.stringify(seed)); } catch { /* storage unavailable */ }
  return seed;
}

export function saveDemoWallet(wallet: WalletSnap, transactions: Tx[]) {
  try { localStorage.setItem(DEMO_KEY, JSON.stringify({ wallet, transactions })); } catch { /* storage unavailable */ }
}

export function formatUsd(cents: number) {
  return (Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatTxDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}


export const isIncoming = (t: Tx) => (t.direction ? t.direction === "in" : t.kind === "fund" || t.kind === "merchant_refund");
