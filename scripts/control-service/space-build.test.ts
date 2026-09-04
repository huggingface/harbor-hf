import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function buildGraph(config: string): string {
  return execFileSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "-b", config, "--dry", "--verbose"],
    { cwd: root, encoding: "utf8" },
  );
}

describe("Space build boundary", () => {
  it("compiles the runtime without the local browser installer", () => {
    const graph = buildGraph("tsconfig.space.json");
    expect(graph).toContain("apps/control-api/tsconfig.space.json");
    expect(graph).toContain("apps/control-web/tsconfig.json");
    expect(graph).not.toContain("scripts/control-service/installer");
  });

  it("retains strict local installer and browser checks", () => {
    expect(buildGraph("tsconfig.json")).toContain(
      "scripts/control-service/installer/tsconfig.json",
    );
    const config = JSON.parse(
      readFileSync(
        resolve(root, "scripts/control-service/installer/tsconfig.json"),
        "utf8",
      ),
    );
    expect(config.extends).toBe("../../../tsconfig.base.json");
    expect(config.include).toEqual(["*.ts", "test/**/*.ts", "e2e/**/*.ts"]);
    const base = JSON.parse(readFileSync(resolve(root, "tsconfig.base.json"), "utf8"));
    expect(base.compilerOptions.strict).toBe(true);
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(manifest.devDependencies["@playwright/test"]).toBeDefined();
    expect(manifest.dependencies["@playwright/test"]).toBeUndefined();
  });
});
