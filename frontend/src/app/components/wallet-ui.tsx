import { type ReactNode } from "react";
import { Bell, Home, User, ArrowLeftRight, Landmark, ChevronLeft, Building2, Pencil } from "lucide-react";
import { cn } from "./ui/utils";
import { DEMO_USER, formatUsd, formatTxDate, isIncoming, type Tx, type WalletSnap } from "../lib/wallet-store";

export function PhoneShell({ children, docked = true }: { children: ReactNode; docked?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-black">
      <header className="shrink-0 px-4 py-4 md:py-5">
        <div
          className="text-center text-[1.85rem] leading-none font-medium tracking-[-0.045em] text-white md:text-[2.4rem]"
          style={{ fontFamily: '"Outfit", "DM Sans", sans-serif' }}
        >
          pulse pay
        </div>
      </header>
      <div className="flex min-h-0 flex-1 justify-center bg-[linear-gradient(160deg,#d8f5b0_0%,#c6ee9a_45%,#b2eb6f_100%)] md:items-center md:px-6 md:py-8">
        <div className="relative flex h-full w-full max-w-[480px] flex-col overflow-hidden bg-[var(--mint)] md:h-[min(860px,100%)] md:rounded-[2rem] md:border md:border-white/40 md:shadow-[0_30px_80px_-30px_rgba(26,61,46,0.45)]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.45),transparent_70%)]" />
          <div className={cn("no-scrollbar relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto", docked ? "pb-24" : "pb-8")}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export function ModeToggle({
  mode,
  onChange,
}: {
  mode: "merchant" | "user";
  onChange: (mode: "merchant" | "user") => void;
}) {
  return (
    <div className="mx-5 flex rounded-full bg-white p-1 shadow-[var(--card-shadow)]" role="tablist" aria-label="Switch mode">
      {(["merchant", "user"] as const).map((item) => (
        <button
          key={item}
          type="button"
          role="tab"
          aria-selected={mode === item}
          onClick={() => onChange(item)}
          className={cn(
            "flex-1 rounded-full py-2 text-sm font-semibold",
            mode === item ? "bg-[var(--dark-green)] text-white" : "text-[var(--dark-green)]",
          )}
        >
          {item === "merchant" ? "Merchant" : "User"}
        </button>
      ))}
    </div>
  );
}

export function BottomNav({
  active,
  onHome,
  onProfile,
}: {
  active: "home" | "profile";
  onHome: () => void;
  onProfile: () => void;
}) {
  return (
    <nav className="absolute inset-x-5 bottom-5 z-20 flex items-center justify-around rounded-full bg-white px-2 py-2 shadow-[var(--card-shadow)]">
      <NavBtn active={active === "home"} onClick={onHome} label="Home">
        <Home className="h-5 w-5" strokeWidth={2.2} />
      </NavBtn>
      <NavBtn active={active === "profile"} onClick={onProfile} label="Profile">
        <User className="h-5 w-5" strokeWidth={2.2} />
      </NavBtn>
    </nav>
  );
}

function NavBtn({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid h-12 w-12 place-items-center rounded-full transition",
        active ? "bg-[var(--lime-btn)] text-[var(--dark-green)]" : "text-[var(--muted-foreground)] hover:bg-[var(--chip)]",
      )}
    >
      {children}
    </button>
  );
}

export function ScreenHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <header className="flex items-center gap-3 px-5 pt-6 pb-2">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="grid h-10 w-10 place-items-center rounded-full bg-white shadow-sm"
      >
        <ChevronLeft className="h-5 w-5 text-[var(--dark-green)]" />
      </button>
      <h1 className="flex-1 text-center pr-10 text-lg font-semibold tracking-tight text-[var(--dark-green)]">{title}</h1>
    </header>
  );
}

export function BalanceCard({
  balanceCents,
  compact,
  actions,
}: {
  balanceCents: number;
  compact?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className={cn("overflow-hidden rounded-[1.75rem] bg-white shadow-[var(--card-shadow)]", compact ? "mx-5" : "mx-5")}>
      <div className={cn("bg-[var(--mint-deep)]/70 px-5", compact ? "py-4" : "py-6")}>
        <div className="text-sm text-[var(--muted-foreground)]">Wallet Balance</div>
        <div className={cn("mt-1 font-semibold tracking-tight tabular-nums text-[var(--dark-green)]", compact ? "text-3xl" : "text-4xl")}>
          ${formatUsd(balanceCents)}
        </div>
      </div>
      {actions && <div className="flex items-stretch justify-around gap-2 px-3 py-4">{actions}</div>}
    </div>
  );
}

function ActionPill({
  label,
  filled,
  icon,
  onClick,
}: {
  label: string;
  filled?: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="flex flex-1 flex-col items-center gap-2">
      <span
        className={cn(
          "grid h-12 w-12 place-items-center rounded-full shadow-sm",
          filled ? "bg-[var(--dark-green)] text-white" : "bg-[var(--chip)] text-[var(--dark-green)]",
        )}
      >
        {icon}
      </span>
      <span className="text-xs font-medium text-[var(--dark-green)]">{label}</span>
    </button>
  );
}

export function HomeScreen({
  userName,
  userEmail,
  wallet,
  txs,
  onSend,
  onBank,
  onSeeAll,
}: {
  userName: string;
  userEmail: string;
  wallet: WalletSnap;
  txs: Tx[];
  onSend: () => void;
  onBank: () => void;
  onSeeAll: () => void;
}) {
  const greeting = userName.split(" ")[0] || DEMO_USER.name;
  return (
    <div className="px-0 pt-4">
      <div className="mb-5 flex items-center justify-between px-5">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-[var(--dark-green)] text-sm font-semibold text-white">
            {(userName || DEMO_USER.name).slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="font-semibold text-[var(--dark-green)]">Hi, {greeting}!</div>
            <div className="text-xs text-[var(--muted-foreground)]">{userEmail || DEMO_USER.email}</div>
          </div>
        </div>
        <button type="button" aria-label="Notifications" className="grid h-10 w-10 place-items-center rounded-full bg-white/80">
          <Bell className="h-4 w-4 text-[var(--dark-green)]" />
        </button>
      </div>

      <BalanceCard
        balanceCents={wallet.balance}
        actions={
          <>
            <ActionPill label="Send" filled icon={<ArrowLeftRight className="h-5 w-5" />} onClick={onSend} />
            <ActionPill label="Wallet" icon={<Landmark className="h-5 w-5" />} onClick={onBank} />
          </>
        }
      />

      <div className="mt-6 px-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-[var(--dark-green)]">Transactions</h2>
          <button type="button" onClick={onSeeAll} className="text-sm text-[var(--muted-foreground)]">See all</button>
        </div>
        <TxList txs={txs.slice(0, 4)} />
      </div>
    </div>
  );
}

export function TxList({ txs }: { txs: Tx[] }) {
  if (!txs.length) {
    return (
      <div className="rounded-[1.5rem] bg-white px-4 py-8 text-center text-sm text-[var(--muted-foreground)] shadow-[var(--card-shadow)]">
        No transactions yet.
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {txs.map((t) => {
        const incoming = isIncoming(t);
        const label = (t.counterparty || "").replace(/ · .*/, "");
        const initials = label.slice(0, 2).toUpperCase();
        return (
          <li key={t.id} className="flex items-center gap-3 rounded-[1.25rem] bg-white px-3 py-3 shadow-sm">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--chip)] text-xs font-semibold text-[var(--dark-green)]">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-[var(--dark-green)]">{label}</div>
              <div className="text-xs text-[var(--muted-foreground)]">{formatTxDate(t.created_at)}{t.refunded ? " · refunded" : ""}</div>
            </div>
            <div className={cn("tabular-nums text-sm font-semibold", incoming ? "text-[var(--dark-green)]" : "text-[var(--outgoing)]")}>
              {incoming ? "+" : "-"}${formatUsd(t.amount)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function PrimaryButton({ children, onClick, disabled }: { children: ReactNode; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-full bg-[var(--lime-btn)] py-4 text-base font-semibold text-[var(--dark-green)] shadow-sm transition active:scale-[0.99] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export { Building2, Pencil };
