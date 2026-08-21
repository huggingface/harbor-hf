export type NpmLockPackage = {
  resolved?: string;
  dev?: boolean;
};

export type NpmLockfile = {
  packages: Record<string, NpmLockPackage>;
};

/**
 * Return unique https tarball URLs needed for `npm ci --omit=dev --offline`.
 * Workspace links and packages marked `dev` in the lockfile are skipped.
 */
export function productionTarballUrls(lockfile: NpmLockfile): string[] {
  if (lockfile.packages === undefined)
    throw new Error("package-lock.json is missing packages");
  const urls = new Set<string>();
  for (const pkg of Object.values(lockfile.packages)) {
    if (pkg.dev === true) continue;
    const resolved = pkg.resolved;
    if (resolved === undefined) continue;
    if (!resolved.includes("://")) continue;
    const url = new URL(resolved);
    if (
      url.protocol !== "https:" ||
      url.origin !== "https://registry.npmjs.org" ||
      !url.pathname.endsWith(".tgz")
    )
      throw new Error(`unsupported production package URL: ${resolved}`);
    urls.add(resolved);
  }
  return [...urls].sort();
}
