import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
import type { NativeObject } from "./launch-draft";

export const draftUrlLimit = 8192;
const costKey = "cost_ceiling_usd_per_trial";
function fitsUrlBudget(search: string): boolean {
  // The existing sign-in flow nests this path in its return_to query.
  return (
    search.length <= draftUrlLimit &&
    `/auth/login?return_to=${encodeURIComponent(`/runs/new${search}`)}`.length <=
      draftUrlLimit
  );
}

function cost(value: string): string {
  const number = Number(value);
  if (!value.trim() || !Number.isFinite(number) || number <= 0 || number > 10000)
    throw new Error("Draft link has an invalid per-trial cost limit");
  return String(number);
}

function config(value: unknown): NativeObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Draft link must contain a native JobConfig object");
  if (containsCredentialMaterial(value))
    throw new Error("Draft links cannot contain credential material");
  return value as NativeObject;
}

/** A URL supplies editable input only, never validation or execution authority. */
export function loadDraftUrl(
  search: string,
): { draft: NativeObject; ceiling: string } | null {
  const params = new URLSearchParams(search);
  if (!params.has("draft") && !params.has(costKey)) return null;
  if (!fitsUrlBudget(search)) throw new Error("Draft link exceeds the 8 KiB URL limit");
  if (params.getAll("draft").length !== 1 || params.getAll(costKey).length > 1)
    throw new Error("Draft link has missing or repeated parameters");
  let value: unknown;
  try {
    value = JSON.parse(params.get("draft") ?? "");
  } catch {
    throw new Error("Draft link contains malformed JSON");
  }
  return { draft: config(value), ceiling: cost(params.get(costKey) ?? "1") };
}

export function draftUrl(base: string, draft: NativeObject, ceiling: string): string {
  const url = new URL(base);
  url.pathname = "/runs/new";
  url.search = "";
  url.hash = "";
  url.searchParams.set("draft", JSON.stringify(config(draft)));
  url.searchParams.set(costKey, cost(ceiling));
  if (url.toString().length > draftUrlLimit || !fitsUrlBudget(url.search))
    throw new Error("Draft is too large for a link; use the native JSON instead");
  return url.toString();
}
