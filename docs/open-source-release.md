# Open-source release checklist

This checklist separates repository preparation from the irreversible act of making the GitHub repository public.

## Completed in the repository

- [x] Declare AGPL-3.0-only licensing.
- [x] Add contribution, security, conduct, and self-hosting documentation.
- [x] Keep local secrets, private keys, Vercel metadata, and run artifacts ignored.
- [x] Document the focused v1 boundary and mark the original broad spec as historical.
- [x] Run a full Git-history secret scan.
- [x] Add pull-request CI for typecheck, tests, build, dependency audit, and secret scanning.

## Maintainer actions before changing visibility

- [ ] Review every current GitHub collaborator, deploy key, App installation, Actions secret, environment, and branch rule.
- [ ] Rotate production credentials as a precaution, especially GitHub, Google OAuth, database, session, connector-encryption, API, cron, Vercel, and PostHog secrets.
- [ ] Enable GitHub private vulnerability reporting, secret scanning, push protection, Dependabot alerts, and Dependabot security updates.
- [ ] Configure branch protection for `main`: pull request required, CI required, no force pushes, and no branch deletion.
- [ ] Create public issue labels and issue/discussion templates.
- [ ] Verify `.env.example` contains placeholders only.
- [ ] Create a clean clone and complete the README quick start without access to maintainer credentials.
- [ ] Decide whether package publication is needed; packages remain workspace-local for the initial source release.
- [ ] Tag `v0.1.0` and publish release notes describing supported and unsupported capabilities.
- [ ] Change repository visibility only after all preceding checks pass.

## After publication

- [ ] Monitor the first public CI runs and security alerts.
- [ ] Pin third-party GitHub Actions to reviewed commit SHAs.
- [ ] Publish a roadmap using `IMPLEMENTATION_PLAN.md` rather than promising the historical `seo-autopilot.md` scope.
- [ ] Triage new issues for security, tenant safety, and deterministic correctness before feature breadth.
