import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type LeaderboardRow,
  type ParentJob,
  type Presets,
  type PresetSubmission,
  request,
  type RunView,
  type Session,
  setRunState,
  signOut,
  submitRun,
  type SystemState,
} from "./api";

interface PrivateState {
  system: SystemState;
  presets: Presets;
  runs: RunView[];
  jobs: ParentJob[];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed.";
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function date(value: string): string {
  return new Date(value).toLocaleString();
}

function Leaderboard({ rows }: { rows: LeaderboardRow[] }) {
  return (
    <section aria-labelledby="leaderboard-title" className="panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Public results</p>
          <h2 id="leaderboard-title">Leaderboard</h2>
        </div>
        <span className="count">{rows.length} entries</span>
      </div>
      {rows.length === 0 ? (
        <p className="empty">No eligible completed runs are available.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Score</th>
                <th>Model</th>
                <th>Agent</th>
                <th>Benchmark</th>
                <th>Trials</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={JSON.stringify(row)}>
                  <td className="score">{percent(row.pass_rate)}</td>
                  <td>
                    <strong>{row.model}</strong>
                    <small>
                      {row.provider} · {row.reasoning_effort}
                    </small>
                  </td>
                  <td>
                    {row.agent} {row.agent_version}
                  </td>
                  <td>
                    {row.benchmark} · {row.preset}
                  </td>
                  <td>{row.n_trials}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function SubmissionForm({
  state,
  onSubmitted,
}: {
  state: PrivateState;
  onSubmitted: () => Promise<void>;
}) {
  const firstBenchmark = state.presets.benchmarks[0];
  const firstAgent = state.presets.agents[0];
  const [benchmarkKey, setBenchmarkKey] = useState(
    firstBenchmark ? `${firstBenchmark.benchmark}|${firstBenchmark.preset}` : "",
  );
  const [agentKey, setAgentKey] = useState(
    firstAgent ? `${firstAgent.agent}|${firstAgent.version}` : "",
  );
  const [model, setModel] = useState("openai/gpt-oss-20b");
  const [provider, setProvider] = useState("together");
  const [reasoning, setReasoning] = useState(
    firstAgent?.reasoning_values[0] ?? "default",
  );
  const [ceiling, setCeiling] = useState("0.25");
  const [role, setRole] = useState<"final" | "diagnostic">("diagnostic");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedAgent = useMemo(
    () =>
      state.presets.agents.find(
        (item) => `${item.agent}|${item.version}` === agentKey,
      ) ?? firstAgent,
    [agentKey, firstAgent, state.presets.agents],
  );
  const allowed =
    state.system.write_mode === "enabled" &&
    state.presets.benchmarks.length > 0 &&
    state.presets.agents.length > 0;

  function changeAgent(value: string) {
    setAgentKey(value);
    const agent = state.presets.agents.find(
      (item) => `${item.agent}|${item.version}` === value,
    );
    setReasoning(agent?.reasoning_values[0] ?? "default");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const benchmark = state.presets.benchmarks.find(
      (item) => `${item.benchmark}|${item.preset}` === benchmarkKey,
    );
    if (!benchmark || !selectedAgent) return;
    const input: PresetSubmission = {
      benchmark: { name: benchmark.benchmark, preset: benchmark.preset },
      model: {
        id: model.trim(),
        provider: provider.trim(),
        reasoning_effort: reasoning,
      },
      harness: { agent: selectedAgent.agent, version: selectedAgent.version },
      cost_ceiling_usd_per_trial: Number(ceiling),
      role,
    };
    setBusy(true);
    setNotice(null);
    try {
      const result = await submitRun(input);
      setNotice(`Submitted ${result.run.run_id}.`);
      await onSubmitted();
    } catch (error) {
      setNotice(message(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="submit-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Operator</p>
          <h2 id="submit-title">New run</h2>
        </div>
        <span className={`status ${allowed ? "good" : "muted"}`}>
          {allowed ? "Launch enabled" : "Read only"}
        </span>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset>
          <legend>1. Benchmark</legend>
          <label>
            Preset
            <select
              value={benchmarkKey}
              onChange={(event) => setBenchmarkKey(event.target.value)}
            >
              {state.presets.benchmarks.map((item) => (
                <option
                  key={`${item.benchmark}|${item.preset}`}
                  value={`${item.benchmark}|${item.preset}`}
                >
                  {item.benchmark} · {item.preset}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>2. Model</legend>
          <label>
            Model ID
            <input
              required
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label>
            Provider
            <input
              required
              pattern="[a-z0-9][a-z0-9-]*"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            />
          </label>
        </fieldset>
        <fieldset>
          <legend>3. Harness</legend>
          <label>
            Agent
            <select
              value={agentKey}
              onChange={(event) => changeAgent(event.target.value)}
            >
              {state.presets.agents.map((item) => (
                <option
                  key={`${item.agent}|${item.version}`}
                  value={`${item.agent}|${item.version}`}
                >
                  {item.agent} · {item.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Reasoning
            <select
              value={reasoning}
              onChange={(event) => setReasoning(event.target.value)}
            >
              {(selectedAgent?.reasoning_values ?? ["default"]).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset>
          <legend>4. Run limits</legend>
          <label>
            Maximum USD per trial
            <input
              required
              min="0.000001"
              max="10000"
              step="any"
              type="number"
              value={ceiling}
              onChange={(event) => setCeiling(event.target.value)}
            />
          </label>
          <label>
            Result role
            <select
              value={role}
              onChange={(event) =>
                setRole(event.target.value as "final" | "diagnostic")
              }
            >
              <option value="diagnostic">Diagnostic</option>
              <option value="final">Final</option>
            </select>
          </label>
        </fieldset>
        <div className="form-footer">
          <button disabled={!allowed || busy} type="submit">
            {busy ? "Submitting…" : "Submit run"}
          </button>
          {notice ? <p role="status">{notice}</p> : null}
        </div>
      </form>
    </section>
  );
}

function Runs({
  state,
  refresh,
}: {
  state: PrivateState;
  refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  async function act(run: RunView, action: "pause" | "resume" | "cancel") {
    setBusy(run.record.run_id);
    setFailure(null);
    try {
      await setRunState(run.record.run_id, action);
      await refresh();
    } catch (error) {
      setFailure(message(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="panel wide" aria-labelledby="runs-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Control</p>
          <h2 id="runs-title">Runs</h2>
        </div>
        <span className="count">{state.runs.length} runs</span>
      </div>
      {failure ? (
        <p className="error" role="alert">
          {failure}
        </p>
      ) : null}
      {state.runs.length === 0 ? (
        <p className="empty">No runs were submitted.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Configuration</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {state.runs.map((run) => (
                <tr key={run.record.run_id}>
                  <td>
                    <code>{run.record.run_id}</code>
                    <small>{run.record.role}</small>
                  </td>
                  <td>
                    <strong>{run.record.submission.model.id}</strong>
                    <small>
                      {run.record.submission.harness.agent} ·{" "}
                      {run.record.submission.benchmark.preset}
                    </small>
                  </td>
                  <td>
                    <span className={`status ${run.status}`}>
                      {run.status.replace("_", " ")}
                    </span>
                  </td>
                  <td>{date(run.record.created_at)}</td>
                  <td>
                    <div className="actions">
                      {run.status === "running" || run.status === "queued" ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy === run.record.run_id}
                          onClick={() => void act(run, "pause")}
                        >
                          Pause
                        </button>
                      ) : null}
                      {run.status === "paused" ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy === run.record.run_id}
                          onClick={() => void act(run, "resume")}
                        >
                          Resume
                        </button>
                      ) : null}
                      {!(
                        ["cancelled", "finished", "cost_stopped"] as string[]
                      ).includes(run.status) ? (
                        <button
                          type="button"
                          className="danger"
                          disabled={busy === run.record.run_id}
                          onClick={() => void act(run, "cancel")}
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Jobs({ jobs }: { jobs: ParentJob[] }) {
  return (
    <section className="panel wide" aria-labelledby="jobs-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Hugging Face</p>
          <h2 id="jobs-title">Parent Jobs</h2>
        </div>
        <span className="count">{jobs.length} Jobs</span>
      </div>
      {jobs.length === 0 ? (
        <p className="empty">No parent Jobs are recorded.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Run</th>
                <th>Stage</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <code>{job.id}</code>
                  </td>
                  <td>
                    <code>{job.run_id}</code>
                  </td>
                  <td>
                    <span className={`status ${job.stage}`}>{job.stage}</span>
                  </td>
                  <td>{date(job.started_at ?? job.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [privateState, setPrivateState] = useState<PrivateState | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  const loadPrivate = useCallback(async () => {
    const [system, presets, runs, jobs] = await Promise.all([
      request<SystemState>("/api/v1/system"),
      request<Presets>("/api/v1/presets"),
      request<{ runs: RunView[] }>("/api/v1/runs"),
      request<{ jobs: ParentJob[] }>("/api/v1/jobs"),
    ]);
    setPrivateState({ system, presets, runs: runs.runs, jobs: jobs.jobs });
  }, []);

  const load = useCallback(async () => {
    setFailure(null);
    setLoading(true);
    try {
      const board = await request<{ rows: LeaderboardRow[] }>("/api/v1/leaderboard");
      setLeaderboard(board.rows);
      try {
        const current = await request<Session>("/api/v1/session");
        setSession(current);
        if (current.authenticated) await loadPrivate();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setSession({ authenticated: false, login_url: "/auth/login" });
          setPrivateState(null);
        } else throw error;
      }
    } catch (error) {
      setFailure(message(error));
    } finally {
      setLoading(false);
    }
  }, [loadPrivate]);

  useEffect(() => {
    void load();
  }, [load]);

  async function logout() {
    await signOut();
    window.location.assign("/");
  }

  return (
    <div className="shell">
      <header>
        <a className="brand" href="/" aria-label="Harbor-HF home">
          <span>H</span> Harbor-HF
        </a>
        <nav aria-label="Account">
          {session?.authenticated ? (
            <>
              <span className="account-name">{session.actor.username}</span>
              <button type="button" className="secondary" onClick={() => void logout()}>
                Sign out
              </button>
            </>
          ) : (
            <a className="button" href="/auth/login">
              Sign in
            </a>
          )}
        </nav>
      </header>
      <main>
        <div className="hero">
          <div>
            <p className="eyebrow">Harbor on Hugging Face</p>
            <h1>Benchmark control without the extra layers.</h1>
            <p>
              One Harbor job owns each run. This page submits runs and shows their
              state.
            </p>
          </div>
          {privateState ? (
            <dl>
              <div>
                <dt>Runs</dt>
                <dd>{privateState.system.projection.runs}</dd>
              </div>
              <div>
                <dt>Trials</dt>
                <dd>{privateState.system.projection.trials}</dd>
              </div>
              <div>
                <dt>Parent Jobs</dt>
                <dd>{privateState.system.projection.parent_jobs}</dd>
              </div>
            </dl>
          ) : null}
        </div>
        {failure ? (
          <div className="error" role="alert">
            {failure}{" "}
            <button type="button" className="secondary" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : null}
        {loading ? (
          <p className="loading" role="status">
            Loading…
          </p>
        ) : null}
        <Leaderboard rows={leaderboard} />
        {privateState && session?.authenticated ? (
          <div className="operator-grid">
            <SubmissionForm state={privateState} onSubmitted={loadPrivate} />
            <Runs state={privateState} refresh={loadPrivate} />
            <Jobs jobs={privateState.jobs} />
          </div>
        ) : !loading ? (
          <section className="panel sign-in">
            <h2>Run control is private</h2>
            <p>
              Sign in with an approved Hugging Face account to submit and manage runs.
            </p>
            <a className="button" href="/auth/login">
              Sign in
            </a>
          </section>
        ) : null}
      </main>
      <footer>Harbor-HF · Harbor revision is pinned for reproducible runs.</footer>
    </div>
  );
}
