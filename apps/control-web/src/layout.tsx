import {
  Activity,
  BarChart3,
  Boxes,
  ClipboardList,
  FileClock,
  Gauge,
  Menu,
  Network,
  ServerCog,
  Settings2,
  ShieldCheck,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cn, humanize } from "./lib";
import { Badge, Button } from "./ui";

const navigation = [
  ["/", "Overview", Gauge],
  ["/campaigns", "Campaigns", ClipboardList],
  ["/jobs", "Jobs", ServerCog],
  ["/endpoints", "Endpoints", Network],
  ["/results", "Results", BarChart3],
  ["/profiles", "Profiles", Boxes],
  ["/audit", "Audit", FileClock],
] as const;

export function Layout({
  children,
  actor,
  writeMode,
  live,
}: {
  children: ReactNode;
  actor: { subject: string; role: string };
  writeMode: string;
  live: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-cyan-400 focus:px-3 focus:py-2 focus:text-slate-950"
        href="#main"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 flex h-16 items-center border-b border-slate-800 bg-slate-950/95 px-4 backdrop-blur lg:hidden">
        <Button
          aria-label="Open navigation"
          variant="ghost"
          onClick={() => setOpen(true)}
        >
          <Menu size={20} />
        </Button>
        <strong className="ml-3 tracking-tight">Harbor-HF Control</strong>
      </header>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-slate-800 bg-slate-950 p-4 transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-12 items-center justify-between px-2">
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-cyan-400 font-black text-slate-950">
              H
            </span>
            <div>
              <div className="font-semibold tracking-tight">Harbor-HF</div>
              <div className="text-xs text-slate-500">Control plane</div>
            </div>
          </div>
          <Button
            className="lg:hidden"
            aria-label="Close navigation"
            variant="ghost"
            onClick={() => setOpen(false)}
          >
            <X size={19} />
          </Button>
        </div>
        <nav className="mt-8 space-y-1" aria-label="Primary">
          {navigation.map(([href, label, Icon]) => (
            <NavLink
              key={href}
              end={href === "/"}
              to={href}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                  isActive
                    ? "bg-cyan-400/10 text-cyan-300"
                    : "text-slate-400 hover:bg-slate-900 hover:text-slate-100",
                )
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs text-slate-400">
              <Activity size={14} />
              Live updates
            </span>
            <Badge status={live === "connected" ? "ready" : "pending"}>
              {humanize(live)}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-xs text-slate-400">
              <ShieldCheck size={14} />
              Write mode
            </span>
            <Badge status={writeMode === "enabled" ? "ready" : "pending"}>
              {humanize(writeMode)}
            </Badge>
          </div>
          <div className="border-t border-slate-800 pt-3">
            <div className="truncate text-sm font-medium">{actor.subject}</div>
            <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
              <Settings2 size={12} />
              {humanize(actor.role)}
            </div>
          </div>
        </div>
      </aside>
      <main id="main" className="min-h-screen px-4 py-8 sm:px-6 lg:ml-72 lg:px-10">
        {children}
      </main>
      {open ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          aria-label="Close navigation overlay"
          onClick={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">{description}</p>
      </div>
      {action}
    </div>
  );
}
