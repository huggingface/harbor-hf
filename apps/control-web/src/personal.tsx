import { useEffect, useState } from "react";
import { api, getPresets, type PresetsResponse } from "./api";

interface Job {
  id: string;
  stage: string;
  url: string;
  run_id: string | null;
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
}

export function PersonalPage() {
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState("");
  const [catalog, setCatalog] = useState<PresetsResponse | null>(null);
  const [benchmark, setBenchmark] = useState("terminal-bench-2-1/two-task-canary");
  const [agent, setAgent] = useState("");
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [reasoning, setReasoning] = useState("default");
  const [ceiling, setCeiling] = useState("1");
  const [bucket, setBucket] = useState("");
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
  useEffect(() => {
    void getPresets()
      .then(setCatalog)
      .catch(() => setMessage("Catalog unavailable."));
  }, []);

  async function request<T>(action: string, body: unknown = {}): Promise<T> {
    return api(`/api/v1/personal/${action}`, {
      method: "POST",
      headers: { "X-HF-User-Token": token },
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
      <h1 className="text-2xl font-semibold">Personal execution</h1>
      <p>
        Jobs and evidence belong to your HF account, not the control Space. Supplied
        tokens are held in page memory and sent over authenticated requests; they are
        not saved by this interface. Every token permission is available wherever it is
        delivered.
      </p>
      <label className="block">
        User HF token
        <input
          className={field}
          type="password"
          autoComplete="off"
          value={token}
          disabled={busy}
          onChange={(event) => {
            setToken(event.target.value);
            setOwner("");
            setJobs([]);
            setFiles([]);
            setOutput("");
            setApproval(null);
            setConsent(false);
          }}
        />
      </label>
      <button
        type="button"
        className={button}
        disabled={busy || !token}
        onClick={() =>
          void perform(async () => {
            setOwner((await request<{ owner: string }>("identity")).owner);
            await refreshJobs();
          })
        }
      >
        Verify token and load my Jobs
      </button>
      {owner ? <p>Verified token owner: {owner}</p> : null}
      <p role="status">{message}</p>
      <fieldset disabled={busy || !owner} className="space-y-3">
        <legend className="text-xl">Select and preview a native run</legend>
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
            onChange={(e) => setAgent(e.target.value)}
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
          </select>
        </label>
        <label className="block">
          Model (organization/model)
          <input
            className={field}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label className="block">
          HF inference provider
          <input
            className={field}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
        </label>
        <label className="block">
          Reasoning effort
          <input
            className={field}
            value={reasoning}
            onChange={(e) => setReasoning(e.target.value)}
          />
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
          onClick={() =>
            void perform(async () => {
              const [name, preset] = benchmark.split("/");
              const [agentName, version] = agent.split("/");
              const preview = await request("preview", {
                run_id: runId,
                submission: {
                  benchmark: { name, preset },
                  harness: { agent: agentName, version },
                  model: { id: model, provider, reasoning_effort: reasoning },
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
