# SEO Autopilot

**Your SEO backlog, converted into pull requests.**

SEO Autopilot is the foundation of a Git-native SEO maintenance agent for content-heavy Next.js and MDX websites. It combines crawl facts and search metrics, finds high-confidence problems, prepares validator-gated draft PRs, and records what happens after deployment.

The v1 contract is deliberately conservative: every change requires human approval, protected paths are enforced in code, duplicate proposals are rejected, and performance reporting never claims causality from a before/after comparison.

## What works today

- Lightweight, same-origin HTML crawler with link status, redirect annotation, robots sitemap discovery, and nested sitemap-index support.
- Five focused detectors: broken links/redirect hops, metadata defects, under-linked pages, CTR anomalies, and indexability conflicts.
- Evidence, confidence, estimated value, proposed fix, and validation requirements on every opportunity.
- Draft PR descriptions gated on validator results.
- Approval-only change state machine with protected paths and idempotent fingerprints.
- Frozen 28-day baselines and recrawl-gated day-28/day-56 observational evaluations.
- CLI support for live crawls, normalized JSON input, and dry-run-first draft PR orchestration.

Google Search Console, PostHog, GitHub App, PostgreSQL, API, dashboard, and measurement integrations are implemented. The current orchestration boundary intentionally authors only deterministic redirect-hop repairs.

## Requirements

- Node.js 20+
- pnpm 10+

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Scan a site without performance data:

```bash
pnpm scan crawl https://example.com
```

The default crawl response is a concise status summary plus opportunities. Add
`--full` to include every crawled page and internal link in the JSON output.

Scan a site and add normalized 28-day GSC/analytics metrics:

```bash
pnpm scan crawl https://example.com ./metrics.json
```

Or run all detectors over a saved normalized scan:

```bash
pnpm scan from-file ./scan.json
```

## Repeatable workspace runs

Create the versioned local configuration once:

```bash
pnpm scan init https://www.example.com
```

This creates `.seo-autopilot/workspace.json`. Add the exact Search Console
property identifier when performance analysis is wanted:

```json
{
  "version": 1,
  "siteUrl": "https://www.example.com",
  "gscPropertyUrl": "sc-domain:example.com",
  "posthog": {
    "eventName": "purchase",
    "revenueProperty": "revenue"
  },
  "protectedPaths": ["legal/**", "pricing", "checkout/**", "auth/**"],
  "crawl": { "maxPages": 500, "concurrency": 4 },
  "repository": {
    "rootDir": "/absolute/path/to/nextjs-site",
    "frameworkRoot": ".",
    "contentRoots": ["content"],
    "validators": [
      { "name": "typecheck", "command": "pnpm", "args": ["typecheck"] },
      { "name": "build", "command": "pnpm", "args": ["build"] }
    ]
  },
  "github": {
    "owner": "your-org",
    "repository": "your-site",
    "baseBranch": "main"
  },
  "orchestration": {
    "maxChanges": 5,
    "destinationMappings": [
      {
        "from": "/missing-planned-hub",
        "to": "/existing-live-hub",
        "approvedBy": "owner@example.com",
        "approvedAt": "2026-08-16T09:00:00.000Z",
        "note": "Reviewed against the current navigation structure"
      }
    ],
    "metadataRepairs": [
      {
        "url": "/about",
        "description": "Learn how the team maintains the product, its evidence standards, and its customer commitments.",
        "approvedBy": "owner@example.com",
        "approvedAt": "2026-08-16T09:00:00.000Z",
        "note": "Reviewed against the visible page copy"
      }
    ]
  }
}
```

Provide either a short-lived `GSC_ACCESS_TOKEN`, or `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`. The latter is refreshed and
cached automatically. Then run:

```bash
pnpm scan workspace
```

Each run is stored under `.seo-autopilot/runs/`; `latest.json` is replaced
atomically. Search Console requests use finalized page-level data from the last
completed 28-day window, excluding the trailing three days. If credentials are
missing or rejected, the run completes non-destructively as `technical-only`
and records the GSC error in its artifact.

When `posthog` is configured, set `POSTHOG_PERSONAL_API_KEY`,
`POSTHOG_PROJECT_ID`, and `POSTHOG_API_HOST`. Workspace scans join conversion
events to GSC landing pages after removing query strings and normalizing trailing
slashes. A PostHog failure is recorded without discarding search metrics.

The crawler reads sitemap declarations from `robots.txt`, falls back to
`/sitemap.xml`, follows bounded same-origin sitemap indexes, and adds orphaned
sitemap URLs to the crawl. Sitemap membership is retained as detector evidence.

## Next.js and MDX repository adapter

Inspect the static routes the adapter can safely map:

```bash
pnpm scan repo-pages /absolute/path/to/site https://www.example.com
```

Workspace runs attach discovered repository paths to matching crawl pages. The
adapter supports static App Router `page.tsx` files, route groups, MD/MDX
frontmatter, literal metadata exports, and direct replacement of known redirect
hops. Dynamic segments and `generateMetadata` are deliberately refused.

Supported, non-protected source routes are also used as bounded crawl seeds.
This exposes repository-to-production drift: routes that fail in production are
high-confidence indexability conflicts, while live routes absent from the
sitemap are medium-confidence review items. These findings are never
automatically changed or merged.

Patch plans contain the complete before/after content and an original-content
hash. Before applying them, the adapter rejects protected or escaping paths,
copies the repository to a temporary staging directory, runs every configured
validator without a shell, checks that source files have not changed since
planning, and only then replaces the real files. A failed validator makes no
change to the source repository.

## Draft PR orchestration

After a workspace scan, preview deterministic work locally:

```bash
pnpm scan orchestrate
```

This default mode stages each eligible patch in an isolated copy and runs all
validators, but does not modify the source repository, database, or GitHub.
Redirect-chain findings with an exact source file and known final URL are
eligible. A broken 404 can also become eligible when its destination is
explicitly recorded under `orchestration.destinationMappings`, includes the
reviewer and approval time, remains same-origin, and returns 2xx in the current
crawl. Unmapped broken links, internal-link, CTR, and indexability findings
remain proposal-only. Metadata findings become eligible only when the workspace
records exact replacement copy, reviewer identity, and approval time. Every
affected field must be supplied, the replacement must remain unique in the
current crawl, and the URL must map to a supported, unprotected static source
page. Dynamic metadata and unreviewed copy remain proposal-only.

Rendered redirect occurrences are traced through structured source contexts:
React `href` values, Markdown links, and MDX `parent`/`relatedContent`
frontmatter. Identical redirect repairs are grouped into one validated
multi-file proposal. Canonical fields and unrelated string literals are never
changed by this tracer.

After reviewing the JSON preview, explicitly open validated draft PRs:

```bash
pnpm scan orchestrate --live
```

Live mode requires `DATABASE_URL`, `GITHUB_APP_ID`,
`GITHUB_INSTALLATION_ID`, and `GITHUB_PRIVATE_KEY_PATH`. It persists the scan
and frozen metric baseline, uses one stable branch per opportunity, reuses an
existing open PR on retry, and never merges it. Human approval remains required.

Metric records use CTR as a decimal:

```json
[
  {
    "url": "https://example.com/guide",
    "impressions": 1200,
    "clicks": 36,
    "ctr": 0.03,
    "position": 6.2,
    "conversions": 4,
    "conversionValue": 400
  }
]
```

## Repository layout

- `packages/core`: crawler, normalized contracts, detectors, PR guardrails, ledger, and measurement.
- `apps/cli`: executable vertical slice for crawling and analyzing a site.
- `seo-autopilot.md`: original broad product brief, retained as historical context.

## Product boundaries

The launch target is an established Next.js/MDX site with 100+ indexable pages and at least 10,000 monthly organic impressions. v1 excludes autonomous content publishing, backlinks/outreach, rank tracking, GEO, WordPress, automatic performance rollback, and automatic merge. These are product decisions, not missing promises.

The recommended validation sequence is three manually supported design partners, followed by five approval-only pilots. Auto-merge should remain disabled until deterministic changes have at least 20 accepted, non-regressing PRs per site; product expansion should wait until at least three pilots convert at $99/month or more.

GitHub App permissions, authentication, idempotency, and webhook lifecycle are
documented in [docs/github-app.md](docs/github-app.md).

PostgreSQL, API, dashboard, scheduled measurement, and PostHog setup are
documented in [docs/service.md](docs/service.md).
