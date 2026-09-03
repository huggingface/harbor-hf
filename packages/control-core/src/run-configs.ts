import { canonicalJson, sha256 } from "@harbor-hf/contracts";

export interface ReviewedBenchmarkConfig {
  name: string;
  label: string;
  description: string;
  benchmark: string;
  model: string;
  harness_template: string;
  deployment: string;
  launch_policy: string;
  default_ceiling_microusd: number;
  max_ceiling_microusd: number;
  harness_policy: {
    type: "workbench";
    inference_apis: Array<"chat-completions" | "responses">;
    require_trajectory: boolean;
  };
}

export interface ResolvedBenchmarkConfig extends ReviewedBenchmarkConfig {
  revision: string;
}

const reviewedBenchmarkConfigs: readonly ReviewedBenchmarkConfig[] = [
  {
    name: "tb21-gpt-oss-20b-canary",
    label: "Terminal-Bench 2.1 canary · GPT-OSS 20B",
    description:
      "Two reviewed Terminal-Bench 2.1 canary tasks with direct chat-completions inference and diagnostic publication.",
    benchmark: "terminal-bench-2-1-canary",
    model: "gpt-oss-20b-together",
    harness_template: "fast-agent-0-10-16-command",
    deployment: "tb21-gpt-oss-20b-fast-agent-command-providers",
    launch_policy: "diagnostic-single-attempt",
    default_ceiling_microusd: 1_000_000,
    max_ceiling_microusd: 1_000_000,
    harness_policy: {
      type: "workbench",
      inference_apis: ["chat-completions"],
      require_trajectory: false,
    },
  },
];

function withRevision(config: ReviewedBenchmarkConfig): ResolvedBenchmarkConfig {
  return {
    ...structuredClone(config),
    revision: sha256(canonicalJson(config)),
  };
}

export function listReviewedBenchmarkConfigs(): ResolvedBenchmarkConfig[] {
  return reviewedBenchmarkConfigs.map(withRevision);
}

export function reviewedBenchmarkConfig(name: string): ResolvedBenchmarkConfig {
  const config = reviewedBenchmarkConfigs.find((candidate) => candidate.name === name);
  if (!config) throw new Error(`unknown benchmark configuration: ${name}`);
  return withRevision(config);
}
