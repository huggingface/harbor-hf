// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { fastAgentWorkbenchStarter } from "../../../packages/control-core/src/workbench";
import { SavedConfigurations } from "../src/saved-configurations";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("saves to the server and loads a revision after a fresh mount", async () => {
  const saved = {
    schema_version: "v1",
    revision: `sha256:${"a".repeat(64)}`,
    recipe: fastAgentWorkbenchStarter,
  };
  let items: (typeof saved)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        items = [saved];
        return Response.json(saved);
      }
      return Response.json({ items });
    }),
  );
  const onLoad = vi.fn();
  const view = render(
    <SavedConfigurations recipe={fastAgentWorkbenchStarter} onLoad={onLoad} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Saved fast-agent");
  view.unmount();
  render(<SavedConfigurations recipe={fastAgentWorkbenchStarter} onLoad={onLoad} />);
  await screen.findByRole("option", { name: /fast-agent · aaaaaaaa/ });
  await userEvent.selectOptions(screen.getByRole("combobox"), saved.revision);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  await userEvent.click(screen.getByRole("button", { name: "Load", exact: true }));
  expect(onLoad).toHaveBeenCalledWith(fastAgentWorkbenchStarter);
});
it("does not claim success when saving fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json(
            { error: { code: "unavailable", message: "Cannot save" } },
            { status: 503 },
          )
        : Response.json({ items: [] }),
    ),
  );
  render(<SavedConfigurations recipe={fastAgentWorkbenchStarter} onLoad={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Save configuration" }));
  await waitFor(() => expect(screen.getByText("Cannot save")).toBeInTheDocument());
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("keeps account scope clear and long saved names in a bounded control", async () => {
  const name = "A long saved configuration name ".repeat(8);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        items: [
          {
            schema_version: "v1",
            revision: `sha256:${"b".repeat(64)}`,
            recipe: { ...fastAgentWorkbenchStarter, name },
          },
        ],
      }),
    ),
  );
  render(<SavedConfigurations recipe={fastAgentWorkbenchStarter} onLoad={vi.fn()} />);
  expect(screen.getByText(/Saved for your account in the shared Bucket/)).toBeVisible();
  expect(screen.queryByText(/Private to your account/)).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Saved configurations" }).parentElement,
  ).toHaveClass("mb-6", "min-w-0");
  const select = screen.getByRole("combobox", { name: "Load configuration" });
  expect(select).toHaveClass("w-full", "min-w-0", "max-w-full", "truncate");
  expect(await screen.findByRole("option", { name: /bbbbbbbb/ })).toHaveTextContent(
    name.trim(),
  );
});
