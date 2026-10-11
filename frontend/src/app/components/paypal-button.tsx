import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "../lib/api";

// PayPal JavaScript SDK v6 (web-sdk/v6/core): a one-time PayPal payment session.
// The server creates the order (createOrder must resolve to { orderId }) and captures
// it after approval. Without PayPal credentials the backend runs in "simulated"
// mode and this renders a clearly labelled stand-in button with the same flow.

type PayPalConfig = { mode: string; enabled: boolean; client_id: string | null; sdk_url: string; currency: string };

let configPromise: Promise<PayPalConfig> | null = null;
export function getPayPalConfig(): Promise<PayPalConfig> {
  if (!configPromise) {
    configPromise = api.get("/api/paypal/config").then((r) => {
      if (!r.ok) { configPromise = null; throw new Error(r.data.error || "PayPal config unavailable"); }
      return r.data as PayPalConfig;
    });
  }
  return configPromise;
}

let sdkPromise: Promise<any> | null = null;
function loadSdk(url: string): Promise<any> {
  if ((window as any).paypal?.createInstance) return Promise.resolve((window as any).paypal);
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url;
      s.async = true;
      s.onload = () => resolve((window as any).paypal);
      s.onerror = () => { sdkPromise = null; reject(new Error("Could not load the PayPal SDK")); };
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

export function PayPalButton({
  createOrder,
  onApproved,
  onError,
  disabled,
}: {
  createOrder: () => Promise<string>;        // returns the PayPal order id
  onApproved: (orderId: string) => void;     // server captures it
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const [cfg, setCfg] = useState<PayPalConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");
  const buttonRef = useRef<HTMLElement | null>(null);
  const sessionRef = useRef<any>(null);
  const handlers = useRef({ createOrder, onApproved, onError });
  handlers.current = { createOrder, onApproved, onError };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await getPayPalConfig();
        if (cancelled) return;
        setCfg(c);
        if (!c.enabled || !c.client_id) { setReady(true); return; }
        const paypal = await loadSdk(c.sdk_url);
        const sdk = await paypal.createInstance({ clientId: c.client_id, components: ["paypal-payments"], pageType: "checkout" });
        const methods = await sdk.findEligibleMethods({ currencyCode: c.currency });
        if (!methods.isEligible("paypal")) throw new Error("PayPal is not available for this browser or region");
        sessionRef.current = sdk.createPayPalOneTimePaymentSession({
          onApprove: async (data: { orderId: string }) => { setBusy(false); handlers.current.onApproved(data.orderId); },
          onCancel: () => { setBusy(false); handlers.current.onError("PayPal payment cancelled"); },
          onError: (e: Error) => { setBusy(false); handlers.current.onError(e?.message || "PayPal error"); },
        });
        if (!cancelled) setReady(true);
      } catch (e: any) {
        if (!cancelled) setLoadError(e?.message || "PayPal unavailable");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The v6 SDK renders <paypal-button>; start the session on click without awaiting
  // createOrder first (awaiting can break the browser's popup permission).
  useEffect(() => {
    const el = buttonRef.current;
    if (!el || !sessionRef.current) return;
    const onClick = async () => {
      if (disabled) return;
      setBusy(true);
      try {
        const orderPromise = handlers.current.createOrder().then((orderId) => ({ orderId }));
        await sessionRef.current.start({ presentationMode: "auto" }, orderPromise);
      } catch (e: any) {
        setBusy(false);
        handlers.current.onError(e?.message || "Could not start PayPal");
      }
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [ready, disabled]);

  async function simulate() {
    setBusy(true);
    try {
      const orderId = await createOrder();
      onApproved(orderId);
    } catch (e: any) {
      onError(e?.message || "Could not start the payment");
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <p role="alert" className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600">{loadError}</p>;
  if (!ready || !cfg) {
    return <div className="grid h-12 place-items-center text-xs text-[var(--muted-foreground)]"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  }

  if (!cfg.enabled) {
    return (
      <div className="space-y-1">
        <button type="button" disabled={disabled || busy} onClick={simulate}
          className="w-full rounded-full bg-[#ffc439] py-3 text-sm font-bold text-[#003087] shadow-sm disabled:opacity-40">
          {busy ? "Processing…" : "Pay with PayPal (simulated)"}
        </button>
        <p className="text-center text-[11px] text-[var(--muted-foreground)]">PayPal keys aren't set on the server, so this payment is simulated.</p>
      </div>
    );
  }

  return (
    <div className={disabled || busy ? "pointer-events-none opacity-50" : ""}>
      {/* custom element from the PayPal v6 SDK */}
      <paypal-button ref={buttonRef as any} type="pay" class="block w-full"></paypal-button>
      <p className="mt-1 text-center text-[11px] text-[var(--muted-foreground)]">{cfg.mode === "paypal-sandbox" ? "PayPal sandbox: use a sandbox buyer account" : "Secured by PayPal"}</p>
    </div>
  );
}
