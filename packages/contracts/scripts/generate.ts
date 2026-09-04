import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
