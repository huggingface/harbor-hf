"use strict";

const { createHash } = require("node:crypto");

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error("required worker environment is missing");
  return value;
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON number is invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalValue(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("canonical JSON value is invalid");
}

function canonicalJson(value) {
  return `${canonicalValue(value)}\n`;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  if (process.env.HF_TOKEN || process.env.HARBOR_HF_BUCKET_ID)
    throw new Error("persistent control credentials are forbidden in workers");
  const campaignId = requiredEnvironment("HARBOR_HF_CAMPAIGN_ID");
  const actionId = requiredEnvironment("HARBOR_HF_ACTION_ID");
  const capability = requiredEnvironment("HARBOR_HF_WORKER_CAPABILITY");
  const taskIds = JSON.parse(requiredEnvironment("HARBOR_HF_TASK_IDS_JSON"));
  if (
    !Array.isArray(taskIds) ||
    taskIds.length !== 1 ||
    taskIds[0] !== "control-smoke-task"
  )
    throw new Error("control smoke worker received an unexpected task set");
  const taskId = taskIds[0];
  const controlUrl = new URL(requiredEnvironment("HARBOR_HF_CONTROL_URL"));
  const loopback =
    controlUrl.protocol === "http:" &&
    ["127.0.0.1", "::1", "localhost"].includes(controlUrl.hostname);
  if (
    (controlUrl.protocol !== "https:" && !loopback) ||
    controlUrl.username ||
    controlUrl.password ||
    controlUrl.pathname !== "/" ||
    controlUrl.search ||
    controlUrl.hash
  )
    throw new Error("control URL must be an HTTPS origin or loopback test origin");

  async function request(path, init = {}) {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(new URL(path, controlUrl), {
          ...init,
          redirect: "error",
          headers: {
            ...init.headers,
            "x-harbor-hf-worker-capability": capability,
          },
          signal: AbortSignal.timeout(30_000),
        });
        lastStatus = response.status;
        if (response.ok) return await response.json();
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) break;
      } catch {
        lastStatus = 0;
      }
      if (attempt < 3) await sleep(250 * 2 ** attempt);
    }
    throw new Error(`control request failed with status ${lastStatus}`);
  }

  const lock = await request(
    `/api/v1/campaigns/${encodeURIComponent(campaignId)}/lock`,
  );
  if (
    lock.campaign_id !== campaignId ||
    !Array.isArray(lock.tasks) ||
    !lock.tasks.some((task) => task && task.task_id === taskId)
  )
    throw new Error("campaign lock identity is invalid");

  const evidenceBytes = Buffer.from(
    canonicalJson({
      action_id: actionId,
      campaign_id: campaignId,
      kind: "control.smoke.receipt",
      schema_version: "v1",
      task_id: taskId,
    }),
    "utf8",
  );
  const evidenceDigest = digest(evidenceBytes);
  const attemptPath = `/api/v1/campaigns/${encodeURIComponent(campaignId)}/tasks/${encodeURIComponent(taskId)}/attempts`;
  const evidence = await request(attemptPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `control-smoke-evidence-${actionId}-${taskId}`,
    },
    body: JSON.stringify({
      operation: "upload_evidence",
      action_id: actionId,
      digest: evidenceDigest,
      content_base64: evidenceBytes.toString("base64"),
    }),
  });
  if (
    evidence.digest !== evidenceDigest ||
    evidence.size !== evidenceBytes.byteLength ||
    typeof evidence.path !== "string"
  )
    throw new Error("evidence upload response is invalid");

  const manifestBytes = Buffer.from(
    canonicalJson({
      action_id: actionId,
      campaign_id: campaignId,
      kind: "worker.evidence.manifest",
      objects: [
        {
          digest: evidenceDigest,
          path: evidence.path,
          size: evidenceBytes.byteLength,
        },
      ],
      schema_version: "v1",
      task_id: taskId,
    }),
    "utf8",
  );
  const manifestDigest = digest(manifestBytes);
  const manifest = await request(attemptPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `control-smoke-manifest-${actionId}-${taskId}`,
    },
    body: JSON.stringify({
      operation: "upload_evidence",
      action_id: actionId,
      digest: manifestDigest,
      content_base64: manifestBytes.toString("base64"),
    }),
  });
  if (
    manifest.digest !== manifestDigest ||
    manifest.size !== manifestBytes.byteLength ||
    typeof manifest.path !== "string"
  )
    throw new Error("manifest upload response is invalid");

  const completedAt = new Date().toISOString();
  const receipt = await request(attemptPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `control-smoke-attempt-${actionId}-${taskId}`,
    },
    body: JSON.stringify({
      action_id: actionId,
      outcome: "complete",
      replacement_eligible: false,
      evidence_digest: manifestDigest,
      evidence_path: manifest.path,
      cost_microusd: 0,
      metrics: { reward: 1 },
      completed_at: completedAt,
      confirmed: true,
    }),
  });
  if (
    receipt.campaign_id !== campaignId ||
    receipt.task_id !== taskId ||
    typeof receipt.attempt_id !== "string"
  )
    throw new Error("attempt receipt response is invalid");
  process.stdout.write("control-smoke-ok\n");
}

main().catch(() => {
  process.stderr.write("control-smoke-failed\n");
  process.exitCode = 1;
});
