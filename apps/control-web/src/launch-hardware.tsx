import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { paths } from "./generated/api";
import { inputClass } from "./launch-fields";

type Hardware =
  paths["/api/v1/hardware"]["get"]["responses"][200]["content"]["application/json"][number];

export function hardwarePrice(item: Hardware): string {
  if (item.unitCostUSD === null || item.unitCostUSD === undefined)
    return "Price unavailable";
  const hourly = item.unitLabel === "minute" || item.unitLabel === "hour";
  const amount = item.unitCostUSD * (item.unitLabel === "minute" ? 60 : 1);
  return `USD ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}/${hourly ? "hour" : item.unitLabel}`;
}

export function LaunchHardware({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const catalog = useQuery({
    queryKey: ["launch-hardware"],
    queryFn: () => api<Hardware[]>("/api/v1/hardware"),
    staleTime: 60_000,
  });
  const selected = catalog.data?.find((item) => item.name === value);
  return (
    <div>
      <label className="block text-sm">
        Sandbox flavor
        <select
          className={inputClass}
          value={value}
          disabled={catalog.isPending || catalog.isError}
          onChange={(event) => onChange(event.target.value)}
        >
          {!selected && (
            <option value={value} disabled>
              {value} (not verified in current catalog)
            </option>
          )}
          {catalog.data?.map((item) => (
            <option key={item.name} value={item.name}>
              {item.prettyName} · {hardwarePrice(item)}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <p className="text-sm text-slate-400">
          {selected.cpu} · {selected.ram} RAM · {selected.ephemeralStorage} storage
          {selected.accelerator && (
            <>
              {" "}
              · {selected.accelerator.quantity}× {selected.accelerator.model} (
              {selected.accelerator.vram})
            </>
          )}
          <br />
          {hardwarePrice(selected)} per sandbox. Concurrent sandboxes are billed
          separately.
        </p>
      )}
      {catalog.isPending && <p role="status">Loading HF hardware…</p>}
      {catalog.isError && (
        <p role="alert">
          HF hardware catalog unavailable.{" "}
          <button type="button" onClick={() => void catalog.refetch()}>
            Retry hardware lookup
          </button>
        </p>
      )}
      {!catalog.isPending && !catalog.isError && !selected && (
        <p role="alert">
          The selected flavor is not in the current HF catalog. Choose a listed flavor
          before launch.
        </p>
      )}
      <p className="text-sm text-slate-400">
        Hardware runs task tools and tests, not hosted model inference. Catalog entries
        do not guarantee quota or capacity.
      </p>
    </div>
  );
}
