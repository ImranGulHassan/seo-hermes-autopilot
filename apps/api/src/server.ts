import { serve } from "@hono/node-server";
import { createPool, migrate, PostgresChangeLedger, PostgresDesignPartnerStore, PostgresRunStore, PostgresWebhookDeliveryStore } from "@seo-autopilot/database";
import { randomBytes } from "node:crypto";
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
const partners = new PostgresDesignPartnerStore(pool);
const app = createApp({ stores: { changes, deliveries: new PostgresWebhookDeliveryStore(pool), listSites: (org) => runs.listSites(org), listChanges: (org, siteId) => runs.listChanges(org, siteId), listOpportunities: (org, siteId) => runs.listOpportunities(org, siteId), listRecentRuns: (org, limit, siteId) => runs.listRecent(org, limit, siteId), saveRun: (org, artifact) => runs.save(artifact, org), listDesignPartners: (org) => partners.list(org), saveDesignPartner: (org,input) => partners.upsert({ ...input, id: input.id ?? `partner_${randomBytes(10).toString("hex")}`, organizationId: org }), recordPartnerFeedback: (org,input) => partners.recordFeedback({ ...input, organizationId: org }), listOperationsAudit: (org) => partners.listAudit(org) }, apiSecret, githubWebhookSecret, posthog });
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
