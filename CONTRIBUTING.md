# Contributing to SEO Autopilot

Thank you for helping make SEO maintenance safer and more accountable.

## Before opening a change

- Search existing issues and pull requests first.
- Use an issue for substantial features, new connectors, schema changes, or changes to the autonomy contract.
- Do not include customer repositories, production exports, crawl artifacts, analytics data, credentials, private keys, access tokens, or `.env` files.
- Keep v1 changes within the approval-first Next.js/MDX product boundary unless maintainers have accepted a broader design.

## Local development

Requirements are Node.js 20.19 or later, pnpm 10, and PostgreSQL for persistence-dependent features.

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm typecheck
pnpm test
pnpm build
```

The crawl and fixture suites do not require third-party credentials. Never use production credentials in tests.

## Pull requests

- Keep each pull request focused and explain the user-visible outcome.
- Add or update tests for changed behaviour.
- Preserve non-destructive failure states, tenant scoping, idempotency, protected paths, and approval requirements.
- Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before requesting review.
- Document new environment variables in `.env.example` and the relevant guide without adding real values.
- Call out database migrations, permission changes, external API costs, and security implications.

Contributions are accepted under the repository's AGPL-3.0-only licence. By submitting a contribution, you certify that you have the right to submit it under that licence.
