/**
 * The Next.js middleware adapter.
 *
 * # It returns a decision; you do the rewrite
 *
 * This deliberately does not import `next`, construct a `NextResponse`, or call
 * `rewrite` for you. Two reasons, and the second is the important one:
 *
 * - The package stays free of a peer dependency it would then have to track
 *   across Next major versions.
 * - **The line that touches the request stays in the customer's own file.** When
 *   their marketing site misbehaves at 2am, the person reading `middleware.ts`
 *   can see exactly what happens to a request without opening `node_modules`.
 *   That is worth more than the two lines it saves.
 *
 * Their whole middleware:
 *
 * ```ts
 * import { NextResponse, type NextRequest } from 'next/server';
 * import { createEndpointRouteSource } from '@tailor-ai/campaign-routes/endpoint';
 * import { campaignRouteFor } from '@tailor-ai/campaign-routes/next';
 *
 * const source = createEndpointRouteSource();
 *
 * export async function middleware(request: NextRequest) {
 *   const target = await campaignRouteFor(request, source);
 *   if (!target) return NextResponse.next();
 *
 *   const url = request.nextUrl.clone();
 *   url.pathname = target;
 *   return NextResponse.rewrite(url);
 * }
 *
 * export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'] };
 * ```
 *
 * plus one route handler, which is where their existing content client lives:
 *
 * ```ts
 * // app/api/campaign-routes/route.ts
 * import { campaignRoutesPayload } from '@tailor-ai/campaign-routes/endpoint';
 * import { CAMPAIGN_ROUTE_TYPE_ID, toCampaignRoutes } from '@tailor-ai/campaign-routes/contentful';
 *
 * export const revalidate = 60;
 *
 * // The raw `getEntries` collection is not a rule list; this is the shape that works.
 * const getCampaignRoutes = async () =>
 *   toCampaignRoutes((await client.getEntries({ content_type: CAMPAIGN_ROUTE_TYPE_ID })).items, 'en-US');
 *
 * export async function GET() {
 *   const [rules, pages] = await Promise.all([getCampaignRoutes(), getAllPages()]);
 *   return Response.json(campaignRoutesPayload(rules, pages.map((p) => p.path)));
 * }
 * ```
 *
 * # Why a route handler rather than reading Contentful from the edge
 *
 * `/contentful` exists and would remove that file, and it is still the wrong
 * default here. Middleware runs in the Edge runtime, before the app, so the
 * customer's content SDK is not available to it — they need a route either way.
 * And because that route runs *inside* the app, it can return the rules **and
 * the paths that exist**, which is what answers "is the campaign page actually
 * published yet". Reading the CDA from the edge cannot answer that, so a rule
 * published before its page turns a live ad into a 404 for as long as nobody
 * notices. `campaignRouteFor` picks the source's `pageExists` up on its own, so
 * the protection is on by default rather than something to know to wire up.
 *
 * The `api/` exclusion in the matcher saves a middleware invocation per rules
 * read and per API call. It is not what prevents a loop: the middleware's own
 * read carries no query string, so it is answered below before any lookup.
 *
 * # `nextUrl.clone()`, never `new URL(target, request.url)`
 *
 * That is the one line in the snippet worth being careful about, and the
 * shorter spelling is wrong. `new URL('/pricing-enterprise', 'https://site/pricing?utm_term=…')`
 * has an **empty** `search`, and Next forwards the rewrite destination verbatim
 * — so the campaign page is rendered with no `utm_*` and no `gclid`, on exactly
 * the requests this feature exists to serve. Any server-side attribution, and
 * any server component reading `searchParams`, sees nothing.
 *
 * It also makes the two adapters disagree: the Lambda@Edge one leaves the query
 * string untouched. A customer moving from Next.js to CloudFront, or running
 * both across one site, has to get the same answer from each.
 *
 * `clone()` carries the search across; building a fresh `URL` from a bare path
 * cannot.
 *
 * # Rewrite, never redirect, and never read the parameter in the page
 *
 * A redirect changes the address bar, which loses the campaign parameters the
 * customer's analytics is reading and shows the visitor a URL their ad did not
 * promise.
 *
 * And the rewrite has to happen HERE rather than by branching inside the page:
 * in Next.js, a component that reads `searchParams` opts its whole route out of
 * static generation. Measured on a real site — one such read turned a
 * `/[...slug]` catch-all from prerendered into dynamic, so every marketing page
 * server-rendered per request, including the organic majority that has nothing
 * to do with any campaign.
 */

import { matchCampaignRoute } from './core/index.js';
import type { RouteSource } from './route-source.js';
import { notifyMatch, type OnCampaignMatch } from './internal/on-match.js';

export type { CampaignMatchEvent, OnCampaignMatch } from './internal/on-match.js';

/** Just enough of a request to decide. `NextRequest` and `Request` both satisfy it. */
export interface RequestLike {
  url: string;
}


export interface CampaignRouteForOptions {
  /**
   * Whether the campaign page exists. See `MatchOptions.pageExists`.
   *
   * Overrides the source's own answer when both are present, so a caller who
   * knows better always wins.
   */
  pageExists?: (path: string) => boolean;
  /**
   * Called when a campaign page is about to be served.
   *
   * This package sends nothing anywhere, which also meant nothing in the
   * customer's own stack could tell that a campaign served — so a conversion
   * could not be attributed to one. This is the seam for that: their function,
   * their destination.
   *
   * Never awaited and never allowed to throw, so an analytics call cannot cost
   * a page load. See `notifyMatch`.
   */
  onMatch?: OnCampaignMatch;
}

/**
 * Turn a URL's query string into the plain map the core compares against.
 *
 * Last value wins on a repeated key, which is what a browser does with
 * `?a=1&a=2` and therefore what the visitor's own request means.
 */
const readSearchParams = (url: URL): Record<string, string> => {
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  return params;
};

/**
 * The path this request should be rewritten to, or null to leave it alone.
 *
 * **Never throws.** Every failure — an unparseable URL, a rule source that is
 * down, a bug in here — answers null, which means "serve the page you were
 * going to serve". That is the floor the whole design rests on: nothing about
 * campaign routing may cost a customer a page load, and it is enforced by the
 * `try/catch` below rather than by a line in a README.
 */
export const campaignRouteFor = async (
  request: RequestLike,
  source: RouteSource,
  options?: CampaignRouteForOptions
): Promise<string | null> => {
  try {
    const url = new URL(request.url);

    // Organic traffic is the majority of every marketing site's requests, and it
    // never carries a campaign. Answering it before touching the rule source
    // keeps the common case off the network entirely.
    if (url.search.length === 0) return null;

    const routes = await source.getRoutes(url.origin);
    // The caller's answer wins; otherwise the source's, if it has one. A source
    // that cannot tell contributes nothing rather than refusing everything.
    // The source is asked about the same origin its rules were read for, so a
    // source keeping one page list per hostname cannot answer from another's.
    const sourcePageExists = source.pageExists;
    const pageExists =
      options?.pageExists ??
      (sourcePageExists ? (path: string) => sourcePageExists(path, url.origin) : undefined);
    const match = matchCampaignRoute(
      routes,
      { path: url.pathname, searchParams: readSearchParams(url) },
      pageExists ? { pageExists } : undefined
    );
    if (!match) return null;

    notifyMatch(options?.onMatch, {
      requestedPath: url.pathname,
      targetPath: match.targetPath,
      matchParams: match.route.matchParams,
      route: match.route
    });

    // A rooted path on this site, guaranteed by the core rather than by the
    // caller. Resolving it against `request.url` is only safe because of that:
    // `new URL('//evil.example', page)` is a DIFFERENT ORIGIN, so a CMS entry
    // would otherwise be able to send a live ad's traffic off-site.
    return match.targetPath;
  } catch {
    return null;
  }
};
