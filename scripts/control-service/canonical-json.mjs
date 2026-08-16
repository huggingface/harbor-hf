import { canonicalJson } from "../../packages/contracts/src/canonical-json.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (!input || !Array.isArray(input.values)) {
  throw new Error("canonical JSON request must contain a values array");
}
const encoded = input.values.map((value) =>
  Buffer.from(canonicalJson(value), "utf8").toString("base64"),
);
process.stdout.write(JSON.stringify(encoded));
