# @tailor-ai/campaign-routes

Serve the campaign page a visitor should get, from rules held in your own CMS.

**TL;DR**

- **What:** a visitor who arrives from an ad (`/pricing?utm_campaign=enterprise`) is served your campaign page (`/pricing-enterprise`) at the original URL. Everyone else gets `/pricing`.
- **How:** a rule in your CMS says which page, for which parameters. Your app exposes the rules at one route. Next.js middleware reads them once a minute and rewrites matching requests.
- **Install:** two files, `middleware.ts` and `app/api/campaign-routes/route.ts`. After that, every campaign is a publish in the CMS, not a deploy.
- **Never:** never calls Tailor, never fails a page load, never redirects, never rewrites off your site, never sets a cookie.
- **Status:** pre-1.0, MIT, four entry points (`.`, `/next`, `/endpoint`, `/contentful`).

An ad points at `/pricing`. A test proved different copy converts better for
`utm_campaign=enterprise`, so that copy lives on `/pricing-enterprise`. This
serves that page at the original URL, on the server, for the visitors the ad
brought — and leaves everyone else alone.

```
/pricing                            → your pricing page
/pricing?utm_campaign=enterprise    → the campaign page, at the same URL
```

No redirect, no flash, no client-side swap. A crawler that runs no JavaScript
sees what a person sees.

## How it works

Three moving parts, and only the last two are code you write, once:

1. **A rule lives in your CMS.** A Campaign Route entry says: on this page
   (`basePath`), for a visitor whose URL carries these parameters
   (`matchParams`), serve that page instead (`targetPath`). Marketers publish
   and unpublish them; turning a campaign on or off is a publish, not a deploy.
2. **Your app exposes its rules at one URL.** A route handler at
   `/api/campaign-routes` reads the entries with the content client you already
   have and returns them, together with the list of pages your site actually
   serves. It is the only thing that talks to your CMS.
3. **Middleware decides per request.** For a request that carries a query
   string, it matches the URL against the rules and, on a hit, rewrites to the
   campaign page. It gets the rules from `/api/campaign-routes`, keeps them in
   its own memory for 60 seconds, and refreshes behind a response rather than
   in front of one, so after the first load no visitor waits on the read (ship
   a `bootstrap` and not even the first one does).

```
marketer publishes     your route handler         middleware, per isolate      per request
a Campaign Route  ───▶ /api/campaign-routes  ───▶ rules cached 60s, refreshed ───▶ match ───▶ rewrite
in the CMS             returns rules + pages       behind the response              (or leave alone)
```

So when a marketer publishes or unpublishes a rule, every server that is
handling traffic picks it up on its next refresh: live within a few minutes at
the default TTL (the route handler's own `revalidate = 60` adds a minute at
worst), with no deploy and no code change. The request
that notices the cache has lapsed is still served the old rules, which is why
it is "a couple" and not one.

## What ships

Four entry points, each one piece of the picture above:

| Entry point | Its place in the flow |
| --- | --- |
| `@tailor-ai/campaign-routes` | Step 3's decision as a pure function: rules and a URL in, a target path or `null` out. No dependencies, no network, no framework. You call it directly only if you are not on Next.js. |
| `/next` | Step 3 for Next.js: `campaignRouteFor(request, source)`, called from your `middleware.ts`. |
| `/endpoint` | Both ends of step 2: `campaignRoutesPayload()` builds what the route handler returns, and `createEndpointRouteSource()` is how the middleware reads it. |
| `/contentful` | Step 1's shape: turns Contentful entries into rules, inside your route handler — or, on a runtime that can, reads them from Contentful directly. |

The Next.js install below is `/next` + `/endpoint`, with `/contentful` doing
the entry parsing if you want it to. A CloudFront and Lambda@Edge adapter
exists as an unpublished example; see the note further down.

## Install

```bash
npm install @tailor-ai/campaign-routes
```

ESM only, with `exports` conditions. A project on `moduleResolution: "node"`
or a CommonJS `require` will not resolve the subpaths; Next.js projects on
`bundler` or `node16` resolution do.

### Next.js

Two files, which are steps 3 and 2 above. `middleware.ts` is step 3:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createEndpointRouteSource } from '@tailor-ai/campaign-routes/endpoint';
import { campaignRouteFor } from '@tailor-ai/campaign-routes/next';

// On Vercel this is enough: the platform vouches for the Host header, so the
// rules are read from the request's own origin and preview deploys work with
// no configuration. (Netlify is treated the same way and has not been driven
// here yet. A preview behind Vercel's Deployment Protection answers the
// middleware's own fetch with a 401, so campaigns are off there until
// /api/campaign-routes is allowed through.)
//
// Do not ship a `vercel env pull` .env.local to a self-hosted production: it
// carries VERCEL=1, which would make that box trust the Host header as if the
// platform stood behind it. Pinning `origin` (below) closes that regardless.
//
// Self-hosting with `next start`? In production this reads nothing (and warns
// once) until you pin the address your app listens on, which is where the
// route handler below actually is:
//   createEndpointRouteSource({ origin: 'http://localhost:3000' })
// A platform deployment that answers on several real hostnames can name them
// instead: `trustedOrigins: ['https://www.example.com', 'https://example.com']`.
const source = createEndpointRouteSource();

export async function middleware(request: NextRequest) {
  const target = await campaignRouteFor(request, source);
  if (!target) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = target;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/).*)'],
};
```

and `app/api/campaign-routes/route.ts` is step 2, the one place your existing
content client is used:

```ts
import { campaignRoutesPayload } from '@tailor-ai/campaign-routes/endpoint';

export const revalidate = 60;

export async function GET() {
  const [rules, pages] = await Promise.all([getCampaignRoutes(), getAllPages()]);
  return Response.json(campaignRoutesPayload(rules, pages.map((p) => p.path)));
}
```

`getCampaignRoutes()` is your CMS read. For Contentful that is
`client.getEntries({ content_type: 'tailorCampaignRoute' })`, or
`toCampaignRoutes()` from `@tailor-ai/campaign-routes/contentful` if you want the
parsing done for you.

**Why a route handler and not a CMS read from the edge.** Middleware runs before
your app, so your content SDK is not available to it — you need a route either
way. And because that route runs *inside* the app, it can return the rules **and
the paths that exist**, which is what stops a rule published before its page from
turning a live ad into a 404. Reading the CMS from the edge cannot answer that.

`paths` is a statement, so make it a true one. An empty list says the site
serves no pages and refuses every rewrite; leaving it out says the inventory is
unknown, which protects nothing. Return the real list, or none — never `[]` as
a placeholder, and never let a failed page query become one.

### CloudFront and Lambda@Edge

Not published. There is a working adapter in
[`examples/lambda-edge`](examples/lambda-edge) — same core, same tests, driven
in process against a real Contentful space — to copy into your own function.
It becomes a real entry point once a real deploy has proved it, which is a
minor version away; shipping it first and removing it later would not be.

Read its header before you do. It has never run in Lambda@Edge, so everything
that runtime contributes is unverified, and its configuration example reads
`process.env`, which Lambda@Edge does not provide.

### Anything else

The core is one pure function with no dependencies, no network and no framework:

```ts
import { matchCampaignRoute } from '@tailor-ai/campaign-routes';

const match = matchCampaignRoute(rules, { path, searchParams });
// → { targetPath, route } | null
```

It uses ES 5.1 built-ins only, so it runs inside a CloudFront Function — the one
interception point available on a statically exported site, and the one that
cannot make network calls. Give it the rules from wherever you can get them.

## The rules

A rule is three fields, and they live in your CMS rather than in this code:

```json
{
  "basePath": "/pricing",
  "matchParams": { "utm_campaign": "enterprise" },
  "targetPath": "/pricing-enterprise"
}
```

`basePath` and `targetPath` must be rooted paths on your own site. Both are
compared ignoring trailing slashes and case; the page that gets served is
`targetPath` with its case preserved (surrounding whitespace and a trailing
slash are trimmed).

### How a value is matched

A parameter value is compared ignoring case, and it can be more than an exact
string:

| `matchParams` value | Matches when the request's value… |
| --- | --- |
| `"enterprise plan"` | is exactly that (an empty string matches a parameter that is present and empty, `?utm_term=`) |
| `"enterprise*"` | starts with `enterprise`; each `*` stands for any run of characters, including none, so `"*langsmith*"` is "contains" and a lone `"*"` is "present, whatever the value" |
| `{ "contains": "langsmith" }` | contains it |
| `{ "startsWith": "enterprise" }` | starts with it |
| `{ "endsWith": " pricing" }` | ends with it |
| `{ "oneOf": ["enterprise plan", "enterprise*"] }` | matches any one entry, each a plain or wildcard string |

Paths take no wildcard at all: a rule is one page served instead of one
other page. A `basePath` or `targetPath` containing `*` makes the rule
unusable (it is dropped, not matched literally). This is deliberate. A rule
replaces the whole page, so `/blog/*` would send every visitor who clicked
through to a specific post to the same campaign page, and one typo would take
a section with it. Matching a section is for tools that change an element on
each page, not for a rewrite.

None of this is a regular expression, and none of it will be. These strings are
typed by marketers and run on every ad click, and a pattern that can be made to
backtrack is a way to take a site down from a content field. Every form above
is a handful of `indexOf` calls.

**A rule matches when the request carries everything it names, and may carry
more.** A real ad click never arrives with only the parameters somebody targeted
on — Google appends `gclid`, Meta appends `fbclid`, your analytics adds its own —
so a rule demanding an exact parameter set would match in testing and never once
in production. Values compare case-insensitively; keys do not.

When two rules match, the narrower one wins: more exact values beat fewer (so
a rule naming the actual keyword beats a catch-all of lone `*`s, however many
parameters the catch-all names), then more narrowing parameters, then more
parameters of any kind. On a genuine tie the
target path decides, which is arbitrary and deliberately deterministic: two
equally specific rules is a mistake in your content, and the failure it must not
produce is a page that alternates between versions depending on which entry came
back first.

## Why the rules live in your CMS

Routing rules in a content system can look odd to an engineer the first time.
Two things are worth knowing before deciding it is.

**It is the established pattern for anything marketing changes more often than
the site deploys.** A "Redirect" content type read by middleware is a stock
Contentful setup, for exactly this reason; Contentful's own personalization
product keeps its audience and variant rules as entries in the space; every
personalization platform that works with a headless CMS does the same. A rule
here is the same shape: "this page, for visitors who arrived from that ad,
serve that page instead". That is a statement about content, so it belongs with
the content, under the roles, workflows and publish gates the content already
has. Tailor writes every rule as a draft; someone on your team publishing it is
what turns the campaign on, and unpublishing it is what turns it off (as long
as your route handler reads with the Delivery client, which serves published
entries only, and not the Preview one). No new permission, no new tool, no
request to an engineer per campaign.

**The alternatives are each worse in a specific way.** `rewrites()` in
`next.config.js` means a deploy per campaign, which is the cost this removes.
Reading `searchParams` inside the page opts the whole route out of static
generation, so every marketing page renders per request for the organic
majority that carries no campaign (measured: one such read turned a `[...slug]`
catch-all dynamic). A personalization service that decides at the edge puts a
vendor in your request path, and this package's whole design is that nothing
except your own CMS and your own app is in it.

What this does *not* put in your CMS: any logic. The matching, the refusal to
rewrite off-site, the caching and the failure behaviour are all in this
package, versioned and tested. The CMS holds three fields per campaign, and a
person who can publish a page can publish one.

## How far it scales

The rules live in memory, one copy per server isolate, refreshed once per TTL.
Two costs grow with the number of rules: the payload each isolate re-reads
every minute, and the per-request scan, which is linear and runs only for
requests that carry a query string. Measured on a laptop (an edge isolate is a
few times slower and has 128 MB):

| Rules | Payload per refresh | Refresh (parse + validate) | Memory held | Per campaign request |
| --- | --- | --- | --- | --- |
| 1,000 | 151 KB | 0.7 ms | 228 KB | 0.13 ms |
| 10,000 | 1.4 MB | 6.5 ms | 2.2 MB | 1.4 ms |
| 50,000 | 7.3 MB | 38 ms | 11 MB | 7 ms |

A rule is one campaign on one page, so a site with hundreds of pages and a
few campaigns each is in the low thousands, where none of this registers.
Past about 10,000 the per-minute payload and the per-request scan are worth
looking at, and that is also where the Contentful source stops on its own: it
reads at most ten pages of 1,000 entries, so a space with more rules than that
routes on the first 10,000. If a site ever gets there, indexing rules by
`basePath` turns the scan into a lookup, and the sources are where that change
would go.

## Knowing when a campaign served

The package sends nothing anywhere. That also means nothing in *your* stack knows
a campaign page served, so a conversion cannot be attributed to one. `onMatch` is
the seam:

```ts
const target = await campaignRouteFor(request, source, {
  onMatch: ({ requestedPath, targetPath, matchParams }) => {
    analytics.track('campaign_page_served', { requestedPath, targetPath, matchParams });
  },
});
```

It is never awaited and never allowed to throw, so an analytics call that hangs
cannot hold the page and one that fails cannot lose it — including an
`async` callback, whose rejection is observed for you.

## Two things to check before you ship

**Your CDN must key on the query string.** Both integration points decide from
`utm_*`, so a cache that ignores or strips query parameters will store the
campaign page under `/pricing` and then serve it to organic traffic. Every CDN
does the right thing by default; stripping query strings is a deliberate
cache-hit-rate optimisation that some teams have made. If yours has, undo it for
these paths.

**Campaign pages are indexable, and they compete with the page they came from.**
`/pricing` and `/pricing-enterprise` are near-duplicates that both exist. Give the
campaign page a `noindex` (keep it crawlable) or a canonical back to the original.
This is not something the package can do for you — it renders in your page, not
in the middleware.

**You are not cloaking**, and it is worth knowing why so nobody breaks it later.
Cloaking is showing a crawler different content than a visitor *at the same URL*.
Crawlers do not send `utm_*`, so they get the original page — the behaviour is
correct by construction. It stops being correct if somebody writes a rule keyed on
something a crawler *does* send, so don't.

## What it will not do

- **It never fails your page load, once built.** Every error path at request
  time — the CMS down, a stalled connection, a malformed rule, a bug in here —
  returns "serve the page you were going to serve". There is no configuration
  for this. The one place it does throw is construction: a malformed `origin`,
  `trustedOrigins` entry, `path` or Contentful `host` throws when the source is
  created, so a bad deploy fails at deploy rather than under traffic. Because
  the source is built at module scope of `middleware.ts`, an env variable that
  is unset in production (`origin: process.env.SELF_ORIGIN ?? ''`) fails the
  deploy the same way, which is the point.
- **It never sends a visitor off your site.** A rule whose target is an absolute
  URL, a protocol-relative `//host`, or carries a backslash, control character,
  `?` or `#` is refused. These strings come out of a CMS that people edit, and
  both integration points hand the target to a URL resolver.
- **It never redirects.** The address bar does not change, so your ad keeps its
  clean destination and your analytics keeps its parameters.
- **It phones nothing home.** There is no telemetry and no logger. The only
  network call it makes is the one to your own CMS or your own endpoint. Use
  `onMatch` to tell your own analytics.
- **It sets no cookies and remembers no visitor.** The campaign applies to the
  click the ad paid for and not to the rest of the session, which is deliberate
  rather than missing: the campaign page *is* the landing page, and a cookie that
  kept rewriting `/pricing` afterwards would personalize navigation nobody bought.
  There is also then nothing to put in a consent banner.
- **It never blocks on a refresh.** After the first load the rules are served
  from cache and refreshed behind the request, so no visitor waits on your CMS.
  The trade: a newly published campaign can take up to twice the TTL to appear,
  because the request that notices the cache has lapsed is still served the old
  rules. Ship a `bootstrap` payload if you want the first request of a cold
  isolate personalized too. On Cloudflare Workers or Vercel's edge runtime,
  pass the runtime's own `waitUntil` so the refresh behind a response is not
  cancelled with it; on a runtime that freezes the moment the handler returns,
  such as Lambda@Edge, pass `awaitStaleRefresh: true` and accept one blocking
  read per TTL per isolate rather than unbounded staleness.
- **It keeps serving through an outage, for an hour.** When your CMS or
  endpoint stops answering, the last good rules keep serving and the upstream
  is retried with a growing wait. After `maxStaleMs` (default one hour) of
  failed reads every visitor gets their original page until a read succeeds,
  so a campaign you unpublished to pull bad content cannot outlive an outage by
  more than that. Pass `onError` to hear about every failed read from your own
  monitoring; the package itself logs nothing, except one `console.warn` the
  first time it refuses to read rules for a request origin.

## Next.js version note

A middleware rewrite **silently disabled ISR in Next 15.4.2-canary.2 through
15.5.21** — the page stays correct and simply stops being cached. Check for it in
one line:

```bash
curl -sI 'https://yoursite.com/pricing?utm_campaign=enterprise' | grep -i 'x-nextjs-prerender\|cache-control'
```

You want `x-nextjs-prerender: 1` and an `s-maxage`. If you see
`Cache-Control: private, no-cache, no-store` and no prerender header, you are on
an affected version. Measured green on Next 16.3.0.

## License

MIT. See [LICENSE](./LICENSE).
