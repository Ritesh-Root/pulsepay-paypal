import { ReactNode } from "react";
import { cn } from "./ui/utils";

export function Panel({
  children,
  className,
  title,
  description,
  aside,
}: {
  children: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-3xl border border-[var(--hairline)] bg-card p-6 shadow-[0_1px_0_rgba(0,0,0,0.02),0_24px_60px_-30px_rgba(15,15,20,0.18)]",
        className,
      )}
    >
      {(title || aside) && (
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            {title && <div className="tracking-tight">{title}</div>}
            {description && (
              <div className="mt-1 text-sm text-muted-foreground">{description}</div>
            )}
          </div>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--hairline)] bg-[var(--chip)] p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
