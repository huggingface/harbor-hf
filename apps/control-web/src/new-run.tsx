import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  type BenchmarkConfig,
  getBenchmarkConfigs,
  listSavedConfigurations,
  listWorkbenchSetups,
  previewWorkbenchRecipe,
  type SavedConfiguration,
  submitRun,
  type WorkbenchPreview,
  type WorkbenchSetup,
} from "./api";
import { useControlState } from "./control-state";
import { profileLabel } from "./launch";
import { formatMoney } from "./lib";
import {
  approvedProfile,
  builtinRouteAvailable,
  matchingConfigurations,
  matchingSetup,
} from "./new-run-selection";
import { clearPendingRun, pendingRunId } from "./pending-run";
import { useAllProfiles } from "./queries";
import { Button, Card, ErrorNotice } from "./ui";

const field =
  "w-full min-w-0 rounded-md border border-slate-700 bg-slate-950 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400";

export function NewRunPanel({
  onClose,
  initialHarness,
}: {
  onClose(): void;
  initialHarness?: string;
}) {
  const navigate = useNavigate();
  const profiles = useAllProfiles();
  const { actor, writesAllowed, writeMode } = useControlState();
  const [configs, setConfigs] = useState<BenchmarkConfig[]>([]);
  const [saved, setSaved] = useState<SavedConfiguration[]>([]);
  const [benchmark, setBenchmark] = useState("");
  const [harness, setHarness] = useState(
    initialHarness ? `builtin:${initialHarness}` : "",
  );
  const [model, setModel] = useState("");
  const [route, setRoute] = useState("");
  const [ceiling, setCeiling] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [evidence, setEvidence] = useState<{
    revision: string;
    preview: WorkbenchPreview;
    setup: WorkbenchSetup | undefined;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const items = profiles.data?.items ?? [];
  const selectedSaved = saved.find((item) => harness === `saved:${item.revision}`);
  const choices = matchingConfigurations(configs, items, benchmark, model);
  const config = choices.find((item) => item.revision === route);
  const builtin = harness.startsWith("builtin:") ? harness.slice(8) : "";
  const currentEvidence =
    evidence?.revision === selectedSaved?.revision ? evidence : null;
  const selectedBuiltin = approvedProfile(items, "harness", builtin);
  const deployment = config
    ? approvedProfile(items, "deployment", config.deployment)
    : undefined;
  const confirmationKey = config
    ? JSON.stringify([
        config,
        harness,
        model,
        ceiling,
        currentEvidence?.preview.revision_id,
        currentEvidence?.setup?.setup_test_id,
        items.map((item) => [item.profile_id, item.approved_aliases]),
      ])
    : null;
  const blocker = !config
    ? "Choose a reviewed configuration. If your model is not listed, ask an administrator to review its route, pricing, and approvals. Arbitrary model routing and subsets are not supported."
    : !harness
      ? "Select a built-in harness or an exact saved version."
      : selectedSaved
        ? checking
          ? "Checking exact-version setup evidence…"
          : !currentEvidence?.setup
            ? "This saved version needs a passed setup test for the current compiler. Load and test this exact version in Workbench, then reopen New Run. Saving is not execution approval."
            : null
        : !builtinRouteAvailable(config, items, builtin)
          ? "No approved built-in harness route exists in this reviewed configuration. Choose another configuration or ask an administrator to review the combination."
          : null;
  const canLaunch =
    writesAllowed &&
    !profiles.error &&
    !blocker &&
    ceiling > 0 &&
    Number.isSafeInteger(ceiling) &&
    config !== undefined &&
    ceiling <= config.max_ceiling_microusd;

  useEffect(() => {
    let active = true;
    void Promise.all([getBenchmarkConfigs(), listSavedConfigurations()])
      .then(([catalog, library]) => {
        if (!active) return;
        setConfigs(catalog.items);
        setSaved(library.items);
      })
      .catch((error) => {
        if (active) setError(error);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setEvidence(null);
    setConfirmed(null);
    if (!selectedSaved) return;
    setChecking(true);
    void Promise.all([
      previewWorkbenchRecipe(selectedSaved.recipe),
      listWorkbenchSetups(),
    ])
      .then(([preview, setups]) => {
        if (!active) return;
        if (preview.recipe_digest !== selectedSaved.revision)
          throw new Error(
            "Saved version does not match the current compiler preview. Save a new version explicitly; this version will not be reinterpreted.",
          );
        setEvidence({
          revision: selectedSaved.revision,
          preview,
          setup: matchingSetup(preview, setups),
        });
      })
      .catch((error) => {
        if (active) setError(error);
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [selectedSaved]);

  useEffect(() => {
    setConfirmed((current) => (current === confirmationKey ? current : null));
  }, [confirmationKey]);

  function changeSelection() {
    setConfirmed(null);
    setError(null);
  }
  async function launch() {
    if (!canLaunch || !config || !confirmationKey || confirmed !== confirmationKey)
      return;
    setBusy(true);
    setError(null);
    try {
      if (pending.current?.key !== confirmationKey)
        pending.current = {
          key: confirmationKey,
          id: pendingRunId(actor.username, confirmationKey),
        };
      const input =
        selectedSaved && currentEvidence?.setup
          ? {
              benchmark_config: config.name,
              benchmark_config_revision: config.revision,
              harness: {
                type: "workbench" as const,
                recipe: selectedSaved.recipe,
                setup_test_id: currentEvidence.setup.setup_test_id,
              },
              ceiling_microusd: ceiling,
              confirmed: true,
            }
          : {
              benchmark: config.benchmark,
              model: config.model,
              harness: builtin,
              deployment: config.deployment,
              launch_policy: config.launch_policy,
              ceiling_microusd: ceiling,
              confirmed: true,
            };
      const result = await submitRun(input, pending.current.id);
      clearPendingRun(actor.username);
      pending.current = null;
      navigate(result.status_url.replace(/^\/api\/v1/, ""));
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">New Run</h2>
          <p className="mt-2 text-sm text-slate-400">
            Select a supported workload, harness, and model, then review the cost
            ceiling. Nothing creates a provider or deployment automatically.
          </p>
        </div>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="mt-5 grid min-w-0 gap-4 md:grid-cols-2">
        <label className="min-w-0 text-sm">
          Benchmark
          <select
            aria-label="Benchmark"
            className={field}
            value={benchmark}
            onChange={(event) => {
              setBenchmark(event.target.value);
              setRoute("");
              changeSelection();
            }}
          >
            <option value="">Select a supported benchmark / subset</option>
            {[...new Set(configs.map((item) => item.benchmark))].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-sm">
          Harness
          <select
            aria-label="Harness"
            className={field}
            value={harness}
            onChange={(event) => {
              setHarness(event.target.value);
              changeSelection();
            }}
          >
            <option value="">Select a harness version</option>
            <optgroup label="Built-in approved profiles">
              {items
                .filter((item) => item.profile_kind === "harness")
                .flatMap((item) =>
                  item.approved_aliases.map((alias) => (
                    <option key={alias} value={`builtin:${alias}`}>
                      {profileLabel("harness", alias, item.spec)} ·{" "}
                      {item.profile_id.slice(7, 15)}
                    </option>
                  )),
                )}
            </optgroup>
            <optgroup label="Your saved versions (not execution approval)">
              {saved.map((item) => (
                <option key={item.revision} value={`saved:${item.revision}`}>
                  {item.recipe.name} · {item.revision.slice(7, 15)}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="min-w-0 text-sm">
          Model
          <input
            aria-label="Model"
            className={field}
            list="reviewed-models"
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              setRoute("");
              changeSelection();
            }}
            placeholder="Enter the exact model string"
          />
          <datalist id="reviewed-models">
            {[
              ...new Set(
                configs
                  .filter((item) => item.benchmark === benchmark)
                  .flatMap((item) => {
                    const value = approvedProfile(items, "model", item.model)?.spec
                      .model_id;
                    return typeof value === "string" ? [value] : [];
                  }),
              ),
            ].map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label className="min-w-0 text-sm">
          Reviewed configuration
          <select
            aria-label="Reviewed configuration"
            className={field}
            value={route}
            onChange={(event) => {
              setRoute(event.target.value);
              const next = choices.find((item) => item.revision === event.target.value);
              setCeiling(next?.default_ceiling_microusd ?? 0);
              changeSelection();
            }}
          >
            <option value="">Select the exact reviewed route</option>
            {choices.map((item) => (
              <option key={item.revision} value={item.revision}>
                {item.label} · {item.size} · {item.task_count} tasks
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-sm">
          Cost ceiling, USD
          <input
            aria-label="Cost ceiling, USD"
            className={field}
            type="number"
            min="0"
            step="0.01"
            value={ceiling / 1_000_000}
            onChange={(event) => {
              setCeiling(Math.round(Number(event.target.value) * 1_000_000));
              changeSelection();
            }}
          />
        </label>
      </div>
      <p className="mt-3 text-sm text-slate-400">
        Only reviewed task selections are available. Size is workload guidance, not a
        price guarantee.{" "}
        <Link className="text-cyan-300 underline" to="/workbench">
          Configure, test, or save a harness in Workbench
        </Link>
        .
      </p>
      {selectedSaved ? (
        <p className="mt-3 text-sm">
          Saved: {selectedSaved.recipe.name} · {selectedSaved.revision.slice(7, 15)}
          <br />
          Tested:{" "}
          {currentEvidence?.setup ? "exact recipe and compiler passed" : "not verified"}
          . Compatible: checked at admission. Reviewed: configuration only; this saved
          harness is not globally approved.
        </p>
      ) : null}
      {config ? (
        <>
          <details className="mt-4 rounded-lg border border-slate-800 p-3">
            <summary className="cursor-pointer">
              Advanced · reviewed execution configuration
            </summary>
            <dl className="mt-3 grid gap-2 break-all text-sm">
              <dt>Provider</dt>
              <dd>{String(deployment?.spec.inference_provider ?? "Not reported")}</dd>
              <dt>Deployment</dt>
              <dd>{config.deployment}</dd>
              <dt>Launch policy</dt>
              <dd>{config.launch_policy}</dd>
              <dt>Configuration revision</dt>
              <dd>{config.revision}</dd>
              <dt>Harness version</dt>
              <dd>{selectedSaved?.revision ?? selectedBuiltin?.profile_id}</dd>
            </dl>
            <Link to="/profiles" className="text-cyan-300 underline">
              Configuration registry
            </Link>
          </details>
          <div className="mt-4 rounded-lg border border-slate-800 p-4">
            <h3 className="font-medium">Review</h3>
            <p className="mt-2 text-sm">
              {config.task_count} tasks · {config.size} · {config.publication_role}
              <br />
              Model: {model}
              <br />
              Harness:{" "}
              {selectedSaved?.recipe.name ??
                profileLabel("harness", builtin, selectedBuiltin?.spec ?? {})}
              <br />
              Ceiling: {formatMoney(ceiling)} · Maximum:{" "}
              {formatMoney(config.max_ceiling_microusd)}
            </p>
            <p className="mt-2 text-sm text-slate-400">
              Server admission rechecks current approvals, route compatibility, pricing,
              setup attestation, and budget. A setup pass is not an inference test or
              execution approval.
            </p>
          </div>
        </>
      ) : null}
      {blocker ? (
        <p role="status" className="mt-4 text-sm text-amber-200">
          {blocker}
        </p>
      ) : null}
      {!writesAllowed ? (
        <p className="mt-4 text-sm text-amber-200">
          Launch unavailable: write mode is {writeMode}; role permissions still apply.
        </p>
      ) : null}
      {error || profiles.error ? <ErrorNotice error={error ?? profiles.error} /> : null}
      <label className="mt-5 flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 accent-cyan-400"
          disabled={!canLaunch || busy}
          checked={confirmationKey !== null && confirmed === confirmationKey}
          onChange={(event) =>
            setConfirmed(event.target.checked ? confirmationKey : null)
          }
        />
        I confirm this exact harness version, reviewed configuration, model, task count,
        and cost ceiling.
      </label>
      <Button
        className="mt-4"
        disabled={!canLaunch || busy || confirmed !== confirmationKey}
        onClick={() => void launch()}
      >
        {busy ? "Submitting…" : "Start run"}
      </Button>
    </Card>
  );
}
