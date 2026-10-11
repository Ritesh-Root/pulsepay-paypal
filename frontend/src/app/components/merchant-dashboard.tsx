import { useCallback, useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from "ag-grid-community";
import { AgCharts } from "ag-charts-react";
import { AllCommunityModule as ChartsCommunity, ModuleRegistry as ChartsRegistry } from "ag-charts-community";
import { AlertTriangle, Info, RefreshCw, Send, XCircle } from "lucide-react";
import { cn } from "./ui/utils";
import { api } from "../lib/api";

ModuleRegistry.registerModules([AllCommunityModule]);
ChartsRegistry.registerModules([ChartsCommunity]);

// Sales and payouts for the signed-in merchant, built with AG Grid + AG Charts
// (community editions). Refunds always ask a person to confirm.

const gridTheme = themeQuartz.withParams({
  accentColor: "#1a3d2e",
  foregroundColor: "#1a3d2e",
  headerBackgroundColor: "#ecfadc",
  borderColor: "rgba(26, 61, 46, 0.08)",
  fontSize: 12,
  rowHeight: 36,
  headerHeight: 34,
  wrapperBorderRadius: 16,
});

const usd = (cents: number) => `${Number(cents) < 0 ? "-" : ""}$${(Math.abs(Number(cents)) / 100).toFixed(2)}`;
const time = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

type Dashboard = {
  balance: { owed: number; in_flight: number; available: number };
  today: { payments: number; gross_cents: number; refunded_cents: number; net_cents: number; average_payment_cents: number };
  week: { payments: number; net_cents: number };
  transactions: Array<{ id: string; created_at: string; kind: string; amount_cents: number; refunded: boolean; method: string; match_score: number | null; customer: string }>;
  payouts: Array<{ id: string; amount_cents: number; status: string; recipient_email: string; created_at: string; last_error: string | null; simulated: boolean }>;
  anomalies: Array<{ type: string; severity: "info" | "warning" | "error"; message: string }>;
  hourly: Array<{ hour: string; sales_cents: number; payments: number }>;
};

export function MerchantDashboard({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState<{ id: string; amount: number; customer: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api.get("/api/merchant/dashboard", token);
    if (r.data?.code === "auth_required") { onSignOut(); return; }
    if (!r.ok) { setError(r.data.error || "Could not load the dashboard"); return; }
    setError("");
    setData(r.data);
  }, [token, onSignOut]);

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 10_000);
    return () => window.clearInterval(id);
  }, [load]);

  async function cashOut() {
    setBusy(true); setNotice("");
    const r = await api.post("/api/merchant/cashout", {}, token);
    setBusy(false);
    setNotice(r.ok ? r.data.message : (r.data.error || "Cash-out failed"));
    void load();
  }

  async function refund() {
    if (!confirming) return;
    setBusy(true);
    const r = await api.post("/api/merchant/refunds", { transaction_id: confirming.id, reason: "merchant" }, token);
    setBusy(false);
    setConfirming(null);
    setNotice(r.ok ? r.data.message : (r.data.error || "Refund failed"));
    void load();
  }

  const txCols = useMemo<ColDef[]>(() => [
    { field: "created_at", headerName: "Time", valueFormatter: (p) => time(p.value), flex: 1.2, sort: "desc" },
    { field: "customer", headerName: "Customer", flex: 1.1 },
    {
      field: "amount_cents", headerName: "Amount", flex: 0.8, type: "rightAligned",
      valueFormatter: (p) => `${p.data.kind === "merchant_refund" ? "-" : ""}${usd(p.value)}`,
      cellClass: (p) => (p.data.kind === "merchant_refund" ? "text-red-600" : "font-semibold"),
    },
    { field: "method", headerName: "Verified by", flex: 1, valueFormatter: (p) => (p.data.kind === "merchant_refund" ? "refund" : String(p.value || "").replace("+pin", " + PIN")) },
    {
      headerName: "", flex: 0.8, sortable: false, filter: false,
      cellRenderer: (p: any) => p.data.kind !== "payment" ? null : p.data.refunded
        ? <span className="text-[11px] text-[var(--muted-foreground)]">refunded</span>
        : <button type="button" className="rounded-full bg-[var(--chip)] px-2 py-0.5 text-[11px] font-semibold text-[var(--dark-green)]"
            onClick={() => setConfirming({ id: p.data.id, amount: p.data.amount_cents, customer: p.data.customer })}>Refund</button>,
    },
  ], []);

  const payoutCols = useMemo<ColDef[]>(() => [
    { field: "created_at", headerName: "Started", valueFormatter: (p) => time(p.value), flex: 1.2 },
    { field: "amount_cents", headerName: "Amount", valueFormatter: (p) => usd(p.value), flex: 0.8, type: "rightAligned" },
    {
      field: "status", headerName: "PayPal status", flex: 1,
      cellRenderer: (p: any) => (
        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold",
          p.value === "SUCCESS" ? "bg-emerald-100 text-emerald-800"
            : ["FAILED", "RETURNED", "BLOCKED", "DENIED", "UNCLAIMED"].includes(p.value) ? "bg-red-100 text-red-700"
            : "bg-amber-100 text-amber-800")}>
          {p.value}{p.data.simulated ? " · sim" : ""}
        </span>
      ),
    },
  ], []);

  const chartOptions = useMemo(() => ({
    data: (data?.hourly || []).map((h) => ({ hour: new Date(h.hour).toLocaleTimeString("en-US", { hour: "numeric" }), sales: h.sales_cents / 100 })),
    height: 170,
    background: { visible: false },
    padding: { top: 8, right: 4, bottom: 0, left: 0 },
    series: [{ type: "bar", xKey: "hour", yKey: "sales", yName: "Sales ($)", fill: "#1a3d2e", cornerRadius: 4 }],
    axes: [
      { type: "category", position: "bottom", label: { fontSize: 10 } },
      { type: "number", position: "left", label: { fontSize: 10, formatter: (p: any) => `$${p.value}` } },
    ],
    legend: { enabled: false },
  }), [data]);

  if (error) return <p role="alert" className="mt-4 rounded-2xl bg-white px-3 py-2 text-center text-sm text-[var(--outgoing)]">{error}</p>;
  if (!data) return <p className="mt-10 text-center text-sm text-[var(--muted-foreground)]">Loading your sales…</p>;

  return (
    <div className="mt-4 space-y-3 pb-6">
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Net today" value={usd(data.today.net_cents)} sub={`${data.today.payments} payments`} />
        <Tile label="This week" value={usd(data.week.net_cents)} sub={`${data.week.payments} payments`} />
        <Tile label="On its way to PayPal" value={usd(data.balance.in_flight)} sub="payouts in progress" />
        <Tile label="Owed to you" value={usd(data.balance.available)} sub={data.balance.available < 0 ? "refunds exceed unpaid sales" : "not yet paid out"} />
      </div>

      {data.anomalies.length > 0 && (
        <div className="space-y-1.5">
          {data.anomalies.map((a) => (
            <div key={a.type} className={cn("flex items-start gap-2 rounded-2xl px-3 py-2 text-xs",
              a.severity === "error" ? "bg-red-50 text-red-700" : a.severity === "warning" ? "bg-amber-50 text-amber-800" : "bg-white text-[var(--dark-green)]")}>
              {a.severity === "error" ? <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : a.severity === "warning" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {a.message}
            </div>
          ))}
        </div>
      )}

      <section className="rounded-[1.25rem] bg-white p-3 shadow-[var(--card-shadow)]">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--dark-green)]">Sales, last 24 hours</h2>
          <button type="button" onClick={() => void load()} aria-label="Refresh" className="grid h-7 w-7 place-items-center rounded-full hover:bg-[var(--chip)]"><RefreshCw className="h-3.5 w-3.5" /></button>
        </div>
        {data.hourly.length ? <AgCharts options={chartOptions as any} /> : <p className="py-6 text-center text-xs text-[var(--muted-foreground)]">No sales yet today.</p>}
      </section>

      <section>
        <h2 className="mb-1.5 px-1 text-sm font-semibold text-[var(--dark-green)]">Payments</h2>
        <div style={{ height: 260 }}>
          <AgGridReact theme={gridTheme} rowData={data.transactions} columnDefs={txCols} getRowId={(p) => p.data.id}
            overlayNoRowsTemplate="No payments yet" suppressCellFocus />
        </div>
      </section>

      <section>
        <div className="mb-1.5 flex items-center justify-between px-1">
          <h2 className="text-sm font-semibold text-[var(--dark-green)]">PayPal payouts</h2>
          <button type="button" disabled={busy || data.balance.available <= 0} onClick={cashOut}
            className="inline-flex items-center gap-1 rounded-full bg-[var(--dark-green)] px-3 py-1 text-xs font-semibold text-white disabled:opacity-30">
            <Send className="h-3 w-3" /> Cash out {data.balance.available > 0 ? usd(data.balance.available) : ""}
          </button>
        </div>
        <div style={{ height: 200 }}>
          <AgGridReact theme={gridTheme} rowData={data.payouts} columnDefs={payoutCols} getRowId={(p) => p.data.id}
            overlayNoRowsTemplate="No payouts yet" suppressCellFocus />
        </div>
      </section>

      {notice && <p className="rounded-2xl bg-white px-3 py-2 text-center text-xs text-[var(--dark-green)]">{notice}</p>}

      {confirming && (
        <div role="dialog" aria-modal="true" aria-label="Confirm refund" className="fixed inset-0 z-50 grid place-items-center bg-black/40 px-6">
          <div className="w-full max-w-xs rounded-[1.5rem] bg-white p-5 text-center shadow-xl">
            <div className="text-sm text-[var(--muted-foreground)]">Refund to {confirming.customer}'s PulsePay wallet</div>
            <div className="mt-1 text-2xl font-semibold text-[var(--dark-green)]">{usd(confirming.amount)}</div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setConfirming(null)} className="rounded-full border border-[var(--hairline)] py-2 text-sm">Cancel</button>
              <button type="button" disabled={busy} onClick={refund} className="rounded-full bg-[var(--dark-green)] py-2 text-sm font-semibold text-white">Refund</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl bg-white px-3 py-3 shadow-sm">
      <div className="text-[11px] text-[var(--muted-foreground)]">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-[var(--dark-green)]">{value}</div>
      <div className="text-[10px] text-[var(--muted-foreground)]">{sub}</div>
    </div>
  );
}
