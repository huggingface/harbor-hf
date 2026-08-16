import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "./lib";

const buttonVariants = cva(
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-cyan-500 text-slate-950 hover:bg-cyan-400",
        secondary: "bg-slate-800 text-slate-100 hover:bg-slate-700",
        outline:
          "border border-slate-700 bg-transparent text-slate-100 hover:bg-slate-800",
        destructive: "bg-rose-600 text-white hover:bg-rose-500",
        ghost: "text-slate-300 hover:bg-slate-800 hover:text-white",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export function Button({
  className,
  variant,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-slate-800 bg-slate-950/70 p-5 shadow-sm",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  status,
  children,
}: {
  status?: string;
  children: React.ReactNode;
}) {
  const tone =
    status === "completed" || status === "published" || status === "ready"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
      : status === "failed" || status === "error"
        ? "border-rose-500/40 bg-rose-500/10 text-rose-300"
        : status === "active" || status === "running"
          ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-300";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        tone,
      )}
    >
      {children}
    </span>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const bounded = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-400">
        <span>{label}</span>
        <span>{Math.round(bounded)}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-cyan-400 transition-[width] motion-reduce:transition-none"
          style={{ width: `${bounded}%` }}
        />
      </div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <Card className="py-12 text-center text-sm text-slate-400">{children}</Card>;
}

export function Loading() {
  return (
    <div className="flex min-h-48 items-center justify-center gap-3 text-sm text-slate-400">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-600 border-t-cyan-400 motion-reduce:animate-none" />
      Loading
    </div>
  );
}
