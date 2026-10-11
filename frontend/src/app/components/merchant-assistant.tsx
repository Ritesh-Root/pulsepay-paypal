import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, SendHorizontal, Sparkles } from "lucide-react";
import { cn } from "./ui/utils";
import { api } from "../lib/api";

// Chat with the PulsePay assistant (GLM on Amazon Bedrock + PayPal Agent Toolkit).
// The model can only *propose* refunds and cash-outs; they run when the merchant
// taps Confirm here.

type Action =
  | { type: "refund"; transaction_id: string; amount_cents: number; label: string; reason?: string }
  | { type: "cashout"; amount_cents: number; label: string }
  | { type: "qr"; invoice_id: string; image_base64: string }
  | { type: "link"; label: string; url: string };

type Msg = { role: "user" | "assistant"; text: string; actions?: Action[]; meta?: string };

const SUGGESTIONS = [
  "How much did I take today?",
  "Anything unusual I should know?",
  "Pay out my balance to PayPal",
  "Invoice sam@example.com for 2 coffees at $4.50",
];

export function MerchantAssistant({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const [status, setStatus] = useState<{ enabled: boolean; model: string } | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Record<string, string>>({});
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get("/api/assistant/status", token).then((r) => {
      if (r.data?.code === "auth_required") onSignOut();
      else setStatus(r.ok ? r.data : { enabled: false, model: "" });
    });
  }, [token, onSignOut]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, busy]);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    const history: Msg[] = [...messages, { role: "user", text: q }];
    setMessages(history);
    setInput("");
    setBusy(true);
    const r = await api.post("/api/assistant/chat", { messages: history.map(({ role, text }) => ({ role, text })) }, token);
    setBusy(false);
    if (r.data?.code === "auth_required") { onSignOut(); return; }
    setMessages([...history, r.ok
      ? { role: "assistant", text: r.data.reply, actions: r.data.actions, meta: `${r.data.model || "model"} · ${(r.data.tools_used || []).join(", ") || "no tools"}` }
      : { role: "assistant", text: r.data.error || "The assistant is unavailable right now." }]);
  }

  async function confirm(key: string, action: Action) {
    setDone((d) => ({ ...d, [key]: "Working…" }));
    const r = action.type === "refund"
      ? await api.post("/api/merchant/refunds", { transaction_id: action.transaction_id, reason: action.reason || "assistant" }, token)
      : await api.post("/api/merchant/cashout", {}, token);
    setDone((d) => ({ ...d, [key]: r.ok ? (r.data.message || "Done") : (r.data.error || "Failed") }));
  }

  if (status && !status.enabled) {
    return <p className="mt-6 rounded-2xl bg-white px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">The assistant isn't configured on this server (set AWS_BEARER_TOKEN_BEDROCK).</p>;
  }

  return (
    <div className="mt-4 flex min-h-[60vh] flex-col pb-4">
      <div className="flex-1 space-y-3">
        {messages.length === 0 && (
          <div className="rounded-[1.5rem] bg-white p-4 shadow-[var(--card-shadow)]">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--dark-green)]"><Sparkles className="h-4 w-4" /> Ask about your shop</div>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">Sales, payouts, unusual activity, refunds and PayPal invoices. Money only moves when you tap Confirm.</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void ask(s)} className="rounded-full bg-[var(--chip)] px-3 py-1.5 text-xs text-[var(--dark-green)]">{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[88%] rounded-[1.25rem] px-3.5 py-2.5 text-sm shadow-sm",
              m.role === "user" ? "bg-[var(--dark-green)] text-white" : "bg-white text-[var(--dark-green)]")}>
              {m.role === "assistant" && <Bot className="mb-1 h-3.5 w-3.5 text-[var(--muted-foreground)]" />}
              <div className="whitespace-pre-wrap">{m.text.replace(/\*\*/g, "")}</div>
              {m.actions?.map((a, j) => {
                const key = `${i}-${j}`;
                if (a.type === "qr") return <img key={key} alt={`PayPal QR code for invoice ${a.invoice_id}`} className="mt-2 w-44 rounded-lg" src={`data:image/png;base64,${a.image_base64}`} />;
                if (a.type === "link") return <a key={key} href={a.url} target="_blank" rel="noreferrer" className="mt-2 block text-xs font-semibold underline">{a.label}</a>;
                return (
                  <div key={key} className="mt-2 rounded-xl bg-[var(--chip)] p-2.5">
                    <div className="text-xs font-semibold">{a.label}</div>
                    {done[key]
                      ? <div className="mt-1 text-xs">{done[key]}</div>
                      : <button type="button" onClick={() => void confirm(key, a)} className="mt-1.5 rounded-full bg-[var(--dark-green)] px-3 py-1 text-xs font-semibold text-white">Confirm</button>}
                  </div>
                );
              })}
              {m.meta && <div className="mt-1.5 text-[10px] text-[var(--muted-foreground)]">{m.meta}</div>}
            </div>
          </div>
        ))}
        {busy && <div className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs text-[var(--muted-foreground)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…</div>}
        <div ref={endRef} />
      </div>

      <form className="sticky bottom-2 mt-3 flex items-center gap-2 rounded-full bg-white p-1.5 pl-4 shadow-[var(--card-shadow)]"
        onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} maxLength={500} placeholder="Ask about sales, payouts, invoices…" aria-label="Message the assistant"
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--dark-green)] outline-none" />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send" className="grid h-9 w-9 place-items-center rounded-full bg-[var(--dark-green)] text-white disabled:opacity-30">
          <SendHorizontal className="h-4 w-4" />
        </button>
      </form>
      <p className="mt-1.5 text-center text-[10px] text-[var(--muted-foreground)]">AI can make mistakes. GLM on Amazon Bedrock + PayPal Agent Toolkit.</p>
    </div>
  );
}
