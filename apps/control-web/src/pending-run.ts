const prefix = "harbor-hf.new-run.pending.v1:";

/** Keep ambiguous submissions idempotent across a reload, separately for each actor. */
export function pendingRunId(owner: string, key: string): string {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(prefix + owner) ?? "null",
    );
    if (
      value &&
      typeof value === "object" &&
      "key" in value &&
      value.key === key &&
      "id" in value &&
      typeof value.id === "string" &&
      value.id.length > 0
    )
      return value.id;
  } catch {
    // A stale cache or restricted browser storage must not prevent review.
  }
  const id = crypto.randomUUID();
  try {
    window.localStorage.setItem(prefix + owner, JSON.stringify({ key, id }));
  } catch {
    /* The controller also retains the key in memory. */
  }
  return id;
}

export function clearPendingRun(owner: string): void {
  try {
    window.localStorage.removeItem(prefix + owner);
  } catch {
    /* Restricted browser storage. */
  }
}
