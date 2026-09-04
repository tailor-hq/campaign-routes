/**
 * The AWS Lambda@Edge adapter, for a site served by CloudFront.
 *
 * # PROTOTYPE: this has never run in Lambda@Edge
 *
 * Its decisions are the same ones the Next.js adapter makes — same core, same
 * tests, and it has been driven in process against a real Contentful space. So
 * the matching is not the risk. Everything the runtime contributes is: cold
 * starts on an idle POP, the 5-second viewer-request kill, `us-east-1`-only
 * publishing, and the 5-8 minutes a version takes to propagate. None of it has
 * been observed, and the notes below about those numbers are read from AWS's
 * documentation rather than measured here.
 *
 * The one that will bite first: **Lambda@Edge does not support environment
 * variables**, so the `process.env` reads in the README's snippet for this
 * adapter cannot resolve at the edge. Baking the values in at build time or
 * reading Secrets Manager on cold start are the usual answers. Confirm against
 * current AWS documentation before building on this.
 *
 * The expected customer deploy is Next.js. Prefer `./next.js`.
 *
 * # Why Lambda@Edge rather than a CloudFront Function
 *
 * A CloudFront Function is cheaper and faster, and it is the wrong tool here:
 * **it cannot make network calls**, so the rules would have to be pushed into a
 * KeyValueStore by something outside the customer's own deploy. That is a second
 * moving part for their team to own, monitor and reason about, and it is the
 * part that fails silently when it stops running.
 *
 * Lambda@Edge fetches the rules itself, so installing this is one Lambda and one
 * behavior association — the same shape every other vendor in this space ships,
 * and the one a customer's platform team has done before. It costs a cold start
 * of roughly 100-200ms on an idle POP and about 6x per-request, against a
 * viewer-request function that runs on a page nobody had to build a pipeline for.
 *
 * Two operational facts worth stating in the install doc rather than discovering:
 * the function must be created in **us-east-1** to be associated with a
 * distribution, and each new version takes about 5-8 minutes to propagate.
 *
 * # Viewer request, not origin request
 *
 * `viewer-request` runs on every request; `origin-request` runs only on a cache
 * miss. A campaign rewrite decided at origin-request would be **cached against
 * the un-rewritten cache key**, so the first visitor's campaign page would then
 * be served to organic traffic, and vice versa. Getting this wrong is a
 * cross-visitor content leak, not a performance regression, which is why the
 * factory names the trigger it is for.
 *
 * The customer's distribution must also forward the campaign query parameters in
 * its cache policy, or CloudFront will serve one cached page for every variant of
 * the URL — same failure, arrived at from the other direction.
 */

import { matchCampaignRoute } from '../../src/core/index.js';
import type { RouteSource } from '../../src/route-source.js';
import { notifyMatch, type OnCampaignMatch } from '../../src/internal/on-match.js';

export type { CampaignMatchEvent, OnCampaignMatch } from '../../src/internal/on-match.js';

/** The subset of the CloudFront viewer-request event this reads. */
export interface CloudFrontRequest {
  uri: string;
  querystring: string;
  [key: string]: unknown;
}

export interface CloudFrontEvent {
  Records: Array<{ cf: { request: CloudFrontRequest } }>;
}

export interface CampaignRouteHandlerOptions {
  /** Whether the campaign page exists. See `MatchOptions.pageExists`. */
  pageExists?: (path: string) => boolean;
  /**
   * Called when a campaign page is about to be served.
   *
   * Never awaited and never allowed to throw — see `notifyMatch`. At viewer
   * request that matters more than anywhere else: this runs on every campaign
   * click, in every region, and an uncaught throw here is a 502.
   */
  onMatch?: OnCampaignMatch;
}

/**
 * Parse a CloudFront `querystring` (no leading `?`) into a plain map.
 *
 * Written by hand rather than with `URLSearchParams` for one reason: this must
 * treat `+` as a space. `utm_term=enterprise+plan` is what Google actually
 * sends, and `decodeURIComponent` alone leaves the plus in place — so the rule a
 * marketer typed as `enterprise plan` would never match the traffic it was
 * written for. That is a silent miss, which is the failure this package spends
 * most of its care avoiding.
 */
export const parseQueryString = (querystring: string): Record<string, string> => {
  const params: Record<string, string> = {};
  if (typeof querystring !== 'string' || querystring.length === 0) return params;

  const pairs = querystring.split('&');
  for (const pair of pairs) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf('=');
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? '' : pair.slice(equals + 1);
    try {
      const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
      if (key.length === 0) continue;
      // Last value wins on a repeated key, matching what a browser does.
      params[key] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      // A malformed percent-escape throws. Skip the pair rather than the request:
      // one unparseable parameter must not decide the whole page.
      continue;
    }
  }
  return params;
};

/**
 * A viewer-request handler that rewrites matching campaign traffic.
 *
 * It **mutates `request.uri` and returns the request**, which is how CloudFront
 * spells a rewrite. It never returns a 301/302: a redirect changes the address
 * bar, dropping the campaign parameters the customer's analytics reads and
 * showing the visitor a URL their ad did not promise.
 *
 * **It never throws.** Any failure — the rule source down, a malformed event, a
 * bug in here — returns the request untouched, so the visitor gets the page they
 * would have got before any of this existed. An edge function that can throw is
 * one that can 503 a marketing site, and no campaign is worth that.
 */
export const createCampaignRouteHandler = (
  source: RouteSource,
  options?: CampaignRouteHandlerOptions
) => {
  return async (event: CloudFrontEvent): Promise<CloudFrontRequest> => {
    const request = event?.Records?.[0]?.cf?.request;
    if (!request) {
      // Unreachable from CloudFront, which always sends a record. There is no
      // good answer here and no pretending otherwise: this object has no
      // `method` or `headers`, so CloudFront answers 502 LambdaValidationError
      // — the same outcome as throwing. It is returned rather than thrown
      // because a value can be inspected in a test and a log line, and because
      // the function's signature stays "returns a request" for every caller.
      return { uri: '/', querystring: '' };
    }

    try {
      // Organic traffic carries no query string and is the majority of requests.
      // Answering it here keeps the common case off the rule source entirely.
      if (!request.querystring) return request;

      const routes = await source.getRoutes();
      // The caller's answer wins; otherwise the source's, if it has one —
      // exactly as the Next adapter resolves it.
      //
      // This adapter used to pass `options` straight through and never look at
      // the source, so a source that CAN say whether a page exists had that
      // answer used on Next.js and ignored on CloudFront. The two adapters
      // disagreeing is the one thing this package cannot afford: a customer
      // running both across one site, or moving between them, has to get the
      // same answer from each, and the difference here was a live ad rewriting
      // to a page that is not published yet.
      const pageExists = options?.pageExists ?? source.pageExists;
      const match = matchCampaignRoute(
        routes,
        { path: request.uri, searchParams: parseQueryString(request.querystring) },
        pageExists ? { pageExists } : undefined
      );
      if (!match) return request;

      notifyMatch(options?.onMatch, {
        requestedPath: request.uri,
        targetPath: match.targetPath,
        matchParams: match.route.matchParams,
        route: match.route
      });

      // The query string is deliberately left intact: the campaign page still
      // needs it for the customer's own analytics, and the visitor's URL does
      // not change at all.
      request.uri = match.targetPath;
      return request;
    } catch {
      return request;
    }
  };
};
