import { describe, expect, it, vi } from "vitest";
import { validateRunRecord } from "@harbor-hf/contracts";
import { InferenceBindings } from "@harbor-hf/control-core";
import { actor, image, fixture } from "../../control-core/test/inference-fixture.js";
import { withSelectedInferenceSecret } from "../src/inference-secrets.js";

function run(suffix: string) {
  const data = fixture(suffix);
  const record = validateRunRecord({
    schema_version: "v1",
    run_id: `run-${"a".repeat(24)}`,
    created_at: "2026-01-01T00:00:00Z",
    submitted_by: actor,
    role: "diagnostic",
    harbor_revision: "a".repeat(40),
    submission: {
      benchmark: { name: "synthetic", preset: "synthetic" },
      cost_ceiling_usd: 1,
    },
    harbor_job_config: data.job(),
  });
  return { ...data, record };
}

describe("ephemeral selected inference delivery", () => {
  it("isolates concurrent selections, does not persist values, and clears each mapping", async () => {
    const records = [run("EXAMPLE"), run("SECOND")];
    const snapshots = records.map(({ record }) => JSON.stringify(record));
    const supplied: Readonly<Record<string, string>>[] = [];
    await Promise.all(
      records.map(async ({ policy, record }, index) => {
        const suffix = index ? "SECOND" : "EXAMPLE";
        const read = vi.fn((source: string) => {
          expect(source).toBe(`INFERENCE_SECRET_${suffix}`);
          return `synthetic-presence-${suffix}`;
        });
        await withSelectedInferenceSecret(
          record,
          image,
          () => policy,
          read,
          async (secrets) => {
            supplied.push(secrets);
            await Promise.resolve();
            expect(secrets).toEqual({
              [`INFERENCE_API_KEY_${suffix}`]: `synthetic-presence-${suffix}`,
            });
          },
        );
        expect(read).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(record)).toBe(snapshots[index]);
      }),
    );
    expect(supplied).toEqual([{}, {}]);
  });
  it("rechecks grant and presence on every restart without fallback", async () => {
    const { record, manifest } = run("EXAMPLE");
    let policy = new InferenceBindings(manifest);
    const read = vi.fn(() => "synthetic-presence");
    const deliver = vi.fn(async () => undefined);
    await withSelectedInferenceSecret(record, image, () => policy, read, deliver);
    manifest.bindings[0]!.enabled = false;
    policy = new InferenceBindings(manifest);
    await expect(
      withSelectedInferenceSecret(record, image, () => policy, read, deliver),
    ).rejects.toThrow("not reviewed");
    expect(read).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    manifest.bindings[0]!.enabled = true;
    policy = new InferenceBindings(manifest);
    await expect(
      withSelectedInferenceSecret(
        record,
        image,
        () => policy,
        () => undefined,
        deliver,
      ),
    ).rejects.toThrow("missing");
  });
  it("sanitizes reader/transport failures and clears mapping on error", async () => {
    const { record, policy } = run("EXAMPLE");
    const detail = "synthetic-private-detail";
    await expect(
      withSelectedInferenceSecret(
        record,
        image,
        () => policy,
        () => {
          throw Error(detail);
        },
        async () => undefined,
      ),
    ).rejects.toThrow("presence is unavailable");
    let supplied: Readonly<Record<string, string>> = {};
    await expect(
      withSelectedInferenceSecret(
        record,
        image,
        () => policy,
        () => detail,
        async (secrets) => {
          supplied = secrets;
          throw Error(detail);
        },
      ),
    ).rejects.toThrow("Reviewed inference delivery failed");
    expect(supplied).toEqual({});
  });
});

it("passes no secrets or source reads for a native no-inference configuration", async () => {
  const { record } = run("EXAMPLE");
  record.harbor_job_config.agents = [];
  const read = vi.fn(() => "synthetic-must-not-be-read");
  const delivered = vi.fn(async (secrets: Readonly<Record<string, string>>) => {
    expect(secrets).toEqual({});
    return "synthetic-result";
  });
  await expect(
    withSelectedInferenceSecret(
      record,
      image,
      () => new InferenceBindings(),
      read,
      delivered,
    ),
  ).resolves.toBe("synthetic-result");
  expect(read).not.toHaveBeenCalled();
  expect(delivered).toHaveBeenCalledTimes(1);
});

it.each([{}, () => "bad", true, 1, ""])(
  "rejects malformed reader values before transport: %s",
  async (value) => {
    const { record, policy } = run("EXAMPLE");
    const deliver = vi.fn();
    await expect(
      withSelectedInferenceSecret(
        record,
        image,
        () => policy,
        () => value as unknown as string,
        deliver,
      ),
    ).rejects.toThrow("missing");
    expect(deliver).not.toHaveBeenCalled();
  },
);
