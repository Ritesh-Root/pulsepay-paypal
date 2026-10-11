import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowLeft, Phone, Lock, ShieldCheck, Fingerprint, ScanFace, ShieldAlert, Check, UserRound, ArrowRight } from "lucide-react";
import { cn } from "./ui/utils";
import { Capture } from "./capture";
import { PayPalButton } from "./paypal-button";
import { api, saveSession, type IdMethod } from "../lib/api";

type Step = "phone" | "signin" | "method" | "scan" | "pin" | "fund" | "done";
type Slot = "finger" | "face" | "distress";

// Mirrors the server: a distress finger this close to the payment finger is refused.
const DISTRESS_MAX_SIMILARITY = 0.83;

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function weakPin(p: string) {
  if (!/^\d{4,6}$/.test(p)) return "PIN must be 4–6 digits";
  if (/^(\d)\1+$/.test(p)) return "Avoid one repeated digit";
  const d = [...p].map(Number);
  const step = d[1] - d[0];
  if ((step === 1 || step === -1) && d.every((x, i) => i === 0 || x - d[i - 1] === step)) return "Avoid a straight run like 1234";
  return "";
}

export function Enroll({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [enrolToken, setEnrolToken] = useState("");
  const [existing, setExisting] = useState(false);
  const [method, setMethod] = useState<IdMethod>("fingerprint");
  const [finger, setFinger] = useState<number[] | null>(null);
  const [face, setFace] = useState<number[] | null>(null);
  const [faceLive, setFaceLive] = useState(false);
  const [distress, setDistress] = useState<number[] | null>(null);
  const [distressChoice, setDistressChoice] = useState<"add" | "skip" | null>(null);
  const [scanKey, setScanKey] = useState(0);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [emergency, setEmergency] = useState("");
  const [amount, setAmount] = useState(150);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [wallet, setWallet] = useState<{ id: string; balance: number; expiry: string } | null>(null);

  const wantsFinger = method !== "face";
  const wantsFace = method !== "fingerprint";
  const steps: Step[] = existing ? ["phone", "signin", "fund"] : ["phone", "method", "scan", "pin", "fund"];
  const labels: Record<string, string> = { phone: "Phone", signin: "PIN", method: "ID", scan: "Scan", pin: "PIN", fund: "Top up" };

  // Which capture is next on the scan step.
  const nextSlot: Slot | "distress-choice" | null = (() => {
    if (wantsFinger && !finger) return "finger";
    if (wantsFace && !face) return "face";
    if (wantsFinger && distressChoice === null) return "distress-choice";
    if (distressChoice === "add" && !distress) return "distress";
    return null;
  })();

  async function sendOtp() {
    setError(""); setInfo(""); setBusy(true);
    const { ok, data } = await api.post("/api/enroll/request-otp", { phone });
    setBusy(false);
    if (!ok) { setError(data.error || "Could not send the code"); return; }
    setOtpSent(true);
    if (data.demo_otp) { setOtp(String(data.demo_otp)); setInfo("Demo mode: code filled in for you."); }
    else setInfo("Code sent by SMS.");
  }

  async function verifyOtp() {
    setError(""); setBusy(true);
    const { ok, data } = await api.post("/api/enroll/verify-otp", { phone, otp });
    setBusy(false);
    if (!ok || !data.verified) { setError(data.error || "Incorrect code"); return; }
    setEnrolToken(data.enrolment_token);
    setExisting(!!data.existing_customer);
    setInfo("");
    setStep(data.existing_customer ? "signin" : "method");
  }

  async function signIn() {
    setError(""); setBusy(true);
    const { ok, status, data } = await api.post("/api/enroll/sign-in", { pin }, enrolToken);
    setBusy(false);
    if (ok) {
      saveSession({ token: data.token, walletId: data.wallet_id, expiry: data.expiry });
      setWallet({ id: data.wallet_id, balance: data.balance, expiry: data.expiry });
      setStep("done");
      return;
    }
    if (status === 404 && data.error === "no_active_wallet") {
      setInfo("Your last wallet has closed. Top up with PayPal to open a new one."); setStep("fund"); return;
    }
    setError(data.error || "Could not sign in");
  }

  function onCaptured(slot: Slot, r: { embedding: number[]; liveness_passed?: boolean }) {
    setError("");
    if (slot === "finger") setFinger(r.embedding);
    if (slot === "face") { setFace(r.embedding); setFaceLive(r.liveness_passed === true); }
    if (slot === "distress") {
      if (finger && cosine(finger, r.embedding) >= DISTRESS_MAX_SIMILARITY) {
        setError("That looks like your payment finger. Use a different finger for distress.");
        setScanKey((k) => k + 1);
        return;
      }
      setDistress(r.embedding);
    }
    setScanKey((k) => k + 1);
  }

  function chooseMethod(m: IdMethod) {
    setMethod(m);
    setFinger(null); setFace(null); setFaceLive(false); setDistress(null); setDistressChoice(null);
  }

  async function createOrder(): Promise<string> {
    setError("");
    const { ok, data } = await api.post("/api/enroll/topup-order", { amount }, enrolToken);
    if (!ok) throw new Error(data.error || "Could not start the PayPal payment");
    return data.order_id;
  }

  async function createWallet(paypalOrderId: string) {
    setError(""); setBusy(true);
    const body = existing
      ? { wallet_pin: pin, paypal_order_id: paypalOrderId }
      : {
          id_method: method,
          ...(wantsFinger ? { fingerprint_embedding: finger } : {}),
          ...(distress ? { distress_fingerprint_embedding: distress } : {}),
          ...(wantsFace ? { face_embedding: face, liveness_passed: faceLive } : {}),
          wallet_pin: pin,
          ...(emergency ? { emergency_contact: emergency } : {}),
          paypal_order_id: paypalOrderId,
        };
    const { ok, data } = await api.post("/api/enroll/create-wallet", body, enrolToken);
    setBusy(false);
    if (ok && data.wallet_id) {
      saveSession({ token: data.token, walletId: data.wallet_id, expiry: data.expiry });
      setWallet({ id: data.wallet_id, balance: data.balance, expiry: data.expiry });
      setStep("done");
      return;
    }
    const msg: string = data.error || "Could not create the wallet";
    setError(msg);
    if (/already registered|distress|scan/i.test(msg) && !existing) { chooseMethod(method); setStep("scan"); }
  }

  const pinProblem = weakPin(pin);
  const canNext = (() => {
    if (step === "method") return true;
    if (step === "scan") return nextSlot === null;
    if (step === "pin") return !pinProblem && pin === pin2 && (!emergency || /^[1-9]\d{9,14}$/.test(emergency));
    return false;
  })();

  function goNext() {
    setError(""); setInfo("");
    const i = steps.indexOf(step);
    setStep(steps[i + 1]);
  }
  function goBack() {
    setError(""); setInfo("");
    const i = steps.indexOf(step);
    if (i > 1) setStep(steps[i - 1]);
  }

  const stepIndex = steps.indexOf(step);

  return (
    <div className="min-w-0 px-2 pb-3">
      {step !== "done" && (
        <ol className="flex gap-1" aria-label="Enrolment progress">
          {steps.map((s, i) => (
            <li key={s} aria-current={s === step ? "step" : undefined}
              className={cn("flex-1 truncate rounded-full px-1 py-1.5 text-center text-[11px] font-medium",
                i === stepIndex ? "bg-[var(--dark-green)] text-white" : i < stepIndex ? "bg-[var(--lime-btn)] text-[var(--dark-green)]" : "bg-white/80 text-[var(--dark-green)]")}>
              {i + 1} {labels[s]}
            </li>
          ))}
        </ol>
      )}

      <div className="mt-3 rounded-[1.5rem] bg-white p-4 shadow-[var(--card-shadow)]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={step} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {step === "phone" && (
              <div className="space-y-2.5">
                <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">Set up a temporary, low-limit wallet funded with PayPal. After this you can leave your phone at home and pay at any PulsePay merchant.</p>
                <Field icon={Phone} label="Mobile number with country code">
                  <input inputMode="numeric" maxLength={15} placeholder="e.g. 14155550123" value={phone} disabled={otpSent}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                    className="w-full bg-transparent tabular-nums outline-none disabled:opacity-60" />
                </Field>
                {!otpSent ? (
                  <button type="button" disabled={busy || !/^[1-9]\d{9,14}$/.test(phone)} onClick={sendOtp}
                    className="w-full rounded-full bg-[var(--dark-green)] py-2.5 text-sm font-semibold text-white disabled:opacity-30">{busy ? "Sending…" : "Send code"}</button>
                ) : (
                  <>
                    <Field icon={Lock} label="6-digit code">
                      <input inputMode="numeric" maxLength={6} value={otp} autoFocus onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                        className="w-full bg-transparent tabular-nums tracking-[0.3em] outline-none" />
                    </Field>
                    <button type="button" disabled={busy || otp.length !== 6} onClick={verifyOtp}
                      className="w-full rounded-full bg-[var(--dark-green)] py-2.5 text-sm font-semibold text-white disabled:opacity-30">{busy ? "Checking…" : "Verify"}</button>
                    <button type="button" onClick={() => { setOtpSent(false); setOtp(""); setInfo(""); }} className="w-full text-xs text-[var(--muted-foreground)]">Use a different number</button>
                  </>
                )}
              </div>
            )}

            {step === "signin" && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-[var(--dark-green)]"><UserRound className="h-4 w-4" /> Welcome back</div>
                <Field icon={Lock} label="Your PIN">
                  <input inputMode="numeric" type="password" maxLength={6} value={pin} autoFocus onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    className="w-full bg-transparent tabular-nums tracking-[0.4em] outline-none" />
                </Field>
                <button type="button" disabled={busy || pin.length < 4} onClick={signIn}
                  className="w-full rounded-full bg-[var(--dark-green)] py-2.5 text-sm font-semibold text-white disabled:opacity-30">{busy ? "Checking…" : "Sign in"}</button>
              </div>
            )}

            {step === "method" && (
              <div className="space-y-2">
                <p className="text-sm font-semibold text-[var(--dark-green)]">How should merchants recognise you?</p>
                <p className="text-xs text-[var(--muted-foreground)]">This replaces the number on a card. You always type your PIN too.</p>
                {([
                  { id: "fingerprint", title: "Fingerprint", sub: "Fastest. Lets you add a distress finger.", icon: Fingerprint },
                  { id: "face", title: "Face", sub: "For phones without a fingerprint sensor.", icon: ScanFace },
                  { id: "both", title: "Fingerprint + face", sub: "Most secure: both are checked every time.", icon: ShieldCheck },
                ] as const).map((o) => (
                  <button key={o.id} type="button" onClick={() => chooseMethod(o.id)} aria-pressed={method === o.id}
                    className={cn("flex w-full items-center gap-3 rounded-2xl border px-3 py-3 text-left",
                      method === o.id ? "border-[var(--dark-green)] bg-[var(--dark-green)] text-white" : "border-[var(--hairline)]")}>
                    <o.icon className="h-5 w-5 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{o.title}</span>
                      <span className={cn("block text-xs", method === o.id ? "text-white/80" : "text-[var(--muted-foreground)]")}>{o.sub}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {step === "scan" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  {wantsFinger && <Chip done={!!finger} icon={Fingerprint} label="Payment finger" />}
                  {wantsFace && <Chip done={!!face} icon={ScanFace} label="Face" />}
                  {wantsFinger && distressChoice !== "skip" && <Chip done={!!distress} icon={ShieldAlert} label="Distress finger" />}
                </div>

                {nextSlot === "finger" && (
                  <Capture key={`finger-${scanKey}`} endpoint="fingerprint" label="Hold your payment finger inside the guide. (The camera stands in for a fingerprint sensor.)" onResult={(r) => onCaptured("finger", r)} />
                )}
                {nextSlot === "face" && (
                  <Capture key={`face-${scanKey}`} endpoint="face" requireLiveness label="Look straight at the camera." onResult={(r) => onCaptured("face", r)} />
                )}
                {nextSlot === "distress-choice" && (
                  <div className="rounded-2xl bg-[var(--chip)] p-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-[var(--dark-green)]"><ShieldAlert className="h-4 w-4" /> Add a distress finger?</div>
                    <p className="mt-1 text-xs leading-relaxed text-[var(--muted-foreground)]">
                      If someone forces you to pay, use this finger instead. The payment looks normal, is capped at a small amount, and your emergency contact gets a silent alert with the shop's name.
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <button type="button" onClick={() => setDistressChoice("add")} className="rounded-full bg-[var(--dark-green)] py-2 text-sm font-semibold text-white">Add one</button>
                      <button type="button" onClick={() => setDistressChoice("skip")} className="rounded-full border border-[var(--hairline)] bg-white py-2 text-sm">Skip</button>
                    </div>
                  </div>
                )}
                {nextSlot === "distress" && (
                  <Capture key={`distress-${scanKey}`} endpoint="fingerprint" label="Now a DIFFERENT finger for distress." onResult={(r) => onCaptured("distress", r)} />
                )}
                {nextSlot === null && (
                  <p className="inline-flex items-center gap-1.5 text-xs text-emerald-700"><Check className="h-3.5 w-3.5" /> Scans ready.
                    <button type="button" className="underline" onClick={() => chooseMethod(method)}>Redo</button>
                  </p>
                )}
              </div>
            )}

            {step === "pin" && (
              <div className="space-y-2.5">
                <Field icon={Lock} label="Choose a PIN (4–6 digits)">
                  <input inputMode="numeric" type="password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                    className="w-full bg-transparent tabular-nums tracking-[0.4em] outline-none" />
                </Field>
                <Field icon={Lock} label="Repeat PIN">
                  <input inputMode="numeric" type="password" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
                    className="w-full bg-transparent tabular-nums tracking-[0.4em] outline-none" />
                </Field>
                {pin.length >= 4 && pinProblem && <p className="text-xs text-red-600">{pinProblem}</p>}
                {pin2.length >= 4 && pin !== pin2 && <p className="text-xs text-red-600">PINs don't match</p>}
                <Field icon={Phone} label={distress ? "Emergency contact (gets the silent alert)" : "Emergency contact (optional)"}>
                  <input inputMode="numeric" maxLength={15} placeholder="with country code" value={emergency} onChange={(e) => setEmergency(e.target.value.replace(/\D/g, ""))}
                    className="w-full bg-transparent tabular-nums outline-none" />
                </Field>
                <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">You type this PIN on the merchant's phone, like a card PIN. Three wrong tries lock it for 30 minutes.</p>
              </div>
            )}

            {step === "fund" && (
              <div className="space-y-3">
                {existing && (
                  <Field icon={Lock} label="Your PIN">
                    <input inputMode="numeric" type="password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                      className="w-full bg-transparent tabular-nums tracking-[0.4em] outline-none" />
                  </Field>
                )}
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-[var(--muted-foreground)]">Top up</span>
                  <span className="font-semibold tabular-nums text-[var(--dark-green)]">${amount.toFixed(2)}</span>
                </div>
                <input type="range" min={10} max={200} step={5} value={amount} aria-label="Top-up amount" onChange={(e) => setAmount(Number(e.target.value))} className="w-full accent-[var(--dark-green)]" />
                <p className="text-xs text-[var(--muted-foreground)]">Low-limit wallet: up to $200, open for 72 hours. Anything you don't spend is refunded to your PayPal.</p>
                {busy ? (
                  <p className="py-3 text-center text-sm text-[var(--muted-foreground)]">Creating your wallet…</p>
                ) : (
                  <PayPalButton
                    disabled={existing && pin.length < 4}
                    createOrder={createOrder}
                    onApproved={(orderId) => { void createWallet(orderId); }}
                    onError={(m) => setError(m)}
                  />
                )}
              </div>
            )}

            {step === "done" && wallet && (
              <div className="grid place-items-center py-6 text-center">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[var(--dark-green)] text-white"><ShieldCheck className="h-6 w-6" /></div>
                <div className="mt-3 text-sm font-semibold text-[var(--dark-green)]">Wallet ready</div>
                <div className="mt-1 text-xs text-[var(--muted-foreground)]">Balance ${(wallet.balance / 100).toFixed(2)} · open until {new Date(wallet.expiry).toLocaleString()}</div>
                <p className="mt-3 max-w-xs text-xs leading-relaxed text-[var(--muted-foreground)]">You can leave your phone at home now. At the shop: scan, the merchant enters the bill, you type your PIN.</p>
                <button type="button" onClick={onDone} className="mt-4 inline-flex items-center gap-2 rounded-full bg-[var(--dark-green)] px-5 py-2 text-sm text-white">Done <ArrowRight className="h-4 w-4" /></button>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {info && <p className="mt-2 text-center text-xs text-[var(--dark-green-soft)]">{info}</p>}
        {error && <p role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

        {(step === "method" || step === "scan" || step === "pin" || step === "fund") && (
          <div className="mt-4 flex items-center justify-between">
            <button type="button" onClick={goBack} disabled={stepIndex <= 1}
              className="inline-flex items-center gap-1 rounded-full px-3 py-2 text-sm text-[var(--muted-foreground)] disabled:opacity-30"><ArrowLeft className="h-4 w-4" /> Back</button>
            {step !== "fund" && (
              <button type="button" onClick={goNext} disabled={busy || !canNext}
                className="inline-flex items-center gap-2 rounded-full bg-[var(--dark-green)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-30">
                {busy ? "Working…" : "Continue"} <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Chip({ done, icon: Icon, label }: { done: boolean; icon: typeof Phone; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs", done ? "bg-[var(--dark-green)] text-white" : "bg-[var(--chip)] text-[var(--muted-foreground)]")}>
      <Icon className="h-3.5 w-3.5" /> {label}{done ? " ✓" : ""}
    </span>
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
