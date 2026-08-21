export function historicalDispositionResourceMatches(
  sourceResource: unknown,
  intentResource: unknown,
): boolean {
  return (
    typeof intentResource === "string" &&
    intentResource.length > 0 &&
    (sourceResource === null || sourceResource === intentResource)
  );
}
