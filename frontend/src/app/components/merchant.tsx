import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, Volume2 } from "lucide-react";
import { Panel, Stat } from "./surface";
import { Capture } from "./capture";
import { cn } from "./ui/utils";
import { api, getTerminalToken, API_URL } from "../lib/api";

type Phase = "form" | "scan" | "pin" | "face" | "otp" | "executing" | "done";

export function Merchant() {
  const [phase, setPhase] = useState<Phase>("form");
  const [amount, setAmount] = useState(450);
  const merchant = "kirana@upi";
  const [pin, setPin] = useState("");
  const [otp, setOtp] = useState("");
  const [otpRef, setOtpRef] = useState("");
  const [fp, setFp] = useState<number[] | null>(null);
  const [face, setFace] = useState<number[] | null>(null);
  const [confidence, setConfidence] = useState(0);
  const [tier, setTier] = useState("");
  const [token, setToken] = useState("");
  const [paidId, setPaidId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { getTerminalToken(merchant).then(setToken).catch(() => setError("Cannot reach terminal service")); }, []);

  const reset = () => { setPhase("form"); setPin(""); setOtp(""); setOtpRef(""); setFp(null); setFace(null); setConfidence(0); setTier(""); setPaidId(""); setError(""); };

  async function authenticate(opts: { face?: number[]; otp?: string } = {}) {
    setError("");
    const body: any = { fingerprint_embedding: fp, pin, amount, merchant_upi: merchant };
    const f = opts.face || face; if (f) body.face_embedding = f;
    if (otpRef) { body.otp_reference = otpRef; const o = opts.otp || otp; if (o) body.otp = o; }
    const { ok, data } = await api.post("/api/payment/authenticate", body, token);
    if (data.requires_face) { setTier(data.tier); setPhase("face"); return; }
    if (data.requires_otp) { setOtpRef(data.otp_reference); setTier(data.tier); setPhase("otp"); return; }
    if (ok && data.authenticated) {
      setConfidence(data.confidence_score || 0); setTier(data.tier || "");
      await execute(data.assertion_token, data.wallet_id);
      return;
    }
    setError(data.error || "Authentication failed"); setPhase("pin");
  }

  async function execute(assertion: string, walletId: string) {
    setPhase("executing");
    const { ok, data } = await api.post("/api/payment/execute", { wallet_id: walletId, amount, merchant_upi: merchant, assertion_token: assertion }, token);
    if (ok && data.status === "completed") {
      setPaidId(data.transaction_id || "");
      setPhase("done");
      speak(`Payment of ${amount} rupees to ${merchant} successful.`);
    } else { setError(data.error || "Payment failed on rails"); setPhase("form"); }
  }

  async function speak(fallback: string) {
    let text = fallback;
    try { const r = await fetch(`${API_URL}/api/voice/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount, merchant_name: merchant }) }); const d = await r.json(); if (d.text) text = d.text; } catch { /* ignore */ }
    try { const u = new SpeechSynthesisUtterance(text); window.speechSynthesis.speak(u); } catch { /* ignore */ }
  }

  const tierLabel = amount > 1500 ? "T3 · +OTP" : amount > 500 ? "T2 · +face" : "T1 · finger+PIN";

  return (
    <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
      <Panel title="Terminal" description="Phone-less payment. The distress finger is indistinguishable from a normal payment by design.">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={phase} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="min-h-[360px]">
            {phase === "form" && (
              <div className="space-y-5">
                <div className="rounded-3xl border border-[var(--hairline)] bg-[var(--chip)] p-6 text-center">
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">Amount due</div>
                  <div className="mt-2 text-5xl tracking-tight tabular-nums">₹{amount.toLocaleString("en-IN")}</div>
                  <div className="mt-1 text-sm text-muted-foreground">to {merchant}</div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[200, 450, 1200, 2400].map((v) => (
                    <button key={v} onClick={() => setAmount(v)} className={cn("rounded-xl border py-2 text-sm tabular-nums transition", amount === v ? "border-foreground bg-foreground text-background" : "border-[var(--hairline)] hover:bg-[var(--chip)]")}>₹{v}</button>
                  ))}
                </div>
                <button onClick={() => setPhase("scan")} className="w-full rounded-2xl bg-foreground py-3 text-background transition hover:opacity-90 active:scale-[0.99]">Authenticate to pay</button>
              </div>
            )}

            {phase === "scan" && (
              <div className="py-4">
                <Capture endpoint="fingerprint" label="Customer: place your finger on the scanner. (Web demo uses the camera.)" onResult={(r) => { setFp(r.embedding); setPhase("pin"); }} />
              </div>
            )}

            {phase === "pin" && (
              <div className="mx-auto max-w-sm space-y-5 py-4">
                <div className="text-center text-sm text-muted-foreground">Enter your wallet PIN</div>
                <input autoFocus inputMode="numeric" maxLength={6} type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-2xl border border-[var(--hairline)] bg-[var(--chip)] px-5 py-4 text-center text-2xl tracking-[0.6em] tabular-nums outline-none focus:border-foreground/40 focus:bg-card" placeholder="••••" />
                <button disabled={pin.length < 4} onClick={() => authenticate()} className="w-full rounded-2xl bg-foreground py-3 text-background transition hover:opacity-90 active:scale-[0.99] disabled:opacity-30">Confirm</button>
              </div>
            )}

            {phase === "face" && (
              <div className="py-4">
                <Capture endpoint="face" requireLiveness label="Larger amount — look at the camera for the face step-up." onResult={(r) => { setFace(r.embedding); authenticate({ face: r.embedding }); }} />
              </div>
            )}

            {phase === "otp" && (
              <div className="mx-auto max-w-sm space-y-5 py-4">
                <div className="text-center text-sm text-muted-foreground">High-value payment — enter the OTP sent to the customer's phone</div>
                <input autoFocus inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  className="w-full rounded-2xl border border-[var(--hairline)] bg-[var(--chip)] px-5 py-4 text-center text-2xl tracking-[0.4em] tabular-nums outline-none focus:border-foreground/40 focus:bg-card" placeholder="000000" />
                <button disabled={otp.length !== 6} onClick={() => authenticate({ otp })} className="w-full rounded-2xl bg-foreground py-3 text-background transition hover:opacity-90 active:scale-[0.99] disabled:opacity-30">Verify &amp; pay</button>
              </div>
            )}

            {phase === "executing" && (
              <div className="grid place-items-center py-20">
                <motion.div animate={{ rotate: 360 }} transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }} className="h-10 w-10 rounded-full border-2 border-foreground/15 border-t-foreground" />
                <div className="mt-4 text-sm text-muted-foreground">Settling over UPI 123Pay…</div>
              </div>
            )}

            {phase === "done" && (
              <div className="grid place-items-center py-12">
                <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 28 }} className="grid h-16 w-16 place-items-center rounded-2xl bg-foreground text-background"><Check className="h-8 w-8" strokeWidth={2.4} /></motion.div>
                <div className="mt-5 tracking-tight tabular-nums">₹{amount.toLocaleString("en-IN")} paid to {merchant}</div>
                <div className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Volume2 className="h-3.5 w-3.5" /> "Payment of {amount} rupees to {merchant} successful."</div>
                {paidId && <div className="mt-1 text-xs text-muted-foreground tabular-nums">Txn {paidId.slice(0, 8)}…</div>}
                <button onClick={reset} className="mt-6 rounded-full border border-[var(--hairline)] px-5 py-2 text-sm hover:bg-[var(--chip)]">New payment</button>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
        {error && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      </Panel>

      <Panel title="Session" description="Live signal during authentication.">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Merchant" value={merchant} />
          <Stat label="Tier" value={tier || tierLabel} hint={amount > 500 ? "step-up" : "base"} />
          <Stat label="Match confidence" value={confidence ? `${confidence}%` : "—"} hint="cosine sim · 1024-d" />
          <Stat label="Assertion TTL" value={phase === "form" || phase === "done" ? "—" : "~90s"} />
        </div>
        <div className="mt-5 rounded-2xl border border-[var(--hairline)] bg-[var(--chip)] p-4 text-sm text-muted-foreground leading-relaxed">
          The customer scans their fingerprint and enters a PIN. Using their <strong>distinct distress finger</strong> completes the payment and silently triggers an SOS with GPS — the terminal shows an identical result.
        </div>
      </Panel>
    </div>
  );
}
