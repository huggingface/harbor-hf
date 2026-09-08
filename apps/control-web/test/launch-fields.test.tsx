// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonInput, SchemaFields } from "../src/launch-fields";

afterEach(cleanup);
describe("native schema controls", () => {
  it("edits strings, integers, numbers, enums, booleans, arrays and referenced objects", () => {
    const onChange = vi.fn();
    const value = {
      text: "before",
      integer: 0,
      number: 0,
      choice: null,
      enabled: false,
      values: [],
      nested: {},
    };
    const schema = {
      properties: {
        text: { type: "string", title: "Text", description: "Native help" },
        integer: { type: "integer", default: 0 },
        number: { type: "number", default: 0.5 },
        choice: { anyOf: [{ $ref: "#/$defs/Choice" }, { type: "null" }] },
        enabled: { type: "boolean", default: false },
        values: { type: "array", default: [] },
        nested: { $ref: "#/$defs/Nested" },
        unknown: {},
      },
      $defs: {
        Choice: { type: "string", enum: ["low", "high"], default: "low" },
        Nested: { type: "object", title: "Nested" },
      },
    };
    render(
      <SchemaFields
        schema={schema}
        value={value}
        onChange={onChange}
        invalid={vi.fn()}
      />,
    );
    expect(screen.getByText("Native help")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, text: "" });
    fireEvent.change(screen.getByLabelText("integer"), { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, integer: 3 });
    fireEvent.change(screen.getByLabelText("integer"), { target: { value: "" } });
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("integer");
    fireEvent.change(screen.getByLabelText("number"), { target: { value: "0.25" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, number: 0.25 });
    fireEvent.change(screen.getByLabelText("choice"), { target: { value: '"high"' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, choice: "high" });
    fireEvent.change(screen.getByLabelText("choice"), { target: { value: "" } });
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("choice");
    fireEvent.change(screen.getByLabelText("enabled"), { target: { value: "true" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, enabled: true });
    fireEvent.change(screen.getByLabelText("enabled"), { target: { value: "" } });
    expect(onChange.mock.lastCall?.[0]).not.toHaveProperty("enabled");
    fireEvent.change(screen.getByLabelText("values JSON"), {
      target: { value: "[1,2]" },
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, values: [1, 2] });
    fireEvent.change(screen.getByLabelText("Nested JSON"), {
      target: { value: '{"custom":true}' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ ...value, nested: { custom: true } });
  });
  it("renders unset and default values without inserting them into kwargs", () => {
    const onChange = vi.fn();
    render(
      <SchemaFields
        schema={{
          properties: {
            enabled: { type: "boolean" },
            list: { type: "array" },
            ignored: { type: "string" },
          },
        }}
        value={{}}
        onChange={onChange}
        invalid={vi.fn()}
        fields={["enabled", "list"]}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("ignored")).toBeNull();
    expect((screen.getByLabelText("list JSON") as HTMLTextAreaElement).value).toBe(
      "[]",
    );
    fireEvent.change(screen.getByLabelText("enabled"), { target: { value: "false" } });
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false });
  });
  it("handles an unset JSON value and a parsed value rejected by its owner", () => {
    const invalid = vi.fn();
    render(
      <JsonInput
        label="Value"
        value={undefined}
        invalid={invalid}
        onChange={() => {
          throw new Error("wrong value type");
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "null" } });
    expect(invalid).toHaveBeenLastCalledWith(expect.any(String), true);
  });
});
