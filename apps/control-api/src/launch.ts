import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { canonicalJson } from "@harbor-hf/contracts";
import { prepareDirectJobConfig } from "@harbor-hf/control-core";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { lookupHuggingFaceHardware } from "./huggingface-hardware.js";
import { lookupHuggingFaceModelProviders } from "./huggingface-models.js";

const object = z.record(z.string(), z.unknown());
export const catalogSchema = z.object({
  harbor_revision: z.string(),
  agents: z.array(
    z.object({ label: z.string(), config: object, options_schema: object }),
  ),
  job_schema: object,
});
const inspectionSchema = z.object({
  harbor_revision: z.string(),
  tasks: z.number().int().positive(),
  agents: z.number().int().positive(),
  trials: z.number().int().positive(),
  warnings: z.array(z.string()),
  not_performed: z.array(z.string()),
});
export const validationSchema = inspectionSchema.extend({
  effective_config: object,
  fingerprint: z.string(),
  credentials_available: z.boolean(),
});
export type LaunchCatalog = z.infer<typeof catalogSchema>;
export type LaunchValidation = z.infer<typeof inspectionSchema> & {
  effective_config: Record<string, unknown>;
  fingerprint: string;
  credentials_available: boolean;
};
export interface LaunchPort {
  catalog(): Promise<LaunchCatalog>;
  validate(input: unknown): Promise<LaunchValidation>;
}

import { HARBOR_REVISION as REVISION } from "./harbor-revision.js";

export class LaunchError extends Error {
  constructor(
    readonly status: 400 | 503,
    message: string,
  ) {
    super(message);
    this.name = "LaunchError";
  }
}

/** One bounded native inspection at a time; no validation service or queue. */
export class NativeLaunch implements LaunchPort {
  private busy = false;
  private cachedCatalog: Promise<LaunchCatalog> | undefined;
  constructor(private readonly config: AppConfig) {}

  private async invoke(request: Record<string, unknown>): Promise<unknown> {
    if (this.busy)
      throw new LaunchError(503, "Launch inspection is busy; try again shortly");
    this.busy = true;
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "harbor-launch-"));
      const cwd = directory;
      const executable = resolve(
        this.config.launch_python ?? "packages/harbor-hf-agents/.venv/bin/python",
      );
      return await new Promise<unknown>((resolveResult, reject) => {
        const child = spawn(
          executable,
          ["-I", "-m", "harbor_hf_agents.launch", resolve(this.config.presets_root)],
          {
            cwd,
            detached: true,
            stdio: ["pipe", "pipe", "ignore"],
            env: {
              PATH: `${dirname(executable)}:/usr/local/bin:/usr/bin:/bin`,
              HOME: cwd,
              TMPDIR: cwd,
              XDG_CACHE_HOME: cwd,
              PYTHONDONTWRITEBYTECODE: "1",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
              ...(request.operation === "validate"
                ? {
                    GIT_CONFIG_COUNT: "2",
                    GIT_CONFIG_KEY_0: "credential.helper",
                    GIT_CONFIG_VALUE_0: "",
                    GIT_CONFIG_KEY_1: "credential.https://huggingface.co.helper",
                    GIT_CONFIG_VALUE_1: "harbor-hf",
                    ...(this.config.hf_token ? { HF_TOKEN: this.config.hf_token } : {}),
                  }
                : {}),
            },
          },
        );
        let output = "";
        let bytes = 0;
        const decoder = new StringDecoder("utf8");
        let failure: Error | undefined;
        const stop = (message: string) => {
          failure = new LaunchError(503, message);
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              /* Already exited. */
            }
          }
        };
        const timer = setTimeout(
          () => stop("Native launch inspection exceeded 90 seconds"),
          90_000,
        );
        child.stdout.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1_048_576) stop("Native inspection response exceeded its limit");
          else output += decoder.write(chunk);
        });
        child.stdin.on("error", () =>
          stop("Native launch inspector could not read the request"),
        );
        child.on("error", () => {
          failure = new LaunchError(
            503,
            "Pinned native launch inspector is unavailable",
          );
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (failure) {
            reject(failure);
            return;
          }
          try {
            const value: unknown = JSON.parse(output + decoder.end());
            if (code !== 0) {
              const message = z
                .object({
                  error: z.string().max(2000),
                  invalid: z.boolean().default(false),
                })
                .safeParse(value);
              throw new LaunchError(
                message.success &&
                  message.data.invalid &&
                  request.operation === "validate"
                  ? 400
                  : 503,
                message.success ? message.data.error : "Native inspection failed",
              );
            }
            resolveResult(value);
          } catch (error) {
            reject(
              error instanceof LaunchError
                ? error
                : new LaunchError(503, "Native inspector returned an invalid response"),
            );
          }
        });
        child.stdin.end(JSON.stringify(request));
      });
    } catch (error) {
      throw error instanceof LaunchError
        ? error
        : new LaunchError(503, "Pinned native launch inspector is unavailable");
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
      this.busy = false;
    }
  }

  async catalog(): Promise<LaunchCatalog> {
    this.cachedCatalog ??= this.invoke({ operation: "catalog" })
      .then((value) => {
        const parsed = catalogSchema.safeParse(value);
        if (!parsed.success)
          throw new LaunchError(
            503,
            "Native catalog response does not match its contract",
          );
        const catalog = parsed.data;
        if (catalog.harbor_revision !== REVISION)
          throw new LaunchError(503, "Native launch catalog revision mismatch");
        return catalog;
      })
      .catch((error: unknown) => {
        this.cachedCatalog = undefined;
        throw error;
      });
    return this.cachedCatalog;
  }

  async validate(input: unknown): Promise<LaunchValidation> {
    let effective: ReturnType<typeof prepareDirectJobConfig>;
    try {
      effective = prepareDirectJobConfig(
        "run-000000000000000000000000",
        input,
        "/data",
      );
    } catch (error) {
      throw new LaunchError(
        400,
        error instanceof Error ? error.message : "Invalid native configuration",
      );
    }
    const approved = this.config.approved_agent_sources ?? [];
    const parsed = inspectionSchema.safeParse(
      await this.invoke({
        operation: "validate",
        config: effective,
        approved_sources: approved,
      }),
    );
    if (!parsed.success)
      throw new LaunchError(
        503,
        "Native inspection response does not match its contract",
      );
    const native = parsed.data;
    if (native.harbor_revision !== REVISION)
      throw new LaunchError(503, "Native launch validator revision mismatch");
    const environment = z
      .object({ kwargs: z.object({ flavor: z.string() }) })
      .parse(effective.environment);
    const hardware = await lookupHuggingFaceHardware();
    if (!hardware.some((item) => item.name === environment.kwargs.flavor))
      throw new LaunchError(
        400,
        "Selected sandbox flavor is not in the current HF hardware catalog",
      );
    const agents = z
      .array(z.object({ model_name: z.string() }))
      .parse(effective.agents);
    const models = new Map<string, Set<string>>();
    for (const agent of agents) {
      const route = /^(?:openai|huggingface)\/(.+):([^:]+)$/.exec(agent.model_name);
      if (!route?.[1] || !route[2])
        throw new LaunchError(400, "Each model must include an explicit HF provider");
      const providers = models.get(route[1]) ?? new Set<string>();
      providers.add(route[2]);
      models.set(route[1], providers);
    }
    // Bound network work, not Harbor's agent count. Reuse each model response
    // within this inspection and cancel all remaining work on failure.
    const pending = models.entries();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    const inspectModels = async () => {
      for (const [model, selected] of pending) {
        signal.throwIfAborted();
        const providers = await lookupHuggingFaceModelProviders(model, signal);
        signal.throwIfAborted();
        if ([...selected].some((provider) => !providers.includes(provider)))
          throw new LaunchError(
            400,
            "Selected HF model provider is not currently available",
          );
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, models.size) }, inspectModels),
      );
    } catch (error) {
      if (signal.aborted)
        throw new LaunchError(503, "HF model provider inspection timed out; try again");
      throw error;
    } finally {
      controller.abort();
    }
    return {
      ...native,
      effective_config: effective,
      fingerprint: createHash("sha256")
        .update(
          canonicalJson({
            input,
            approved,
            revision: REVISION,
            deployment: this.config.source_revision,
          }),
        )
        .digest("hex"),
      credentials_available: Boolean(
        this.config.hf_token &&
          this.config.hf_inference_token &&
          this.config.hf_token !== this.config.hf_inference_token,
      ),
    };
  }
}
