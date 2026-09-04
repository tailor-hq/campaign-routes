/**
 * Reading the rules from an endpoint in the customer's own app.
 *
 * # Why this exists, and why it is the right default for Next.js
 *
 * `/contentful` fetches the CDA straight from the edge, which is correct for
 * Lambda@Edge and wrong for Next.js middleware, for two reasons that only became
 * obvious from a real install:
 *
 * 1. **Middleware has no content client.** It runs in the Edge runtime, before
 *    the app, so the customer's `contentful` SDK is not available to it. They
 *    need a route inside the app either way.
 * 2. **That route can answer a question the edge cannot.** It runs where the app
 *    knows its own routes, so it can return the rules *and the paths that
 *    exist*, in one payload. That is `pageExists` for free — and `pageExists` is
 *    what stops a rule published before its page turns a live ad into a 404 for
 *    as long as nobody notices.
 *
 * A Next.js install built on `/contentful` silently loses that second half.
 * Nothing fails; the protection is just absent, which is the shape of bug this
 * package exists to avoid.
 *
 * # The payload
 *
 * ```json
 * { "routes": [ { "basePath": "…", "matchParams": { … }, "targetPath": "…" } ],
 *   "paths": ["/pricing", "/pricing-enterprise", …] }
 * ```
 *
 * `campaignRoutesPayload` builds it, so the two halves of the install cannot
 * drift apart on a field name — the failure that would produce is every campaign
 * quietly not routing.
 */

import { createCachedLoader } from './internal/cached-loader.js';
import type { CampaignRoute } from './core/index.js';

/** The path Tailor's guide tells customers to serve the rules on. */
export const DEFAULT_ENDPOINT_PATH = '/api/campaign-routes';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_500;

export interface CampaignRoutesPayload {
  routes: CampaignRoute[];
  paths: string[];
}

/**
 * Build the payload the endpoint returns.
 *
 * Trivial on purpose. It exists so the shape is written down in one place that
 * both halves import, rather than as a field name in a route handler and a
 * matching field name in a middleware that nothing checks against it.
 */
export const campaignRoutesPayload = (
  routes: CampaignRoute[],
  paths: string[]
): CampaignRoutesPayload => ({ routes: routes ?? [], paths: paths ?? [] });

export interface EndpointRouteSourceConfig {
  /**
   * Where the endpoint is served, relative to the site. Defaults to
   * `/api/campaign-routes`.
   *
   * Relative rather than absolute so it follows the deployment: the request's
   * own origin is used, which is what makes this work unchanged on a preview
   * deploy, a branch URL and production without an environment variable per
   * environment. Pass `origin` to `getRoutes` (the Next adapter does).
   */
  path?: string;
  /** An absolute origin, when the endpoint is not on the same site. */
  origin?: string;
  /** How long a fetched payload is reused. Default 60s. */
  ttlMs?: number;
  /** How long a single fetch may take before it is abandoned. Default 2500ms. */
  timeoutMs?: number;
  /**
   * A payload to serve until the first real read lands.
   *
   * Ship it with the deploy and the first request of every new isolate is
   * personalized rather than not. Treated as already stale, so a real read
   * starts immediately behind it.
   */
  bootstrap?: CampaignRoutesPayload;
  /** Injectable for tests and for runtimes with a non-global fetch. */
  fetchImpl?: typeof fetch;
}

export interface EndpointRouteSource {
  /** The current rules. Never throws; answers with the last good set on failure. */
  getRoutes: (origin?: string) => Promise<CampaignRoute[]>;
  /**
   * Whether a path is one the site actually serves.
   *
   * Synchronous, answered from the payload already in hand, because it is called
   * per candidate rule inside the match and there is nothing to await there.
   *
   * **Answers `true` when the paths are not known yet**, which is the one
   * decision here worth arguing about. A cold isolate that has not loaded a
   * payload would otherwise refuse every rule, turning the first request after
   * every deploy into an un-personalized one — a silent, permanent-looking
   * failure. Not-yet-known and known-absent are different states, and only the
   * second one is evidence.
   */
  pageExists: (path: string) => boolean;
}

const isPayload = (value: unknown): value is CampaignRoutesPayload =>
  !!value && typeof value === 'object' && Array.isArray((value as CampaignRoutesPayload).routes);

/** Paths compare the way the core compares them: trailing slash and case are noise. */
const normalize = (path: string): string => {
  const trimmed = String(path).trim().toLowerCase();
  if (trimmed.length > 1 && trimmed.charAt(trimmed.length - 1) === '/') {
    return trimmed.substring(0, trimmed.length - 1);
  }
  return trimmed;
};

export const createEndpointRouteSource = (
  config: EndpointRouteSourceConfig = {}
): EndpointRouteSource => {
  const path = config.path ?? DEFAULT_ENDPOINT_PATH;
  const doFetch = config.fetchImpl ?? fetch;

  // The origin the last read used, so `peek` and a later read agree about which
  // site's rules are in hand.
  let lastOrigin = config.origin ?? '';

  const loader = createCachedLoader<CampaignRoutesPayload>({
    ttlMs: config.ttlMs ?? DEFAULT_TTL_MS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    bootstrap: config.bootstrap,
    load: async (signal) => {
      const response = await doFetch(lastOrigin + path, { signal });
      if (!response.ok) throw new Error('campaign routes endpoint answered ' + String(response.status));
      const body: unknown = await response.json();
      if (!isPayload(body)) throw new Error('campaign routes endpoint returned an unexpected shape');
      return campaignRoutesPayload(body.routes, Array.isArray(body.paths) ? body.paths : []);
    }
  });

  return {
    getRoutes: async (origin?: string) => {
      if (typeof origin === 'string' && origin.length > 0) lastOrigin = origin;
      const payload = await loader.read();
      return payload ? payload.routes : [];
    },
    pageExists: (candidate: string) => {
      const payload = loader.peek();
      // Nothing loaded yet, or an endpoint that returned no path list at all:
      // no evidence either way, so do not refuse on it.
      if (!payload || payload.paths.length === 0) return true;
      const wanted = normalize(candidate);
      for (let index = 0; index < payload.paths.length; index += 1) {
        if (normalize(payload.paths[index]!) === wanted) return true;
      }
      return false;
    }
  };
};
