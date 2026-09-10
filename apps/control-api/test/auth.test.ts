import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorizationCodeGrant,
  Configuration,
  discovery,
  fetchUserInfo,
} from "openid-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationService, AuthStore, OAuthCallbackError } from "../src/auth.js";

vi.mock("openid-client", async (original) => ({
  ...(await original<typeof import("openid-client")>()),
  discovery: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  fetchUserInfo: vi.fn(),
}));

let store: AuthStore;
let auth: AuthenticationService;
const callbackUrl = new URL("https://example.com/auth/callback?code=fixture-code");

beforeEach(async () => {
  store = await AuthStore.open(":memory:");
  auth = new AuthenticationService(
    "oauth",
    store,
    {
      issuer: "https://example.com",
      client_id: "fixture-client",
      client_secret: "fixture-only",
      scopes: "openid profile",
      callback_url: "https://example.com/auth/callback",
      session_ttl_seconds: 3600,
      operator_org_subject: null,
    },
    async () => null,
  );
  vi.mocked(discovery).mockResolvedValue(
    new Configuration({ issuer: "https://example.com" }, "fixture-client"),
  );
  vi.mocked(authorizationCodeGrant).mockResolvedValue({
    access_token: "fixture-only",
    token_type: "bearer",
    claims: () => undefined,
    expiresIn: () => undefined,
  });
  vi.mocked(fetchUserInfo).mockResolvedValue({
    sub: "fixture-subject",
    preferred_username: "example-user",
  });
  await auth.initialize();
  vi.spyOn(auth, "role").mockResolvedValue("operator");
});

afterEach(() => {
  store.close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("OAuth callback diagnostics", () => {
  it("preserves a successful session and one-use flow", async () => {
    const flow = store.createFlow("/runs");
    const result = await auth.callback(flow.id, callbackUrl);
    expect(result.return_to).toBe("/runs");
    expect(store.session(result.session_id)?.subject).toBe("fixture-subject");
    expect(authorizationCodeGrant).toHaveBeenCalledWith(
      expect.any(Configuration),
      callbackUrl,
      {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
      },
    );
    await expect(auth.callback(flow.id, callbackUrl)).rejects.toMatchObject({
      stage: "flow",
      denied: false,
    });
  });

  it.each(["orgs", "organizations"] as const)(
    "authorizes a configured organization from %s by stable subject",
    async (membershipField) => {
      const orgAuth = new AuthenticationService(
        "oauth",
        store,
        {
          issuer: "https://example.com",
          client_id: "fixture-client",
          client_secret: "fixture-only",
          scopes: "openid profile read-memberships",
          callback_url: "https://example.com/auth/callback",
          session_ttl_seconds: 3600,
          operator_org_subject: "fixture-org-subject",
        },
        async () => null,
      );
      vi.mocked(discovery).mockResolvedValueOnce(
        new Configuration(
          {
            issuer: "https://example.com",
            authorization_endpoint: "https://example.com/authorize",
          },
          "fixture-client",
        ),
      );
      vi.mocked(fetchUserInfo).mockResolvedValueOnce({
        sub: "organization-member",
        preferred_username: "example-member",
        [membershipField]: [{ sub: "fixture-org-subject", name: "renamable-name" }],
      });
      await orgAuth.initialize();

      const login = await orgAuth.login("/runs");
      expect(login.url.searchParams.get("orgIds")).toBe("fixture-org-subject");
      expect(login.url.searchParams.get("scope")?.split(" ")).toContain(
        "read-memberships",
      );

      const result = await orgAuth.callback(login.flow_id, callbackUrl);
      expect(store.session(result.session_id)?.operator_org_subject).toBe(
        "fixture-org-subject",
      );
      expect(await orgAuth.sessionActor(result.session_id)).toMatchObject({
        actor: { subject: "organization-member", role: "operator" },
      });
    },
  );

  it("does not authorize organization names or unrelated subjects", async () => {
    const orgAuth = new AuthenticationService(
      "oauth",
      store,
      {
        issuer: "https://example.com",
        client_id: "fixture-client",
        client_secret: "fixture-only",
        scopes: "openid profile read-memberships",
        callback_url: "https://example.com/auth/callback",
        session_ttl_seconds: 3600,
        operator_org_subject: "fixture-org-subject",
      },
      async () => null,
    );
    await orgAuth.initialize();
    vi.mocked(fetchUserInfo).mockResolvedValueOnce({
      sub: "unrelated-user",
      orgs: [
        { sub: "unrelated-org-subject", name: "fixture-org-subject" },
        { name: "fixture-org-subject" },
      ],
    });

    await expect(
      orgAuth.callback(store.createFlow("/").id, callbackUrl),
    ).rejects.toMatchObject({ stage: "authorization", denied: true });
  });

  it("keeps an explicit reader role ahead of organization access", async () => {
    const orgAuth = new AuthenticationService(
      "oauth",
      store,
      {
        issuer: "https://example.com",
        client_id: "fixture-client",
        client_secret: "fixture-only",
        scopes: "openid profile read-memberships",
        callback_url: "https://example.com/auth/callback",
        session_ttl_seconds: 3600,
        operator_org_subject: "fixture-org-subject",
      },
      async () => ({
        schema_version: "v1",
        kind: "operator.acl",
        record_id: "fixture-acl",
        created_at: "2026-09-10T00:00:00Z",
        actor: { subject: "fixture-service", role: "service" },
        operators: [],
        readers: ["fixture-subject"],
      }),
    );
    await orgAuth.initialize();
    vi.mocked(fetchUserInfo).mockResolvedValueOnce({
      sub: "fixture-subject",
      organizations: [{ sub: "fixture-org-subject" }],
    });

    const result = await orgAuth.callback(store.createFlow("/").id, callbackUrl);
    expect(await orgAuth.sessionActor(result.session_id)).toMatchObject({
      actor: { subject: "fixture-subject", role: "reader" },
    });
  });

  it("revokes an organization session when that organization is no longer configured", async () => {
    const session = store.createSession(
      "organization-member",
      "Example member",
      3600,
      "fixture-org-subject",
    );
    const withoutOrganization = new AuthenticationService(
      "oauth",
      store,
      {
        issuer: "https://example.com",
        client_id: "fixture-client",
        client_secret: "fixture-only",
        scopes: "openid profile",
        callback_url: "https://example.com/auth/callback",
        session_ttl_seconds: 3600,
        operator_org_subject: null,
      },
      async () => null,
    );

    expect(await withoutOrganization.sessionActor(session.id)).toBeNull();
    expect(store.session(session.id)).toBeNull();
  });

  it("adds organization authorization to an existing session store", async () => {
    const root = await mkdtemp(join(tmpdir(), "harbor-hf-auth-"));
    const path = join(root, "auth.sqlite");
    const database = new Database(path);
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        username TEXT,
        csrf_digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `);
    database.close();

    const migrated = await AuthStore.open(path);
    try {
      const created = migrated.createSession(
        "organization-member",
        "Example member",
        3600,
        "fixture-org-subject",
      );
      expect(migrated.session(created.id)?.operator_org_subject).toBe(
        "fixture-org-subject",
      );
    } finally {
      migrated.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("identifies missing configuration without retaining the callback", async () => {
    const unconfigured = new AuthenticationService(
      "oauth",
      store,
      null,
      async () => null,
    );
    await expect(unconfigured.callback("missing", callbackUrl)).rejects.toMatchObject({
      stage: "configuration",
    });
  });

  it("identifies expired flows before exchanging tokens", async () => {
    const flow = store.createFlow("/", -1);
    await expect(auth.callback(flow.id, callbackUrl)).rejects.toMatchObject({
      stage: "flow",
    });
    expect(authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it.each(["token_exchange", "user_info", "authorization", "session"] as const)(
    "reports only a fixed classification for %s failures",
    async (stage) => {
      const failure = new Error(
        "private-marker: provider response and credentials must not escape",
      );
      failure.name = "private-marker";
      if (stage === "token_exchange")
        vi.mocked(authorizationCodeGrant).mockRejectedValue(failure);
      if (stage === "user_info") vi.mocked(fetchUserInfo).mockRejectedValue(failure);
      if (stage === "authorization") vi.mocked(auth.role).mockRejectedValue(failure);
      if (stage === "session")
        vi.spyOn(store, "createSession").mockImplementation(() => {
          throw failure;
        });
      const result = await auth
        .callback(store.createFlow("/").id, callbackUrl)
        .catch((error: unknown) => error);
      expect(result).toBeInstanceOf(OAuthCallbackError);
      expect(result).toMatchObject({
        stage,
        denied: false,
        name: "OAuthCallbackError",
      });
      expect(JSON.stringify(result)).not.toContain("private-marker");
      expect(String(result)).not.toContain("private-marker");
      expect(result).not.toHaveProperty("cause");
    },
  );

  it("classifies missing token and subject responses", async () => {
    vi.mocked(authorizationCodeGrant).mockResolvedValueOnce({
      access_token: "",
      token_type: "bearer",
      claims: () => undefined,
      expiresIn: () => undefined,
    });
    await expect(
      auth.callback(store.createFlow("/").id, callbackUrl),
    ).rejects.toMatchObject({ stage: "token_exchange" });
    vi.mocked(fetchUserInfo).mockResolvedValueOnce({ sub: "" });
    await expect(
      auth.callback(store.createFlow("/").id, callbackUrl),
    ).rejects.toMatchObject({ stage: "user_info" });
  });

  it("distinguishes a denied identity from an ACL lookup failure", async () => {
    vi.mocked(auth.role).mockResolvedValue(null);
    const create = vi.spyOn(store, "createSession");
    await expect(
      auth.callback(store.createFlow("/").id, callbackUrl),
    ).rejects.toMatchObject({ stage: "authorization", denied: true });
    expect(create).not.toHaveBeenCalled();
  });
});
