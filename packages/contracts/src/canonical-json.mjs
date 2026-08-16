export class CanonicalJsonError extends Error {}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function normalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError("canonical JSON cannot contain a non-finite number");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object") {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value))
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, normalize(item)]));
  }
  throw new CanonicalJsonError(`canonical JSON does not support ${typeof value}`);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return `${JSON.stringify(normalize(value))}\n`;
}
