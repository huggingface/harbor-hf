import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it.each([
  ["control-core", "replacements"],
  ["hf-adapters", "bucket-store"],
])("maps compiled %s code back to its tested TypeScript source", async (pkg, name) => {
  const root = `packages/${pkg}/dist/${name}.js`;
  const emitted = await readFile(root, "utf8");
  const map: unknown = JSON.parse(await readFile(`${root}.map`, "utf8"));
  expect(emitted).toContain(`//# sourceMappingURL=${name}.js.map`);
  expect(map).toMatchObject({
    version: 3,
    file: `${name}.js`,
    sourceRoot: "",
    sources: [`../src/${name}.ts`],
  });
});
