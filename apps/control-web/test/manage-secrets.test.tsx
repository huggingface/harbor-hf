// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
  return { user, view };
}
const saveButton = () => screen.getByRole("button", { name: "Save binding" });
const previewButton = () =>
  screen.getByRole("button", { name: "Preview binding scope" });
async function requestPreview() {
  await userEvent.click(previewButton());
}
async function preview() {
  await requestPreview();
  return screen.findByRole("region", { name: "Binding scope" });
}
async function poll(interval: ReturnType<typeof vi.spyOn>) {
  await act(async () => {
    const callback = interval.mock.calls.find((call) => call[1] === 30000)?.[0];
    if (typeof callback === "function") callback();
  });
}
it("registers an existing name only with optional label and a generated audit reason", async () => {
  const { user } = await open();
  await user.type(screen.getByLabelText("Space secret name"), "bad-name");
  expect(screen.getByRole("button", { name: "Register secret name" })).toBeDisabled();
  await user.clear(screen.getByLabelText("Space secret name"));
  await user.type(screen.getByLabelText("Space secret name"), "MY_SECRET_KEY");
  await user.click(screen.getByRole("button", { name: "Register secret name" }));
  expect(api.registerInferenceBinding).toHaveBeenCalledWith({
    expected_revision: 1,
    source_env: "MY_SECRET_KEY",
    label: "Inference secret",
    reason: "Register existing Space secret name for explicit binding selection.",
  });
  expect(document.querySelector("input[type=password]")).toBeNull();
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});
it("displays a read-only exact scope, then saves with one explicit consent action", async () => {
  const { user } = await open();
  await preview();
  expect(api.reviewInferenceBinding).toHaveBeenCalledWith(ref, {
    expected_revision: 1,
    recipe,
    model_name: "example:model",
    base_url: null,
    allowed_hosts: [],
  });
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
  expect(screen.getByText(/MY_SECRET_KEY → EXAMPLE_API_KEY/)).toBeInTheDocument();
  expect(screen.getByText(/Worker image:/)).toHaveTextContent(
    review.grant.worker_image,
  );
  expect(screen.getByText(/Model: example:model · Route: native/)).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Binding needs saving.");
  const reason = screen.getByText(/^Save binding: use/).textContent;
  const saved = {
    ...registry,
    revision: 2,
    bindings: registry.bindings.map((binding) => ({
      ...binding,
      grants: [review.grant],
    })),
  };
  vi.mocked(api.getInferenceBindings).mockResolvedValue(saved);
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue({ ...review, revision: 2 });
  await user.click(saveButton());
  expect(api.approveInferenceBinding).toHaveBeenCalledWith(ref, {
    expected_revision: 1,
    review_id: review.review_id,
    reviewed_confirmation: true,
    reason,
  });
  await preview();
  await screen.findByText("Binding saved for this scope.");
  expect(saveButton()).toBeDisabled();
  await user.click(saveButton());
  expect(api.approveInferenceBinding).toHaveBeenCalledTimes(1);
});
it("does not review or approve on closed render; opening and refreshing do not allocate tickets", async () => {
  const interval = vi.spyOn(window, "setInterval");
  const user = userEvent.setup();
  render(
    <ManageSecrets recipe={recipe} model="example:model" onDiscovery={onDiscovery} />,
  );
  await poll(interval);
  expect(api.reviewInferenceBinding).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Manage secrets" }));
  await preview();
  await user.click(screen.getByRole("button", { name: "Refresh secret registry" }));
  await preview();
  await poll(interval);
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});
it.each([409, 400, 503, 0])(
  "blocks approval failure %i without automatic retries",
  async (status) => {
    vi.mocked(api.approveInferenceBinding).mockRejectedValue(
      new api.ApiError(status, "test", "test"),
    );
    const interval = vi.spyOn(window, "setInterval");
    const { user } = await open();
    await preview();
    await user.click(saveButton());
    expect(screen.getByRole("alert")).toHaveTextContent(
      status === 409 ? "Conflict" : status === 400 ? "rejected" : "may have succeeded",
    );
    expect(saveButton()).toBeDisabled();
    await user.click(screen.getByText("Advanced connection settings"));
    await user.type(screen.getByLabelText("Declared hosts"), "example.com");
    await user.clear(screen.getByLabelText("Declared hosts"));
    expect(previewButton()).toBeDisabled();
    await poll(interval);
    expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(1);
    expect(api.approveInferenceBinding).toHaveBeenCalledTimes(1);
    expect(saveButton()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Refresh secret registry" }));
    await preview();
    expect(saveButton()).toBeEnabled();
    expect(api.approveInferenceBinding).toHaveBeenCalledTimes(1);
  },
);
it("blocks an expired preview at click time without approving or automatically reviewing again", async () => {
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue({
    ...review,
    expires_at: "2000-01-01T00:00:00Z",
  });
  const { user } = await open();
  await preview();
  await user.click(saveButton());
  expect(screen.getByRole("alert")).toHaveTextContent("expired");
  expect(saveButton()).toBeDisabled();
  expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(1);
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});
it.each(["recipe", "model", "context", "destination", "connection"])(
  "discards in-flight previews after %s edits",
  async (field) => {
    let finish: ((value: InferenceReviewV1) => void) | undefined;
    vi.mocked(api.reviewInferenceBinding).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { user, view } = await open();
    await requestPreview();
    await waitFor(() => expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(1));
    if (field === "connection") {
      await user.click(screen.getByText("Advanced connection settings"));
      await user.type(
        screen.getByLabelText("Credential base URL"),
        "https://example.com",
      );
    } else
      view.rerender(
        <ManageSecrets
          recipe={
            field === "recipe"
              ? { ...recipe, run_command: "echo edited" }
              : field === "destination"
                ? {
                    ...recipe,
                    environment: [
                      {
                        ...recipe.environment[0],
                        name: "OTHER_KEY",
                        source: "model_api_key",
                      },
                    ],
                  }
                : recipe
          }
          model={field === "model" ? "example:other" : "example:model"}
          context={field === "context" ? "other" : ""}
          onDiscovery={onDiscovery}
        />,
      );
    await act(async () => {
      finish?.(review);
    });
    expect(
      screen.queryByRole("region", { name: "Binding scope" }),
    ).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    expect(api.approveInferenceBinding).not.toHaveBeenCalled();
  },
);
it.each(["revision", "presence"])(
  "invalidates displayed and in-flight previews on registry %s changes",
  async (field) => {
    const interval = vi.spyOn(window, "setInterval");
    const { user } = await open();
    await preview();
    let finish: ((value: InferenceReviewV1) => void) | undefined;
    vi.mocked(api.reviewInferenceBinding).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await user.click(screen.getByText("Advanced connection settings"));
    await user.type(screen.getByLabelText("Declared hosts"), "example.com");
    await requestPreview();
    await waitFor(() => expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(2));
    vi.mocked(api.getInferenceBindings).mockResolvedValue(
      field === "revision"
        ? { ...registry, revision: 2 }
        : {
            ...registry,
            bindings: registry.bindings.map((binding) => ({
              ...binding,
              status: "configured",
            })),
          },
    );
    await poll(interval);
    await act(async () => {
      finish?.(review);
    });
    expect(saveButton()).toBeDisabled();
    expect(api.approveInferenceBinding).not.toHaveBeenCalled();
  },
);
it.each([
  "ref",
  "revision",
  "source",
  "recipe",
  "model",
  "route",
  "destinations",
  "url",
  "hosts",
])("blocks mismatched server %s before consent", async (field) => {
  const result = structuredClone(review);
  if (field === "ref") result.ref = "OTHER_REF";
  if (field === "revision") result.revision++;
  if (field === "source") result.source_env = "OTHER_KEY";
  if (field === "recipe") result.recipe.run_command = "echo changed";
  if (field === "model") result.grant.allowed_models = ["other:model"];
  if (field === "route") result.grant.route_api = "responses";
  if (field === "destinations") result.grant.destination_env = ["OTHER_KEY"];
  if (field === "url") result.grant.base_url = "https://example.com";
  if (field === "hosts") result.grant.allowed_hosts = ["example.com"];
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue(result);
  await open();
  await requestPreview();
  await screen.findByRole("alert");
  expect(saveButton()).toBeDisabled();
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});
it("recognizes existing exact grants across benign name edits but not image changes", async () => {
  vi.mocked(api.getInferenceBindings).mockResolvedValue({
    ...registry,
    bindings: registry.bindings.map((binding) => ({
      ...binding,
      grants: [review.grant],
    })),
  });
  const { view } = await open();
  await preview();
  await screen.findByText("Binding saved for this scope.");
  const renamed = { ...recipe, name: "Renamed" };
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue({
    ...review,
    recipe: renamed,
  });
  view.rerender(
    <ManageSecrets recipe={renamed} model="example:model" onDiscovery={onDiscovery} />,
  );
  await preview();
  await screen.findByText("Binding saved for this scope.");
  expect(saveButton()).toBeDisabled();
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue({
    ...review,
    recipe: renamed,
    grant: { ...review.grant, worker_image: `example/image@sha256:${"c".repeat(64)}` },
  });
  view.rerender(
    <ManageSecrets
      recipe={renamed}
      model="example:model"
      context="changed"
      onDiscovery={onDiscovery}
    />,
  );
  await preview();
  await screen.findByText("Binding needs saving.");
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});
it.each(["disabled", "mixed", "empty model"])(
  "does not review or approve %s selection",
  async (field) => {
    if (field === "disabled")
      vi.mocked(api.getInferenceBindings).mockResolvedValue({
        ...registry,
        bindings: registry.bindings.map((binding) => ({
          ...binding,
          enabled: false,
          status: "disabled",
        })),
      });
    const user = userEvent.setup();
    render(
      <ManageSecrets
        recipe={
          field === "mixed"
            ? {
                ...recipe,
                environment: [
                  ...recipe.environment,
                  { name: "SECOND_KEY", source: "model_api_key" },
                ],
              }
            : recipe
        }
        model={field === "empty model" ? "" : "example:model"}
        onDiscovery={onDiscovery}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Manage secrets" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(saveButton()).toBeDisabled();
    expect(api.reviewInferenceBinding).not.toHaveBeenCalled();
    expect(api.approveInferenceBinding).not.toHaveBeenCalled();
  },
);
it.each(["discovery", "review"])(
  "fails closed on reader-forbidden %s",
  async (operation) => {
    const error = new api.ApiError(403, "forbidden", "forbidden");
    if (operation === "discovery")
      vi.mocked(api.getInferenceBindings).mockRejectedValue(error);
    else vi.mocked(api.reviewInferenceBinding).mockRejectedValue(error);
    await open();
    if (operation === "review") await requestPreview();
    await screen.findByRole("alert");
    expect(saveButton()).toBeDisabled();
    expect(api.approveInferenceBinding).not.toHaveBeenCalled();
    expect(api.registerInferenceBinding).not.toHaveBeenCalled();
  },
);
it("keeps enable/disable and their reason under advanced controls", async () => {
  const { user } = await open();
  expect(
    screen.queryByRole("button", { name: "Disable Example inference" }),
  ).not.toBeVisible();
  await user.click(screen.getByText("Advanced reference controls"));
  expect(
    screen.getByRole("button", { name: "Disable Example inference" }),
  ).toBeDisabled();
  await user.type(screen.getByLabelText("Change reason"), "Disable this reference");
  await user.click(screen.getByRole("button", { name: "Disable Example inference" }));
  expect(api.setInferenceBindingStatus).toHaveBeenCalledWith(ref, {
    expected_revision: 1,
    enabled: false,
    reason: "Disable this reference",
  });
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});
it("ignores pending reviews after unmount", async () => {
  let finish: ((value: InferenceReviewV1) => void) | undefined;
  vi.mocked(api.reviewInferenceBinding).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { view } = await open();
  await requestPreview();
  await waitFor(() => expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(1));
  view.unmount();
  await act(async () => {
    finish?.(review);
  });
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});

it("does not resubmit or approve edited scope while a save is pending", async () => {
  let finish: (() => void) | undefined;
  vi.mocked(api.approveInferenceBinding).mockReturnValue(
    new Promise((resolve) => {
      finish = () => resolve(registry);
    }),
  );
  const { user, view } = await open();
  await preview();
  await user.dblClick(saveButton());
  expect(api.approveInferenceBinding).toHaveBeenCalledTimes(1);
  expect(saveButton()).toBeDisabled();
  const edited = { ...recipe, run_command: "echo new scope" };
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue({
    ...review,
    recipe: edited,
    grant: { ...review.grant, recipe_digest: "c".repeat(64) },
  });
  view.rerender(
    <ManageSecrets recipe={edited} model="example:model" onDiscovery={onDiscovery} />,
  );
  await act(async () => {
    finish?.();
  });
  await preview();
  await screen.findByText("Binding needs saving.");
  expect(api.approveInferenceBinding).toHaveBeenCalledTimes(1);
});
it("ignores obsolete review failures rather than blocking a newer form", async () => {
  let fail: ((reason: Error) => void) | undefined;
  vi.mocked(api.reviewInferenceBinding).mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  const { view } = await open();
  await requestPreview();
  await waitFor(() => expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(1));
  const edited = { ...recipe, name: "Renamed" };
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue({
    ...review,
    recipe: edited,
  });
  view.rerender(
    <ManageSecrets recipe={edited} model="example:model" onDiscovery={onDiscovery} />,
  );
  await preview();
  await act(async () => {
    fail?.(new Error("obsolete"));
  });
  expect(saveButton()).toBeEnabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("accepts explicit URL/host settings and multiple destinations of the same key", async () => {
  const expanded = {
    ...recipe,
    environment: [
      ...recipe.environment,
      { name: "SECOND_KEY", source: "model_api_key" as const, credential_ref: ref },
      { name: "MODEL_URL", source: "model_base_url" as const },
    ],
  };
  const result = {
    ...review,
    recipe: expanded,
    grant: {
      ...review.grant,
      destination_env: ["EXAMPLE_API_KEY", "SECOND_KEY"],
      base_url: "https://example.com",
      allowed_hosts: ["example.com"],
    },
  };
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue(result);
  const user = userEvent.setup();
  render(
    <ManageSecrets recipe={expanded} model="example:model" onDiscovery={onDiscovery} />,
  );
  await user.click(screen.getByRole("button", { name: "Manage secrets" }));
  await user.click(screen.getByText("Advanced connection settings"));
  await user.type(screen.getByLabelText("Credential base URL"), "https://example.com");
  await user.type(screen.getByLabelText("Declared hosts"), "example.com");
  await preview();
  await user.click(saveButton());
  expect(api.approveInferenceBinding).toHaveBeenCalledTimes(1);
});
it("refreshes read availability after a failure and discards older discoveries", async () => {
  let finish: ((value: InferenceBindingsV1) => void) | undefined;
  vi.mocked(api.getInferenceBindings)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockRejectedValueOnce(new Error("unavailable"));
  const { user } = await open();
  await user.click(screen.getByRole("button", { name: "Refresh secret registry" }));
  await screen.findByText(/Availability unavailable, not missing/);
  await act(async () => {
    finish?.(registry);
  });
  expect(saveButton()).toBeDisabled();
  expect(api.reviewInferenceBinding).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Refresh secret registry" }));
  await preview();
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});
it("requires explicit re-enable before reading a disabled reference's scope", async () => {
  vi.mocked(api.getInferenceBindings).mockResolvedValue({
    ...registry,
    bindings: registry.bindings.map((binding) => ({
      ...binding,
      enabled: false,
      status: "disabled",
    })),
  });
  const { user } = await open();
  await user.click(screen.getByText("Advanced reference controls"));
  await user.type(screen.getByLabelText("Change reason"), "Enable this reference");
  await user.click(screen.getByRole("button", { name: "Re-enable Example inference" }));
  expect(api.setInferenceBindingStatus).toHaveBeenCalledWith(ref, {
    expected_revision: 1,
    enabled: true,
    reason: "Enable this reference",
  });
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});

it("retains scope through unchanged polling even if JSON property order changes", async () => {
  const interval = vi.spyOn(window, "setInterval");
  await open();
  await preview();
  vi.mocked(api.getInferenceBindings).mockResolvedValue({
    revision: registry.revision,
    bindings: registry.bindings,
    schema_version: "v1",
  });
  await poll(interval);
  expect(screen.getByRole("region", { name: "Binding scope" })).toBeInTheDocument();
  expect(saveButton()).toBeEnabled();
  expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(1);
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});

it("does not allocate tickets on typing, opening, polling or unchanged refresh; reuses a valid preview", async () => {
  const interval = vi.spyOn(window, "setInterval");
  const { user, view } = await open();
  await user.click(screen.getByText("Advanced connection settings"));
  await user.type(screen.getByLabelText("Declared hosts"), "example.com");
  await user.clear(screen.getByLabelText("Declared hosts"));
  for (const model of ["e", "example:", "example:model"]) {
    view.rerender(
      <ManageSecrets recipe={recipe} model={model} onDiscovery={onDiscovery} />,
    );
  }
  await poll(interval);
  await user.click(screen.getByRole("button", { name: "Refresh secret registry" }));
  expect(api.reviewInferenceBinding).not.toHaveBeenCalled();
  await preview();
  await user.click(screen.getByRole("button", { name: "Manage secrets" }));
  await user.click(screen.getByRole("button", { name: "Manage secrets" }));
  await user.click(screen.getByRole("button", { name: "Refresh secret registry" }));
  await poll(interval);
  await preview();
  expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(1);
  expect(saveButton()).toBeEnabled();
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
});

it.each([400, 403, 409, 503])(
  "allows an explicit corrected-scope preview after review failure %i",
  async (status) => {
    vi.mocked(api.reviewInferenceBinding).mockRejectedValueOnce(
      new api.ApiError(status, "test", "test"),
    );
    const { view } = await open();
    await requestPreview();
    await screen.findByText(/Binding preview unavailable/);
    expect(saveButton()).toBeDisabled();
    expect(previewButton()).toBeEnabled();
    const edited = { ...recipe, run_command: "echo corrected" };
    view.rerender(
      <ManageSecrets recipe={edited} model="example:model" onDiscovery={onDiscovery} />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.reviewInferenceBinding).toHaveBeenCalledTimes(1);
    vi.mocked(api.reviewInferenceBinding).mockResolvedValue({
      ...review,
      recipe: edited,
    });
    await preview();
    expect(saveButton()).toBeEnabled();
    expect(api.approveInferenceBinding).not.toHaveBeenCalled();
  },
);

it("requires fresh displayed image scope and another explicit Save after expiry", async () => {
  const { user } = await open();
  await preview();
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(review.expires_at));
  await user.click(saveButton());
  expect(saveButton()).toBeDisabled();
  expect(previewButton()).toBeEnabled();
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
  now.mockRestore();
  const changed = {
    ...review,
    grant: { ...review.grant, worker_image: `example/image@sha256:${"c".repeat(64)}` },
  };
  vi.mocked(api.reviewInferenceBinding).mockResolvedValue(changed);
  await preview();
  expect(screen.getByText(/Worker image:/)).toHaveTextContent(
    changed.grant.worker_image,
  );
  expect(api.approveInferenceBinding).not.toHaveBeenCalled();
  await user.click(saveButton());
  expect(api.approveInferenceBinding).toHaveBeenCalledTimes(1);
});
