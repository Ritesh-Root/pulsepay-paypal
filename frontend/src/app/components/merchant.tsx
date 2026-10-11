import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { BarChart3, Bot, Check, Fingerprint, LogOut, ScanFace, ShieldCheck, Sparkles, Store, Volume2, X, CreditCard } from "lucide-react";
import { Capture } from "./capture";
// AG Grid + AG Charts are large; load them only when the dashboard tab opens.
const MerchantDashboard = lazy(() => import("./merchant-dashboard").then((m) => ({ default: m.MerchantDashboard })));
import { MerchantAssistant } from "./merchant-assistant";
import { PrimaryButton } from "./wallet-ui";
import { cn } from "./ui/utils";
import {
  api, API_URL, clearDemoCustomer, clearMerchantSession, getDemoCustomer, getMerchantSession, saveDemoCustomer,
  saveMerchantSession, saveSession, type DemoCustomer, type Merchant as MerchantInfo,
} from "../lib/api";

// Terminal phases. App hides the mode toggle while a customer is mid-payment.
export type MerchantPhase = "login" | "ready" | "scan" | "amount" | "pin" | "paying" | "done";
type ScanMethod = "fingerprint" | "face";
type MerchantSession = { token: string; merchant: MerchantInfo };

export function Merchant({ onPhase }: { onPhase?: (phase: MerchantPhase) => void }) {
  const [session, setSession] = useState<MerchantSession | null>(() => getMerchantSession());

  useEffect(() => { if (!session) onPhase?.("login"); }, [session, onPhase]);

  if (!session) {
    return <MerchantLogin onSignedIn={(s) => { saveMerchantSession(s); setSession(s); }} />;
  }
  return (
    <MerchantShell
      session={session}
      onPhase={onPhase}
      onSignOut={() => { clearMerchantSession(); clearDemoCustomer(); setSession(null); }}
    />
  );
}

type Tab = "checkout" | "dashboard" | "assistant";

function MerchantShell({ session, onPhase, onSignOut }: {
  session: MerchantSession;
  onPhase?: (p: MerchantPhase) => void;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>("checkout");
  const [phase, setPhase] = useState<MerchantPhase>("ready");
  const report = useCallback((p: MerchantPhase) => { setPhase(p); onPhase?.(p); }, [onPhase]);
  const customerPresent = tab === "checkout" && phase !== "ready";
  const { merchant } = session;
  const demo = merchant.is_demo ? getDemoCustomer() : null;

  return (
    <div className="px-5 pt-4">
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--dark-green)] text-sm font-semibold text-white">
          {merchant.display_name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-[var(--dark-green)]">{merchant.display_name}</div>
          <div className="truncate text-xs text-[var(--muted-foreground)]">Payouts to PayPal · {merchant.paypal_email}</div>
        </div>
        {!customerPresent && (
          <button type="button" onClick={onSignOut} aria-label="Sign out of merchant mode"
            className="grid h-10 w-10 place-items-center rounded-full bg-white/80 text-[var(--dark-green)]">
            <LogOut className="h-4 w-4" />
          </button>
        )}
      </div>

      {!customerPresent && (
        <div className="mt-4 grid grid-cols-3 gap-1 rounded-full bg-white p-1 shadow-sm" role="tablist" aria-label="Merchant sections">
          {([["checkout", "Checkout", CreditCard], ["dashboard", "Dashboard", BarChart3], ["assistant", "Assistant", Bot]] as const).map(([id, label, Icon]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={cn("inline-flex items-center justify-center gap-1.5 rounded-full py-2 text-xs font-semibold",
                tab === id ? "bg-[var(--dark-green)] text-white" : "text-[var(--dark-green)]")}>
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
      )}

      {demo && !customerPresent && <DemoBanner demo={demo} />}

      {tab === "checkout" && <Terminal session={session} demo={demo} onPhase={report} onSignOut={onSignOut} />}
      {tab === "dashboard" && (
        <Suspense fallback={<p className="mt-10 text-center text-sm text-[var(--muted-foreground)]">Loading dashboard…</p>}>
          <MerchantDashboard token={session.token} onSignOut={onSignOut} />
        </Suspense>
      )}
      {tab === "assistant" && <MerchantAssistant token={session.token} onSignOut={onSignOut} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign-in / registration on the merchant's own phone
// ---------------------------------------------------------------------------

function MerchantLogin({ onSignedIn }: { onSignedIn: (s: MerchantSession) => void }) {
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [needsRegistration, setNeedsRegistration] = useState(false);
  const [shopName, setShopName] = useState("");
  const [paypalEmail, setPaypalEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [demoEnabled, setDemoEnabled] = useState(false);

  useEffect(() => {
    let live = true;
    void api.get("/api/demo").then((r) => { if (live && r.ok) setDemoEnabled(!!r.data.enabled); });
    return () => { live = false; };
  }, []);

  async function sendOtp() {
    setError(""); setInfo(""); setBusy(true);
    const r = await api.post("/api/merchant/request-otp", { phone });
    setBusy(false);
    if (!r.ok) { setError(r.data.error || "Could not send the code"); return; }
    setSent(true);
    if (r.data.demo_otp) { setOtp(String(r.data.demo_otp)); setInfo("Demo mode: code filled in for you."); }
    else setInfo("Code sent by SMS.");
  }

  async function verify() {
    setError(""); setBusy(true);
    const r = await api.post("/api/merchant/verify-otp", {
      phone, otp, ...(needsRegistration ? { display_name: shopName.trim(), paypal_email: paypalEmail.trim() } : {}),
    });
    setBusy(false);
    if (r.status === 409 && r.data.registration_required) {
      setNeedsRegistration(true);
      setInfo("New merchant: add your shop name and the PayPal account your sales should be paid out to.");
      return;
    }
    if (!r.ok) { setError(r.data.error || "Could not sign in"); return; }
    onSignedIn({ token: r.data.token, merchant: r.data.merchant });
  }

  async function tryDemo() {
    setError(""); setBusy(true);
    const r = await api.post("/api/demo/start", {});
    setBusy(false);
    if (!r.ok) { setError(r.data.error || "Could not start the demo"); return; }
    const c = r.data.customer;
    saveDemoCustomer({ label: c.label, pin: c.pin, scan: c.scan });
    saveSession({ token: c.token, walletId: c.wallet_id, expiry: c.expiry }); // the User tab shows this customer's wallet
    onSignedIn(r.data.merchant);
  }

  const canVerify = otp.length === 6 && (!needsRegistration || (shopName.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(paypalEmail.trim())));

  return (
    <div className="px-5 pt-5">
      {demoEnabled && !sent && (
        <div className="mb-4 rounded-[1.75rem] bg-[var(--dark-green)] p-5 text-white shadow-[var(--card-shadow)]">
          <div className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4" /> Try the demo</div>
          <p className="mt-1 text-xs text-white/75">
            Get your own demo shop with this morning's sales and a demo customer holding $50. No camera or sign-up needed. Money is simulated.
          </p>
          <button type="button" disabled={busy} onClick={() => { void tryDemo(); }}
            className="mt-4 w-full rounded-full bg-[var(--lime-btn)] py-3 text-sm font-semibold text-[var(--dark-green)] transition active:scale-[0.98] disabled:opacity-60">
            {busy ? "Setting up your shop…" : "Open my demo shop"}
          </button>
        </div>
      )}
      <div className="rounded-[1.75rem] bg-white p-5 shadow-[var(--card-shadow)]">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-[var(--dark-green)] text-white"><Store className="h-5 w-5" /></div>
          <div>
            <div className="font-semibold text-[var(--dark-green)]">Merchant sign-in</div>
            <div className="text-xs text-[var(--muted-foreground)]">Take PulsePay payments on this phone; get paid out to PayPal</div>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          <Field label="Shop phone with country code">
            <input inputMode="numeric" maxLength={15} placeholder="e.g. 14155550100" value={phone} disabled={sent}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
              className="w-full bg-transparent tabular-nums outline-none disabled:opacity-60" />
          </Field>
          {!sent ? (
            <PrimaryButton disabled={busy || !/^[1-9]\d{9,14}$/.test(phone)} onClick={sendOtp}>{busy ? "Sending…" : "Send code"}</PrimaryButton>
          ) : (
            <>
              <Field label="6-digit code">
                <input inputMode="numeric" maxLength={6} value={otp} autoFocus
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  className="w-full bg-transparent tabular-nums tracking-[0.3em] outline-none" />
              </Field>
              {needsRegistration && (
                <>
                  <Field label="Shop name">
                    <input value={shopName} maxLength={80} placeholder="Corner Grocer" onChange={(e) => setShopName(e.target.value)}
                      className="w-full bg-transparent outline-none" />
                  </Field>
                  <Field label="PayPal email for payouts">
                    <input type="email" value={paypalEmail} placeholder="you@business.example.com" autoCapitalize="none" onChange={(e) => setPaypalEmail(e.target.value.trim())}
                      className="w-full bg-transparent outline-none" />
                  </Field>
                </>
              )}
              <PrimaryButton disabled={busy || !canVerify} onClick={verify}>{busy ? "Checking…" : needsRegistration ? "Register shop" : "Sign in"}</PrimaryButton>
              <button type="button" onClick={() => { setSent(false); setOtp(""); setNeedsRegistration(false); setInfo(""); }}
                className="w-full text-sm text-[var(--muted-foreground)]">Use a different number</button>
            </>
          )}
          {info && <p className="text-center text-xs text-[var(--dark-green-soft)]">{info}</p>}
          {error && <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-center text-xs text-red-600">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The payment terminal
// ---------------------------------------------------------------------------

const AUTO_SIGN_OUT_MS = 6000;
const MAX_PAYMENT_DOLLARS = 100; // the server enforces PER_PAYMENT_LIMIT_CENTS

function Terminal({ session, demo, onSignOut, onPhase }: {
  session: MerchantSession;
  demo: DemoCustomer | null;
  onSignOut: () => void;
  onPhase?: (p: MerchantPhase) => void;
}) {
  const { token, merchant } = session;
  const [phase, setPhase] = useState<MerchantPhase>("ready");
  const [method, setMethod] = useState<ScanMethod>("fingerprint");
  const [scanKey, setScanKey] = useState(0);
  const [payToken, setPayToken] = useState<string | null>(null);
  const [customerLabel, setCustomerLabel] = useState("");
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<{ amount: string; ref: string } | null>(null);
  const gps = useRef<{ lat: number; lng: number } | null>(null);
  const doneTimer = useRef<number | null>(null);
  const [instantPayouts, setInstantPayouts] = useState(false);

  useEffect(() => {
    void api.get("/api/paypal/config").then((r) => { if (r.ok) setInstantPayouts(r.data.payouts === "instant"); });
  }, []);

  useEffect(() => { onPhase?.(phase); }, [phase, onPhase]);

  // Shop location is attached to silent distress alerts (best effort).
  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      (p) => { gps.current = { lat: p.coords.latitude, lng: p.coords.longitude }; },
      () => { gps.current = null; },
      { timeout: 5000, maximumAge: 10 * 60 * 1000 },
    );
  }, []);

  // Wipe everything about the customer: the terminal "logs out".
  const reset = useCallback((message = "") => {
    if (doneTimer.current) { window.clearTimeout(doneTimer.current); doneTimer.current = null; }
    setPhase("ready"); setMethod("fingerprint"); setScanKey((k) => k + 1);
    setPayToken(null); setCustomerLabel(""); setExpiresAt(null); setSecondsLeft(null);
    setAmount(""); setPin(""); setBusy(false); setError(""); setResult(null);
    setNotice(message);
  }, []);

  const endCustomer = useCallback((message: string) => {
    if (payToken) void api.post("/api/payment/cancel", { session_token: payToken }, token);
    reset(message);
  }, [payToken, token, reset]);

  function handleAuthLoss(data: any) {
    if (data?.code === "auth_required") { onSignOut(); return true; }
    return false;
  }

  // Session countdown; the server expires it too.
  useEffect(() => {
    if (!expiresAt || phase === "done" || phase === "paying") return;
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) endCustomer("Session timed out. Customer signed out.");
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, phase, endCustomer]);

  useEffect(() => () => { if (doneTimer.current) window.clearTimeout(doneTimer.current); }, []);

  function startScan(m: ScanMethod) {
    setNotice(""); setError(""); setMethod(m); setScanKey((k) => k + 1); setPhase("scan");
  }

  async function onScanned(embedding: number[]) {
    setBusy(true); setError("");
    const r = await api.post("/api/payment/identify", {
      method, embedding, ...(payToken ? { session_token: payToken } : {}),
    }, token);
    setBusy(false);
    if (handleAuthLoss(r.data)) return;
    if (!r.ok) {
      if (r.data.expired) { reset(r.data.error); return; }
      setError(r.data.error || "Not recognised. Scan again.");
      setScanKey((k) => k + 1);
      return;
    }
    setPayToken(r.data.session_token);
    setCustomerLabel(r.data.customer_label || "Customer");
    setExpiresAt(new Date(r.data.expires_at).getTime());
    if (r.data.ready) { setPhase("amount"); return; }
    // This customer chose "both": take the other scan too.
    setMethod(r.data.next_scan);
    setScanKey((k) => k + 1);
    setNotice(`${r.data.customer_label}: now scan their ${r.data.next_scan === "face" ? "face" : "finger"}.`);
  }

  async function pay(attempt = 0): Promise<void> {
    setPhase("paying"); setError("");
    const r = await api.post("/api/payment/pay", {
      session_token: payToken, amount, pin,
      ...(gps.current ? { gps_lat: gps.current.lat, gps_lng: gps.current.lng } : {}),
    }, token);
    if (handleAuthLoss(r.data)) return;

    if (r.ok && r.data.status === "completed") {
      setPin(""); setPayToken(null); setExpiresAt(null);
      setResult({ amount, ref: r.data.payment_ref || "" });
      setPhase("done");
      speak(amount);
      doneTimer.current = window.setTimeout(() => reset("Customer signed out. Ready for the next customer."), AUTO_SIGN_OUT_MS);
      return;
    }
    if (r.status === 0) {
      // No answer: the payment may or may not have gone through. Retrying the same
      // session is safe (the server returns the first result); scanning again is not.
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 1500));
        return pay(attempt + 1);
      }
      setError("Connection lost. Tap Pay again when you're back online: the customer will only be charged once.");
      setPhase("pin");
      return;
    }
    if (r.status === 401 && typeof r.data.attempts_left === "number") {
      setPin("");
      setError(`Incorrect PIN. ${r.data.attempts_left} ${r.data.attempts_left === 1 ? "try" : "tries"} left.`);
      setPhase("pin");
      return;
    }
    if (r.status === 400) {
      // Amount problem (limit, insufficient balance): the customer stays identified.
      setPin(""); setError(r.data.error || "Check the amount"); setPhase("amount");
      return;
    }
    // Expired, locked, declined or failed on the rail: end this customer's session.
    endCustomer(r.data.error || "Payment failed. Customer signed out.");
  }

  async function speak(dollars: string) {
    let text = `Payment of ${dollars} dollars received.`;
    try {
      const r = await fetch(`${API_URL}/api/voice/confirm`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: dollars, merchant_name: merchant.display_name }),
      });
      const d = await r.json();
      if (d.text) text = d.text;
    } catch { /* offline: use the default line */ }
    try { window.speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch { /* no TTS */ }
  }

  const overLimit = Number(amount) > MAX_PAYMENT_DOLLARS;
  const amountOk = /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && !overLimit;
  const inSession = phase === "amount" || phase === "pin" || (phase === "scan" && !!payToken);

  return (
    <div>
      {inSession && (
        <div className="mt-4 flex items-center justify-between rounded-full bg-white px-4 py-2 text-xs shadow-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-[var(--dark-green)]"><ShieldCheck className="h-3.5 w-3.5" /> {customerLabel || "Identifying…"}</span>
          <span className="tabular-nums text-[var(--muted-foreground)]">
            {secondsLeft != null && `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
          </span>
          <button type="button" onClick={() => endCustomer("Cancelled. Customer signed out.")} aria-label="Cancel and sign the customer out"
            className="-mr-2 grid h-7 w-7 place-items-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--chip)]">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={phase} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
          {phase === "ready" && (
            <div className="mt-5 space-y-3">
              <div className="rounded-[1.75rem] bg-white p-6 text-center shadow-[var(--card-shadow)]">
                <div className="text-lg font-semibold text-[var(--dark-green)]">Next customer</div>
                <p className="mt-1 text-sm text-[var(--muted-foreground)]">No phone needed. The customer scans, you enter the bill, they type their PIN.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <MethodTile icon={<Fingerprint className="h-7 w-7" />} label="Scan finger" onClick={() => startScan("fingerprint")} />
                <MethodTile icon={<ScanFace className="h-7 w-7" />} label="Scan face" onClick={() => startScan("face")} />
              </div>
              {notice && <p className="text-center text-xs text-[var(--dark-green-soft)]">{notice}</p>}
            </div>
          )}

          {phase === "scan" && (
            <div className="mt-4 space-y-3">
              {notice && <p className="text-center text-sm font-medium text-[var(--dark-green)]">{notice}</p>}
              <Capture
                key={`${method}-${scanKey}`}
                endpoint={method}
                requireLiveness={method === "face"}
                noCameraHint={demo && method === "fingerprint" ? "No camera here? Use the demo finger below." : undefined}
                label={method === "face" ? "Customer looks at the camera." : "Customer holds their finger inside the guide. (The camera stands in for a fingerprint sensor.)"}
                onResult={(r) => { void onScanned(r.embedding); }}
              />
              {demo && method === "fingerprint" && !busy && (
                <button type="button" onClick={() => { void onScanned(demoRecapture(demo.scan)); }}
                  className="w-full rounded-full border border-dashed border-[var(--dark-green)]/40 bg-white/70 py-2.5 text-sm font-medium text-[var(--dark-green)]">
                  Use {demo.label}'s demo finger (no camera)
                </button>
              )}
              {busy && <p className="text-center text-xs text-[var(--muted-foreground)]">Identifying…</p>}
              {error && <p role="alert" className="text-center text-sm text-[var(--outgoing)]">{error}</p>}
              {!payToken && (
                <button type="button" onClick={() => reset()} className="w-full text-sm text-[var(--muted-foreground)]">Back</button>
              )}
            </div>
          )}

          {phase === "amount" && (
            <div className="mt-5 space-y-4">
              <div className="rounded-[1.75rem] bg-white p-6 text-center shadow-[var(--card-shadow)]">
                <div className="text-sm text-[var(--muted-foreground)]">Bill amount</div>
                <div className="mt-1 flex items-center justify-center text-5xl font-semibold tracking-tight tabular-nums text-[var(--dark-green)]">
                  <span>$</span>
                  <input
                    autoFocus inputMode="decimal" aria-label="Bill amount" placeholder="0" value={amount}
                    onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1"))}
                    className="w-40 bg-transparent text-center text-5xl font-semibold tracking-tight tabular-nums outline-none placeholder:text-[var(--dark-green)]/25"
                  />
                </div>
                <div className={cn("mt-1 text-xs", overLimit ? "text-[var(--outgoing)]" : "text-[var(--muted-foreground)]")}>Up to ${MAX_PAYMENT_DOLLARS} per payment</div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {["4.50", "12", "25", "60"].map((v) => (
                  <button key={v} type="button" onClick={() => setAmount(v)}
                    className={cn("rounded-full py-2 text-sm font-medium tabular-nums", amount === v ? "bg-[var(--dark-green)] text-white" : "bg-white text-[var(--dark-green)]")}>${v}</button>
                ))}
              </div>
              {error && <p role="alert" className="text-center text-sm text-[var(--outgoing)]">{error}</p>}
              <PrimaryButton disabled={!amountOk} onClick={() => { setError(""); setPhase("pin"); }}>Continue to PIN</PrimaryButton>
            </div>
          )}

          {phase === "pin" && (
            <div className="mt-5 space-y-4">
              <div className="text-center">
                <div className="text-sm text-[var(--muted-foreground)]">Pay {merchant.display_name}</div>
                <div className="text-3xl font-semibold tabular-nums text-[var(--dark-green)]">${Number(amount).toFixed(2)}</div>
                <div className="mt-2 text-xs font-medium text-[var(--dark-green-soft)]">Hand the phone to the customer to enter their PIN</div>
              </div>
              <input autoFocus inputMode="numeric" maxLength={6} type="password" autoComplete="off" aria-label="Customer PIN" value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                className="w-full rounded-[1.5rem] bg-white px-5 py-4 text-center text-2xl tracking-[0.6em] tabular-nums text-[var(--dark-green)] shadow-[var(--card-shadow)] outline-none" placeholder="••••" />
              {error && <p role="alert" className="text-center text-sm text-[var(--outgoing)]">{error}</p>}
              <PrimaryButton disabled={pin.length < 4} onClick={() => { void pay(); }}>Pay</PrimaryButton>
              <button type="button" onClick={() => { setPin(""); setError(""); setPhase("amount"); }} className="w-full text-sm text-[var(--muted-foreground)]">Change amount</button>
            </div>
          )}

          {phase === "paying" && (
            <div className="grid place-items-center py-24">
              <motion.div animate={{ rotate: 360 }} transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }} className="h-10 w-10 rounded-full border-2 border-[var(--dark-green)]/15 border-t-[var(--dark-green)]" />
              <div className="mt-4 text-sm text-[var(--muted-foreground)]">Settling…</div>
            </div>
          )}

          {phase === "done" && result && (
            <div className="mt-8 grid place-items-center rounded-[1.75rem] bg-white px-6 py-10 text-center shadow-[var(--card-shadow)]">
              <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 28 }}
                className="grid h-16 w-16 place-items-center rounded-full bg-[var(--lime-btn)] text-[var(--dark-green)]"><Check className="h-8 w-8" strokeWidth={2.4} /></motion.div>
              <div className="mt-5 text-lg font-semibold tabular-nums text-[var(--dark-green)]">${Number(result.amount).toFixed(2)} received</div>
              <div className="mt-1 inline-flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]"><Volume2 className="h-3.5 w-3.5" /> {instantPayouts ? "Payout to PayPal on its way" : "Added to your balance · cash out to PayPal any time"}</div>
              {result.ref && <div className="mt-1 text-xs tabular-nums text-[var(--muted-foreground)]">Ref {result.ref.slice(0, 8)}</div>}
              <div className="mt-3 text-xs text-[var(--dark-green-soft)]">Customer signed out automatically</div>
              <button type="button" onClick={() => reset("Ready for the next customer.")} className="mt-6 rounded-full bg-[var(--dark-green)] px-5 py-2 text-sm font-semibold text-white">Next customer</button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** A slightly noisy copy of the enrolled vector, like a second touch on a real scanner. */
function demoRecapture(scan: number[]): number[] {
  return scan.map((x) => x + (Math.random() - 0.5) * 0.1);
}

function DemoBanner({ demo }: { demo: DemoCustomer }) {
  return (
    <div className="mt-4 rounded-2xl border border-dashed border-[var(--dark-green)]/30 bg-white/70 px-4 py-3 text-xs text-[var(--dark-green)]">
      <div className="font-semibold">Demo shop · money is simulated</div>
      <div className="mt-1 text-[var(--muted-foreground)]">
        Your customer is <b className="text-[var(--dark-green)]">{demo.label}</b>, PIN <b className="tabular-nums text-[var(--dark-green)]">{demo.pin}</b>.
        Tap <b>Scan finger</b>, use their demo finger, enter the bill, then the PIN. Their wallet is in the User tab.
      </div>
    </div>
  );
}

function MethodTile({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex flex-col items-center gap-2 rounded-[1.5rem] bg-[var(--dark-green)] px-3 py-6 text-white shadow-[var(--card-shadow)] transition active:scale-[0.98]">
      {icon}
      <span className="text-sm font-semibold">{label}</span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block rounded-2xl border border-[var(--hairline)] bg-[var(--chip)] px-4 py-3 transition focus-within:border-[var(--dark-green)]/40 focus-within:bg-white">
      <div className="text-[11px] uppercase tracking-wider text-[var(--muted-foreground)]">{label}</div>
      {children}
    </label>
  );
}
