type ModelLike = {
  provider: string;
  baseUrl?: string;
};

/**
 * Extract Copilot seat-specific proxy endpoint from token payload and
 * normalize to API base URL.
 *
 * Example token fragment:
 *   ...;proxy-ep=proxy.business.githubcopilot.com;...
 * Returns:
 *   https://api.business.githubcopilot.com
 */
export function deriveCopilotApiBaseUrlFromToken(token: string | undefined): string | undefined {
  if (!token) return undefined;

  const match = /(?:^|;)proxy-ep=([^;]+)/.exec(token);
  if (!match) return undefined;

  const proxyHost = match[1].trim();
  if (!proxyHost) return undefined;

  const host = proxyHost.replace(/^proxy\./, "api.");
  if (!/^[a-z0-9.-]+$/i.test(host)) return undefined;

  return `https://${host}`;
}

/**
 * Override static model baseUrl for Copilot routes using seat-specific endpoint.
 */
export function applyCopilotEndpoint<T extends ModelLike>(model: T, token: string | undefined): T {
  if (model.provider !== "github-copilot") return model;
  const derived = deriveCopilotApiBaseUrlFromToken(token);
  if (!derived || model.baseUrl === derived) return model;
  return { ...model, baseUrl: derived };
}
