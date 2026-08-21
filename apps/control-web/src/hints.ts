export const hints = {
  nav: {
    overview:
      "Queue, active runs, recorded spend, and Endpoint cleanup risk from the control projection.",
    campaigns:
      "Start and inspect runs. Logical tasks stay sealed; only infrastructure failures can be replaced.",
    jobs: "Hugging Face Jobs launched by control, with Hub inspect links, latest observed stage, and recorded hardware cost.",
    endpoints:
      "Inference Endpoints owned by runs. Completion requires a verified pause with zero ready replicas.",
    results:
      "Published catalog scores after runs finish. Open a result for pass rate CIs, token cost, publication identity, and the Bucket prefix. This is not the live run queue.",
    profiles:
      "Immutable benchmark, model, harness, deployment, and launch-policy records. Runs lock aliases at submit time.",
    audit:
      "Append-only intents, receipts, actors, and integrity-relevant state changes.",
  },
  chrome: {
    liveUpdates:
      "The browser refreshes from the control API and event stream. This is a read view, not the durable Bucket.",
    writeMode:
      "Deployment safety switch. Disabled blocks new runs even for approved operators. Enabled is required for new runs.",
  },
  overview: {
    active:
      "Runs that are not completed or cancelled. Completed is green only when every sealed task scored complete. Completed with failures still counts as completed for this filter.",
    policyStops:
      "Runs in failed or manual-intervention state. The reconciler stopped and an operator must inspect the audit trail.",
    observedSpend:
      "Sum of recorded attempt receipts plus the latest Job and Sandbox hardware cost on each projected campaign.",
    unsafeEndpoints:
      "Endpoints that are not verified paused with zero ready replicas. A campaign cannot complete while any remain.",
    spendChart:
      "Observed cost per recent run, in USD, from oldest to newest. Reserved budget and the hard ceiling are tracked separately.",
    writeMode:
      "Whether this Space accepts operator mutations. Your OAuth role is checked separately from this switch.",
    sourceRevision: "Exact Harbor-HF git revision running in this Space.",
    projectedObjects:
      "How many immutable Bucket records the local SQLite projection currently indexes.",
    projectionFreshness:
      "Last successful replay from the Bucket into the disposable read view.",
  },
  launch: {
    benchmark:
      "Which Harbor job to run. This selects the task set and source. Harbor resolves the exact lock in a preparation Job when the deployment requires it.",
    model:
      "Locked model identity and revision the worker must call. The same benchmark with a different model is a different run.",
    harness:
      "Agent wrapper around the model: prompts, tools, and runtime settings. Code for a new harness belongs in a Harbor plugin, not here.",
    reasoning:
      "Reasoning effort locked onto the harness for this run. None means the agent does not request extra thinking.",
    deployment:
      "Where the model is served: Hugging Face Inference Providers, or a dedicated Inference Endpoint.",
    launch_policy:
      "Promoted admission, reservation, repair, and publication rules to lock for this run.",
    ceiling:
      "Hard spend stop for this run, entered in USD. Defaults to twice the estimated reservation until you edit it. Control refuses new reservations once reserved plus observed cost would exceed it.",
    confirmed:
      "Required acknowledgement that the resolved profiles, task count, estimated reservation, and ceiling are the run you intend to lock. After submit, that lock does not change.",
    logicalTasks:
      "Distinct tasks in the selected benchmark profile. One Hugging Face Job may cover several tasks.",
    modelRevision:
      "Content digest of the selected model profile. This value is what the campaign lock stores.",
    hardware:
      "Hugging Face Jobs flavor from the deployment profile, such as cpu-basic or cpu-upgrade.",
    attemptLimit:
      "max_infrastructure_attempts from the launch policy. Extra attempts are only for infrastructure failures, never to rerun a scored outcome.",
    estimatedReservation:
      "Launch-policy reservation times the expected execution Jobs, plus preparation Jobs when the deployment requires them. The hard ceiling must cover this amount.",
    hardCeiling: "The run spend cap you entered. Stored as integer microusd.",
    publicationRole:
      "How published results are classified: diagnostic (smoke), component (partial), or final (leaderboard-grade).",
    perJobReservation:
      "Amount reserved from the ceiling before each execution Job launches. Unused reservation is released when the Job ends.",
  },
  campaign: {
    identity:
      "Immutable campaign id. Open it to see the lock, logical tasks, Jobs, and recorded spend.",
    status:
      "Run lifecycle: queued, active, publishing, completed, or cancelled. Completed is green only when every sealed task scored complete. Completed with failures means the run finished, but at least one sealed task did not succeed. Cancelled means an operator stopped the run.",
    logicalTasks:
      "Terminal logical outcomes over the locked task count. Pending actions are in-flight Jobs, Sandboxes, or other control work.",
    observedCost:
      "All recorded sources for this campaign: attempt receipts plus the latest hardware cost on each Job and Sandbox. Reserved is money still held against the ceiling.",
    endpointCleanup:
      "Verified pause with zero ready replicas is required before the campaign can complete.",
    jobs: "Hugging Face Jobs launched for this campaign. Preparation and execution are separate Jobs when preparation is required.",
    outcome:
      "Sealed logical result for this task. Hover the badge for the exact meaning. Scored success is a verifier pass. Provider rejected the request means the inference API refused the locked call. Agent ended without a score means the agent loop finished without a pass. Infrastructure failures can be replaced; the other sealed failures cannot.",
    selectedAttempt:
      "The physical attempt chosen as the logical outcome. Infrastructure replacements create a new attempt.",
    inputDigest: "Digest of the locked task input. Retries must use this same input.",
    replacementEligible:
      "Whether this attempt may be replaced. Only infrastructure failures are eligible. Semantic outcomes stay sealed.",
    attemptCost:
      "Cost recorded on this attempt receipt, typically inference spend. Job hardware is counted on the Job receipt instead.",
    attemptRecorded: "When this immutable attempt receipt was written.",
    attemptMetrics: "Optional numeric metrics the worker attached to the receipt.",
  },
  jobs: {
    hfJob:
      "Remote Hugging Face Job id. Opens the Hub inspect page. Pending means control has not observed a remote id yet.",
    campaign: "Campaign that owns this Job.",
    action: "Latest control action for this Job: launch, observe, or cancel.",
    observed:
      "Latest Hub stage copied onto the action receipt, such as RUNNING or COMPLETED.",
    recorded: "When this latest Job observation was written.",
    cost: "Locked Job hardware cost from the latest observe or cancel receipt. Inference spend is on attempt receipts, not this row.",
  },
  endpoints: {
    endpoint: "Inference Endpoint id owned by a campaign.",
    campaign: "Campaign that requested this Endpoint.",
    desired: "State control asked for, usually paused after work finishes.",
    observed: "State last seen on the provider.",
    readyReplicas: "Serving replicas currently ready. Cleanup requires zero.",
    cleanup: "Verified only after a pause receipt reports zero ready replicas.",
    hourly: "Locked hourly rate while the Endpoint is active.",
  },
  results: {
    search: "Free-text filter over publication identity and display fields.",
    model: "Filter by locked model name.",
    benchmark: "Filter by locked benchmark name.",
    agent: "Filter by harness or agent wrapper name.",
    status: "Publication status: published, pending, or failed.",
    fromDate: "Include results published on or after this date.",
    throughDate: "Include results published on or before this date.",
    sort: "Field used to order the result list.",
    order: "Ascending or descending order for the sort field.",
    publication: "Stable publication identity for this normalized result.",
    modelBenchmark: "Locked model and benchmark names copied onto the catalog row.",
    primaryMetric: "Headline score and unit from the publication, usually mean reward.",
    passRate:
      "Complete sealed tasks over the locked task count, with a Wilson 95% confidence interval.",
    tokenCost:
      "Sum of selected-attempt inference receipts. The 95% interval is a Wald interval on the per-task mean.",
    observedCost:
      "Attempt receipts plus recorded Job and Sandbox hardware for the source campaign.",
    outputs:
      "Hugging Face Bucket prefix for this publication's receipt and generated result objects. Opens the Hub browser. The Space never sends the Bucket credential to the browser.",
    hfUri: "hf:// URI for the same Bucket prefix, for CLI and SDK tools.",
    taskId: "Locked task identity. Opens the campaign task page.",
    taskOutcome: "Sealed outcome of the selected attempt.",
    taskReward: "Harbor reward on the selected attempt, usually 0 or 1.",
    taskCost: "Inference receipt for the selected attempt, in USD.",
    taskTokens: "Prompt and completion tokens recorded on the selected attempt.",
    scoredTasks:
      "How many locked tasks contributed a score, over the locked task count.",
    state: "Whether this publication is published, pending, or failed.",
    published: "When the catalog row was written.",
  },
  profiles: {
    name: "Profile alias and content-derived profile id.",
    kind: "benchmark, model, harness, deployment, or launch_policy.",
    source: "Whether this record is built-in source or an imported promotion.",
    approval: "Whether operators may select this alias when creating a campaign.",
    aliases: "Approved names that resolve to this immutable profile.",
  },
  audit: {
    time: "When the immutable record was written.",
    record: "Record kind, such as an action intent, receipt, or budget event.",
    identity: "Stable record or action id.",
    digest: "Content digest of the stored object, when present.",
  },
} as const;
