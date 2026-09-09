import { formatMoneyUsd } from "./lib";
import { Hint } from "./ui";

export function ExactValue({
  value,
  text,
  label,
}: {
  value: number | null;
  text: string;
  label: string;
}) {
  const exact = value === null ? `${label}: unavailable` : `${label}: ${value}`;
  return (
    <Hint text={exact}>
      <output
        aria-live="off"
        className="whitespace-nowrap tabular-nums"
        title={exact}
        aria-label={exact}
      >
        {text}
      </output>
    </Hint>
  );
}

export function CostValue({
  value,
  label = "Reported cost (USD)",
}: {
  value: number | null;
  label?: string;
}) {
  return (
    <ExactValue
      value={value}
      text={value === null ? "-" : formatMoneyUsd(value)}
      label={label}
    />
  );
}
