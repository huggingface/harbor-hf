import { type Browser, chromium, type Page } from "@playwright/test";
import type { HttpJsonResponse } from "./http.js";

export interface ApplicationAuthAdapter {
  getJson(url: URL): Promise<HttpJsonResponse>;
  close(): Promise<void>;
}

export type ApplicationAuthFactory = (
  origin: string,
  username: string,
) => ApplicationAuthAdapter;

const routes = new Set(["/api/v1/system", "/api/v1/runs?limit=1"]);
class BrowserAuthError extends Error {}

const failure = () =>
  new Error("Browser verification failed; retry and sign in in the opened browser.");

export function browserEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SYSTEMROOT",
  ]) {
    const value = environment[name];
    if (value) result[name] = value;
  }
  return result;
}

/** The browser alone owns cookies. No persistent profile or credential export. */
export class BrowserApplicationAuth implements ApplicationAuthAdapter {
  private browser?: Browser;
  private page?: Page;
  private closed = false;
  private readonly origin: string;

  constructor(
    origin: string,
    private readonly username: string,
    private readonly options: {
      launch?: typeof chromium.launch;
      environment?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      pollMs?: number;
      progress?: () => void;
    } = {},
  ) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || !username) {
      throw new Error(
        "Browser verification requires the exact planned HTTPS origin and operator.",
      );
    }
    this.origin = origin;
  }

  private async start(deadline: number): Promise<Page> {
    if (this.closed) throw failure();
    if (this.page) return this.page;
    const environment = browserEnvironment(this.options.environment ?? process.env);
    if (
      process.platform === "linux" &&
      !environment.DISPLAY &&
      !environment.WAYLAND_DISPLAY
    ) {
      throw new BrowserAuthError(
        "Interactive browser verification requires a local graphical display; headless login is not supported.",
      );
    }
    try {
      this.browser = await (this.options.launch ?? chromium.launch.bind(chromium))({
        headless: false,
        env: environment,
        timeout: Math.max(1, deadline - Date.now()),
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      if (this.closed) {
        await this.browser.close();
        throw failure();
      }
      const context = await this.browser.newContext({ serviceWorkers: "block" });
      this.page = await context.newPage();
      await this.page.goto(this.origin, {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1, deadline - Date.now()),
      });
      return this.page;
    } catch {
      throw new BrowserAuthError(
        "Cannot open verification browser. Provide a local graphical display and install Chromium locally with: npx playwright install chromium",
      );
    }
  }

  private async query(
    page: Page,
    path: string,
    deadline: number,
  ): Promise<HttpJsonResponse> {
    if (new URL(page.url()).origin !== this.origin) throw failure();
    return await page.evaluate(
      async ({ origin, path, timeoutMs }) => {
        if (location.origin !== origin) throw new Error("Invalid origin");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(`${origin}${path}`, {
            method: "GET",
            credentials: "same-origin",
            mode: "same-origin",
            referrerPolicy: "no-referrer",
            redirect: "error",
            cache: "no-store",
            signal: controller.signal,
            headers: { accept: "application/json" },
          });
          // Proxy startup/auth responses may be HTML or empty. Never parse them.
          if (response.status === 401 || response.status === 503) {
            await response.body?.cancel();
            return { status: response.status, body: null };
          }
          const maxBytes = 256 * 1024;
          if (Number(response.headers.get("content-length")) > maxBytes)
            throw new Error("Oversize response");
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Missing response");
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              throw new Error("Oversize response");
            }
            chunks.push(next.value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return {
            status: response.status,
            body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
          };
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      },
      {
        origin: this.origin,
        path,
        timeoutMs: Math.max(1, Math.min(10_000, deadline - Date.now())),
      },
    );
  }

  private async authenticate(page: Page, deadline: number): Promise<void> {
    let prompted = false;
    let loginStarted = false;
    while (!this.closed && Date.now() < deadline) {
      if (new URL(page.url()).origin === this.origin) {
        const response = await this.query(page, "/api/v1/auth/session", deadline);
        if (response.status === 200) {
          const body = response.body;
          if (
            typeof body !== "object" ||
            body === null ||
            !("authenticated" in body) ||
            body.authenticated !== true ||
            !("actor" in body)
          )
            throw failure();
          const actor = body.actor;
          if (
            typeof actor !== "object" ||
            actor === null ||
            !("role" in actor) ||
            actor.role !== "operator" ||
            !("username" in actor) ||
            actor.username !== this.username ||
            !("transport" in actor) ||
            actor.transport !== "session"
          ) {
            throw new BrowserAuthError(
              "Sign in as the planned operator using the Space browser login.",
            );
          }
          return;
        }
        if (response.status !== 401 && response.status !== 503) throw failure();
        if (response.status === 401 && !loginStarted) {
          if (!prompted) this.options.progress?.();
          prompted = true;
          loginStarted = true;
          await page.goto(`${this.origin}/auth/login`, {
            waitUntil: "domcontentloaded",
            timeout: Math.max(1, deadline - Date.now()),
          });
        }
      } else if (!prompted) {
        this.options.progress?.();
        prompted = true;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(this.options.pollMs ?? 1000, Math.max(1, deadline - Date.now())),
        ),
      );
    }
    throw new BrowserAuthError(
      "Browser sign-in timed out after at most five minutes; retry verification.",
    );
  }

  async getJson(url: URL): Promise<HttpJsonResponse> {
    if (
      url.origin !== this.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !routes.has(`${url.pathname}${url.search}`)
    ) {
      await this.close();
      throw new Error("Browser verification route is not allowed.");
    }
    const deadline = Date.now() + Math.min(this.options.timeoutMs ?? 300_000, 300_000);
    const timer = setTimeout(
      () => {
        void this.close();
      },
      Math.max(1, deadline - Date.now()),
    );
    try {
      const page = await this.start(deadline);
      await this.authenticate(page, deadline);
      let response = await this.query(page, `${url.pathname}${url.search}`, deadline);
      if (response.status === 401) {
        await this.authenticate(page, deadline);
        response = await this.query(page, `${url.pathname}${url.search}`, deadline);
      }
      if (this.closed || Date.now() >= deadline) throw failure();
      return response;
    } catch (error) {
      await this.close();
      if (error instanceof BrowserAuthError) throw error;
      throw failure();
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.browser?.close().catch(() => undefined);
  }
}
