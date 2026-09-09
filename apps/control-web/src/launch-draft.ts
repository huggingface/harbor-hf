import { containsCredentialMaterial } from "@harbor-hf/contracts/credentials";
export type NativeObject = Record<string, unknown>;
export const draftKey = "harbor-hf.launch.draft.v1";
export const draftLimit = 128 * 1024;
export function object(value: unknown): NativeObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as NativeObject)
    : {};
}
export function initialDraft(): NativeObject {
  return {
    datasets: [],
    agents: [],
    environment: {
      type: "hf-sandbox",
      // Temporary stopgap for https://github.com/huggingface/sandbox-server/pull/21.
      // Remove after the fixed server passes a foreground canary longer than 30 minutes.
      kwargs: { flavor: "cpu-basic", job_timeout: "none" },
    },
  };
}
export function loadDraft(): NativeObject {
  try {
    const text = localStorage.getItem(draftKey);
    if (!text || text.length > draftLimit) return initialDraft();
    const value: unknown = JSON.parse(text);
    if (
      Array.isArray(value) ||
      !value ||
      typeof value !== "object" ||
      containsCredentialMaterial(value)
    ) {
      localStorage.removeItem(draftKey);
      return initialDraft();
    }
    return object(value);
  } catch {
    return initialDraft();
  }
}
export function saveDraft(value: NativeObject): boolean {
  try {
    const text = JSON.stringify(value);
    if (containsCredentialMaterial(value) || text.length > draftLimit) {
      localStorage.removeItem(draftKey);
      return false;
    }
    localStorage.setItem(draftKey, text);
    return true;
  } catch {
    return false;
  }
}
export function setField(
  value: NativeObject,
  key: string,
  next: unknown,
): NativeObject {
  const updated = { ...value };
  if (next === undefined) delete updated[key];
  else updated[key] = next;
  return updated;
}
