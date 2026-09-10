import type { InferenceBindingsV1 } from "@harbor-hf/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { getInferenceBindings } from "./api";

export function InferenceBindingSelector({
  value,
  operator,
  onChange,
  discovery: sharedDiscovery,
}: {
  discovery?: InferenceBindingsV1 | null;
  value: string | undefined;
  operator: boolean;
  onChange(value: string | undefined): void;
}) {
  const [discovery, setDiscovery] = useState<InferenceBindingsV1 | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const current = ++request.current;
    setDiscovery(null);
    setFailed(false);
    if (operator && sharedDiscovery === undefined)
      void getInferenceBindings()
        .then((result) => {
          if (current === request.current) setDiscovery(result);
        })
        .catch(() => {
          if (current === request.current) setFailed(true);
        });
  }, [operator, sharedDiscovery]);
  useEffect(() => {
    refresh();
    return () => {
      ++request.current;
    };
  }, [refresh]);
  const currentDiscovery = sharedDiscovery === undefined ? discovery : sharedDiscovery;
  const bindings = operator ? (currentDiscovery?.bindings ?? []) : [];
  return (
    <div className="space-y-1 text-xs text-slate-400">
      <select
        aria-label="Inference credential reference"
        className="w-full rounded border border-slate-700 bg-slate-950 p-2"
        value={value ?? ""}
        disabled={!operator}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">Existing HF inference binding (legacy)</option>
        {value && !bindings.some((binding) => binding.ref === value) ? (
          <option value={value} disabled>
            Selected reference unavailable
          </option>
        ) : null}
        {bindings.map((binding) => (
          <option
            key={binding.ref}
            value={binding.ref}
            disabled={binding.status === "disabled"}
          >
            Registered: {binding.label} · {binding.status}
          </option>
        ))}
      </select>
      <p>
        {failed || sharedDiscovery === null
          ? "Availability unavailable (not missing)."
          : currentDiscovery && !bindings.length
            ? "No registered provider references available."
            : "Presence only; not API validity, quota or compatibility."}
      </p>
      <p>
        Set the destination name required by the harness. Setup success grants no
        credential access.
      </p>
      {operator && sharedDiscovery === undefined ? (
        <button type="button" className="underline" onClick={refresh}>
          Refresh availability
        </button>
      ) : null}
    </div>
  );
}
