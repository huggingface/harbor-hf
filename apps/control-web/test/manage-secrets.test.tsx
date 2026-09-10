// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InferenceBindingsV1, InferenceReviewV1 } from "@harbor-hf/contracts";
import * as api from "../src/api";
import { ManageSecrets } from "../src/manage-secrets";

vi.mock("../src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof api>()),
  getInferenceBindings: vi.fn(),
  registerInferenceBinding: vi.fn(),
  setInferenceBindingStatus: vi.fn(),
  reviewInferenceBinding: vi.fn(),
  approveInferenceBinding: vi.fn(),
}));
const ref = "INFERENCE_API_KEY_EXAMPLE";
const recipe: api.WorkbenchRecipe = {
  schema_version: "v1",
  name: "Example",
  setup_command: "true",
  run_command: "true",
  route_api: "native",
  setup_timeout_seconds: 60,
  outputs: { results_path: "results.json", trajectory_path: null },
  environment: [
    { name: "EXAMPLE_API_KEY", source: "model_api_key" as const, credential_ref: ref },
  ],
};
const registry: InferenceBindingsV1 = {
  schema_version: "v1",
  revision: 1,
  bindings: [
    {
      ref,
      label: "Example inference",
      source_env: "MY_SECRET_KEY",
      enabled: true,
      status: "missing",
      grants: [],
    },
  ],
};
const review: InferenceReviewV1 = {
  schema_version: "v1",
  revision: 1,
  ref,
  review_id: "review-example",
  expires_at: "2099-01-01T00:00:00Z",
  source_env: "MY_SECRET_KEY",
  label: "Example inference",
  presence: "missing",
  recipe,
  grant: {
    operator_subjects: [],
    worker_image: `example/image@sha256:${"a".repeat(64)}`,
    agent_import_path: "example:Agent",
    recipe_digest: "b".repeat(64),
    destination_env: ["EXAMPLE_API_KEY"],
    route_api: "native",
    base_url: null,
    allowed_hosts: [],
    allowed_models: ["example:model"],
  },
};
const onDiscovery = vi.fn();
beforeEach(() => {
  vi.mocked(api.getInferenceBindings).mockResolvedValue(registry);
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue(review);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function open() {
  const user = userEvent.setup();
  const view = render(
    <ManageSecrets recipe={recipe} model="example:model" onDiscovery={onDiscovery} />,
  );
  await user.click(screen.getByRole("button", { name: "Manage secrets" }));
  await screen.findByText(/Example inference · MY_SECRET_KEY/);
  return { user, view };
}
it("registers names without values, rejects invalid syntax and uses the registry revision even when missing", async () => {
  const { user } = await open();
  await user.type(screen.getByLabelText("Space secret name"), "bad-name");
  await user.type(screen.getByLabelText("Friendly label"), "New reference");
  await user.type(screen.getByLabelText("Change reason"), "Reviewed registration");
  expect(screen.getByRole("button", { name: "Register reference" })).toBeDisabled();
  await user.clear(screen.getByLabelText("Space secret name"));
  await user.type(screen.getByLabelText("Space secret name"), "MY_SECRET_KEY");
  await user.click(screen.getByRole("button", { name: "Register reference" }));
  expect(api.registerInferenceBinding).toHaveBeenCalledWith({
    expected_revision: 1,
    source_env: "MY_SECRET_KEY",
    label: "New reference",
    reason: "Reviewed registration",
  });
  expect(document.querySelector("input[type=password]")).toBeNull();
});
it.each([409, 503, 0])(
  "blocks uncertain/status %i saves until explicit refresh, with no automatic retry",
  async (status) => {
    vi.mocked(api.setInferenceBindingStatus).mockRejectedValue(
      new api.ApiError(status, "test", "test"),
    );
    const { user } = await open();
    await user.type(screen.getByLabelText("Change reason"), "Reviewed status");
    await user.click(screen.getByRole("button", { name: "Disable Example inference" }));
    expect(api.setInferenceBindingStatus).toHaveBeenCalledWith(ref, {
      expected_revision: 1,
      enabled: false,
      reason: "Reviewed status",
    });
    expect(
      screen.getByRole("button", { name: "Disable Example inference" }),
    ).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      status === 409 ? "Conflict" : "may have succeeded",
    );
    await user.click(screen.getByRole("button", { name: "Refresh secret registry" }));
    expect(
      screen.getByRole("button", { name: "Disable Example inference" }),
    ).toBeEnabled();
    expect(api.setInferenceBindingStatus).toHaveBeenCalledTimes(1);
  },
);
it("reviews native key-only settings and requires confirmation plus reason for ephemeral approval", async () => {
  const { user } = await open();
  await user.click(screen.getByRole("button", { name: "Review credential use" }));
  expect(api.reviewInferenceBinding).toHaveBeenCalledWith(ref, {
    expected_revision: 1,
    recipe,
    model_name: "example:model",
    base_url: null,
    allowed_hosts: [],
  });
  expect(screen.getByRole("button", { name: "Approve credential use" })).toBeDisabled();
  await user.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Approve credential use" })).toBeDisabled();
  await user.type(screen.getByLabelText("Change reason"), "Reviewed exact use");
  await user.click(screen.getByRole("button", { name: "Approve credential use" }));
  expect(api.approveInferenceBinding).toHaveBeenCalledWith(ref, {
    expected_revision: 1,
    review_id: "review-example",
    reviewed_confirmation: true,
    reason: "Reviewed exact use",
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
it.each(["recipe", "model"])(
  "invalidates review and confirmation after %s edits",
  async (field) => {
    const { user, view } = await open();
    await user.click(screen.getByRole("button", { name: "Review credential use" }));
    await user.click(screen.getByRole("checkbox"));
    view.rerender(
      <ManageSecrets
        recipe={field === "recipe" ? { ...recipe, name: "Edited recipe" } : recipe}
        model={field === "model" ? "example:other" : "example:model"}
        onDiscovery={onDiscovery}
      />,
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  },
);
it("invalidates on registry polling changes and discards in-flight reviews after edits", async () => {
  const interval = vi.spyOn(window, "setInterval");
  const { user, view } = await open();
  await user.click(screen.getByRole("button", { name: "Review credential use" }));
  await user.click(screen.getByRole("checkbox"));
  vi.mocked(api.getInferenceBindings).mockResolvedValue({ ...registry, revision: 2 });
  await act(async () => {
    const callback = interval.mock.calls.find((call) => call[1] === 30000)?.[0];
    if (typeof callback === "function") callback();
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  vi.useRealTimers();
  let finish: ((value: InferenceReviewV1) => void) | undefined;
  vi.mocked(api.reviewInferenceBinding).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await user.click(screen.getByRole("button", { name: "Review credential use" }));
  view.rerender(
    <ManageSecrets recipe={recipe} model="example:changed" onDiscovery={onDiscovery} />,
  );
  await act(async () => {
    finish?.(review);
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("re-enables a disabled reference with the expected revision and requires a fresh review", async () => {
  vi.mocked(api.getInferenceBindings).mockResolvedValue({
    ...registry,
    revision: 4,
    bindings: registry.bindings.map((binding) => ({
      ...binding,
      enabled: false,
      status: "disabled",
    })),
  });
  const { user } = await open();
  expect(screen.getByRole("button", { name: "Review credential use" })).toBeDisabled();
  await user.type(screen.getByLabelText("Change reason"), "Reviewed reactivation");
  await user.click(screen.getByRole("button", { name: "Re-enable Example inference" }));
  expect(api.setInferenceBindingStatus).toHaveBeenCalledWith(ref, {
    expected_revision: 4,
    enabled: true,
    reason: "Reviewed reactivation",
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("invalidates confirmation when polling changes only key presence", async () => {
  const interval = vi.spyOn(window, "setInterval");
  const { user } = await open();
  await user.click(screen.getByRole("button", { name: "Review credential use" }));
  await user.click(screen.getByRole("checkbox"));
  vi.mocked(api.getInferenceBindings).mockResolvedValue({
    ...registry,
    bindings: registry.bindings.map((binding) => ({
      ...binding,
      status: "configured",
    })),
  });
  await act(async () => {
    const callback = interval.mock.calls.find((call) => call[1] === 30000)?.[0];
    if (typeof callback === "function") callback();
  });
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});

it("rejects mixed credentials including legacy HF rather than silently falling back", async () => {
  const view = render(
    <ManageSecrets
      recipe={{
        ...recipe,
        environment: [
          ...recipe.environment,
          { name: "SECOND_API_KEY", source: "model_api_key" },
        ],
      }}
      model="example:model"
      onDiscovery={onDiscovery}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Manage secrets" }));
  await screen.findByText(/Example inference · MY_SECRET_KEY/);
  expect(screen.getByRole("button", { name: "Review credential use" })).toBeDisabled();
  view.rerender(
    <ManageSecrets
      recipe={{
        ...recipe,
        environment: [
          ...recipe.environment,
          { name: "SECOND_API_KEY", source: "model_api_key", credential_ref: ref },
        ],
      }}
      model="example:model"
      onDiscovery={onDiscovery}
    />,
  );
  expect(screen.getByRole("button", { name: "Review credential use" })).toBeEnabled();
});
