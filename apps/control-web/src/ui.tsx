import { cva, type VariantProps } from "class-variance-authority";
import { CircleHelp } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { ApiError } from "./api";
import { BADGE_TONE_CLASS, badgeTone } from "./badge-tone";
import { cn, logicalOutcomeHint, logicalOutcomeLabel } from "./lib";

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
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant }), className)} {...props} />;
}

export function Hint({
  text,
  children,
  icon = false,
}: {
  text: string;
  children: ReactNode;
  icon?: boolean;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    top?: number;
    bottom?: number;
  }>({ left: 12, top: 12 });
  const updatePosition = useCallback(() => {
    const bounds = anchor.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.min(288, window.innerWidth - 24);
    const left = Math.min(
      Math.max(bounds.left, 12),
      Math.max(12, window.innerWidth - width - 12),
    );
    if (bounds.top > 180)
      setPosition({ left, bottom: window.innerHeight - bounds.top + 8 });
    else setPosition({ left, top: bounds.bottom + 8 });
  }, []);
  const show = () => {
    updatePosition();
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);
  useLayoutEffect(() => {
    if (icon) return;
    const element = anchor.current;
    if (!element) return;
    const owner =
      element.parentElement?.closest<HTMLElement>("button, a, [tabindex]") ?? null;
    if (!owner) {
      element.tabIndex = 0;
      return () => element.removeAttribute("tabindex");
    }
    element.removeAttribute("tabindex");
    const describedBy = owner.getAttribute("aria-describedby");
    const ids = new Set(describedBy?.split(/\s+/).filter(Boolean) ?? []);
    ids.add(id);
    owner.setAttribute("aria-describedby", [...ids].join(" "));
    const showFromOwner = () => {
      updatePosition();
      setOpen(true);
    };
    const hideFromOwner = () => setOpen(false);
    owner.addEventListener("focus", showFromOwner);
    owner.addEventListener("blur", hideFromOwner);
    return () => {
      owner.removeEventListener("focus", showFromOwner);
      owner.removeEventListener("blur", hideFromOwner);
      if (describedBy) owner.setAttribute("aria-describedby", describedBy);
      else owner.removeAttribute("aria-describedby");
    };
  }, [icon, id, updatePosition]);
  const tooltip =
    typeof document === "undefined"
      ? null
      : createPortal(
          <span
            aria-hidden={!open}
            id={id}
            role="tooltip"
            className={cn(
              "pointer-events-none fixed z-[100] w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-cyan-500/50 bg-slate-800 p-3 text-left text-xs font-normal normal-case leading-5 tracking-normal text-slate-100 shadow-2xl ring-1 ring-black/50",
              open ? "visible opacity-100" : "invisible opacity-0",
            )}
            style={position}
          >
            {text}
          </span>,
          document.body,
        );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Focus listeners are attached to the surrounding control or optional icon button.
    <span
      aria-describedby={id}
      className="relative inline-flex max-w-full items-center gap-1"
      ref={anchor}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onFocusCapture={show}
      onMouseEnter={show}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="cursor-help border-b border-dotted border-slate-500">
        {children}
      </span>
      {icon ? (
        <button
          type="button"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-slate-500 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
          aria-label={
            typeof children === "string" ? `Explain ${children}` : "Explain this field"
          }
          aria-describedby={id}
        >
          <CircleHelp size={13} />
        </button>
      ) : null}
      {tooltip}
    </span>
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border border-slate-800 bg-slate-950/70 p-4 shadow-sm sm:p-5",
        className,
      )}
      {...props}
    />
  );
}

export type { BadgeTone } from "./badge-tone";
export { badgeTone, statusTextClass } from "./badge-tone";

export function Badge({ status, children }: { status?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        BADGE_TONE_CLASS[badgeTone(status)],
      )}
    >
      {children}
    </span>
  );
}

export function OutcomeBadge({ outcome }: { outcome?: string | null }) {
  const value = outcome ?? "pending";
  return (
    <Hint text={logicalOutcomeHint(value)}>
      <Badge status={value}>{logicalOutcomeLabel(value)}</Badge>
    </Hint>
  );
}

export function Progress({ value, label }: { value: number; label: string }) {
  const bounded = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1">
      <div className="flex justify-between gap-2 text-xs text-slate-400">
        <span className="min-w-0 truncate">{label}</span>
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

export function Empty({ children }: { children: ReactNode }) {
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

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("The request failed.");
}

function errorTitle(error: unknown): string {
  if (!(error instanceof ApiError)) return "Request failed";
  if (error.status === 0) return "Offline";
  if (error.status === 429) return "Rate limited";
  if (error.status === 403) return "Forbidden";
  if (error.status === 404) return "Not found";
  if (error.status >= 500) return "Server error";
  return "Request failed";
}

export function ErrorNotice({
  error,
  retry,
  stale = false,
}: {
  error: unknown;
  retry?: () => void;
  stale?: boolean;
}) {
  const normalized = asError(error);
  const apiError = error instanceof ApiError ? error : null;
  return (
    <Card
      className={cn(
        "border-rose-500/40 bg-rose-500/5 text-sm",
        stale && "mb-4 border-amber-500/40 bg-amber-500/5",
      )}
      role="alert"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-medium text-slate-100">
            {stale ? "Showing saved data" : errorTitle(error)}
          </p>
          <p className="mt-1 whitespace-pre-line break-words text-slate-400">
            {stale
              ? `The latest refresh failed: ${normalized.message}`
              : normalized.message}
          </p>
          {apiError ? (
            <p className="mt-2 text-xs text-slate-500">
              Code: {apiError.code} ·{" "}
              {apiError.status > 0 ? `HTTP ${apiError.status}` : "network error"}
            </p>
          ) : null}
          {apiError?.retryAt ? (
            <p className="mt-1 text-xs text-slate-500">
              Retry after {new Date(apiError.retryAt).toLocaleTimeString()}.
            </p>
          ) : null}
          {apiError?.requestId ? (
            <p className="mt-1 text-xs text-slate-500">
              Request ID: <code className="select-all">{apiError.requestId}</code>
            </p>
          ) : null}
        </div>
        {retry ? (
          <Button variant="outline" onClick={retry}>
            Retry
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

interface QueryStateLike {
  data: unknown;
  error: unknown;
  isPending: boolean;
  refetch: () => Promise<unknown>;
}

export function QueryContent({
  query,
  children,
}: {
  query: QueryStateLike;
  children: ReactNode;
}) {
  if (query.isPending && query.data === undefined) return <Loading />;
  if (query.error && query.data === undefined)
    return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  return (
    <>
      {query.error ? (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} stale />
      ) : null}
      {children}
    </>
  );
}
