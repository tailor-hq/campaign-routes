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

import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  createCachedLoader,
  deferredRead,
  duration,
  type CachedLoader
} from './internal/cached-loader.js';
import { normalizeRoutes } from './internal/freeze-routes.js';
import type { CampaignRoute } from './core/index.js';

/** The path Tailor's guide tells customers to serve the rules on. */
export const DEFAULT_ENDPOINT_PATH = '/api/campaign-routes';

export interface CampaignRoutesPayload {
  routes: CampaignRoute[];
  /**
   * The paths the site serves, so a rule whose page is not published yet is
   * skipped rather than rewritten to a 404. Two different things can be said
   * here: **leave it out** to say the inventory is unknown, which protects
   * nothing; **an empty list** says the site serves no pages, and refuses every
   * rewrite. A page query that failed into `[]` must fail closed, not open.
   */
  paths?: string[];
}

/**
 * Build the payload the endpoint returns.
 *
 * Trivial on purpose. It exists so the shape is written down in one place that
 * both halves import, rather than as a field name in a route handler and a
 * matching field name in a middleware that nothing checks against it. `paths`
 * is carried only when given, so "unknown" and "none" stay different answers.
 */
export const campaignRoutesPayload = (
  routes: CampaignRoute[],
  paths?: string[]
): CampaignRoutesPayload =>
  paths === undefined ? { routes: routes ?? [] } : { routes: routes ?? [], paths };

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
  /**
   * An absolute origin, when the endpoint is not on the same site — or when
   * the site's own origin is not to be trusted from the request.
   *
   * Once set, the request's origin is never consulted. Trusted as configured,
   * so it may name an internal address if that is where the endpoint lives.
   */
  origin?: string;
  /**
   * The only request origins this source will read from, when the request is
   * the source of truth for which hostname it is running on.
   *
   * The request origin is the Host header, and behind a forwarding proxy or on
   * self-hosted Next.js that header is attacker-supplied. Without this list the
   * default refuses the destinations only a server could reach (see
   * `isRefusedRequestOrigin`) and accepts anything else; with it, a request
   * origin not listed here reads no rules at all. Set it on any deployment
   * where the set of legitimate hostnames is known, which is most of them.
   */
  trustedOrigins?: string[];
  /** How long a fetched payload is reused. Default 60s. */
  ttlMs?: number;
  /** How long a single fetch may take before it is abandoned. Default 2500ms. */
  timeoutMs?: number;
  /**
   * How long the last good payload keeps serving while the endpoint is
   * unreachable. Default one hour. Past it, every request is served its
   * original page until a read succeeds, so a campaign somebody unpublished
   * cannot outlive an outage by more than this.
   */
  maxStaleMs?: number;
  /**
   * Told about every failed read, so your own monitoring can know the rules
   * are going stale. Never awaited, and a throw inside it is swallowed.
   */
  onError?: (error: unknown) => void;
  /**
   * Your runtime's way of keeping work alive past the response, so the refresh
   * behind a stale read is not cancelled with it on Cloudflare Workers or
   * Vercel's edge runtime. Wrap a native method rather than passing it
   * detached; a throw inside it is swallowed. See the Contentful source for
   * the per-request slot pattern.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  /**
   * Whether a stale read waits for its refresh rather than serving stale and
   * refreshing behind it. Default `false`; for a runtime that freezes the
   * moment the handler returns, where a background refresh may never run.
   */
  awaitStaleRefresh?: boolean;
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
   * second one is evidence. Unknown is spelled by a payload with no `paths`
   * at all; **an empty list is evidence**, and refuses every candidate.
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

/** The origin as a URL would spell it, or null when it is not one at all. */
const canonicalOrigin = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/**
 * Whether a request-derived origin names somewhere only the server could reach.
 *
 * A forged Host header can name any hostname at all, and the fetch this source
 * makes from it is a server-side request from inside the customer's network.
 * The path is fixed and the response is never returned to the requester, so the
 * primitive is blind — but a blind GET to a cloud metadata service or a
 * private address is still a request the customer never meant to make. Those
 * destinations are refused outright for a request-derived origin; a pinned
 * `origin` is trusted as configured, since a customer may legitimately keep the
 * endpoint on an internal address.
 *
 * Loopback is deliberately NOT on this list. `next dev` serves on
 * `localhost:3000`, so refusing it breaks every developer's first run of the
 * package, and a request to a server's own loopback reaches only what that
 * server already exposes to itself. A self-hosted production deployment should
 * close even that with `origin` or `trustedOrigins`.
 *
 * **Literal addresses only.** Nothing here resolves DNS, so a hostname that
 * points at a private address (`metadata.google.internal`, an attacker's own
 * record) passes this check. That is why the policy in `requestOriginPolicy`
 * is the gate and this list is the backstop behind it: under `refuse` nothing
 * is fetched, under `platform` the platform vouches for the hostname, under
 * `trustedOrigins` only the names the deployment listed are read.
 */
export const isRefusedRequestOrigin = (origin: string): boolean => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return true;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (url.username !== '' || url.password !== '') return true;

  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // An IPv4 address carried inside an IPv6 one is the IPv4 address. The URL
  // parser hands it back in hex form — `[::ffff:10.0.0.5]` becomes
  // `::ffff:a00:5` — so the two 16-bit groups are turned back into octets
  // before the IPv4 rules below get to look at them.
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    const groups = mapped.split(':');
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
      const high = parseInt(groups[0]!, 16);
      const low = parseInt(groups[1]!, 16);
      host = [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
    } else {
      host = mapped;
    }
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0) return true; // 0.0.0.0/8, "this host"
    if (a === 10) return true; // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 192 && b === 168) return true; // RFC 1918
    if (a === 169 && b === 254) return true; // link-local, and every cloud metadata service
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT, and some metadata services
    return false;
  }
  if (host.includes(':')) {
    // IPv6: the unspecified address, link-local, unique-local, and NAT64,
    // which carries an IPv4 address this list would otherwise not see.
    if (host === '::') return true;
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (host.startsWith('64:ff9b:')) return true;
  }
  return false;
};

/** Whether an origin names this machine — `next dev`'s address, and nobody else's business in production. */
export const isLoopbackOrigin = (origin: string): boolean => {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '::ffff:7f00:1' ||
    host.startsWith('127.')
  );
};

/**
 * How far a request's own origin is trusted, decided by where the code runs.
 *
 * - **`platform`** — a host that routes by hostname (Vercel, Netlify) never
 *   hands the app a request whose Host it did not itself resolve, so the origin
 *   is the platform's word rather than the client's. Any public origin is read;
 *   loopback is not, since production has no business reaching it.
 * - **`development`** — a build that says so: `NODE_ENV` of `development` or
 *   `test`, which `next dev` and every test runner set. Public origins and
 *   loopback both, so a first run against a local endpoint needs no
 *   configuration.
 * - **`refuse`** — everything else, including an unset `NODE_ENV` and a
 *   runtime with no `process` at all (Cloudflare Workers, Deno). Unknown is
 *   refused, never assumed to be development: a self-hosted Next.js or
 *   anything behind a proxy that forwards Host has no vouching to lean on, so
 *   a request-derived origin reads nothing until the deployment says where
 *   its rules are. For a self-hosted `next start` that is a pinned `origin`:
 *   the origin the middleware sees there is the address Next is bound to
 *   (`http://localhost:3000`), never the public hostname, so an allowlist of
 *   public hostnames would match nothing. `trustedOrigins` is for a platform
 *   deployment answering on several real hostnames. That is the fail-closed
 *   default a public package owes its users, and it is loud rather than
 *   silent: see the warning in `createEndpointRouteSource`.
 *
 * Exported so the decision is testable without a deploy.
 */
export type RequestOriginPolicy = 'platform' | 'development' | 'refuse';

export const requestOriginPolicy = (
  env: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {}
): RequestOriginPolicy => {
  if (env.VERCEL || env.NETLIFY) return 'platform';
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return 'development';
  return 'refuse';
};

/**
 * How many rule reads this source will have in flight at once, across every
 * origin. The cache size bounds what is remembered, not what is fetched: each
 * new origin starts a read before anything is evicted, so a burst of forged
 * Hosts would otherwise fan out into as many concurrent server-side requests.
 * Past this, a read for a new origin answers with nothing rather than joining
 * the pile.
 */
const MAX_CONCURRENT_LOADS = 4;

const isPayload = (value: unknown): value is CampaignRoutesPayload =>
  !!value && typeof value === 'object' && Array.isArray((value as CampaignRoutesPayload).routes);

/**
 * A payload built from input this package did not construct — the endpoint's
 * JSON, or a caller's bootstrap — as fresh, leaf-frozen copies. Every request
 * on this isolate gets these by reference, and the callers are code we do not
 * control; a malformed rule is skipped rather than failing the payload, and a
 * path that is not a string is dropped.
 */
const frozenPayload = (routes: unknown, paths: unknown): CampaignRoutesPayload => {
  const payload = campaignRoutesPayload(
    normalizeRoutes(routes),
    Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : undefined
  );
  if (payload.paths) Object.freeze(payload.paths);
  return Object.freeze(payload);
};

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
  // Both fail at construction, where somebody is looking, rather than per
  // request. `origin: process.env.SELF_ORIGIN ?? ''` with the variable unset
  // would otherwise fall through to request trust nobody asked for, and a
  // `trustedOrigins` entry without a scheme would be dropped silently and
  // refuse every request with only the one-time warning to say why.
  const pinnedOrigin = config.origin;
  if (pinnedOrigin !== undefined && canonicalOrigin(pinnedOrigin) === null) {
    throw new Error(
      `campaign routes: origin must be an absolute http(s) origin, got ${JSON.stringify(pinnedOrigin)}`
    );
  }
  // Normalised once, so `https://Example.com` and `https://example.com/` match
  // the origin a URL actually reports.
  const trustedOrigins = config.trustedOrigins
    ? new Set(
        config.trustedOrigins.map((value) => {
          const canonical = canonicalOrigin(value);
          if (canonical === null) {
            throw new Error(
              `campaign routes: trustedOrigins entry must be an absolute http(s) origin, got ${JSON.stringify(value)}`
            );
          }
          return canonical;
        })
      )
    : null;
  const ttlMs = duration(config.ttlMs, DEFAULT_TTL_MS);
  const timeoutMs = duration(config.timeoutMs, DEFAULT_TIMEOUT_MS);

  /** Insertion order is recency: a hit is re-inserted, and eviction takes the head. */
  const loaders = new Map<string, CachedLoader<CampaignRoutesPayload>>();
  // The origin most recently read, for a `pageExists` caller that names none.
  let lastOrigin = pinnedOrigin ?? '';
  let activeLoads = 0;
  const policy = requestOriginPolicy();
  let warnedRefusal = false;

  /**
   * Refuse, and say so once. This package is otherwise silent on purpose, but
   * a refusal here switches every campaign off for that hostname with nothing
   * else anywhere reporting it, and the fix is one line of configuration —
   * exactly the silent miss the rest of the package spends its care avoiding.
   */
  const refuse = (origin: string): null => {
    if (!warnedRefusal && typeof console !== 'undefined') {
      warnedRefusal = true;
      console.warn(
        `campaign-routes: refused to read rules from ${origin}. Self-hosting? Pass origin, the address this app listens on (e.g. http://localhost:3000), to createEndpointRouteSource. On a platform with several real hostnames, pass trustedOrigins instead.`
      );
    }
    return null;
  };

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
      maxStaleMs: config.maxStaleMs,
      onError: config.onError,
      waitUntil: config.waitUntil,
      awaitStaleRefresh: config.awaitStaleRefresh,
      // The shipped rules are for this deploy, whichever hostname it answers on.
      // Copied and frozen, so the caller's own object neither leaks into the
      // cache nor is frozen under them.
      bootstrap: config.bootstrap ? frozenPayload(config.bootstrap.routes, config.bootstrap.paths) : undefined,
      load: async (signal) => {
        // Declining is not failing: the origin is not put into backoff and
        // the customer's monitoring is not told about a healthy upstream.
        if (activeLoads >= MAX_CONCURRENT_LOADS) throw deferredRead();
        activeLoads += 1;
        try {
          const response = await doFetch(origin + path, { signal });
          if (!response.ok) throw new Error('campaign routes endpoint answered ' + String(response.status));
          const body: unknown = await response.json();
          if (!isPayload(body)) throw new Error('campaign routes endpoint returned an unexpected shape');
          return frozenPayload(body.routes, body.paths);
        } finally {
          activeLoads -= 1;
        }
      }
    });
    loaders.set(origin, loader);
    if (loaders.size > MAX_ORIGINS) {
      const oldest = loaders.keys().next().value;
      if (oldest !== undefined) loaders.delete(oldest);
    }
    return loader;
  };

  /**
   * Which origin to read for, or null for a request origin this source will
   * not fetch from. A pinned origin wins outright and is never checked. A
   * request-derived one is checked against the allowlist when there is one;
   * otherwise the policy decides, and the destinations only a server could
   * reach are refused under every policy.
   */
  const resolveOrigin = (origin?: string): string | null => {
    if (pinnedOrigin) return pinnedOrigin;
    if (typeof origin === 'string' && origin.length > 0) {
      if (trustedOrigins) {
        return trustedOrigins.has(canonicalOrigin(origin) ?? '') ? origin : refuse(origin);
      }
      if (policy === 'refuse') return refuse(origin);
      if (isRefusedRequestOrigin(origin)) return refuse(origin);
      if (policy === 'platform' && isLoopbackOrigin(origin)) return refuse(origin);
      return origin;
    }
    return lastOrigin.length > 0 ? lastOrigin : null;
  };

  return {
    getRoutes: async (origin?: string) => {
      const resolved = resolveOrigin(origin);
      // A refused origin reads nothing: no fetch is made, and no other origin's
      // rules are handed back in its place.
      if (resolved === null) return [];
      lastOrigin = resolved;
      const payload = await loaderFor(resolved).read();
      return payload ? payload.routes : [];
    },
    pageExists: (candidate: string, origin?: string) => {
      const resolved = resolveOrigin(origin);
      // `get`, not `loaderFor`: an origin nothing has read yet has no evidence
      // to offer, and creating a loader to say so would let this synchronous
      // path grow the map.
      const payload = resolved === null ? null : (loaders.get(resolved)?.peek() ?? null);
      // Nothing loaded yet, or an endpoint that sent no path list at all: no
      // evidence either way, so do not refuse on it. An empty list is not that
      // case — it is the endpoint saying nothing exists, and it refuses below.
      if (!payload || payload.paths === undefined) return true;
      const wanted = normalize(candidate);
      for (let index = 0; index < payload.paths.length; index += 1) {
        if (normalize(payload.paths[index]!) === wanted) return true;
      }
      return false;
    }
  };
};
