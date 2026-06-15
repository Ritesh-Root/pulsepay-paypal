import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Wallet, ScanFace, Store, ShieldCheck } from "lucide-react";
import { Enroll } from "./components/enroll";
import { Merchant } from "./components/merchant";
import { Dashboard } from "./components/dashboard";
import { cn } from "./components/ui/utils";

type Tab = "enroll" | "pay" | "wallet";

const TABS: { id: Tab; label: string; icon: typeof Wallet }[] = [
  { id: "enroll", label: "Enrol", icon: ScanFace },
  { id: "pay", label: "Merchant", icon: Store },
  { id: "wallet", label: "Wallet", icon: Wallet },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("enroll");

  return (
    <div className="size-full min-h-screen bg-[var(--surface)] text-foreground antialiased">
      <div className="mx-auto flex min-h-screen w-full max-w-[1180px] flex-col px-6 py-6 lg:px-10 lg:py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-2xl bg-foreground text-background">
              <ShieldCheck className="h-5 w-5" strokeWidth={2.2} />
            </div>
            <div className="leading-tight">
              <div className="tracking-tight">PulsePay</div>
              <div className="text-xs text-muted-foreground">SBI · India-resident · RBI-AFA</div>
            </div>
          </div>

          <nav className="relative flex items-center gap-1 rounded-full border border-[var(--hairline)] bg-[var(--chip)] p-1 backdrop-blur">
            {TABS.map((t) => {
              const active = tab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "relative z-10 flex items-center gap-2 rounded-full px-4 py-2 text-sm transition-colors duration-150",
                    active ? "text-background" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="tab-pill"
                      transition={{ type: "spring", stiffness: 520, damping: 38, mass: 0.6 }}
                      className="absolute inset-0 -z-10 rounded-full bg-foreground"
                    />
                  )}
                  <Icon className="h-4 w-4" strokeWidth={2} />
                  <span className="hidden sm:inline">{t.label}</span>
                </button>
              );
            })}
          </nav>
        </header>

        <main className="mt-8 flex-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              {tab === "enroll" && <Enroll onDone={() => setTab("pay")} />}
              {tab === "pay" && <Merchant />}
              {tab === "wallet" && <Dashboard />}
            </motion.div>
          </AnimatePresence>
        </main>

        <footer className="mt-12 flex items-center justify-between text-xs text-muted-foreground">
          <span>Adaptive auth · fingerprint + PIN, face on larger amounts</span>
          <span>v0.1 · demo</span>
        </footer>
      </div>
    </div>
  );
}
