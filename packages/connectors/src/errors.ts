export type ConnectorKind = "github" | "google-search-console" | "posthog";

export type ConnectorErrorCode =
  | "invalid-config"
  | "authentication-failed"
  | "permission-denied"
  | "not-found"
  | "invalid-state"
  | "expired-state"
  | "rate-limited"
  | "upstream-unavailable"
  | "unexpected-response";

export class ConnectorError extends Error {
  readonly name = "ConnectorError";

  constructor(
    readonly connector: ConnectorKind,
    readonly code: ConnectorErrorCode,
    message: string,
    readonly action: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export async function connectorHttpError(connector: ConnectorKind, response: Response, operation: string): Promise<ConnectorError> {
  const detail = (await response.text()).slice(0, 500).replace(/\s+/g, " ").trim();
  const suffix = detail ? `: ${detail}` : "";
  if (response.status === 401) return new ConnectorError(connector, "authentication-failed", `${operation} failed (401)${suffix}`, "Reconnect the account or replace the expired credential.", response.status);
  if (response.status === 403) return new ConnectorError(connector, "permission-denied", `${operation} failed (403)${suffix}`, "Grant the required permissions, then verify the connection again.", response.status);
  if (response.status === 404) return new ConnectorError(connector, "not-found", `${operation} failed (404)${suffix}`, "Confirm the selected resource still exists and the connected account can access it.", response.status);
  if (response.status === 429) return new ConnectorError(connector, "rate-limited", `${operation} was rate limited (429)${suffix}`, "Wait briefly and retry.", response.status);
  if (response.status >= 500) return new ConnectorError(connector, "upstream-unavailable", `${operation} failed (${response.status})${suffix}`, "The provider is unavailable; retry later.", response.status);
  return new ConnectorError(connector, "unexpected-response", `${operation} failed (${response.status})${suffix}`, "Review the connector settings and retry.", response.status);
}
