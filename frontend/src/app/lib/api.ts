// API client for the PulsePay-SBI backend (fingerprint-primary).
// The web demo uses the webcam as a stand-in for the AePS fingerprint scanner;
// captured frames go to the India-resident CV service, which returns a vector.

export const API_URL = (import.meta as any).env?.VITE_API_URL || "http://localhost:5000";
export const CV_URL = (import.meta as any).env?.VITE_CV_URL || "http://localhost:8000";

// ---- session (the customer's wallet token) --------------------------------
type Session = { token: string; walletId: string; expiry?: string };
const SKEY = "pulsepay_session";

export function saveSession(s: Session) {
  localStorage.setItem(SKEY, JSON.stringify(s));
}
export function getSession(): Session | null {
  try {
    const raw = localStorage.getItem(SKEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (s.expiry && new Date(s.expiry) < new Date()) { clearSession(); return null; }
    return s;
  } catch { return null; }
}
export function clearSession() { localStorage.removeItem(SKEY); }

// ---- merchant/terminal token (demo) ---------------------------------------
let terminalToken: string | null = null;
export async function getTerminalToken(merchantUpi = "kirana@upi"): Promise<string> {
  if (terminalToken) return terminalToken;
  const r = await fetch(`${API_URL}/api/merchant/session`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchant_upi: merchantUpi }),
  });
  const d = await r.json();
  terminalToken = d.token;
  return terminalToken!;
}

// ---- low-level fetch ------------------------------------------------------
async function req(path: string, opts: RequestInit = {}, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers as any) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const r = await fetch(`${API_URL}${path}`, { ...opts, headers });
  let data: any = {};
  try { data = await r.json(); } catch { /* empty */ }
  return { ok: r.ok, status: r.status, data };
}

export const api = {
  get: (path: string, token?: string) => req(path, { method: "GET" }, token),
  post: (path: string, body: any, token?: string) => req(path, { method: "POST", body: JSON.stringify(body) }, token),
};

// ---- biometric embedding via the India-resident CV service ----------------
// endpoint: 'fingerprint' (primary / distress) or 'face' (step-up)
export async function embed(endpoint: "fingerprint" | "face", blob: Blob): Promise<{ embedding: number[]; liveness_passed?: boolean; pad_score?: number; error?: string }> {
  const fd = new FormData();
  fd.append("image", blob, "capture.jpg");
  const r = await fetch(`${CV_URL}/embed-${endpoint}`, { method: "POST", body: fd });
  return r.json();
}

export function rupeesToPaise(r: number) { return Math.round(r * 100); }
export function paiseToRupees(p: number) { return Math.round(Number(p) / 100); }
