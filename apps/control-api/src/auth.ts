import { createHash, randomBytes } from "node:crypto";
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

export class InvalidBearerCredentialError extends Error {}

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

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
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
    const flow = {
      id: randomToken(),
      state: randomState(),
      verifier: randomPKCECodeVerifier(),
      return_to: returnTo,
      expires_at: Date.now() + ttlSeconds * 1000,
    };
    this.database
      .prepare(
        "INSERT INTO oauth_flows (id, state, verifier, return_to, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(flow.id, flow.state, flow.verifier, flow.return_to, flow.expires_at);
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
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.database
      .prepare(
        "INSERT INTO sessions (id, subject, csrf_digest, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(id, subject, digest(csrf), expiresAt);
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
    return token.length > 20 && digest(token) === session.csrf_digest;
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

export class AuthenticationService {
  private oidc: Configuration | null = null;
  private readonly bearerCache = new Map<
    string,
    { subject: string; expires_at: number }
  >();

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
    const safeReturn =
      returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
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
    return {
      actor: {
        subject: session.subject,
        role: await this.role(session.subject),
        transport: "session",
      },
      session,
    };
  }

  async bearerActor(token: string): Promise<AuthenticatedActor> {
    const key = digest(token);
    const cached = this.bearerCache.get(key);
    let subject =
      cached?.expires_at && cached.expires_at > Date.now() ? cached.subject : null;
    if (!subject) {
      const response = await fetch("https://huggingface.co/api/whoami-v2", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new InvalidBearerCredentialError("bearer token identity is invalid");
      const body = (await response.json()) as Record<string, unknown>;
      subject =
        typeof body.id === "string"
          ? body.id
          : typeof body.name === "string"
            ? body.name
            : null;
      if (!subject)
        throw new InvalidBearerCredentialError(
          "bearer token identity has no stable subject",
        );
      this.bearerCache.set(key, { subject, expires_at: Date.now() + 300_000 });
    }
    return { subject, role: await this.role(subject), transport: "bearer" };
  }

  developmentActor(): AuthenticatedActor {
    return {
      subject: "development-operator",
      role: "operator",
      transport: "development",
    };
  }

  async role(subject: string): Promise<AuthRole> {
    const acl = await this.acl();
    if (acl?.operators.includes(subject)) return "operator";
    return "reader";
  }

  csrfValid(session: SessionRow, token: string | undefined): boolean {
    return token ? this.store.verifyCsrf(session, token) : false;
  }
}
