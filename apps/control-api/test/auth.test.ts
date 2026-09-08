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
