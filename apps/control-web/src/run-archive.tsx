import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type RunView } from "./api";
import { useControlState } from "./control-state";
import { keys } from "./queries";
import { Button } from "./ui";

/** Shared display state only. Never use execution actions for archive/restore. */
export function RunArchive({ run }: { run: RunView }) {
  const { writesAllowed } = useControlState();
  const client = useQueryClient();
  const [needsReload, setNeedsReload] = useState(false);
  const reload = async () => {
    setNeedsReload(true);
    try {
      await Promise.all([
        client.refetchQueries(
          { queryKey: keys.run(run.record.run_id), exact: true },
          { throwOnError: true },
        ),
        client.invalidateQueries({ queryKey: keys.runs }, { throwOnError: true }),
      ]);
      setNeedsReload(false);
    } catch {
      /* Keep writes blocked while the projected read fails. */
    }
  };
  const mutation = useMutation({
    mutationFn: () =>
      api<RunView["presentation"]>(
        `/api/v1/runs/${encodeURIComponent(run.record.run_id)}/presentation`,
        {
          method: "PATCH",
          body: JSON.stringify({
            archived: !run.presentation?.archived,
            expected_revision: run.presentation?.revision ?? 0,
          }),
        },
      ),
    onSuccess: reload,
    onError: reload,
    retry: false,
  });
  if (!writesAllowed) return null;
  return (
    <div className="mb-4 text-sm">
      <Button
        variant="outline"
        disabled={
          mutation.isPending || needsReload || run.presentation_available === false
        }
        onClick={() => mutation.mutate()}
      >
        {run.presentation?.archived ? "Restore" : "Archive"}
      </Button>
      <span className="ml-3 text-slate-400">
        Shared across browsers. Hides from default Runs view; jobs continue and results
        are kept.
      </span>
      {mutation.error ? (
        <p role="alert">
          {mutation.error.message} A synchronized archive state is required before
          retrying.
        </p>
      ) : null}
      {needsReload || run.presentation_available === false ? (
        <div role="alert">
          Archive visibility is unconfirmed.{" "}
          <Button variant="outline" onClick={() => void reload()}>
            Reload archive state
          </Button>
        </div>
      ) : null}
    </div>
  );
}
