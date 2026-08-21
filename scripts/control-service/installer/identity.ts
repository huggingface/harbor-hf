import type { HfCli } from "./hf.js";
import type { HttpAdapter } from "./http.js";
import type { Principal } from "./model.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface IdentityAdapter {
  resolve(): Promise<Principal>;
}

export class StableIdentityAdapter implements IdentityAdapter {
  constructor(
    private readonly hf: HfCli,
    private readonly http: HttpAdapter,
  ) {}

  async resolve(): Promise<Principal> {
    const cliUsername = await this.hf.whoamiUsername();
    let token: string | undefined = await this.hf.authToken();
    try {
      const response = await this.http.getJson(
        new URL("https://huggingface.co/api/whoami-v2"),
        { bearer: token, timeoutMs: 10_000, maxBytes: 256 * 1024 },
      );
      if (response.status !== 200 || !isRecord(response.body)) {
        throw new Error("authenticated identity lookup failed");
      }
      const id = response.body.id;
      const username = response.body.name ?? response.body.username;
      if (
        typeof id !== "string" ||
        id.length < 1 ||
        typeof username !== "string" ||
        username !== cliUsername
      ) {
        throw new Error("authenticated identity is inconsistent");
      }
      const rawOrganizations = response.body.orgs ?? response.body.organizations ?? [];
      if (!Array.isArray(rawOrganizations)) {
        throw new Error("authenticated organizations are invalid");
      }
      const organizations = rawOrganizations.map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.name === "string") return item.name;
        throw new Error("authenticated organization is invalid");
      });
      return {
        subject: id,
        username,
        organizations: [...new Set(organizations)].sort(),
      };
    } finally {
      token = undefined;
    }
  }
}
