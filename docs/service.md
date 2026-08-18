# Durable service

## Local startup

The service requires PostgreSQL 15 or newer.

```bash
docker compose up -d postgres
cp .env.example .env
```

Load the environment through your normal secret tooling, then start the API and
dashboard in separate terminals:

```bash
pnpm api
pnpm web
```

The API applies the idempotent initial migration at startup. Production
deployments should run the same migration as a release step before shifting
traffic. The dashboard reads the API server-side; `API_SECRET` is never sent to
the browser.

## API

- `GET /health` is public for platform health checks.
- `GET /v1/opportunities` lists prioritized durable opportunities.
- `GET /v1/changes` and `GET /v1/changes/:id` expose the change ledger.
- `POST /v1/runs` ingests a version-1 normalized scan artifact.
- `POST /webhooks/github` accepts only correctly signed GitHub deliveries.

All `/v1/*` endpoints require `Authorization: Bearer $API_SECRET`. GitHub uses
its independent HMAC webhook secret and raw request body.

## Measurement job

Run `pnpm measurement` as a daily Cloud Run Job or equivalent. It:

1. Loads deployed changes from PostgreSQL.
2. Uses GSC URL Inspection to confirm a crawl after deployment.
3. Leaves unconfirmed changes untouched.
4. Fetches finalized page-level GSC data when day 28 or 56 is due.
5. Records `positive`, `negative`, `inconclusive`, or `confounded` observational
   outcomes through the durable change ledger.

The job requires `DATABASE_URL`, `GSC_ACCESS_TOKEN`, and `GSC_PROPERTY_URL`.
The access token should be injected shortly before the job starts; production
OAuth refresh-token management remains part of deployment secret management.

## GitHub reconciliation job

Run `pnpm reconcile` on a short schedule (for example every 15 minutes) as a
fallback for delayed or missed webhooks. The job reads open lifecycle records,
queries the authoritative GitHub pull request, review, merge, and deployment
state, and advances only valid transitions. A merge by a repository user counts
as explicit human approval when a separate approval review is absent.

Only a successful deployment whose environment is exactly `Production` and
whose SHA is the merge commit or is proven by GitHub to contain it can advance
a merged change to `deployed`. Every recovered transition receives an
audit entry in the serialized ledger record. Repeated runs are idempotent;
ambiguous or incomplete provider state remains unchanged and is reported as
waiting. The job requires `DATABASE_URL`, `GITHUB_APP_ID`,
`GITHUB_INSTALLATION_ID`, and `GITHUB_PRIVATE_KEY_PATH`.

On the initial Linux host this is installed as the user timer
`seo-autopilot-reconcile.timer`. Its unit files live under
`~/.config/systemd/user/`, load the project `.env`, and run every 15 minutes.
User lingering must remain enabled so the timer runs after logout. Operators can
inspect it with `systemctl --user status seo-autopilot-reconcile.timer` and read
recent runs with
`journalctl --user -u seo-autopilot-reconcile.service -n 50 --no-pager`.

## Daily pilot loop

`pnpm pilot` runs the approval-only operational sequence: workspace crawl and
GSC ingestion, deterministic draft-PR orchestration, GitHub reconciliation, and
recrawl-gated measurement. An atomic `.seo-autopilot/pilot.lock` prevents
overlapping manual and scheduled runs. A failed step stops the sequence, exits
non-zero, removes the lock, and leaves its structured progress in the journal.

Pass workspace files as arguments to process several sites sequentially, or set
a comma-separated `SEO_AUTOPILOT_WORKSPACES` value for the unattended timer:

```bash
pnpm pilot -- .seo-autopilot/sites/one.json .seo-autopilot/sites/two.json
```

Each site is scanned and orchestrated independently, GitHub is reconciled once,
and measurement uses a site-scoped ledger so one site's changes cannot be
evaluated against another site's Search Console property.

The initial host runs this command daily through
`seo-autopilot-pilot.timer`. Inspect it with
`systemctl --user status seo-autopilot-pilot.timer` and read failures with
`journalctl --user -u seo-autopilot-pilot.service -n 100 --no-pager`.
Long-running operation should use `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
and `GOOGLE_REFRESH_TOKEN`; a standalone `GSC_ACCESS_TOKEN` expires and is only
suitable for short manual sessions.

## Local API and dashboard services

The initial host runs the API and production-built dashboard as persistent user
services: `seo-autopilot-api.service` on port 3000 and
`seo-autopilot-dashboard.service` on port 3002. Both restart after failure and
run after logout because user lingering is enabled. Deployments must run
`pnpm build` before restarting the dashboard. Inspect them with
`systemctl --user status seo-autopilot-api.service seo-autopilot-dashboard.service`.

## PostHog conversion enrichment

`PostHogConversionClient` uses PostHog's project query endpoint with a HogQL
query and bound event/date values. Configure a narrowly scoped personal API key,
project ID, conversion event, and numeric revenue property. Use
`POSTHOG_API_HOST` (for example `https://us.posthog.com`) for authenticated
queries; `POSTHOG_HOST` remains the separate ingestion host used by the event
capture SDK. The connector groups
conversion counts and value by `$current_url`, then enriches matching normalized
GSC page metrics. Unsafe event/property identifiers are rejected before any
network request.

PostHog enrichment is optional. Search-only prioritization and evaluation remain
available when analytics credentials are missing.

Set the conversion semantics in `workspace.json` under `posthog.eventName` and
`posthog.revenueProperty`. Scheduled measurement uses the equivalent
`POSTHOG_CONVERSION_EVENT` and `POSTHOG_REVENUE_PROPERTY` variables. Current URL
query parameters are removed before matching, and multiple URL variants are
aggregated into one landing-page metric.
