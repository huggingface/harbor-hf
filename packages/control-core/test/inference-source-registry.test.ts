import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  InferenceRegistry,
  INFERENCE_SOURCE_REGISTRY_KEY as key,
} from "../src/inference-source-registry.js";
import { FilesystemObjectStore } from "../src/store.js";
import { actor, image, fixture } from "./inference-fixture.js";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "inference-registry-"));
  roots.push(root);
  const store = new FilesystemObjectStore(root);
  const present = vi.fn(() => false);
  let now = new Date("2026-09-10T00:00:00Z");
  const create = () =>
    new InferenceRegistry(store, image, present, () => now, randomUUID);
  const registry = create();
  return {
    store,
    registry,
    present,
    create,
    time: (value: Date) => {
      now = value;
    },
  };
}
const registration = {
  expected_revision: 0,
  source_env: "MY_SECRET_KEY",
  label: "Example inference",
  reason: "Register inference source",
};
async function registered(registry: InferenceRegistry) {
  const response = await registry.register(registration, actor);
  const ref = response.bindings[0]!.ref;
  const recipe = fixture().recipe;
  recipe.environment[0]!.credential_ref = ref;
  return { ref, recipe };
}
async function reviewed(registry: InferenceRegistry) {
  const { ref, recipe } = await registered(registry);
  const review = await registry.review(
    ref,
    {
      expected_revision: 1,
      recipe,
      model_name: "example:native",
      base_url: null,
      allowed_hosts: [],
    },
    actor,
  );
  return {
    ref,
    recipe,
    review,
    approve: {
      expected_revision: 1,
      review_id: review.review_id,
      reviewed_confirmation: true,
      reason: "Reviewed exact configuration",
    },
  };
}
it("registers ordinary names without values; review is separate and grants before presence", async () => {
  const { registry, store, present } = await setup();
  const { ref, recipe, review, approve } = await reviewed(registry);
  expect(review.grant.worker_image).toBe(image);
  expect(review.grant.operator_subjects).toEqual([actor]);
  expect(review.presence).toBe("missing");
  expect((await registry.discovery("other-operator")).bindings).toEqual([]);
  expect(() =>
    registry.register(
      {
        ...registration,
        source_env: "MY_SECOND_KEY",
        expected_revision: 1,
        value: "synthetic",
      },
      actor,
    ),
  ).toThrow();
  expect(() =>
    registry.approve(ref, { ...approve, worker_image: image }, actor),
  ).toThrow();
  await expect(registry.approve(ref, approve, "other-operator")).rejects.toThrow();
  await registry.approve(ref, approve, actor);
  const policy = await registry.policy();
  expect(() =>
    policy.compile(recipe, actor, image, "example:native", () => false),
  ).toThrow();
  const agent = policy.compile(recipe, actor, image, "example:native", () => true);
  expect(agent.env).toEqual({ OPENAI_API_KEY: `\${${ref}}` });
  expect(() =>
    policy.compile(
      { ...recipe, run_command: "different" },
      actor,
      image,
      "example:native",
      () => true,
    ),
  ).toThrow();
  expect(() =>
    policy.compile(recipe, actor, image, "example:changed", () => true),
  ).toThrow();
  expect(present.mock.calls.every(([name]) => name === "MY_SECRET_KEY")).toBe(true);
  expect(new TextDecoder().decode(await store.read(key))).not.toContain('"value"');
  await expect(registry.approve(ref, approve, actor)).rejects.toThrow("changed");
});
it.each([
  "HF_TOKEN",
  "HF_INFERENCE_TOKEN",
  "OAUTH_CLIENT_SECRET",
  "SESSION_KEY",
  "AUTH_KEY",
  "MY_CONTROL_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "HOME",
  "LD_PRELOAD",
  "hf_token",
  "sk-synthetic-value",
  "MY_SECRET_KEY=value",
])("rejects prohibited source %s", async (source_env) => {
  const { registry } = await setup();
  await expect(
    Promise.resolve().then(() =>
      registry.register({ ...registration, source_env }, actor),
    ),
  ).rejects.toThrow();
});
it("serializes concurrent mutations, survives restart, and disables never regrant", async () => {
  const { registry, create } = await setup();
  const { ref, recipe, approve } = await reviewed(registry);
  const outcomes = await Promise.allSettled([
    registry.approve(ref, approve, actor),
    registry.status(
      ref,
      { expected_revision: 1, enabled: false, reason: "Revoke" },
      actor,
    ),
  ]);
  expect(outcomes.map((value) => value.status)).toEqual(["fulfilled", "rejected"]);
  await registry.status(
    ref,
    { expected_revision: 2, enabled: false, reason: "Revoke" },
    actor,
  );
  const restarted = create();
  await expect(
    restarted.register({ ...registration, expected_revision: 3 }, actor),
  ).rejects.toThrow();
  await restarted.status(
    ref,
    { expected_revision: 3, enabled: true, reason: "Restore registration only" },
    actor,
  );
  const policy = await restarted.policy();
  expect(() =>
    policy.compile(recipe, actor, image, "example:native", () => true),
  ).toThrow();
  const state = await restarted.discovery(actor);
  expect(state.revision).toBe(4);
  expect(state.bindings[0]?.grants).toEqual([]);
});
it("invalidates review on restart, expiry, actor changes and intervening revision", async () => {
  const { registry, create, time } = await setup();
  const { ref, approve } = await reviewed(registry);
  await expect(create().approve(ref, approve, actor)).rejects.toThrow();
  time(new Date("2026-09-10T00:16:00Z"));
  await expect(registry.approve(ref, approve, actor)).rejects.toThrow();
});
it("holds mutation behind the complete selected delivery sequence", async () => {
  const { registry } = await setup();
  const { ref, approve } = await reviewed(registry);
  await registry.approve(ref, approve, actor);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = () => {};
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delivery = registry.sequence(async () => {
    await registry.policy();
    started();
    await gate;
  });
  await entering;
  let revoked = false;
  const revocation = registry
    .status(ref, { expected_revision: 2, enabled: false, reason: "Revoke" }, actor)
    .then(() => {
      revoked = true;
    });
  await Promise.resolve();
  expect(revoked).toBe(false);
  release();
  await delivery;
  await revocation;
  expect(revoked).toBe(true);
});
it("recovers ambiguous writes only through a validated fresh read", async () => {
  const { registry, store } = await setup();
  const put = store.put.bind(store);
  vi.spyOn(store, "put").mockImplementationOnce(async (k, v) => {
    await put(k, v);
    throw Error("private failure");
  });
  await expect(registry.register(registration, actor)).rejects.toThrow("unavailable");
  const read = vi.spyOn(store, "read").mockRejectedValueOnce(Error("private URL"));
  await expect(registry.policy()).rejects.toThrow("unavailable");
  const state = await registry.discovery(actor);
  expect(state.revision).toBe(1);
  expect(read).toHaveBeenLastCalledWith(key, { fresh: true });
  await expect(registry.register(registration, actor)).rejects.toThrow("changed");
});
it.each([
  "not-json",
  JSON.stringify({ schema_version: "v2", entries: [] }),
  "x".repeat(1024 * 1024 + 1),
])("fails closed on corrupt durable registry", async (value) => {
  const { registry, store } = await setup();
  await store.put(key, new TextEncoder().encode(value));
  await expect(registry.policy()).rejects.toThrow(/^Inference registry unavailable/);
});
it("rejects history tampering and a source alias embedded in public metadata", async () => {
  const { registry, store, create } = await setup();
  await registered(registry);
  await expect(
    registry.register(
      {
        ...registration,
        expected_revision: 1,
        source_env: "SECOND_KEY",
        label: "MY_SECRET_KEY",
      },
      actor,
    ),
  ).rejects.toThrow();
  const value = JSON.parse(new TextDecoder().decode(await store.read(key)));
  value.entries[0].registration.revision = 2;
  await store.put(key, new TextEncoder().encode(JSON.stringify(value)));
  await expect(create().policy()).rejects.toThrow("unavailable");
});

it("rejects rollback, missing established ledger and identity edits without forgetting reservations", async () => {
  const { registry, store } = await setup();
  const { ref } = await registered(registry);
  const prior = await store.read(key);
  await registry.status(
    ref,
    { expected_revision: 1, enabled: false, reason: "Revoke" },
    actor,
  );
  const current = await store.read(key);
  await store.put(key, prior);
  await expect(registry.policy()).rejects.toThrow("unavailable");
  await store.put(key, current);
  const edit = JSON.parse(new TextDecoder().decode(current));
  edit.entries[0].source_env = "CHANGED_KEY";
  await store.put(key, new TextEncoder().encode(JSON.stringify(edit)));
  await expect(registry.policy()).rejects.toThrow("unavailable");
  await store.put(key, current);
  vi.spyOn(store, "read").mockRejectedValueOnce(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );
  await expect(registry.policy()).rejects.toThrow("unavailable");
  expect((await registry.discovery(actor)).revision).toBe(2);
});
it("rejects secret-looking labels, reasons, models, destination authority names and cross-source mentions", async () => {
  const { registry } = await setup();
  for (const field of ["label", "reason", "source_env"])
    await expect(
      Promise.resolve().then(() =>
        registry.register(
          { ...registration, [field]: "ghp_123456789012345678901234567890123456" },
          actor,
        ),
      ),
    ).rejects.toThrow();
  const { ref, recipe } = await registered(registry);
  const body = {
    expected_revision: 1,
    recipe,
    model_name: "example:native",
    base_url: null,
    allowed_hosts: [],
  };
  await expect(
    registry.review(
      ref,
      { ...body, model_name: "ghp_123456789012345678901234567890123456" },
      actor,
    ),
  ).rejects.toThrow();
  expect(() =>
    registry.review(
      ref,
      { ...body, recipe: { ...recipe, name: "MY_SECRET_KEY" } },
      actor,
    ),
  ).toThrow();
  const forbidden = structuredClone(recipe);
  forbidden.environment[0]!.name = "SESSION_KEY";
  await expect(
    registry.review(ref, { ...body, recipe: forbidden }, actor),
  ).rejects.toThrow();
  await expect(
    registry.review(ref, { ...body, base_url: "https://example.invalid" }, actor),
  ).rejects.toThrow();
});
it("invalidates a reviewed receipt on intervening registration and sanitizes presence failure", async () => {
  const { registry, present } = await setup();
  const { ref, approve } = await reviewed(registry);
  await registry.register(
    {
      ...registration,
      expected_revision: 1,
      source_env: "ANOTHER_KEY",
      label: "Other source",
    },
    actor,
  );
  await expect(
    registry.approve(ref, { ...approve, expected_revision: 2 }, actor),
  ).rejects.toThrow("changed");
  present.mockImplementation(() => {
    throw Error("private value");
  });
  await expect(registry.discovery(actor)).rejects.toThrow(
    /^Inference registry unavailable/,
  );
});

it.each([
  "MY_SECRET_KEY",
  "ordinary_key",
  "INFERENCE_SECRET_EXAMPLE",
  "EXAMPLE_API_KEY",
])("accepts valid non-authority source %s", async (source_env) => {
  const { registry } = await setup();
  const result = await registry.register({ ...registration, source_env }, actor);
  expect(result.bindings[0]?.source_env).toBe(source_env);
});

it.each(["native", "chat-completions", "responses"] as const)(
  "protocol admission survives approval and restart: %s",
  async (route) => {
    const { registry, create } = await setup();
    const { ref, recipe } = await registered(registry);
    recipe.route_api = route;
    const request = {
      expected_revision: 1,
      recipe,
      model_name: "example:native",
      base_url: null as string | null,
      allowed_hosts: [] as string[],
    };
    if (route !== "native") {
      await expect(registry.review(ref, request, actor)).rejects.toThrow();
      request.base_url = "https://example.invalid/v1";
      request.allowed_hosts = ["example.invalid"];
      await expect(registry.review(ref, request, actor)).rejects.toThrow();
      recipe.environment.push({ name: "MODEL_URL", source: "model_base_url" });
    }
    const review = await registry.review(ref, request, actor);
    await registry.approve(
      ref,
      {
        expected_revision: 1,
        review_id: review.review_id,
        reviewed_confirmation: true,
        reason: "Reviewed protocol",
      },
      actor,
    );
    for (const controller of [registry, create()]) {
      const policy = await controller.policy();
      const agent = policy.compile(recipe, actor, image, "example:native", () => true);
      expect(policy.selected({ agents: [agent] }, actor, image)?.ref).toBe(ref);
      if (route !== "native") {
        delete agent.env?.OPENAI_BASE_URL;
        expect(() => policy.selected({ agents: [agent] }, actor, image)).toThrow();
      }
    }
  },
);

it.each(["chat-completions", "responses"] as const)(
  "restart rejects corrupt durable key-only approval: %s",
  async (route) => {
    const { registry, store, create } = await setup();
    const { ref, approve } = await reviewed(registry);
    await registry.approve(ref, approve, actor);
    const bytes = await store.read(key);
    const corrupt = JSON.parse(new TextDecoder().decode(bytes));
    corrupt.entries[0].history[0].grant.route_api = route;
    await store.put(key, new TextEncoder().encode(JSON.stringify(corrupt)));
    await expect(create().policy()).rejects.toThrow("unavailable");
  },
);
