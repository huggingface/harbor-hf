import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Route, Routes, useLocation } from "react-router-dom";
import { ApiError, signOut, type SessionResponse } from "./api";
import { ControlStateProvider, type DisplayActor } from "./control-state";
import { Layout } from "./layout";
import {
  AuditPage,
  CampaignPage,
  CampaignsPage,
  EndpointsPage,
  JobsPage,
  NotFoundPage,
  OverviewPage,
  ProfilesPage,
  ResultPage,
  ResultsPage,
  TaskPage,
} from "./pages";
import { keys, useLiveUpdates, useSession, useSystem } from "./queries";
import { Button, Card, ErrorNotice, Loading } from "./ui";

function AuthenticatedApp({
  actor,
  expiresAt,
  sessionError,
}: {
  actor: DisplayActor;
  expiresAt?: string | undefined;
  sessionError: unknown;
}) {
  const client = useQueryClient();
  const system = useSystem();
  const live = useLiveUpdates(true);
  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      client.setQueryData<SessionResponse>(keys.session, {
        authenticated: false,
        login_url: "/auth/login",
      });
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== "session" });
    },
  });
  const writeMode = system.data?.write_mode ?? "unknown";
  return (
    <ControlStateProvider actor={actor} writeMode={writeMode}>
      <Layout
        actor={actor}
        writeMode={writeMode}
        live={live}
        sessionExpiresAt={expiresAt}
        serviceError={sessionError ?? system.error}
        onSignOut={() => logout.mutate()}
        signingOut={logout.isPending}
      >
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/campaigns/:campaignId" element={<CampaignPage />} />
          <Route path="/campaigns/:campaignId/tasks/:taskId" element={<TaskPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/endpoints" element={<EndpointsPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/results/:publicationId" element={<ResultPage />} />
          <Route path="/profiles" element={<ProfilesPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Layout>
    </ControlStateProvider>
  );
}

export default function App() {
  const session = useSession();
  const location = useLocation();
  if (session.isPending && !session.data)
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Loading />
      </div>
    );

  const unauthorized =
    (session.error instanceof ApiError && session.error.status === 401) ||
    session.data?.authenticated === false;
  if (unauthorized) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100">
        <Card className="max-w-md text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-cyan-400 text-xl font-black text-slate-950">
            H
          </div>
          <h1 className="mt-5 text-xl font-semibold">Harbor-HF Control</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Your session expired, was revoked, or was lost during a service restart.
            Sign in again to continue on this page.
          </p>
          <a
            className="mt-6 inline-block"
            href={`/auth/login?return_to=${encodeURIComponent(returnTo)}`}
          >
            <Button>Sign in with Hugging Face</Button>
          </a>
        </Card>
      </main>
    );
  }

  if (!session.data?.authenticated || !session.data.actor) {
    const error =
      session.error ?? new Error("The control service could not verify your session.");
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100">
        <div className="w-full max-w-xl">
          <ErrorNotice error={error} retry={() => void session.refetch()} />
          <p className="mt-4 text-center text-sm text-slate-500">
            A temporary failure does not end an existing 12-hour session.
          </p>
        </div>
      </main>
    );
  }

  return (
    <AuthenticatedApp
      actor={session.data.actor}
      expiresAt={session.data.expires_at}
      sessionError={session.error}
    />
  );
}
