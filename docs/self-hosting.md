# Self-hosting SEO Autopilot

The easiest first run is the credential-free CLI crawl documented in the README. The full dashboard requires PostgreSQL and additional connectors only for the features you enable.

## Local service

1. Install Node.js 20.19+, pnpm 10, Docker, and Git.
2. Run `pnpm install`.
3. Copy `.env.example` to `.env` and replace placeholder secrets locally.
4. Start PostgreSQL with `docker compose up -d`.
5. Run `pnpm web` for the dashboard or `pnpm api` for the standalone API.
6. Validate the installation with `pnpm typecheck && pnpm test && pnpm build`.

The application creates its current schema idempotently at runtime. Back up PostgreSQL before upgrading and test restores separately from production.

## Optional integrations

- GitHub App: follow [github-app.md](github-app.md). Use least privilege and a dedicated webhook secret.
- Google Search Console: create OAuth web credentials, set the exact callback URL, and grant only the required Search Console access.
- PostHog: configure a personal API key only when conversion enrichment is wanted.
- Stripe: optional and unnecessary for free/self-hosted or design-partner use.
- Hosted scheduling: configure authenticated cron requests as described in [service.md](service.md).

## Production minimums

- Generate independent secrets for sessions, internal API access, cron authentication, GitHub webhooks, OAuth state, and connector encryption.
- Serve only over HTTPS and keep PostgreSQL off the public internet.
- Restrict OAuth redirects and GitHub App installation permissions to the intended deployment.
- Configure backups, restore tests, logs, alerts, dependency updates, and secret rotation.
- Run one tenant-isolation and webhook-replay test after every deployment change.

Do not copy the maintainers' production identifiers, secrets, database, or Vercel project. A fork must use its own service accounts and callback URLs.
