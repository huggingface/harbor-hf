import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { validateHarborJobConfig, runRecordPath } from "@harbor-hf/contracts";
import { InferenceRegistry } from "../src/inference-source-registry.js";
import { FilesystemObjectStore, putJson, readJson } from "../src/store.js";
import { actor, image, fixture } from "./inference-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const id = `run-${"a".repeat(24)}`;
const revision = "dcd0a7ac74b7bd417780d9cb27cd819c7ec82e4e";
const currentImage = image.replace(/a{64}$/, "b".repeat(64));
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "run-inference-"));
  roots.push(root);
  const store = new FilesystemObjectStore(root);
  let now = new Date("2026-09-11T00:00:00Z");
  const present = vi.fn(() => true);
  const create = (worker = currentImage) =>
    new InferenceRegistry(store, worker, present, () => now, randomUUID);
  const original = create(image);
  const registered = await original.register(
    {
      expected_revision: 0,
      source_env: "MY_SECRET_KEY",
      label: "Example inference",
      reason: "Register source",
    },
    actor,
  );
  const ref = registered.bindings[0]!.ref;
  const recipe = fixture("EXAMPLE", "https://example.invalid/v1").recipe;
  recipe.environment[0]!.credential_ref = ref;
  const review = await original.review(
    ref,
    {
      expected_revision: 1,
      recipe,
      model_name: "example:native",
      base_url: "https://example.invalid/v1",
      allowed_hosts: ["example.invalid"],
    },
    actor,
  );
  await original.approve(
    ref,
    {
      expected_revision: 1,
      review_id: review.review_id,
      reviewed_confirmation: true,
      reason: "Approve original",
    },
    actor,
  );
  const agent = (await original.policy()).compile(
    recipe,
    actor,
    image,
    "example:native",
    present,
  );
  const config = validateHarborJobConfig({ agents: [agent] });
  const record = {
    schema_version: "v1",
    run_id: id,
    created_at: now.toISOString(),
    submitted_by: actor,
    role: "diagnostic",
    harbor_revision: revision,
    submission: {
      benchmark: { name: "synthetic", preset: "synthetic" },
      cost_ceiling_usd: 1,
    },
    workbench_recipe: { name: recipe.name },
    harbor_job_config: config,
  };
  await putJson(store, runRecordPath(id), record);
  const registry = create();
  return {
    registry,
    original,
    record,
    store,
    ref,
    config,
    present,
    create,
    time: (value: Date) => {
      now = value;
    },
    grant: review.grant,
  };
}
function approval(review: Awaited<ReturnType<InferenceRegistry["reviewRun"]>>) {
  return {
    expected_revision: review.revision,
    review_id: review.review_id,
    reviewed_confirmation: true,
    reason: "Review current image",
  };
}
it("carries forward the real compiled configuration through existing policy approval without recipe reconstruction", async () => {
  const { registry, original, config, store, ref, grant } = await setup();
  expect((await original.policy()).selected(config, actor, image)?.ref).toBe(ref);
  const before = await readJson(store, runRecordPath(id));
  const policy = await registry.policy();
  expect(() => policy.selected(config, actor, currentImage)).toThrow();
  const review = await registry.reviewRun(id, actor, revision);
  expect(review.approval_required).toBe(true);
  expect(review).not.toHaveProperty("recipe");
  expect(review.grant).toEqual({ ...grant, worker_image: currentImage });
  const saved = await registry.approve(ref, approval(review), actor);
  expect(saved.revision).toBe(3);
  expect((await registry.policy()).selected(config, actor, currentImage)?.ref).toBe(
    ref,
  );
  expect(await readJson(store, runRecordPath(id))).toEqual(before);
  expect((await registry.reviewRun(id, actor, revision)).approval_required).toBe(false);
  expect((await registry.discovery(actor)).revision).toBe(3);
  await expect(registry.approve(ref, approval(review), actor)).rejects.toMatchObject({
    status: 409,
  });
});
it.each(["model", "route", "command", "destination", "env", "hosts", "url", "ref"])(
  "rejects altered %s instead of granting a different scope",
  async (field) => {
    const { registry, record, store } = await setup();
    const agent = record.harbor_job_config.agents![0]!;
    const command = agent.kwargs!.config as {
      route_api: string;
      run: { command: string; bindings: Record<string, string> };
    };
    if (field === "model") agent.model_name = "other:model";
    if (field === "route") command.route_api = "responses";
    if (field === "command") command.run.command = "other-command";
    if (field === "destination") command.run.bindings.EXTRA_KEY = "model_api_key";
    if (field === "env") agent.env!.EXTRA = "value";
    if (field === "hosts") agent.extra_allowed_hosts = ["other.invalid"];
    if (field === "url") agent.env!.OPENAI_BASE_URL = "https://other.invalid/v1";
    if (field === "ref") agent.env!.OPENAI_API_KEY = "${INFERENCE_API_KEY_OTHER}";
    await putJson(store, runRecordPath(id), record);
    await expect(registry.reviewRun(id, actor, revision)).rejects.toMatchObject({
      status: 403,
    });
  },
);
it.each(["actor", "harbor", "identity", "missing", "invalid"])(
  "rejects unavailable or foreign native record: %s",
  async (field) => {
    const { registry, record, store } = await setup();
    if (field === "actor") record.submitted_by = "other-operator";
    if (field === "harbor") record.harbor_revision = "b".repeat(40);
    if (field === "identity") record.run_id = `run-${"b".repeat(24)}`;
    if (field === "invalid") record.harbor_job_config = { agents: "invalid" } as never;
    await putJson(store, runRecordPath(id), record);
    await expect(
      registry.reviewRun(
        field === "missing" ? `run-${"b".repeat(24)}` : id,
        actor,
        revision,
      ),
    ).rejects.toMatchObject({ status: 409 });
  },
);
it.each(["disable", "reenable", "presence", "presence-error", "other-owner"])(
  "does not renew unavailable binding: %s",
  async (field) => {
    const { registry, ref, present } = await setup();
    if (field === "disable" || field === "reenable") {
      await registry.status(
        ref,
        { expected_revision: 2, enabled: false, reason: "Disable" },
        actor,
      );
      if (field === "reenable")
        await registry.status(
          ref,
          { expected_revision: 3, enabled: true, reason: "Enable" },
          actor,
        );
    }
    if (field === "presence") present.mockReturnValue(false);
    if (field === "presence-error")
      present.mockImplementation(() => {
        throw new Error("private failure");
      });
    await expect(
      registry.reviewRun(
        id,
        field === "other-owner" ? "other-operator" : actor,
        revision,
      ),
    ).rejects.toThrow();
  },
);
it.each(["revision", "record", "presence", "actor", "expiry", "restart", "ref"])(
  "fences stale approval: %s",
  async (field) => {
    const { registry, ref, present, record, store, time, create } = await setup();
    const review = await registry.reviewRun(id, actor, revision);
    if (field === "revision")
      await registry.status(
        ref,
        { expected_revision: 2, enabled: true, reason: "Changed" },
        actor,
      );
    if (field === "record") {
      record.submission.cost_ceiling_usd = 2;
      await putJson(store, runRecordPath(id), record);
    }
    if (field === "presence") present.mockReturnValue(false);
    if (field === "expiry") time(new Date(review.expires_at));
    const target = field === "restart" ? create(image) : registry;
    await expect(
      target.approve(
        field === "ref" ? "INFERENCE_API_KEY_OTHER" : ref,
        approval(review),
        field === "actor" ? "other-operator" : actor,
      ),
    ).rejects.toThrow();
    expect(
      (await registry.discovery(actor)).bindings[0]!.grants.every(
        (grant) => grant.worker_image === image,
      ),
    ).toBe(true);
  },
);

it("does not infer permission for another record actor from the original owner's grant", async () => {
  const { registry, record, store } = await setup();
  record.submitted_by = "other-operator";
  await putJson(store, runRecordPath(id), record);
  await expect(
    registry.reviewRun(id, "other-operator", revision),
  ).rejects.toMatchObject({ status: 403 });
});
it("refuses ambiguous historical model scopes instead of selecting a broader grant", async () => {
  const { registry, store } = await setup();
  const key = "control/inference-bindings.json";
  const data = (await readJson(
    store,
    key,
  )) as import("@harbor-hf/contracts").InferenceSourceRegistryV1;
  const entry = data.entries[0]!;
  const previous = entry.history[0]!;
  if (previous.kind !== "approve") throw new Error("Expected approval fixture");
  entry.history.push({
    ...previous,
    revision: 3,
    grant: {
      ...previous.grant,
      allowed_models: [...previous.grant.allowed_models, "other:model"],
    },
  });
  data.revision = 3;
  await putJson(store, key, data);
  await expect(registry.reviewRun(id, actor, revision)).rejects.toMatchObject({
    status: 403,
  });
});
it("refuses an invalid current image and retains the existing policy", async () => {
  const { create, registry } = await setup();
  await expect(
    create("mutable-image:latest").reviewRun(id, actor, revision),
  ).rejects.toMatchObject({ status: 403 });
  expect((await registry.discovery(actor)).revision).toBe(2);
});
it("fences two outstanding reviews across the first successful save", async () => {
  const { registry, ref } = await setup();
  const first = await registry.reviewRun(id, actor, revision);
  const second = await registry.reviewRun(id, actor, revision);
  await registry.approve(ref, approval(first), actor);
  await expect(registry.approve(ref, approval(second), actor)).rejects.toMatchObject({
    status: 409,
  });
  expect((await registry.reviewRun(id, actor, revision)).approval_required).toBe(false);
});
