## Outcome

Describe the user-visible result and why it belongs in the focused product.

## Verification

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] Tests cover changed behaviour
- [ ] Documentation and `.env.example` are updated when applicable

## Safety

- [ ] No credentials, customer data, private repository content, or generated run artifacts are included
- [ ] Tenant scoping, approval gates, protected paths, idempotency, and non-destructive failure behaviour remain intact
- [ ] Permission, schema, external API cost, and migration changes are called out below

Safety or migration notes:
