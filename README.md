# @tailor-ai/campaign-routes

Serve the campaign page a visitor should get, from rules held in your own CMS.

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

## What ships

Four entry points, and every one of them has run somewhere real:

| Entry point | What it is |
| --- | --- |
| `.` | The matching core. Pure, no dependencies, no network, no framework. |
| `/next` | Next.js middleware. |
| `/endpoint` | Reads the rules from a route handler inside your own app. |
| `/contentful` | Shapes Contentful entries into rules, and can fetch them directly. |

`/next` + `/endpoint` is the pairing behind a deployed site and the one to reach
for first.

**A CloudFront and Lambda@Edge adapter exists in
[`examples/lambda-edge`](examples/lambda-edge), and is deliberately not
published.** It shares this core and its tests, but it has never run in the
Lambda@Edge runtime, and its own configuration example reads `process.env` —
which that runtime does not provide. Copy it as a starting point rather than
depending on it. It becomes a real entry point when a real deploy has proved
it, which is a minor version away; shipping it first and removing it later
would not be.

## Install

```bash
npm install @tailor-ai/campaign-routes
```

### Next.js

Two files. `middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createEndpointRouteSource } from '@tailor-ai/campaign-routes/endpoint';
import { campaignRouteFor } from '@tailor-ai/campaign-routes/next';

// On Vercel or Netlify this is enough: the platform vouches for the Host
// header, so the rules are read from the request's own origin and preview
// deploys work with no configuration.
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

and `app/api/campaign-routes/route.ts`, which is where your existing content
client lives:

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
`targetPath` exactly as you wrote it.

**A rule matches when the request carries everything it names, and may carry
more.** A real ad click never arrives with only the parameters somebody targeted
on — Google appends `gclid`, Meta appends `fbclid`, your analytics adds its own —
so a rule demanding an exact parameter set would match in testing and never once
in production. Values compare case-insensitively; keys do not.

When two rules match, the one naming more parameters wins. On a genuine tie the
target path decides, which is arbitrary and deliberately deterministic: two
equally specific rules is a mistake in your content, and the failure it must not
produce is a page that alternates between versions depending on which entry came
back first.

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

- **It never fails your page load.** Every error path — the CMS down, a stalled
  connection, a malformed rule, a bug in here — returns "serve the page you were
  going to serve". There is no configuration for this.
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
  isolate personalized too.

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
