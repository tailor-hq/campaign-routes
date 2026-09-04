/**
 * Reading the campaign rules out of the customer's own Contentful, and caching
 * them.
 *
 * # Their Contentful, never Tailor
 *
 * The rules are entries in the space they already own, fetched with their own
 * delivery token, from an API their site already talks to and already caches.
 * **Tailor is not in the request path**, so a Tailor outage cannot affect their
 * page loads — which is a property worth being able to state plainly in a
 * security review, and therefore one that has to be structural rather than
 * incidental.
 *
 * # Only published entries, and that is the Delivery API's doing
 *
 * Tailor writes every rule as a draft. The CDA serves published entries only, so
 * a rule nobody has published is invisible here — the customer's team publishing
 * it is what turns the campaign on, and unpublishing it is what turns it off.
 * No `active` flag to learn, and no way for an unreviewed draft to reach a
 * visitor.
 */

import { createCachedLoader } from './internal/cached-loader.js';
import type { CampaignRoute } from './core/index.js';
import type { RouteSource } from './route-source.js';

/** The content type Tailor installs to hold the rules. */
export const CAMPAIGN_ROUTE_TYPE_ID = 'tailorCampaignRoute';

export interface ContentfulRouteSourceConfig {
  spaceId: string;
  /** Defaults to `master`, which is what a space has unless somebody changed it. */
  environmentId?: string;
  /** A Content **Delivery** API token. Read-only, and published entries only. */
  deliveryToken: string;
  /**
   * The API host. Defaults to `cdn.contentful.com`, the Delivery API.
   *
   * Set it to `preview.contentful.com` — with that environment's preview token —
   * on a staging deploy, and the same code serves campaigns that are still
   * drafts. That is the only way to see a campaign before publishing it, since
   * Tailor writes every rule as a draft and the Delivery API cannot see drafts
   * by design.
   *
   * **Never point production at preview.** It would serve every unreviewed rule
   * in the space to real visitors, which is precisely the safety property the
   * draft-only write model exists to provide.
   *
   * Only Contentful's own hosts are accepted — see `CONTENTFUL_HOSTS`. The
   * request carries the delivery token in an `Authorization` header, so a host
   * read from configuration is a route for that token to leave the building.
   */
  host?: string;
  /** Defaults to `en-US`. */
  locale?: string;
  /**
   * How long a fetched rule set is reused. Default 60s.
   *
   * The trade is how long a just-published campaign takes to go live against how
   * often a page load waits on Contentful. Sixty seconds is short enough that
   * nobody watches a spinner wondering if it worked, and long enough that the
   * fetch is amortised across effectively all traffic.
   */
  ttlMs?: number;
  /**
   * How long a single fetch may take before it is abandoned. Default 2500ms.
   *
   * **Without a deadline the fail-open promise below is not one.** Failing open
   * requires the fetch to *settle*; a connection Contentful accepts and then
   * stalls on never rejects, so the adapter's catch block is never reached and
   * the request simply waits. In Lambda@Edge the platform then kills the
   * invocation before JavaScript regains control, and the visitor gets an error
   * page — the exact outcome every other line here exists to prevent.
   *
   * The default sits below the strictest runtime this package targets: a
   * CloudFront viewer-request Lambda@Edge is killed at 5 seconds, so 2500ms
   * leaves the handler time to do its own work and answer.
   */
  timeoutMs?: number;
  /**
   * Rules to serve until the first real read lands.
   *
   * An edge runtime spawns isolates constantly and each begins with an empty
   * cache, so without this the first visitor to reach each new one gets the
   * un-personalized page. Treated as already stale, so it never delays the
   * truth — it only fills the gap in front of it.
   */
  bootstrap?: CampaignRoute[];
  /** Injectable for tests and for runtimes with a non-global fetch. */
  fetchImpl?: typeof fetch;
}

interface ContentfulEntry {
  fields?: Record<string, unknown>;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_500;

/**
 * The only hosts this will send a token to.
 *
 * An allowlist rather than a charset check, because the docstring on `host`
 * teaches "set it to `preview.contentful.com` on a staging deploy" — which
 * invites reading it from an env var, and an env var is one deploy-config
 * mistake away from `evil.example`. Every request carries
 * `Authorization: Bearer <delivery token>`, so an unvalidated host is a route
 * for that token to leave. Shapes like `cdn.contentful.com@evil.example` and
 * `cdn.contentful.com/../` are the ones that read as fine to a human reviewer
 * and resolve somewhere else; an allowlist refuses all of them without anyone
 * having to enumerate them.
 */
const CONTENTFUL_HOSTS = ['cdn.contentful.com', 'preview.contentful.com'];

/** Contentful's own per-page maximum. Asking for more is an error, not a bigger page. */
const PAGE_SIZE = 1000;

/**
 * A ceiling on the paging loop.
 *
 * Ten pages is 10,000 campaign rules, which is far past anything a marketing
 * team will hand-publish. It exists so a wrong or ever-growing `total` cannot
 * hold a request open until the deadline kills it — an infinite loop inside the
 * timeout looks, from the visitor's seat, exactly like Contentful being down.
 */
const MAX_PAGES = 10;

/** Contentful returns a locale map when a space is localized, a bare value otherwise. */
const readField = (fields: Record<string, unknown> | undefined, id: string, locale: string): unknown => {
  if (!fields) return undefined;
  const raw = fields[id];
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && locale in (raw as object)) {
    return (raw as Record<string, unknown>)[locale];
  }
  return raw;
};

/**
 * Turn CDA entries into rules, dropping any that are not usable.
 *
 * Dropping rather than throwing: these come from a CMS a person edits, and one
 * half-filled entry must not take every campaign on the site down with it. The
 * core refuses malformed rules too — this is the same instinct one layer up,
 * where it also keeps the cached payload small.
 */
export const toCampaignRoutes = (items: ContentfulEntry[], locale: string): CampaignRoute[] => {
  const routes: CampaignRoute[] = [];
  for (const item of items ?? []) {
    const basePath = readField(item?.fields, 'basePath', locale);
    const targetPath = readField(item?.fields, 'targetPath', locale);
    const matchParams = readField(item?.fields, 'matchParams', locale);
    if (typeof basePath !== 'string' || typeof targetPath !== 'string') continue;
    if (!matchParams || typeof matchParams !== 'object' || Array.isArray(matchParams)) continue;

    // Values are compared as strings by the core; anything else is a content
    // mistake rather than something to coerce and guess at.
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(matchParams as Record<string, unknown>)) {
      if (typeof value === 'string') params[key] = value;
    }
    if (Object.keys(params).length === 0) continue;

    routes.push({ basePath, targetPath, matchParams: params });
  }
  return routes;
};

/**
 * A rule source that fetches from Contentful and caches for `ttlMs`.
 *
 * # It never throws, and it never returns nothing because of an error
 *
 * A failed fetch answers with the **last good rule set** if there is one, and an
 * empty list if there is not. Both mean "serve the page you were going to
 * serve", which is what the visitor would have got before any of this existed.
 *
 * Serving stale rules through an outage is deliberate and is the safer half of
 * the trade: the alternative is that a Contentful blip silently switches every
 * campaign off, turning a content-delivery problem into a marketing one at the
 * worst possible moment.
 *
 * # One in-flight fetch at a time
 *
 * Without that, the moment a cache expires under load every concurrent request
 * starts its own fetch — a thundering herd aimed at the customer's own
 * rate-limited Contentful, caused by us.
 */
export const createContentfulRouteSource = (config: ContentfulRouteSourceConfig): RouteSource => {
  const environmentId = config.environmentId ?? 'master';
  const locale = config.locale ?? 'en-US';
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;

  const host = config.host ?? CONTENTFUL_HOSTS[0]!;
  if (!CONTENTFUL_HOSTS.includes(host)) {
    // Throws at construction, not per request. A misconfigured host is a deploy
    // mistake, and the deploy is where somebody is looking — failing open here
    // would send the token first and report nothing.
    throw new Error(
      `campaign-routes: host must be one of ${CONTENTFUL_HOSTS.join(', ')} — got "${host}"`
    );
  }

  const pageUrl = (skip: number): string =>
    'https://' +
    host +
    '/spaces/' +
    encodeURIComponent(config.spaceId) +
    '/environments/' +
    encodeURIComponent(environmentId) +
    '/entries?content_type=' +
    encodeURIComponent(CAMPAIGN_ROUTE_TYPE_ID) +
    '&limit=' +
    String(PAGE_SIZE) +
    '&skip=' +
    String(skip) +
    // Without a stable order, two pages of a set somebody is editing can miss an
    // entry or repeat one. `sys.id` is the only field every entry has.
    '&order=sys.id';

  /**
   * Fetch every page, not just the first.
   *
   * Contentful caps a page at 1000 entries and reports `total`. Reading only
   * `items` means that past 1000 rules some campaigns simply never route, with
   * nothing anywhere saying so — the silent-miss shape the rest of this package
   * works to avoid. `MAX_PAGES` bounds the loop so a `total` that never stops
   * growing cannot hold a request open until the deadline kills it.
   */
  const loader = createCachedLoader<CampaignRoute[]>({
    ttlMs,
    timeoutMs,
    bootstrap: config.bootstrap,
    load: async (signal) => {
      const routes: CampaignRoute[] = [];
      let skip = 0;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await doFetch(pageUrl(skip), {
          headers: { Authorization: 'Bearer ' + config.deliveryToken },
          signal
        });
        if (!response.ok) throw new Error('Contentful answered ' + String(response.status));
        // Reading the body stays inside the deadline: a response whose headers
        // arrive and whose body then stalls hangs exactly as a stalled
        // connection does, and aborting the signal tears the body stream down.
        const body = (await response.json()) as { items?: ContentfulEntry[]; total?: number };
        const items = body?.items ?? [];
        for (const route of toCampaignRoutes(items, locale)) routes.push(route);

        skip += items.length;
        // Stop on a short page as well as on the count: a `total` that is
        // missing or wrong must not turn into an unbounded loop, and a page
        // that came back empty would otherwise never advance `skip`.
        if (items.length < PAGE_SIZE) break;
        if (typeof body?.total !== 'number' || skip >= body.total) break;
      }
      // Frozen because every caller gets this same array by reference, and the
      // callers are code we do not control. A customer's `pageExists` helper or
      // logging wrapper sorting it in place would corrupt every subsequent
      // request on that isolate, for as long as the cache lives.
      return Object.freeze(routes) as CampaignRoute[];
    }
  });

  return {
    getRoutes: async () => (await loader.read()) ?? []
  };
};
