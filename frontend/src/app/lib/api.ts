// API client for the PulsePay backend.
// The web demo uses the device camera as a stand-in for a fingerprint sensor;
// captured frames go to the CV service, which returns a vector (no image is stored).

// Base URLs. The one-service deploy builds with VITE_API_URL=/ and VITE_CV_URL=/cv, so the
// page calls its own host; local development talks to the separate ports.
const env = (import.meta as any).env || {};
const base = (url: string) => url.replace(/\/+$/, "");
export const API_URL = base(env.VITE_API_URL || "http://localhost:5000");
export const CV_URL = base(env.VITE_CV_URL || "http://localhost:8000");

export type IdMethod = "fingerprint" | "face" | "both";

// ---- customer session (the wallet owner's own phone) ----------------------
type Session = { token: string; walletId: string; expiry?: string };
const SKEY = "pulsepay_session";

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function remove(key: string) {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

export function saveSession(s: Session) { writeJson(SKEY, s); }
export function getSession(): Session | null {
  const s = readJson<Session>(SKEY);
  if (s?.expiry && new Date(s.expiry) < new Date()) { clearSession(); return null; }
  return s;
}
export function clearSession() { remove(SKEY); }

// ---- merchant session (the shop's phone) ----------------------------------
export type Merchant = { id: string; display_name: string; paypal_email: string; is_demo?: boolean };
type MerchantSession = { token: string; merchant: Merchant };
const MKEY = "pulsepay_merchant";

export function saveMerchantSession(s: MerchantSession) { writeJson(MKEY, s); }
export function getMerchantSession(): MerchantSession | null { return readJson<MerchantSession>(MKEY); }
export function clearMerchantSession() { remove(MKEY); }

// ---- "Try the demo" (server DEMO_MODE) ------------------------------------
// The demo customer's scan vector and PIN, so the terminal can stand in for the
// scanner on devices without a camera.
export type DemoCustomer = { label: string; pin: string; scan: number[] };
const DKEY = "pulsepay_demo_customer";

export function saveDemoCustomer(d: DemoCustomer) { writeJson(DKEY, d); }
export function getDemoCustomer(): DemoCustomer | null { return readJson<DemoCustomer>(DKEY); }
export function clearDemoCustomer() { remove(DKEY); }

// ---- low-level fetch ------------------------------------------------------
export type ApiResult = { ok: boolean; status: number; data: any };

async function req(path: string, opts: RequestInit = {}, token?: string): Promise<ApiResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as any) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  let r: Response;
  try {
    r = await fetch(`${API_URL}${path}`, { ...opts, headers });
  } catch {
    return { ok: false, status: 0, data: { error: "Can't reach the PulsePay server. Check your connection and try again." } };
  }
  let data: any = {};
  try { data = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, data };
}

export const api = {
  get: (path: string, token?: string) => req(path, { method: "GET" }, token),
  post: (path: string, body: any, token?: string) => req(path, { method: "POST", body: JSON.stringify(body) }, token),
};

// ---- biometric embedding via the CV service --------------------------------
export type EmbedResult = { embedding: number[]; liveness_passed?: boolean; pad_score?: number; quality?: number; error?: string };

export async function embed(endpoint: "fingerprint" | "face", blob: Blob): Promise<EmbedResult> {
  const fd = new FormData();
  fd.append("image", blob, "capture.jpg");
  try {
    const r = await fetch(`${CV_URL}/embed-${endpoint}`, { method: "POST", body: fd });
    return await r.json();
  } catch {
    return { embedding: [], error: "Can't reach the scanner service. Try again in a moment." };
  }
}

export function newIdempotencyKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
