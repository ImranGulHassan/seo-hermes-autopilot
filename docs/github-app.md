# GitHub App setup

SEO Autopilot uses an installation-scoped GitHub App. It does not accept a
personal access token and exposes no merge API.

## Repository permissions

- **Metadata: read** (mandatory GitHub App baseline)
- **Contents: read and write** to create a dedicated branch and one commit
- **Pull requests: read and write** to discover or open a draft PR
- **Deployments: read** only when deployment-status tracking is enabled

Do not grant Administration, Actions, Checks, Issues, Members, Secrets, or
Workflow permissions. Branch protection must continue to require the site's
normal CI and human approval.

Subscribe only to:

- Pull request
- Pull request review
- Deployment status (optional)

Configure a random webhook secret and pass the exact raw request bytes,
`X-GitHub-Event`, `X-GitHub-Delivery`, and `X-Hub-Signature-256` to
`handleGitHubWebhook`. Invalid signatures are rejected before JSON parsing.
Delivery IDs are deduplicated before lifecycle transitions.

## Runtime authentication

Keep these values in the deployment secret manager, never workspace JSON:

- GitHub App ID
- Installation ID for the customer repository
- PEM private key
- Webhook secret

`GitHubAppAuthenticator` signs a short-lived App JWT, exchanges it for an
installation token, and refreshes it before expiry. `GitHubAppClient` uses that
provider to create the branch, blobs, tree, single commit, and draft PR.

The head branch is stable (`seo-autopilot/<opportunity-id>`). Before creating
Git objects, the client searches for an existing open PR with that head branch.
If a prior attempt created the branch but failed before opening the PR, the next
attempt opens the PR from that branch instead of generating another commit.

## Lifecycle contract

1. The internal change is recorded as `proposed` before any GitHub mutation.
2. The returned owner, repository, PR number, node ID, branch, and URL are
   attached to that change.
3. An authenticated approved-review webhook records reviewer identity and moves
   the change to `approved`.
4. An authenticated merged-PR webhook moves only an approved change to `merged`.
5. An optional successful deployment-status webhook moves the matching merged
   branch to `deployed`.

A valid human merge recovered from GitHub's API is treated as authoritative
approval when an approval webhook was missed. This does not weaken repository
controls: operators should continue to enforce required reviews and CI with
GitHub branch protection.
