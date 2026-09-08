import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, getModelProviders, getPresets, type RunRecord } from "./api";
import { useControlState } from "./control-state";
import type { paths } from "./generated/api";
import {
  initialDraft,
  loadDraft,
  type NativeObject,
  object,
  saveDraft,
  setField,
} from "./launch-draft";
import {
  buttonClass,
  type InvalidChange,
  inputClass,
  JsonInput,
  SchemaFields,
} from "./launch-fields";

type Catalog =
  paths["/api/v1/agents"]["get"]["responses"][200]["content"]["application/json"];
type AgentEntry = Catalog["agents"][number];
type Validation =
  paths["/api/v1/runs/validate"]["post"]["responses"][200]["content"]["application/json"];
const items = (value: unknown): NativeObject[] =>
  Array.isArray(value) ? value.map(object) : [];
const identity = (value: NativeObject) => String(value.import_path ?? value.name ?? "");
const jobFields = [
  "n_attempts",
  "n_concurrent_trials",
  "timeout_multiplier",
  "agent_timeout_multiplier",
  "verifier_timeout_multiplier",
  "agent_setup_timeout_multiplier",
];

function AgentCard({
  agent,
  agentSchema,
  entries,
  onChange,
  invalid,
}: {
  agent: NativeObject;
  agentSchema: NativeObject;
  entries: AgentEntry[];
  onChange: (value: NativeObject) => void;
  invalid: InvalidChange;
}) {
  const selected = entries.find((entry) => identity(entry.config) === identity(agent));
  const kwargs = object(agent.kwargs);
  const nativeHf = String(
    agent.model_name ?? selected?.config.model_name ?? "openai/",
  ).startsWith("huggingface/");
  const prefix = nativeHf ? "huggingface/" : "openai/";
  const route =
    typeof agent.model_name === "string"
      ? agent.model_name.replace(/^(openai|huggingface)\//, "")
      : "";
  const separator = route.lastIndexOf(":");
  const model = separator >= 0 ? route.slice(0, separator) : route;
  const provider = separator >= 0 ? route.slice(separator + 1) : "";
  const [queryModel, setQueryModel] = useState(model);
  useEffect(() => {
    const timer = setTimeout(() => setQueryModel(model), 250);
    return () => clearTimeout(timer);
  }, [model]);
  const providers = useQuery({
    queryKey: ["launch-providers", queryModel],
    queryFn: () => getModelProviders(queryModel),
    enabled: queryModel.includes("/"),
  });
  const source = object(kwargs.source);
  return (
    <div className="space-y-4">
      <label className="block text-sm">
        Agent implementation
        <select
          className={inputClass}
          value={identity(agent)}
          onChange={(event) => {
            const entry = entries.find(
              (item) => identity(item.config) === event.target.value,
            );
            if (
              entry &&
              (Object.keys(kwargs).length === 0 ||
                window.confirm("Replace this agent and its options?"))
            )
              onChange(structuredClone(entry.config));
          }}
        >
          <option value="">Select an agent</option>
          {entries.map((entry) => (
            <option key={identity(entry.config)} value={identity(entry.config)}>
              {entry.label === "acp" ? "Custom Git source (ACP)" : entry.label}
            </option>
          ))}
        </select>
      </label>
      <p className="break-all text-xs text-slate-400">
        {identity(agent) || "Choose a reviewed installed implementation."}
      </p>
      <p className="break-all text-xs text-slate-400">
        Requested version or source ref:{" "}
        {String(kwargs.version ?? source.ref ?? "Not set")} · Model:{" "}
        {model || "Not set"} · Provider: {provider || "Not set"}
      </p>
      {agent.name === "acp" && (
        <fieldset className="space-y-2">
          <legend>Public Git source</legend>
          {["repo_url", "ref", "source_dir", "manifest_path"].map((key) => (
            <label className="block text-sm" key={key}>
              {key}
              <input
                className={inputClass}
                value={String(source[key] ?? "")}
                placeholder={
                  key === "source_dir"
                    ? "."
                    : key === "manifest_path"
                      ? "harbor-agent.json"
                      : key === "ref"
                        ? "Full approved commit SHA"
                        : "https://github.com/<organization>/<repository>.git"
                }
                onChange={(event) =>
                  onChange({
                    ...agent,
                    kwargs: {
                      ...kwargs,
                      source: setField(source, key, event.target.value || undefined),
                    },
                  })
                }
              />
            </label>
          ))}
          <p className="text-sm text-amber-300">
            The exact source must be approved in deployment settings. Only native ACP
            manifests are supported. A Pi extension or an arbitrary repository is not an
            ACP agent. Source code receives the inference credential, never the control
            credential.
          </p>
        </fieldset>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          HF model
          <input
            className={inputClass}
            value={model}
            placeholder="publisher/model"
            onChange={(event) =>
              onChange({ ...agent, model_name: `${prefix}${event.target.value}` })
            }
          />
        </label>
        <label className="block text-sm">
          HF provider
          <select
            className={inputClass}
            value={provider}
            disabled={queryModel !== model || providers.isPending || providers.isError}
            onChange={(event) =>
              onChange({
                ...agent,
                model_name: `${prefix}${model}${event.target.value ? `:${event.target.value}` : ""}`,
              })
            }
          >
            <option value="">Select an explicit provider</option>
            {provider && !providers.data?.providers.includes(provider) && (
              <option value={provider} disabled>
                {provider} (not verified in current mappings)
              </option>
            )}
            {providers.data?.providers.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      {providers.isError && (
        <p role="alert">
          Provider lookup failed.{" "}
          <button type="button" onClick={() => void providers.refetch()}>
            Retry
          </button>
        </p>
      )}
      {providers.isFetching && <p role="status">Checking model providers…</p>}
      {providers.data?.providers.length === 0 && (
        <p>No compatible provider mappings are available.</p>
      )}
      {selected && (
        <details>
          <summary className="cursor-pointer">Agent configuration</summary>
          <SchemaFields
            schema={selected.options_schema}
            value={kwargs}
            onChange={(value) => onChange({ ...agent, kwargs: value })}
            invalid={invalid}
            fields={Object.keys(object(selected.options_schema.properties)).filter(
              (key) =>
                !containsCredentialMaterial(undefined, key) &&
                !["source", "config", "prompt_template_path", "model_api"].includes(
                  key,
                ),
            )}
          />
          <p className="text-xs text-slate-400">
            Unset options use native defaults. File-based configuration and extension
            loading require a reviewed integration.
          </p>
        </details>
      )}
      <details>
        <summary className="cursor-pointer">Agent environment and timeouts</summary>
        <SchemaFields
          schema={agentSchema}
          value={agent}
          onChange={onChange}
          invalid={invalid}
          fields={[
            "override_timeout_sec",
            "override_setup_timeout_sec",
            "max_timeout_sec",
            "n_concurrent",
          ]}
        />
        <JsonInput
          label="Native agent fields (including kwargs, env, and timeouts)"
          value={agent}
          onChange={(value) => {
            if (!value || typeof value !== "object" || Array.isArray(value))
              throw new Error("Agent must be an object");
            onChange(object(value));
          }}
          invalid={invalid}
        />
      </details>
    </div>
  );
}

function SourceCard({
  value,
  task,
  onChange,
}: {
  value: NativeObject;
  task: boolean;
  onChange: (value: NativeObject) => void;
}) {
  const git = task ? "git_url" in value : "repo" in value;
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        Source type
        <select
          className={inputClass}
          value={git ? "git" : "package"}
          onChange={(event) => {
            if (window.confirm("Replace this source and its filters?"))
              onChange(
                event.target.value === "git"
                  ? task
                    ? { git_url: "", git_commit_id: "", path: "." }
                    : { repo: "" }
                  : { name: "", ref: "" },
              );
          }}
        >
          <option value="package">
            {task ? "Single package task" : "Package dataset"}
          </option>
          <option value="git">{task ? "Git task" : "Git dataset"}</option>
        </select>
      </label>
      {(git
        ? task
          ? ["git_url", "git_commit_id", "path"]
          : ["repo", "path"]
        : ["name", "ref"]
      ).map((key) => (
        <label key={key} className="block text-sm">
          {key}
          <input
            className={inputClass}
            value={String(value[key] ?? "")}
            placeholder={
              key === "ref"
                ? "sha256:<content hash>"
                : key === "repo"
                  ? "https://github.com/<organization>/<repository>.git@<commit>"
                  : ""
            }
            onChange={(event) =>
              onChange(
                setField(
                  value,
                  key,
                  key === "path" && event.target.value === ""
                    ? undefined
                    : event.target.value,
                ),
              )
            }
          />
        </label>
      ))}
      {!task && (
        <div className="grid gap-2 md:grid-cols-3">
          {["task_names", "exclude_task_names"].map((key) => (
            <label key={key} className="block text-sm">
              {key} (one glob per line)
              <textarea
                className={inputClass}
                value={Array.isArray(value[key]) ? value[key].join("\n") : ""}
                onChange={(event) =>
                  onChange(
                    setField(
                      value,
                      key,
                      event.target.value ? event.target.value.split("\n") : undefined,
                    ),
                  )
                }
              />
            </label>
          ))}
          <label className="block text-sm">
            n_tasks
            <input
              className={inputClass}
              type="number"
              min={1}
              value={typeof value.n_tasks === "number" ? value.n_tasks : ""}
              onChange={(event) =>
                onChange(
                  setField(
                    value,
                    "n_tasks",
                    event.target.value ? Number(event.target.value) : undefined,
                  ),
                )
              }
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function LaunchPage() {
  const navigate = useNavigate();
  const control = useControlState();
  const [draft, setDraft] = useState(loadDraft);
  const [saved, setSaved] = useState(true);
  const [ceiling, setCeiling] = useState("1");
  const [errors, setErrors] = useState<Set<string>>(new Set());
  const [validation, setValidation] = useState<Validation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  const revision = useRef(0);
  const key = useRef(crypto.randomUUID());
  const [keys, setKeys] = useState(() => ({
    datasets: items(draft.datasets).map(() => crypto.randomUUID()),
    tasks: items(draft.tasks).map(() => crypto.randomUUID()),
    agents: items(draft.agents).map(() => crypto.randomUUID()),
  }));
  const catalog = useQuery({
    queryKey: ["launch-catalog"],
    queryFn: () => api<Catalog>("/api/v1/agents"),
  });
  const presets = useQuery({ queryKey: ["presets"], queryFn: getPresets });
  const invalid: InvalidChange = useCallback((id, failed) => {
    setErrors((old) => {
      if (old.has(id) === failed) return old;
      const next = new Set(old);
      if (failed) next.add(id);
      else next.delete(id);
      return next;
    });
    if (failed) {
      revision.current++;
      setValidation(null);
    }
  }, []);
  const change = (value: NativeObject) => {
    revision.current++;
    key.current = crypto.randomUUID();
    setValidation(null);
    setError(null);
    setDraft(value);
  };
  const replace = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("JobConfig must be an object");
    const next = object(value);
    change(next);
    setKeys({
      datasets: items(next.datasets).map(() => crypto.randomUUID()),
      tasks: items(next.tasks).map(() => crypto.randomUUID()),
      agents: items(next.agents).map(() => crypto.randomUUID()),
    });
  };
  useEffect(() => {
    setSaved(saveDraft(draft));
  }, [draft]);
  const updateCard = (
    field: "datasets" | "tasks" | "agents",
    index: number,
    value: NativeObject,
  ) =>
    change({
      ...draft,
      [field]: items(draft[field]).map((item, i) => (i === index ? value : item)),
    });
  const add = (field: "datasets" | "tasks" | "agents", value: NativeObject) => {
    change({ ...draft, [field]: [...items(draft[field]), value] });
    setKeys((old) => ({ ...old, [field]: [...old[field], crypto.randomUUID()] }));
  };
  const remove = (field: "datasets" | "tasks" | "agents", index: number) => {
    change({ ...draft, [field]: items(draft[field]).filter((_, i) => i !== index) });
    setKeys((old) => ({ ...old, [field]: old[field].filter((_, i) => i !== index) }));
  };
  const secret = containsCredentialMaterial(draft);
  const blocked =
    pending ||
    errors.size > 0 ||
    secret ||
    !catalog.data ||
    !Number.isFinite(Number(ceiling)) ||
    Number(ceiling) <= 0 ||
    Number(ceiling) > 10000;
  const validate = async () => {
    const current = revision.current;
    setPending(true);
    setError(null);
    setValidation(null);
    try {
      const result = await api<Validation>("/api/v1/runs/validate", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      if (revision.current === current) setValidation(result);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Validation failed");
    } finally {
      setPending(false);
    }
  };
  const launch = async () => {
    if (!validation) return;
    setPending(true);
    setError(null);
    try {
      const result = await api<{ run: RunRecord }>("/api/v1/runs/config", {
        method: "POST",
        headers: {
          "Idempotency-Key": key.current,
          "X-Harbor-Hf-Cost-Ceiling-Usd-Per-Trial": ceiling,
          "X-Harbor-Hf-Validation": validation.fingerprint,
        },
        body: JSON.stringify(draft),
      });
      navigate(`/runs/${encodeURIComponent(result.run.run_id)}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Launch failed");
      setValidation(null);
    } finally {
      setPending(false);
    }
  };
  const environment = object(draft.environment);
  const envKwargs = object(environment.kwargs);
  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      <Link to="/runs" className="text-sky-400">
        ← Runs
      </Link>
      <h1 className="text-2xl font-semibold">New Job</h1>
      <p className="text-sm text-slate-400">
        Native Harbor configuration on Hugging Face. Diagnostic runs only; use reviewed
        presets for final leaderboard submissions.
      </p>
      <p>
        Access: {control.actor.role}. Write mode: {control.writeMode}.
      </p>
      {!saved && (
        <p role="status">
          The draft was not saved. Storage is unavailable, the draft is too large, or it
          contains credential material.
        </p>
      )}
      {secret && (
        <p role="alert">
          Remove credential material before saving, validating, or launching.
        </p>
      )}
      {catalog.isError && (
        <p role="alert">
          Native agent catalog unavailable.{" "}
          <button onClick={() => void catalog.refetch()} type="button">
            Retry
          </button>
        </p>
      )}
      <fieldset disabled={pending} className="space-y-6">
        <section className="rounded border border-slate-800 p-5 space-y-4">
          <h2 className="text-xl">Starting preset</h2>
          <label className="block text-sm">
            Benchmark preset
            <select
              className={inputClass}
              defaultValue=""
              onChange={(event) => {
                const preset = presets.data?.benchmarks[Number(event.target.value)];
                if (
                  preset &&
                  window.confirm(
                    "Replace sources and job settings with this preset? Agents are kept.",
                  )
                )
                  replace({ ...preset.job, agents: draft.agents ?? [] });
              }}
            >
              <option value="" disabled>
                Choose a starting point
              </option>
              {presets.data?.benchmarks.map((preset, index) => (
                <option key={`${preset.benchmark}/${preset.preset}`} value={index}>
                  {preset.benchmark} / {preset.preset}
                </option>
              ))}
            </select>
          </label>
          <button
            className={buttonClass}
            type="button"
            onClick={() => {
              if (window.confirm("Clear the draft?")) replace(initialDraft());
            }}
          >
            Clear draft
          </button>
        </section>
        <section className="rounded border border-slate-800 p-5 space-y-4">
          <h2 className="text-xl">Sources</h2>
          <p className="text-sm text-slate-400">
            Enter exact source references. Package refs must be immutable content
            hashes; Git refs must be full commits. Source autocomplete is unavailable.
            HF tasks need prebuilt images.
          </p>
          {(["datasets", "tasks"] as const).flatMap((field) =>
            items(draft[field]).map((value, index) => (
              <article
                key={keys[field][index]}
                className="space-y-3 rounded border border-slate-700 p-4"
              >
                <h3>
                  {field === "tasks" ? "Task" : "Dataset"} {index + 1}
                </h3>
                <SourceCard
                  value={value}
                  task={field === "tasks"}
                  onChange={(next) => updateCard(field, index, next)}
                />
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => remove(field, index)}
                >
                  Remove source
                </button>
              </article>
            )),
          )}
          <div className="flex gap-2">
            <button
              className={buttonClass}
              type="button"
              onClick={() => add("datasets", { name: "", ref: "" })}
            >
              Add dataset
            </button>
            <button
              className={buttonClass}
              type="button"
              onClick={() => add("tasks", { name: "", ref: "" })}
            >
              Add task
            </button>
          </div>
        </section>
        <section className="rounded border border-slate-800 p-5 space-y-4">
          <h2 className="text-xl">Agents</h2>
          {items(draft.agents).map((agent, index) => (
            <article
              key={keys.agents[index]}
              className="space-y-3 rounded border border-slate-700 p-4"
            >
              <h3>Agent {index + 1}</h3>
              <AgentCard
                agent={agent}
                agentSchema={{
                  ...object(object(catalog.data?.job_schema.$defs).AgentConfig),
                  $defs: catalog.data?.job_schema.$defs,
                }}
                entries={catalog.data?.agents ?? []}
                invalid={invalid}
                onChange={(value) => updateCard("agents", index, value)}
              />
              <button
                className={buttonClass}
                type="button"
                onClick={() => remove("agents", index)}
              >
                Remove agent
              </button>
            </article>
          ))}
          <button
            className={buttonClass}
            type="button"
            onClick={() => add("agents", {})}
          >
            Add agent
          </button>
        </section>
        <section className="rounded border border-slate-800 p-5 space-y-4">
          <h2 className="text-xl">Credentials</h2>
          <p>
            Credentials are operator-managed. Do not enter tokens here. The sandbox
            agent receives only the inference credential. Validate checks configured
            credential availability, not authentication or inference.
          </p>
          <h2 className="text-xl">Job settings</h2>
          {catalog.data && (
            <SchemaFields
              schema={catalog.data.job_schema}
              value={draft}
              onChange={change}
              invalid={invalid}
              fields={jobFields}
            />
          )}
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">
              Sandbox flavor
              <select
                className={inputClass}
                value={String(envKwargs.flavor ?? "cpu-basic")}
                onChange={(event) =>
                  change({
                    ...draft,
                    environment: {
                      ...environment,
                      type: "hf-sandbox",
                      kwargs: { ...envKwargs, flavor: event.target.value },
                    },
                  })
                }
              >
                <option value="cpu-basic">CPU Basic</option>
                <option value="cpu-upgrade">CPU Upgrade</option>
              </select>
            </label>
            <label className="text-sm">
              Sandbox idle timeout
              <input
                className={inputClass}
                value={String(envKwargs.job_timeout ?? "30m")}
                onChange={(event) =>
                  change({
                    ...draft,
                    environment: {
                      ...environment,
                      type: "hf-sandbox",
                      kwargs: { ...envKwargs, job_timeout: event.target.value },
                    },
                  })
                }
              />
            </label>
            <label className="text-sm">
              Post-trial cost limit (USD)
              <input
                className={inputClass}
                type="number"
                min="0.01"
                max="10000"
                step="any"
                value={ceiling}
                onChange={(event) => {
                  setCeiling(event.target.value);
                  revision.current++;
                  key.current = crypto.randomUUID();
                  setValidation(null);
                }}
              />
            </label>
          </div>
          <p className="text-sm text-amber-300">
            This is not a strict spending ceiling. In-flight trials, retries, and HF
            infrastructure can add cost before a stop. Cost and ETA estimates are
            unavailable.
          </p>
        </section>
        <section className="rounded border border-slate-800 p-5 space-y-4">
          <h2 className="text-xl">Advanced</h2>
          <p className="text-sm text-slate-400">
            Image builds, hardware resource overrides, and enforced network allowlists
            are unavailable. Nonsecret env keys: LANG, LC_ALL, TZ, NO_COLOR, TERM.
            Native JSON retains fields not shown by this form.
          </p>
          {catalog.data && (
            <SchemaFields
              schema={catalog.data.job_schema}
              value={draft}
              onChange={change}
              invalid={invalid}
              fields={["extra_instructions"]}
            />
          )}
          {catalog.data &&
            (["retry", "verifier"] as const).map((field) => (
              <details key={field}>
                <summary>{field === "retry" ? "Retry policy" : "Verifier"}</summary>
                <SchemaFields
                  schema={{
                    ...object(
                      object(catalog.data.job_schema.$defs)[
                        field === "retry" ? "RetryConfig" : "VerifierConfig"
                      ],
                    ),
                    $defs: catalog.data.job_schema.$defs,
                  }}
                  value={object(draft[field])}
                  onChange={(value) => change({ ...draft, [field]: value })}
                  invalid={invalid}
                />
              </details>
            ))}
          <details>
            <summary>Environment</summary>
            <JsonInput
              label="Native environment"
              value={draft.environment}
              onChange={(value) => change({ ...draft, environment: value })}
              invalid={invalid}
            />
          </details>
          <details>
            <summary>Native JobConfig JSON</summary>
            <JsonInput
              label="JobConfig JSON"
              value={draft}
              onChange={replace}
              invalid={invalid}
              rows={24}
            />
          </details>
        </section>
      </fieldset>
      {error && (
        <p
          ref={errorRef}
          tabIndex={-1}
          role="alert"
          className="whitespace-pre-wrap text-red-400"
        >
          {error}
        </p>
      )}
      {validation && (
        <section
          className="rounded border border-sky-800 p-5 space-y-2"
          aria-live="polite"
        >
          <h2 className="text-xl">Validated configuration</h2>
          <p>
            {validation.tasks} resolved tasks · {validation.agents} agents ·{" "}
            {validation.trials} trials
          </p>
          <p>
            Harbor revision:{" "}
            <code className="break-all">{validation.harbor_revision}</code>
          </p>
          <p>
            Separate credentials:{" "}
            {validation.credentials_available
              ? "configured"
              : "missing; launch blocked"}
          </p>
          {validation.warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <p>Not performed: {validation.not_performed.join(", ")}.</p>
          <details>
            <summary>
              Effective native configuration (managed output path is a preview)
            </summary>
            <pre className="overflow-auto text-xs">
              {JSON.stringify(validation.effective_config, null, 2)}
            </pre>
          </details>
        </section>
      )}
      <div className="flex gap-3">
        <button
          className={buttonClass}
          type="button"
          disabled={blocked || control.actor.role !== "operator"}
          onClick={() => void validate()}
        >
          {pending ? "Working…" : "Validate"}
        </button>
        <button
          className={`${buttonClass} bg-sky-800`}
          type="button"
          disabled={
            blocked ||
            !validation?.credentials_available ||
            control.actor.role !== "operator" ||
            control.writeMode !== "enabled"
          }
          onClick={() => void launch()}
        >
          Launch
        </button>
      </div>
    </div>
  );
}
