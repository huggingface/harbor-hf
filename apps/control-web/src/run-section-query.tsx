import { type ReactNode, useContext } from "react";
import { ConsolidatedRunRefresh } from "./run-refresh-status";
import { QueryContent } from "./ui";

/** Fetch feedback is separate from the freshness of Harbor evidence. */
export function RunSectionQuery({
  label,
  query,
  children,
}: {
  label: string;
  query: {
    data: unknown;
    error: unknown;
    isPending: boolean;
    isFetching: boolean;
    refetch: () => Promise<unknown>;
  };
  children?: ReactNode;
}) {
  const consolidated = useContext(ConsolidatedRunRefresh);
  const hasData = query.data !== undefined;
  if (consolidated) return hasData ? children : null;
  return (
    <>
      {/* Reserve feedback space so background requests never move cached evidence. */}
      <div className="my-3 h-10 text-sm text-slate-400">
        {query.isFetching || (query.isPending && !hasData) ? (
          <p role="status">
            {hasData ? "Refreshing" : "Loading"} {label}…
          </p>
        ) : null}
        {hasData && query.error ? (
          <p role="alert" className="text-amber-400">
            <span title="The latest refresh failed.">Showing saved data</span>{" "}
            <button
              type="button"
              className="underline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </p>
        ) : null}
      </div>
      {hasData ? (
        children
      ) : query.isPending ? null : (
        <QueryContent query={query}>{children}</QueryContent>
      )}
    </>
  );
}
