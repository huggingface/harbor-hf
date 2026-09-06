import { useEffect, useState } from "react";
import {
  getSavedSetupResults,
  getWorkbenchStarters,
  listSavedConfigurations,
  saveConfiguration,
  type SavedConfiguration,
  type SavedSetupResult,
  type WorkbenchStarter,
} from "./api";
import { PageHeader } from "./layout";
import { Button, Card, ErrorNotice } from "./ui";

export function WorkbenchPage() {
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("my-harness");
  const [text, setText] = useState(
    '{"agents": [{"name": "terminus-2", "kwargs": {}}]}',
  );
  const [items, setItems] = useState<SavedConfiguration[]>([]);
  const [starters, setStarters] = useState<WorkbenchStarter[]>([]);
  const [tests, setTests] = useState<SavedSetupResult[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void listSavedConfigurations()
      .then((value) => setItems(value.items))
      .catch(setError)
      .finally(() => setLoading(false));
    void getWorkbenchStarters()
      .then((value) => setStarters(value.items))
      .catch(setError);
    void getSavedSetupResults()
      .then((value) => setTests(value.items))
      .catch(setError);
  }, []);
  async function save() {
    setSaving(true);
    try {
      const item = await saveConfiguration({
        name,
        harbor_job_config: JSON.parse(text),
      });
      setItems((current) => [
        ...current.filter((value) => value.revision !== item.revision),
        item,
      ]);
      setSelected(item.revision);
      setMessage("Saved immutable harness version. No Job was launched.");
      setError(null);
      return item;
    } catch (failure) {
      setError(failure);
      return null;
    } finally {
      setSaving(false);
    }
  }
  async function prepare(mode: "setup" | "benchmark") {
    // Snapshot the current draft first. Edits can never reuse an old test identity.
    const item = await save();
    if (item)
      window.location.assign(
        `/personal?workbench=${encodeURIComponent(item.revision)}&mode=${mode}`,
      );
  }
  return (
    <>
      <PageHeader
        title="Agent Workbench"
        description="Configure → test setup → save versions → select for benchmark runs."
      />
      <Card>
        <p role="status">
          Test setup snapshots this draft and opens a native Harbor install-only run.
          Benchmark runs use the exact saved version and require a matching passed setup
          test. Both are dedicated Jobs requiring explicit compute/credential approval.
        </p>
        <p className="my-4">
          Save an agents-only native Harbor fragment. Benchmark tasks, environment and
          retries come from the selected benchmark. Model routing is selected in
          Personal execution; agent kwargs (including reasoning) stay as saved. Never
          enter secrets.
        </p>
        <div className="flex flex-wrap gap-3">
          {starters.map((starter) => (
            <Button
              key={starter.name}
              disabled={saving}
              onClick={() => {
                setName(starter.name);
                setText(JSON.stringify(starter.harbor_job_config, null, 2));
                setSelected("");
                setMessage(
                  "Loaded starter draft. Save or test it to create your own version.",
                );
              }}
            >
              Start from {starter.label}
            </Button>
          ))}
        </div>
        <label className="block mt-4">
          Harness name
          <input
            className="block w-full bg-slate-950 p-2"
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="block mt-4">
          Harbor JobConfig fragment
          <textarea
            className="block w-full bg-slate-950 p-2 font-mono"
            rows={16}
            value={text}
            disabled={saving}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button disabled={saving || loading} onClick={() => void save()}>
            Save configuration
          </Button>
          <Button disabled={saving || loading} onClick={() => void prepare("setup")}>
            Test setup
          </Button>
          <Button
            disabled={saving || loading}
            onClick={() => void prepare("benchmark")}
          >
            Use for benchmark
          </Button>
        </div>
        <p className="mt-4">
          A setup pass checks installation only, not inference or benchmark quality.
          Results are user-owned evidence, not independent verification. Changing the
          version, model, benchmark environment or runner image requires a new test.
        </p>
        {loading ? <p role="status">Loading your saved configurations…</p> : null}
        <label className="block mt-4">
          Load configuration
          <select
            className="block w-full bg-slate-950 p-2"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Select a saved version</option>
            {items.map((item) => (
              <option key={item.revision} value={item.revision}>
                {item.name} · {item.revision.slice(7, 15)}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={!selected || saving}
          onClick={() => {
            const item = items.find((value) => value.revision === selected);
            if (item) {
              setName(item.name);
              setText(JSON.stringify(item.harbor_job_config, null, 2));
              setMessage("Loaded exact saved version. Launch still requires approval.");
            }
          }}
        >
          Load
        </Button>
        {tests
          .filter((result) => result.revision === selected)
          .map((result) => (
            <p key={result.run_id}>
              Setup passed: {result.run_id} ({result.observed_at}). Only valid for its
              recorded execution context.
            </p>
          ))}
        {message ? <p role="status">{message}</p> : null}
        {error ? <ErrorNotice error={error} /> : null}
      </Card>
    </>
  );
}
