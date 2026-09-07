import { useEffect, useState } from "react";
import {
  api,
  getModelProviders,
  getPresets,
  listSavedConfigurations,
  type PresetsResponse,
  type SavedConfiguration,
} from "./api";

interface Job {
  id: string;
  stage: string;
  url: string;
  run_id: string | null;
  mode?: string | null;
}
interface Approval {
  approval_sha256: string;
  run_id: string;
  results_bucket: string;
  submission: unknown;
  total_budget_usd: number;
  inference_limit_usd: number;
  runtime_seconds: number;
  job_timeout_seconds: number;
  expires_at: string;
  mode?: "setup" | "benchmark";
  setup_test_run_id?: string;
}

export function PersonalPage({
  initialSelection,
}: {
  initialSelection?: { revision: string; mode: "setup" | "benchmark" };
} = {}) {
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState("");
  const [catalog, setCatalog] = useState<PresetsResponse | null>(null);
  const [benchmark, setBenchmark] = useState("terminal-bench-2-1/two-task-canary");
  const [agent, setAgent] = useState(() => {
    if (initialSelection) return `workbench/${initialSelection.revision}`;
    const revision = new URLSearchParams(window.location.search).get("workbench");
    return revision ? `workbench/${revision}` : "";
  });
  const [saved, setSaved] = useState<SavedConfiguration[]>([]);
  const [mode, setMode] = useState<"setup" | "benchmark">(() =>
    initialSelection
      ? initialSelection.mode
      : new URLSearchParams(window.location.search).get("mode") === "setup"
        ? "setup"
        : "benchmark",
  );
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [providers, setProviders] = useState<string[]>([]);
  const [reasoning, setReasoning] = useState("default");
  const [ceiling, setCeiling] = useState("1");
  const [bucket, setBucket] = useState("");
  const [buckets, setBuckets] = useState<Array<{ name: string }>>([]);
  const [runId, setRunId] = useState(
    () => `run-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
  );
  const [jobs, setJobs] = useState<Job[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [files, setFiles] = useState<Array<{ path: string; size: number }>>([]);
  const [output, setOutput] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [consent, setConsent] = useState(false);
  const selectedAgent = catalog?.agents.find(
    (item) => `${item.agent}/${item.version}` === agent,
  );
  const selectedSaved = saved.find((item) => `workbench/${item.revision}` === agent);
  useEffect(() => {
    void getPresets()
      .then((value) => {
        setCatalog(value);
        if (
          !value.benchmarks.some(
            (item) =>
              `${item.benchmark}/${item.preset}` ===
              "terminal-bench-2-1/two-task-canary",
          )
        ) {
          const first = value.benchmarks[0];
          setBenchmark(first ? `${first.benchmark}/${first.preset}` : "");
        }
      })
      .catch(() => setMessage("Catalog unavailable."));
    void listSavedConfigurations()
      .then((value) => setSaved(value.items))
      .catch(() => setMessage("Saved Workbench configurations are unavailable."));
  }, []);

  async function request<T>(action: string, body: unknown = {}): Promise<T> {
    return api(`/api/v1/personal/${action}`, {
      method: "POST",
      ...(action === "preview" || !token
        ? {}
        : { headers: { "X-HF-User-Token": token } }),
      body: JSON.stringify(body),
    });
  }
  async function perform(operation: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }
  async function refreshJobs() {
    setJobs((await request<{ jobs: Job[] }>("jobs")).jobs);
  }
  const field = "block w-full rounded border border-slate-600 bg-slate-900 p-2";
  const button = "rounded border border-slate-500 px-3 py-2 disabled:opacity-40";
  return (
    <section className="space-y-5">
      <h1 className="text-2xl font-semibold">
        {initialSelection
          ? initialSelection.mode === "setup"
            ? "Workbench setup test"
            : "Workbench benchmark"
          : "Personal execution"}
      </h1>
      <p>
        Use your signed-in HF account for Jobs, private results, and approved execution.
        The token field is an optional same-account override. Sign in again if your
        OAuth credential expires or the service restarts.
      </p>
      <p>
        Jobs and evidence belong to your HF account, not the control Space. Supplied
        tokens are held in page memory and sent over authenticated requests; they are
        not saved by this interface. Every token permission is available wherever it is
        delivered.
      </p>
      <label className="block">
        <strong className="block mb-2">
          {token
            ? "Authentication: explicit token override"
            : "Authentication: OAuth — no token required"}
        </strong>
        User HF token
        <input
          className={field}
          type="password"
          autoComplete="off"
          placeholder="Optional override — leave empty to use your signed-in HF account"
          aria-label="User HF token"
          aria-describedby="execution-token-help"
          value={token}
          disabled={busy}
          onChange={(event) => {
            setToken(event.target.value);
            setOwner("");
            setJobs([]);
            setFiles([]);
            setBuckets([]);
            setOutput("");
            setApproval(null);
            setConsent(false);
          }}
        />
      </label>
      <p id="execution-token-help">
        This is an override, not a required field. With OAuth, leave it empty and
        connect below.
      </p>
      <button
        type="button"
        className={button}
        disabled={busy}
        onClick={() =>
          void perform(async () => {
            const identity = await request<{
              owner: string;
              results_bucket?: string | null;
            }>("identity");
            setOwner(identity.owner);
            setBucket(identity.results_bucket ?? "");
            await refreshJobs();
          })
        }
      >
        {token ? "Verify token and load my Jobs" : "Connect with OAuth"}
      </button>
      <p>
        Leave the token empty to use OAuth. Jobs and inference permissions require
        consent; Bucket permissions are checked separately.
      </p>
      {owner ? <p>Verified token owner: {owner}</p> : null}
      <p role="status">{message}</p>
      <fieldset disabled={busy || !catalog} className="space-y-3">
        <legend className="text-xl">Select and preview a native run</legend>
        <label className="block">
          Run purpose
          <select
            className={field}
            value={mode}
            onChange={(event) => setMode(event.target.value as "setup" | "benchmark")}
          >
            <option value="benchmark">Benchmark execution</option>
            <option value="setup">Setup test — native Harbor install-only</option>
          </select>
        </label>
        <p>
          Setup mode skips the agent task run and verifier. Installation commands still
          execute and can access the network; compute and credential approval is
          required.
        </p>
        <label className="block">
          Benchmark
          <select
            className={field}
            value={benchmark}
            onChange={(e) => setBenchmark(e.target.value)}
          >
            {catalog?.benchmarks.map((item) => (
              <option
                key={`${item.benchmark}/${item.preset}`}
                value={`${item.benchmark}/${item.preset}`}
              >
                {item.benchmark} / {item.preset}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          Agent and version
          <select
            className={field}
            value={agent}
            onChange={(e) => {
              setAgent(e.target.value);
              const selected = catalog?.agents.find(
                (item) => `${item.agent}/${item.version}` === e.target.value,
              );
              const values: readonly string[] = selected?.reasoning_values ?? [];
              setReasoning(values.includes("default") ? "default" : (values[0] ?? ""));
            }}
          >
            <option value="">Select an agent</option>
            {catalog?.agents.map((item) => (
              <option
                key={`${item.agent}/${item.version}`}
                value={`${item.agent}/${item.version}`}
              >
                {item.agent} / {item.version}
              </option>
            ))}
            <optgroup label="My Workbench configurations">
              {saved.map((item) => (
                <option key={item.revision} value={`workbench/${item.revision}`}>
                  {item.name} · {item.revision.slice(7, 15)} (saved)
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        {selectedSaved ? (
          <p>
            Using exact Workbench version {selectedSaved.revision}. Agent settings stay
            as saved. Benchmark execution requires a passed setup test for this version
            and the approved execution context.
          </p>
        ) : null}
        <label className="block">
          Model (organization/model)
          <input
            className={field}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setProvider("");
              setProviders([]);
            }}
          />
        </label>
        <button
          type="button"
          className={button}
          disabled={!model.trim()}
          onClick={() =>
            void perform(async () => {
              const result = await getModelProviders(model.trim());
              setProviders(result.providers);
              setProvider(result.providers[0] ?? "");
              if (!result.providers.length)
                setMessage("No HF inference providers are available for this model.");
            })
          }
        >
          Find model providers
        </button>
        <label className="block">
          HF inference provider
          <select
            className={field}
            value={provider}
            disabled={!providers.length}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">Find providers for your model first</option>
            {providers.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          Reasoning effort
          <select
            className={field}
            value={selectedSaved ? "saved" : reasoning}
            disabled={!selectedAgent || Boolean(selectedSaved)}
            onChange={(e) => setReasoning(e.target.value)}
          >
            {selectedSaved ? (
              <option value="saved">Use saved agent settings</option>
            ) : !selectedAgent ? (
              <option value="">Select an agent first</option>
            ) : null}
            {selectedAgent?.reasoning_values.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          Requested per-trial USD allowance (not an enforced cap)
          <input
            className={field}
            type="number"
            min="0.01"
            step="0.01"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
          />
        </label>
        <label className="block">
          Run ID
          <input
            className={field}
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={button}
          disabled={
            !benchmark ||
            !agent ||
            !model.trim() ||
            !provider ||
            (!selectedSaved && !reasoning)
          }
          onClick={() =>
            void perform(async () => {
              const [name, preset] = benchmark.split("/");
              const [agentName, version] = agent.split("/");
              const preview = await request("preview", {
                run_id: runId,
                mode,
                submission: {
                  benchmark: { name, preset },
                  harness: { agent: agentName, version },
                  model: {
                    id: model.trim(),
                    provider,
                    reasoning_effort: selectedSaved ? "saved" : reasoning,
                  },
                  cost_ceiling_usd_per_trial: Number(ceiling),
                },
              });
              setOutput(JSON.stringify(preview, null, 2));
            })
          }
        >
          Preview for launch approval
        </button>
      </fieldset>
      {!owner ? (
        <p>
          Verify your user token above to access Jobs, private results, or launch
          approval.
        </p>
      ) : null}
      <fieldset disabled={busy || !owner} className="space-y-3">
        <legend className="text-xl">Explicit approved launch</legend>
        <p>
          Preview does not approve spending. An operator must record the exact launch,
          budget, inference limits, credential destinations and cleanup scope. Timeout
          is not a dollar ceiling. No automatic cost enforcement or complete child
          cleanup is promised.
        </p>
        <button
          type="button"
          className={button}
          onClick={() =>
            void perform(async () => {
              const value = (await request<{ approval: Approval | null }>("approval"))
                .approval;
              setApproval(value);
              setConsent(false);
              if (!value) setMessage("No valid launch approval for your account.");
            })
          }
        >
          Load my exact launch approval
        </button>
        {approval ? (
          <>
            <pre className="overflow-auto whitespace-pre-wrap">
              {JSON.stringify(approval, null, 2)}
            </pre>
            <label className="block">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />{" "}
              I approve this exact launch, token delivery, external cost limits and
              best-effort cleanup.
            </label>
            <button
              type="button"
              className={button}
              disabled={!consent}
              onClick={() =>
                void perform(async () => {
                  const job = await request<Job>("launch", {
                    run_id: approval.run_id,
                    approval_sha256: approval.approval_sha256,
                    confirm: true,
                    accept_best_effort_cleanup_and_external_cost_limits: true,
                  });
                  setBucket(approval.results_bucket);
                  setRunId(approval.run_id);
                  setApproval(null);
                  setConsent(false);
                  setMessage(
                    `Runner dispatched: ${job.id}. Remote cleanup remains unverified.`,
                  );
                  await refreshJobs();
                })
              }
            >
              Dispatch the approved HF Job
            </button>
          </>
        ) : null}
      </fieldset>
      <h2 className="text-xl">My HF Jobs</h2>
      {jobs.map((job) => (
        <div key={job.id} className="flex flex-wrap items-center gap-3">
          <a href={job.url} target="_blank" rel="noreferrer">
            {job.id}
          </a>
          <span>{job.stage}</span>
          {job.mode === "setup" && job.run_id ? (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const result = await request<{ status: string }>("setup-result", {
                    run_id: job.run_id,
                  });
                  setOutput(JSON.stringify(result, null, 2));
                  setMessage(
                    `Setup ${result.status}. This is installation evidence, not a benchmark score.`,
                  );
                })
              }
            >
              Check setup result
            </button>
          ) : null}
          {job.run_id ? (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => {
                setRunId(job.run_id ?? "");
                setFiles([]);
                setOutput("");
              }}
            >
              Use {job.run_id} for results
            </button>
          ) : null}
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                setOutput(
                  (await request<{ text: string }>("logs", { job_id: job.id })).text,
                );
              })
            }
          >
            Logs snapshot
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `Request cancellation of Job ${job.id} only? Child Sandboxes may remain running.`,
                )
              )
                return;
              void perform(async () => {
                await request("cancel", { job_id: job.id, confirm: true });
                setMessage(
                  "Cancellation requested for selected Job only. Child cleanup is unverified.",
                );
                await refreshJobs();
              });
            }}
          >
            Cancel selected Job
          </button>
        </div>
      ))}
      <fieldset disabled={busy || !owner} className="space-y-3">
        <legend className="text-xl">Private native results</legend>
        <button
          type="button"
          className={button}
          onClick={() =>
            void perform(async () => {
              const value = await request<{ items: Array<{ name: string }> }>(
                "buckets",
              );
              setBuckets(value.items);
              setMessage(
                "Loaded the first page of private Buckets. You can also enter a name and validate it.",
              );
            })
          }
        >
          Find my private Buckets
        </button>
        <label className="block">
          Select a private Bucket
          <select
            className={field}
            value={bucket}
            onChange={(event) => {
              setBucket(event.target.value);
              setFiles([]);
            }}
          >
            <option value="">Select a Bucket</option>
            {buckets.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          Existing private Bucket name
          <input
            className={field}
            value={bucket}
            onChange={(e) => {
              setBucket(e.target.value);
              setFiles([]);
            }}
          />
        </label>
        <button
          type="button"
          className={button}
          disabled={!bucket}
          onClick={() =>
            void perform(async () => {
              await request("check-bucket", { bucket });
              setMessage(
                "Private Bucket access verified. Upload/write access is checked during execution.",
              );
            })
          }
        >
          Validate private Bucket
        </button>
        <button
          type="button"
          className={button}
          disabled={!bucket}
          onClick={() => {
            if (
              !window.confirm(
                `Create private Bucket ${owner}/${bucket}? Storage may incur charges. No existing Bucket will be modified.`,
              )
            )
              return;
            void perform(async () => {
              await request("create-bucket", { bucket, confirm: true });
              setBuckets((current) => [
                ...current.filter((item) => item.name !== bucket),
                { name: bucket },
              ]);
              setMessage("Private Bucket created. No Job was launched.");
            });
          }}
        >
          Create private Bucket
        </button>
        <p>Uses the Run ID above. Evidence is not submitted or published.</p>
        <button
          type="button"
          className={button}
          onClick={() =>
            void perform(async () => {
              setFiles(
                (
                  await request<{ files: Array<{ path: string; size: number }> }>(
                    "results",
                    { bucket, run_id: runId },
                  )
                ).files,
              );
            })
          }
        >
          List native artifacts
        </button>
        {files.map((file) => (
          <button
            type="button"
            className={`${button} block`}
            key={file.path}
            onClick={() =>
              void perform(async () => {
                setOutput(
                  (
                    await request<{ text: string }>("artifact", {
                      bucket,
                      run_id: runId,
                      path: file.path,
                    })
                  ).text,
                );
              })
            }
          >
            {file.path} ({file.size} bytes; preview up to 256 KiB)
          </button>
        ))}
      </fieldset>
      <pre className="max-h-[40rem] overflow-auto whitespace-pre-wrap">{output}</pre>
    </section>
  );
}
