import {
  Activity,
  BarChart3,
  Boxes,
  ClipboardList,
  FileClock,
  Gauge,
  LogOut,
  Menu,
  Network,
  ServerCog,
  ShieldCheck,
  Trophy,
  Wrench,
  X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { DisplayActor } from "./control-state";
import { hints } from "./hints";
import { cn, formatDate, humanize } from "./lib";
import type { LiveState } from "./queries";
import { Badge, Button, ErrorNotice, Hint } from "./ui";

const adminNavigation = [
  ["/overview", "Overview", Gauge, hints.nav.overview],
  ["/workbench", "Workbench", Wrench, hints.nav.workbench],
  ["/runs", "Runs", ClipboardList, hints.nav.runs],
  ["/jobs", "Jobs", ServerCog, hints.nav.jobs],
  ["/endpoints", "Endpoints", Network, hints.nav.endpoints],
  ["/results", "Results", BarChart3, hints.nav.results],
  ["/profiles", "Profiles", Boxes, hints.nav.profiles],
  ["/audit", "Audit", FileClock, hints.nav.audit],
] as const;

export function loginHref(returnTo: string): string {
  return `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

function isAdminPath(path: string): boolean {
  return (
    path === "/overview" ||
    path.startsWith("/workbench") ||
    path.startsWith("/runs") ||
    path.startsWith("/jobs") ||
    path.startsWith("/endpoints") ||
    path.startsWith("/results") ||
    path.startsWith("/profiles") ||
    path.startsWith("/audit")
  );
}

function navItemClass(active: boolean): string {
  return cn(
    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
    active
      ? "bg-cyan-400/10 text-cyan-300"
      : "text-slate-400 hover:bg-slate-900 hover:text-slate-100",
  );
}

export function Layout({
  children,
  actor,
  writeMode,
  live,
  serviceError,
  onSignOut,
  signingOut,
}: {
  children: ReactNode;
  actor: DisplayActor | null;
  writeMode: string;
  live: LiveState | null;
  serviceError: unknown;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const authenticated = actor !== null;
  const adminActive = isAdminPath(location.pathname);
  const closeNav = () => setOpen(false);
  return (
    <div className="min-h-screen overflow-x-hidden bg-slate-950 text-slate-100">
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
          <NavLink
            end
            to="/"
            onClick={closeNav}
            className={({ isActive }) => navItemClass(isActive)}
          >
            <Trophy size={18} />
            <Hint text={hints.nav.leaderboard}>Leaderboard</Hint>
          </NavLink>
          <div className="pt-3">
            <div
              className={cn(
                "flex items-center gap-3 px-3 py-2 text-sm font-medium",
                adminActive ? "text-cyan-300" : "text-slate-300",
              )}
            >
              <ShieldCheck size={18} />
              <Hint text={hints.nav.admin}>Admin</Hint>
            </div>
            <div className="ml-3 space-y-1 border-l border-slate-800 pl-2">
              {adminNavigation.map(([href, label, Icon, hint]) =>
                authenticated ? (
                  <NavLink
                    key={href}
                    end={href === "/overview"}
                    to={href}
                    onClick={closeNav}
                    className={({ isActive }) => navItemClass(isActive)}
                  >
                    <Icon size={18} />
                    <Hint text={hint}>{label}</Hint>
                  </NavLink>
                ) : (
                  <a
                    key={href}
                    href={loginHref(href)}
                    onClick={closeNav}
                    className={navItemClass(false)}
                  >
                    <Icon size={18} />
                    <Hint text={hint}>{label}</Hint>
                  </a>
                ),
              )}
            </div>
          </div>
        </nav>
        {authenticated ? (
          <div className="mt-auto space-y-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            {live ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs text-slate-400">
                    <Activity size={14} />
                    <Hint text={hints.chrome.liveUpdates}>Live updates</Hint>
                  </span>
                  <Badge status={live.status === "connected" ? "ready" : "pending"}>
                    {humanize(live.status)}
                  </Badge>
                </div>
                <p className="text-xs leading-5 text-slate-500">
                  {live.lastSuccessfulUpdate
                    ? `Last update ${formatDate(new Date(live.lastSuccessfulUpdate).toISOString())}`
                    : "Waiting for the first live update"}
                </p>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 text-xs text-slate-400">
                    <ShieldCheck size={14} />
                    <Hint
                      text={
                        writeMode === "local"
                          ? "Local Harbor runs are enabled. Hosted control-plane writes remain disabled."
                          : hints.chrome.writeMode
                      }
                    >
                      {writeMode === "local" ? "Execution mode" : "Write mode"}
                    </Hint>
                  </span>
                  <Badge
                    status={
                      writeMode === "enabled" || writeMode === "local"
                        ? "ready"
                        : "pending"
                    }
                  >
                    {humanize(writeMode)}
                  </Badge>
                </div>
              </>
            ) : null}
            {actor ? (
              <div className={live ? "border-t border-slate-800 pt-3" : undefined}>
                <div className="truncate text-sm font-medium">{actor.username}</div>
                <Button
                  className="mt-2 w-full"
                  variant="ghost"
                  disabled={signingOut}
                  onClick={onSignOut}
                >
                  <LogOut size={14} />
                  {signingOut ? "Signing out" : "Sign out"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
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
