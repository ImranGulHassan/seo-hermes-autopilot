import { serve } from "@hono/node-server";
import { createPool, migrate, PostgresChangeLedger, PostgresRunStore, PostgresWebhookDeliveryStore } from "@seo-autopilot/database";
import { createApp } from "./app.js";
import { posthog } from "./posthog.js";

const databaseUrl = process.env.DATABASE_URL;
const apiSecret = process.env.API_SECRET;
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
if (!databaseUrl || !apiSecret || !githubWebhookSecret) throw new Error("DATABASE_URL, API_SECRET, and GITHUB_WEBHOOK_SECRET are required.");
const pool = createPool({ connectionString: databaseUrl });
await migrate(pool);
const changes = new PostgresChangeLedger(pool);
const runs = new PostgresRunStore(pool);
const app = createApp({ stores: { changes, deliveries: new PostgresWebhookDeliveryStore(pool), listSites: () => runs.listSites(), listChanges: (siteId) => runs.listChanges(siteId), listOpportunities: (siteId) => runs.listOpportunities(siteId), listRecentRuns: (limit, siteId) => runs.listRecent(limit, siteId), saveRun: (artifact) => runs.save(artifact) }, apiSecret, githubWebhookSecret, posthog });
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
