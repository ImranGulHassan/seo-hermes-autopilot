import { PostHog } from "posthog-node";

const posthogKey = process.env.POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.POSTHOG_HOST;

if ((!posthogKey || !posthogHost) && process.env.NODE_ENV !== "production") {
  const missingVariable = !posthogKey ? "POSTHOG_PROJECT_TOKEN" : "POSTHOG_HOST";
  throw new Error(`${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`);
}

export const posthog = posthogKey && posthogHost
  ? new PostHog(posthogKey, { host: posthogHost, enableExceptionAutocapture: true })
  : null;
