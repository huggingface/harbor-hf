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

// Compare server metadata without depending on JSON object property order.
function sameMetadata(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = Object.entries(left);
  const b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        sameMetadata(value, (right as Record<string, unknown>)[key]),
    )
  );
}

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
  const [reviewContext, setReviewContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [message, setMessage] = useState("");
  const epoch = useRef(0);
  const latest = useRef("");
  const fingerprint = JSON.stringify([recipe, model, context, baseUrl, hosts]);
  const [previewMessage, setPreviewMessage] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const invalidate = useCallback(() => {
    ++epoch.current;
    setReview(null);
    setReviewContext("");
    setPreviewMessage("");
    setPreviewing(false);
  }, []);
  useEffect(() => {
    void fingerprint;
    invalidate();
  }, [fingerprint, invalidate]);
  const registryIdentity = useRef<InferenceBindingsV1 | null>(null);
  const reads = useRef(0);
  const refresh = useCallback(
    async (explicit = false) => {
      const request = ++reads.current;
      try {
        const result = await getInferenceBindings();
        if (request !== reads.current) return;
        if (!sameMetadata(result, registryIdentity.current)) {
          invalidate();
          registryIdentity.current = result;
        }
        setRegistry((previous) => (sameMetadata(previous, result) ? previous : result));
        onDiscovery(result);
        if (explicit) {
          setBlocked(false);
          setMessage("Registry refreshed. Inspect current state before saving again.");
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
            ? "Request rejected. Check the name and connection settings, then refresh before trying again."
            : "Save not confirmed; it may have succeeded. Refresh and inspect current state before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  // Reviews allocate retained server tickets: request only on explicit action.
  const identity = JSON.stringify(registry);
  const scope = JSON.stringify([fingerprint, identity]);
  latest.current = scope;
  const currentReview = !blocked && reviewContext === scope ? review : null;
  const bindingSaved =
    currentReview &&
    selected?.enabled &&
    selected.grants.some((grant) => sameMetadata(grant, currentReview.grant));
  async function previewBinding() {
    if (!ready || previewing || !registry || !selected?.enabled || !model.trim())
      return;
    if (currentReview && Date.now() < Date.parse(currentReview.expires_at)) return;
    invalidate();
    setPreviewing(true);
    const current = ++epoch.current;
    const input = scope;
    try {
      await reviewInferenceBinding(selected.ref, {
        expected_revision: registry.revision,
        recipe,
        model_name: model,
        base_url: baseUrl.trim() || null,
        allowed_hosts: hosts
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      })
        .then((result) => {
          if (current !== epoch.current || input !== latest.current) return;
          // The full server-normalized recipe and image are displayed before consent.
          if (
            result.ref !== selected.ref ||
            result.revision !== registry.revision ||
            result.source_env !== selected.source_env ||
            !sameMetadata(result.recipe, recipe) ||
            !sameMetadata(result.grant.allowed_models, [model]) ||
            result.grant.route_api !== recipe.route_api ||
            !sameMetadata(
              result.grant.destination_env,
              recipe.environment
                .filter((row) => row.source === "model_api_key")
                .map((row) => row.name)
                .sort(),
            ) ||
            result.grant.base_url !== (baseUrl.trim() || null) ||
            !sameMetadata(
              result.grant.allowed_hosts,
              hosts
                .split(",")
                .map((host) => host.trim())
                .filter(Boolean),
            )
          ) {
            setPreviewMessage(
              "Binding preview did not match the selection. Check the scope and preview again.",
            );
            return;
          }
          setReview(result);
          setReviewContext(input);
        })
        .catch(() => {
          if (current !== epoch.current || input !== latest.current) return;
          setPreviewMessage(
            "Binding preview unavailable or stale. Correct the scope or refresh the registry, then preview again.",
          );
        });
    } finally {
      if (current === epoch.current) setPreviewing(false);
    }
  }
  const auditReason =
    "Save binding: use the displayed source for this exact recipe, model, worker image and destinations.";
  function saveBinding() {
    if (!ready || !currentReview || bindingSaved) return;
    if (
      !Number.isFinite(Date.parse(currentReview.expires_at)) ||
      Date.now() >= Date.parse(currentReview.expires_at)
    ) {
      invalidate();
      setPreviewMessage(
        "Binding preview expired. Preview again before saving; nothing was retried.",
      );
      return;
    }
    void save(
      () =>
        approveInferenceBinding(currentReview.ref, {
          expected_revision: currentReview.revision,
          review_id: currentReview.review_id,
          reviewed_confirmation: true,
          reason: auditReason,
        }),
      "Binding saved for the submitted scope. Preview to check the current form against the registry.",
    );
  }
  const inputClass =
    "mt-1 block w-full rounded border border-slate-700 bg-slate-950 p-2 text-slate-100";
  return (
    <section className="my-3 min-w-0 max-w-full space-y-3 rounded border border-slate-700 p-3 text-sm [overflow-wrap:anywhere]">
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
            Friendly label (optional)
            <input
              className={inputClass}
              aria-label="Friendly label"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <button
            className="rounded border border-slate-600 px-3 py-2 text-cyan-300 disabled:opacity-40"
            type="button"
            disabled={!ready || !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name)}
            onClick={() =>
              registry &&
              void save(
                () =>
                  registerInferenceBinding({
                    expected_revision: registry.revision,
                    source_env: name,
                    label: label.trim() || "Inference secret",
                    reason:
                      "Register existing Space secret name for explicit binding selection.",
                  }),
                "Reference registered. Select it in a Secret environment binding.",
              )
            }
          >
            Register secret name
          </button>
          <p>
            Control and infrastructure names are reserved and rejected by the server.
            Ownership is enforced by the server.
          </p>
          <details>
            <summary>Advanced reference controls</summary>
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
                        "Reference status saved. Check binding status before saving.",
                      )
                    }
                  >
                    {binding.enabled ? "Disable" : "Re-enable"} {binding.label}
                  </button>
                </li>
              ))}
            </ul>
          </details>
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
            Select one registered secret in the environment rows and enter the exact
            harness model. Multiple destinations for the same secret are allowed;
            registered and legacy HF bindings cannot be mixed.
          </p>
          <p role="status">
            {bindingSaved
              ? "Binding saved for this scope."
              : currentReview
                ? "Binding needs saving."
                : blocked
                  ? "Binding status unverified. Refresh before continuing."
                  : selected?.enabled && model.trim()
                    ? previewing
                      ? "Checking binding scope…"
                      : "Preview the exact binding scope before saving."
                    : "Select a registered secret and exact model to check binding status."}
          </p>
          <button
            className="rounded border border-slate-600 px-3 py-2 text-cyan-300 disabled:opacity-40"
            type="button"
            disabled={!ready || previewing || !selected?.enabled || !model.trim()}
            onClick={() => void previewBinding()}
          >
            Preview binding scope
          </button>
          {currentReview && (
            <section aria-label="Binding scope" className="space-y-2">
              <p>
                {currentReview.source_env} →{" "}
                {currentReview.grant.destination_env.join(", ")}
                {" · "}presence: {currentReview.presence} (not authentication)
              </p>
              <p>
                Model: {currentReview.grant.allowed_models.join(", ")} · Route:{" "}
                {currentReview.grant.route_api}
              </p>
              <p>Worker image: {currentReview.grant.worker_image}</p>
              <p>Agent: {currentReview.grant.agent_import_path}</p>
              <p>Recipe digest: {currentReview.grant.recipe_digest}</p>
              <p>
                Base URL: {currentReview.grant.base_url ?? "none"} · Declared hosts:{" "}
                {currentReview.grant.allowed_hosts.join(", ") || "none"}
              </p>
              <details>
                <summary>Exact recipe scope</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                  {JSON.stringify(currentReview.recipe, null, 2)}
                </pre>
              </details>
              <p>{auditReason}</p>
              <p>
                Preview expires: {currentReview.expires_at}. No secret values are read
                or sent by this action.
              </p>
            </section>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              className="rounded border border-slate-600 px-3 py-2 text-cyan-300 disabled:opacity-40"
              type="button"
              disabled={!ready || !currentReview || !!bindingSaved}
              onClick={saveBinding}
            >
              Save binding
            </button>
            <button
              className="rounded border border-slate-600 px-3 py-2 text-cyan-300 disabled:opacity-40"
              type="button"
              disabled={busy}
              onClick={() => {
                void refresh(true);
              }}
            >
              Refresh secret registry
            </button>
          </div>
          {previewMessage && <p role="alert">{previewMessage}</p>}
          {message && <p role="alert">{message}</p>}
        </section>
      )}
    </section>
  );
}
