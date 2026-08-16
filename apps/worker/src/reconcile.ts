import { readFile } from "node:fs/promises";
import { GitHubAppAuthenticator, GitHubAppClient, reconcileGitHubChanges } from "@seo-autopilot/connectors";
import { ChangeWorkflow } from "@seo-autopilot/core";
import { createPool, migrate, PostgresChangeLedger } from "@seo-autopilot/database";

const databaseUrl = process.env.DATABASE_URL;
const appId = process.env.GITHUB_APP_ID;
const installationId = process.env.GITHUB_INSTALLATION_ID;
const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
if (!databaseUrl || !appId || !installationId || !privateKeyPath) throw new Error("DATABASE_URL, GITHUB_APP_ID, GITHUB_INSTALLATION_ID, and GITHUB_PRIVATE_KEY_PATH are required.");

const privateKey = await readFile(privateKeyPath, "utf8");
const pool = createPool({ connectionString: databaseUrl });
try {
  await migrate(pool);
  const ledger = new PostgresChangeLedger(pool);
  const github = new GitHubAppClient({ tokenProvider: new GitHubAppAuthenticator({ appId, installationId, privateKey }) });
  const result = await reconcileGitHubChanges({ ledger, workflow: new ChangeWorkflow(ledger), github });
  console.log(JSON.stringify(result));
  if (result.errors.length > 0) process.exitCode = 1;
} finally { await pool.end(); }
