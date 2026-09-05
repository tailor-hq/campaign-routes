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

import { createCachedLoader, type CachedLoader } from './internal/cached-loader.js';
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
   *
   * `origin` says whose page list to answer from, and the adapter passes the
   * same origin it passed to `getRoutes`. Without it the answer comes from the
   * origin most recently read, which is right on a single-hostname deploy and
   * a race on any other: two requests for different hostnames interleave at
   * every `await`, so "the last origin read" is whichever request yielded last.
   */
  pageExists: (path: string, origin?: string) => boolean;
}

/**
 * How many distinct origins this source keeps a cache for at once.
 *
 * The origin is, by default, the Host header, so without a ceiling a stream of
 * requests carrying random Hosts grows the map without limit. Eight covers
 * production, a preview alias or two and a branch URL on one deployment; past
 * that the least recently used origin is dropped and refetched on its next
 * request.
 */
const MAX_ORIGINS = 8;

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

  // **One cache per origin, never one cache for all of them.** That is the
  // property everything below protects, for two reasons that both showed up in
  // review:
  //
  // - The request origin is the Host header, and behind a forwarding proxy or
  //   on self-hosted Next.js the Host header is attacker-supplied. With a single
  //   shared cache, a request carrying `Host: evil.example` had this source
  //   fetch its rules FROM the attacker and serve them to every following
  //   visitor on the isolate for a TTL. With a cache per origin, that request
  //   poisons a cache that only requests carrying the same bogus Host will ever
  //   read — which is to say, only the attacker's own. What remains is a plain
  //   uncredentialed GET to a host they already control, and pinning `origin`
  //   removes even that.
  // - No attacker is needed for the other one. A deployment routinely answers
  //   on several hostnames — production, a preview alias, a branch URL — and a
  //   shared cache meant whichever origin loaded first answered for all of
  //   them, page list included.
  //
  // A pinned `origin` collapses the map to one entry and the request origin is
  // ignored entirely, which is what makes the option a mitigation rather than
  // decoration.
  const pinnedOrigin = config.origin;
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** Insertion order is recency: a hit is re-inserted, and eviction takes the head. */
  const loaders = new Map<string, CachedLoader<CampaignRoutesPayload>>();
  // The origin most recently read, for a `pageExists` caller that names none.
  let lastOrigin = pinnedOrigin ?? '';

  const loaderFor = (origin: string): CachedLoader<CampaignRoutesPayload> => {
    const existing = loaders.get(origin);
    if (existing) {
      loaders.delete(origin);
      loaders.set(origin, existing);
      return existing;
    }
    const loader = createCachedLoader<CampaignRoutesPayload>({
      ttlMs,
      timeoutMs,
      // The shipped rules are for this deploy, whichever hostname it answers on.
      bootstrap: config.bootstrap,
      load: async (signal) => {
        const response = await doFetch(origin + path, { signal });
        if (!response.ok) throw new Error('campaign routes endpoint answered ' + String(response.status));
        const body: unknown = await response.json();
        if (!isPayload(body)) throw new Error('campaign routes endpoint returned an unexpected shape');
        // Frozen for the same reason the Contentful source freezes: every
        // request on this isolate gets these arrays by reference, and the
        // callers are code we do not control. A customer's helper sorting
        // `routes` in place would corrupt every subsequent request for as long
        // as the cache lives.
        const payload = campaignRoutesPayload(body.routes, Array.isArray(body.paths) ? body.paths : []);
        Object.freeze(payload.routes);
        Object.freeze(payload.paths);
        return Object.freeze(payload);
      }
    });
    loaders.set(origin, loader);
    if (loaders.size > MAX_ORIGINS) {
      const oldest = loaders.keys().next().value;
      if (oldest !== undefined) loaders.delete(oldest);
    }
    return loader;
  };

  const resolveOrigin = (origin?: string): string => {
    if (pinnedOrigin) return pinnedOrigin;
    if (typeof origin === 'string' && origin.length > 0) return origin;
    return lastOrigin;
  };

  return {
    getRoutes: async (origin?: string) => {
      const resolved = resolveOrigin(origin);
      lastOrigin = resolved;
      const payload = await loaderFor(resolved).read();
      return payload ? payload.routes : [];
    },
    pageExists: (candidate: string, origin?: string) => {
      // `get`, not `loaderFor`: an origin nothing has read yet has no evidence
      // to offer, and creating a loader to say so would let this synchronous
      // path grow the map.
      const payload = loaders.get(resolveOrigin(origin))?.peek() ?? null;
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
