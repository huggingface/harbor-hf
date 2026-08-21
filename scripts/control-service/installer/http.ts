export interface HttpJsonResponse {
  status: number;
  body: unknown;
}

export interface HttpAdapter {
  getJson(
    url: URL,
    options: { bearer?: string; timeoutMs: number; maxBytes: number },
  ): Promise<HttpJsonResponse>;
}

export class BoundedHttpAdapter implements HttpAdapter {
  async getJson(
    url: URL,
    options: { bearer?: string; timeoutMs: number; maxBytes: number },
  ): Promise<HttpJsonResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const headers = new Headers({ accept: "application/json" });
      if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`);
      const response = await fetch(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("HTTP redirects are not allowed");
      }
      const declaredLength = response.headers.get("content-length");
      if (
        declaredLength !== null &&
        Number.parseInt(declaredLength, 10) > options.maxBytes
      ) {
        throw new Error("HTTP response exceeds size limit");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("HTTP response body is missing");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > options.maxBytes) {
          await reader.cancel();
          throw new Error("HTTP response exceeds size limit");
        }
        chunks.push(next.value);
      }
      const bytes = Buffer.concat(chunks);
      let body: unknown;
      try {
        body = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new Error("HTTP response is not valid JSON");
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timer);
    }
  }
}
