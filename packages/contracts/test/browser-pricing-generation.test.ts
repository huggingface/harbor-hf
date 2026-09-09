import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("generates deterministic browser validation that runs without code generation", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const validator = new URL(
    "../../../apps/control-web/src/generated/browser-pricing-validator.js",
    import.meta.url,
  );
  const declaration = new URL("./browser-pricing-validator.d.ts", validator);
  const read = () => [
    readFileSync(validator, "utf8"),
    readFileSync(declaration, "utf8"),
  ];
  const checkedIn = read();
  for (let attempt = 0; attempt < 2; attempt++) {
    execFileSync(
      process.execPath,
      ["--import", "tsx", "packages/contracts/scripts/generate.ts"],
      { cwd: root },
    );
    expect(read()).toEqual(checkedIn);
  }
  const result = execFileSync(
    process.execPath,
    [
      "--disallow-code-generation-from-strings",
      "--input-type=module",
      "-e",
      `import validate from ${JSON.stringify(validator.href)};
     console.log(validate({schema_version: "v1", scenarios: [], selected_id: null, tier: "standard"}), validate({}));`,
    ],
    { encoding: "utf8" },
  );
  expect(result.trim()).toBe("true false");
}, 30_000);
