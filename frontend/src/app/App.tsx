import { useEffect, useState } from "react";
import {
  BalanceCard,
  BottomNav,
  HomeScreen,
  ModeToggle,
  PhoneShell,
  PrimaryButton,
  ScreenHeader,
  TxList,
  Pencil,
  Building2,
} from "./components/wallet-ui";
import { Enroll } from "./components/enroll";
import { Merchant, type MerchantPhase } from "./components/merchant";
import { PayPalButton } from "./components/paypal-button";
import { cn } from "./components/ui/utils";
import { api, getSession, clearSession, newIdempotencyKey } from "./lib/api";
import {
  DEMO_RECIPIENT,
  DEMO_USER,
  formatUsd,
  loadDemoWallet,
  saveDemoWallet,
  type Tx,
  type WalletSnap,
} from "./lib/wallet-store";

type Screen = "home" | "send" | "bank" | "profile" | "txs" | "enroll";
type Mode = "merchant" | "user";

export default function App() {
  const [mode, setMode] = useState<Mode>("merchant");
  const [screen, setScreen] = useState<Screen>("home");
  const [payPhase, setPayPhase] = useState<MerchantPhase>("ready");
  const [wallet, setWallet] = useState<WalletSnap>(() => loadDemoWallet().wallet);
  const [txs, setTxs] = useState<Tx[]>(() => loadDemoWallet().transactions);
  const [live, setLive] = useState(false);
  const [userName, setUserName] = useState(DEMO_USER.name);
  const [userEmail, setUserEmail] = useState(DEMO_USER.email);
  const [msg, setMsg] = useState("");

  function showDemo() {
    const demo = loadDemoWallet();
    setWallet(demo.wallet);
    setTxs(demo.transactions);
    setLive(false);
    setUserName(DEMO_USER.name);
    setUserEmail(DEMO_USER.email);
  }

  async function refresh() {
    const session = getSession();
    if (!session) { showDemo(); return; }
    const w = await api.get(`/api/wallet/${session.walletId}`, session.token);
    if (w.ok) {
      setWallet(w.data.wallet);
      setTxs((w.data.transactions || []).map((t: any) => ({ ...t, direction: t.kind === "fund" || t.kind === "merchant_refund" ? "in" : "out" })));
      setLive(true);
      const last4 = w.data.user?.phone_last4;
      const method = { fingerprint: "Fingerprint ID", face: "Face ID", both: "Fingerprint + face ID" }[w.data.user?.id_method as string] || "";
      setUserName("Customer");
      setUserEmail([last4 ? `Phone ••${last4}` : "", method].filter(Boolean).join(" · "));
    } else if (w.status === 401 || w.status === 403 || w.status === 404) {
      clearSession();
      showDemo();
      setMsg("Your session ended. Sign in again from Profile.");
    }
  }

  useEffect(() => { refresh(); }, []);

  const navActive = screen === "profile" || screen === "enroll" ? "profile" : "home";
  // Hide the mode switch while a customer is mid-payment on the merchant terminal.
  const customerAtTerminal = payPhase === "scan" || payPhase === "amount" || payPhase === "pin" || payPhase === "paying";
  const showToggle = mode === "merchant" ? !customerAtTerminal : (screen === "home" || screen === "profile");

  function setAppMode(next: Mode) {
    setMode(next);
    setScreen("home");
    if (next === "user") void refresh(); // a wallet may have been opened meanwhile (e.g. "Try the demo")
  }

  return (
    <PhoneShell docked={mode === "user"}>
      {showToggle && (
        <div className="pt-5">
          <ModeToggle mode={mode} onChange={setAppMode} />
        </div>
      )}
      {mode === "merchant" ? <Merchant onPhase={setPayPhase} /> : (<>
      {screen === "home" && !live && (
        <p className="mx-5 mt-3 rounded-2xl border border-dashed border-[var(--dark-green)]/30 bg-white/70 px-4 py-2 text-center text-xs text-[var(--muted-foreground)]">
          Sample wallet, not connected to PulsePay. Create a real one in Profile, or tap “Try the demo” in Merchant mode.
        </p>
      )}
      {screen === "home" && (
        <HomeScreen
          userName={userName}
          userEmail={userEmail}
          wallet={wallet}
          txs={txs}
          onSend={() => setScreen("send")}
          onBank={() => setScreen("bank")}
          onSeeAll={() => setScreen("txs")}
        />
      )}
      {screen === "txs" && (
        <div>
          <ScreenHeader title="Transactions" onBack={() => setScreen("home")} />
          <div className="px-5 pt-2"><TxList txs={txs} /></div>
        </div>
      )}
      {screen === "send" && (
        <SendScreen
          wallet={wallet}
          live={live}
          onBack={() => setScreen("home")}
          onDone={async () => { await refresh(); setScreen("home"); }}
          onLocalSend={(amountCents, description) => {
            const nextBal = wallet.balance - amountCents;
            if (nextBal < 0) { setMsg("Insufficient demo balance"); return false; }
            const nextWallet = { ...wallet, balance: nextBal };
            const nextTx: Tx = {
              id: `local-${Date.now()}`,
              counterparty: description || DEMO_RECIPIENT.email,
              amount: amountCents,
              status: "completed",
              created_at: new Date().toISOString(),
              direction: "out",
            };
            const nextTxs = [nextTx, ...txs];
            setWallet(nextWallet);
            setTxs(nextTxs);
            saveDemoWallet(nextWallet, nextTxs);
            setScreen("home");
            return true;
          }}
        />
      )}
      {screen === "bank" && (
        <BankScreen
          wallet={wallet}
          live={live}
          msg={msg}
          setMsg={setMsg}
          onBack={() => setScreen("home")}
          onRefresh={refresh}
        />
      )}
      {screen === "profile" && (
        <ProfileScreen
          live={live}
          userName={userName}
          userEmail={userEmail}
          onEnroll={() => setScreen("enroll")}
          onLogout={() => { clearSession(); refresh(); setMsg("Signed out of live wallet."); }}
        />
      )}
      {screen === "enroll" && (
        <div className="min-w-0 overflow-x-hidden px-3 pt-2">
          <ScreenHeader title="Enrol" onBack={() => setScreen("profile")} />
          <Enroll onDone={() => { refresh(); setScreen("home"); }} />
        </div>
      )}

      {(screen === "home" || screen === "profile" || screen === "txs") && (
        <BottomNav
          active={navActive}
          onHome={() => setScreen("home")}
          onProfile={() => setScreen("profile")}
        />
      )}
      </>)}
    </PhoneShell>
  );
}

function SendScreen({
  wallet,
  live,
  onBack,
  onDone,
  onLocalSend,
}: {
  wallet: WalletSnap;
  live: boolean;
  onBack: () => void;
  onDone: () => void;
  onLocalSend: (amountCents: number, description: string) => boolean;
}) {
  const [dollars, setDollars] = useState("20");
  const [description, setDescription] = useState("");
  const [recipient, setRecipient] = useState(DEMO_RECIPIENT);
  const [editing, setEditing] = useState(false);
  const [phase, setPhase] = useState<"form" | "pin" | "busy">("form");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  // One key for this Send screen: a retry after a lost response returns the first
  // result instead of paying twice.
  const [idemKey] = useState(newIdempotencyKey);

  const amountCents = Math.round(Number(dollars || 0) * 100);
  const limit = wallet.per_payment_limit || 10000;

  async function submitLive() {
    const session = getSession();
    if (!session) { setError("Sign in again from Profile."); return; }
    setError("");
    setPhase("busy");
    const r = await api.post("/api/wallet/send", {
      wallet_id: session.walletId, to_email: recipient.email, amount: dollars, pin, idempotency_key: idemKey,
    }, session.token);
    if (r.ok && r.data.status === "completed") { onDone(); return; }
    setPin("");
    if (r.status === 401 && typeof r.data.attempts_left === "number") {
      setError(`Incorrect PIN. ${r.data.attempts_left} ${r.data.attempts_left === 1 ? "try" : "tries"} left.`);
      setPhase("pin");
      return;
    }
    if (r.status === 0) {
      setError("Connection lost. Tap Send again: you'll only be charged once.");
      setPhase("pin");
      return;
    }
    setError(r.data.error || "Payment failed");
    setPhase("form");
  }

  function onSendMoney() {
    setError("");
    if (!/^\d+(\.\d{1,2})?$/.test(dollars) || amountCents <= 0) { setError("Enter an amount"); return; }
    if (amountCents > limit) { setError(`Up to $${formatUsd(limit)} per payment`); return; }
    if (amountCents > wallet.balance) { setError("Insufficient balance"); return; }
    if (live) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipient.email)) { setError("Enter the recipient's PayPal email"); return; }
      setPhase("pin");
      return;
    }
    const note = description.trim() || `${recipient.name} · ${recipient.email}`;
    if (!onLocalSend(amountCents, note)) setError("Insufficient balance");
  }

  return (
    <div>
      <ScreenHeader title="Send" onBack={onBack} />
      <BalanceCard balanceCents={wallet.balance} compact />

      <div className="mx-5 mt-4 flex items-center gap-3 rounded-[1.25rem] bg-white px-3 py-3 shadow-[var(--card-shadow)]">
        <div className="grid h-11 w-11 place-items-center rounded-full bg-[var(--dark-green)] text-xs font-semibold text-white">
          {recipient.initials}
        </div>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-1">
              <input aria-label="Recipient name" className="w-full rounded-lg bg-[var(--chip)] px-2 py-1 text-sm outline-none" value={recipient.name} onChange={(e) => setRecipient({ ...recipient, name: e.target.value, initials: e.target.value.slice(0, 2).toUpperCase() || "??" })} />
              <input aria-label="Recipient PayPal email" type="email" autoCapitalize="none" className="w-full rounded-lg bg-[var(--chip)] px-2 py-1 text-xs outline-none" value={recipient.email} onChange={(e) => setRecipient({ ...recipient, email: e.target.value.trim() })} />
            </div>
          ) : (
            <>
              <div className="truncate text-sm font-semibold text-[var(--dark-green)]">{recipient.name}</div>
              <div className="truncate text-xs text-[var(--muted-foreground)]">{recipient.email}</div>
            </>
          )}
        </div>
        <button type="button" onClick={() => setEditing((v) => !v)} className="inline-flex items-center gap-1 rounded-full bg-[var(--chip)] px-3 py-1.5 text-xs font-medium text-[var(--dark-green)]">
          <Pencil className="h-3 w-3" /> {editing ? "Done" : "Edit"}
        </button>
      </div>

      {phase === "form" && (
        <div className="px-5 pt-8">
          <div className="text-center">
            <div className="text-xs text-[var(--muted-foreground)]">Amount</div>
            <div className="mt-1 flex items-baseline justify-center gap-1">
              <span className="text-3xl font-semibold text-[var(--dark-green)]">$</span>
              <input
                inputMode="decimal"
                aria-label="Amount"
                value={dollars}
                onChange={(e) => setDollars(e.target.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1"))}
                className="w-[10ch] bg-transparent text-center text-5xl font-semibold tracking-tight tabular-nums text-[var(--dark-green)] outline-none"
              />
            </div>
          </div>
          {!live && (
            <div className="mt-6 rounded-[1.25rem] bg-[var(--chip)] px-4 py-3">
              <div className="text-xs text-[var(--muted-foreground)]">Description</div>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Note for this payment"
                className="mt-1 w-full resize-none bg-transparent text-sm text-[var(--dark-green)] outline-none placeholder:text-[var(--muted-foreground)]/70"
              />
            </div>
          )}
          {error && <p role="alert" className="mt-3 text-center text-sm text-[var(--outgoing)]">{error}</p>}
          <div className="mt-8"><PrimaryButton onClick={onSendMoney}>Send Money</PrimaryButton></div>
          {!live && <p className="mt-3 text-center text-[11px] text-[var(--muted-foreground)]">Demo mode: updates a local balance only. Create a wallet from Profile to pay for real.</p>}
        </div>
      )}

      {phase === "pin" && (
        <div className="mx-auto max-w-sm space-y-4 px-5 pt-6">
          <div className="text-center text-sm text-[var(--muted-foreground)]">Enter your PIN to send ${formatUsd(amountCents)} to {recipient.email} (paid out by PayPal)</div>
          <input autoFocus inputMode="numeric" maxLength={6} type="password" aria-label="PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-2xl bg-white px-4 py-3 text-center text-2xl tracking-[0.5em] shadow-sm outline-none" />
          {error && <p role="alert" className="text-center text-sm text-[var(--outgoing)]">{error}</p>}
          <PrimaryButton disabled={pin.length < 4} onClick={submitLive}>Confirm &amp; send</PrimaryButton>
          <button type="button" onClick={() => { setPin(""); setError(""); setPhase("form"); }} className="w-full text-sm text-[var(--muted-foreground)]">Back</button>
        </div>
      )}
      {phase === "busy" && <p className="pt-10 text-center text-sm text-[var(--muted-foreground)]">Settling…</p>}
    </div>
  );
}

function BankScreen({
  wallet,
  live,
  msg,
  setMsg,
  onBack,
  onRefresh,
}: {
  wallet: WalletSnap;
  live: boolean;
  msg: string;
  setMsg: (s: string) => void;
  onBack: () => void;
  onRefresh: () => Promise<void>;
}) {
  const session = getSession();
  const [topup, setTopup] = useState(20);
  const [adding, setAdding] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const room = Math.max(0, (wallet.max_balance || 20000) - wallet.balance);
  const maxTopup = Math.floor(room / 100); // whole dollars that still fit in the wallet
  const amount = Math.min(topup, maxTopup);

  async function extend() {
    if (!session) { setMsg("Create a wallet first."); return; }
    const r = await api.post("/api/wallet/extend", { wallet_id: session.walletId }, session.token);
    setMsg(r.ok ? "Open for another 72 hours." : (r.data.error || "Could not extend"));
    await onRefresh();
  }
  async function closeWallet() {
    if (!session) { setMsg("Create a wallet first."); return; }
    setConfirmClose(false);
    const r = await api.post("/api/wallet/refund", { wallet_id: session.walletId }, session.token);
    setMsg(r.ok ? r.data.message : (r.data.error || "Refund failed"));
    await onRefresh();
  }
  async function createTopupOrder() {
    if (!session) throw new Error("Create a wallet first");
    const r = await api.post("/api/wallet/topup-order", { wallet_id: session.walletId, amount }, session.token);
    if (!r.ok) throw new Error(r.data.error || "Could not start PayPal");
    return r.data.order_id as string;
  }
  async function captureTopup(orderId: string) {
    if (!session) return;
    setAdding(true);
    const r = await api.post("/api/wallet/topup-capture", { wallet_id: session.walletId, paypal_order_id: orderId }, session.token);
    setAdding(false);
    setMsg(r.ok ? `Added $${formatUsd(r.data.added)} from PayPal.` : (r.data.error || "Top-up failed"));
    await onRefresh();
  }

  return (
    <div>
      <ScreenHeader title="Wallet" onBack={onBack} />
      <BalanceCard balanceCents={wallet.balance} compact />
      <div className="mx-5 mt-4 space-y-3">
        <div className="rounded-[1.5rem] bg-white p-4 shadow-[var(--card-shadow)]">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-[var(--chip)] text-[var(--dark-green)]">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold text-[var(--dark-green)]">Funded with PayPal</div>
              <div className="text-xs text-[var(--muted-foreground)]">{wallet.funded_by === "simulated" ? "Simulated PayPal (no real money)" : wallet.paypal_payer || "PayPal sandbox"}</div>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Per payment" value={`Up to $${formatUsd(wallet.per_payment_limit || 10000)}`} />
            <Row label="Wallet limit" value={`$${formatUsd(wallet.max_balance || 20000)}`} />
            <Row label="Status" value={wallet.active === false ? "closed" : "active"} />
            {wallet.expiry && <Row label="Open until" value={new Date(wallet.expiry).toLocaleString()} />}
          </dl>
        </div>

        {live && wallet.active !== false && room >= 1000 && (
          <div className="rounded-[1.5rem] bg-white p-4 shadow-[var(--card-shadow)]">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-semibold text-[var(--dark-green)]">Add money</span>
              <span className="font-semibold tabular-nums text-[var(--dark-green)]">${amount.toFixed(2)}</span>
            </div>
            <input type="range" min={10} max={maxTopup} step={1} value={amount} aria-label="Top-up amount"
              onChange={(e) => setTopup(Number(e.target.value))} className="mt-2 w-full accent-[var(--dark-green)]" />
            <div className="mt-3">
              {adding ? <p className="py-3 text-center text-sm text-[var(--muted-foreground)]">Adding…</p> : (
                <PayPalButton createOrder={createTopupOrder} onApproved={(id) => { void captureTopup(id); }} onError={(m) => setMsg(m)} />
              )}
            </div>
          </div>
        )}

        <PrimaryButton onClick={extend}>Keep open another 72 hours</PrimaryButton>
        <button type="button" onClick={() => setConfirmClose(true)} className="w-full rounded-full border border-[var(--dark-green)]/20 bg-white py-3 text-sm font-semibold text-[var(--dark-green)]">
          Close wallet · refund to PayPal
        </button>
        {confirmClose && (
          <div className="rounded-2xl bg-white p-3 text-center text-sm shadow-sm">
            <p>Close the wallet and refund ${formatUsd(wallet.balance)} to PayPal?</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setConfirmClose(false)} className="rounded-full border border-[var(--hairline)] py-2">Keep it</button>
              <button type="button" onClick={closeWallet} className="rounded-full bg-[var(--dark-green)] py-2 font-semibold text-white">Close & refund</button>
            </div>
          </div>
        )}
        {msg && <p className="text-center text-xs text-[var(--muted-foreground)]">{msg}</p>}
        {!live && <p className="text-center text-[11px] text-[var(--muted-foreground)]">Demo wallet. Create a real one from Profile.</p>}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[var(--muted-foreground)]">{label}</dt>
      <dd className="truncate font-medium tabular-nums text-[var(--dark-green)]">{value}</dd>
    </div>
  );
}

function ProfileScreen({
  live,
  userName,
  userEmail,
  onEnroll,
  onLogout,
}: {
  live: boolean;
  userName: string;
  userEmail: string;
  onEnroll: () => void;
  onLogout: () => void;
}) {
  const [sosMsg, setSosMsg] = useState("");

  async function panic() {
    const session = getSession();
    if (!session) { setSosMsg("Enrol first for live SOS."); return; }
    const send = async (lat: number | null, lng: number | null) => {
      const r = await api.post("/api/wallet/sos", { wallet_id: session.walletId, ...(lat != null ? { gps_lat: lat, gps_lng: lng } : {}) }, session.token);
      setSosMsg(r.ok ? "SOS sent to your emergency contact (best effort)." : (r.data.error || "SOS failed"));
    };
    if (!navigator.geolocation) { void send(null, null); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => send(pos.coords.latitude, pos.coords.longitude),
      () => send(null, null),
      { timeout: 5000 },
    );
  }

  return (
    <div className="px-5 pt-8">
      <div className="flex flex-col items-center text-center">
        <div className="grid h-16 w-16 place-items-center rounded-full bg-[var(--dark-green)] text-lg font-semibold text-white">
          {userName.slice(0, 2).toUpperCase()}
        </div>
        <div className="mt-3 text-lg font-semibold text-[var(--dark-green)]">{userName}</div>
        <div className="text-sm text-[var(--muted-foreground)]">{userEmail}</div>
        <div className={cn("mt-2 rounded-full px-3 py-1 text-xs", live ? "bg-[var(--lime-btn)]" : "bg-white")}>
          {live ? "Live wallet session" : "Demo profile"}
        </div>
      </div>

      <div className="mt-8 space-y-2">
        <PrimaryButton onClick={onEnroll}>{live ? "Open or sign in to a wallet" : "Create wallet / sign in"}</PrimaryButton>
        <button type="button" onClick={panic} className="w-full rounded-full bg-white py-3 text-sm font-semibold text-[var(--outgoing)] shadow-sm">
          Panic SOS (best-effort)
        </button>
        {live && (
          <button type="button" onClick={onLogout} className="w-full rounded-full py-3 text-sm text-[var(--outgoing)]">
            Sign out on this phone
          </button>
        )}
      </div>
      {sosMsg && <p className="mt-3 text-center text-xs text-[var(--muted-foreground)]">{sosMsg}</p>}
      <p className="mt-6 text-center text-[11px] leading-relaxed text-[var(--muted-foreground)]">
        Demo: the camera stands in for a fingerprint sensor and FAR/FRR are unmeasured. Money moves through the PayPal sandbox (or a labelled simulation without keys). A distress-finger payment looks normal on the merchant screen, but the capped amount can still give it away later.
      </p>
    </div>
  );
}
