// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api";
import { ErrorNotice } from "../src/ui";

describe("ErrorNotice", () => {
  it("shows the API code, status, and detailed validation message", () => {
    render(
      <ErrorNotice
        error={
          new ApiError(
            400,
            "invalid_request",
            "the request is invalid:\n✖ Invalid string\n  → at model.provider",
          )
        }
      />,
    );

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("model.provider");
    expect(notice).toHaveTextContent("Code: invalid_request · HTTP 400");
  });
});
