import { useEffect, useId, useState } from "react";
import { type NativeObject, object, setField } from "./launch-draft";
export const inputClass =
  "w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100";
export const buttonClass =
  "rounded border border-slate-600 px-3 py-2 text-sm disabled:opacity-40";
export type InvalidChange = (id: string, invalid: boolean) => void;

export function JsonInput({
  label,
  value,
  onChange,
  invalid,
  rows = 6,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  invalid: InvalidChange;
  rows?: number;
}) {
  const id = useId();
  const serialized = JSON.stringify(value, null, 2) ?? "";
  const [text, setText] = useState(serialized);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (error) return;
    setText(serialized);
    invalid(id, false);
  }, [serialized, id, invalid, error]);
  useEffect(() => () => invalid(id, false), [id, invalid]);
  return (
    <div className="block space-y-1 text-sm">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className={inputClass}
        rows={rows}
        value={text}
        aria-invalid={error}
        aria-describedby={error ? `${id}-error` : undefined}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed: unknown = JSON.parse(next);
            onChange(parsed);
            setError(false);
            invalid(id, false);
          } catch {
            setError(true);
            invalid(id, true);
          }
        }}
      />
      {error && (
        <span id={`${id}-error`} role="alert" className="text-red-400">
          Invalid JSON or value type. Validation and launch are blocked.
        </span>
      )}
    </div>
  );
}

function resolvedSchema(schema: NativeObject, root: NativeObject): NativeObject {
  const ref = schema.$ref;
  if (typeof ref === "string" && ref.startsWith("#/$defs/"))
    return object(object(root.$defs)[ref.slice(8)]);
  return schema;
}

export function SchemaFields({
  schema,
  value,
  onChange,
  invalid,
  fields,
}: {
  schema: NativeObject;
  value: NativeObject;
  onChange: (value: NativeObject) => void;
  invalid: InvalidChange;
  fields?: string[];
}) {
  const properties = object(schema.properties);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Object.entries(properties)
        .filter(([key]) => !fields || fields.includes(key))
        .map(([key, source]) => {
          let property = resolvedSchema(object(source), schema);
          const choices = Array.isArray(property.anyOf)
            ? property.anyOf.map((item) => resolvedSchema(object(item), schema))
            : [property];
          const nullable = choices.some((item) => item.type === "null");
          property = choices.find((item) => item.type !== "null") ?? property;
          const type = property.type;
          const current = value[key];
          const options = Array.isArray(property.enum) ? property.enum : null;
          const update = (next: unknown) => onChange(setField(value, key, next));
          const label = typeof property.title === "string" ? property.title : key;
          return (
            <div key={key} className="space-y-1">
              <div className="block text-sm">
                <span className="font-medium">{label}</span>
                <code className="ml-2 text-xs text-slate-500">{key}</code>
                {options ? (
                  <select
                    aria-label={label}
                    className={inputClass}
                    value={
                      current === undefined || current === null
                        ? ""
                        : JSON.stringify(current)
                    }
                    onChange={(event) =>
                      update(
                        event.target.value === ""
                          ? undefined
                          : JSON.parse(event.target.value),
                      )
                    }
                  >
                    <option value="">
                      Unset
                      {property.default !== undefined
                        ? ` (default: ${JSON.stringify(property.default)})`
                        : ""}
                    </option>
                    {options.map((option) => (
                      <option
                        key={JSON.stringify(option)}
                        value={JSON.stringify(option)}
                      >
                        {String(option)}
                      </option>
                    ))}
                  </select>
                ) : type === "boolean" ? (
                  <select
                    aria-label={label}
                    className={inputClass}
                    value={current === true ? "true" : current === false ? "false" : ""}
                    onChange={(event) =>
                      update(
                        event.target.value === ""
                          ? undefined
                          : event.target.value === "true",
                      )
                    }
                  >
                    <option value="">
                      Unset (default: {String(property.default ?? "native")})
                    </option>
                    <option value="true">True</option>
                    <option value="false">False</option>
                  </select>
                ) : type === "string" || type === "integer" || type === "number" ? (
                  <input
                    aria-label={label}
                    className={inputClass}
                    type={type === "string" ? "text" : "number"}
                    step={type === "integer" ? 1 : "any"}
                    value={
                      current === null || current === undefined ? "" : String(current)
                    }
                    placeholder={
                      property.default === undefined
                        ? "Unset"
                        : `Default: ${String(property.default)}`
                    }
                    onChange={(event) =>
                      update(
                        type === "string"
                          ? event.target.value
                          : event.target.value === ""
                            ? undefined
                            : Number(event.target.value),
                      )
                    }
                  />
                ) : null}
              </div>
              {!["string", "integer", "number", "boolean"].includes(String(type)) &&
                !options && (
                  <JsonInput
                    label={`${label} JSON`}
                    value={current ?? property.default ?? (type === "array" ? [] : {})}
                    onChange={update}
                    invalid={invalid}
                    rows={3}
                  />
                )}
              <div className="flex gap-2 text-xs">
                <button type="button" onClick={() => update(undefined)}>
                  Unset
                </button>
                {nullable && (
                  <button type="button" onClick={() => update(null)}>
                    Set null
                  </button>
                )}
                <span>
                  {current === undefined ? "Unset" : current === null ? "Null" : "Set"}
                </span>
              </div>
              {typeof property.description === "string" && (
                <p className="text-xs text-slate-400">{property.description}</p>
              )}
            </div>
          );
        })}
    </div>
  );
}
