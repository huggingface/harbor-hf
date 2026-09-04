import { useEffect, useState } from "react";
import {
  listSavedConfigurations,
  type SavedConfiguration,
  saveConfiguration,
  type WorkbenchRecipe,
} from "./api";
import { Button, Card, ErrorNotice } from "./ui";

export function SavedConfigurations({
  recipe,
  onLoad,
  canSave = true,
}: {
  recipe: WorkbenchRecipe;
  canSave?: boolean;
  onLoad: (recipe: WorkbenchRecipe) => void;
}) {
  const [items, setItems] = useState<SavedConfiguration[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void listSavedConfigurations()
      .then((result) => {
        if (active) setItems(result.items);
      })
      .catch((error) => {
        if (active) setError(error);
      });
    return () => {
      active = false;
    };
  }, []);
  async function save() {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      const saved = await saveConfiguration(recipe);
      setItems((current) => [
        ...current.filter((item) => item.revision !== saved.revision),
        saved,
      ]);
      setSelected(saved.revision);
      setMessage(`Saved ${saved.recipe.name} to your configuration library.`);
    } catch (error) {
      setError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mb-6">
      <h2 className="font-semibold text-white">Saved configurations</h2>
      <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-400">
        Saved for your account in the shared Bucket. Saving does not launch a Job or
        approve shared use. Never include secrets.
      </p>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <Button onClick={() => void save()} disabled={busy || !canSave}>
          {busy ? "Saving…" : "Save configuration"}
        </Button>
        <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm text-slate-200 sm:min-w-48">
          Load configuration
          <select
            className="w-full min-w-0 max-w-full truncate rounded-md border border-slate-700 bg-slate-950 p-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Select a saved revision</option>
            {items.map((item) => (
              <option key={item.revision} value={item.revision}>
                {item.recipe.name} · {item.revision.slice(7, 15)}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={!selected || busy}
          onClick={() => {
            const item = items.find((item) => item.revision === selected);
            if (
              item &&
              window.confirm(
                "Load this saved configuration and replace the current editor contents?",
              )
            ) {
              onLoad(structuredClone(item.recipe));
              setMessage(`Loaded ${item.recipe.name}. Test setup before launching.`);
            }
          }}
        >
          Load
        </Button>
      </div>
      {message ? (
        <p role="status" className="mt-3 break-words text-sm leading-6 text-cyan-300">
          {message}
        </p>
      ) : null}
      {error ? <ErrorNotice error={error} /> : null}
    </Card>
  );
}
