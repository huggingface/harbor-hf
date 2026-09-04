import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type LeaderboardCandidates,
  type LeaderboardReviewInput,
  type LeaderboardSubmissionInput,
  type LeaderboardSubmissions,
  request,
} from "./api";
import { useControlState } from "./control-state";
import { PageHeader } from "./layout";
import { formatDate, humanize } from "./lib";
import { Badge, Button, Card, ErrorNotice, Loading } from "./ui";

type Candidate = LeaderboardCandidates["items"][number];
type Submission = LeaderboardSubmissions["items"][number];
const base = "/api/v1/leaderboard";
const listKey = ["leaderboard-submissions"];

function ResultPreview({ candidate }: { candidate: Candidate }) {
  return (
    <details className="my-4 rounded-lg border border-slate-800 p-3" open>
      <summary className="cursor-pointer text-sm font-medium text-slate-200">
        Exact public leaderboard fields
      </summary>
      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        {Object.entries(candidate.public_row).map(([key, value]) => (
          <div key={key} className="min-w-0">
            <dt className="text-xs text-slate-500">{humanize(key)}</dt>
            <dd className="break-all text-slate-200">{String(value)}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Review({
  item,
  candidate,
  onChanged,
}: {
  item: Submission;
  candidate: Candidate | undefined;
  onChanged: () => void;
}) {
  const { writesAllowed } = useControlState();
  const [consent, setConsent] = useState(false);
  const mutation = useMutation({
    mutationFn: (decision: "approved" | "rejected") => {
      const body: LeaderboardReviewInput = {
        decision,
        confirmed: true,
        ...(decision === "approved" ? { public_metadata_confirmed: true } : {}),
      };
      return request(`${base}/submissions/${encodeURIComponent(item.id)}/review`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: onChanged,
  });
  return (
    <div className="mt-4 border-t border-slate-800 pt-4">
      {candidate ? (
        <ResultPreview candidate={candidate} />
      ) : (
        <p className="text-sm text-amber-300">
          The exact submitted result is no longer eligible or available. Approval is
          disabled.
        </p>
      )}
      <label className="my-4 flex items-start gap-3 text-sm text-slate-300">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        I reviewed every field above. Consent covers these exact values on the public
        leaderboard, with no unapproved personal or private information.
      </label>
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={!candidate || !consent || !writesAllowed || mutation.isPending}
          onClick={() => {
            if (
              window.confirm(
                "Approve and publish these exact fields on the public leaderboard?",
              )
            )
              mutation.mutate("approved");
          }}
        >
          Approve & publish
        </Button>
        <Button
          variant="secondary"
          disabled={!writesAllowed || mutation.isPending}
          onClick={() => {
            if (
              window.confirm("Reject this submission? This decision cannot be edited.")
            )
              mutation.mutate("rejected");
          }}
        >
          Reject
        </Button>
      </div>
      {mutation.error ? <ErrorNotice error={mutation.error} /> : null}
    </div>
  );
}

export function SubmissionsPage() {
  const { actor, writeMode } = useControlState();
  const client = useQueryClient();
  const [selected, setSelected] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState("");
  const candidates = useQuery({
    queryKey: ["leaderboard-candidates"],
    queryFn: () => request<LeaderboardCandidates>(`${base}/candidates`),
  });
  const submissions = useQuery({
    queryKey: listKey,
    queryFn: () => request<LeaderboardSubmissions>(`${base}/submissions`),
    refetchInterval: 20_000,
  });
  const candidate = candidates.data?.items.find(
    (item) => item.catalog_digest === selected,
  );
  const refresh = () => {
    void client.invalidateQueries({ queryKey: listKey });
    void client.invalidateQueries({ queryKey: ["leaderboard"] });
  };
  const submit = useMutation({
    mutationFn: (candidate: Candidate) => {
      const body: LeaderboardSubmissionInput = {
        run_id: candidate.run_id,
        catalog_digest: candidate.catalog_digest,
        confirmed: true,
      };
      return request<Submission>(`${base}/submissions`, {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: (result) => {
      setMessage(
        result.status === "pending"
          ? "Submitted for admin review. Nothing has been published yet."
          : `This result was already ${result.status}.`,
      );
      setConfirmed(false);
      refresh();
    },
  });
  const operator = actor.role === "operator";
  const canSubmit = actor.role !== "reader" && writeMode !== "disabled";
  return (
    <>
      <PageHeader
        title={operator ? "Leaderboard submissions" : "Submit your results"}
        description="Share a completed hosted result for admin review. Submission does not publish it or launch another run."
      />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <h2 className="text-lg font-semibold">1. Choose a result</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            No Bucket token is needed. Only complete, clean hosted results eligible for
            the leaderboard appear here. External bundle uploads are not available yet.
          </p>
          {candidates.isPending ? (
            <Loading />
          ) : candidates.error ? (
            <ErrorNotice
              error={candidates.error}
              retry={() => void candidates.refetch()}
            />
          ) : !candidates.data?.items.length ? (
            <p className="mt-5 rounded-lg border border-dashed border-slate-700 p-5 text-sm text-slate-400">
              No eligible hosted results are associated with this account. Results must
              have been launched under this HF identity. Smoke and diagnostic results do
              not qualify.
            </p>
          ) : (
            <>
              <label className="mt-5 block text-sm">
                Hosted result
                <select
                  className="mt-2 w-full min-w-0 rounded-lg border border-slate-700 bg-slate-950 p-3"
                  value={selected}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    setConfirmed(false);
                    setMessage("");
                  }}
                >
                  <option value="">Choose a result…</option>
                  {candidates.data.items.map((item) => (
                    <option key={item.catalog_digest} value={item.catalog_digest}>
                      {item.public_row.model} · {item.public_row.benchmark} ·{" "}
                      {item.run_id}
                    </option>
                  ))}
                </select>
              </label>
              {candidate ? <ResultPreview candidate={candidate} /> : null}
              <label className="my-5 flex items-start gap-3 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                I consent to sharing these exact fields publicly if an administrator
                approves this submission.
              </label>
              <Button
                disabled={!candidate || !confirmed || !canSubmit || submit.isPending}
                onClick={() => {
                  if (candidate) submit.mutate(candidate);
                }}
              >
                {submit.isPending ? "Submitting…" : "Submit for review"}
              </Button>
            </>
          )}
          {!canSubmit ? (
            <p className="mt-3 text-sm text-amber-300">
              {actor.role === "reader"
                ? "Reader accounts cannot submit results."
                : "Submissions are temporarily disabled."}
            </p>
          ) : null}
          {message ? (
            <p className="mt-4 text-sm text-cyan-300" role="status">
              {message}
            </p>
          ) : null}
          {submit.error ? <ErrorNotice error={submit.error} /> : null}
        </Card>
        <section className="min-w-0 space-y-4" aria-label="Submission history">
          <div>
            <h2 className="text-lg font-semibold">
              {operator ? "2. Review submissions" : "2. Track your submissions"}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Pending → admin review → approved or rejected.
            </p>
          </div>
          {submissions.isPending ? (
            <Loading />
          ) : submissions.error ? (
            <ErrorNotice
              error={submissions.error}
              retry={() => void submissions.refetch()}
            />
          ) : !submissions.data?.items.length ? (
            <Card>
              <p className="text-sm text-slate-400">
                No submissions yet. Your review history will appear here.
              </p>
            </Card>
          ) : (
            submissions.data.items.map((item) => (
              <Card key={item.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="break-all font-medium">{item.run_id}</h3>
                    <p className="mt-1 text-xs text-slate-500">
                      Submitted {formatDate(item.created_at)}
                    </p>
                  </div>
                  <Badge
                    status={
                      item.status === "approved"
                        ? "ready"
                        : item.status === "rejected"
                          ? "failed"
                          : "pending"
                    }
                  >
                    {humanize(item.status)}
                  </Badge>
                </div>
                <p className="mt-3 break-all font-mono text-xs text-slate-500">
                  {item.catalog_digest}
                </p>
                {operator && item.status === "pending" ? (
                  <Review
                    item={item}
                    candidate={candidates.data?.items.find(
                      (candidate) =>
                        candidate.catalog_digest === item.catalog_digest &&
                        candidate.publication_id === item.publication_id,
                    )}
                    onChanged={refresh}
                  />
                ) : null}
              </Card>
            ))
          )}
        </section>
      </div>
    </>
  );
}
