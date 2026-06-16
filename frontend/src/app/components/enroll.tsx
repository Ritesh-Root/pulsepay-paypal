import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight, ArrowLeft, Phone, Lock, Banknote, ShieldCheck, Fingerprint, ScanFace, ShieldAlert } from "lucide-react";
import { Panel } from "./surface";
import { Capture } from "./capture";
import { cn } from "./ui/utils";
import { api, saveSession } from "../lib/api";

const STEPS = ["Identity", "Biometric", "Security", "Funding"] as const;

export function Enroll({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [enrolToken, setEnrolToken] = useState("");
  const [bioStep, setBioStep] = useState(0); // 0 primary, 1 distress, 2 face
  const [fp, setFp] = useState<number[] | null>(null);
  const [distress, setDistress] = useState<number[] | null>(null);
  const [face, setFace] = useState<number[] | null>(null);
  const [faceLive, setFaceLive] = useState(false);
  const [walletPin, setWalletPin] = useState("");
  const [amount, setAmount] = useState(1500);
  const [source, setSource] = useState<"sbi_cbs" | "upi">("sbi_cbs");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [wallet, setWallet] = useState<{ id: string; balance: number; expiry: string } | null>(null);

  const bioComplete = !!(fp && distress && face);
  const canNext = (() => {
    if (step === 0) return !!enrolToken;
    if (step === 1) return bioComplete;
    if (step === 2) return /^\d{4,6}$/.test(walletPin);
    return true;
  })();

  async function sendOtp() {
    setError(""); setBusy(true);
    const { ok, data } = await api.post("/api/enroll/request-otp", { reference: phone, phone });
    setBusy(false);
    if (ok && data.otp_sent) { setOtpSent(true); if (data.dev_otp) setOtp(String(data.dev_otp)); }
    else setError(data.error || "Could not send OTP");
  }
  async function verifyOtp() {
    setError(""); setBusy(true);
    const { ok, data } = await api.post("/api/enroll/verify-otp", { reference: phone, otp, phone });
    setBusy(false);
    if (ok && data.verified) setEnrolToken(data.enrolment_token);
    else setError(data.error || "Invalid OTP");
  }
  async function createWallet() {
    setError(""); setBusy(true);
    const { ok, data } = await api.post("/api/enroll/create-wallet", {
      fingerprint_embedding: fp, distress_fingerprint_embedding: distress,
      face_embedding: face, liveness_passed: faceLive, wallet_pin: walletPin,
      amount, phone, funding_source: source,
    }, enrolToken);
    setBusy(false);
    if (ok && data.wallet_id) {
      saveSession({ token: data.token, walletId: data.wallet_id, expiry: data.expiry });
      setWallet({ id: data.wallet_id, balance: data.balance, expiry: data.expiry });
      setDone(true);
    } else setError(data.error || "Could not create wallet");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <Panel className="p-5">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">Enrolment</div>
          <ol className="mt-4 space-y-1">
            {STEPS.map((s, i) => {
              const active = i === step, complete = i < step || done;
              return (
                <li key={s}>
                  <button onClick={() => i <= step && setStep(i)}
                    className={cn("flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors",
                      active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-[var(--chip)]")}>
                    <span className={cn("grid h-6 w-6 place-items-center rounded-full border tabular-nums",
                      active ? "border-background/30" : complete ? "border-foreground bg-foreground text-background" : "border-[var(--hairline)]")}>{i + 1}</span>
                    {s}
                  </button>
                </li>
              );
            })}
          </ol>
        </Panel>
      </aside>

      <Panel title={done ? "Wallet ready" : STEPS[step]}
        description={done ? "Funded and active. Use the Merchant tab to make a payment." : "Attended enrolment — biometrics become encrypted, revocable vectors. No image is stored."}>
        <AnimatePresence mode="wait" initial={false}>
          {done && wallet ? (
            <motion.div key="done" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} className="grid place-items-center py-10">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-foreground text-background"><ShieldCheck className="h-8 w-8" strokeWidth={2.2} /></div>
              <div className="mt-5 tracking-tight tabular-nums">Wallet {wallet.id.slice(0, 8)}…</div>
              <div className="mt-1 text-sm text-muted-foreground">Balance ₹{(wallet.balance / 100).toLocaleString("en-IN")} · expires {new Date(wallet.expiry).toLocaleDateString()}</div>
              <button onClick={onDone} className="mt-6 inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2 text-sm text-background hover:opacity-90 active:scale-[0.98] transition">Try a payment <ArrowRight className="h-4 w-4" /></button>
            </motion.div>
          ) : (
            <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="min-h-[340px]">
              {/* Identity */}
              {step === 0 && (
                <div className="mx-auto max-w-md space-y-5">
                  <Field icon={Phone} label="Mobile number">
                    <input inputMode="numeric" maxLength={10} placeholder="10-digit mobile" value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} disabled={!!enrolToken}
                      className="w-full bg-transparent outline-none tabular-nums disabled:opacity-60" />
                  </Field>
                  <div className="flex items-center gap-3">
                    <Field icon={Lock} label="OTP" className="flex-1">
                      <input inputMode="numeric" maxLength={6} placeholder="6-digit code" value={otp} disabled={!otpSent || !!enrolToken}
                        onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                        className="w-full bg-transparent outline-none tabular-nums disabled:opacity-50" />
                    </Field>
                    {!enrolToken && (
                      <button type="button" disabled={busy || !/^\d{10}$/.test(phone)} onClick={sendOtp}
                        className="rounded-2xl border border-[var(--hairline)] px-4 py-3 text-sm hover:bg-[var(--chip)] disabled:opacity-40">{otpSent ? "Resend" : "Send OTP"}</button>
                    )}
                  </div>
                  {otpSent && !enrolToken && (
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">Code delivered server-side (Aadhaar AUA/KUA) — not shown here.</p>
                      <button disabled={busy || otp.length !== 6} onClick={verifyOtp}
                        className="rounded-full bg-foreground px-4 py-2 text-sm text-background disabled:opacity-30">Verify</button>
                    </div>
                  )}
                  {enrolToken && <p className="inline-flex items-center gap-1.5 text-sm text-emerald-600"><ShieldCheck className="h-4 w-4" /> Identity verified — continue.</p>}
                </div>
              )}

              {/* Biometric: 3 captures */}
              {step === 1 && (
                <div className="space-y-5">
                  <div className="mx-auto flex max-w-md items-center justify-center gap-2">
                    {([["Payment finger", fp, Fingerprint], ["Distress finger", distress, ShieldAlert], ["Face (step-up)", face, ScanFace]] as const).map(([lbl, val, Ic], i) => (
                      <div key={lbl} className={cn("flex flex-1 items-center gap-2 rounded-2xl border px-3 py-2 text-xs", val ? "border-foreground bg-foreground text-background" : i === bioStep ? "border-foreground/40" : "border-[var(--hairline)] text-muted-foreground")}>
                        <Ic className="h-3.5 w-3.5" /> <span className="truncate">{lbl}</span>
                      </div>
                    ))}
                  </div>
                  {bioStep === 0 && <Capture endpoint="fingerprint" label="Scan your PAYMENT finger. (This web demo uses the camera as a stand-in for the AePS fingerprint scanner.)" onResult={(r) => { setFp(r.embedding); setBioStep(1); }} />}
                  {bioStep === 1 && <Capture endpoint="fingerprint" label="Register your DISTRESS finger — show a DIFFERENT finger. Using it later pays normally but silently alerts your contact." onResult={(r) => { setDistress(r.embedding); setBioStep(2); }} />}
                  {bioStep === 2 && <Capture endpoint="face" requireLiveness label="Face check — used only for larger payments." onResult={(r) => { setFace(r.embedding); setFaceLive(!!r.liveness_passed); }} />}
                  {bioComplete && <p className="text-center text-sm text-emerald-600">All three captured ✓ — continue.</p>}
                </div>
              )}

              {/* Security */}
              {step === 2 && (
                <div className="mx-auto max-w-md space-y-4">
                  <Field icon={Lock} label="Wallet PIN">
                    <input inputMode="numeric" maxLength={6} placeholder="4–6 digits" value={walletPin}
                      onChange={(e) => setWalletPin(e.target.value.replace(/\D/g, ""))} className="w-full bg-transparent outline-none tabular-nums" />
                  </Field>
                  <p className="rounded-2xl bg-[var(--chip)] p-3 text-xs leading-relaxed text-muted-foreground">
                    Your PIN is the knowledge factor paired with your fingerprint (RBI AFA). Distress is handled by your distinct distress finger — no separate distress PIN needed.
                  </p>
                </div>
              )}

              {/* Funding */}
              {step === 3 && (
                <div className="mx-auto max-w-md space-y-6">
                  <div>
                    <div className="mb-2 flex items-baseline justify-between">
                      <span className="text-sm text-muted-foreground">Amount</span>
                      <span className="tracking-tight tabular-nums">₹{amount.toLocaleString("en-IN")}</span>
                    </div>
                    <input type="range" min={1000} max={2000} step={50} value={amount} onChange={(e) => setAmount(Number(e.target.value))} className="w-full accent-foreground" />
                    <div className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums"><span>₹1,000</span><span>₹2,000</span></div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    {([{ id: "sbi_cbs", title: "SBI Account", sub: "CBS debit" }, { id: "upi", title: "UPI", sub: "Any bank" }] as const).map((opt) => (
                      <button key={opt.id} onClick={() => setSource(opt.id)}
                        className={cn("flex flex-col items-start gap-1 rounded-2xl border p-4 text-left transition-all", source === opt.id ? "border-foreground bg-foreground text-background" : "border-[var(--hairline)] hover:bg-[var(--chip)]")}>
                        <Banknote className="h-4 w-4" strokeWidth={2} />
                        <div className="mt-1 text-sm">{opt.title}</div>
                        <div className={cn("text-xs", source === opt.id ? "text-background/70" : "text-muted-foreground")}>{opt.sub}</div>
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Funds settle on SBI CBS · 72-hour auto-expiry with auto-refund.</p>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {error && <p className="mt-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

        {!done && (
          <div className="mt-8 flex items-center justify-between">
            <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
              className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-30"><ArrowLeft className="h-4 w-4" /> Back</button>
            <button onClick={() => (step === STEPS.length - 1 ? createWallet() : setStep((s) => s + 1))} disabled={!canNext || busy}
              className="inline-flex items-center gap-2 rounded-full bg-foreground px-5 py-2 text-sm text-background transition hover:opacity-90 active:scale-[0.98] disabled:opacity-30">
              {busy ? "Working…" : step === STEPS.length - 1 ? "Create wallet" : "Continue"} <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Field({ icon: Icon, label, children, className }: { icon: typeof Phone; label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex items-center gap-3 rounded-2xl border border-[var(--hairline)] bg-[var(--chip)] px-4 py-3 transition focus-within:border-foreground/40 focus-within:bg-card", className)}>
      <Icon className="h-4 w-4 text-muted-foreground" strokeWidth={2} />
      <div className="flex-1">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
        {children}
      </div>
    </label>
  );
}
