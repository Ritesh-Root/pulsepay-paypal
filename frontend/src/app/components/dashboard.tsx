import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowUpRight, RefreshCw, Timer, Siren, Users, Fingerprint, X } from "lucide-react";
import { Panel, Stat } from "./surface";
import { Capture } from "./capture";
import { cn } from "./ui/utils";
import { api, getSession, paiseToRupees } from "../lib/api";

type Tx = { id: string; merchant_upi: string; amount: number; status: string; distress_triggered?: boolean; created_at: string };
type Delegate = { id: string; spending_cap: number; spent_total: number; created_at: string };
type Wallet = { id: string; balance: number; expiry: string; max_lifetime: string; extend_count: number; active: boolean };

export function Dashboard() {
  const session = getSession();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [delegates, setDelegates] = useState<Delegate[]>([]);
  const [countdown, setCountdown] = useState("");
  const [msg, setMsg] = useState("");
  const [mode, setMode] = useState<"none" | "reissue" | "delegate">("none");

  async function load() {
    if (!session) return;
    const w = await api.get(`/api/wallet/${session.walletId}`, session.token);
    if (w.ok) { setWallet(w.data.wallet); setTxs(w.data.transactions || []); }
    const d = await api.get(`/api/family/delegates/${session.walletId}`, session.token);
    if (d.ok) setDelegates(d.data.delegates || []);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    if (!wallet) return;
    const tick = () => {
      const s = Math.max(0, (new Date(wallet.expiry).getTime() - Date.now()) / 1000);
      setCountdown(fmt(s));
    };
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id);
  }, [wallet]);

  async function extend() {
    setMsg("");
    const r = await api.post("/api/wallet/extend", { wallet_id: session!.walletId }, session!.token);
    if (r.ok) { setMsg("Extended by 72h."); load(); }
    else setMsg(r.data.error || "Could not extend");
  }
  async function refund() {
    setMsg("");
    const r = await api.post("/api/wallet/refund", { wallet_id: session!.walletId }, session!.token);
    if (r.ok) { setMsg(`Refunded ₹${paiseToRupees(r.data.refunded_amount || 0)}.`); load(); }
    else setMsg(r.data.error || "Refund failed");
  }
  async function panic() {
    setMsg("");
    navigator.geolocation?.getCurrentPosition(
      async (pos) => {
        const r = await api.post("/api/payment/sos", { wallet_id: session!.walletId, gps_lat: pos.coords.latitude, gps_lng: pos.coords.longitude }, session!.token);
        setMsg(r.ok ? "SOS dispatched to your emergency contact." : (r.data.error || "SOS failed"));
      },
      async () => {
        const r = await api.post("/api/payment/sos", { wallet_id: session!.walletId, gps_lat: 0, gps_lng: 0 }, session!.token);
        setMsg(r.ok ? "SOS dispatched (no GPS)." : "SOS failed");
      }
    );
  }

  if (!session) {
    return (
      <Panel title="No active wallet" description="Enrol first to see your wallet here.">
        <div className="grid place-items-center py-12 text-sm text-muted-foreground">Use the Enrol tab to create a wallet.</div>
      </Panel>
    );
  }

  const balance = wallet ? paiseToRupees(wallet.balance) : 0;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Panel className="lg:col-span-2" title={wallet ? `Wallet ${wallet.id.slice(0, 8)}…` : "Wallet"} description="Funded from SBI CBS · auto-expires for safety."
        aside={<button onClick={panic} className="inline-flex items-center gap-2 rounded-full border border-[var(--hairline)] px-3 py-1.5 text-xs hover:bg-[var(--chip)]"><Siren className="h-3.5 w-3.5" /> Panic</button>}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Balance</div>
            <div className="mt-1 text-5xl tracking-tight tabular-nums">₹{balance.toLocaleString("en-IN")}</div>
          </div>
          <div className="grid w-full grid-cols-3 gap-3 sm:w-auto">
            <Stat label="Expires in" value={<span className="inline-flex items-center gap-1"><Timer className="h-3.5 w-3.5" />{countdown || "—"}</span>} />
            <Stat label="Extends" value={`${wallet?.extend_count ?? 0}`} />
            <Stat label="Status" value={wallet?.active ? "active" : "closed"} />
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-2">
          <Action icon={RefreshCw} label="Extend 72h" onClick={extend} disabled={!wallet?.active} />
          <Action icon={Fingerprint} label="Re-issue finger" onClick={() => setMode("reissue")} disabled={!wallet?.active} />
          <Action icon={ArrowUpRight} label="Refund unused" onClick={refund} disabled={!wallet?.active} />
        </div>
        {msg && <p className="mt-3 rounded-xl bg-[var(--chip)] px-3 py-2 text-sm text-muted-foreground">{msg}</p>}

        {mode === "reissue" && <ReissuePanel walletId={session.walletId} token={session.token} onClose={() => setMode("none")} onDone={() => { setMode("none"); setMsg("Fingerprint re-issued."); load(); }} />}

        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm">Recent activity</div>
            <div className="text-xs text-muted-foreground">{txs.length} entries</div>
          </div>
          {txs.length === 0 ? (
            <div className="rounded-2xl border border-[var(--hairline)] bg-card px-4 py-8 text-center text-sm text-muted-foreground">No transactions yet.</div>
          ) : (
            <ul className="divide-y divide-[var(--hairline)] rounded-2xl border border-[var(--hairline)] overflow-hidden">
              {txs.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-4 bg-card px-4 py-3 hover:bg-[var(--chip)] transition-colors">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{t.merchant_upi}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{new Date(t.created_at).toLocaleString()}</span>
                      {t.distress_triggered && <span className="rounded-full bg-foreground px-1.5 py-0.5 text-[10px] text-background">distress</span>}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={cn("tabular-nums tracking-tight", t.status === "refunded" && "text-muted-foreground line-through")}>−₹{paiseToRupees(t.amount)}</div>
                    <div className="text-xs text-muted-foreground">{t.status}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <div className="flex flex-col gap-6">
        <Panel title="Delegates" description="Family members with capped spend."
          aside={<button onClick={() => setMode("delegate")} className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs text-background"><Users className="h-3.5 w-3.5" /> Add</button>}>
          {mode === "delegate" && <DelegatePanel parentId={session.walletId} token={session.token} onClose={() => setMode("none")} onDone={() => { setMode("none"); setMsg("Delegate added."); load(); }} />}
          {delegates.length === 0 ? (
            <div className="text-sm text-muted-foreground">No delegates yet.</div>
          ) : (
            <ul className="space-y-3">
              {delegates.map((d) => {
                const pct = d.spending_cap ? (d.spent_total / d.spending_cap) * 100 : 0;
                return (
                  <li key={d.id} className="rounded-2xl border border-[var(--hairline)] p-3">
                    <div className="flex items-baseline justify-between">
                      <div className="text-sm tabular-nums">Delegate {d.id.slice(0, 6)}</div>
                      <div className="text-xs tabular-nums text-muted-foreground">₹{paiseToRupees(d.spent_total)} / ₹{paiseToRupees(d.spending_cap)}</div>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--chip)]">
                      <motion.div initial={{ width: 0 }} animate={{ width: `${Math.min(100, pct)}%` }} transition={{ duration: 0.6 }} className="h-full bg-foreground" />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <Panel title="Safety" description="Adaptive controls running silently.">
          <ul className="space-y-2 text-sm">
            <SafetyRow label="Liveness (PAD)" value="on" />
            <SafetyRow label="Velocity check" value="ok" />
            <SafetyRow label="Distress route" value="armed" />
            <SafetyRow label="Data residency" value="India" />
          </ul>
        </Panel>
      </div>
    </div>
  );
}

function ReissuePanel({ walletId, token, onClose, onDone }: { walletId: string; token: string; onClose: () => void; onDone: () => void }) {
  const [emb, setEmb] = useState<number[] | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  async function submit() {
    setErr("");
    const r = await api.post("/api/wallet/reissue-biometric", { wallet_id: walletId, template_type: "fingerprint", embedding: emb, pin }, token);
    if (r.ok) onDone(); else setErr(r.data.error || "Re-issue failed");
  }
  return (
    <div className="mt-4 rounded-2xl border border-[var(--hairline)] bg-[var(--chip)] p-4">
      <div className="mb-3 flex items-center justify-between"><div className="text-sm">Re-issue fingerprint</div><button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button></div>
      <Capture endpoint="fingerprint" label="Re-scan your current payment finger to re-verify." onResult={(r) => setEmb(r.embedding)} />
      <input inputMode="numeric" maxLength={6} type="password" placeholder="Wallet PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} className="mt-3 w-full rounded-xl border border-[var(--hairline)] bg-card px-4 py-2 text-center tabular-nums outline-none" />
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
      <button disabled={!emb || pin.length < 4} onClick={submit} className="mt-3 w-full rounded-xl bg-foreground py-2 text-sm text-background disabled:opacity-30">Re-issue</button>
    </div>
  );
}

function DelegatePanel({ parentId, token, onClose, onDone }: { parentId: string; token: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [cap, setCap] = useState(500);
  const [emb, setEmb] = useState<number[] | null>(null);
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  async function submit() {
    setErr("");
    const r = await api.post("/api/family/add-delegate", { parent_wallet_id: parentId, delegate_name: name, delegate_fingerprint_embedding: emb, delegate_pin: pin, spending_cap: cap }, token);
    if (r.ok) onDone(); else setErr(r.data.error || "Could not add delegate");
  }
  return (
    <div className="mb-4 rounded-2xl border border-[var(--hairline)] bg-[var(--chip)] p-4">
      <div className="mb-3 flex items-center justify-between"><div className="text-sm">Add delegate</div><button onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button></div>
      <input placeholder="Name (e.g. Riya)" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-xl border border-[var(--hairline)] bg-card px-4 py-2 text-sm outline-none" />
      <div className="mt-3 flex items-center justify-between text-sm"><span className="text-muted-foreground">Spending cap</span><span className="tabular-nums">₹{cap}</span></div>
      <input type="range" min={100} max={1000} step={50} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="w-full accent-foreground" />
      <div className="mt-3"><Capture endpoint="fingerprint" label="Capture the delegate's finger." onResult={(r) => setEmb(r.embedding)} /></div>
      <input inputMode="numeric" maxLength={6} type="password" placeholder="Delegate PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} className="mt-3 w-full rounded-xl border border-[var(--hairline)] bg-card px-4 py-2 text-center tabular-nums outline-none" />
      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
      <button disabled={!name || !emb || pin.length < 4} onClick={submit} className="mt-3 w-full rounded-xl bg-foreground py-2 text-sm text-background disabled:opacity-30">Add delegate</button>
    </div>
  );
}

function Action({ icon: Icon, label, onClick, disabled }: { icon: typeof RefreshCw; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} className={cn("flex items-center justify-center gap-2 rounded-2xl border border-[var(--hairline)] px-3 py-3 text-sm transition active:scale-[0.98]", disabled ? "opacity-40" : "hover:bg-[var(--chip)]")}>
      <Icon className="h-4 w-4" strokeWidth={2} /><span className="truncate">{label}</span>
    </button>
  );
}

function SafetyRow({ label, value }: { label: string; value: string }) {
  return (<li className="flex items-center justify-between rounded-xl bg-[var(--chip)] px-3 py-2"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{value}</span></li>);
}

function fmt(totalSec: number) {
  const d = Math.floor(totalSec / 86400), h = Math.floor((totalSec % 86400) / 3600), m = Math.floor((totalSec % 3600) / 60), s = Math.floor(totalSec % 60);
  return `${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
