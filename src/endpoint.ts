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
import { VERSION } from './version.js';
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
  /**
   * The version of this package the route handler was built with. Stamped by
   * `campaignRoutesPayload`, read by nobody in the request path: it is there
   * so whoever reads the endpoint — a person, or Tailor checking a site — can
   * see which version is deployed, since the code itself only updates when
   * the site does.
   */
  version?: string;
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
  paths === undefined
    ? { routes: routes ?? [], version: VERSION }
    : { routes: routes ?? [], paths, version: VERSION };

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
  /**
   * Headers sent with every read of the endpoint.
   *
   * For a preview behind Vercel Deployment Protection this is where the
   * bypass header goes, so the middleware can read its own rules there:
   * `{ 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET }`.
   * An entry whose value is `undefined` is skipped, so a variable that only
   * exists on previews adds nothing in production. A name that is not a plain
   * header token, or a value that is not a single header line, throws at
   * construction rather than becoming a header line somebody else wrote.
   *
   * Sent to whichever origin the policy approved, and nowhere else: a redirect
   * off that origin is refused before any second request. That makes a secret
   * here exactly as safe as the origin it is read from. On Vercel or Netlify
   * the platform resolved the Host, so the request origin is safe; anywhere
   * else, a forged Host would carry the secret away, so pin `origin` or set
   * `trustedOrigins` before putting a secret in here.
   */
  headers?: Record<string, string | undefined>;
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
 * An origin the deployment CONFIGURED (`origin`, a `trustedOrigins` entry),
 * held to what the message promises: absolute, http(s), no credentials. It
 * throws at construction, where somebody is looking. `canonicalOrigin` alone
 * accepts any scheme and drops credentials silently, so `ftp://host` or
 * `https://:secret@host` would survive it and fail every read after deploy —
 * a configuration mistake turned into a production outage with nothing
 * saying why.
 */
const configuredOrigin = (value: string, what: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`campaign routes: ${what} must be an absolute http(s) origin, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`campaign routes: ${what} must be an absolute http(s) origin, got ${JSON.stringify(value)}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`campaign routes: ${what} must not carry credentials; the endpoint is read without any`);
  }
  return url.origin;
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
    if (a === 168 && b === 63 && host === '168.63.129.16') return true; // Azure's wireserver, a public-range address that is its metadata service
    if (a === 192 && b === 0 && Number(ipv4[3]) === 0) return true; // 192.0.0.0/24, IETF protocol assignments (metadata on some clouds)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15, benchmarking
    if (a >= 224) return true; // multicast and reserved, 224.0.0.0/3
    return false;
  }
  if (host.includes(':')) {
    // IPv6: the unspecified address, link-local, unique-local, multicast, and
    // the two forms that carry an IPv4 address this list would otherwise not
    // see: NAT64 and 6to4.
    if (host === '::') return true;
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true;
    if (host.startsWith('ff')) return true;
    if (host.startsWith('64:ff9b:')) return true;
    if (host.startsWith('2002:')) return true;
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
    // Any 127.x.x.x, in the hex form the URL parser gives an IPv4-mapped address.
    host.startsWith('::ffff:7f') ||
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
  // The build's own word comes first: `next dev` sets NODE_ENV=development and
  // is never the platform, whatever `vercel env pull` left in .env.local (it
  // writes VERCEL=1 alongside the project's variables). The production half of
  // that cannot be told apart here: a self-host that ships that .env.local
  // reads as the platform. The README says not to, and a pinned `origin`
  // closes it regardless.
  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') return 'development';
  if (env.VERCEL || env.NETLIFY) return 'platform';
  return 'refuse';
};

export type OriginRefusalReason =
  | 'policy'
  | 'allowlist'
  | 'unsafe-address'
  | 'loopback-on-platform'
  | 'malformed'
  | 'no-origin';

/**
 * What `onError` is handed when a request origin is refused: the origin, and
 * why. Refusing switches every campaign off for that hostname, and the one
 * `console.warn` the source prints is consumed by the first refusal — on an
 * internet-facing self-host that is a scanner's bogus Host, not the customer's
 * real one — so the customer's own monitoring is told as well, once per
 * origin per isolate.
 */
export interface OriginRefusedError extends Error {
  kind: 'origin_refused';
  origin: string;
  reason: OriginRefusalReason;
}

const REFUSAL_ADVICE: Record<OriginRefusalReason, string> = {
  policy:
    'nothing vouches for a request origin here (NODE_ENV is not development, and this is not Vercel or Netlify). Self-hosting? Pass origin, the address this app listens on (e.g. http://localhost:3000). On a platform with several real hostnames, pass trustedOrigins.',
  allowlist:
    'it is not in trustedOrigins. Add it there if this site really answers on it; otherwise this is a request that was right to refuse.',
  'unsafe-address':
    'it names a private or link-local address, carries credentials, or is not http(s), which is refused under every policy. Pin origin if the endpoint really lives there.',
  'loopback-on-platform':
    'loopback is refused on a platform deployment. Pin origin if a local endpoint is intended.',
  malformed: 'it is not an absolute http(s) origin.',
  'no-origin':
    'no origin was given and none is pinned. Pass the request origin to getRoutes (the Next adapter does), or pin origin.'
};

/** An origin as it may appear in a log line: no control characters, bounded length. */
const printable = (value: string): string =>
  value.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 200);

const originRefused = (origin: string, reason: OriginRefusalReason): OriginRefusedError =>
  Object.assign(
    new Error(`campaign-routes: refused to read rules from ${printable(origin)}: ${REFUSAL_ADVICE[reason]}`),
    { kind: 'origin_refused' as const, origin, reason }
  );

/**
 * The largest rules payload a read will accept, so an endpoint that answers
 * with something enormous (the customer's own bug, under every policy that
 * fetches) is a failed read rather than an isolate out of memory. Ten
 * thousand rules is about 1.4 MB; this leaves room for a very large site.
 */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Where a redirect from the rules endpoint may go: the same origin, and one
 * hop. A Next app with `trailingSlash: true` answers `/api/campaign-routes`
 * with a 308 to the slash form, and that install must not fail closed. Anywhere
 * else is a failed read: following it would hand the address check a
 * destination the endpoint chose, after the check had already said yes to the
 * public hostname.
 */
const sameOriginRedirect = (location: string, origin: string): string | null => {
  try {
    const next = new URL(location, origin);
    return next.origin === origin ? next.toString() : null;
  } catch {
    return null;
  }
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
/**
 * The page list of each payload, normalised once, so `pageExists` is a lookup
 * rather than a pass over every path per candidate rule per request. Keyed
 * weakly on the payload: it lives exactly as long as the cache entry does and
 * never appears on the public shape.
 */
const normalizedPaths = new WeakMap<CampaignRoutesPayload, Set<string>>();

const frozenPayload = (routes: unknown, paths: unknown, version?: unknown): CampaignRoutesPayload => {
  const payload: CampaignRoutesPayload = { routes: normalizeRoutes(routes) };
  if (Array.isArray(paths)) payload.paths = paths.filter((path): path is string => typeof path === 'string');
  // The writer's version, carried as read; this side never stamps its own.
  if (typeof version === 'string') payload.version = version;
  if (payload.paths) {
    Object.freeze(payload.paths);
    normalizedPaths.set(payload, new Set(payload.paths.map(normalize)));
  }
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

/**
 * The characters a header name may contain (RFC 9110 token). Anything else,
 * a space, a colon, CR or LF, is refused at construction: the value came from
 * configuration, and a name that is not a token is either a typo that would
 * silently send nothing useful or an attempt to end the header and start
 * another one.
 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * What a header value may contain (RFC 9110 field-value: tab, printable
 * ASCII and the high half of Latin-1). Checked here so a NUL or a character
 * outside that range fails at construction, where a bad `origin` fails, and
 * not as a fetch error on every read.
 */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/**
 * The configured headers with the unset ones dropped, or `undefined` when
 * there is nothing to send, so a read with no configuration is the same
 * request it always was.
 */
const requestHeaders = (
  configured: Record<string, string | undefined> | undefined
): Record<string, string> | undefined => {
  if (!configured) return undefined;
  const sent: Record<string, string> = {};
  for (const name of Object.keys(configured)) {
    // The name is static configuration, so a typo fails everywhere, not only
    // on the deployment where the variable behind it happens to be set.
    if (!HEADER_NAME.test(name)) {
      throw new Error('campaign routes: headers entry is not a valid header name: ' + JSON.stringify(name));
    }
    const value = configured[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !HEADER_VALUE.test(value)) {
      throw new Error('campaign routes: headers entry ' + JSON.stringify(name) + ' must be a single-line header value');
    }
    sent[name] = value;
  }
  // Handed to every fetch for the life of the source, so nothing downstream
  // (a custom fetchImpl included) can rewrite it for the next read.
  return Object.keys(sent).length > 0 ? Object.freeze(sent) : undefined;
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
  const pinnedOrigin = config.origin === undefined ? undefined : configuredOrigin(config.origin, 'origin');
  // `origin + path` with a path that lost its leading slash parses as a
  // different host: `rules@evil.example` makes `https://site.test@evil.example`.
  if (config.path !== undefined && config.path.charAt(0) !== '/') {
    throw new Error(`campaign routes: path must start with "/", got ${JSON.stringify(config.path)}`);
  }
  // Normalised once, so `https://Example.com` and `https://example.com/` match
  // the origin a URL actually reports.
  const trustedOrigins = config.trustedOrigins
    ? new Set(config.trustedOrigins.map((value) => configuredOrigin(value, 'trustedOrigins entry')))
    : null;
  const ttlMs = duration(config.ttlMs, DEFAULT_TTL_MS);
  const timeoutMs = duration(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  const headers = requestHeaders(config.headers);

  /** Insertion order is recency: a hit is re-inserted, and eviction takes the head. */
  const loaders = new Map<string, CachedLoader<CampaignRoutesPayload>>();
  // The origin most recently read, for a `pageExists` caller that names none.
  let lastOrigin = pinnedOrigin ?? '';
  let activeLoads = 0;
  const policy = requestOriginPolicy();
  let warnedRefusal = false;
  // Origins already reported through `onError`, so a scanner hammering one
  // bogus Host does not become one error per request; bounded like the cache.
  const reportedRefusals = new Set<string>();

  /**
   * Refuse, and say so. This package is otherwise silent on purpose, but a
   * refusal here switches every campaign off for that hostname, and the fix is
   * one line of configuration — exactly the silent miss the rest of the package
   * spends its care avoiding. The console hears about it once; the customer's
   * `onError` hears about every origin, with the reason.
   */
  const refuse = (origin: string, reason: OriginRefusalReason): null => {
    const error = originRefused(origin, reason);
    if (config.onError && !reportedRefusals.has(origin)) {
      if (reportedRefusals.size >= MAX_ORIGINS) reportedRefusals.clear();
      reportedRefusals.add(origin);
      try {
        config.onError(error);
      } catch {
        // A customer's error hook must not take the page down.
      }
    }
    if (!warnedRefusal && typeof console !== 'undefined') {
      warnedRefusal = true;
      console.warn(error.message);
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
      bootstrap: config.bootstrap
        ? frozenPayload(config.bootstrap.routes, config.bootstrap.paths, config.bootstrap.version)
        : undefined,
      load: async (signal) => {
        // Declining is not failing: the origin is not put into backoff and
        // the customer's monitoring is not told about a healthy upstream.
        if (activeLoads >= MAX_CONCURRENT_LOADS) throw deferredRead();
        activeLoads += 1;
        try {
          // `redirect: 'manual'`, never follow: the address check ran on the
          // origin, and a redirect is the endpoint choosing a new destination
          // after that check said yes. One same-origin hop is allowed, for a
          // Next app with `trailingSlash: true`; anything else is a failed read.
          let response = await doFetch(origin + path, { signal, redirect: 'manual', headers });
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (location === null) {
              throw new Error('campaign routes endpoint answered ' + String(response.status) + ' with no Location');
            }
            const next = sameOriginRedirect(location, origin);
            if (next === null) throw new Error('campaign routes endpoint redirected off its own origin');
            response = await doFetch(next, { signal, redirect: 'manual', headers });
            if (response.status >= 300 && response.status < 400) {
              throw new Error('campaign routes endpoint redirected twice');
            }
          }
          if (!response.ok) throw new Error('campaign routes endpoint answered ' + String(response.status));
          // Declared length first, where the origin states one; a body with
          // no length still parses, since the customer's own endpoint is the
          // only thing any policy fetches.
          const declared = response.headers && typeof response.headers.get === 'function'
            ? Number(response.headers.get('content-length'))
            : Number.NaN;
          if (Number.isFinite(declared) && declared > MAX_PAYLOAD_BYTES) {
            throw new Error('campaign routes endpoint answered with ' + String(declared) + ' bytes, more than this reads');
          }
          const body: unknown = await response.json();
          if (!isPayload(body)) throw new Error('campaign routes endpoint returned an unexpected shape');
          // `paths` may be absent or null (unknown, protects nothing) or a list.
          // Anything else is schema drift or a route-handler bug, and reading
          // it as "unknown" would cache the bad answer over the last good
          // inventory with the 404 guard switched off and nothing reported.
          // A failed read keeps the last good payload and tells `onError`.
          if (body.paths !== undefined && body.paths !== null && !Array.isArray(body.paths)) {
            throw new Error('campaign routes endpoint returned paths that is not a list');
          }
          return frozenPayload(body.routes, body.paths ?? undefined, body.version);
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
  const resolveOrigin = (origin: string | undefined, purpose: 'read' | 'answer'): string | null => {
    if (pinnedOrigin) return pinnedOrigin;
    if (typeof origin === 'string' && origin.length > 0) {
      // The canonical origin is what is fetched and what keys the cache, so a
      // caller passing a path or different casing lands on the same entry.
      const canonical = canonicalOrigin(origin);
      if (canonical === null) return refuse(origin, 'malformed');
      if (trustedOrigins) {
        return trustedOrigins.has(canonical) ? canonical : refuse(canonical, 'allowlist');
      }
      if (policy === 'refuse') return refuse(canonical, 'policy');
      // Checked on the value as given: canonicalisation drops credentials,
      // and an origin that carried them is refused, not cleaned.
      if (isRefusedRequestOrigin(origin)) return refuse(canonical, 'unsafe-address');
      if (policy === 'platform' && isLoopbackOrigin(canonical)) return refuse(canonical, 'loopback-on-platform');
      return canonical;
    }
    // No origin given and none pinned. A read has nothing to read from, and
    // "whichever origin read last" could be a scanner's forged Host, so it is
    // refused — loudly, since a caller that forgot the origin would otherwise
    // see every campaign off with nothing saying why. Answering `pageExists`
    // from the last read is different: it is evidence already in hand.
    if (purpose === 'read') return refuse('(none)', 'no-origin');
    return lastOrigin.length > 0 ? lastOrigin : null;
  };

  return {
    getRoutes: async (origin?: string) => {
      const resolved = resolveOrigin(origin, 'read');
      // A refused origin reads nothing: no fetch is made, and no other origin's
      // rules are handed back in its place.
      if (resolved === null) return [];
      lastOrigin = resolved;
      const payload = await loaderFor(resolved).read();
      return payload ? payload.routes : [];
    },
    pageExists: (candidate: string, origin?: string) => {
      const resolved = resolveOrigin(origin, 'answer');
      // `get`, not `loaderFor`: an origin nothing has read yet has no evidence
      // to offer, and creating a loader to say so would let this synchronous
      // path grow the map.
      const payload = resolved === null ? null : (loaders.get(resolved)?.peek() ?? null);
      // Nothing loaded yet, or an endpoint that sent no path list at all: no
      // evidence either way, so do not refuse on it. An empty list is not that
      // case — it is the endpoint saying nothing exists, and it refuses below.
      if (!payload || payload.paths === undefined) return true;
      const known = normalizedPaths.get(payload);
      return known ? known.has(normalize(candidate)) : false;
    }
  };
};
