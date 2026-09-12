import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  approveInferenceBinding,
  reviewRunInference,
  type RunInferenceReview,
} from "./api";
import { useControlState } from "./control-state";
import { useRunClock } from "./queries";
import { Button } from "./ui";

export function RunInferenceAccess({
  runId,
  disabled,
  onReview,
}: {
  runId: string;
  disabled: boolean;
  onReview: () => void;
}) {
  const { writesAllowed, actor } = useControlState();
  const [review, setReview] = useState<RunInferenceReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const generation = useRef(0);
  const now = useRunClock();
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope changes must invalidate pending responses and confirmation, even without reading their values in the reset.
  useEffect(() => {
    generation.current++;
    setReview(null);
    setMessage(null);
    return () => {
      generation.current++;
    };
  }, [runId, writesAllowed, actor.username, disabled]);
  const available = writesAllowed && !disabled && !busy;
  async function preview() {
    if (!available) return;
    const version = ++generation.current;
    setBusy(true);
    setReview(null);
    setMessage(null);
    onReview();
    try {
      const value = await reviewRunInference(runId);
      if (version !== generation.current) return;
      if (value.run_id !== runId) throw new Error("Run changed");
      setReview(value);
      if (!value.approval_required)
        setMessage(
          "Inference access is already approved for this configuration and current worker image. Review replacements next; nothing was launched.",
        );
    } catch (error) {
      if (version === generation.current)
        setMessage(
          error instanceof ApiError && error.status === 403
            ? "No unambiguous enabled approval for this run is available to your account, or its secret is missing. Ask the original binding owner to check Manage secrets. Do not recreate the recipe or change its source to bypass this check."
            : "Inference review is unavailable or changed. Refresh this run and review again; no approval was saved.",
        );
    } finally {
      setBusy(false);
    }
  }
  async function approve() {
    if (!available || !review?.approval_required) return;
    if (Date.now() >= Date.parse(review.expires_at)) {
      setReview(null);
      return;
    }
    const version = ++generation.current;
    setBusy(true);
    setMessage(null);
    // Never replay an uncertain policy write. A fresh review checks for success.
    setReview(null);
    try {
      await approveInferenceBinding(review.ref, {
        expected_revision: review.revision,
        review_id: review.review_id,
        reviewed_confirmation: true,
        reason: "Reviewed existing run inference scope for current worker image",
      });
      if (version === generation.current)
        setMessage(
          "Inference access approved. Review replacements next; nothing was launched.",
        );
    } catch {
      if (version === generation.current)
        setMessage(
          "Approval is unconfirmed or the registry changed. Review inference access again to check current policy before trying to save. No automatic retry or launch.",
        );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Run inference access" className="space-y-3">
      <Button
        type="button"
        variant="outline"
        disabled={!available}
        onClick={() => void preview()}
      >
        {busy ? "Checking inference access…" : "Review inference access for this run"}
      </Button>
      <p>
        Uses the run’s recorded configuration, not an editable Workbench draft. Existing
        valid approval is reused; a new worker image requires explicit confirmation.
      </p>
      {message ? <p role="status">{message}</p> : null}
      {review?.approval_required ? (
        <div className="space-y-2 break-all">
          <h3 className="font-semibold">
            Approve existing inference scope for the current image
          </h3>
          <p>
            Only the worker image changes. This saves credential policy, not a
            replacement run. It permits this exact scope wherever normal policy applies,
            not only this run.
          </p>
          <p>
            {review.label}: {review.source_env} →{" "}
            {review.grant.destination_env.join(", ")} · Presence: {review.presence} (not
            authentication)
          </p>
          <p>Operator: {review.grant.operator_subjects.join(", ")}</p>
          <p>Current worker image: {review.grant.worker_image}</p>
          <p>
            Agent: {review.grant.agent_import_path} · Recipe digest:{" "}
            {review.grant.recipe_digest}
          </p>
          <p>
            Model: {review.grant.allowed_models.join(", ")} · Route:{" "}
            {review.grant.route_api}
          </p>
          <p>
            Base URL: {review.grant.base_url ?? "none"} · Declared hosts:{" "}
            {review.grant.allowed_hosts.join(", ") || "none"}
          </p>
          <p>
            Host declarations are not firewall enforcement. No credential values or
            source/destination changes. Review expires: {review.expires_at}.
          </p>
          <Button
            type="button"
            disabled={!available || now >= Date.parse(review.expires_at)}
            onClick={() => void approve()}
          >
            Approve this image for the existing scope
          </Button>
          {now >= Date.parse(review.expires_at) ? (
            <p>Review expired. Review inference access again.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
