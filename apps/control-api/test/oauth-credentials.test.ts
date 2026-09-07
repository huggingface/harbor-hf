import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AuthStore } from "../src/auth.js";

it("keeps OAuth credentials session-bound, memory-only and cleared on logout/restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "oauth-credentials-"));
  const path = join(root, "auth.sqlite");
  const store = await AuthStore.open(path);
  try {
    const first = store.createSession("subject", "example-user", 60);
    const other = store.createSession("other", "other-user", 60);
    const token = "oauth-private-example-value";
    store.retainCredential(first.id, token, 30);
    expect(store.executionCredential(first.id)).toBe(token);
    expect(store.executionCredential(other.id)).toBeNull();
    expect((await readFile(path)).includes(Buffer.from(token))).toBe(false);
    store.deleteSession(first.id);
    expect(store.executionCredential(first.id)).toBeNull();
    store.retainCredential(other.id, token, 0);
    expect(store.executionCredential(other.id)).toBeNull();
    const now = Date.now();
    store.retainCredential(other.id, token, 1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    try {
      expect(store.executionCredential(other.id)).toBeNull();
    } finally {
      clock.mockRestore();
    }
    store.retainCredential(other.id, token, 30);
    store.close();
    const reopened = await AuthStore.open(path);
    try {
      expect(reopened.session(other.id)).not.toBeNull();
      expect(reopened.executionCredential(other.id)).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
