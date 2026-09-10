import type { InferenceBindingsV1, InferenceReviewV1 } from "@harbor-hf/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  approveInferenceBinding,
  getInferenceBindings,
  registerInferenceBinding,
  reviewInferenceBinding,
  setInferenceBindingStatus,
  type WorkbenchRecipe,
} from "./api";

/** Operator-only metadata editor. Never persist reviews, reasons or source names. */
export function ManageSecrets({
  recipe,
  model,
  context = "",
  onDiscovery,
}: {
  recipe: WorkbenchRecipe;
  model: string;
  context?: string;
  onDiscovery(value: InferenceBindingsV1 | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [registry, setRegistry] = useState<InferenceBindingsV1 | null>(null);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [reason, setReason] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [hosts, setHosts] = useState("");
  const [review, setReview] = useState<InferenceReviewV1 | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const epoch = useRef(0);
  const latest = useRef("");
  const fingerprint = JSON.stringify([recipe, model, context, baseUrl, hosts]);
  latest.current = fingerprint;
  const invalidate = useCallback(() => {
    ++epoch.current;
    setReview(null);
    setConfirmed(false);
  }, []);
  useEffect(() => {
    void fingerprint;
    invalidate();
  }, [fingerprint, invalidate]);
  const registryIdentity = useRef("");
  const reads = useRef(0);
  const refresh = useCallback(
    async (explicit = false) => {
      const request = ++reads.current;
      try {
        const result = await getInferenceBindings();
        if (request !== reads.current) return;
        const identity = JSON.stringify(result);
        if (identity !== registryIdentity.current) {
          invalidate();
          registryIdentity.current = identity;
        }
        setRegistry(result);
        onDiscovery(result);
        if (explicit) {
          setBlocked(false);
          setMessage(
            "Registry refreshed. Inspect current state before saving or reviewing again.",
          );
        }
      } catch {
        if (request !== reads.current) return;
        invalidate();
        setRegistry(null);
        onDiscovery(null);
        setBlocked(true);
        setMessage("Availability unavailable, not missing. Refresh before continuing.");
      }
    },
    [invalidate, onDiscovery],
  );
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 30000);
    return () => {
      window.clearInterval(timer);
      ++epoch.current;
      ++reads.current;
    };
  }, [refresh]);
  const refs = [
    ...new Set(
      recipe.environment
        .filter((row) => row.source === "model_api_key")
        .map((row) => row.credential_ref ?? ""),
    ),
  ];
  const selected =
    refs.length === 1 && refs[0]
      ? registry?.bindings.find((item) => item.ref === refs[0])
      : undefined;
  const ready = !busy && !blocked && registry !== null;
  async function save(action: () => Promise<unknown>, success: string) {
    invalidate();
    setBusy(true);
    setMessage("");
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (error) {
      setBlocked(true);
      setMessage(
        error instanceof ApiError && error.status === 409
          ? "Conflict: refresh and review current state. Nothing will be retried automatically."
          : error instanceof ApiError && error.status === 400
            ? "Request rejected. Check the name, label, reason and connection settings, then refresh before trying again."
            : "Save not confirmed; it may have succeeded. Refresh and inspect current state before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function requestReview() {
    if (!registry || !selected) return;
    invalidate();
    const current = epoch.current;
    const input = fingerprint;
    setBusy(true);
    setMessage("");
    try {
      const result = await reviewInferenceBinding(selected.ref, {
        expected_revision: registry.revision,
        recipe,
        model_name: model,
        base_url: baseUrl.trim() || null,
        allowed_hosts: hosts
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      });
      if (current === epoch.current && input === latest.current) setReview(result);
    } catch {
      setBlocked(true);
      setMessage("Review unavailable or stale. Refresh and review again.");
    } finally {
      setBusy(false);
    }
  }
  const inputClass =
    "mt-1 block w-full rounded border border-slate-700 bg-slate-950 p-2 text-slate-100";
  return (
    <section className="my-3 space-y-3 rounded border border-slate-700 p-3 text-sm">
      <button type="button" className="underline" onClick={() => setOpen(!open)}>
        Manage secrets
      </button>
      {open && (
        <section aria-label="Manage secrets" className="space-y-3">
          <p>
            Register an existing Space secret NAME only, never its value. Missing keys
            may be registered. Presence is not authentication, quota or compatibility.
          </p>
          <label className="block">
            Space secret name
            <input
              className={inputClass}
              aria-label="Space secret name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="block">
            Friendly label
            <input
              className={inputClass}
              aria-label="Friendly label"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <label className="block">
            Change reason
            <input
              className={inputClass}
              aria-label="Change reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            className="rounded border border-slate-600 px-3 py-2 text-cyan-300 disabled:opacity-40"
            type="button"
            disabled={
              !ready ||
              !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) ||
              !label.trim() ||
              !reason.trim()
            }
            onClick={() =>
              registry &&
              void save(
                () =>
                  registerInferenceBinding({
                    expected_revision: registry.revision,
                    source_env: name,
                    label,
                    reason,
                  }),
                "Reference registered. Select it in a Secret environment binding.",
              )
            }
          >
            Register reference
          </button>
          <p>
            Control and infrastructure names are reserved and rejected by the server.
            Ownership is enforced by the server.
          </p>
          <ul>
            {registry?.bindings.map((binding) => (
              <li key={binding.ref}>
                {binding.label} · {binding.source_env} · {binding.status}
                <button
                  className="ml-2 rounded border border-slate-600 px-2 py-1 text-cyan-300 disabled:opacity-40"
                  type="button"
                  disabled={!ready || !reason.trim()}
                  onClick={() =>
                    registry &&
                    void save(
                      () =>
                        setInferenceBindingStatus(binding.ref, {
                          expected_revision: registry.revision,
                          enabled: !binding.enabled,
                          reason,
                        }),
                      "Reference status saved. Review again before approving.",
                    )
                  }
                >
                  {binding.enabled ? "Disable" : "Re-enable"} {binding.label}
                </button>
              </li>
            ))}
          </ul>
          <details>
            <summary>Advanced connection settings</summary>
            <p>
              Native key-only use needs no base URL or hosts. Other protocols require
              explicit connection settings. Hosts are declarations, not a firewall.
            </p>
            <label className="block">
              Base URL
              <input
                className={inputClass}
                aria-label="Credential base URL"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            <label className="block">
              Declared hosts (comma separated)
              <input
                className={inputClass}
                aria-label="Declared hosts"
                value={hosts}
                onChange={(event) => setHosts(event.target.value)}
              />
            </label>
          </details>
          <p>
            Choose one registered credential per run; multiple destinations of that same
            key are allowed. Legacy HF and registered references cannot be mixed. Enter
            the exact harness model below before review.
          </p>
          <button
            className="rounded border border-slate-600 px-3 py-2 text-cyan-300 disabled:opacity-40"
            type="button"
            disabled={!ready || !selected?.enabled || !model.trim()}
            onClick={() => void requestReview()}
          >
            Review credential use
          </button>
          {review && (
            <section aria-label="Credential review" className="space-y-2">
              <p>
                {review.label} · {review.source_env} · presence: {review.presence} (not
                authentication)
              </p>
              <p>
                Model: {review.grant.allowed_models.join(", ")} · Protocol:{" "}
                {review.grant.route_api}
              </p>
              <p>Worker image: {review.grant.worker_image}</p>
              <p>
                Agent: {review.grant.agent_import_path} · Server-derived digest:{" "}
                {review.grant.recipe_digest}
              </p>
              <p>Destinations: {review.grant.destination_env.join(", ")}</p>
              <p>
                Base URL: {review.grant.base_url ?? "none"} · Declared hosts:{" "}
                {review.grant.allowed_hosts.join(", ") || "none"}
              </p>
              <pre className="max-h-64 overflow-auto">
                {JSON.stringify(review.recipe, null, 2)}
              </pre>
              <p>Review expires: {review.expires_at}. Setup success is not approval.</p>
              <label>
                <input
                  className="mr-2"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I approve this exact recipe, model, image and destinations
              </label>
              <button
                className="rounded border border-slate-600 px-3 py-2 text-cyan-300 disabled:opacity-40"
                type="button"
                disabled={
                  !ready ||
                  !confirmed ||
                  !reason.trim() ||
                  Date.now() >= Date.parse(review.expires_at)
                }
                onClick={() =>
                  void save(
                    () =>
                      approveInferenceBinding(review.ref, {
                        expected_revision: review.revision,
                        review_id: review.review_id,
                        reviewed_confirmation: true,
                        reason,
                      }),
                    "Credential use approved. Run standalone setup, then launch with the existing launch confirmation.",
                  )
                }
              >
                Approve credential use
              </button>
            </section>
          )}
          <button
            className="rounded border border-slate-600 px-3 py-2 text-cyan-300 disabled:opacity-40"
            type="button"
            disabled={busy}
            onClick={() => {
              invalidate();
              void refresh(true);
            }}
          >
            Refresh secret registry
          </button>
          {message && <p role="status">{message}</p>}
        </section>
      )}
    </section>
  );
}
