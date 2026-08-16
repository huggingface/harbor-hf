import { Route, Routes } from "react-router-dom";
import { Layout } from "./layout";
import { ApiError } from "./api";
import {
  AuditPage,
  CampaignPage,
  CampaignsPage,
  EndpointsPage,
  JobsPage,
  NotFoundPage,
  OverviewPage,
  ProfilesPage,
  ResultsPage,
  TaskPage,
} from "./pages";
import { useLiveUpdates, useSession, useSystem } from "./queries";
import { Button, Card, Loading } from "./ui";

function AuthenticatedApp({ actor }: { actor: { subject: string; role: string } }) {
  const system = useSystem();
  const live = useLiveUpdates(true);
  return (
    <Layout
      actor={actor}
      writeMode={String(system.data?.write_mode ?? "unknown")}
      live={live}
    >
      <Routes>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/:campaignId" element={<CampaignPage />} />
        <Route path="/campaigns/:campaignId/tasks/:taskId" element={<TaskPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/endpoints" element={<EndpointsPage />} />
        <Route path="/results" element={<ResultsPage />} />
        <Route path="/profiles" element={<ProfilesPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  const session = useSession();
  if (session.isLoading)
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Loading />
      </div>
    );
  if (session.error || !session.data?.authenticated || !session.data.actor) {
    const unauthorized =
      session.error instanceof ApiError && session.error.status === 401;
    return (
      <main className="grid min-h-screen place-items-center bg-slate-950 p-6 text-slate-100">
        <Card className="max-w-md text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-cyan-400 text-xl font-black text-slate-950">
            H
          </div>
          <h1 className="mt-5 text-xl font-semibold">Harbor-HF Control</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            {unauthorized
              ? "Sign in with Hugging Face to view campaign operations."
              : "The control service could not verify your session."}
          </p>
          <a className="mt-6 inline-block" href="/auth/login">
            <Button>Sign in with Hugging Face</Button>
          </a>
        </Card>
      </main>
    );
  }
  return <AuthenticatedApp actor={session.data.actor} />;
}
