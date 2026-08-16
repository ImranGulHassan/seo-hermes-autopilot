# SEO Autopilot — Build Spec v0.1

Working name. The autonomous layer of the unified OSS SEO/GEO platform: connectors in, detectors over a warehouse, an agent that opens PRs against the site repo, and a measurement loop that grades its own changes.

**Autonomy contract:** the system runs unattended and closes the loop on everything mechanical. Two categories stay human: (1) link acquisition, (2) publishing net-new content. Everything else — detection, diagnosis, patch authoring, deployment, measurement, rollback — is automated with tiered gating.

---

## 1. System shape

```
┌─────────────┐   ┌──────────────┐   ┌────────────┐   ┌──────────────┐
│ Connectors  │──▶│  Warehouse   │──▶│ Detectors  │──▶│ Opportunity  │
│ (sync jobs) │   │ (Postgres)   │   │  (SQL/TS)  │   │    queue     │
└─────────────┘   └──────────────┘   └────────────┘   └──────┬───────┘
                          ▲                                   │
                          │                            ┌──────▼───────┐
                  ┌───────┴────────┐                   │ Agent runner │
                  │  Measurement   │◀──────────────────│ (Agent SDK)  │
                  │     loop       │   change ledger   └──────┬───────┘
                  └────────────────┘                          │
                                                      ┌───────▼────────┐
                                                      │  GitHub App    │
                                                      │  (PR / merge)  │
                                                      └────────────────┘
```

**Stack:** TypeScript throughout. Hono API, Next.js dashboard, Postgres (Drizzle), Redis + BullMQ for scheduling/queues, GCP Cloud Run for services + Cloud Run Jobs for agent runs. Object storage for raw crawl artifacts and SERP HTML.

**Repos:** monorepo (`pnpm` workspaces) — `apps/api`, `apps/web`, `apps/worker`, `packages/connectors`, `packages/detectors`, `packages/agent`, `packages/site-adapters`, `packages/shared`.

---

## 2. Connector layer

Every connector implements the same interface: `sync(siteId, window) → normalized rows + cost accounting`. All credentials are BYOK, encrypted per-workspace.

| Connector | Provides | Cost | Cadence | Notes |
|---|---|---|---|---|
| **Google Search Console API** | query/page/country/device dims: clicks, impressions, CTR, position | Free | Daily, backfill 16mo | ~2 day lag; row sampling on high-volume dims — always pull `page` and `query` dims separately as well as jointly |
| **GSC URL Inspection API** | index status, canonical Google picked, crawl date, mobile usability | Free | Daily, prioritized | Hard quota ~2k URLs/day/property — spend it on sitemap URLs with impressions, not the whole site |
| **GSC Sitemaps API** | submit + read sitemap status | Free | On change | |
| **Bing Webmaster API** | keyword data, backlinks, crawl info, index status | Free | Daily | Independent backlink view; useful cross-check |
| **IndexNow** | instant URL submission (Bing/Yandex/Naver) | Free | On publish/change | Key file at site root; fire-and-forget |
| **DataForSEO** | SERP (live + task), keyword ideas/volume/difficulty, backlinks, on-page, SERP features, AI Overview presence | PAYG, ~$0.60/1k SERP requests, backlinks $0.02/req + per-row | Rank tracking daily; research on demand | **The automation backbone.** Cheapest per-unit and no plan gate |
| **Ahrefs API v3** | DR/UR, backlink graph, organic keywords, Site Audit, Brand Radar, Rank Tracker | Included on Lite+ plans as monthly units; Rank Tracker/Management/Web Analytics endpoints are free | Weekly (units are scarce) | Every billable request costs ≥50 units + per-row × fields — batch aggressively, cache hard |
| **PageSpeed Insights / CrUX API** | lab + field CWV (LCP, INP, CLS) at p75 | Free | Weekly per template | Sample by page *template*, not per URL |
| **Google Ads API** | keyword volume, forecast | Free w/ account | On demand | Optional; DataForSEO covers most of it |
| **Own crawler** | full site graph, status codes, redirect chains, canonicals, hreflang, schema, internal links, content hash | Self-hosted compute | Weekly + on deploy | Playwright for JS rendering, respect robots, politeness budget |
| **Analytics (GA4 / Plausible / PostHog)** | sessions, conversions, revenue per landing page | Free | Daily | Optional but required for the value-weighted prioritizer |

**Semrush:** deliberately excluded from the pipeline. API access requires the Advanced tier (~$549/mo) plus separately purchased units. Keep it as a manual research surface; do not build automation on it.

**Cost governor:** every connector call is priced and logged to `api_usage`. Per-workspace monthly budget with soft (throttle) and hard (halt) caps. The prioritizer spends the budget on pages with traffic/revenue, not uniformly.

---

## 3. Warehouse schema (core tables)

```
workspaces, sites, site_credentials
pages                 — url, template, first_seen, status, canonical, indexable, word_count, content_hash
queries               — normalized query text, cluster_id, volume, difficulty, intent, serp_features[]
clusters              — centroid embedding, label, primary_url_id, cannibalization_flag
gsc_daily             — (site, date, page, query, country, device) → clicks, impressions, ctr, position
rank_daily            — (site, date, keyword, location, device) → position, url, serp_features
crawl_snapshots       — run-scoped page facts; diffable
internal_links        — from_page, to_page, anchor, rel, position_in_dom
backlinks             — source_url, target_url, anchor, dr, first_seen, last_seen, lost_at
cwv_samples           — page_template, date, lcp_p75, inp_p75, cls_p75, source(lab|field)
opportunities         — type, page/cluster ref, severity, est_impact, evidence jsonb, state
changes               — the ledger: opportunity_id, tier, diff, pr_url, merged_at, deployed_at,
                        baseline jsonb, eval_window, outcome, reverted_at
experiments           — change_group, treatment_ids[], control_ids[], hypothesis, result
runs                  — agent run log: prompt, tools used, tokens, cost, actions, session_id
```

`changes` is the most important table in the system. Every mutation the agent makes is a row with a frozen pre-change baseline. Without it there is no measurement loop, no rollback, and no learning.

---

## 4. Detector layer

Detectors are pure functions over the warehouse producing `opportunities`. Each carries evidence, an estimated impact, and a confidence. All thresholds are per-site configurable; defaults below.

**Ranking & content**
1. **Striking distance** — avg position 5–20 over trailing 28d, impressions ≥ 100, CTR below expected curve → on-page optimization candidate.
2. **CTR anomaly** — fit the site's own position→CTR curve; flag pages ≥1.5σ below expected for their position with ≥500 impressions → title/meta rewrite.
3. **Content decay** — clicks down ≥25% over 28d vs prior 28d *while* cluster search volume is flat or up (separates demand drop from ranking loss) → refresh.
4. **Cannibalization** — ≥2 URLs alternating as the ranking URL for a cluster across ≥5 days in 28 → consolidate/redirect/differentiate.
5. **Cluster gap** — cluster with volume ≥ threshold and no page above position 30 → content brief (Tier 3, queued for human).
6. **Intent mismatch** — page ranks 10–30 for a cluster whose SERP is dominated by a different page type (e.g. you have a blog post, SERP is all product pages) → restructure recommendation.
7. **SERP feature loss/gain** — lost featured snippet, lost sitelinks, AI Overview appearance → format-specific fix (answer block, list markup, concise definition paragraph).

**Technical**
8. **Index coverage** — sitemap URL with `NOT INDEXED` / `CRAWLED — CURRENTLY NOT INDEXED` / Google-selected canonical ≠ declared canonical.
9. **Crawl waste** — high-crawl, zero-impression parameterized/faceted URLs → robots/canonical/noindex proposal (Tier 2).
10. **Broken links & chains** — internal 4xx/5xx, redirect chains >1 hop, redirect loops.
11. **Orphan & under-linked** — page with impressions but <3 internal inbound links.
12. **Schema** — missing/invalid structured data vs page type; validate against schema.org shapes.
13. **Duplicate metadata** — identical/near-identical titles or descriptions across ≥2 indexable pages.
14. **CWV regression** — p75 LCP/INP/CLS crossing "good" thresholds at template level, week over week.

**Off-page & GEO**
15. **Backlink loss** — lost referring domain pointing at a page in the top-20% by traffic → reclamation task (Tier 3).
16. **Link reclamation** — unlinked brand mentions, 404s with inbound links → redirect proposal (Tier 1) or outreach task (Tier 3).
17. **AI/LLM visibility** — brand presence in AI Overviews and tracked LLM prompts (Ahrefs Brand Radar or own prompt panel) → GEO-oriented content structuring.

**Prioritizer:** `score = est_traffic_delta × conversion_value × confidence ÷ effort`, with a fatigue penalty for pages changed recently. Only the top N per run enter the agent queue.

---

## 5. Action tiers (the autonomy dial)

| Tier | Gate | Actions |
|---|---|---|
| **0 — Autonomous, no PR** | none | IndexNow ping, sitemap regenerate + resubmit, URL Inspection recheck, cache purge, alerting |
| **1 — PR, auto-merge on green** | CI + validators pass | Meta description rewrite, image `alt` text, schema block insert/fix, canonical fix, 404→best-match redirect (similarity ≥ threshold), internal link insertion from approved anchor set, hreflang fix, sitemap entries |
| **2 — PR, human review required** | 1 approval | Title tag changes on pages in top-20% traffic, H1 changes, content refresh/expansion of existing pages, robots.txt / noindex / canonical changes that reduce indexable surface, bulk internal-link restructuring, template-level CWV code changes |
| **3 — Human owns, agent prepares** | manual | Publishing net-new content (agent delivers brief + full draft + internal link plan), link outreach, site migrations & large redirect maps, anything touching pricing/legal/checkout |

Tier 1 auto-merge is the whole point — it's what makes the system self-maintaining rather than another dashboard that generates homework. Start every new site with Tier 1 also requiring approval, and promote to auto-merge after 2–3 weeks of clean human-approved diffs (the "trust ramp").

---

## 6. Agent runner

Nightly Cloud Run Job per site. Claude Agent SDK (the same agent loop as Claude Code, run headless — `claude -p` is that SDK behind a CLI) in a container with the site repo checked out on a scratch branch.

**Run structure**
1. **Context assembly (deterministic, not agentic).** Pull the top-N opportunities with evidence, the page's current source, its GSC trend, the cluster's SERP snapshot, the site's style guide, and the last 5 changes to this page. Assembling context in code rather than letting the agent grep is what keeps runs cheap and reproducible.
2. **Plan.** Agent proposes an action per opportunity, tags a tier, states an expected effect and how it will be measured. Structured output (`--json-schema` / SDK typed output), validated against a Zod schema.
3. **Act.** Agent edits files via site adapters, runs validators, commits to `seo-autopilot/<date>-<slug>`.
4. **Gate.** Irreversible steps (open PR, merge, ping IndexNow) are behind explicit final tools that run only after validators pass — so a retry is always safe.
5. **Record.** Write `changes` rows with frozen baselines, `runs` row with cost and session_id.

**Tool surface** (allowlisted, nothing else): `read_file`, `edit_file`, `run_validator`, `query_warehouse` (read-only SQL against a restricted view), `fetch_serp` (budgeted), `open_pr`, `request_review`, `ping_indexnow`. No raw bash, no network beyond the connector proxy.

**Safety via SDK primitives:** `--permission-mode` + `--allowedTools` pre-decide everything; `can_use_tool` callback enforces per-run blast-radius caps; hooks write the audit log. `--max-turns` and `--max-budget-usd` bound every run. Treat any result subtype other than success as a failed run — a model refusal will not show up in the exit code.

**Model routing:** Sonnet for the bulk pass (classification, meta rewrites, schema, link insertion), Opus for content refresh drafts and diagnosis of ambiguous ranking losses, Haiku for high-volume classification (intent tagging, dedupe). Route by opportunity type, not per run.

**Site adapters** — the layer that makes this work across stacks. Each implements `readPage(url)`, `writeMeta(url, {title, description})`, `insertSchema(url, json)`, `insertInternalLink(url, anchor, target, context)`, `addRedirect(from, to)`, `updateContent(url, markdown)`. Ship: Next.js (App Router metadata exports + MDX), Astro, Hugo/11ty (frontmatter), and a WordPress adapter over the REST API for the non-repo case. The WP adapter is what opens the market beyond dev-owned sites.

---

## 7. Measurement loop

This is the part every competitor skips, and it's the reason the cloud tier is defensible.

- **Baseline freeze.** At change time, snapshot 28d of the page's clicks/impressions/CTR/position, plus cluster-level volume trend.
- **Evaluation window.** 14d minimum for CTR effects (title/meta), 28–56d for ranking effects (content, links). No verdict before the window closes.
- **Controls.** Where a detector fires on ≥20 comparable pages, hold back 20% as an untouched control group. Compare treatment vs control deltas, not pre vs post — this removes seasonality and algorithm-update noise, which otherwise makes every result unreadable.
- **Confounder guards.** Flag runs overlapping a known Google update or a site-wide deploy; mark those evaluations low-confidence rather than trusting them.
- **Auto-revert.** If a change's primary metric drops beyond threshold with sufficient volume, revert the commit, mark the opportunity `regressed`, and suppress that action type on that page.
- **Learning.** Outcomes feed back as priors: per-site (this site's title patterns win/lose) and — cloud only — cross-site (across all workspaces, which meta patterns move CTR at which positions in which verticals).

---

## 8. Safety rails

Non-negotiable, all enforced in code rather than prompt:

- **Blast radius:** max changes per run (default 15), max % of site per week (default 5%), max 1 change per page per 28 days per element type.
- **Protected paths:** glob list, never touched (`/legal/*`, `/pricing`, checkout, auth).
- **Volume floor:** never act on a page with <100 impressions/28d — noise, not signal.
- **Indexability guard:** any change that reduces indexable surface is Tier 2 minimum, always, with a diff summary of affected URL count.
- **Freeze windows:** manual freeze switch; auto-freeze during detected volatility (site-wide rank turbulence above threshold).
- **Content policy:** the agent never publishes net-new pages autonomously. Google's scaled content abuse policy targets exactly this pattern, and a low-authority site is the most exposed. Drafts queue for human sign-off, always.
- **Full reversibility:** every change is a commit + a `changes` row. One command reverts any run.

---

## 9. Open-core split

**AGPL-3.0 core, self-hosted, BYOK — free forever**
Connectors, warehouse, crawler, all detectors, clustering, dashboard, agent runner, site adapters, PR generation, single workspace, manual + cron triggers, full measurement loop for your own sites.

**Cloud (paid)**
- Hosted infrastructure and managed scheduling — nobody wants to run Playwright crawlers and cron on their own box.
- Multi-site workspaces, team seats, roles.
- Historical retention beyond 12 months.
- **Cross-site outcome priors** — the model of what actually works, trained on aggregate anonymized change outcomes. This is the one asset a fork structurally cannot replicate, because it requires fleet-scale observation. Guard it accordingly.
- Managed LLM credits (no key setup), Slack/email digests, white-label client reporting, SSO/audit log.
- Commercial license for anyone who wants to embed without AGPL obligations.

**Pricing sketch:** Free self-host · Solo $39/site/mo · Studio $149 (10 sites) · Agency $449 (40 sites, white-label) · + metered content credits. Agencies are the buyer with budget and the pain (they do this work manually, per client, every month).

---

## 10. Build phases

**Phase 0 — Read-only spine (2 weeks).** GSC + Bing + DataForSEO connectors, warehouse, clustering, dashboard. Deploy against freeatsresume.com. Output: you can see everything, change nothing.

**Phase 1 — Detectors + queue (2 weeks).** Detectors 1–14, prioritizer, opportunity queue with evidence UI. Still no writes. Validate: do the top-10 opportunities look right to a human SEO?

**Phase 2 — Agent + Tier 1 with approval (3 weeks).** GitHub App, Next.js adapter, agent runner, PR generation, change ledger. Every PR human-approved. This is where you find out how good the diffs actually are.

**Phase 3 — Measurement + auto-merge (3 weeks).** Evaluation windows, control groups, auto-revert, trust ramp. Turn on Tier 1 auto-merge for freeatsresume. **This is the point the system becomes the product.**

**Phase 4 — Productize (4 weeks).** WordPress adapter, multi-site, onboarding, billing, AGPL release + cloud waitlist.

**Dogfood:** freeatsresume.com is the ideal first deployment — near-zero organic baseline means every intervention is cleanly attributable, and the public before/after becomes the launch asset. Second site should be one with existing traffic, to test that the safety rails actually prevent damage.

---

## 11. External agent interface (Hermes handoff)

SEO Autopilot owns everything that touches the repo and the change ledger. An external agent runtime (Hermes Agent, running separately) owns everything that touches humans and the open web. This section defines only the seam — the external agent's own configuration is out of scope for this repo.

**Out of scope for this codebase:** outreach prospecting and sending, reply triage, community/social distribution, notification delivery, human approval UX. Do not build these here.

**Outbound events.** The API emits signed webhooks (HMAC-SHA256 over the raw body, `X-Autopilot-Signature`, timestamp in header, 5-minute replay window) for:

| Event | Payload | Consumer action |
|---|---|---|
| `review.requested` | change_id, tier, page, diff summary, est_impact, pr_url | Deliver to messaging channel, collect approve/reject |
| `draft.ready` | opportunity_id, cluster, brief, draft_url, internal link plan | Deliver for content sign-off |
| `link.reclamation` | target_url, source_url, type (lost \| unlinked_mention \| 404_inbound) | Queue outreach task |
| `change.regressed` | change_id, metric deltas, revert commit | Notify; no action required |
| `run.failed` | run_id, subtype, error | Alert |

**Inbound callbacks** (API-key auth, scoped to review actions only): `POST /v1/changes/:id/approve`, `/reject`, `/defer`. Approvals are recorded with the approving identity and channel in the `changes` row — an approval is part of the audit trail, not a side effect.

**A2A agent card** at `/.well-known/agent.json`, exposing read-only skills: `get_opportunities`, `get_site_health`, `get_change_outcomes`. No write skills over A2A — writes go through the repo, always.

**Deliberately not shared:** the external agent gets no repo write access, no warehouse write access, and no ability to trigger a merge. It can approve a change that the Autopilot already authored; it cannot author one.

---

## 12. Open risks

- **GSC sampling and 2-day lag** will break naive regression detectors. Always compare like-for-like windows and never alert on the trailing 3 days.
- **Ahrefs unit burn** is easy to blow through — cache every response and treat Ahrefs as a weekly enrichment pass, not a daily source.
- **Auto-merged changes to a live site** is the scariest feature you will ship. The trust ramp and per-page fatigue caps are what make it defensible; do not ship auto-merge before the revert path has been tested for real.
- **Attribution honesty** — SEO is noisy enough that you will be tempted to claim wins the control group doesn't support. Resist; the measurement rigor is the brand.
- **Outreach blast radius** — the external agent sends from the same domains this system is optimizing. Automated link outreach at volume is spam; a burned sending domain damages the very asset the Autopilot is improving. First-touch templates stay human-approved, with hard rate limits, before anything sends unattended.