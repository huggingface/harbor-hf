import {
  Activity,
  ClipboardList,
  Gauge,
  LogIn,
  LogOut,
  Menu,
  ServerCog,
  Trophy,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { SystemResponse } from "./api";
import type { DisplayActor } from "./control-state";
import { cn, humanize } from "./lib";
import { Badge, Button, ErrorNotice } from "./ui";

const operatorNavigation = [
  ["/overview", "Overview", Gauge],
  ["/workbench", "Workbench", Wrench],
  ["/runs", "Runs", ClipboardList],
  ["/jobs", "Jobs", ServerCog],
] as const;

export function loginHref(returnTo: string): string {
  return `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

function navItemClass(active: boolean): string {
  return cn(
    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
    active
      ? "bg-cyan-400/10 text-cyan-300"
      : "text-slate-400 hover:bg-slate-900 hover:text-slate-100",
  );
}

function Navigation({
  authenticated,
  close,
}: {
  authenticated: boolean;
  close(): void;
}) {
  return (
    <nav aria-label="Main navigation" className="space-y-1">
      <NavLink
        className={({ isActive }) => navItemClass(isActive)}
        to="/"
        onClick={close}
      >
        <Trophy size={17} aria-hidden="true" />
        Leaderboard
      </NavLink>
      {authenticated
        ? operatorNavigation.map(([href, label, Icon]) => (
            <NavLink
              className={({ isActive }) => navItemClass(isActive)}
              key={href}
              to={href}
              onClick={close}
            >
              <Icon size={17} aria-hidden="true" />
              {label}
            </NavLink>
          ))
        : null}
    </nav>
  );
}

export function Layout({
  children,
  actor,
  system,
  serviceError,
  onSignOut,
  signingOut,
}: {
  children: ReactNode;
  actor: DisplayActor | null;
  system: SystemResponse | null;
  serviceError: unknown;
  onSignOut(): void;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-950 text-slate-100">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-cyan-400 focus:px-3 focus:py-2 focus:text-slate-950"
        href="#main"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 backdrop-blur lg:hidden">
        <Link
          className="flex items-center gap-2 font-semibold"
          to={actor ? "/overview" : "/"}
        >
          <Activity className="text-cyan-400" size={20} aria-hidden="true" />
          Harbor-HF
        </Link>
        <button
          type="button"
          className="rounded-md p-2 text-slate-300 hover:bg-slate-800 hover:text-white"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-slate-800 bg-slate-950 p-5 transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-8 flex items-center justify-between">
          <Link
            className="flex items-center gap-3"
            to={actor ? "/overview" : "/"}
            onClick={() => setOpen(false)}
          >
            <span className="grid size-9 place-items-center rounded-lg bg-cyan-400/10 text-cyan-300">
              <Activity size={20} aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-white">Harbor-HF</span>
              <span className="block text-xs text-slate-500">Benchmark control</span>
            </span>
          </Link>
          <button
            type="button"
            className="rounded-md p-2 text-slate-400 lg:hidden"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          >
            <X size={19} />
          </button>
        </div>
        <Navigation authenticated={actor !== null} close={() => setOpen(false)} />
        <div className="mt-auto space-y-4 border-t border-slate-800 pt-4">
          {system ? (
            <div className="space-y-2 text-xs text-slate-500">
              <div className="flex items-center justify-between gap-3">
                <span>Service</span>
                <Badge status={system.ready ? "ready" : "error"}>
                  {system.ready ? "Ready" : "Not ready"}
                </Badge>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Write mode</span>
                <Badge status={system.write_mode}>{humanize(system.write_mode)}</Badge>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Workbench</span>
                <Badge status={system.workbench.setup_enabled ? "ready" : "pending"}>
                  {humanize(system.workbench.runner)}
                </Badge>
              </div>
            </div>
          ) : null}
          {actor ? (
            <div>
              <p className="truncate text-sm font-medium text-slate-200">
                {actor.username}
              </p>
              <p className="text-xs text-slate-500">
                {humanize(actor.role)} · {humanize(actor.transport)}
              </p>
              <Button
                className="mt-3 w-full"
                variant="ghost"
                disabled={signingOut}
                onClick={onSignOut}
              >
                <LogOut size={14} aria-hidden="true" />
                {signingOut ? "Signing out" : "Sign out"}
              </Button>
            </div>
          ) : (
            <a
              className="flex min-h-9 items-center justify-center gap-2 rounded-md bg-cyan-500 px-3 text-sm font-medium text-slate-950 hover:bg-cyan-400"
              href={loginHref(location.pathname)}
            >
              <LogIn size={14} aria-hidden="true" />
              Sign in
            </a>
          )}
        </div>
      </aside>
      <main
        id="main"
        className="min-h-screen min-w-0 overflow-x-hidden px-4 py-8 sm:px-6 lg:ml-72 lg:px-10"
      >
        {serviceError ? <ErrorNotice error={serviceError} stale /> : null}
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
  titleClassName,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  titleClassName?: string;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1
          className={cn(
            "text-2xl font-semibold tracking-tight text-white sm:text-3xl",
            titleClassName,
          )}
        >
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">{description}</p>
      </div>
      {action}
    </div>
  );
}
