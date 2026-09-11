// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { InferenceBindingsV1 } from "@harbor-hf/contracts";
import { InferenceBindingSelector } from "../src/inference-binding-selector";
import { getInferenceBindings } from "../src/api";

vi.mock("../src/api", () => ({ getInferenceBindings: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const response: InferenceBindingsV1 = {
  schema_version: "v1",
  revision: 1,
  bindings: [
    {
      ref: "INFERENCE_API_KEY_EXAMPLE",
      label: "Synthetic first",
      status: "configured",
      source_env: "MY_SECRET_KEY",
      enabled: true,
      grants: [],
    },
    {
      ref: "INFERENCE_API_KEY_SECOND",
      label: "Synthetic second",
      status: "disabled",
      source_env: "SECOND_KEY",
      enabled: false,
      grants: [],
    },
    {
      ref: "INFERENCE_API_KEY_MISSING",
      label: "Synthetic missing",
      status: "missing",
      source_env: "THIRD_KEY",
      enabled: true,
      grants: [],
    },
  ],
};

it("selects only a reference, retains unknown selection, and clears to the legacy HF binding", async () => {
  vi.mocked(getInferenceBindings).mockResolvedValue(response);
  const change = vi.fn();
  const view = render(
    <InferenceBindingSelector value={undefined} operator onChange={change} />,
  );
  const select = screen.getByRole("combobox");
  await screen.findByText("Registered: Synthetic first · MY_SECRET_KEY · configured");
  expect(
    screen.getByText("Registered: Synthetic second · SECOND_KEY · disabled"),
  ).toBeDisabled();
  const user = userEvent.setup();
  await user.selectOptions(select, "INFERENCE_API_KEY_MISSING");
  expect(change).toHaveBeenLastCalledWith("INFERENCE_API_KEY_MISSING");
  await user.selectOptions(select, "INFERENCE_API_KEY_EXAMPLE");
  expect(change).toHaveBeenLastCalledWith("INFERENCE_API_KEY_EXAMPLE");
  view.rerender(
    <InferenceBindingSelector
      value="INFERENCE_API_KEY_EXAMPLE"
      operator
      onChange={change}
    />,
  );
  await user.selectOptions(select, "");
  expect(change).toHaveBeenLastCalledWith(undefined);
  view.rerender(
    <InferenceBindingSelector
      value="INFERENCE_API_KEY_UNKNOWN"
      operator
      onChange={change}
    />,
  );
  expect(select).toHaveValue("INFERENCE_API_KEY_UNKNOWN");
  expect(screen.getByText("Selected reference unavailable")).toBeDisabled();
});

it("does not fetch for readers and resets on revoked operator access", async () => {
  vi.mocked(getInferenceBindings).mockResolvedValue(response);
  const view = render(
    <InferenceBindingSelector value={undefined} operator={false} onChange={vi.fn()} />,
  );
  expect(getInferenceBindings).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox")).toBeDisabled();
  view.rerender(
    <InferenceBindingSelector value={undefined} operator onChange={vi.fn()} />,
  );
  await screen.findByText("Registered: Synthetic first · MY_SECRET_KEY · configured");
  view.rerender(
    <InferenceBindingSelector value={undefined} operator={false} onChange={vi.fn()} />,
  );
  expect(
    screen.queryByText("Registered: Synthetic first · MY_SECRET_KEY · configured"),
  ).not.toBeInTheDocument();
});

it("distinguishes failed discovery from missing and ignores stale refreshes", async () => {
  let finish: ((value: InferenceBindingsV1) => void) | undefined;
  vi.mocked(getInferenceBindings)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockRejectedValueOnce(new Error("synthetic"));
  const view = render(
    <InferenceBindingSelector value={undefined} operator onChange={vi.fn()} />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Refresh availability" }));
  await screen.findByText("Availability unavailable (not missing).");
  await act(async () => {
    finish?.(response);
  });
  expect(
    screen.queryByText("Registered: Synthetic first · MY_SECRET_KEY · configured"),
  ).not.toBeInTheDocument();
  vi.mocked(getInferenceBindings).mockResolvedValueOnce({
    schema_version: "v1",
    revision: 1,
    bindings: [],
  });
  await user.click(screen.getByRole("button", { name: "Refresh availability" }));
  await screen.findByText("No registered provider references available.");
  vi.mocked(getInferenceBindings).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await user.click(screen.getByRole("button", { name: "Refresh availability" }));
  view.unmount();
  await act(async () => {
    finish?.(response);
  });
  await waitFor(() => expect(getInferenceBindings).toHaveBeenCalledTimes(4));
});

it("shared discovery stays metadata-only and never changes the selection on refresh", async () => {
  const change = vi.fn();
  const view = render(
    <InferenceBindingSelector
      value="INFERENCE_API_KEY_EXAMPLE"
      operator
      discovery={response}
      onChange={change}
    />,
  );
  expect(
    screen.getByText(/Selecting a secret does not save or authorize its use/),
  ).toBeInTheDocument();
  view.rerender(
    <InferenceBindingSelector
      value="INFERENCE_API_KEY_EXAMPLE"
      operator
      discovery={{ ...response, revision: 2 }}
      onChange={change}
    />,
  );
  expect(getInferenceBindings).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  view.rerender(
    <InferenceBindingSelector
      value="INFERENCE_API_KEY_EXAMPLE"
      operator={false}
      discovery={response}
      onChange={change}
    />,
  );
  expect(
    screen.queryByText("Registered: Synthetic first · MY_SECRET_KEY · configured"),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("combobox")).toBeDisabled();
});
