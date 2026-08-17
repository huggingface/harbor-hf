import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Actor, OperatorAcl } from "@harbor-hf/contracts";
import Database from "better-sqlite3";
import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  discovery,
  fetchUserInfo,
  randomPKCECodeVerifier,
  randomState,
  skipSubjectCheck,
  type Configuration,
} from "openid-client";

export type AuthRole = "operator" | "reader";

export class BearerRateLimitError extends Error {}
export class InvalidBearerCredentialError extends Error {}
export class UnauthorizedSubjectError extends Error {}

export interface AuthenticatedActor extends Actor {
  role: AuthRole;
  transport: "session" | "bearer" | "development";
}

export interface SessionRow {
  id: string;
  subject: string;
  csrf_digest: string;
  expires_at: number;
}

interface FlowRow {
  id: string;
  state: string;
  verifier: string;
  return_to: string;
  expires_at: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestBytes(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

class BearerLookupLimiter {
  private windowStartedAt = Date.now();
  private total = 0;
  private readonly clients = new Map<string, number>();

  allow(client: string, now = Date.now()): boolean {
    if (now - this.windowStartedAt >= 60_000) {
      this.windowStartedAt = now;
      this.total = 0;
      this.clients.clear();
    }
    const clientCount = this.clients.get(client) ?? 0;
    if (
      this.total >= 120 ||
      clientCount >= 20 ||
      (!this.clients.has(client) && this.clients.size >= 4096)
    )
      return false;
    this.total += 1;
    this.clients.set(client, clientCount + 1);
    return true;
  }
}

export class AuthStore {
  private constructor(private readonly database: Database.Database) {}

  static async open(path: string): Promise<AuthStore> {
    await mkdir(dirname(path), { recursive: true });
    const database = new Database(path);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        csrf_digest TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_flows (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        verifier TEXT NOT NULL,
        return_to TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    return new AuthStore(database);
  }

  createFlow(returnTo: string, ttlSeconds = 600): FlowRow {
    const now = Date.now();
    const flow = {
      id: randomToken(),
      state: randomState(),
      verifier: randomPKCECodeVerifier(),
      return_to: returnTo,
      expires_at: now + ttlSeconds * 1000,
    };
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM oauth_flows WHERE expires_at < ?").run(now);
      this.database
        .prepare(
          "INSERT INTO oauth_flows (id, state, verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(flow.id, flow.state, flow.verifier, flow.return_to, flow.expires_at);
      this.database
        .prepare(
          "DELETE FROM oauth_flows WHERE id IN (SELECT id FROM oauth_flows ORDER BY expires_at DESC, id DESC LIMIT -1 OFFSET 4096)",
        )
        .run();
    })();
    return flow;
  }

  takeFlow(id: string): FlowRow | null {
    const row = this.database
      .prepare(
        "SELECT id, state, verifier, return_to, expires_at FROM oauth_flows WHERE id = ?",
      )
      .get(id) as FlowRow | undefined;
    this.database.prepare("DELETE FROM oauth_flows WHERE id = ?").run(id);
    if (!row || row.expires_at < Date.now()) return null;
    return row;
  }

  createSession(
    subject: string,
    ttlSeconds: number,
  ): { id: string; csrf: string; expires_at: number } {
    const id = randomToken();
    const csrf = randomToken();
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    this.database.transaction(() => {
      this.database.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
      this.database
        .prepare(
          "INSERT INTO sessions (id, subject, csrf_digest, expires_at) VALUES (?, ?, ?, ?)",
        )
        .run(id, subject, digest(csrf), expiresAt);
      this.database
        .prepare(
          "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions ORDER BY expires_at DESC, id DESC LIMIT -1 OFFSET 4096)",
        )
        .run();
    })();
    return { id, csrf, expires_at: expiresAt };
  }

  session(id: string): SessionRow | null {
    const row = this.database
      .prepare("SELECT id, subject, csrf_digest, expires_at FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    if (!row || row.expires_at < Date.now()) {
      if (row) this.deleteSession(id);
      return null;
    }
    return row;
  }

  verifyCsrf(session: SessionRow, token: string): boolean {
    return (
      token.length > 20 &&
      timingSafeEqual(digestBytes(token), Buffer.from(session.csrf_digest, "hex"))
    );
  }

  deleteSession(id: string): void {
    this.database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  close(): void {
    this.database.close();
  }
}

interface OAuthConfig {
  issuer: string;
  client_id: string;
  client_secret: string;
  scopes: string;
  callback_url: string;
  session_ttl_seconds: number;
}

export function safeReturnPath(returnTo: string, callbackUrl: string): string {
  if (
    !returnTo.startsWith("/") ||
    returnTo.includes("\\") ||
    [...returnTo].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  )
    return "/";
  try {
    const origin = new URL(callbackUrl).origin;
    const resolved = new URL(returnTo, origin);
    if (resolved.origin !== origin) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}

export class AuthenticationService {
  private oidc: Configuration | null = null;
  private readonly bearerCache = new Map<
    string,
    { subject: string | null; expires_at: number }
  >();
  private readonly bearerLookupLimiter = new BearerLookupLimiter();

  constructor(
    readonly mode: "oauth" | "development",
    readonly store: AuthStore,
    readonly oauth: OAuthConfig | null,
    readonly acl: () => Promise<OperatorAcl | null>,
  ) {}

  async initialize(): Promise<void> {
    if (this.mode === "oauth") {
      if (!this.oauth) throw new Error("OAuth configuration is required in OAuth mode");
      this.oidc = await discovery(
        new URL(this.oauth.issuer),
        this.oauth.client_id,
        this.oauth.client_secret,
      );
    }
  }

  async login(returnTo: string): Promise<{ flow_id: string; url: URL }> {
    if (!this.oidc || !this.oauth) throw new Error("OAuth is not configured");
    const safeReturn = safeReturnPath(returnTo, this.oauth.callback_url);
    const flow = this.store.createFlow(safeReturn);
    const challenge = await calculatePKCECodeChallenge(flow.verifier);
    const url = buildAuthorizationUrl(this.oidc, {
      redirect_uri: this.oauth.callback_url,
      scope: this.oauth.scopes,
      state: flow.state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { flow_id: flow.id, url };
  }

  async callback(
    flowId: string,
    currentUrl: URL,
  ): Promise<{
    session_id: string;
    csrf: string;
    return_to: string;
    expires_at: number;
  }> {
    if (!this.oidc || !this.oauth) throw new Error("OAuth is not configured");
    const flow = this.store.takeFlow(flowId);
    if (!flow) throw new Error("OAuth flow is missing or expired");
    const tokens = await authorizationCodeGrant(this.oidc, currentUrl, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
    });
    if (!tokens.access_token)
      throw new Error("OAuth token response has no access token");
    const user = await fetchUserInfo(
      this.oidc,
      tokens.access_token,
      tokens.claims()?.sub ?? skipSubjectCheck,
    );
    if (!user.sub) throw new Error("OAuth user info has no stable subject");
    if (!(await this.role(user.sub)))
      throw new UnauthorizedSubjectError("OAuth identity is not authorized");
    const session = this.store.createSession(user.sub, this.oauth.session_ttl_seconds);
    return {
      session_id: session.id,
      csrf: session.csrf,
      return_to: flow.return_to,
      expires_at: session.expires_at,
    };
  }

  async sessionActor(
    sessionId: string,
  ): Promise<{ actor: AuthenticatedActor; session: SessionRow } | null> {
    const session = this.store.session(sessionId);
    if (!session) return null;
    const role = await this.role(session.subject);
    if (!role) {
      this.store.deleteSession(session.id);
      return null;
    }
    return {
      actor: {
        subject: session.subject,
        role,
        transport: "session",
      },
      session,
    };
  }

  async bearerActor(token: string): Promise<AuthenticatedActor> {
    const key = digest(token);
    const cached = this.bearerCache.get(key);
    let subject: string | null | undefined =
      cached?.expires_at && cached.expires_at > Date.now() ? cached.subject : undefined;
    if (subject === null)
      throw new InvalidBearerCredentialError("bearer token identity is invalid");
    if (subject === undefined) {
      if (!this.bearerLookupLimiter.allow(key))
        throw new BearerRateLimitError("bearer identity lookup rate exceeded");
      const response = await fetch("https://huggingface.co/api/whoami-v2", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.rememberBearer(key, null, 60_000);
        throw new InvalidBearerCredentialError("bearer token identity is invalid");
      }
      const body = (await response.json()) as Record<string, unknown>;
      subject =
        typeof body.id === "string"
          ? body.id
          : typeof body.name === "string"
            ? body.name
            : null;
      if (!subject) {
        this.rememberBearer(key, null, 60_000);
        throw new InvalidBearerCredentialError(
          "bearer token identity has no stable subject",
        );
      }
      this.rememberBearer(key, subject, 300_000);
    }
    const role = await this.role(subject);
    if (!role)
      throw new InvalidBearerCredentialError("bearer identity is not authorized");
    return { subject, role, transport: "bearer" };
  }

  private rememberBearer(
    key: string,
    subject: string | null,
    ttlMilliseconds: number,
  ): void {
    if (!this.bearerCache.has(key) && this.bearerCache.size >= 4096) {
      const oldest = this.bearerCache.keys().next().value;
      if (oldest) this.bearerCache.delete(oldest);
    }
    this.bearerCache.set(key, {
      subject,
      expires_at: Date.now() + ttlMilliseconds,
    });
  }

  developmentActor(): AuthenticatedActor {
    return {
      subject: "development-operator",
      role: "operator",
      transport: "development",
    };
  }

  async role(subject: string): Promise<AuthRole | null> {
    const acl = await this.acl();
    if (acl?.operators.includes(subject)) return "operator";
    if (acl?.readers.includes(subject)) return "reader";
    return null;
  }

  csrfValid(session: SessionRow, token: string | undefined): boolean {
    return token ? this.store.verifyCsrf(session, token) : false;
  }
}
