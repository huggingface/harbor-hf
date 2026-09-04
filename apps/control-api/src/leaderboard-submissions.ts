import {
  LeaderboardSubmissionError,
  LeaderboardSubmissions,
  PolicyError,
} from "@harbor-hf/control-core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { leaderboardRowSchema } from "./api-schemas.js";
import type { Runtime } from "./runtime.js";

const {
  rank: _rank,
  pareto: _pareto,
  ...publicRowProperties
} = leaderboardRowSchema.properties;
const publicRowSchema = {
  ...leaderboardRowSchema,
  required: leaderboardRowSchema.required.filter(
    (key) => key !== "rank" && key !== "pareto",
  ),
  properties: publicRowProperties,
};

const text = { type: "string" } as const;
const status = { enum: ["pending", "approved", "rejected"] } as const;
const digest = { type: "string", pattern: "^sha256:[a-f0-9]{64}$" } as const;
const submission = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "run_id",
    "publication_id",
    "catalog_digest",
    "created_at",
    "status",
  ],
  properties: {
    id: text,
    run_id: text,
    publication_id: text,
    catalog_digest: digest,
    created_at: { type: "string", format: "date-time" },
    status,
  },
} as const;
const list = (items: object) => ({
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: { items: { type: "array", items } },
});
const confirmed = { const: true, type: "boolean" } as const;

export function submitterRouteAllowed(method: string, path: string): boolean {
  return (
    (method === "GET" &&
      [
        "/api/v1/auth/session",
        "/api/v1/leaderboard",
        "/api/v1/leaderboard/submissions",
        "/api/v1/leaderboard/candidates",
      ].includes(path)) ||
    (method === "POST" &&
      ["/auth/logout", "/api/v1/leaderboard/submissions"].includes(path))
  );
}

export function registerLeaderboardSubmissions(
  app: FastifyInstance,
  runtime: Runtime,
): void {
  const service = new LeaderboardSubmissions(
    runtime.store,
    runtime.projection,
    runtime.service.clock,
  );
  const actor = (request: FastifyRequest) => {
    if (!request.actor)
      throw new LeaderboardSubmissionError(
        401,
        "authentication_required",
        "authentication is required",
      );
    return request.actor;
  };
  const writable = () => {
    if (runtime.config.write_mode === "disabled")
      throw new PolicyError("control writes are disabled");
  };
  app.get(
    "/api/v1/leaderboard/candidates",
    {
      schema: {
        tags: ["results"],
        response: {
          200: list({
            type: "object",
            additionalProperties: false,
            required: ["run_id", "publication_id", "catalog_digest", "public_row"],
            properties: {
              run_id: text,
              publication_id: text,
              catalog_digest: digest,
              public_row: publicRowSchema,
            },
          }),
        },
      },
    },
    async (request) => ({
      items: (await service.candidates(actor(request))).map((item) => ({
        run_id: item.row.run_id,
        publication_id: item.row.publication_id,
        catalog_digest: item.catalog_digest,
        public_row: item.row,
      })),
    }),
  );
  app.get(
    "/api/v1/leaderboard/submissions",
    { schema: { tags: ["results"], response: { 200: list(submission) } } },
    async (request) => ({ items: await service.list(actor(request)) }),
  );
  app.post<{ Body: { run_id: string; catalog_digest: string; confirmed: true } }>(
    "/api/v1/leaderboard/submissions",
    {
      schema: {
        tags: ["results"],
        body: {
          type: "object",
          additionalProperties: false,
          required: ["run_id", "catalog_digest", "confirmed"],
          properties: {
            run_id: { type: "string", pattern: "^[a-zA-Z0-9_-]+$", maxLength: 160 },
            catalog_digest: digest,
            confirmed,
          },
        },
        response: { 200: submission },
      },
    },
    async (request) => {
      writable();
      const record = await service.submit(
        actor(request),
        request.body.run_id,
        request.body.catalog_digest,
      );
      return service.summary(record);
    },
  );
  app.post<{
    Params: { id: string };
    Body: {
      decision: "approved" | "rejected";
      confirmed: true;
      public_metadata_confirmed?: boolean;
    };
  }>(
    "/api/v1/leaderboard/submissions/:id/review",
    {
      schema: {
        tags: ["results"],
        params: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string", pattern: "^[a-z0-9-]+$", maxLength: 160 },
          },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["decision", "confirmed"],
          properties: {
            decision: { enum: ["approved", "rejected"] },
            confirmed,
            public_metadata_confirmed: {
              type: "boolean",
              description:
                "Required true for approval: operator verified privacy and consent for every exact public row field.",
            },
          },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["id", "status"],
            properties: { id: text, status },
          },
        },
      },
    },
    async (request) => {
      writable();
      const review = await service.review(
        actor(request),
        request.params.id,
        request.body.decision,
        request.body.public_metadata_confirmed === true,
      );
      return { id: review.submission_id, status: review.decision };
    },
  );
}
