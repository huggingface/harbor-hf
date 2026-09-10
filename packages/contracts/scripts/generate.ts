import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";
import { compile, compileFromFile } from "json-schema-to-typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaRoot = join(packageRoot, "schemas");
const outputRoot = join(packageRoot, "src", "generated");

await mkdir(outputRoot, { recursive: true });
const files = (await readdir(schemaRoot))
  .filter((name) => name.endsWith(".schema.json"))
  .sort();

const exports: string[] = [
  'export type { LaunchPricingV1 } from "./launch-pricing-v1.js";',
];
for (const file of files) {
  const stem = basename(file, ".schema.json");
  const options = {
    bannerComment: "/* Generated from JSON Schema. Do not edit. */",
    cwd: schemaRoot,
    enableConstEnums: false,
    format: false,
    style: {
      bracketSpacing: true,
      semi: true,
      singleQuote: false,
      tabWidth: 2,
      trailingComma: "all" as const,
    },
    unknownAny: true,
  };
  let output: string;
  if (file === "run-record-v1.schema.json") {
    // json-schema-to-typescript drops sibling properties beside nested
    // conditionals. Keep the runtime schema strict, but omit that conditional
    // from the generated structural type.
    const typeSchema = JSON.parse(await readFile(join(schemaRoot, file), "utf8")) as {
      properties: { submission: { allOf?: unknown } };
    };
    delete typeSchema.properties.submission.allOf;
    output = await compile(typeSchema, stem, options);
  } else {
    output = await compileFromFile(join(schemaRoot, file), options);
  }
  const outputName = `${stem}.ts`;
  const cleanOutput = output.replace(/[ \t]+$/gm, "");
  await writeFile(join(outputRoot, outputName), cleanOutput, "utf8");
  const inferenceType = (
    {
      "inference-review-v1": "InferenceReviewV1",
      "inference-review-request-v1": "InferenceReviewRequestV1",
    } as Record<string, string>
  )[stem];
  exports.push(
    inferenceType
      ? `export type { ${inferenceType} } from "./${stem}.js";`
      : `export type * from "./${stem}.js";`,
  );
}
await writeFile(join(outputRoot, "index.ts"), `${exports.join("\n")}\n`, "utf8");

// Browser validation is compiled here, never at application startup under CSP.
const browserOutput = resolve(packageRoot, "../../apps/control-web/src/generated");
await mkdir(browserOutput, { recursive: true });
for (const [stem, typeName] of [
  ["browser-pricing", "BrowserPricingV1"],
  ["launch-pricing", "LaunchPricingV1"],
]) {
  const pricingSchema = JSON.parse(
    await readFile(join(schemaRoot, `${stem}-v1.schema.json`), "utf8"),
  );
  const ajv = new Ajv2020({ strict: false, code: { source: true, esm: true } });
  const validator = ajv.compile(pricingSchema);
  const banner = `/* Generated from ${stem}-v1.schema.json by Ajv standalone and esbuild. Do not edit. */`;
  await build({
    absWorkingDir: packageRoot,
    stdin: {
      contents: standaloneCode(ajv, validator),
      resolveDir: packageRoot,
      sourcefile: `${stem}-validator.js`,
    },
    outfile: join(browserOutput, `${stem}-validator.js`),
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
    join(browserOutput, `${stem}-validator.d.ts`),
    `${banner}
import type { ${typeName} } from "@harbor-hf/contracts";
export default function validate(value: unknown): value is ${typeName};
`,
    "utf8",
  );
}
