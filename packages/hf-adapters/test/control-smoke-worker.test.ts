import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { canonicalJson, workerEvidenceObjectPath } from "@harbor-hf/contracts";
import { describe, expect, it } from "vitest";

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function childResult(
  command: string[],
  environment: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  expect(command[0]).toBe("node");
  const child = spawn(process.execPath, command.slice(1), {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return { code, stdout, stderr };
}

describe("control smoke worker", () => {
  it("uses only its scoped capability to submit canonical evidence", async () => {
    const campaignId = "campaign-control-smoke";
    const actionId = "action-control-smoke";
    const taskId = "control-smoke-task";
    const capability = "test-worker-capability";
    const captured: CapturedRequest[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const body = bytes.byteLength
        ? (JSON.parse(bytes.toString("utf8")) as Record<string, unknown>)
        : null;
      captured.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body,
      });
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(
          JSON.stringify({
            campaign_id: campaignId,
            tasks: [{ task_id: taskId, input_digest: `sha256:${"a".repeat(64)}` }],
          }),
        );
        return;
      }
      if (body?.operation === "upload_evidence") {
        const content = Buffer.from(String(body.content_base64), "base64");
        const contentDigest = String(body.digest);
        response.statusCode = 201;
        response.end(
          JSON.stringify({
            path: workerEvidenceObjectPath(campaignId, actionId, taskId, contentDigest),
            digest: contentDigest,
            size: content.byteLength,
            created: true,
          }),
        );
        return;
      }
      response.statusCode = 202;
      response.end(
        JSON.stringify({
          campaign_id: campaignId,
          task_id: taskId,
          attempt_id: "worker-attempt-control-smoke",
          status_url: `/api/v1/campaigns/${campaignId}/tasks/${taskId}`,
          adopted: false,
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("test server did not bind a TCP port");

    try {
      const script = await readFile(
        resolve("scripts/control-service/control-smoke-worker.cjs"),
        "utf8",
      );
      const profile = JSON.parse(
        await readFile(resolve("profiles/deployment/hf-cpu-smoke.json"), "utf8"),
      ) as {
        spec: { job_image: string; job_command: string[] };
      };
      expect(profile.spec.job_image).toBe(
        "node:22.22.0-bookworm-slim@sha256:7cc56ef285a8568121537d17b05e72128f01b89c54607b51acf084a50ef483f3",
      );
      expect(profile.spec.job_command.slice(0, 3)).toEqual([
        "node",
        "-e",
        'eval(process.argv.slice(1).join(""))',
      ]);
      expect(profile.spec.job_command.slice(3).join("")).toBe(script);
      expect(
        profile.spec.job_command.every((argument) => argument.length <= 4096),
      ).toBe(true);

      const result = await childResult(profile.spec.job_command, {
        HARBOR_HF_CAMPAIGN_ID: campaignId,
        HARBOR_HF_ACTION_ID: actionId,
        HARBOR_HF_TASK_IDS_JSON: JSON.stringify([taskId]),
        HARBOR_HF_CONTROL_URL: `http://127.0.0.1:${address.port}`,
        HARBOR_HF_WORKER_CAPABILITY: capability,
      });
      expect(result).toEqual({ code: 0, stdout: "control-smoke-ok\n", stderr: "" });
      expect(captured).toHaveLength(4);
      for (const request of captured) {
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["x-harbor-hf-worker-capability"]).toBe(capability);
      }
      expect(captured[0]).toMatchObject({
        method: "GET",
        path: `/api/v1/campaigns/${campaignId}/lock`,
      });

      const evidenceUpload = captured[1]?.body;
      const manifestUpload = captured[2]?.body;
      const attempt = captured[3]?.body;
      expect(evidenceUpload?.operation).toBe("upload_evidence");
      expect(manifestUpload?.operation).toBe("upload_evidence");
      const evidenceBytes = Buffer.from(
        String(evidenceUpload?.content_base64),
        "base64",
      );
      expect(digest(evidenceBytes)).toBe(evidenceUpload?.digest);
      const manifestBytes = Buffer.from(
        String(manifestUpload?.content_base64),
        "base64",
      );
      expect(digest(manifestBytes)).toBe(manifestUpload?.digest);
      const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<
        string,
        unknown
      >;
      expect(canonicalJson(manifest)).toBe(manifestBytes.toString("utf8"));
      expect(manifest).toMatchObject({
        schema_version: "v1",
        kind: "worker.evidence.manifest",
        campaign_id: campaignId,
        action_id: actionId,
        task_id: taskId,
      });
      expect(attempt).toMatchObject({
        action_id: actionId,
        outcome: "complete",
        replacement_eligible: false,
        evidence_digest: manifestUpload?.digest,
        cost_microusd: 0,
        metrics: { reward: 1 },
        confirmed: true,
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("embeds the reviewed Sandbox smoke worker in its pinned profile", async () => {
    const profile = JSON.parse(
      await readFile(resolve("profiles/deployment/hf-cpu-sandbox-smoke.json"), "utf8"),
    ) as { spec: { job_command: string[]; sandbox: Record<string, unknown> } };
    const source = await readFile(
      resolve("scripts/control-service/sandbox-smoke-worker.cjs"),
      "utf8",
    );

    expect(profile.spec.job_command.slice(3).join("")).toBe(source);
    expect(profile.spec.sandbox).toMatchObject({
      hardware: "cpu-basic",
      inference_token: "forbidden",
      reservation_microusd: 2000,
      active_hourly_cost_microusd: 10000,
      max_sandboxes: 1,
    });
  });

  it.each(["HF_TOKEN", "HF_INFERENCE_TOKEN"])(
    "refuses the %s credential in a no-inference worker",
    async (credentialName) => {
      const profile = JSON.parse(
        await readFile(resolve("profiles/deployment/hf-cpu-smoke.json"), "utf8"),
      ) as { spec: { job_command: string[] } };
      const result = await childResult(profile.spec.job_command, {
        [credentialName]: "forbidden-test-value",
        HARBOR_HF_CAMPAIGN_ID: "campaign-control-smoke",
        HARBOR_HF_ACTION_ID: "action-control-smoke",
        HARBOR_HF_TASK_IDS_JSON: JSON.stringify(["control-smoke-task"]),
        HARBOR_HF_CONTROL_URL: "https://control.example",
        HARBOR_HF_WORKER_CAPABILITY: "test-worker-capability",
      });
      expect(result).toEqual({
        code: 1,
        stdout: "",
        stderr: "control-smoke-failed\n",
      });
    },
  );

  it("requires a worker receipt for control smoke success", async () => {
    const profile = JSON.parse(
      await readFile(resolve("profiles/launch-policy/control-smoke.json"), "utf8"),
    ) as { spec: { success_without_worker_receipt: boolean } };
    expect(profile.spec.success_without_worker_receipt).toBe(false);
  });
});
