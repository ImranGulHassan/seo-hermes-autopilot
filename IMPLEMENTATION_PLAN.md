# SEO Autopilot Implementation Plan

This roadmap implements the focused “Dependabot for SEO” product. Each milestone must be useful and verifiable on its own; later work does not widen the launch scope beyond established Git-managed Next.js/MDX sites.

## Milestone 1 — Local evidence engine (complete)

- Crawl an entered site, including canonical seed redirects.
- Normalize pages and 28-day search metrics.
- Run the five launch detectors with evidence and stable fingerprints.
- Enforce approval, protected paths, idempotency, frozen baselines, and observational outcomes.
- Generate validator-gated draft PR descriptions.

Acceptance: clean install, typecheck, build, fixture tests, and a successful crawl of a real site.

## Milestone 2 — Repeatable site runs (complete)

- Add versioned workspace configuration.
- Fetch page metrics from Google Search Console without the trailing three incomplete days.
- Persist timestamped normalized scan artifacts and a `latest.json` pointer.
- Run crawl and GSC ingestion together through one command.
- Preserve explicit non-destructive states when GSC credentials or sufficient volume are unavailable.

Acceptance: a workspace run can be repeated without losing prior evidence; connector pagination and date windows are fixture-tested; technical analysis still runs when GSC is unavailable.

## Milestone 3 — Next.js/MDX repository adapter (complete)

- Map canonical URLs to App Router metadata exports and MDX frontmatter.
- Produce deterministic patches for broken internal links and unambiguously defective metadata.
- Run configured repository build, link, schema, and protected-path validators in an isolated branch.
- Keep internal-link, CTR, and indexability changes proposal-only.

Acceptance: fixture repositories produce stable patches; failed validation leaves the source tree unchanged; no protected file can enter a proposal.

## Milestone 4 — GitHub approval workflow (complete)

- Install through a least-privilege GitHub App.
- Create one draft PR per change group with evidence and measurement plan.
- Record external PR identifiers and make retries idempotent.
- Receive signed merge/deployment callbacks and prohibit product-side merge in v1.

Acceptance: duplicate runs cannot create duplicate PRs; revoked permissions and failed checks are visible, recoverable states.

## Milestone 5 — Durable service and measurement (complete)

- Move workspace, run, opportunity, change, and evaluation records to Postgres.
- Add scheduled recrawl detection and day-28/day-56 evaluation jobs.
- Add GA4 or PostHog landing-page conversion enrichment.
- Expose a minimal API/UI for opportunities, approvals, changes, and outcomes.

Acceptance: every merged change retains its immutable baseline and deployment history; evaluation cannot start before recrawl; outcome language remains explicitly observational.

Operational note: PostHog enrichment is wired into workspace scans and scheduled
measurement. Activation remains site-specific because a real conversion event
and revenue property must be selected from the customer's analytics taxonomy.

## Milestone 6 — Safe end-to-end orchestration (complete)

- Refresh Google access tokens from the configured long-lived OAuth refresh token.
- Convert only unambiguous redirect-chain findings into source patches; leave editorial and unknown-destination repairs proposal-only.
- Validate patches against an isolated repository copy without changing the working tree.
- Preview all actions by default and require `--live` before writing records or opening idempotent draft GitHub PRs.
- Freeze the scan metric window as the change baseline and persist the originating run.

Acceptance: a dry run performs no database, GitHub, or repository writes; a live run opens only validated draft PRs, records their immutable baseline, and reuses existing PRs safely.

## Milestone 7 — Sitemap-complete discovery (complete)

- Discover sitemap locations from `robots.txt` with a conventional `/sitemap.xml` fallback.
- Follow nested sitemap indexes with bounded traversal.
- Crawl same-origin sitemap pages even when no internal link reaches them.
- Preserve sitemap membership in artifacts and feed it into indexability-conflict detection.
- Ignore malformed, unavailable, and off-origin sitemap entries non-destructively.

Acceptance: orphaned sitemap pages enter the crawl, sitemap conflicts retain evidence, and discovery cannot expand beyond the established canonical origins or configured page limit.

## Milestone 8 — Repository-to-production drift (complete)

- Use supported, non-protected Next.js/MDX source routes as bounded crawl seeds.
- Keep repository discovery separate from sitemap membership.
- Report source routes returning 4xx/5xx as high-confidence conflicts and redirects as medium-confidence review items.
- Report indexable source routes missing from the sitemap at medium confidence for human review.
- Preserve the exact source path in opportunity evidence and artifacts.

Acceptance: unlinked source routes are checked in production, protected routes remain excluded, and no drift finding is eligible for automatic implementation or merge.

## Milestone 9 — Structured link source tracing (complete)

- Trace rendered redirect links to structured `href`, Markdown link, `parent`, and `relatedContent` source contexts.
- Avoid broad literal replacement so canonical URLs and unrelated metadata remain unchanged.
- Group repeated occurrences of the same redirect into one multi-file change and stable draft-PR branch.
- Validate the complete grouped patch in an isolated repository copy.
- Keep broken links without a verified replacement proposal-only.

Acceptance: one repeated redirect produces one validated multi-file proposal; dry-run leaves the repository unchanged; unknown 404 replacements cannot become code changes.

Remote publication additionally requires each planned file's original content
to exactly match the GitHub base branch. Untracked, missing, stale, or unknown
branch content blocks PR creation before any Git blob or branch is written.

## Milestone 10 — Local Git eligibility (complete)

- Classify mapped and patched files as tracked-clean, tracked-modified, or untracked.
- Retain local-only source as diagnostic evidence without treating it as PR-ready.
- Block orchestration before validation or provider writes when any patch source is not tracked-clean.
- Keep the independent GitHub base-content comparison as the final publication guard.

Acceptance: dirty or untracked customer work is never uploaded by SEO Autopilot, while technical findings remain visible and explain exactly why implementation is blocked.

## Milestone 11 — Provider lifecycle reconciliation (complete)

- Poll authoritative GitHub PR/review state for active ledger records.
- Treat a human merge as approval when no separate approval review was delivered.
- Require a successful `Production` deployment whose SHA is the merge commit or is proven by GitHub comparison to contain it.
- Recover only valid approval → merge → deployment transitions and remain idempotent.
- Record an audit note for every lifecycle state recovered after a missed webhook.

Acceptance: missed webhooks cannot permanently strand a change, batched releases advance every included merge, repeated reconciliation produces no duplicate transitions, and preview or diverged deployments cannot start measurement.

## Milestone 12 — Unattended pilot loop (complete)

- Compose daily scanning, approval-only deterministic PR orchestration,
  provider reconciliation, and recrawl-gated measurement into one command.
- Prevent overlapping scheduled or manual runs with an atomic process lock.
- Refresh Google access tokens from OAuth credentials in both scanning and
  measurement workers.
- Stop on failed stages and retain structured progress in the service journal.
- Schedule the pilot daily while keeping lifecycle reconciliation on its
  independent 15-minute timer.

Acceptance: one command exercises the complete operational sequence, concurrent
runs are rejected, failures remain visible and non-destructive, and no workflow
can bypass draft PR review.

## Milestone 13 — Reviewed broken-link destinations (complete)

- Record explicit source-to-destination decisions with reviewer identity,
  approval time, and an optional rationale.
- Require every reviewed destination to remain same-origin and return 2xx in
  the current crawl before generating a patch.
- Group all structured occurrences into one validator-gated draft PR while
  preserving the mapping approval in opportunity evidence.
- Leave every unmapped 404 proposal-only and retain all v1 merge controls.

Acceptance: ambiguous broken links cannot be changed without recorded human
direction, stale or external destinations are rejected, and an approved mapping
can safely repair future recurrences without repeated manual triage.

## Milestone 14 — Pilot evidence scorecard (complete)

- Calculate proposal acceptance, merge, deployment, failure, and rollback rates
  from the durable change ledger.
- Count only the latest observational evaluation for each change.
- Keep acceptance and rollback gates in `insufficient-data` until at least five
  relevant records exist.
- Expose the scorecard through the authenticated API and dashboard.
- Mark paid conversion unavailable until billing or design-partner records are
  connected instead of inferring product-market fit from implementation data.

Acceptance: zero-volume rates are not shown as misleading percentages, pilot
gates use the documented 40% acceptance and 5% rollback thresholds, and every
displayed implementation metric derives from persisted change records.

## Milestone 15 — Reviewed static metadata repairs (complete)

- Record exact replacement metadata with reviewer identity, approval time, and
  an optional rationale.
- Require replacements to address every detected metadata field, remain
  same-origin, and stay unique across the current indexable crawl.
- Map only supported static Next.js/MDX routes and retain dynamic or protected
  pages as proposal-only findings.
- Apply tracked-clean, protected-path, isolated validation, idempotency, and
  draft-only GitHub controls to metadata patches exactly as for link repairs.

Acceptance: unreviewed copy cannot become code, stale or duplicate metadata is
rejected before validation, dry runs leave the repository unchanged, and live
runs can open only validator-gated draft PRs for approved static pages.

Operational hardening: recurring runs treat retained approvals as satisfied only
when the live page exactly matches every approved field; missing or mismatched
approvals remain explicit failures.

Durability hardening: changes retain their own site identity so immutable
baselines and measurement history never depend on a mutable opportunity row.

## Pilot and expansion gates

- Manually support three established Next.js sites before unattended scheduling.
- Require at least 40% proposal acceptance and fewer than 5% technically incorrect PRs.
- Run five approval-only design partners for eight weeks.
- Add deterministic auto-merge only after at least 20 accepted, non-regressing PRs on that site; never auto-merge editorial or indexability-reducing changes in v1.
- Continue only if at least three pilots actively use the workflow and will pay at least $99/month.

WordPress, outreach, rank tracking, GEO, autonomous publishing, white-label agency features, and full SEO experimentation remain outside these milestones.

## Milestone 16 — Permanent Vercel runtime (in progress)

- Deploy the Next.js dashboard and API as one Vercel project.
- Replace the local PostgreSQL proxy with managed serverless PostgreSQL.
- Move secrets into scoped Vercel environment variables.
- Replace systemd scheduling with authenticated Vercel cron entry points.
- Retain the local runner only for repository validation workloads that exceed
  serverless execution limits, with durable job leases and heartbeats.

Acceptance: production does not depend on the operator workstation for web
availability, durable state, scheduled reconciliation, or measurement.

## Milestone 17 — Authentication and tenant isolation (pending)

- Add users, organizations, memberships, sessions, and organization-owned sites.
- Require an authenticated organization context for every product read and write.
- Enforce role-based owner, approver, and viewer permissions.
- Scope webhook, run, opportunity, change, billing, and audit records to a site and
  organization without accepting tenant identifiers solely from the browser.

Acceptance: cross-tenant access tests fail closed, session revocation is immediate,
and the global API secret is no longer a customer authentication mechanism.

## Milestone 18 — Guided onboarding and connectors (pending)

- Create an organization and site through the dashboard.
- Install and verify the GitHub App, then choose an allowed repository and branch.
- Complete Google OAuth and choose a verified Search Console property.
- Optionally connect PostHog and select conversion semantics.
- Configure protected paths, validate the repository, and run an initial read-only scan.

Acceptance: a supported customer can reach a successful first scan without manual
JSON editing or operator access to connector secrets.

## Milestone 19 — Design-partner operations (pending)

- Track partner start, weekly feedback, active-use, publication permission, and
  conversion intent.
- Add two external partners to reach five approval-only pilots.
- Provide admin retry, suspension, audit, and integration-health controls.
- Deliver lifecycle and outcome notifications.

Acceptance: five partners can run for eight weeks with failures visible and
recoverable without database or filesystem intervention.

## Milestone 20 — Outcome validation (pending)

- Preserve and display recrawl, day-28, and day-56 states per deployed change.
- Keep results observational and expose confounded/inconclusive explanations.
- Evaluate the 40% acceptance and 5% correction/rollback gates only with sufficient
  samples.

Acceptance: five-partner evidence—not operator judgment—determines whether launch
criteria have been reached.

## Milestone 21 — Billing and legal launch surface (pending)

- Add Stripe Starter, Growth, and Team subscriptions with explicit usage limits.
- Add checkout, billing portal, webhook reconciliation, delinquency, and entitlement
  enforcement.
- Publish Terms, Privacy, subprocessors, security, deletion/export, and responsible
  disclosure pages for SEO Autopilot.

Acceptance: billing state is authoritative and auditable, cancellation does not
destroy evidence, and no customer can exceed paid entitlements silently.

## Milestone 22 — Paid launch gate (pending)

- Require at least three of five design partners to remain active, merge multiple
  PRs, and convert at $99/month or more.
- Complete production restore, tenant-isolation, webhook replay, secret rotation,
  accessibility, and incident-response checks.
- Keep auto-merge disabled until the existing per-site trust threshold is met.

Acceptance: public paid launch is enabled only when the persisted scorecard and
partner records satisfy the documented continue criteria.
