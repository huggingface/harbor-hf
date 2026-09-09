import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import { compileFromFile } from "json-schema-to-typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = join(packageRoot, "schemas");
const outputRoot = join(packageRoot, "src", "generated");

await mkdir(outputRoot, { recursive: true });
const files = (await readdir(schemaRoot))
  .filter((name) => name.endsWith(".schema.json"))
  .sort();

const exports: string[] = [];
for (const file of files) {
  const stem = basename(file, ".schema.json");
  const output = await compileFromFile(join(schemaRoot, file), {
    bannerComment: "/* Generated from JSON Schema. Do not edit. */",
    cwd: schemaRoot,
    enableConstEnums: false,
    format: false,
    style: {
      bracketSpacing: true,
      semi: true,
      singleQuote: false,
      tabWidth: 2,
      trailingComma: "all",
    },
    unknownAny: true,
  });
  const outputName = `${stem}.ts`;
  const cleanOutput = output.replace(/[ \t]+$/gm, "");
  await writeFile(join(outputRoot, outputName), cleanOutput, "utf8");
  exports.push(`export type * from "./${stem}.js";`);
}
await writeFile(join(outputRoot, "index.ts"), `${exports.join("\n")}\n`, "utf8");

// Browser validation is compiled here, never at application startup under CSP.
const browserOutput = resolve(packageRoot, "../../apps/control-web/src/generated");
await mkdir(browserOutput, { recursive: true });
const pricingSchema = JSON.parse(
  await readFile(join(schemaRoot, "browser-pricing-v1.schema.json"), "utf8"),
);
const ajv = new Ajv2020({ strict: false, code: { source: true, esm: true } });
const validator = ajv.compile(pricingSchema);
const banner =
  "/* Generated from browser-pricing-v1.schema.json by Ajv standalone and esbuild. Do not edit. */";
await build({
  absWorkingDir: packageRoot,
  stdin: {
    contents: standaloneCode(ajv, validator),
    resolveDir: packageRoot,
    sourcefile: "browser-pricing-validator.js",
  },
  outfile: join(browserOutput, "browser-pricing-validator.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  legalComments: "inline",
  banner: {
    js: `${banner}
/*! Bundled Ajv runtime license:
${await readFile(
  new URL("./LICENSE", import.meta.resolve("ajv/package.json")),
  "utf8",
)}*/`,
  },
});
await writeFile(
  join(browserOutput, "browser-pricing-validator.d.ts"),
  `${banner}
import type { BrowserPricingV1 } from "@harbor-hf/contracts";
export default function validate(value: unknown): value is BrowserPricingV1;
`,
  "utf8",
);
