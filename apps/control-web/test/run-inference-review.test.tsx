// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import * as api from "../src/api";
import { ControlStateProvider } from "../src/control-state";
import { RunInferenceAccess } from "../src/run-inference-review";
const runId = `run-${"a".repeat(24)}`;
const review: api.RunInferenceReview = {
  schema_version: "v1",
  run_id: runId,
  approval_required: true,
  revision: 2,
  review_id: "c".repeat(64),
  expires_at: "2099-01-01T00:00:00Z",
  ref: "INFERENCE_API_KEY_EXAMPLE",
  source_env: "MY_SECRET_KEY",
  label: "Example inference",
  presence: "configured",
  grant: {
    operator_subjects: ["synthetic-operator"],
    worker_image: `example.invalid/worker@sha256:${"b".repeat(64)}`,
    agent_import_path: "harbor_hf_agents.command.agent:CommandAgent",
    recipe_digest: "a".repeat(64),
    destination_env: ["EXAMPLE_API_KEY"],
    route_api: "native",
    base_url: null,
    allowed_hosts: [],
    allowed_models: ["example:native"],
  },
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount(
  role: "operator" | "reader" = "operator",
  mode: "enabled" | "disabled" = "enabled",
) {
  const preview = vi.spyOn(api, "reviewRunInference").mockResolvedValue(review);
  const approve = vi
    .spyOn(api, "approveInferenceBinding")
    .mockResolvedValue({ schema_version: "v1", revision: 3, bindings: [] });
  const onReview = vi.fn();
  const view = (id = runId, disabled = false) => (
    <ControlStateProvider
      actor={{ username: "synthetic-operator", role, transport: "session" }}
      writeMode={mode}
    >
      <RunInferenceAccess runId={id} disabled={disabled} onReview={onReview} />
    </ControlStateProvider>
  );
  const rendered = render(view());
  return { preview, approve, onReview, ...rendered, view };
}
const previewButton = () =>
  screen.getByRole("button", { name: "Review inference access for this run" });
const approveButton = () =>
  screen.getByRole("button", { name: "Approve this image for the existing scope" });
it("reviews the run without a browser recipe and explicitly saves exact existing policy", async () => {
  const { preview, approve, onReview } = mount();
  fireEvent.click(previewButton());
  await screen.findByText(/Only the worker image changes/);
  expect(preview).toHaveBeenCalledWith(runId);
  expect(onReview).toHaveBeenCalledOnce();
  expect(approve).not.toHaveBeenCalled();
  expect(screen.getByText(/Current worker image:/)).toHaveTextContent(
    review.grant.worker_image,
  );
  expect(screen.getByText(/Operator:/)).toHaveTextContent("synthetic-operator");
  fireEvent.click(approveButton());
  await screen.findByText(
    "Inference access approved. Review replacements next; nothing was launched.",
  );
  expect(approve).toHaveBeenCalledWith(review.ref, {
    expected_revision: 2,
    review_id: review.review_id,
    reviewed_confirmation: true,
    reason: "Reviewed existing run inference scope for current worker image",
  });
  expect(
    screen.queryByRole("button", { name: /Approve this image/ }),
  ).not.toBeInTheDocument();
});
it("skips renewed approval when the current exact grant is already valid", async () => {
  const { preview, approve } = mount();
  preview.mockResolvedValue({ ...review, approval_required: false });
  fireEvent.click(previewButton());
  await screen.findByText(/already approved for this configuration/);
  expect(approve).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: /Approve this image/ }),
  ).not.toBeInTheDocument();
});
it.each([403, 409, 503])(
  "gives actionable review failure without raw API error: %s",
  async (status) => {
    const { preview } = mount();
    preview.mockRejectedValue(
      new api.ApiError(status, "inference_registry_error", "private details"),
    );
    fireEvent.click(previewButton());
    await screen.findByRole("status");
    expect(screen.queryByText(/private details|ApiError/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      status === 403 ? "original binding owner" : "Refresh this run",
    );
  },
);
it("requires fresh review after uncertain save and does not automatically retry", async () => {
  const { approve } = mount();
  approve.mockRejectedValue(new Error("network"));
  fireEvent.click(previewButton());
  await screen.findByText(/Only the worker image changes/);
  fireEvent.click(approveButton());
  await screen.findByText(/Approval is unconfirmed/);
  expect(approve).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("button", { name: /Approve this image/ }),
  ).not.toBeInTheDocument();
});
it.each(["run", "disabled"])(
  "discards late preview after %s changes",
  async (field) => {
    const { preview, rerender, view } = mount();
    let resolve!: (value: api.RunInferenceReview) => void;
    preview.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(previewButton());
    rerender(
      view(field === "run" ? `run-${"b".repeat(24)}` : runId, field === "disabled"),
    );
    await act(async () => resolve(review));
    expect(
      screen.queryByRole("button", { name: /Approve this image/ }),
    ).not.toBeInTheDocument();
  },
);
it("rejects a preview for another run", async () => {
  const { preview } = mount();
  preview.mockResolvedValue({ ...review, run_id: "other" });
  fireEvent.click(previewButton());
  await screen.findByText(/Refresh this run/);
});
it("expires review and refuses saving", async () => {
  const { preview, approve } = mount();
  preview.mockResolvedValue({ ...review, expires_at: "2000-01-01T00:00:00Z" });
  fireEvent.click(previewButton());
  await screen.findByText(/Review expired/);
  expect(approveButton()).toBeDisabled();
  expect(approve).not.toHaveBeenCalled();
});
it.each([
  ["reader", "enabled"],
  ["operator", "disabled"],
] as const)("requires %s and %s authority", (role, mode) => {
  const { preview } = mount(role, mode);
  expect(previewButton()).toBeDisabled();
  expect(preview).not.toHaveBeenCalled();
});
