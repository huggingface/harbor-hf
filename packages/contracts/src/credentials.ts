// Shared admission and browser draft check. This is not a general secret detector.
const CREDENTIAL_VALUE =
  /(?:hf_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+\S{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;
const CREDENTIAL_KEY =
  /(?:^|[_-])(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|(?:hf|github|gitlab|openai|anthropic)[_-]?token|client[_-]?secret|password|secret|credential|authorization|signature|sig)$/i;
function urlContainsCredential(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) return true;
    const hashParameters = parsed.hash.includes("=")
      ? new URLSearchParams(parsed.hash.slice(1))
      : new URLSearchParams();
    return [...parsed.searchParams, ...hashParameters].some(
      ([parameter, content]) =>
        CREDENTIAL_KEY.test(parameter) || CREDENTIAL_VALUE.test(content),
    );
  } catch {
    return false;
  }
}
export function containsCredentialMaterial(value: unknown, key = ""): boolean {
  if (CREDENTIAL_KEY.test(key)) return true;
  if (typeof value === "string")
    return (
      urlContainsCredential(value) ||
      /\$\{[A-Z][A-Z0-9_]*\}/.test(value) ||
      CREDENTIAL_VALUE.test(value) ||
      value.includes("-----BEGIN PRIVATE KEY-----")
    );
  if (Array.isArray(value))
    return value.some((item) => containsCredentialMaterial(item, key));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([childKey, child]) =>
    containsCredentialMaterial(child, childKey),
  );
}
