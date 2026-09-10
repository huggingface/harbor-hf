import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  actor,
  fixture,
  image,
} from "../../../packages/control-core/test/inference-fixture.js";
import {
  FilesystemObjectStore,
  INFERENCE_SOURCE_REGISTRY_KEY,
} from "@harbor-hf/control-core";
import { HuggingFaceBucketStore } from "@harbor-hf/hf-adapters";
import { loadConfig } from "../src/config.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
let root: string;
let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (root) await rm(root, { recursive: true, force: true });
});
async function config() {
  root = await mkdtemp(join(tmpdir(), "inference-runtime-"));
  return loadConfig({
    NODE_ENV: "test",
    HARBOR_HF_NAMESPACE: "synthetic",
    HARBOR_HF_BUCKET_ID: "synthetic/artifacts",
    HARBOR_HF_BUCKET_ROOT: join(root, "store"),
    HARBOR_HF_PROJECTION_PATH: join(root, "projection.sqlite"),
    HARBOR_HF_AUTH_PATH: join(root, "auth.sqlite"),
    HARBOR_HF_PRESETS_ROOT: resolve("presets"),
    HARBOR_HF_AUTH_MODE: "development",
    HARBOR_HF_PARENT_IMAGE: image,
  });
}
async function approve(rt: Runtime, model: string) {
  const state = await rt.inference.register(
    {
      expected_revision: 0,
      source_env: "MY_SECRET_KEY",
      label: "Synthetic inference",
      reason: "Register",
    },
    actor,
  );
  const ref = state.bindings[0]!.ref;
  const recipe = fixture().recipe;
  recipe.environment[0]!.credential_ref = ref;
  const review = await rt.inference.review(
    ref,
    {
      expected_revision: 1,
      recipe,
      model_name: model,
      base_url: null,
      allowed_hosts: [],
    },
    actor,
  );
  await rt.inference.approve(
    ref,
    {
      expected_revision: 1,
      review_id: review.review_id,
      reviewed_confirmation: true,
      reason: "Reviewed complete recipe",
    },
    actor,
  );
  return { ref, recipe };
}
it("HF-only empty initialization reads no secrets; corrupt durable data cannot hide behind empty policy", async () => {
  const read = vi.fn();
  runtime = await createRuntime(await config(), read);
  await runtime.initialize();
  expect((await runtime.inference.discovery(actor)).bindings).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  await runtime.store.put(
    INFERENCE_SOURCE_REGISTRY_KEY,
    new TextEncoder().encode("bad"),
  );
  await expect(
    runtime.service.compileWorkbench(fixture().recipe, actor, "example:native"),
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
it.each(["example:native", "second:unchanged/model"])(
  "runtime registration to fake SDK dispatch selects only reviewed secret for %s",
  async (model) => {
    const cfg = await config();
    cfg.store_mode = "bucket";
    cfg.write_mode = "enabled";
    cfg.hf_token = ["hf", "synthetic-control-value"].join("_");
    cfg.hf_inference_token = "synthetic-unrelated-value";
    const store = new FilesystemObjectStore(cfg.bucket_root);
    vi.spyOn(HuggingFaceBucketStore.prototype, "list").mockImplementation((prefix) =>
      store.list(prefix),
    );
    vi.spyOn(HuggingFaceBucketStore.prototype, "read").mockImplementation(
      (key, options) => store.read(key, options),
    );
    vi.spyOn(HuggingFaceBucketStore.prototype, "create").mockImplementation(
      (key, bytes) => store.create(key, bytes),
    );
    vi.spyOn(HuggingFaceBucketStore.prototype, "put").mockImplementation((key, bytes) =>
      store.put(key, bytes),
    );
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        let response: unknown = [];
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          requests.push(body);
          response = {
            id: "synthetic-parent",
            createdAt: "2026-01-01T00:00:00Z",
            status: { stage: "RUNNING" },
            labels: body.labels,
          };
        }
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const read = vi.fn(() => "synthetic-selected-value");
    runtime = await createRuntime(cfg, read);
    await runtime.initialize();
    const { ref, recipe } = await approve(runtime, model);
    const fragment = await runtime.service.compileWorkbench(recipe, actor, model);
    const submit = (key: string) =>
      runtime!.service.submitWorkbench(
        {
          benchmark: { name: "terminal-bench-2-1", preset: "one-task-1-trial" },
          model: { id: model, provider: "synthetic", reasoning_effort: "off" },
          harness: { agent: "synthetic", version: "1" },
          cost_ceiling_usd: 1,
        },
        fragment,
        key,
        actor,
      );
    await submit("selected-first");
    await runtime.service.reconcile();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.secrets).toEqual({
      HF_TOKEN: cfg.hf_token,
      [ref]: "synthetic-selected-value",
    });
    expect(JSON.stringify(requests)).not.toContain(cfg.hf_inference_token);
    expect(read.mock.calls.every(([source]) => source === "MY_SECRET_KEY")).toBe(true);
    for (const entry of await store.list("runs/"))
      expect(new TextDecoder().decode(await store.read(entry.key))).not.toMatch(
        /MY_SECRET_KEY|synthetic-selected-value|synthetic-unrelated-value/,
      );
    await submit("selected-second");
    read.mockReturnValue("");
    await runtime.service.reconcile();
    expect(requests).toHaveLength(1);
    read.mockReturnValue("synthetic-selected-value");
    await runtime.inference.status(
      ref,
      { expected_revision: 2, enabled: false, reason: "Revoke" },
      actor,
    );
    await expect(submit("selected-third")).rejects.toThrow();
    await runtime.close();
    runtime = undefined;
    runtime = await createRuntime(cfg, read);
    await runtime.initialize();
    await expect(
      runtime.service.compileWorkbench(recipe, actor, model),
    ).rejects.toThrow();
    await runtime.service.reconcile();
    expect(requests).toHaveLength(1);
  },
);
it.each(["control", "inference", "oauth"])(
  "rejects infrastructure value hidden behind ordinary source at delivery: %s",
  async (kind) => {
    const cfg = await config();
    cfg.hf_token = "synthetic-control";
    cfg.hf_inference_token = "synthetic-inference";
    cfg.oauth = {
      issuer: "https://example.invalid",
      client_id: "synthetic",
      client_secret: "synthetic-oauth",
      scopes: "openid",
      callback_url: "http://localhost/callback",
      session_ttl_seconds: 60,
      operator_org_subject: null,
    };
    const read = vi.fn(() => undefined as string | undefined);
    runtime = await createRuntime(cfg, read);
    await runtime.initialize();
    const { recipe } = await approve(runtime, "example:native");
    read.mockReturnValue(`synthetic-${kind}`);
    await expect(
      runtime.service.compileWorkbench(recipe, actor, "example:native"),
    ).rejects.toThrow();
  },
);

it("reads only validated own single environment keys", async () => {
  const { readOwnInferenceSource } = await import("../src/runtime.js");
  const env = Object.create({ SYNTHETIC_UPPERCASE: "inherited" }) as Record<
    string,
    unknown
  >;
  env.MY_SECRET_KEY = "synthetic-present";
  expect(readOwnInferenceSource(env, "SYNTHETIC_UPPERCASE")).toBeUndefined();
  expect(readOwnInferenceSource(env, "MY_SECRET_KEY")).toBe("synthetic-present");
  for (const value of [{}, () => "bad", true, 1, "", null]) {
    env.MY_SECRET_KEY = value;
    expect(readOwnInferenceSource(env, "MY_SECRET_KEY")).toBeUndefined();
  }
  expect(() => readOwnInferenceSource(env, "INVALID-NAME")).toThrow();
  expect(() => readOwnInferenceSource(env, "HF_TOKEN")).toThrow();
});
it.each([{}, () => "bad", true, 1])(
  "malformed injected reader is missing and cannot admit: %s",
  async (value) => {
    runtime = await createRuntime(await config(), () => value as unknown as string);
    await runtime.initialize();
    const { recipe } = await approve(runtime, "example:native");
    expect((await runtime.inference.discovery(actor)).bindings[0]?.status).toBe(
      "missing",
    );
    await expect(
      runtime.service.compileWorkbench(recipe, actor, "example:native"),
    ).rejects.toThrow();
  },
);
it("read-only startup does not mutate the canonical store", async () => {
  const cfg = await config();
  cfg.write_mode = "disabled";
  runtime = await createRuntime(cfg, vi.fn());
  const put = vi.spyOn(runtime.store, "put");
  const create = vi.spyOn(runtime.store, "create");
  await runtime.initialize();
  runtime.start();
  expect(put).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("runtime reader errors never expose their details", async () => {
  const read = vi.fn((): string | undefined => undefined);
  runtime = await createRuntime(await config(), read);
  await runtime.initialize();
  const { recipe } = await approve(runtime, "example:native");
  read.mockImplementation(() => {
    throw new Error("synthetic-private-reader-detail");
  });
  await expect(runtime.inference.discovery(actor)).rejects.toThrow(
    "Inference registry unavailable; refetch before retrying",
  );
  await expect(
    runtime.service.compileWorkbench(recipe, actor, "example:native"),
  ).rejects.toThrow("Inference credential presence is unavailable");
});
