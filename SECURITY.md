# Security policy

## Reporting a vulnerability

Do not open a public issue for credential exposure, authentication bypass, tenant-isolation failure, webhook forgery, repository-write escalation, or another security vulnerability.

Use GitHub's private vulnerability reporting for this repository when available. If it is unavailable, email `imrangulhassan@gmail.com` with the subject `SEO Autopilot security report`. Include affected versions, impact, reproduction steps, and any suggested mitigation. Do not include real customer data or exploit systems you do not own.

We aim to acknowledge a report within three business days. Timelines for a fix and disclosure depend on severity and whether connected services or users need to rotate credentials.

## Supported versions

Until the first tagged stable release, only the latest commit on `main` receives security fixes. Self-hosters should follow repository releases and upgrade promptly.

## Deployment responsibilities

Self-hosters must use unique high-entropy secrets, encrypt connector credentials, restrict GitHub App permissions, configure exact OAuth callback URLs, protect cron endpoints, keep PostgreSQL private, and rotate any credential that may have been exposed. Never commit `.env`, `.pem`, `.key`, crawl artifacts, database exports, or customer repositories.
