import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ApiError, signOut } from "./api";
import { ControlStateProvider, type DisplayActor } from "./control-state";
import { Layout, loginHref } from "./layout";
import {
  JobsPage,
  NotFoundPage,
  OverviewPage,
  RunPage,
  RunsPage,
  TrialPage,
} from "./pages";
import { useSession, useSystem } from "./queries";
import { ErrorNotice, Loading, QueryContent } from "./ui";
import { WorkbenchPage } from "./workbench";
import { LeaderboardPage } from "./leaderboard-page";

function isPublicBoard(path: string): boolean {
  return path === "/" || path === "/leaderboard";
}

function GuestShell({ children }: { children: ReactNode }) {
  return (
    <Layout
      actor={null}
      system={null}
      serviceError={null}
      onSignOut={() => undefined}
      signingOut={false}
    >
      {children}
    </Layout>
  );
}

function LoginRedirect({ returnTo }: { returnTo: string }) {
  const href = loginHref(returnTo);
  useEffect(() => {
    window.location.replace(href);
  }, [href]);
  return <Loading />;
}

function AuthenticatedApp({
  actor,
  sessionError,
}: {
  actor: DisplayActor;
  sessionError: unknown;
}) {
  const client = useQueryClient();
  const system = useSystem();
  const logout = useMutation({
    mutationFn: signOut,
    onSuccess: () => {
      client.clear();
      window.location.assign("/");
    },
  });
  const writeMode = system.data?.write_mode ?? "unknown";
  return (
    <ControlStateProvider actor={actor} writeMode={writeMode}>
      <Layout
        actor={actor}
        system={system.data ?? null}
        serviceError={sessionError ?? (system.data ? system.error : null)}
        onSignOut={() => logout.mutate()}
        signingOut={logout.isPending}
      >
        <Routes>
          {system.data ? (
            <>
              <Route path="/" element={<LeaderboardPage />} />
              <Route path="/leaderboard" element={<Navigate to="/" replace />} />
              <Route path="/overview" element={<OverviewPage />} />
              <Route path="/workbench" element={<WorkbenchPage />} />
              <Route path="/runs" element={<RunsPage />} />
              <Route path="/runs/:runId" element={<RunPage />} />
              <Route path="/runs/:runId/trials/:trialName" element={<TrialPage />} />
              <Route path="/jobs" element={<JobsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </>
          ) : (
            <Route
              path="*"
              element={<QueryContent query={system}>{null}</QueryContent>}
            />
          )}
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

  const actor =
    session.data?.authenticated === true && session.data.actor
      ? session.data.actor
      : null;

  if (actor) return <AuthenticatedApp actor={actor} sessionError={session.error} />;

  if (isPublicBoard(location.pathname)) {
    if (location.pathname === "/leaderboard") return <Navigate to="/" replace />;
    return (
      <GuestShell>
        <LeaderboardPage />
      </GuestShell>
    );
  }

  const unauthorized =
    (session.error instanceof ApiError && session.error.status === 401) ||
    session.data?.authenticated === false;
  if (unauthorized) return <LoginRedirect returnTo={location.pathname} />;

  const error =
    session.error ?? new Error("The control service could not verify your session.");
  return (
    <GuestShell>
      <div className="mx-auto mt-16 w-full max-w-xl">
        <ErrorNotice error={error} retry={() => void session.refetch()} />
        <p className="mt-4 text-center text-sm text-slate-500">
          A temporary failure does not end an existing session.
        </p>
      </div>
    </GuestShell>
  );
}
