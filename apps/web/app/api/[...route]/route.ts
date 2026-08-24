import { createApp } from "@seo-autopilot/api";
import {
  createPool,
  migrate,
  PostgresChangeLedger,
  PostgresRunStore,
  PostgresWebhookDeliveryStore,
} from "@seo-autopilot/database";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

let runtime: ReturnType<typeof createRuntime> | undefined;

function createRuntime() {
  const databaseUrl = process.env.DATABASE_URL;
  const apiSecret = process.env.API_SECRET;
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!databaseUrl || !apiSecret || !githubWebhookSecret) {
    throw new Error("DATABASE_URL, API_SECRET, and GITHUB_WEBHOOK_SECRET are required.");
  }
  const pool = createPool({ connectionString: databaseUrl, max: 3 });
  const changes = new PostgresChangeLedger(pool);
  const runs = new PostgresRunStore(pool);
  return {
    ready: migrate(pool),
    app: createApp({
      stores: {
        changes,
        deliveries: new PostgresWebhookDeliveryStore(pool),
        listSites: () => runs.listSites(),
        listChanges: (siteId) => runs.listChanges(siteId),
        listOpportunities: (siteId) => runs.listOpportunities(siteId),
        listRecentRuns: (limit, siteId) => runs.listRecent(limit, siteId),
        saveRun: (artifact) => runs.save(artifact),
      },
      apiSecret,
      githubWebhookSecret,
    }),
  };
}

async function handler(request: Request): Promise<Response> {
  runtime ??= createRuntime();
  await runtime.ready;
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api/, "") || "/";
  return runtime.app.fetch(new Request(url, request));
}

export const GET = handler;
export const POST = handler;
